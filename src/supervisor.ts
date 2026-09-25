import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { type Outcome, type StreamFacts, classify, emptyFacts, scanLine } from './outcome.ts'
import { type Admission, type AdmittedReview, admit, verdict } from './review/admit.ts'
import type { Candidate } from './review/candidate.ts'
import { REVIEW_PROMPT_BUDGET, closingMessage, renderCorrectionPrompt } from './review/prompt.ts'
import { readJson, setStatus, writeJsonAtomic } from './runs.ts'
import type {
  AttemptKind, AttemptMetrics, Family, LaunchSpec, RejectedField, ResumeInfo, RetryInfo, Status,
} from './types.ts'
import { claudeResume, claudeRetry, withSessionId } from './workers/claude.ts'
import { codexResume, codexRetry, withResultFile } from './workers/codex.ts'

export interface ArgvFile {
  family: Family; launch: LaunchSpec; deadline_sec: number; grace_ms?: number
  /** Tope de la reanudación que sigue a un `timeout`; el de la corrida ya venció a esa altura. */
  resume_sec?: number
  kind?: 'run' | 'review'
  candidate?: string
}

const DEFAULT_RESUME_SEC = 300

const SESSION_VARS = new Set([
  'CLAUDECODE', 'CLAUDE_EFFORT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI',
])

/**
 * Entorno del worker: el del supervisor sin las señales de sesión del conductor, para que el worker
 * no se crea anidado ni herede su identidad, y con la marca que impide que lance otro sdd-ai.
 */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (SESSION_VARS.has(k) || k.startsWith('CLAUDE_CODE_') || k.startsWith('CODEX_SANDBOX')) continue
    out[k] = v
  }
  out.SDD_AI_WORKER = '1'
  return out
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // El grupo ya no existe.
  }
}

interface RunContext { dir: string; family: Family; grace: number; cancelFile: string }
interface Attempt {
  outcome: Outcome; facts: StreamFacts; resultFile: string
  startedAt: Date; endedAt: Date; stdoutFile: string; stderrFile: string
}

/** Codex escribe su respuesta donde diga `--output-last-message`; Claude la entrega en el stream. */
function resultFileOf(family: Family, launch: LaunchSpec, dir: string, suffix: string): string {
  const i = launch.args.indexOf('--output-last-message')
  if (family === 'codex' && i >= 0 && i + 1 < launch.args.length) return launch.args[i + 1]
  return join(dir, `result${suffix}.md`)
}

/**
 * Un lanzamiento del worker. Cada intento escribe sus propios logs (`suffix`) para que la salida de
 * uno no se mezcle con la clasificación del otro; el tope es el de toda la corrida.
 */
async function attempt(ctx: RunContext, launch: LaunchSpec, suffix: string, until: number): Promise<Attempt> {
  const { dir, family, grace, cancelFile } = ctx
  const facts = emptyFacts()
  const startedAt = new Date()
  const stdoutFile = join(dir, `stdout${suffix}.log`)
  const stdinFd = openSync(launch.stdinFile, 'r')
  const stdoutFd = openSync(stdoutFile, 'a')
  const stderrFile = join(dir, `stderr${suffix}.log`)
  const stderrFd = openSync(stderrFile, 'a')

  const child = spawn(launch.cmd, launch.args, {
    cwd: launch.cwd,
    detached: true,
    env: cleanEnv(process.env),
    stdio: [stdinFd, 'pipe', stderrFd],
  })

  let timedOut = false
  let deadline: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let cancelWatch: NodeJS.Timeout | undefined

  const ended = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once('error', (err) => resolve({ code: null, spawnError: err }))
    child.once('close', (code) => resolve({ code }))
  })

  if (child.pid !== undefined) {
    const pid = child.pid
    const running: Partial<Status> = { state: 'running', worker_pid: pid, supervisor_pid: process.pid }
    if (suffix === '') running.started_at = new Date().toISOString()
    setStatus(dir, running)
    createInterface({ input: child.stdout! }).on('line', (line) => {
      writeSync(stdoutFd, `${line}\n`)
      scanLine(family, facts, line)
    })
    deadline = setTimeout(() => {
      timedOut = true
      killGroup(pid, 'SIGTERM')
      graceTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), grace)
    }, Math.max(0, until - Date.now()))
    // `cancel` puede llegar antes de que exista el PID; el pedido en disco es la señal.
    cancelWatch = setInterval(() => {
      if (existsSync(cancelFile)) {
        clearInterval(cancelWatch)
        killGroup(pid, 'SIGTERM')
        graceTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), grace)
      }
    }, 250)
  }

  const { code, spawnError } = await ended
  clearTimeout(deadline)
  clearTimeout(graceTimer)
  clearInterval(cancelWatch)
  // Un nieto que sobrevivió al worker no debe quedar vivo.
  if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
  for (const fd of [stdinFd, stdoutFd, stderrFd]) closeSync(fd)

  const resultFile = resultFileOf(family, launch, dir, suffix)
  const common = { facts, resultFile, startedAt, endedAt: new Date(), stdoutFile, stderrFile }
  if (spawnError) {
    const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
    return { ...common, outcome: { state: 'launch_failed', reason: missing ? 'cli_missing' : 'unknown', detail: spawnError.message } }
  }
  let resultText = ''
  if (family === 'claude') {
    resultText = facts.result ?? ''
    writeFileSync(resultFile, resultText)
  } else if (existsSync(resultFile)) {
    resultText = readFileSync(resultFile, 'utf8')
  }
  const outcome = classify(family, facts, {
    exitCode: code,
    timedOut,
    cancelled: existsSync(cancelFile),
    resultText,
    stderr: readFileSync(stderrFile, 'utf8'),
  })
  return { ...common, outcome }
}

