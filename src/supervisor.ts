import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Outcome, type StreamFacts, classify, emptyFacts, scanLine, usageSince } from './outcome.ts'
import { type Admission, type AdmittedReview, type RoundReview, type Unverifiable, admit, admitRefutation, admitRound, parseLocation } from './review/admit.ts'
import { sliceCandidate } from './review/batch.ts'
import { type Candidate, readContextBlobs } from './review/candidate.ts'
import {
  type Ledger, type LedgerEntry, type Reviewer, type RoundPlan, type Target, applyRefutation, applyRound, axesOf, byProvenance,
  openLedger, refutationBatch, standing, withProvenance,
} from './review/ledger.ts'
import { REVIEW_PROMPT_BUDGET, closingMessage, fits, renderCorrectionPrompt, renderMaterial, renderRefutePrompt } from './review/prompt.ts'
import { type RiskRecord, readRisk } from './review/risk.ts'
import { dirtyPaths, headCommit } from './git.ts'
import { readJson, setStatus, writeJsonAtomic } from './runs.ts'
import type {
  AttemptKind, AttemptMetrics, Family, LaunchSpec, RejectedField, Resolution, ResumeInfo, RetryInfo, RunState, Status, Usage, WorkerTask,
} from './types.ts'
import { ARTIFACT_SYSTEM_PROMPT, REFUTER_SYSTEM_PROMPT, claudeResume, claudeRetry, claudeReviewLaunch, withSessionId } from './workers/claude.ts'
import { codexResume, codexRetry, codexReviewLaunch, withResultFile } from './workers/codex.ts'
import {
  type GroupIdentity, captureTreeAtBase, freezeHarvest, groupState, launchTreeDiff, launchTreeHolds, readControl, readProcess, recordGroup, writeControl,
} from './writer-store.ts'
import { type DocumentContract, admitPlan, admitSpecify, admitTasks } from './sdd/phase.ts'
import { readPhaseRecord, withFlowLock, writePhaseRecord } from './sdd/phase-state.ts'
import { type FrozenLaunch, type PublishOutcome, publishPhase } from './sdd/publish.ts'

/** Un revisor sobre un lote. `prompt` es la ruta de su prompt, ya medido y escrito por la CLI. */
export interface ReviewJob { key: string; reviewer: Reviewer; batch: number; paths: string[]; prompt: string; targets?: Target[] }

/**
 * Cómo terminó un trabajo en un lanzamiento. `prompt_sha256` es la identidad de su encargo: el
 * candidato, el revisor, el lote, los pendientes, las decisiones y sus motivos.
 */
export interface JobRecord {
  key: string; reviewer: Reviewer; batch: number; launch: number; state: RunState; reason?: string; detail?: string
  admitted?: string; prompt_sha256: string; model_effective: string | null; tool_events: string[]
  retry?: RetryInfo; resume?: ResumeInfo
}

export interface ArgvFile {
  family: Family; deadline_sec: number; grace_ms?: number
  /** El worker de `run`. Una revisión arma el de cada trabajo, con su propio temporal. */
  launch?: LaunchSpec
  /** Tope de la reanudación que sigue a un `timeout`; el de la corrida ya venció a esa altura. */
  resume_sec?: number
  kind?: 'run' | 'review' | 'writer' | 'phase'
  /** Una corrida de fase: lo que congeló al lanzarse, la raíz del repo y, en `tasks`, los criterios de la spec. */
  phase?: FrozenLaunch & { root: string; criteria?: string[] }
  /** Un writer: la raíz del checkout que lo lanzó y su corrida. El supervisor corre en su almacén. */
  root?: string
  id?: string
  candidate?: string
  /** Ronda de la revisión; por defecto 1. */
  round?: number
  /** Marca de los archivos de la ronda: '' en la 1, `-r<n>` desde la 2. */
  tag?: string
  /** `round<tag>.json` de una ronda n≥2: qué verifica, qué responde y dónde admite regresiones. */
  plan?: string
  /** La ronda la concedió `--extra`, más allá del tope. */
  extra?: boolean
  /** Número de este lanzamiento de la ronda: separa sus archivos de los de un relanzamiento. */
  launch_n?: number
  reviewer_resolution?: Resolution
  refuter_resolution?: Resolution
  /** Los trabajos a correr, en serie y en este orden. */
  jobs?: ReviewJob[]
  /** Los trabajos ya admitidos en un lanzamiento anterior de la misma ronda, que no se repiten. */
  kept?: JobRecord[]
  batches?: string[][]
  risk?: RiskRecord
}

/** Cómo terminó una sub-tanda de refutación: sus hallazgos, los archivos de su material y su resultado. */
export interface SubBatchRecord { ids: string[]; paths: string[]; outcome: 'admitted' | 'inconclusive'; reason?: string }

/**
 * La refutación de una ronda. `trimmed` dice si el material no entró entero y la tanda se partió por
 * hallazgos; `partial` es que algunas sub-tandas se admitieron y otras no.
 */
export interface RefutationRecord {
  ids: string[]; outcome: 'admitted' | 'inconclusive' | 'partial'; reason?: string; tool_events: string[]
  trimmed: boolean; batches: SubBatchRecord[]
}

/** Una entrada de `rounds.json` por ronda lanzada, haya terminado o no. */
export interface RoundRecord {
  n: number; tag: string; candidate_hash: string; base_sha: string | null; head_sha: string | null
  state: RunState; reason?: string; detail?: string; started_at: string; ended_at: string
  extra: boolean; model_effective: string | null
  tool_events: string[]; retry?: RetryInfo; resume?: ResumeInfo
  refutation?: RefutationRecord
  launch?: number; risk?: RiskRecord; batches?: string[][]; jobs?: JobRecord[]
  /** En un artefacto, lo que el revisor de esta ronda no pudo comprobar. */
  unverifiable?: Unverifiable[]
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

/**
 * Señala al grupo solo si todavía existe: un id de grupo no se reutiliza mientras tenga procesos, pero
 * uno vacío sí. Queda la ventana mínima entre la consulta y la señal.
 */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, 0)
    process.kill(-pid, signal)
  } catch {
    // El grupo ya no existe.
  }
}

const SCRATCH_PREFIX = 'sdd-ai-review-'

/**
 * Borra un temporal de un trabajo, y solo eso: un directorio que está directamente bajo el temporal
 * del sistema y cuyo nombre empieza con el prefijo de sdd-ai. Devuelve si borró.
 */
