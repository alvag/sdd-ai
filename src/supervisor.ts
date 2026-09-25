import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { type Outcome, type StreamFacts, classify, emptyFacts, scanLine } from './outcome.ts'
import { type Admission, admit, admitRefutation, admitRound } from './review/admit.ts'
import type { Candidate } from './review/candidate.ts'
import {
  type Ledger, type LedgerEntry, type RoundPlan, applyRefutation, applyRound, axesOf, openLedger, refutationBatch, standing,
} from './review/ledger.ts'
import { REVIEW_PROMPT_BUDGET, closingMessage, renderCorrectionPrompt, renderRefutePrompt } from './review/prompt.ts'
import { readJson, setStatus, writeJsonAtomic } from './runs.ts'
import type {
  AttemptKind, AttemptMetrics, Family, LaunchSpec, RejectedField, Resolution, ResumeInfo, RetryInfo, RunState, Status,
} from './types.ts'
import { claudeResume, claudeRetry, withSessionId } from './workers/claude.ts'
import { codexResume, codexRetry, withResultFile } from './workers/codex.ts'

export interface ArgvFile {
  family: Family; launch: LaunchSpec; deadline_sec: number; grace_ms?: number
  /** Tope de la reanudación que sigue a un `timeout`; el de la corrida ya venció a esa altura. */
  resume_sec?: number
  kind?: 'run' | 'review'
  candidate?: string
  /** Ronda de la revisión; por defecto 1. */
  round?: number
  /** Marca de los archivos de la ronda: '' en la 1, `-r<n>` desde la 2. */
  tag?: string
  /** `round<tag>.json` de una ronda n≥2: qué verifica, qué responde y dónde admite regresiones. */
  plan?: string
  /** `material<tag>.md`: el material congelado de la ronda, que el refutador recibe tal cual. */
  material?: string
  /** El refutador, listo para lanzar; su stdinFile es `prompt<tag>-refute.md`. */
  refuter_launch?: LaunchSpec
  /** La ronda la concedió `--extra`, más allá del tope. */
  extra?: boolean
}

