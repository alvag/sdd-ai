import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Contrato aditivo: una corrida anterior no trae ni documents ni revisions. */
export type RevisionArtifact = 'spec' | 'plan' | 'tasks'
export type RevisionPhase = 'specify' | 'plan' | 'tasks'
export type RevisionFamily = 'claude' | 'codex'
export type RevisionState = 'active' | 'published' | 'no_changes' | 'awaiting_context' | 'conflict'
  | 'not_admitted' | 'not_published' | 'resume_rejected' | 'launch_failed' | 'failed'
  | 'timeout' | 'cancelled' | 'superseded'
export interface MaterialReference { path: string; digest: string; copy?: string; role?: string }
export interface EffectiveLaunch { cmd: string; args: string[]; cwd: string; stdinFile: string }
export interface RevisionProof {
  runner: RevisionFamily; source: 'ask_user_question' | 'rollout_message'
  ref: string; session: string; answered_at: string
}
export interface DocumentOrigin {
  phase: RevisionPhase; artifact: string; run: string; family: RevisionFamily
  session_id?: string; launch: EffectiveLaunch; sources: MaterialReference[]; amendments: MaterialReference[]
  task_actors?: true
}
export interface RevisionResult {
  state: RevisionState; cause?: string; detail?: string; digest?: string; registry_pending?: true
  assumptions?: string[]; blocking_questions?: string[]; missing_context?: string[]
  blocked_reasons?: { code: string; detail: string }[]
}
/** El ledger enviado es una copia JSON íntegra, no una selección que pierda decisiones anteriores. */
export interface RevisionEntry {
  run: string; origin_run: string; parent_run: string | null; phase: RevisionPhase; artifact: string
  family: RevisionFamily; session_mode: 'same' | 'new'; session_id?: string; session_recoverable?: boolean
  launch: EffectiveLaunch; review: string; round: number; candidate: string; ledger_digest: string
  accepted: string[]; decisions: Record<string, unknown>[]; history: Record<string, unknown>[]
  materials: MaterialReference[]; conductor?: MaterialReference; authorization?: RevisionProof
  at: string; state: RevisionState; result?: RevisionResult
  continuation?: true
}
export interface RevisionIntent {
  run: string; artifact: string; previous_digest: string; result_digest: string; gates: string[]
  resolved?: true
}
export interface RevisionBarrier { run: string; artifact: string; gates: string[]; digest: string }
export interface RevisionRecord {
  entries: RevisionEntry[]; active?: { run: string; artifact: string }
  intent?: RevisionIntent; barriers: RevisionBarrier[]
}

const PHASES = ['specify', 'plan', 'tasks']
const STATES: readonly string[] = ['active', 'published', 'no_changes', 'awaiting_context', 'conflict',
  'not_admitted', 'not_published', 'resume_rejected', 'launch_failed', 'failed', 'timeout', 'cancelled', 'superseded']
const GATES = ['spec', 'plan', 'tasks', 'plan-tasks', 'single']
const map = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text)
const digest = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
const date = (v: unknown) => text(v) && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))
const family = (v: unknown) => v === 'claude' || v === 'codex'
const run = (v: unknown) => text(v) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v)
const path = (v: unknown) => text(v) && !isAbsolute(v) && !v.includes('\\') && !v.split('/').some((p) => p === '..' || p === '.' || p === '')
const artifact = (v: unknown) => typeof v === 'string' && path(v) && /^\.plans\/[^/]+\/(spec|plan|tasks)\.md$/.test(v)
const gates = (v: unknown) => texts(v) && v.length > 0 && new Set(v).size === v.length && v.every((g) => GATES.includes(g))
const list = (v: unknown) => Array.isArray(v) && v.every(map)
const invalid = (where: string, why: string): never => { throw new Error(`${where}: ${why}`) }

function launchValid(v: unknown): v is EffectiveLaunch {
  return map(v) && family(v.cmd) && Array.isArray(v.args) && v.args.every((a) => typeof a === 'string')
    && text(v.cwd) && text(v.stdinFile)
}
function referenceValid(v: unknown): v is MaterialReference {
  return map(v) && path(v.path) && digest(v.digest) && (v.copy === undefined || path(v.copy))
    && (v.role === undefined || text(v.role))
}
const references = (v: unknown) => Array.isArray(v) && v.every(referenceValid)
function proofValid(v: unknown): v is RevisionProof {
  return map(v) && family(v.runner) && v.source === (v.runner === 'claude' ? 'ask_user_question' : 'rollout_message')
    && text(v.ref) && text(v.session) && date(v.answered_at)
}
function resultValid(v: unknown): v is RevisionResult {
  return map(v) && STATES.includes(String(v.state)) && (v.cause === undefined || text(v.cause))
    && (v.detail === undefined || typeof v.detail === 'string') && (v.digest === undefined || digest(v.digest))
    && (v.registry_pending === undefined || v.registry_pending === true)
    && ['assumptions', 'blocking_questions', 'missing_context'].every((k) => v[k] === undefined || texts(v[k]))
    && (v.blocked_reasons === undefined || Array.isArray(v.blocked_reasons)
      && v.blocked_reasons.every((r) => map(r) && text(r.code) && typeof r.detail === 'string'))
}
function phaseMatches(phase: unknown, file: unknown): boolean {
  return PHASES.includes(String(phase)) && artifact(file)
    && (file as string).endsWith(`/${phase === 'specify' ? 'spec' : phase}.md`)
}