interface MetricsFile { attempts: AttemptMetrics[]; totals: { duration_ms: number; attempts: number; inadmissible: number } }

function withTotals(m: MetricsFile): MetricsFile {
  m.totals = {
    duration_ms: m.attempts.reduce((t, x) => t + x.duration_ms, 0),
    attempts: m.attempts.length,
    inadmissible: m.attempts.filter((x) => x.admission?.startsWith('inadmissible')).length,
  }
  return m
}

/** Suma el intento a `metrics.json`: duración, bytes del prompt, tokens y dónde quedó su salida cruda. */
function recordAttempt(dir: string, kind: AttemptKind, suffix: string, launch: LaunchSpec, a: Attempt, admission?: string): void {
  const file = join(dir, 'metrics.json')
  const m: MetricsFile = existsSync(file) ? readJson<MetricsFile>(file) : { attempts: [], totals: { duration_ms: 0, attempts: 0, inadmissible: 0 } }
  const entry: AttemptMetrics = {
    kind, suffix, started_at: a.startedAt.toISOString(), ended_at: a.endedAt.toISOString(),
    duration_ms: a.endedAt.getTime() - a.startedAt.getTime(), prompt_bytes: statSync(launch.stdinFile).size,
    outcome: a.outcome.state,
    raw: { stdout: relative(dir, a.stdoutFile), stderr: relative(dir, a.stderrFile), result: relative(dir, a.resultFile) },
  }
  if (a.facts.usage) entry.usage = a.facts.usage
  if (a.outcome.reason) entry.reason = a.outcome.reason
  if (admission) entry.admission = admission
  m.attempts.push(entry)
  writeJsonAtomic(file, withTotals(m))
}

/** Admite la respuesta del último intento y anota el resultado en su entrada de `metrics.json`. */
function admitAttempt(dir: string, candidate: Candidate, a: Attempt): Admission {
  const text = existsSync(a.resultFile) ? readFileSync(a.resultFile, 'utf8') : ''
  const adm = admit(text, candidate)
  const file = join(dir, 'metrics.json')
  const m = readJson<MetricsFile>(file)
  const lastEntry = m.attempts.at(-1)
  if (lastEntry) {
    if (adm.kind === 'admitted') lastEntry.admission = 'ok'
    else if (adm.kind === 'unavailable') lastEntry.admission = 'unavailable'
    else lastEntry.admission = `inadmissible: ${adm.error}`
  }
  writeJsonAtomic(file, withTotals(m))
  return adm
}

/** La corrección es un lanzamiento nuevo, no una reanudación: otra sesión en Claude, otro `exec` en Codex. */
function correctionLaunch(family: Family, launch: LaunchSpec, dir: string): LaunchSpec {
  const stdinFile = join(dir, 'prompt-fix.md')
  if (family === 'claude') return { ...launch, args: withSessionId(launch.args, randomUUID()), stdinFile }
  return { ...launch, args: withResultFile(launch.args, join(dir, 'result-fix.md')), stdinFile }
}

function optionalJson<T>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined
}

interface ReviewTrail { facts: StreamFacts; toolEvents: string[]; retried: boolean; resumed: boolean }

