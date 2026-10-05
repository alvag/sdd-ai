import type { Reviewer } from './review/ledger.ts'

export type Family = 'claude' | 'codex'
export type Via = 'native' | 'process'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Origin = 'flag' | 'workers' | 'heredado'

/** Los roles de las fases SDD: tienen perfil en `workers.yml`, pero solo los despacha `sdd phase`. */
export const PHASE_ROLES = ['specify', 'plan', 'tasks'] as const
export type PhaseRole = typeof PHASE_ROLES[number]
export const ROLES = ['explore', 'counter-plan', 'investigate', 'debate',
  'design-review', 'implement', 'refute', 'code-review', ...PHASE_ROLES] as const
export type Role = typeof ROLES[number]
/**
 * Los roles que solo leen: tienen agente nativo y perfil propio. `implement` escribe y no tiene agente;
 * los de fase van siempre por proceso y tampoco lo tienen.
 */
export type ReadOnlyRole = Exclude<Role, 'implement' | PhaseRole>
export const READ_ONLY_ROLES: readonly ReadOnlyRole[] = ROLES.filter((r): r is ReadOnlyRole => r !== 'implement' && !isPhaseRole(r))
/** Lo que `run` despacha: los roles de lectura y el writer, que sale siempre por proceso. */
export type DispatchableRole = ReadOnlyRole | 'implement'
export const DISPATCHABLE_ROLES: readonly DispatchableRole[] = [...READ_ONLY_ROLES, 'implement']
/**
 * Roles que pueden buscar en la web: explorar e investigar a veces necesitan documentación de afuera.
 * Los demás responden solo con el encargo y el repositorio, porque lo que traen de la web no se puede
 * reproducir y el conductor no sabe que vino de ahí.
 */
export const WEB_ROLES: ReadonlySet<ReadOnlyRole> = new Set<ReadOnlyRole>(['explore', 'investigate'])
/**
 * Roles que cambiaron de nombre: el viejo da un error de migración, nunca funciona como alias. Es un
 * `Map` porque la clave la escribe el usuario, y un objeto resolvería `constructor` o `toString`
 * desde su prototipo.
 */
export const RETIRED_ROLES: ReadonlyMap<string, Role> = new Map([['pr', 'code-review']])

export type RejectedField = 'model' | 'effort'
export interface RetryInfo { field: RejectedField; requested: string; effective: string; diagnostic: string }

export interface Conductor { family: Family; model?: string; effort?: Effort }
/** Lo que `run` le devolvió al conductor para lanzar una nativa: su hook lo vuelve a poner en el despacho. */
export interface NativeProfile { agent: string; family: Family; role: Role; model?: string; effort?: Effort }
export interface Profile { model?: string; effort?: Effort }
export interface Resolution {
  family: Family; via: Via; model?: string; effort?: Effort
  origin: { model: Origin; effort: Origin }
}

export interface WorkerTask {
  cwd: string; promptFile: string; resultFile: string; sessionId: string
  model?: string; effort?: Effort
  /** Puede buscar en la web; sin el campo, no. */
  web?: boolean
}
export interface LaunchSpec { cmd: string; args: string[]; cwd: string; stdinFile: string }

/** `cessation_uncertain` no es terminal: el writer puede seguir escribiendo y su reserva sigue tomada. */
export type RunState = 'launching' | 'running' | 'done' | 'failed' | 'launch_failed'
  | 'timeout' | 'cancelled' | 'delegated' | 'unavailable' | 'cessation_uncertain'
export const TERMINAL: ReadonlySet<RunState> = new Set<RunState>(
  ['done', 'failed', 'launch_failed', 'timeout', 'cancelled', 'delegated', 'unavailable'])
