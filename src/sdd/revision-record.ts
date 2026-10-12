import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type RevisionArtifact = 'spec' | 'plan' | 'tasks'
export type RevisionPhase = 'specify' | 'plan' | 'tasks'
export type RevisionFamily = 'claude' | 'codex'
export const REVISION_STATES = ['active', 'published', 'no_changes', 'awaiting_context', 'conflict',
  'not_admitted', 'not_published', 'resume_rejected', 'launch_failed', 'failed', 'timeout', 'cancelled', 'superseded'] as const
export type RevisionState = typeof REVISION_STATES[number]
export type MaterialKind = 'document' | 'source' | 'historical' | 'conductor' | 'continuation' | 'historical_context'
export interface MaterialReference { path: string; digest: string; copy?: string; role?: string; kind?: MaterialKind }
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
const STATES: readonly string[] = REVISION_STATES
// No se importa status: el lector de registros no debe depender del resolver que lo consume.
const GATES = ['spec', 'plan', 'tasks', 'plan-tasks', 'single']
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)
const isDigest = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
const isDate = (v: unknown) => isText(v) && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))
const isFamily = (v: unknown) => v === 'claude' || v === 'codex'
const isRunId = (v: unknown) => isText(v) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v)
const isInternalPath = (v: unknown) => isText(v) && !isAbsolute(v) && !v.includes('\\') && !v.split('/').some((p) => p === '..' || p === '.' || p === '')
const isArtifactPath = (v: unknown) => typeof v === 'string' && isInternalPath(v) && /^\.plans\/[^/]+\/(spec|plan|tasks)\.md$/.test(v)
const isGateList = (v: unknown) => isTextList(v) && v.length > 0 && new Set(v).size === v.length && v.every((g) => GATES.includes(g))
const isObjectList = (v: unknown) => Array.isArray(v) && v.every(isPlainObject)
const invalid = (where: string, why: string): never => { throw new Error(`${where}: ${why}`) }

export function launchValid(v: unknown): v is EffectiveLaunch {
  return isPlainObject(v) && isFamily(v.cmd) && Array.isArray(v.args) && v.args.every((a) => typeof a === 'string')
    && isText(v.cwd) && isText(v.stdinFile)
}
/** El registro viaja con el flujo; las rutas del lanzamiento se ligan a su raíz original. */
export function portableLaunch(launch: EffectiveLaunch): EffectiveLaunch {
  const stdin = isAbsolute(launch.stdinFile) ? relative(launch.cwd, launch.stdinFile) : launch.stdinFile
  if ((!isAbsolute(launch.cwd) && launch.cwd !== '.') || !isInternalPath(stdin) || !stdin.startsWith('.sdd-ai/runs/')) {
    return invalid('launch', 'lanzamiento fuera del repositorio o de las corridas')
  }
  return { ...launch, cwd: '.', stdinFile: stdin }
}

export function repositoryLaunch(root: string, launch: EffectiveLaunch): EffectiveLaunch {
  const stored = portableLaunch(launch)
  return { ...stored, cwd: root, stdinFile: resolve(root, stored.stdinFile) }
}