/** Escribe el veredicto y el recibo: qué se revisó, quién, con qué degradaciones y qué encontró. Informa; no autoriza. */
function writeReviewResult(dir: string, family: Family, candidate: Candidate, review: AdmittedReview, trail: ReviewTrail): void {
  const v = verdict(review.findings)
  writeJsonAtomic(join(dir, 'verdict.json'), v)
  const request = optionalJson<{ selection?: unknown; author?: string; degradations?: string[] }>(join(dir, 'request.json'))
  const resolved = optionalJson<{ model?: string; effort?: string }>(join(dir, 'resolved.json'))
  const degradations = [...(request?.degradations ?? [])]
  if (trail.retried) degradations.push('profile_retry')
  if (trail.resumed) degradations.push('resume')
  writeJsonAtomic(join(dir, 'receipt.json'), {
    candidate_hash: candidate.hash, base_sha: candidate.base_sha, head_sha: candidate.head_sha,
    selection: request?.selection ?? null, author: request?.author ?? null,
    reviewer: {
      family, model_requested: resolved?.model ?? null, model_effective: trail.facts.model ?? null, effort: resolved?.effort ?? null,
    },
    degradations, tool_events: trail.toolEvents,
    axes: { scope: v.scope, spec: v.spec, quality: v.quality }, findings: v.findings, out_of_scope: v.out_of_scope,
    admitted_at: new Date().toISOString(),
    note: 'informa; no autoriza commit ni push',
  })
}

function retryArgs(family: Family, args: string[], field: RejectedField, dir: string): { args: string[]; requested: string } | null {
  if (family === 'claude') return claudeRetry(args, field, randomUUID())
  const next = codexRetry(args, field)
  return next && { ...next, args: withResultFile(next.args, join(dir, 'result-2.md')) }
}

/** En Claude la sesión la fija el argv; en Codex solo se conoce cuando el stream abre el hilo. */
function sessionOf(family: Family, args: string[], facts: StreamFacts): string | undefined {
  const i = args.indexOf('--session-id')
  if (family === 'claude' && i >= 0 && i + 1 < args.length) return args[i + 1]
  return facts.sessionId
}

function resumeLaunch(family: Family, launch: LaunchSpec, sessionId: string, dir: string): LaunchSpec | null {
  const args = family === 'claude' ? claudeResume(launch.args) : codexResume(launch.args, sessionId, join(dir, 'result-resume.md'))
  return args ? { ...launch, args, stdinFile: join(dir, 'resume.md') } : null
}

/** Lo que usó el reintento en lugar del valor rechazado: el modelo si el CLI lo informa, si no el default. */
function effectiveValue(family: Family, field: RejectedField, facts: StreamFacts): string {
  return family === 'claude' && field === 'model' && facts.model ? facts.model : 'default del CLI'
}

interface ReviewPhase { last: Attempt; outcome: Outcome; review?: AdmittedReview; toolEvents: string[] }

/**
 * Admite la respuesta del revisor. Una respuesta inadmisible tiene una sola corrección, con el error
 * concreto y tope propio; si tampoco se admite, o si el revisor declara que no pudo ver el candidato,
 * la revisión termina en `unavailable` con el motivo.
 */
async function reviewPhase(ctx: RunContext, family: Family, candidate: Candidate, launch: LaunchSpec, last: Attempt, resumeSec: number): Promise<ReviewPhase> {
  const { dir } = ctx
  const adm = admitAttempt(dir, candidate, last)
  if (adm.kind === 'admitted') return { last, outcome: last.outcome, review: adm.review, toolEvents: [] }
  if (adm.kind === 'unavailable') return { last, outcome: { state: 'unavailable', reason: 'reviewer_unavailable', detail: adm.reason }, toolEvents: [] }

  const fix = renderCorrectionPrompt(readFileSync(join(dir, 'prompt.md'), 'utf8'), adm.error)
  if (Buffer.byteLength(fix) > REVIEW_PROMPT_BUDGET) {
    return { last, outcome: { state: 'unavailable', reason: 'correction_over_budget', detail: adm.error }, toolEvents: [] }
  }
  writeFileSync(join(dir, 'prompt-fix.md'), fix)
  const fixLaunch = correctionLaunch(family, launch, dir)
  const fixed = await attempt(ctx, fixLaunch, '-fix', Date.now() + resumeSec * 1000)
  recordAttempt(dir, 'correction', '-fix', fixLaunch, fixed)
  const toolEvents = fixed.facts.toolEvents
  if (fixed.outcome.state !== 'done') {
    const why = fixed.outcome.reason ? `${fixed.outcome.state}/${fixed.outcome.reason}` : fixed.outcome.state
    return { last: fixed, outcome: { state: 'unavailable', reason: 'correction_failed', detail: why }, toolEvents }
  }
  const second = admitAttempt(dir, candidate, fixed)
  if (second.kind === 'admitted') return { last: fixed, outcome: fixed.outcome, review: second.review, toolEvents }
  if (second.kind === 'unavailable') return { last: fixed, outcome: { state: 'unavailable', reason: 'reviewer_unavailable', detail: second.reason }, toolEvents }
  return { last: fixed, outcome: { state: 'unavailable', reason: 'inadmissible_twice', detail: second.error }, toolEvents }
}