export function removeScratch(dir: string): boolean {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return false
  }
  if (dirname(real) !== realpathSync(tmpdir()) || !basename(real).startsWith(SCRATCH_PREFIX)) return false
  rmSync(real, { recursive: true, force: true })
  return true
}

/**
 * Corre `fn` con un directorio vacío propio y lo borra al terminar, sea cual sea el final. Vive el
 * trabajo entero porque la reanudación de Codex usa el cwd del proceso.
 */
export async function withScratch<T>(fn: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
  try {
    return await fn(scratch)
  } finally {
    removeScratch(scratch)
  }
}

/**
 * `tag` separa las rondas y `prefix` los archivos de E/S de cada trabajo (`<tag>-l<k>-<clave>`; '' en
 * `run`). `job` es la procedencia que va a `metrics.json`. `once` se comparte entre los trabajos.
 */
interface RunContext {
  dir: string; family: Family; grace: number; cancelFile: string; tag: string; round: number; prefix: string
  argv: ArgvFile
  job?: { reviewer: Reviewer | 'refute'; batch: number; launch: number }
  once: { started: boolean }
  threadUsage: Map<string, Usage>
  /** Un writer: su identidad de grupo se registra en el almacén al arrancar. */
  writer?: { root: string; id: string }
  /** Antes del reintento por perfil: si devuelve falso, no se reintenta. */
  canRetry?: () => Promise<boolean>
}
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

/** La identidad del grupo del writer, leída de `ps` una vez que el CLI ya corre. */
function recordLeader(w: { root: string; id: string }, pid: number): void {
  const seen = readProcess(pid)
  const g: GroupIdentity = seen && seen !== 'gone'
    ? { pid, pgid: seen.pgid, lstart: seen.lstart, argvHash: seen.argvHash }
    : { pid, pgid: pid, lstart: null, argvHash: '' }
  recordGroup(w.root, w.id, g)
}

/**
 * Un lanzamiento del worker. Cada intento escribe sus propios logs (`<prefijo><suffix>`) para que la
 * salida de uno no se mezcle con la clasificación de otro, ni con la de otro trabajo o lanzamiento.
 */
