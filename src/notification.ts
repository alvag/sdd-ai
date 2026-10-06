import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { detectRunner } from './approval/session.ts'
import { readBinding } from './backstop.ts'
import { associationFor, collectRunAssociations, ownerAssociationSource } from './run-association.ts'
import type { OwnerAssociationSource } from './run-association.ts'
import { ownerSession, isRunId } from './runs.ts'
import { isWriterRun, readControl } from './writer-store.ts'
import { evaluateSignal, sameRecipient, selectRecipient, SIGNAL_TTL_MS } from '../mods/sdd-ai/hooks/notification.ts'
import type { NotificationCheckout, RecipientIdentity, RoutingCandidate, SignalObservation } from '../mods/sdd-ai/hooks/notification.ts'

export type ReceiptOwner = RecipientIdentity
export interface SignalInventory { items: { recipient: RecipientIdentity; signal: SignalObservation }[]; complete: boolean }
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'
const unknown = (reason: string): SignalObservation => ({ kind: 'unknown', reason })
/** La identidad del checkout que publica la proyección: el sha256 de su ruta real. */
export const checkoutIdentity = (root: string): NotificationCheckout => ({ id: createHash('sha256').update(root).digest('hex'), root })
const NOTIFICATIONS = ['.sdd-ai', 'hooks', 'notifications']
const ROUTE = ['.sdd-ai', 'hooks', 'route']
const SIGNAL_NAME = /^(claude|codex)-(.+)\.json$/
const MAX_SIGNAL_BYTES = 64 * 1024
/** El request de una corrida puede traer su encargo: el límite es el de un archivo de dominio, no el de una señal. */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024

/** Comprueba cada tramo y su ruta física, antes y después de leer el archivo. */
function safeDirectory(root: string, segments: string[]): 'safe' | 'absent' {
  let path = root
  for (const segment of segments) {
    path = join(path, segment)
    let st
    try { st = lstatSync(path) } catch (e) { if (missing(e)) return 'absent'; throw e }
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Ruta de señal insegura.')
  }
  return 'safe'
}

class SourceChanged extends Error {}

/**
 * Lee un archivo regular sin seguir enlaces y comprueba que no cambió durante la lectura. `content` es `undefined`
 * si el texto no es JSON: el llamador decide si un archivo ilegible pesa (una señal vencida por su fecha no pesa).
 */
function regularSource(path: string, maxBytes: number): { content: unknown; mtimeMs: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes || realpathSync(path) !== path) throw new Error('Fuente insegura.')
    let content: unknown
    try { content = JSON.parse(readFileSync(fd, 'utf8')) } catch { content = undefined }
    const after = lstatSync(path)
    if (after.isSymbolicLink() || after.dev !== st.dev || after.ino !== st.ino || after.mtimeMs !== st.mtimeMs) throw new SourceChanged('La fuente cambió durante su lectura.')
    return { content, mtimeMs: st.mtimeMs }
  } finally { closeSync(fd) }
}

/** Solo comprueba que la ruta es un archivo regular propio, sin leerlo como fuente. */
function assertRegularFile(path: string): void {
  regularSource(path, MAX_SIGNAL_BYTES)
}

export function readNotificationSignal(root: string, recipient: RecipientIdentity, now: number): SignalObservation {
  try {
    if (!isRunId(recipient.session) || !['claude', 'codex'].includes(recipient.family)) return unknown('invalid_identity')
    root = realpathSync(root)
    if (safeDirectory(root, NOTIFICATIONS) === 'absent') return { kind: 'inactive', reason: 'missing' }
    const path = join(root, ...NOTIFICATIONS, `${recipient.family}-${recipient.session}.json`)
    let read
    // El mod renueva la señal cada segundo: si la reemplaza justo mientras se lee, se vuelve a leer una vez.
    for (let attempt = 0; ; attempt++) {
      try { read = regularSource(path, MAX_SIGNAL_BYTES); break } catch (e) {
        if (missing(e)) return { kind: 'inactive', reason: 'missing' }
        if (!(e instanceof SourceChanged) || attempt > 0) throw e
      }
    }
    if (safeDirectory(root, NOTIFICATIONS) !== 'safe') return unknown('path_changed')
    // Un archivo ilegible (una escritura cortada de una sesión que terminó) deja de pesar cuando su fecha vence.
    if (read.content === undefined) return now - read.mtimeMs >= SIGNAL_TTL_MS ? { kind: 'inactive', reason: 'expired' } : unknown('signal_unreadable')
    return evaluateSignal({ checkout: checkoutIdentity(root), recipient, content: read.content, mtimeMs: read.mtimeMs, now, path: 'safe' })
  } catch { return unknown('signal_unreadable') }
}

