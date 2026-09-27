import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, readStatus, setStatus, writeJsonAtomic } from './runs.ts'
import type { Status } from './types.ts'

/**
 * Dónde está el lanzamiento de una nativa. El conductor la lanza con su herramienta de agentes y el
 * hook lo registra: `launch.json` es la reserva de un despacho, `launched.json` su confirmación, y
 * cada `launch-failed-<n>.json` un despacho que falló y se liberó.
 */
export type LaunchState =
  | { kind: 'pending'; attempt: number }
  | { kind: 'reserved'; toolUseId: string | null; attempt: number }
  | { kind: 'launched' }
  | { kind: 'cancelled' }

const LAUNCH = 'launch.json'
const LAUNCHED = 'launched.json'
const FAILED = /^launch-failed-\d+\.json$/

function attempts(dir: string): number {
  return readdirSync(dir).filter((f) => FAILED.test(f)).length
}

/** El `tool_use_id` de la reserva: `undefined` si no hay, `null` si el archivo no se puede leer. */
function reservedBy(dir: string): string | null | undefined {
  const file = join(dir, LAUNCH)
  if (!existsSync(file)) return undefined
  try {
    const reservation = readJson<{ tool_use_id?: unknown }>(file)
    return typeof reservation.tool_use_id === 'string' ? reservation.tool_use_id : null
  } catch {
    return null
  }
}

export function launchState(dir: string, s: Status): LaunchState {
  if (s.state === 'cancelled') return { kind: 'cancelled' }
  if (existsSync(join(dir, LAUNCHED))) return { kind: 'launched' }
  const attempt = attempts(dir)
  const toolUseId = reservedBy(dir)
  if (toolUseId !== undefined) return { kind: 'reserved', toolUseId, attempt }
  return { kind: 'pending', attempt }
}

/**
 * Reserva el lanzamiento para un despacho. El archivo se escribe completo en un temporal y se enlaza:
 * `linkSync` falla si ya existe, así que de dos despachos simultáneos gana uno solo y nadie lee una
 * reserva a medio escribir.
 */
export function reserve(dir: string, toolUseId: string): boolean {
  const tmp = join(dir, `${LAUNCH}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    const reservation = { tool_use_id: toolUseId, attempt: attempts(dir), reserved_at: new Date().toISOString() }
    writeFileSync(tmp, `${JSON.stringify(reservation, null, 2)}\n`)
    linkSync(tmp, join(dir, LAUNCH))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  } finally {
    rmSync(tmp, { force: true })
  }
}

export function confirm(dir: string, toolUseId: string): boolean {
  if (reservedBy(dir) !== toolUseId) return false
  writeJsonAtomic(join(dir, LAUNCHED), { tool_use_id: toolUseId, launched_at: new Date().toISOString() })
  return true
}

/** Libera la reserva de un despacho que falló, dejando constancia del intento. */
export function release(dir: string, toolUseId: string): boolean {
  if (reservedBy(dir) !== toolUseId) return false
  renameSync(join(dir, LAUNCH), join(dir, `launch-failed-${attempts(dir) + 1}.json`))
  return true
}

/** Una nativa sin lanzar no tiene procesos propios: cancelarla solo cambia su registro. */
export function cancelNative(dir: string): boolean {
  const state = launchState(dir, readStatus(dir))
  if (state.kind !== 'pending' && state.kind !== 'reserved') return false
  setStatus(dir, { state: 'cancelled' })
  return true
}