async function attempt(ctx: RunContext, launch: LaunchSpec, suffix: string, until: number): Promise<Attempt> {
  const { dir, family, grace, cancelFile } = ctx
  const name = `${ctx.prefix}${suffix}`
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

  let leaderRecorded = false
  if (child.pid !== undefined) {
    const pid = child.pid
    const running: Partial<Status> = { state: 'running', worker_pid: pid, supervisor_pid: process.pid }
    if (!ctx.once.started) {
      running.started_at = new Date().toISOString()
      ctx.once.started = true
    }
    setStatus(dir, running)
    createInterface({ input: child.stdout! }).on('line', (line) => {
      // La primera línea prueba que el CLI ya corre su propio código: su comando es el definitivo.
      if (ctx.writer && !leaderRecorded) {
        leaderRecorded = true
        recordLeader(ctx.writer, pid)
      }
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
  // Un writer que terminó sin escribir nada: su grupo se registra igual, sin hora de inicio.
  if (ctx.writer && !leaderRecorded && child.pid !== undefined) {
    recordGroup(ctx.writer.root, ctx.writer.id, { pid: child.pid, pgid: child.pid, lstart: null, argvHash: '' })
  }
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
  // Claude entrega la respuesta en el stream; Codex también, cuando no se le pidió archivo.
  if (family === 'claude' || !launch.args.includes('--output-last-message')) {
    // Sin resultado en el stream no hay archivo: un archivo vacío se leería como una respuesta.
    if (facts.result !== undefined) {
      resultText = facts.result
      writeFileSync(resultFile, resultText)
    }
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

/**
 * Suma el intento a `metrics.json`: ronda, procedencia, duración, bytes del prompt, tokens y dónde quedó
 * su salida cruda. Un resultado que el worker no escribió queda como `null`.
 */
function recordAttempt(ctx: RunContext, kind: AttemptKind, suffix: string, launch: LaunchSpec, a: Attempt): void {
  const { dir } = ctx
  const file = join(dir, 'metrics.json')
  const m: MetricsFile = existsSync(file) ? readJson<MetricsFile>(file) : { attempts: [], totals: { duration_ms: 0, attempts: 0, inadmissible: 0 } }
  const entry: AttemptMetrics = {
    round: ctx.round, ...(ctx.job ?? {}),
    kind, suffix, started_at: a.startedAt.toISOString(), ended_at: a.endedAt.toISOString(),
    duration_ms: a.endedAt.getTime() - a.startedAt.getTime(), prompt_bytes: statSync(launch.stdinFile).size,
    outcome: a.outcome.state,
    raw: {
      stdout: relative(dir, a.stdoutFile), stderr: relative(dir, a.stderrFile),
      result: existsSync(a.resultFile) ? relative(dir, a.resultFile) : null,
    },
  }
  if (a.facts.usage) {
    // Codex informa el acumulado del hilo: un intento que lo reanuda guarda lo que sumó desde el último
    // acumulado conocido. El hilo sale de su argv, porque el stream de una reanudación puede no traerlo.
    const resumed = ctx.family === 'codex' && isResumeArgs(ctx.family, launch.args) ? sessionOf(ctx.family, launch.args, a.facts) : undefined
    const before = resumed ? ctx.threadUsage.get(resumed) : undefined
    entry.usage = before ? usageSince(a.facts.usage, before) : a.facts.usage
    const sessionId = resumed ?? a.facts.sessionId
    if (ctx.family === 'codex' && sessionId) ctx.threadUsage.set(sessionId, a.facts.usage)
  }
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

/** El límite de repartir en lotes: lo que la vista y el recibo advierten cuando una ronda corrió en más de uno. */
export const BATCHES_NOTE = 'las relaciones entre archivos de lotes distintos no se revisaron juntas'

/** Los lotes de una ronda, numerados, con su advertencia; nada si corrió en uno solo. */
export function declaredBatches(batches: string[][] | undefined): { batches?: Array<{ n: number; paths: string[] }>; batches_note?: string } {
  if (!batches || batches.length < 2) return {}
  return { batches: batches.map((paths, i) => ({ n: i + 1, paths })), batches_note: BATCHES_NOTE }
}

/** Lo que el conductor necesita de cada trabajo: quién, qué lote, en qué lanzamiento y cómo terminó. */
export const jobSummary = (j: JobRecord) => ({
  key: j.key, reviewer: j.reviewer, batch: j.batch, launch: j.launch, state: j.state, ...(j.reason ? { reason: j.reason } : {}),
})

const roundDegradations = (r: RoundRecord) => {
  const jobs = r.jobs ?? []
  const retry = r.retry !== undefined || jobs.some((j) => j.retry !== undefined)
  const resume = r.resume !== undefined || jobs.some((j) => j.resume !== undefined)
  return [...(retry ? ['profile_retry'] : []), ...(resume ? ['resume'] : [])]
}

/**
 * Reescribe el veredicto y el recibo desde el ledger y `rounds.json`: qué se revisó en cada ronda,
 * quién, con qué degradaciones y qué quedó. Son proyecciones; nadie los lee para decidir. Informa;
 * no autoriza.
 */
/** Lo que dice el recibo de un artefacto: el veredicto no aprueba nada, el gate es de la persona. */
export const ARTIFACT_NOTE = 'el veredicto informa; el gate del artefacto lo decide la persona'

export function writeReceipt(dir: string): void {
  const ledger = readJson<Ledger>(join(dir, 'ledger.json'))
  const rounds = optionalJson<{ rounds: RoundRecord[] }>(join(dir, 'rounds.json'))?.rounds ?? []
  const request = optionalJson<{ selection?: unknown; author?: string; degradations?: string[]; risk?: RiskRecord }>(join(dir, 'request.json'))
  const resolved = readJson<Resolution>(join(dir, 'resolved.json'))
  const axes = axesOf(ledger)
  // La última ronda que avanzó el ledger: una terminada, o una cancelada en la refutación, que corre
  // después de escribirlo.
  const lastDone = rounds.filter((r) => r.state === 'done' || (r.state === 'cancelled' && r.refutation)).at(-1)
  const degradations = [...(request?.degradations ?? [])]
  for (const d of rounds.flatMap(roundDegradations)) if (!degradations.includes(d)) degradations.push(d)
  const artifact = ledger.artifact === true
  const informative = ledger.entries.filter((e) => e.state === 'informativo')
    .map((e) => ({ id: e.id, of: e.of, severity: e.severity, claim: e.claim, location: e.location }))
  writeJsonAtomic(join(dir, 'verdict.json'), {
    ...axes, findings: standing(ledger).map(withProvenance),
    out_of_scope: ledger.entries.filter((e) => e.state === 'fuera-de-alcance').map(withProvenance),
    ...(artifact ? { informative } : {}),
  })
  writeJsonAtomic(join(dir, 'receipt.json'), {
    candidate_hash: lastDone?.candidate_hash ?? null, base_sha: lastDone?.base_sha ?? null, head_sha: lastDone?.head_sha ?? null,
    rounds: rounds.map((r) => ({
      n: r.n, candidate_hash: r.candidate_hash, base_sha: r.base_sha, head_sha: r.head_sha, state: r.state,
      ...(r.reason ? { reason: r.reason } : {}), extra: r.extra, model_effective: r.model_effective,
      degradations: roundDegradations(r), tool_events: r.tool_events, ...(r.refutation ? { refutation: r.refutation } : {}),
      ...declaredBatches(r.batches), ...(r.jobs ? { jobs: r.jobs.map(jobSummary) } : {}),
    })),
    selection: request?.selection ?? null, author: request?.author ?? null,
    risk: artifact ? { level: 'no_aplica' } : readRisk(request ?? {}),
    reviewer: {
      family: resolved.family, model_requested: resolved.model ?? null,
      model_effective: lastDone?.model_effective ?? null, effort: resolved.effort ?? null,
    },
    degradations, tool_events: rounds.flatMap((r) => r.tool_events),
    axes, ledger: { ...ledger, entries: ledger.entries.map(withProvenance) },
    written_at: new Date().toISOString(),
    ...(artifact
      ? { informative, unverifiable: lastDone?.unverifiable ?? [], note: ARTIFACT_NOTE }
      : { note: 'informa; no autoriza commit ni push' }),
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
  return next && { ...next, args: withResultFile(next.args, join(ctx.dir, `result${ctx.prefix}-2.md`)) }
}

/** En Claude la sesión la fija el argv; en Codex solo se conoce cuando el stream abre el hilo. */
function sessionOf(family: Family, args: string[], facts: StreamFacts): string | undefined {
  const i = args.indexOf('--session-id')
  if (family === 'claude' && i >= 0 && i + 1 < args.length) return args[i + 1]
  const r = args.indexOf('--resume')
  if (family === 'claude' && r >= 0 && r + 1 < args.length) return args[r + 1]
  // Un argv de Codex que ya reanuda lleva el hilo justo antes del `-` final (`codexResume`): el stream
  // de la reanudación puede no volver a informarlo.
  if (family === 'codex' && args[1] === 'resume' && args.length > 3 && args.at(-1) === '-') return args.at(-2)
  return facts.sessionId
}

/** Si el argv ya reanuda una sesión: el de una corrida encadenada que continúa la de otra. */
const isResumeArgs = (family: Family, args: string[]) => (family === 'claude' ? args.includes('--resume') : args[1] === 'resume')

function resumeLaunch(ctx: RunContext, launch: LaunchSpec, sessionId: string): LaunchSpec | null {
  const { dir, family, prefix } = ctx
  // Un argv que ya reanuda la sesión sirve tal cual para cerrarla: solo cambia el mensaje.
  const args = isResumeArgs(family, launch.args) ? launch.args
    : family === 'claude' ? claudeResume(launch.args) : codexResume(launch.args, sessionId, join(dir, `result${prefix}-resume.md`))
  return args ? { ...launch, args, stdinFile: join(dir, `resume${prefix}.md`) } : null
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
  // Un prompt medido con la reserva nunca llega acá; queda como defensa.
  if (Buffer.byteLength(text) > REVIEW_PROMPT_BUDGET) {
    return { last, outcome: { state: 'unavailable', reason: 'correction_over_budget', detail: adm.error }, toolEvents: [] }
  }
  const fixLaunch = correctionLaunch(family, launch, dir, fix.name)
  writeFileSync(fixLaunch.stdinFile, text)
  const fixed = await attempt(ctx, fixLaunch, fix.suffix, Date.now() + fixSec * 1000)
  recordAttempt(ctx, fix.kind, fix.suffix, fixLaunch, fixed)
  const toolEvents = fixed.facts.toolEvents
  // Un cancel durante la corrección es un cancel, no una corrección fallida: la ronda termina cancelada.
  if (fixed.outcome.state === 'cancelled') return { last: fixed, outcome: fixed.outcome, toolEvents }
  if (fixed.outcome.state !== 'done') {
    return { last: fixed, outcome: { state: 'unavailable', reason: 'correction_failed', detail: stateAndReason(fixed.outcome) }, toolEvents }
  }
  const second = admitAttempt(dir, fixed, admitFn)
  if (second.kind === 'admitted') return { last: fixed, outcome: fixed.outcome, review: second.review, toolEvents }
  if (second.kind === 'unavailable') return { last: fixed, outcome: { state: 'unavailable', reason: 'reviewer_unavailable', detail: second.reason }, toolEvents }
  return { last: fixed, outcome: { state: 'unavailable', reason: 'inadmissible_twice', detail: second.error }, toolEvents }
}

/** El revisor o el refutador de una ronda, en su temporal y con una sesión nueva. */
function reviewLaunch(r: Resolution, promptFile: string, resultFile: string, scratch: string, systemPrompt?: string): LaunchSpec {
  const task: WorkerTask & { scratch: string } = { cwd: scratch, promptFile, resultFile, sessionId: randomUUID(), scratch }
  if (r.model) task.model = r.model
  if (r.effort) task.effort = r.effort
  return r.family === 'claude' ? claudeReviewLaunch({ ...task, ...(systemPrompt ? { systemPrompt } : {}) }) : codexReviewLaunch(task)
}

/** Los hallazgos que se juzgan juntos y los archivos que su material necesita. */
interface SubBatch { entries: LedgerEntry[]; paths: string[] }

/**
 * Parte la tanda si el material entero no entra: se recorre por ID y se empaqueta de forma voraz. Cada
 * hallazgo aporta el archivo de su cita, o ninguno si cita el contexto, y entra en la sub-tanda si el
 * prompt con la unión de archivos entra. Uno que no entra ni solo no se lanza.
 */
function packRefutation(c: Candidate, contextTexts: Map<string, string>, batch: LedgerEntry[]):
  { subs: SubBatch[]; tooLarge: LedgerEntry[]; trimmed: boolean } {
  const all = c.files.map((f) => f.path)
  const fitsWith = (paths: string[], entries: LedgerEntry[]) =>
    fits(renderRefutePrompt(c, renderMaterial(c, contextTexts, sliceCandidate(c, paths)), entries))
  if (fitsWith(all, batch)) return { subs: [{ entries: batch, paths: all }], tooLarge: [], trimmed: false }
  const fileOf = (e: LedgerEntry) => {
    const cited = parseLocation(e.location).path
    return all.includes(cited) ? [cited] : []
  }
  const subs: SubBatch[] = []
  const tooLarge: LedgerEntry[] = []
  let current: SubBatch = { entries: [], paths: [] }
  for (const e of batch) {
    const paths = [...new Set([...current.paths, ...fileOf(e)])]
    if (fitsWith(paths, [...current.entries, e])) {
      current = { entries: [...current.entries, e], paths }
    } else if (!fitsWith(fileOf(e), [e])) {
      tooLarge.push(e)
    } else {
      if (current.entries.length > 0) subs.push(current)
      current = { entries: [e], paths: fileOf(e) }
    }
  }
  if (current.entries.length > 0) subs.push(current)
  return { subs, tooLarge, trimmed: true }
}

interface SubResult { outcome: Parameters<typeof applyRefutation>[1]; record: SubBatchRecord; toolEvents: string[] }

/**
 * Una sub-tanda en su temporal: un solo intento, sin reanudación ni reintento de perfil, admitido
 * contra los archivos y el contexto de su material. Si no llega a una respuesta admitida, sus
 * hallazgos quedan inconclusos con el motivo.
 */
async function refuteSub(ctx: RunContext, resolution: Resolution, c: Candidate, contextTexts: Map<string, string>, sub: SubBatch,
  j: number, launchN: number, fixSec: number): Promise<SubResult> {
  const { dir, argv } = ctx
  const ids = sub.entries.map((e) => e.id)
  const failed = (reason: string, toolEvents: string[] = []): SubResult =>
    ({ outcome: { failed: reason, ids }, record: { ids, paths: sub.paths, outcome: 'inconclusive', reason }, toolEvents })
  const view = sliceCandidate(c, sub.paths)
  const prefix = `${ctx.tag}-l${launchN}-refute-s${j}`
  const rctx: RunContext = { ...ctx, family: resolution.family, prefix, job: { reviewer: 'refute', batch: j, launch: launchN } }
  const promptFile = join(dir, `prompt${prefix}.md`)
  writeFileSync(promptFile, renderRefutePrompt(c, renderMaterial(c, contextTexts, view), sub.entries))
  return withScratch(async (scratch) => {
    const launch = reviewLaunch(resolution, promptFile, join(dir, `result${prefix}.md`), scratch, REFUTER_SYSTEM_PROMPT)
    const first = await attempt(rctx, launch, '', Date.now() + argv.deadline_sec * 1000)
    recordAttempt(rctx, 'refutation', '', launch, first)
    if (first.outcome.state !== 'done') return failed(stateAndReason(first.outcome), first.facts.toolEvents)
    const phase = await admitPhase(rctx, launch, first, fixSec, (t) => admitRefutation(t, view, ids),
      { name: `${prefix}-fix`, suffix: '-fix', kind: 'refutation' })
    const toolEvents = [...first.facts.toolEvents, ...phase.toolEvents]
    if (!phase.review) return failed(phase.outcome.reason ?? phase.outcome.state, toolEvents)
    return { outcome: { results: phase.review.results }, record: { ids, paths: sub.paths, outcome: 'admitted' }, toolEvents }
  })
}

/**
 * La refutación de los graves inferenciales de la ronda, en sub-tandas medidas antes de lanzar. Cada
 * resultado se aplica al ledger en orden, apenas llega. Un cancel detiene la sub-tanda en curso y no
 * lanza las demás: lo que no tiene resultado queda inconcluso por `cancelled`.
 */
async function refute(ctx: RunContext, c: Candidate, ledger: Ledger, batch: LedgerEntry[], fixSec: number, launchN: number):
  Promise<{ ledger: Ledger; record: RefutationRecord; cancelled: boolean }> {
  const { dir, argv, cancelFile } = ctx
  const ids = batch.map((e) => e.id)
  const records: SubBatchRecord[] = []
  const toolEvents: string[] = []
  let l = ledger
  let cancelled = false
  const settle = (outcome: Parameters<typeof applyRefutation>[1]) => {
    l = applyRefutation(l, outcome)
    writeJsonAtomic(join(dir, 'ledger.json'), l)
  }
  const resolution = argv.refuter_resolution
  if (!resolution) {
    settle({ failed: 'no_refuter', ids })
    const batches: SubBatchRecord[] = [{ ids, paths: [], outcome: 'inconclusive', reason: 'no_refuter' }]
    return { ledger: l, record: { ids, outcome: 'inconclusive', reason: 'no_refuter', tool_events: [], trimmed: false, batches }, cancelled }
  }
  const contextTexts = readContextBlobs(dir, c)
  const { subs, tooLarge, trimmed } = packRefutation(c, contextTexts, batch)
  for (const e of tooLarge) {
    settle({ failed: 'prompt_too_large', ids: [e.id] })
    records.push({ ids: [e.id], paths: [parseLocation(e.location).path], outcome: 'inconclusive', reason: 'prompt_too_large' })
  }
  for (const [i, sub] of subs.entries()) {
    const subIds = sub.entries.map((e) => e.id)
    if (cancelled || existsSync(cancelFile)) {
      cancelled = true
      settle({ failed: 'cancelled', ids: subIds })
      records.push({ ids: subIds, paths: sub.paths, outcome: 'inconclusive', reason: 'cancelled' })
      continue
    }
    setStatus(dir, { job: { phase: 'refutation', key: `refute-s${i + 1}`, index: i + 1, total: subs.length } })
    const r = await refuteSub(ctx, resolution, c, contextTexts, sub, i + 1, launchN, fixSec)
    settle(r.outcome)
    records.push(r.record)
    toolEvents.push(...r.toolEvents)
    if (r.record.reason === 'cancelled') cancelled = true
  }
  const admitted = records.filter((r) => r.outcome === 'admitted').length
  const outcome = admitted === records.length ? 'admitted' : admitted === 0 ? 'inconclusive' : 'partial'
  const reasons = [...new Set(records.map((r) => r.reason).filter((r) => r !== undefined))]
  const record: RefutationRecord = {
    ids, outcome, ...(outcome === 'inconclusive' && reasons.length === 1 ? { reason: reasons[0] } : {}),
    tool_events: toolEvents, trimmed, batches: records,
  }
  return { ledger: l, record, cancelled }
}

interface Attempts {
  last: Attempt; outcome: Outcome; facts: StreamFacts; current: LaunchSpec; toolEvents: string[]
  retry?: RetryInfo; resume?: ResumeInfo
}

/**
 * El intento de un worker con sus dos recuperaciones: si el CLI rechaza el modelo o el esfuerzo
 * pedido, relanza una sola vez sin ese campo; si se agota el tope, reanuda una sola vez la misma
 * sesión para que entregue lo que tenga.
 */
async function runAttempts(ctx: RunContext, launch: LaunchSpec, until: number, resumeSec: number, kind: 'run' | 'review' | 'write'): Promise<Attempts> {
  const { dir, cancelFile, argv } = ctx
  let last = await attempt(ctx, launch, '', until)
  recordAttempt(ctx, 'initial', '', launch, last)
  const toolEvents = [...last.facts.toolEvents]
  let { outcome, facts } = last
  let current = launch
  let retry: RetryInfo | undefined
  const rejected = outcome.state === 'launch_failed' ? facts.rejected : undefined
  const next = rejected ? retryArgs(ctx, launch.args, rejected.field) : null
  if (rejected && next && (await ctx.canRetry?.() ?? true)) {
    if (existsSync(cancelFile)) {
      outcome = { state: 'cancelled' }
    } else {
      current = { ...launch, args: next.args }
      writeJsonAtomic(join(dir, `argv${ctx.prefix}-2.json`), { ...argv, launch: current })
      last = await attempt(ctx, current, '-2', until)
      recordAttempt(ctx, 'profile_retry', '-2', current, last)
      toolEvents.push(...last.facts.toolEvents)
      outcome = last.outcome
      facts = last.facts
      retry = {
        field: rejected.field, requested: next.requested,
        effective: effectiveValue(ctx.family, rejected.field, facts), diagnostic: rejected.diagnostic,
      }
    }
  }

  let resume: ResumeInfo | undefined
  if (outcome.state === 'timeout' && !existsSync(cancelFile)) {
    const sessionId = sessionOf(ctx.family, current.args, facts)
    const resumed = sessionId ? resumeLaunch(ctx, current, sessionId) : null
    if (sessionId && resumed) {
      writeFileSync(resumed.stdinFile, closingMessage(kind))
      resume = { session_id: sessionId, started_at: new Date().toISOString() }
      setStatus(dir, { resume })
      writeJsonAtomic(join(dir, `argv${ctx.prefix}-resume.json`), { ...argv, launch: resumed })
      last = await attempt(ctx, resumed, '-resume', Date.now() + resumeSec * 1000)
      recordAttempt(ctx, 'resume', '-resume', resumed, last)
      toolEvents.push(...last.facts.toolEvents)
      facts = { ...last.facts, sessionId: last.facts.sessionId ?? sessionId }
      resume = { ...resume, outcome: last.outcome.state }
      // Una reanudación que no entrega deja el intento en el timeout original, con su sesión.
      if (last.outcome.state === 'done' || last.outcome.state === 'cancelled') outcome = last.outcome
    }
  }
  return { last, outcome, facts, current, toolEvents, ...(retry ? { retry } : {}), ...(resume ? { resume } : {}) }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/**
 * Un trabajo de revisión en su temporal: lanza con su propio tope, y si el revisor entrega, lo admite
 * contra la vista de su lote. La respuesta admitida queda en `admitted<prefijo>.json`.
 */
async function runJob(ctx: RunContext, job: ReviewJob, candidate: Candidate, plan: RoundPlan | undefined,
  launchN: number, resumeSec: number): Promise<JobRecord> {
  const { argv, dir } = ctx
  const resolution = argv.reviewer_resolution
  if (!resolution) throw new Error('la ronda no trae la resolución del revisor')
  const prefix = `${ctx.tag}-l${launchN}-${job.key}`
  const jctx: RunContext = { ...ctx, prefix, job: { reviewer: job.reviewer, batch: job.batch, launch: launchN } }
  const base = { key: job.key, reviewer: job.reviewer, batch: job.batch, launch: launchN, prompt_sha256: sha256(readFileSync(job.prompt)) }
  return withScratch(async (scratch) => {
    const launch = reviewLaunch(resolution, job.prompt, join(dir, `result${prefix}.md`), scratch, candidate.subject ? ARTIFACT_SYSTEM_PROMPT : undefined)
    const r = await runAttempts(jctx, launch, Date.now() + argv.deadline_sec * 1000, resumeSec, 'review')
    const extras = { ...(r.retry ? { retry: r.retry } : {}), ...(r.resume ? { resume: r.resume } : {}) }
    if (r.outcome.state !== 'done') {
      return { ...base, ...outcomeFields(r.outcome), model_effective: r.last.facts.model ?? null, tool_events: r.toolEvents, ...extras }
    }
    // Un artefacto es un solo trabajo con todo el material: no hay lotes que recortar.
    const view = candidate.subject ? candidate : sliceCandidate(candidate, job.paths)
    const fix: Fix = { name: `${prefix}-fix`, suffix: '-fix', kind: 'correction' }
    const phase: Phase<AdmittedReview | RoundReview> = plan
      ? await admitPhase(jctx, r.current, r.last, resumeSec, (t) => admitRound(t, view, narrow(plan, job)), fix)
      : await admitPhase(jctx, r.current, r.last, resumeSec, (t) => admit(t, view), fix)
    const common = { model_effective: phase.last.facts.model ?? null, tool_events: [...r.toolEvents, ...phase.toolEvents], ...extras }
    if (!phase.review) return { ...base, ...outcomeFields(phase.outcome), ...common }
    const admitted = `admitted${prefix}.json`
    writeJsonAtomic(join(dir, admitted), phase.review)
    return { ...base, state: 'done', admitted, ...common }
  })
}

const outcomeFields = (o: Outcome) => ({ state: o.state, ...(o.reason ? { reason: o.reason } : {}), ...(o.detail ? { detail: o.detail } : {}) })

/** El plan de la ronda acotado a un trabajo: sus pendientes y los cambios de sus rutas. */
function narrow(plan: RoundPlan, job: ReviewJob): RoundPlan {
  const changed = Object.fromEntries(Object.entries(plan.changed).filter(([p]) => job.paths.includes(p)))
  return { ...plan, targets: job.targets ?? plan.targets, changed }
}

type Admitted = JobRecord & { admitted: string }

/**
 * Abre o avanza el ledger una sola vez, con las respuestas de todos los trabajos. La procedencia la
 * anota el código y los hallazgos entran en el orden fijo: base, lentes y lote.
 */
function advance(ctx: RunContext, records: Admitted[], plan: RoundPlan | undefined, candidate: Candidate): Ledger {
  const withProvenance = <T extends { findings: AdmittedReview['findings'] }>(r: Admitted, review: T) =>
    review.findings.map((f) => ({ ...f, reviewer: r.reviewer, batch: r.batch }))
  if (!plan) {
    return openLedger(byProvenance(records.flatMap((r) => withProvenance(r, readJson<AdmittedReview>(join(ctx.dir, r.admitted))))),
      { artifact: candidate.subject !== undefined })
  }
  const reviews = records.map((r) => ({ r, review: readJson<RoundReview>(join(ctx.dir, r.admitted)) }))
  return applyRound(readJson<Ledger>(join(ctx.dir, 'ledger.json')), ctx.round, reviews.flatMap((x) => x.review.responses),
    byProvenance(reviews.flatMap((x) => withProvenance(x.r, x.review))))
}

const jobState = (r: JobRecord) => `${r.key}: ${r.state}${r.reason ? `/${r.reason}` : ''}`

/**
 * Una ronda de revisión: recorre sus trabajos en serie, cada uno con su tope y su temporal. Un trabajo
 * que no queda admitido no detiene a los demás; un cancel sí. Con todos admitidos se abre o avanza el
 * ledger y se refuta; si falta alguno, la ronda termina `unavailable` con el estado de cada uno.
 */
async function superviseReview(ctx: RunContext, resumeSec: number): Promise<Status> {
  const { dir, argv, cancelFile } = ctx
  if (!argv.candidate) throw new Error('la ronda no trae su candidato')
  const candidate = readJson<Candidate>(argv.candidate)
  if (ctx.round > 1 && !argv.plan) throw new Error(`la ronda ${ctx.round} no trae su plan`)
  const plan = argv.plan ? readJson<RoundPlan>(argv.plan) : undefined
  const launchN = argv.launch_n ?? 1
  const startedAt = new Date().toISOString()
  const jobs = argv.jobs ?? []
  const records: JobRecord[] = [...(argv.kept ?? [])]
  let cancelled = false
  for (const [i, job] of jobs.entries()) {
    if (existsSync(cancelFile)) {
      cancelled = true
      break
    }
    setStatus(dir, { job: { phase: 'review', key: job.key, reviewer: job.reviewer, batch: job.batch, index: i + 1, total: jobs.length } })
    const record = await runJob(ctx, job, candidate, plan, launchN, resumeSec)
    records.push(record)
    if (record.state === 'cancelled') {
      cancelled = true
      break
    }
  }

  const ordered = byProvenance(records)
  let outcome: Outcome
  let refutation: RefutationRecord | undefined
  const admitted = ordered.filter((r): r is Admitted => r.admitted !== undefined)
  if (cancelled) {
    outcome = { state: 'cancelled' }
  } else if (admitted.length === ordered.length) {
    // El ledger se escribe antes de refutar: un cancel en la refutación deja la ronda con sus respuestas.
    const ledger = advance(ctx, admitted, plan, candidate)
    writeJsonAtomic(join(dir, 'ledger.json'), ledger)
    // Un artefacto no se refuta: casi todo hallazgo sobre un documento es inferencial.
    const batch = candidate.subject ? [] : refutationBatch(ledger, ctx.round)
    const r = batch.length > 0 ? await refute(ctx, candidate, ledger, batch, resumeSec, launchN) : undefined
    refutation = r?.record
    outcome = { state: r?.cancelled ? 'cancelled' : 'done' }
  } else {
    outcome = { state: 'unavailable', reason: 'jobs_incomplete', detail: ordered.map(jobState).join(', ') }
  }

  const unverifiable = candidate.subject && outcome.state === 'done' && admitted.length > 0
    ? readJson<AdmittedReview | RoundReview>(join(dir, admitted[0].admitted)).unverifiable ?? []
    : undefined
  appendRound(dir, {
    n: ctx.round, tag: ctx.tag, candidate_hash: candidate.hash, base_sha: candidate.base_sha, head_sha: candidate.head_sha,
    ...outcomeFields(outcome), started_at: startedAt, ended_at: new Date().toISOString(), extra: argv.extra ?? false,
    model_effective: ordered[0]?.model_effective ?? null, tool_events: ordered.flatMap((r) => r.tool_events),
    launch: launchN, ...(argv.risk ? { risk: argv.risk } : {}), ...(argv.batches ? { batches: argv.batches } : {}),
    jobs: ordered, ...(refutation ? { refutation } : {}), ...(unverifiable ? { unverifiable } : {}),
  })
  if (existsSync(join(dir, 'ledger.json'))) writeReceipt(dir)
  const patch: Partial<Status> = { ...outcome, ended_at: new Date().toISOString(), round: ctx.round, job: undefined }
  const retry = records.findLast((r) => r.retry)?.retry
  const resume = records.findLast((r) => r.resume)?.resume
  if (retry) patch.retry = retry
  if (resume) patch.resume = resume
  return setStatus(dir, patch)
}

/**
 * Lanza al worker de una corrida preparada, aplica el tope y escribe el estado final. En una revisión,
 * cada lanzamiento de una ronda lee su propio argv (`argv<tag>-l<k>.json`) y recorre sus trabajos.
 */
export async function supervise(dir: string, argvName = 'argv.json'): Promise<Status> {
  const argv = readJson<ArgvFile>(join(dir, argvName))
  const cancelFile = join(dir, 'cancel.request')
  const ctx: RunContext = {
    dir, family: argv.family, grace: argv.grace_ms ?? 10_000, cancelFile, tag: argv.tag ?? '', round: argv.round ?? 1,
    prefix: '', argv, once: { started: false }, threadUsage: new Map(),
  }
  const resumeSec = argv.resume_sec ?? DEFAULT_RESUME_SEC
  if (argv.kind === 'review') return superviseReview(ctx, resumeSec)
  if (argv.kind === 'writer') return superviseWriter(ctx, resumeSec)
  if (argv.kind === 'phase') return supervisePhase(ctx, resumeSec)
  // Un cancel que llegó antes de que hubiera worker: no se lanza nada.
  if (existsSync(cancelFile)) return setStatus(dir, { state: 'cancelled', ended_at: new Date().toISOString() })
  if (!argv.launch) throw new Error('la corrida no trae su lanzamiento')
  const r = await runAttempts(ctx, argv.launch, Date.now() + argv.deadline_sec * 1000, resumeSec, 'run')
  const patch: Partial<Status> = { ...r.outcome, ended_at: new Date().toISOString() }
  // Cada intento conserva su propia respuesta; `wait` lee la del último.
  if (r.last.resultFile !== join(dir, 'result.md')) patch.result_file = basename(r.last.resultFile)
  if (r.facts.sessionId) patch.session_id = r.facts.sessionId
  if (r.retry) patch.retry = r.retry
  if (r.resume) patch.resume = r.resume
  return setStatus(dir, patch)
}

/** Lo que una corrida de fase deja en `phase.json`: la salida, el artefacto y lo que el gate necesita. */
export interface PhaseResult {
  outcome: 'published' | 'awaiting_context' | 'closed_inline' | 'not_published' | 'not_admitted'
  artifact?: string; assumptions: string[]; blocking_questions: string[]; missing_context: string[]; cause?: string
}

/**
 * Una corrida de fase: el hijo con sus recuperaciones, la admisión del contrato con una sola corrección
 * y la salida. Con preguntas o faltantes la fase espera ampliación, o se cierra inline si ya se amplió;
 * sin ellos, se publica el artefacto. La salida y el registro se escriben antes del estado terminal:
 * mientras no hay terminal, la corrida sigue activa y ninguna otra fase del flujo arranca.
 */
async function supervisePhase(ctx: RunContext, resumeSec: number): Promise<Status> {
  const { dir, argv, cancelFile } = ctx
  const phase = argv.phase
  if (!phase || !argv.launch) throw new Error('la corrida de fase no trae lo que congeló o su lanzamiento')
  const run = basename(dir)
  const finish = (patch: Partial<Status>, result?: PhaseResult) => {
    if (result) writeJsonAtomic(join(dir, 'phase.json'), result)
    return setStatus(dir, { ...patch, ended_at: new Date().toISOString() })
  }
  if (existsSync(cancelFile)) return finish({ state: 'cancelled' })
  const r = await runAttempts(ctx, argv.launch, Date.now() + argv.deadline_sec * 1000, resumeSec, 'run')
  const extras: Partial<Status> = {
    ...(r.facts.sessionId ? { session_id: r.facts.sessionId } : {}), ...(r.retry ? { retry: r.retry } : {}), ...(r.resume ? { resume: r.resume } : {}),
  }
  if (r.outcome.state !== 'done') return finish({ ...outcomeFields(r.outcome), ...extras })

  const admitFn = (text: string): Admission<DocumentContract> => {
    if (phase.step === 'specify') return admitSpecify(text)
    if (phase.step === 'plan') return admitPlan(text, phase.criteria ?? [])
    return admitTasks(text, phase.criteria ?? [])
  }
  const admitted = await admitPhase(ctx, r.current, r.last, resumeSec, admitFn, { name: '-fix', suffix: '-fix', kind: 'correction' })
  const empty = { assumptions: [], blocking_questions: [], missing_context: [] }
  if (!admitted.review) {
    const detail = admitted.outcome.detail ?? admitted.outcome.reason ?? admitted.outcome.state
    return finish({ ...outcomeFields(admitted.outcome), ...extras }, admitted.outcome.state === 'cancelled' ? undefined : { outcome: 'not_admitted', ...empty, cause: detail })
  }
  const c = admitted.review
  writeJsonAtomic(join(dir, 'contract.json'), c)
  // Un cancel que llegó mientras se admitía corta antes de escribir nada en el flujo.
  if (existsSync(cancelFile)) return finish({ state: 'cancelled', ...extras })
  const lists = { assumptions: c.assumptions, blocking_questions: c.blocking_questions, missing_context: c.missing_context }
  const step = phase.step

  if (c.blocking_questions.length > 0 || c.missing_context.length > 0) {
    const closed = withFlowLock(phase.root, phase.flow, () => {
      const rec = readPhaseRecord(phase.root, phase.flow)
      const entry = { ...rec.phases[step] }
      // Una fase que ya se amplió no se amplía otra vez: la sigue el conductor inline.
      const inline = phase.amended || entry.amended?.consumed === true
      if (inline) {
        delete entry.awaiting
        entry.amended = { run: entry.amended?.run ?? run, consumed: true }
        entry.inline = { run, at: new Date().toISOString() }
      } else {
        entry.awaiting = { run, blocking_questions: c.blocking_questions, missing_context: c.missing_context }
      }
      writePhaseRecord(phase.root, phase.flow, { ...rec, phases: { ...rec.phases, [step]: entry } })
      return inline
    })
    return finish({ state: 'done', ...extras }, { outcome: closed ? 'closed_inline' : 'awaiting_context', ...lists })
  }

  const out: PublishOutcome = publishPhase(phase.root, phase, c, new Date(), (o) => {
    if (o.kind !== 'published') return
    const rec = readPhaseRecord(phase.root, phase.flow)
    const entry = { ...rec.phases[step] }
    delete entry.awaiting
    if (entry.amended) entry.amended = { ...entry.amended, consumed: true }
    writePhaseRecord(phase.root, phase.flow, { ...rec, phases: { ...rec.phases, [step]: entry } })
  })
  if (out.kind === 'published') return finish({ state: 'done', ...extras }, { outcome: 'published', artifact: out.artifact, ...lists })
  return finish({ state: 'failed', reason: 'not_published', detail: `${out.cause}: ${out.detail}`, ...extras },
    { outcome: 'not_published', ...lists, cause: `${out.cause}: ${out.detail}` })
}

/**
 * Espera a que el grupo del writer quede vacío, con `SIGKILL` mientras exista, hasta `graceMs`.
 * Devuelve el último estado que vio: solo `gone` acredita el cese.
 */
export async function settleGroup(g: GroupIdentity, graceMs: number, state: (g: GroupIdentity) => 'gone' | 'alive' | 'unknown' = groupState):
  Promise<'gone' | 'alive' | 'unknown'> {
  const until = Date.now() + graceMs
  for (;;) {
    const s = state(g)
    if (s === 'gone') return s
    if (s === 'alive') killGroup(g.pgid, 'SIGKILL')
    if (Date.now() >= until) return s
    await sleep(100)
  }
}

/**
 * Con la cosecha de un writer de cadena congelada, el terminal que esa cosecha implica queda escrito bajo
 * el lock del flujo: un bloque sin progreso (`no_progress`) o una segunda corrección que no es candidato
 * (`fix_cap`). Un fallo acá no toca la cosecha: el próximo verbo que escriba lo vuelve a derivar.
 */
async function persistHarvestTerminal(root: string, flow: string): Promise<void> {
  try {
    const { chainView } = await import('./sdd/chain-facts.ts')
    const { closeChain, withFlowLock } = await import('./sdd/phase-state.ts')
    const { readFlow } = await import('./sdd/read.ts')
    withFlowLock(root, flow, () => {
      const view = chainView(root, flow, readFlow(root, flow))
      const derived = view.state.derived
      if (derived && (derived.code === 'no_progress' || derived.code === 'fix_cap') && view.state.chain && view.state.chain.terminal === null) {
        closeChain(root, flow, view.state.chain.id, { ...derived, at: new Date().toISOString() })
      }
    })
  } catch {
    // El terminal se deriva igual en cada consulta; escribirlo acá solo lo adelanta.
  }
}

/**
 * El writer de una corrida: corre en su almacén y no escribe nada en `.sdd-ai/runs/<id>/`. Antes de
 * lanzar comprueba que el árbol siga en la base; al terminar, confirma que el grupo cesó y recién
 * entonces congela la cosecha, que es el terminal y libera la reserva. Sin cese confirmado, deja
 * `cessation_uncertain` con la reserva tomada.
 */
async function superviseWriter(ctx: RunContext, resumeSec: number): Promise<Status> {
  const { dir, argv, cancelFile } = ctx
  if (!argv.root || !argv.id || !argv.launch) throw new Error('la corrida del writer no trae su checkout, su id o su lanzamiento')
  const { root, id } = argv
  const control = readControl(root, id)
  const done = async (outcome: Outcome, report?: string): Promise<Status> => {
    const record = await freezeHarvest(root, id, outcome, report)
    if (control.phase?.kind) await persistHarvestTerminal(root, control.phase.flow)
    return setStatus(dir, { state: record.state, ended_at: new Date().toISOString() })
  }
  if (existsSync(cancelFile)) return done({ state: 'cancelled' })
  // Un cambio en el árbol entre `run` y el arranque no es del writer: no se lanza. Una corrida con padre
  // parte del árbol del padre; las demás, del árbol limpio.
  const chained = control.phase?.launch_from !== undefined
  const dirty = chained ? (launchTreeDiff(root, control) ?? ['(el árbol del eslabón anterior no se puede leer)']) : dirtyPaths(root)
  if (dirty.length > 0 || headCommit(root) !== control.base) {
    const detail = dirty.length > 0 ? `cambió: ${dirty.join(', ')}` : 'HEAD ya no es la base'
    return done({ state: 'launch_failed', reason: 'tree_changed', detail })
  }
  writeControl(root, { ...control, spawning: new Date().toISOString() })
  const wctx: RunContext = {
    ...ctx, writer: { root, id },
    // Un primer intento que ya cambió el árbol no se reintenta: se congela lo que dejó. Una corrida que
    // reanuda una sesión tampoco: hereda un perfil que el proveedor ya aceptó.
    canRetry: async () => !isResumeArgs(argv.family, argv.launch?.args ?? []) && (chained ? launchTreeHolds(root, control) : captureTreeAtBase(root, id)),
  }
  const r = await runAttempts(wctx, argv.launch, Date.now() + argv.deadline_sec * 1000, resumeSec, 'write')
  const patch: Partial<Status> = {}
  if (r.facts.sessionId) patch.session_id = r.facts.sessionId
  if (r.retry) patch.retry = r.retry
  if (r.resume) patch.resume = r.resume
  setStatus(dir, patch)
  const g = readControl(root, id).group
  const settled = g ? await settleGroup(g, ctx.grace) : 'gone'
  if (settled !== 'gone') {
    return setStatus(dir, {
      state: 'cessation_uncertain', reason: settled === 'alive' ? 'group_alive' : 'group_unknown',
      detail: `el grupo ${g?.pgid} del writer sigue ${settled === 'alive' ? 'vivo' : 'sin poder consultarse'} después de SIGKILL`,
    })
  }
  const report = existsSync(r.last.resultFile) ? readFileSync(r.last.resultFile, 'utf8') : undefined
  return done(r.outcome, report)
}
