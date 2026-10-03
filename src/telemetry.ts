import { randomUUID } from 'node:crypto'
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from './git.ts'
import type { AttemptKind, Family, RunState, Usage } from './types.ts'
import { telemetryEnabled } from './user-config.ts'

export const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'reasoning_output_tokens'] as const satisfies readonly (keyof Usage)[]
export type TokenKey = typeof TOKEN_KEYS[number]

/** Un valor por contador de tokens, con las cinco claves exactas del contrato. */
export function perToken<T>(f: (key: TokenKey) => T): Record<TokenKey, T> {
  return {
    input_tokens: f('input_tokens'), output_tokens: f('output_tokens'), cache_read_input_tokens: f('cache_read_input_tokens'),
    cache_creation_input_tokens: f('cache_creation_input_tokens'), reasoning_output_tokens: f('reasoning_output_tokens'),
  }
}
export interface TelemetryRecord {
  schema_version: 1; repository: string; run: string; attempt: number; attempt_kind: AttemptKind
  flow: string | null; step: string | null; role: string | null; family: Family
  model_requested: string | null; effort_requested: string | null
  model_effective: string | null; effort_effective: string | null; via: 'process'
  closed_at: string; duration_ms: number; outcome: RunState; thread_id: string | null
  tokens: Record<TokenKey, number | null>
  token_scope: Record<TokenKey, 'attempt' | 'thread_cumulative' | null>
}

export function serializeTelemetry(r: TelemetryRecord): string {
  return JSON.stringify({
    schema_version: r.schema_version, repository: r.repository, run: r.run, attempt: r.attempt,
    attempt_kind: r.attempt_kind, flow: r.flow, step: r.step, role: r.role, family: r.family,
    model_requested: r.model_requested, effort_requested: r.effort_requested,
    model_effective: r.model_effective, effort_effective: r.effort_effective, via: r.via,
    closed_at: r.closed_at, duration_ms: r.duration_ms, outcome: r.outcome, thread_id: r.thread_id,
    tokens: perToken((k) => r.tokens[k]),
    token_scope: perToken((k) => r.token_scope[k]),
  }) + '\n'
}

const directory = (home: string) => join(home, '.sdd-ai', 'telemetry')
function allowedDirectory(path: string): boolean {
  const st = lstatSync(path)
  return st.isDirectory() && !st.isSymbolicLink()
}

export function publishTelemetry(home: string, record: TelemetryRecord): void {
  let temporary: string | undefined
  try {
    const dir = directory(home)
    mkdirSync(join(home, '.sdd-ai'), { recursive: true, mode: 0o700 })
    try { mkdirSync(dir, { mode: 0o700 }) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    if (!allowedDirectory(dir)) return
    const day = record.closed_at.slice(0, 10)
    const id = randomUUID()
    const path = join(dir, `.${day}.${id}.tmp`)
    const fd = openSync(path, 'wx', 0o600)
    temporary = path
    try { writeFileSync(fd, serializeTelemetry(record)) } finally { closeSync(fd) }
    if (!lstatSync(temporary).isFile()) return
    linkSync(temporary, join(dir, `${day}.${id}.jsonl`))
  } catch { /* La telemetría no altera ni anuncia el resultado funcional. */ }
  finally {
    if (temporary !== undefined) try { unlinkSync(temporary) } catch { /* Retirada silenciosa. */ }
  }
}

const FINAL_NAME = /^(\d{4}-\d{2}-\d{2})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const TEMP_NAME = /^\.(\d{4}-\d{2}-\d{2})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

export function cleanupTelemetry(home: string, now: Date): void {
  try {
    const dir = directory(home)
    if (!allowedDirectory(dir)) return
    const limit = new Date(now)
    limit.setUTCHours(0, 0, 0, 0)
    limit.setUTCDate(limit.getUTCDate() - 30)
    for (const name of readdirSync(dir)) {
      const day = (FINAL_NAME.exec(name) ?? TEMP_NAME.exec(name))?.[1]
      if (!day) continue
      const date = new Date(`${day}T00:00:00.000Z`)
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day || date >= limit) continue
      try {
        const path = join(dir, name)
        if (lstatSync(path).isFile()) unlinkSync(path)
      } catch { /* Otra limpieza puede haber retirado el archivo. */ }
    }
  } catch { /* No recorrer ni reparar un almacenamiento inaccesible. */ }
}

export function closeTelemetry(home: string, root: string, override: string | undefined, attempt: Omit<TelemetryRecord, 'repository'>): void {
  cleanupTelemetry(home, new Date())
  try {
    if (telemetryEnabled(home, override)) publishTelemetry(home, { ...attempt, repository: gitDirs(root).commonDir })
  } catch { /* Configuración e identidad también pertenecen a la frontera silenciosa. */ }
}