export function readDocumentOrigins(value: unknown): Partial<Record<RevisionPhase, DocumentOrigin>> | undefined {
  if (value === undefined) return undefined
  if (!map(value)) return invalid('documents', 'no es un mapa')
  for (const [key, v] of Object.entries(value)) {
    if (!map(v) || key !== v.phase || !phaseMatches(v.phase, v.artifact) || !run(v.run) || !family(v.family)
      || !launchValid(v.launch) || v.launch.cmd !== v.family || !references(v.sources) || !references(v.amendments)
      || (v.session_id !== undefined && (!text(v.session_id) || /[/\\]/.test(v.session_id)))
      || (v.task_actors !== undefined && v.task_actors !== true)) invalid(`documents.${key}`, 'productor inválido')
  }
  return value as unknown as Partial<Record<RevisionPhase, DocumentOrigin>>
}

/** Valida campos presentes; ausencia no equivale a un registro ilegible o inválido. */
export function readRevisions(value: unknown): RevisionRecord | undefined {
  if (value === undefined) return undefined
  if (!map(value) || !Array.isArray(value.entries) || !Array.isArray(value.barriers)) return invalid('revisions', 'faltan entries o barriers')
  const ids = new Set<string>()
  for (const [i, e] of value.entries.entries()) {
    if (!map(e) || !run(e.run) || !run(e.origin_run) || !(e.parent_run === null || run(e.parent_run))
      || !phaseMatches(e.phase, e.artifact) || !family(e.family) || !['same', 'new'].includes(String(e.session_mode))
      || !launchValid(e.launch) || e.launch.cmd !== e.family || !run(e.review) || !Number.isSafeInteger(e.round) || Number(e.round) < 1
      || !digest(e.candidate) || !digest(e.ledger_digest) || !texts(e.accepted) || e.accepted.length === 0
      || new Set(e.accepted).size !== e.accepted.length || !e.accepted.every((id) => /^F-\d+$/.test(id))
      || !list(e.decisions) || !list(e.history) || !references(e.materials) || !date(e.at) || !STATES.includes(String(e.state))
      || (e.session_id !== undefined && (!text(e.session_id) || /[/\\]/.test(e.session_id)))
      || (e.session_mode === 'same' && !text(e.session_id))
      || (e.session_recoverable !== undefined && typeof e.session_recoverable !== 'boolean')
      || (e.conductor !== undefined && !referenceValid(e.conductor))
      || (e.authorization !== undefined && !proofValid(e.authorization))
      || (e.session_mode === 'new' && !proofValid(e.authorization))
      || (e.result !== undefined && !resultValid(e.result))) invalid(`revisions.entries[${i}]`, 'corrección inválida')
    if (e.continuation !== undefined && e.continuation !== true) invalid(`revisions.entries[${i}]`, 'continuación inválida')
    if (ids.has(e.run as string)) invalid(`revisions.entries[${i}]`, 'corrida repetida')
    ids.add(e.run as string)
  }
  if (value.active !== undefined) {
    const a = value.active
    if (!map(a) || !run(a.run) || !artifact(a.artifact)
      || !value.entries.some((e) => map(e) && e.run === a.run && e.artifact === a.artifact)) invalid('revisions.active', 'reserva sin entrada')
  }
  if (value.intent !== undefined) {
    const i = value.intent
    if (!map(i) || !run(i.run) || !ids.has(i.run as string) || !artifact(i.artifact) || !digest(i.previous_digest)
      || !digest(i.result_digest) || !gates(i.gates) || (i.resolved !== undefined && i.resolved !== true)) invalid('revisions.intent', 'intención inválida')
  }
  for (const [i, b] of value.barriers.entries()) {
    if (!map(b) || !run(b.run) || !ids.has(b.run as string) || !artifact(b.artifact) || !gates(b.gates) || !digest(b.digest)) invalid(`revisions.barriers[${i}]`, 'barrera inválida')
  }
  return value as unknown as RevisionRecord
}

export function pendingIntent(record: { revisions?: RevisionRecord }): RevisionIntent | undefined {
  const intent = record.revisions?.intent
  return intent?.resolved === true ? undefined : intent
}

export interface RevisionFileRead {
  documents?: Partial<Record<RevisionPhase, DocumentOrigin>>; revisions?: RevisionRecord; digest: string
}

/** Solo ENOENT acredita ausencia. Se abre sin enlaces y sin bloquear ante rutas especiales. */
export function readRevisionFile(file: string): RevisionFileRead {
  let fd: number | undefined
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink()) return invalid(file, 'no es un archivo regular sin enlaces')
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return invalid(file, 'no es un archivo regular')
    const bytes = readFileSync(fd)
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!map(value) || value.schema_version !== 1) return invalid(file, 'schema_version no es 1')
    return { documents: readDocumentOrigins(value.documents), revisions: readRevisions(value.revisions),
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && fd === undefined) return { digest: 'absent' }
    throw new Error(`no se pudo leer el registro de correcciones ${file}: ${(e as Error).message}`, { cause: e })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