function referenceValid(v: unknown): v is MaterialReference {
  return isPlainObject(v) && isInternalPath(v.path) && isDigest(v.digest) && (v.copy === undefined || isInternalPath(v.copy))
    && (v.role === undefined || isText(v.role))
    && (v.kind === undefined || ['document', 'source', 'historical', 'conductor', 'continuation', 'historical_context'].includes(String(v.kind)))
}
const references = (v: unknown) => Array.isArray(v) && v.every(referenceValid)
function proofValid(v: unknown): v is RevisionProof {
  return isPlainObject(v) && isFamily(v.runner) && v.source === (v.runner === 'claude' ? 'ask_user_question' : 'rollout_message')
    && isText(v.ref) && isText(v.session) && isDate(v.answered_at)
}
function resultValid(v: unknown): v is RevisionResult {
  return isPlainObject(v) && STATES.includes(String(v.state)) && (v.cause === undefined || isText(v.cause))
    && (v.detail === undefined || typeof v.detail === 'string') && (v.digest === undefined || isDigest(v.digest))
    && (v.registry_pending === undefined || v.registry_pending === true)
    && ['assumptions', 'blocking_questions', 'missing_context'].every((k) => v[k] === undefined || isTextList(v[k]))
    && (v.blocked_reasons === undefined || Array.isArray(v.blocked_reasons)
      && v.blocked_reasons.every((r) => isPlainObject(r) && isText(r.code) && typeof r.detail === 'string'))
}
function phaseMatches(phase: unknown, file: unknown): boolean {
  return PHASES.includes(String(phase)) && isArtifactPath(file)
    && (file as string).endsWith(`/${phase === 'specify' ? 'spec' : phase}.md`)
}

export function readDocumentOrigins(value: unknown): Partial<Record<RevisionPhase, DocumentOrigin>> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return invalid('documents', 'no es un mapa')
  for (const [key, v] of Object.entries(value)) {
    if (!isPlainObject(v) || key !== v.phase || !phaseMatches(v.phase, v.artifact) || !isRunId(v.run) || !isFamily(v.family)
      || !launchValid(v.launch) || v.launch.cmd !== v.family || !references(v.sources) || !references(v.amendments)
      || (v.session_id !== undefined && (!isText(v.session_id) || /[/\\]/.test(v.session_id)))
      || (v.task_actors !== undefined && v.task_actors !== true)) invalid(`documents.${key}`, 'productor inválido')
  }
  return value as unknown as Partial<Record<RevisionPhase, DocumentOrigin>>
}

/** Valida campos presentes; ausencia no equivale a un registro ilegible o inválido. */
export function readRevisions(value: unknown): RevisionRecord | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value) || !Array.isArray(value.entries) || !Array.isArray(value.barriers)) return invalid('revisions', 'faltan entries o barriers')
  const ids = new Set<string>()
  for (const [i, e] of value.entries.entries()) {
    if (!isPlainObject(e) || !isRunId(e.run) || !isRunId(e.origin_run) || !(e.parent_run === null || isRunId(e.parent_run))
      || !phaseMatches(e.phase, e.artifact) || !isFamily(e.family) || !['same', 'new'].includes(String(e.session_mode))
      || !launchValid(e.launch) || e.launch.cmd !== e.family || !isRunId(e.review) || !Number.isSafeInteger(e.round) || Number(e.round) < 1
      || !isDigest(e.candidate) || !isDigest(e.ledger_digest) || !isTextList(e.accepted) || e.accepted.length === 0
      || new Set(e.accepted).size !== e.accepted.length || !e.accepted.every((id) => /^F-\d+$/.test(id))
      || !isObjectList(e.decisions) || !isObjectList(e.history) || !references(e.materials) || !isDate(e.at) || !STATES.includes(String(e.state))
      || (e.session_id !== undefined && (!isText(e.session_id) || /[/\\]/.test(e.session_id)))
      || (e.session_mode === 'same' && !isText(e.session_id))
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
    if (!isPlainObject(a) || !isRunId(a.run) || !isArtifactPath(a.artifact)
      || !value.entries.some((e) => isPlainObject(e) && e.run === a.run && e.artifact === a.artifact && (e.state === 'active' || isPlainObject(e.result)))) invalid('revisions.active', 'reserva sin entrada')
  }
  if (value.intent !== undefined) {
    const i = value.intent
    if (!isPlainObject(i) || !isRunId(i.run) || !ids.has(i.run as string) || !isArtifactPath(i.artifact) || !isDigest(i.previous_digest)
      || !isDigest(i.result_digest) || !value.entries.some((e) => e.run === i.run && e.artifact === i.artifact) || !isGateList(i.gates) || (i.resolved !== undefined && i.resolved !== true)) invalid('revisions.intent', 'intención inválida')
  }
  for (const [i, b] of value.barriers.entries()) {
    if (!isPlainObject(b) || !isRunId(b.run) || !ids.has(b.run as string) || !isArtifactPath(b.artifact) || !isGateList(b.gates) || !isDigest(b.digest) || !value.entries.some((e) => e.run === b.run && e.artifact === b.artifact)) invalid(`revisions.barriers[${i}]`, 'barrera inválida')
  }
  return value as unknown as RevisionRecord
}