export interface ResumeInfo { session_id: string; started_at: string; outcome?: RunState }
export interface Usage {
  input_tokens?: number; output_tokens?: number
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number; reasoning_output_tokens?: number
}
export type AttemptKind = 'initial' | 'profile_retry' | 'resume' | 'correction' | 'refutation'
export interface AttemptMetrics {
  round: number
  /** En una revisión, de qué trabajo es el intento; en una sub-tanda de refutación, `batch` es su número. */
  reviewer?: Reviewer | 'refute'; batch?: number; launch?: number
  kind: AttemptKind; suffix: string; started_at: string; ended_at: string; duration_ms: number
  prompt_bytes: number; usage?: Usage; outcome: RunState; reason?: string; admission?: string
  /** `result` es null si el worker no escribió su respuesta. */
  raw: { stdout: string; stderr: string; result: string | null }
}
/** El trabajo en curso de una ronda: un revisor sobre un lote, o una sub-tanda de refutación. */
export type JobProgress =
  | { phase: 'review'; key: string; reviewer: Reviewer; batch: number; index: number; total: number }
  | { phase: 'refutation'; key: string; index: number; total: number }
/**
 * Un trabajo lógico `(round, key)` que terminó en un lanzamiento, sin respuestas ni archivos de salida.
 * `admission` es `null` cuando no se conoce: el trabajo terminó sin una respuesta que admitir o rechazar.
 */
export interface LaunchJob {
  round: number; key: string; launch: number; state: RunState; admission: 'admitted' | 'inadmissible' | null
}
/**
 * El avance del lanzamiento activo de una ronda: los trabajos previstos para este lanzamiento, los conservados
 * de uno anterior, los terminados en este y el que corre. La refutación es una fase aparte, con su propio plan.
 */
export interface LaunchProgress {
  phase: 'review' | 'refutation'; round: number; launch: number
  planned: string[]; retained: LaunchJob[]; completed: LaunchJob[]
  active: { key: string; reviewer: Reviewer | null; batch: number | null } | null
}
export interface Status {
  state: RunState; reason?: string; detail?: string
  supervisor_pid?: number; worker_pid?: number; session_id?: string
  started_at?: string; ended_at?: string; fallback?: Conductor; retry?: RetryInfo; resume?: ResumeInfo
  result_file?: string
  /** En una revisión, la ronda a la que corresponde este estado. */
  round?: number
  /** En una revisión, el lanzamiento activo de la ronda y el trabajo que corre. */
  launch?: number
  job?: JobProgress
  /** En una revisión en curso, el avance real del lanzamiento activo; no está en los formatos anteriores. */
  progress?: LaunchProgress
}

export class SddError extends Error {
  code: string
  detail?: string
  next?: string
  constructor(code: string, message: string, opts: { detail?: string; next?: string } = {}) {
    super(message)
    this.code = code
    this.detail = opts.detail
    this.next = opts.next
  }
}

const FAMILIES: readonly Family[] = ['claude', 'codex']
const NATIVE_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const PORTABLE_EFFORTS: Record<string, Effort> = {
  bajo: 'low', medio: 'medium', alto: 'high', muy_alto: 'xhigh', maximo: 'max',
}

export function isFamily(v: unknown): v is Family {
  return typeof v === 'string' && (FAMILIES as readonly string[]).includes(v)
}

export function isReadOnlyRole(v: unknown): v is ReadOnlyRole {
  return typeof v === 'string' && (READ_ONLY_ROLES as readonly string[]).includes(v)
}

export function isPhaseRole(v: unknown): v is PhaseRole {
  return typeof v === 'string' && (PHASE_ROLES as readonly string[]).includes(v)
}

export function isDispatchableRole(v: unknown): v is DispatchableRole {
  return typeof v === 'string' && (DISPATCHABLE_ROLES as readonly string[]).includes(v)
}

export function isNativeEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (NATIVE_EFFORTS as readonly string[]).includes(v)
}

export function opposite(f: Family): Family {
  return f === 'claude' ? 'codex' : 'claude'
}

/** Acepta el vocabulario portable (bajo…maximo) o el nativo (low…max). */
export function toNativeEffort(v: string): Effort {
  if (isNativeEffort(v)) return v
  const native = PORTABLE_EFFORTS[v]
  if (native) return native
  throw new SddError('usage', `esfuerzo desconocido: ${v}`, {
    next: 'usa bajo | medio | alto | muy_alto | maximo, o low | medium | high | xhigh | max',
  })
}
