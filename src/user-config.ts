import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type Document, isMap, parseDocument } from 'yaml'
import { SddError } from './types.ts'

export type TelemetryPreference = 'on' | 'off'
export interface UserConfigSnapshot {
  path: string; bytes: string | null; current: TelemetryPreference | null
  document: Document
}
export interface UserTelemetryPlan {
  path: string; current: TelemetryPreference | null; proposed: TelemetryPreference
  action: 'create' | 'update' | 'unchanged'; content?: string
}

export const userConfigPath = (home: string): string => resolve(home, '.sdd-ai/config.yml')

/** Lectura estricta para init; el supervisor convierte sus errores en apagado. */
export function readUserConfig(home: string): UserConfigSnapshot {
  const path = userConfigPath(home)
  let bytes: string | null
  try {
    bytes = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new SddError('user_config_invalid', `${path}: no se puede leer la configuración de usuario`)
    // Un enlace roto es una configuración ilegible, no un archivo ausente.
    try {
      lstatSync(path)
      throw new SddError('user_config_invalid', `${path}: el destino no existe`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    bytes = null
  }
  const document = parseDocument(bytes ?? '')
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) {
    throw new SddError('user_config_invalid', `${path}: se exige un mapa YAML válido sin claves duplicadas`)
  }
  const has = document.has('telemetry')
  const value = document.get('telemetry')
  if (has && value !== 'on' && value !== 'off') throw new SddError('user_config_invalid', `${path}: telemetry debe ser on u off`)
  return { path, bytes, current: has ? value as TelemetryPreference : null, document }
}

export function planUserTelemetry(snapshot: UserConfigSnapshot, requested?: TelemetryPreference): UserTelemetryPlan {
  const proposed = requested ?? snapshot.current ?? 'off'
  const action = snapshot.bytes === null ? 'create' : snapshot.current === proposed ? 'unchanged' : 'update'
  const plan: UserTelemetryPlan = { path: snapshot.path, current: snapshot.current, proposed, action }
  if (action !== 'unchanged') {
    const doc = snapshot.document.clone()
    if (doc.contents === null) doc.contents = doc.createNode({})
    doc.set('telemetry', proposed)
    plan.content = doc.toString()
  }
  return plan
}

export function telemetryEnabled(home: string, override: string | undefined): boolean {
  if (override === 'on' || override === 'off') return override === 'on'
  try { return readUserConfig(home).current === 'on' } catch { return false }
}

/** Escribe el destino de un enlace sin reemplazar el enlace ni perder los permisos anteriores. */
export function writeUserTelemetry(plan: UserTelemetryPlan): void {
  if (plan.action === 'unchanged') return
  if (plan.content === undefined) throw new Error('falta el contenido de la preferencia')
  mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 })
  let destination = plan.path
  let mode = 0o600
  try {
    const st = lstatSync(plan.path)
    if (st.isSymbolicLink()) destination = realpathSync(plan.path)
    const target = statSync(destination)
    if (!target.isFile()) throw new Error('la configuración no es un archivo regular')
    mode = target.mode & 0o777
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const temporary = join(dirname(destination), `.config.${randomUUID()}.tmp`)
  let owned = false
  try {
    const fd = openSync(temporary, 'wx', mode)
    owned = true
    try { writeFileSync(fd, plan.content) } finally { closeSync(fd) }
    chmodSync(temporary, mode)
    renameSync(temporary, destination)
  } finally {
    if (owned) try { unlinkSync(temporary) } catch { /* El temporal puede haberse publicado. */ }
  }
}
