/** Política portable: no recibe el motor ni importa fuentes con efectos. */
export interface NotificationCheckout { id: string; root: string }
export interface RecipientIdentity { family: 'claude' | 'codex'; session: string }
export interface ResultIdentity { checkout: NotificationCheckout; id: string; round: number | null; launch: number | null }
export type NotificationFact<T> = { value: T; reason: null } | { value: null; reason: { code: string; detail: string } }
export interface NotificationRun {
  id: string; availability: 'available' | 'unavailable'
  // La proyección publica los writers terminales como `worker`: no hay una clase `writer` aparte.
  kind: NotificationFact<'worker' | 'review' | 'native'>
  state: NotificationFact<string>; open: NotificationFact<string>
  session: NotificationFact<string>; session_family?: NotificationFact<'claude' | 'codex'>
  delivery?: NotificationFact<{ round: number | null; launch: number | null }>
}
export interface NotificationObservation {
  checkout: NotificationCheckout; current: boolean; valid: boolean; compatible: boolean; complete: boolean
}
export const SIGNAL_TTL_MS = 5_000
export const SUBMIT_IDLE_TIMEOUT_MS = 10_000
export const OBSERVATION_INTERVAL_MS = 1_000
export const MAX_NOTIFICATION_ATTEMPTS = 3
/** Espera antes de la segunda y de la tercera solicitud tras un rechazo confirmado. */
export const RETRY_DELAYS_MS = [30_000, 60_000] as const
/** Un id que se puede citar en un comando sin comillas: un solo segmento de ruta, como valida el binario. */
export const safeSegment = (value: string): boolean => /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== '.' && value !== '..'
const terminal = new Set(['done', 'failed', 'launch_failed', 'timeout', 'cancelled'])
const component = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)

export function eligibleResult(observation: NotificationObservation, run: NotificationRun): ResultIdentity | null {
  const delivery = run.delivery?.value
  if (!observation.current || !observation.valid || !observation.compatible || run.availability !== 'available'
    || !safeSegment(run.id) || !['worker', 'review'].includes(run.kind.value ?? '') || !terminal.has(run.state.value ?? '')
    || run.open.value !== 'undelivered' || !delivery || !component(delivery.round) || !component(delivery.launch)) return null
  if (run.kind.value === 'review' && (delivery.round === null || delivery.launch === null)) return null
  return { checkout: observation.checkout, id: run.id, round: delivery.round, launch: delivery.launch }
}

export function resultKey(identity: ResultIdentity, recipient: RecipientIdentity): string {
  return 'sdd-ai.notification.v1:' + JSON.stringify([identity.checkout.id, identity.checkout.root, identity.id,
    identity.round, identity.launch, recipient.family, recipient.session])
}

export function validNotificationRecord(value: unknown, identity: ResultIdentity, recipient: RecipientIdentity): value is NotificationRecord {
  if (!object(value) || value.schema_version !== 1 || !object(value.identity) || !object(value.identity.checkout)
    || !object(value.recipient) || value.recipient.family !== recipient.family || value.recipient.session !== recipient.session
    || value.identity.id !== identity.id || value.identity.round !== identity.round || value.identity.launch !== identity.launch
    || value.identity.checkout.id !== identity.checkout.id || value.identity.checkout.root !== identity.checkout.root
    || typeof value.instance !== 'string' || !value.instance || typeof value.status !== 'string'
    || !['prepared', 'submitting', 'accepted', 'rejected', 'exhausted', 'indeterminate'].includes(value.status)
    || typeof value.updated_at !== 'number' || !Number.isFinite(value.updated_at)
    || typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > MAX_NOTIFICATION_ATTEMPTS
    || typeof value.idle_ms !== 'number' || !Number.isFinite(value.idle_ms) || value.idle_ms < 0
    || !(value.next_attempt_at === null || (typeof value.next_attempt_at === 'number' && Number.isFinite(value.next_attempt_at)))) return false
  // Un rechazo admite reintento (con fecha) o está cerrado por una respuesta tardía (sin fecha).
  return value.status !== 'rejected' || value.attempts > 0 && (value.next_attempt_at === null || value.attempts < MAX_NOTIFICATION_ATTEMPTS)
}