/** Una entrada de `rounds.json` por ronda lanzada, haya terminado o no. */
export interface RoundRecord {
  n: number; tag: string; candidate_hash: string; base_sha: string; head_sha: string | null
  state: RunState; reason?: string; detail?: string; started_at: string; ended_at: string
  extra: boolean; model_effective: string | null
  tool_events: string[]; retry?: RetryInfo; resume?: ResumeInfo
  refutation?: { ids: string[]; outcome: 'admitted' | 'inconclusive'; reason?: string; tool_events: string[] }
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

/** `tag` separa los archivos de cada ronda; `round` va a cada intento de `metrics.json`. */
interface RunContext { dir: string; family: Family; grace: number; cancelFile: string; tag: string; round: number }
interface Attempt {
  outcome: Outcome; facts: StreamFacts; resultFile: string
  startedAt: Date; endedAt: Date; stdoutFile: string; stderrFile: string
}

/** Codex escribe su respuesta donde diga `--output-last-message`; Claude la entrega en el stream. */
function resultFileOf(family: Family, launch: LaunchSpec, dir: string, name: string): string {
  const i = launch.args.indexOf('--output-last-message')
  if (family === 'codex' && i >= 0 && i + 1 < launch.args.length) return launch.args[i + 1]
  return join(dir, `result${name}.md`)
}

/**
 * Un lanzamiento del worker. Cada intento escribe sus propios logs (`<tag><suffix>`) para que la
 * salida de uno no se mezcle con la clasificación de otro, ni con la de una ronda anterior.
 */
async function attempt(ctx: RunContext, launch: LaunchSpec, suffix: string, until: number): Promise<Attempt> {
  const { dir, family, grace, cancelFile } = ctx
  const name = `${ctx.tag}${suffix}`
  const facts = emptyFacts()
  const startedAt = new Date()
  const stdoutFile = join(dir, `stdout${name}.log`)
  const stdinFd = openSync(launch.stdinFile, 'r')
  const stdoutFd = openSync(stdoutFile, 'w')
  const stderrFile = join(dir, `stderr${name}.log`)
  const stderrFd = openSync(stderrFile, 'w')

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

  const resultFile = resultFileOf(family, launch, dir, name)
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

/** Suma el intento a `metrics.json`: ronda, duración, bytes del prompt, tokens y dónde quedó su salida cruda. */
function recordAttempt(ctx: RunContext, kind: AttemptKind, suffix: string, launch: LaunchSpec, a: Attempt): void {
  const { dir } = ctx
  const file = join(dir, 'metrics.json')
  const m: MetricsFile = existsSync(file) ? readJson<MetricsFile>(file) : { attempts: [], totals: { duration_ms: 0, attempts: 0, inadmissible: 0 } }
  const entry: AttemptMetrics = {
    round: ctx.round, kind, suffix, started_at: a.startedAt.toISOString(), ended_at: a.endedAt.toISOString(),
    duration_ms: a.endedAt.getTime() - a.startedAt.getTime(), prompt_bytes: statSync(launch.stdinFile).size,
    outcome: a.outcome.state,
    raw: { stdout: relative(dir, a.stdoutFile), stderr: relative(dir, a.stderrFile), result: relative(dir, a.resultFile) },
  }
  if (a.facts.usage) entry.usage = a.facts.usage
  if (a.outcome.reason) entry.reason = a.outcome.reason
  m.attempts.push(entry)
  writeJsonAtomic(file, withTotals(m))
}

/** Admite la respuesta del último intento y anota el resultado en su entrada de `metrics.json`. */
function admitAttempt<T>(dir: string, a: Attempt, admitFn: (text: string) => Admission<T>): Admission<T> {
  const text = existsSync(a.resultFile) ? readFileSync(a.resultFile, 'utf8') : ''
  const adm = admitFn(text)
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

/**
 * La corrección es un lanzamiento nuevo, no una reanudación: otra sesión en Claude, otro `exec` en
 * Codex. Lee `prompt<name>.md` y, en Codex, responde en `result<name>.md`.
 */
function correctionLaunch(family: Family, launch: LaunchSpec, dir: string, name: string): LaunchSpec {
  const stdinFile = join(dir, `prompt${name}.md`)
  if (family === 'claude') return { ...launch, args: withSessionId(launch.args, randomUUID()), stdinFile }
  return { ...launch, args: withResultFile(launch.args, join(dir, `result${name}.md`)), stdinFile }
}

function optionalJson<T>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined
}

const roundDegradations = (r: RoundRecord) => [...(r.retry ? ['profile_retry'] : []), ...(r.resume ? ['resume'] : [])]

/**
 * Reescribe el veredicto y el recibo desde el ledger y `rounds.json`: qué se revisó en cada ronda,
 * quién, con qué degradaciones y qué quedó. Son proyecciones; nadie los lee para decidir. Informa;
 * no autoriza.
 */
export function writeReceipt(dir: string): void {
  const ledger = readJson<Ledger>(join(dir, 'ledger.json'))
  const rounds = optionalJson<{ rounds: RoundRecord[] }>(join(dir, 'rounds.json'))?.rounds ?? []
  const request = optionalJson<{ selection?: unknown; author?: string; degradations?: string[] }>(join(dir, 'request.json'))
  const resolved = readJson<Resolution>(join(dir, 'resolved.json'))
  const axes = axesOf(ledger)
  const lastDone = rounds.filter((r) => r.state === 'done').at(-1)
  const degradations = [...(request?.degradations ?? [])]
  for (const d of rounds.flatMap(roundDegradations)) if (!degradations.includes(d)) degradations.push(d)
  writeJsonAtomic(join(dir, 'verdict.json'), {
    ...axes, findings: standing(ledger), out_of_scope: ledger.entries.filter((e) => e.state === 'fuera-de-alcance'),
  })
  writeJsonAtomic(join(dir, 'receipt.json'), {
    candidate_hash: lastDone?.candidate_hash ?? null, base_sha: lastDone?.base_sha ?? null, head_sha: lastDone?.head_sha ?? null,
    rounds: rounds.map((r) => ({
      n: r.n, candidate_hash: r.candidate_hash, base_sha: r.base_sha, head_sha: r.head_sha, state: r.state,
      ...(r.reason ? { reason: r.reason } : {}), extra: r.extra, model_effective: r.model_effective,
      degradations: roundDegradations(r), tool_events: r.tool_events, ...(r.refutation ? { refutation: r.refutation } : {}),
    })),
    selection: request?.selection ?? null, author: request?.author ?? null,
    reviewer: {
      family: resolved.family, model_requested: resolved.model ?? null,
      model_effective: lastDone?.model_effective ?? null, effort: resolved.effort ?? null,
    },
    degradations, tool_events: rounds.flatMap((r) => r.tool_events),
    axes, ledger,
    written_at: new Date().toISOString(),
    note: 'informa; no autoriza commit ni push',
  })
}

function appendRound(dir: string, record: RoundRecord): void {
  const file = join(dir, 'rounds.json')
  const current = optionalJson<{ rounds: RoundRecord[] }>(file) ?? { rounds: [] }
  writeJsonAtomic(file, { rounds: [...current.rounds, record] })
}

function retryArgs(ctx: RunContext, args: string[], field: RejectedField): { args: string[]; requested: string } | null {
  if (ctx.family === 'claude') return claudeRetry(args, field, randomUUID())
  const next = codexRetry(args, field)
  return next && { ...next, args: withResultFile(next.args, join(ctx.dir, `result${ctx.tag}-2.md`)) }
}

/** En Claude la sesión la fija el argv; en Codex solo se conoce cuando el stream abre el hilo. */
function sessionOf(family: Family, args: string[], facts: StreamFacts): string | undefined {
  const i = args.indexOf('--session-id')
  if (family === 'claude' && i >= 0 && i + 1 < args.length) return args[i + 1]
  return facts.sessionId
}

function resumeLaunch(ctx: RunContext, launch: LaunchSpec, sessionId: string): LaunchSpec | null {
  const { dir, family, tag } = ctx
  const args = family === 'claude' ? claudeResume(launch.args) : codexResume(launch.args, sessionId, join(dir, `result${tag}-resume.md`))
  return args ? { ...launch, args, stdinFile: join(dir, `resume${tag}.md`) } : null
}

/** Lo que usó el reintento en lugar del valor rechazado: el modelo si el CLI lo informa, si no el default. */
function effectiveValue(family: Family, field: RejectedField, facts: StreamFacts): string {
  return family === 'claude' && field === 'model' && facts.model ? facts.model : 'default del CLI'
}

const stateAndReason = (o: Outcome) => (o.reason ? `${o.state}/${o.reason}` : o.state)

interface Phase<T> { last: Attempt; outcome: Outcome; review?: T; toolEvents: string[] }
interface Fix { name: string; suffix: string; kind: AttemptKind }

/**
 * Admite la respuesta de un intento terminado. Una respuesta inadmisible tiene una sola corrección,
 * con el error concreto y tope propio; si tampoco se admite, o si el revisor declara que no pudo ver
 * el candidato, termina en `unavailable` con el motivo. La corrección parte del prompt de ese intento.
 */
async function admitPhase<T>(ctx: RunContext, launch: LaunchSpec, last: Attempt, fixSec: number,
  admitFn: (text: string) => Admission<T>, fix: Fix): Promise<Phase<T>> {
  const { dir, family } = ctx
  const adm = admitAttempt(dir, last, admitFn)
  if (adm.kind === 'admitted') return { last, outcome: last.outcome, review: adm.review, toolEvents: [] }
  if (adm.kind === 'unavailable') return { last, outcome: { state: 'unavailable', reason: 'reviewer_unavailable', detail: adm.reason }, toolEvents: [] }

  const text = renderCorrectionPrompt(readFileSync(launch.stdinFile, 'utf8'), adm.error)
  if (Buffer.byteLength(text) > REVIEW_PROMPT_BUDGET) {
    return { last, outcome: { state: 'unavailable', reason: 'correction_over_budget', detail: adm.error }, toolEvents: [] }
  }
  const fixLaunch = correctionLaunch(family, launch, dir, fix.name)
  writeFileSync(fixLaunch.stdinFile, text)
  const fixed = await attempt(ctx, fixLaunch, fix.suffix, Date.now() + fixSec * 1000)
  recordAttempt(ctx, fix.kind, fix.suffix, fixLaunch, fixed)
  const toolEvents = fixed.facts.toolEvents
  if (fixed.outcome.state !== 'done') {
    return { last: fixed, outcome: { state: 'unavailable', reason: 'correction_failed', detail: stateAndReason(fixed.outcome) }, toolEvents }
  }
  const second = admitAttempt(dir, fixed, admitFn)
  if (second.kind === 'admitted') return { last: fixed, outcome: fixed.outcome, review: second.review, toolEvents }
  if (second.kind === 'unavailable') return { last: fixed, outcome: { state: 'unavailable', reason: 'reviewer_unavailable', detail: second.reason }, toolEvents }
  return { last: fixed, outcome: { state: 'unavailable', reason: 'inadmissible_twice', detail: second.error }, toolEvents }
}

type Refutation = { outcome: Parameters<typeof applyRefutation>[1]; record: NonNullable<RoundRecord['refutation']> }

/**
 * Una sola tanda por ronda: el refutador recibe los graves inferenciales con el mismo material que vio
 * el revisor, sin reanudación. Si no llega a una respuesta admitida, toda la tanda queda inconclusa.
 */
async function refute(ctx: RunContext, argv: ArgvFile, candidate: Candidate, batch: LedgerEntry[], fixSec: number): Promise<Refutation> {
  const ids = batch.map((e) => e.id)
  const failed = (reason: string, toolEvents: string[] = []): Refutation =>
    ({ outcome: { failed: reason, ids }, record: { ids, outcome: 'inconclusive', reason, tool_events: toolEvents } })
  if (!argv.refuter_launch || !argv.material) return failed('no_refuter')
  const prompt = renderRefutePrompt(candidate, readFileSync(argv.material, 'utf8'), batch)
  if (Buffer.byteLength(prompt) > REVIEW_PROMPT_BUDGET) return failed('prompt_too_large')
  if (existsSync(ctx.cancelFile)) return failed('cancelled')
  const launch = argv.refuter_launch
  writeFileSync(launch.stdinFile, prompt)
  const first = await attempt(ctx, launch, '-refute', Date.now() + argv.deadline_sec * 1000)
  recordAttempt(ctx, 'refutation', '-refute', launch, first)
  if (first.outcome.state !== 'done') return failed(stateAndReason(first.outcome), first.facts.toolEvents)
  const phase = await admitPhase(ctx, launch, first, fixSec, (t) => admitRefutation(t, candidate, ids),
    { name: `${ctx.tag}-refute-fix`, suffix: '-refute-fix', kind: 'refutation' })
  const toolEvents = [...first.facts.toolEvents, ...phase.toolEvents]
  if (!phase.review) return failed(phase.outcome.reason ?? phase.outcome.state, toolEvents)
  return { outcome: { results: phase.review.results }, record: { ids, outcome: 'admitted', tool_events: toolEvents } }
}

/**
 * Admite la ronda y actualiza el ledger: la 1 lo abre, la n aplica las respuestas y las regresiones.
 * Después, si hay graves inferenciales nuevos, corre la tanda de refutación.
 */
async function reviewRound(ctx: RunContext, argv: ArgvFile, candidate: Candidate, launch: LaunchSpec, last: Attempt, fixSec: number):
  Promise<{ phase: Phase<unknown>; ledger?: Ledger; refutation?: RoundRecord['refutation'] }> {
  const fix: Fix = { name: `${ctx.tag}-fix`, suffix: '-fix', kind: 'correction' }
  let phase: Phase<unknown>
  let ledger: Ledger | undefined
  if (ctx.round === 1) {
    const p = await admitPhase(ctx, launch, last, fixSec, (t) => admit(t, candidate), fix)
    if (p.review) ledger = openLedger(p.review.findings)
    phase = p
  } else {
    if (!argv.plan) throw new Error(`la ronda ${ctx.round} no trae su plan`)
    const plan = readJson<RoundPlan>(argv.plan)
    const p = await admitPhase(ctx, launch, last, fixSec, (t) => admitRound(t, candidate, plan), fix)
    if (p.review) {
      ledger = applyRound(readJson<Ledger>(join(ctx.dir, 'ledger.json')), ctx.round, p.review.responses, p.review.findings)
    }
    phase = p
  }
  if (!ledger) return { phase }
  const batch = refutationBatch(ledger, ctx.round)
  if (batch.length === 0) return { phase, ledger }
  const r = await refute(ctx, argv, candidate, batch, fixSec)
  return { phase, ledger: applyRefutation(ledger, r.outcome), refutation: r.record }
}

/**
 * Lanza al worker de una corrida preparada, aplica el tope y escribe el estado final. Si el CLI
 * rechaza el modelo o el esfuerzo pedido, relanza una sola vez sin ese campo y lo deja registrado.
 * Si se agota el tope, reanuda una sola vez la misma sesión para que entregue lo que tenga. En una
 * revisión, cada ronda lee su propio argv (`argv<tag>.json`).
 */
export async function supervise(dir: string, argvName = 'argv.json'): Promise<Status> {
  const argv = readJson<ArgvFile>(join(dir, argvName))
  const cancelFile = join(dir, 'cancel.request')
  const ctx: RunContext = {
    dir, family: argv.family, grace: argv.grace_ms ?? 10_000, cancelFile, tag: argv.tag ?? '', round: argv.round ?? 1,
  }
  const review = argv.kind === 'review' && argv.candidate ? readJson<Candidate>(argv.candidate) : undefined
  const roundStarted = new Date().toISOString()
  const closeRound = (patch: Partial<RoundRecord> & { state: RunState }) => {
    if (!review) return
    appendRound(dir, {
      n: ctx.round, tag: ctx.tag, candidate_hash: review.hash, base_sha: review.base_sha, head_sha: review.head_sha,
      started_at: roundStarted, ended_at: new Date().toISOString(), extra: argv.extra ?? false, model_effective: null,
      tool_events: [], ...patch,
    })
  }
  const roundPatch: Partial<Status> = review ? { round: ctx.round } : {}
  // Un cancel que llegó antes de que hubiera worker: no se lanza nada.
  if (existsSync(cancelFile)) {
    closeRound({ state: 'cancelled' })
    return setStatus(dir, { state: 'cancelled', ended_at: new Date().toISOString(), ...roundPatch })
  }
  const until = Date.now() + argv.deadline_sec * 1000
  const resumeSec = argv.resume_sec ?? DEFAULT_RESUME_SEC

  let last = await attempt(ctx, argv.launch, '', until)
  recordAttempt(ctx, 'initial', '', argv.launch, last)
  const toolEvents = [...last.facts.toolEvents]
  let { outcome, facts } = last
  let current = argv.launch
  let retry: RetryInfo | undefined
  const rejected = outcome.state === 'launch_failed' ? facts.rejected : undefined
  const next = rejected ? retryArgs(ctx, argv.launch.args, rejected.field) : null
  if (rejected && next) {
    if (existsSync(cancelFile)) {
      outcome = { state: 'cancelled' }
    } else {
      current = { ...argv.launch, args: next.args }
      writeJsonAtomic(join(dir, `argv${ctx.tag}-2.json`), { ...argv, launch: current })
      last = await attempt(ctx, current, '-2', until)
      recordAttempt(ctx, 'profile_retry', '-2', current, last)
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
    const launch = sessionId ? resumeLaunch(ctx, current, sessionId) : null
    if (sessionId && launch) {
      writeFileSync(launch.stdinFile, closingMessage(argv.kind ?? 'run'))
      resume = { session_id: sessionId, started_at: new Date().toISOString() }
      setStatus(dir, { resume })
      writeJsonAtomic(join(dir, `argv${ctx.tag}-resume.json`), { ...argv, launch })
      last = await attempt(ctx, launch, '-resume', Date.now() + resumeSec * 1000)
      recordAttempt(ctx, 'resume', '-resume', launch, last)
      toolEvents.push(...last.facts.toolEvents)
      facts = { ...last.facts, sessionId: last.facts.sessionId ?? sessionId }
      resume = { ...resume, outcome: last.outcome.state }
      // Una reanudación que no entrega deja la corrida en el timeout original, con su sesión.
      if (last.outcome.state === 'done' || last.outcome.state === 'cancelled') outcome = last.outcome
    }
  }

  if (review) {
    let refutation: RoundRecord['refutation']
    if (outcome.state === 'done') {
      const reviewed = await reviewRound(ctx, argv, review, current, last, resumeSec)
      last = reviewed.phase.last
      outcome = reviewed.phase.outcome
      toolEvents.push(...reviewed.phase.toolEvents)
      refutation = reviewed.refutation
      if (reviewed.ledger) writeJsonAtomic(join(dir, 'ledger.json'), reviewed.ledger)
    }
    closeRound({
      state: outcome.state, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}),
      model_effective: last.facts.model ?? null, tool_events: toolEvents,
      ...(retry ? { retry } : {}), ...(resume ? { resume } : {}), ...(refutation ? { refutation } : {}),
    })
    if (existsSync(join(dir, 'ledger.json'))) writeReceipt(dir)
  }

  const patch: Partial<Status> = { ...outcome, ended_at: new Date().toISOString(), ...roundPatch }
  // Cada intento conserva su propia respuesta; `wait` lee la del último.
  if (last.resultFile !== join(dir, 'result.md')) patch.result_file = basename(last.resultFile)
  if (facts.sessionId) patch.session_id = facts.sessionId
  if (retry) patch.retry = retry
  if (resume) patch.resume = resume
  return setStatus(dir, patch)
}