/**
 * Lanza al worker de una corrida preparada, aplica el tope y escribe el estado final. Si el CLI
 * rechaza el modelo o el esfuerzo pedido, relanza una sola vez sin ese campo y lo deja registrado.
 * Si se agota el tope, reanuda una sola vez la misma sesión para que entregue lo que tenga.
 */
export async function supervise(dir: string): Promise<Status> {
  const argv = readJson<ArgvFile>(join(dir, 'argv.json'))
  const cancelFile = join(dir, 'cancel.request')
  // Un cancel que llegó antes de que hubiera worker: no se lanza nada.
  if (existsSync(cancelFile)) return setStatus(dir, { state: 'cancelled', ended_at: new Date().toISOString() })
  const ctx: RunContext = { dir, family: argv.family, grace: argv.grace_ms ?? 10_000, cancelFile }
  const until = Date.now() + argv.deadline_sec * 1000
  const resumeSec = argv.resume_sec ?? DEFAULT_RESUME_SEC

  let last = await attempt(ctx, argv.launch, '', until)
  recordAttempt(dir, 'initial', '', argv.launch, last)
  const toolEvents = [...last.facts.toolEvents]
  let { outcome, facts } = last
  let current = argv.launch
  let retry: RetryInfo | undefined
  const rejected = outcome.state === 'launch_failed' ? facts.rejected : undefined
  const next = rejected ? retryArgs(argv.family, argv.launch.args, rejected.field, dir) : null
  if (rejected && next) {
    if (existsSync(cancelFile)) {
      outcome = { state: 'cancelled' }
    } else {
      current = { ...argv.launch, args: next.args }
      writeJsonAtomic(join(dir, 'argv-2.json'), { ...argv, launch: current })
      last = await attempt(ctx, current, '-2', until)
      recordAttempt(dir, 'profile_retry', '-2', current, last)
      toolEvents.push(...last.facts.toolEvents)
      outcome = last.outcome
      facts = last.facts
      retry = {
        field: rejected.field, requested: next.requested,
        effective: effectiveValue(argv.family, rejected.field, facts), diagnostic: rejected.diagnostic,
      }
    }
  }

  let resume: ResumeInfo | undefined
  if (outcome.state === 'timeout' && !existsSync(cancelFile)) {
    const sessionId = sessionOf(argv.family, current.args, facts)
    const launch = sessionId ? resumeLaunch(argv.family, current, sessionId, dir) : null
    if (sessionId && launch) {
      writeFileSync(launch.stdinFile, closingMessage(argv.kind ?? 'run'))
      resume = { session_id: sessionId, started_at: new Date().toISOString() }
      setStatus(dir, { resume })
      writeJsonAtomic(join(dir, 'argv-resume.json'), { ...argv, launch })
      last = await attempt(ctx, launch, '-resume', Date.now() + resumeSec * 1000)
      recordAttempt(dir, 'resume', '-resume', launch, last)
      toolEvents.push(...last.facts.toolEvents)
      facts = { ...last.facts, sessionId: last.facts.sessionId ?? sessionId }
      resume = { ...resume, outcome: last.outcome.state }
      // Una reanudación que no entrega deja la corrida en el timeout original, con su sesión.
      if (last.outcome.state === 'done' || last.outcome.state === 'cancelled') outcome = last.outcome
    }
  }

  if (argv.kind === 'review' && argv.candidate && outcome.state === 'done') {
    const candidate = readJson<Candidate>(argv.candidate)
    const reviewed = await reviewPhase(ctx, argv.family, candidate, current, last, resumeSec)
    last = reviewed.last
    outcome = reviewed.outcome
    toolEvents.push(...reviewed.toolEvents)
    if (reviewed.review) {
      writeReviewResult(dir, argv.family, candidate, reviewed.review, {
        facts: last.facts, toolEvents, retried: retry !== undefined, resumed: resume !== undefined,
      })
    }
  }

  const patch: Partial<Status> = { ...outcome, ended_at: new Date().toISOString() }
  // Cada intento conserva su propia respuesta; `wait` lee la del último.
  if (last.resultFile !== join(dir, 'result.md')) patch.result_file = basename(last.resultFile)
  if (facts.sessionId) patch.session_id = facts.sessionId
  if (retry) patch.retry = retry
  if (resume) patch.resume = resume
  return setStatus(dir, patch)
}