export interface NotificationSignal {
  schema_version: 1; checkout: NotificationCheckout; family: 'claude' | 'codex'; session: string
  instance: string; operational: boolean; updated_at: number
}
export type SignalObservation = { kind: 'live' | 'degraded'; signal: NotificationSignal }
  | { kind: 'inactive'; reason: string } | { kind: 'unknown'; reason: string }
export interface SignalEvaluationInput {
  checkout: NotificationCheckout; recipient: RecipientIdentity; content: unknown; now: number
  mtimeMs: number | null; path: 'safe' | 'absent' | 'unknown'
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export function evaluateSignal(input: SignalEvaluationInput): SignalObservation {
  if (input.path === 'absent') return { kind: 'inactive', reason: 'missing' }
  if (input.path !== 'safe') return { kind: 'unknown', reason: 'unsafe_path' }
  const s = input.content
  if (!object(s) || s.schema_version !== 1 || !object(s.checkout) || s.checkout.id !== input.checkout.id
    || s.checkout.root !== input.checkout.root || s.family !== input.recipient.family || s.session !== input.recipient.session
    || typeof s.instance !== 'string' || !s.instance || typeof s.operational !== 'boolean'
    || typeof s.updated_at !== 'number' || !Number.isFinite(s.updated_at) || s.updated_at < 0
    || input.mtimeMs === null || !Number.isFinite(input.mtimeMs) || !Number.isFinite(input.now)
    || s.updated_at > input.now || input.mtimeMs > input.now) return { kind: 'unknown', reason: 'invalid_signal' }
  if (input.now - s.updated_at >= SIGNAL_TTL_MS || input.now - input.mtimeMs >= SIGNAL_TTL_MS) return { kind: 'inactive', reason: 'expired' }
  return { kind: s.operational ? 'live' : 'degraded', signal: s as unknown as NotificationSignal }
}

export type NotificationAssociation = { kind: 'known'; flow: string } | { kind: 'absent' }
  | { kind: 'conflict'; flows: string[] } | { kind: 'unknown'; reason: string }
export interface RoutingCandidate { recipient: RecipientIdentity; signal: SignalObservation; flow: string | null; known: boolean }
export interface RoutingInput {
  owner: RecipientIdentity | null; ownerSignal: SignalObservation; association: NotificationAssociation
  candidates: RoutingCandidate[]; complete: boolean
  self?: { recipient: RecipientIdentity; instance: string; eligible: boolean }
}
export type RecipientSelection = { kind: 'selected'; recipient: RecipientIdentity; instance: string; source: 'owner' | 'flow' | 'self' }
  | { kind: 'pending'; reason: string }
export const sameRecipient = (a: RecipientIdentity, b: RecipientIdentity): boolean => a.family === b.family && a.session === b.session
export function selectRecipient(input: RoutingInput): RecipientSelection {
  const pending = (reason: string): RecipientSelection => ({ kind: 'pending', reason })
  if (input.owner === null) return pending('owner_unknown')
  if (input.owner.family === 'claude' && input.ownerSignal.kind === 'live') {
    return { kind: 'selected', recipient: input.owner, instance: input.ownerSignal.signal.instance, source: 'owner' }
  }
  if (input.self?.eligible && input.self.recipient.family === 'claude' && sameRecipient(input.owner, input.self.recipient)) {
    return { kind: 'selected', recipient: input.self.recipient, instance: input.self.instance, source: 'self' }
  }
  if (input.ownerSignal.kind === 'unknown') return pending('owner_operativity_unknown')
  if (input.association.kind !== 'known') return pending('association_unavailable')
  const flow = input.association.flow
  if (!input.complete || input.candidates.some(c => !c.known || (c.flow === flow && c.signal.kind === 'unknown'))) return pending('candidates_unknown')
  const live = input.candidates.flatMap(c => c.recipient.family === 'claude' && c.flow === flow && c.signal.kind === 'live'
    ? [{ recipient: c.recipient, instance: c.signal.signal.instance }] : [])
  if (live.length > 1) return pending('ambiguous_recipients')
  const [candidate] = live
  return candidate ? { kind: 'selected', recipient: candidate.recipient, instance: candidate.instance, source: 'flow' } : pending('no_recipient')
}

export interface NotificationRecord {
  schema_version: 1; identity: ResultIdentity; recipient: RecipientIdentity; instance: string
  status: 'prepared' | 'submitting' | 'accepted' | 'rejected' | 'exhausted' | 'indeterminate'
  updated_at: number; attempts: number; next_attempt_at: number | null; idle_ms: number
}
export type NotificationEvent = { kind: 'prepare'; identity: ResultIdentity; recipient: RecipientIdentity; instance: string }
  | { kind: 'submit' | 'reload' | 'failure' }
  | { kind: 'response'; response: unknown } | { kind: 'elapsed'; ms: number; working: boolean; question: boolean }
/**
 * Si el mod todavía puede llevar este aviso a buen término por su cuenta. No puede con un intento indeterminado, uno
 * agotado o un rechazo cerrado sin reintento (la respuesta tardía de uno indeterminado): esos quedan para la recepción
 * manual, y mientras sigan pendientes la señal no acredita operatividad.
 */
export function mayRecover(record: NotificationRecord): boolean {
  return !(record.status === 'indeterminate' || record.status === 'exhausted' || (record.status === 'rejected' && record.next_attempt_at === null))
}
export function mayAttempt(record: NotificationRecord | null, now: number): boolean {
  return record === null || record.status === 'prepared' || (record.status === 'rejected'
    && record.attempts < MAX_NOTIFICATION_ATTEMPTS && record.next_attempt_at !== null && now >= record.next_attempt_at)
}
export function transitionNotification(record: NotificationRecord | null, event: NotificationEvent, now: number): NotificationRecord {
  if (event.kind === 'prepare') {
    if (!mayAttempt(record, now)) throw new Error('El aviso no permite otro intento.')
    return { schema_version: 1, identity: event.identity, recipient: event.recipient, instance: event.instance,
      status: 'prepared', updated_at: now, attempts: record?.attempts ?? 0, next_attempt_at: null, idle_ms: 0 }
  }
  if (record === null) throw new Error('Falta el registro del aviso.')
  const next = { ...record, updated_at: now }
  if (event.kind === 'reload') {
    if (record.status === 'submitting') next.status = 'indeterminate'
  } else if (event.kind === 'submit') {
    if (record.status !== 'prepared') throw new Error('El aviso no está preparado.')
    next.status = 'submitting'; next.attempts++; next.idle_ms = 0
  } else if (event.kind === 'elapsed') {
    if (record.status === 'submitting' && !event.working && !event.question) {
      next.idle_ms += Math.max(0, event.ms)
      if (next.idle_ms >= SUBMIT_IDLE_TIMEOUT_MS) next.status = 'indeterminate'
    }
  } else if (event.kind === 'response' && ['submitting', 'indeterminate'].includes(record.status)) {
    // Una respuesta tardía (sobre indeterminate) cierra el intento pero nunca habilita otro envío: con text pasa a
    // accepted y con drop a rejected, como dice el plan, pero sin fecha de reintento (recuperación manual).
    const late = record.status === 'indeterminate'
    if (object(event.response) && typeof event.response.text === 'string') next.status = 'accepted'
    else if (object(event.response) && typeof event.response.drop === 'string') {
      if (late) { next.status = 'rejected'; next.next_attempt_at = null }
      else {
        next.status = record.attempts >= MAX_NOTIFICATION_ATTEMPTS ? 'exhausted' : 'rejected'
        next.next_attempt_at = next.status === 'rejected' ? now + (RETRY_DELAYS_MS[record.attempts - 1] ?? RETRY_DELAYS_MS[1]) : null
      }
    } else next.status = 'indeterminate'
  } else if (event.kind === 'failure' && record.status === 'submitting') next.status = 'indeterminate'
  return next
}
