export type Family = 'claude' | 'codex'
export type Via = 'native' | 'process'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Origin = 'flag' | 'workers' | 'heredado'

export const ROLES = ['explore', 'counter-plan', 'investigate', 'debate',
  'design-review', 'implement', 'refute', 'code-review'] as const
export type Role = typeof ROLES[number]
/** Hasta que exista un worker que escriba, `implement` no se despacha. */
export type ReadOnlyRole = Exclude<Role, 'implement'>
export const READ_ONLY_ROLES: readonly ReadOnlyRole[] = ROLES.filter((r): r is ReadOnlyRole => r !== 'implement')
/** Roles que cambiaron de nombre: el viejo da un error de migración, nunca funciona como alias. */
export const RETIRED_ROLES: Readonly<Record<string, Role>> = { pr: 'code-review' }

export type RejectedField = 'model' | 'effort'
export interface RetryInfo { field: RejectedField; requested: string; effective: string; diagnostic: string }

export interface Conductor { family: Family; model?: string; effort?: Effort }
export interface Profile { model?: string; effort?: Effort }
export interface Resolution {
  family: Family; via: Via; model?: string; effort?: Effort
  origin: { model: Origin; effort: Origin }
}

export interface WorkerTask {
  cwd: string; promptFile: string; resultFile: string; sessionId: string
  model?: string; effort?: Effort
}
export interface LaunchSpec { cmd: string; args: string[]; cwd: string; stdinFile: string }

export type RunState = 'launching' | 'running' | 'done' | 'failed' | 'launch_failed'
  | 'timeout' | 'cancelled' | 'delegated'
export const TERMINAL: ReadonlySet<RunState> = new Set<RunState>(
  ['done', 'failed', 'launch_failed', 'timeout', 'cancelled', 'delegated'])
export interface Status {
  state: RunState; reason?: string; detail?: string
  supervisor_pid?: number; worker_pid?: number; session_id?: string
  started_at?: string; ended_at?: string; fallback?: Conductor; retry?: RetryInfo
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