export function readNotificationSignals(root: string, now: number): SignalInventory {
  const result: SignalInventory = { items: [], complete: true }
  try {
    root = realpathSync(root)
    if (safeDirectory(root, NOTIFICATIONS) === 'absent') return result
    for (const name of readdirSync(join(root, ...NOTIFICATIONS)).sort()) {
      // Solo cuentan los nombres de señal: un archivo ajeno (un `.DS_Store`, un temporal) no deja el inventario incompleto.
      const [, family, session] = SIGNAL_NAME.exec(name) ?? []
      if (session === undefined) continue
      if (!isRunId(session)) { result.complete = false; continue }
      const recipient: RecipientIdentity = { family: family as RecipientIdentity['family'], session }
      const signal = readNotificationSignal(root, recipient, now)
      if (signal.kind === 'unknown') result.complete = false
      result.items.push({ recipient, signal })
    }
    if (safeDirectory(root, NOTIFICATIONS) !== 'safe') result.complete = false
  } catch { result.complete = false }
  return result
}

export function isNotifierOperational(root: string, family: RecipientIdentity['family'], session: string, now: number): boolean {
  return family === 'claude' && readNotificationSignal(root, { family, session }, now).kind === 'live'
}

/** No usa la proyección: las referencias, las ligas y el control protegido conservan la autoridad. */
export function authorizeTerminalReceipt(root: string, runId: string, owner: ReceiptOwner, env: Record<string, string | undefined>): boolean {
  if (ownerSession(env, owner.family) === owner.session) return true
  try {
    if (!isRunId(runId) || !isRunId(owner.session)) return false
    const runner = detectRunner(env)
    if (runner.runner !== 'claude' || !isRunId(runner.session)) return false
    root = realpathSync(root)
    const now = Date.now()
    const recipient: RecipientIdentity = { family: 'claude', session: runner.session }
    const ownerSignal = readNotificationSignal(root, owner, now)
    if (ownerSignal.kind === 'live' || ownerSignal.kind === 'unknown') return false
    let source: OwnerAssociationSource
    if (isWriterRun(root, runId)) {
      const control = readControl(root, runId)
      if (control.id !== runId || control.checkout.root !== root || control.session !== owner.session
        || control.request.conductor.family !== owner.family) return false
      source = ownerAssociationSource(control.phase?.flow)
    } else {
      if (safeDirectory(root, ['.sdd-ai', 'runs', runId]) !== 'safe') return false
      const request = regularSource(join(root, '.sdd-ai', 'runs', runId, 'request.json'), MAX_REQUEST_BYTES).content
      if (typeof request !== 'object' || request === null) return false
      source = ownerAssociationSource((request as { flow?: unknown }).flow)
    }
    const association = associationFor(collectRunAssociations(root), runId, source)
    if (association.kind !== 'known') return false
    const inventory = readNotificationSignals(root, now)
    if (!inventory.complete || safeDirectory(root, ROUTE) !== 'safe') return false
    const sessions = new Set<string>()
    for (const name of readdirSync(join(root, ...ROUTE))) {
      if (!name.endsWith('.json')) continue
      const session = name.slice(0, -'.json'.length)
      if (!isRunId(session)) return false
      // El estado de ruta de cada sesión tiene que ser un archivo regular propio, aunque aquí no se lea.
      assertRegularFile(join(root, ...ROUTE, name))
      sessions.add(session)
    }
    for (const item of inventory.items) if (item.recipient.family === 'claude') sessions.add(item.recipient.session)
    const candidates: RoutingCandidate[] = []
    for (const session of sessions) {
      const binding = readBinding(root, session)
      if (binding === 'unreadable') return false
      candidates.push({ recipient: { family: 'claude', session }, signal: readNotificationSignal(root, { family: 'claude', session }, now),
        flow: binding?.id ?? null, known: true })
    }
    const selected = selectRecipient({ owner, ownerSignal, association, candidates, complete: true })
    if (selected.kind === 'selected') return sameRecipient(selected.recipient, recipient)
    // Recuperación manual: ninguna operativa y exactamente una ligada con señal vigente.
    const bound = candidates.filter(c => c.flow === association.flow)
    if (bound.some(c => c.signal.kind === 'unknown' || c.signal.kind === 'live')) return false
    const current = bound.filter(c => c.signal.kind === 'degraded')
    return current.length === 1 && sameRecipient(current[0].recipient, recipient)
  } catch { return false }
}