export function pendingIntent(record: { revisions?: RevisionRecord }): RevisionIntent | undefined {
  const intent = record.revisions?.intent
  return intent?.resolved === true ? undefined : intent
}

/** Contrato aditivo: una corrida anterior no trae ni documents ni revisions. */
export interface RevisionFileRead {
  documents?: Partial<Record<RevisionPhase, DocumentOrigin>>; revisions?: RevisionRecord; digest: string
}

/** Apertura segura compartida para registros y evidencia auxiliar. */
export function readRegularBytes(file: string): Buffer {
  if (!lstatSync(file).isFile()) return invalid(file, 'no es un archivo regular sin enlaces')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) return invalid(file, 'no es un archivo regular')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

/** La lectura del flujo y la de fases validan la misma evidencia ya abierta. */
export function readRevisionData(file: string, value: unknown): Pick<RevisionFileRead, 'documents' | 'revisions'> {
  if (!isPlainObject(value) || value.schema_version !== 1) return invalid(file, 'schema_version no es 1')
  const documents = readDocumentOrigins(value.documents)
  const revisions = readRevisions(value.revisions)
  const root = dirname(dirname(dirname(file)))
  const flow = dirname(file).split(/[\\/]/).at(-1)
  for (const entry of [...Object.values(documents ?? {}).filter((e): e is DocumentOrigin => e !== undefined), ...(revisions?.entries ?? [])]) {
    if (entry.artifact !== `.plans/${flow}/${entry.phase === 'specify' ? 'spec' : entry.phase}.md`) invalid(file, 'artefacto de otro flujo')
    entry.launch = repositoryLaunch(root, entry.launch)
  }
  return { documents, revisions }
}

/** Solo ENOENT acredita ausencia. */
export function readRevisionFile(file: string): RevisionFileRead {
  try {
    const bytes = readRegularBytes(file)
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    const { documents, revisions } = readRevisionData(file, value)
    return { documents, revisions, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { digest: 'absent' }
    throw new Error(`no se pudo leer el registro de correcciones ${file}: ${(e as Error).message}`, { cause: e })
  }
}

/** La lectura informativa y la recuperación comparten la misma regla, sin efectos. */
export function revisionPublicationFacts(root: string, intent: RevisionIntent, current?: string): {
  published: boolean; barrier: boolean; digest: string; terminal?: Record<string, unknown>; detail?: string
} {
  const file = join(root, '.sdd-ai', 'runs', intent.run, 'phase.json')
  let terminal: Record<string, unknown> | undefined
  let digest = 'absent'; let detail: string | undefined
  try {
    const data = readRegularBytes(file)
    digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    const value: unknown = JSON.parse(data.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('el terminal no es un objeto')
    terminal = value as Record<string, unknown>
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      detail = `${file}: ${(e as Error).message}`
      digest = `unreadable:${createHash('sha256').update(detail).digest('hex')}`
    }
  }
  const renamed = terminal?.outcome === 'published'
  return { published: renamed || current === intent.result_digest,
    barrier: renamed || current !== intent.previous_digest || detail !== undefined, digest, terminal, ...(detail ? { detail } : {}) }
}


/** El PID separado cubre el tramo de launching anterior al primer status del supervisor. */
export function revisionSupervisorPid(root: string, run: string, pid?: number): number | undefined {
  if (pid === undefined) {
    try { pid = Number(readRegularBytes(join(root, '.sdd-ai', 'runs', run, 'supervisor.pid')).toString('utf8').trim()) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}
