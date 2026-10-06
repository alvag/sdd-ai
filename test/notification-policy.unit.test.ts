import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eligibleResult, evaluateSignal, MAX_NOTIFICATION_ATTEMPTS, mayAttempt, mayRecover, resultKey, RETRY_DELAYS_MS, selectRecipient, SIGNAL_TTL_MS, SUBMIT_IDLE_TIMEOUT_MS, transitionNotification, validNotificationRecord } from '../mods/sdd-ai/hooks/notification.ts'
import type { NotificationObservation, NotificationRecord, NotificationRun, NotificationSignal, RecipientIdentity, RoutingInput, SignalObservation } from '../mods/sdd-ai/hooks/notification.ts'

const checkout = { id: 'checkout', root: '/checkout' }
const owner: RecipientIdentity = { family: 'claude', session: 'owner' }
const fallback: RecipientIdentity = { family: 'claude', session: 'fallback' }
const known = <T>(value: T) => ({ value, reason: null })
const observation: NotificationObservation = { checkout, current: true, valid: true, compatible: true, complete: true }
const run: NotificationRun = { id: 'run', availability: 'available', kind: known('worker'), state: known('done'), open: known('undelivered'),
  session: known('owner'), session_family: known('claude'), delivery: known({ round: null, launch: null }) }
const signal = (recipient = owner, operational = true): NotificationSignal => ({ schema_version: 1, checkout,
  ...recipient, instance: recipient.session, operational, updated_at: 1000 })
const live = (recipient = owner): SignalObservation => ({ kind: 'live', signal: signal(recipient) })
const inactive: SignalObservation = { kind: 'inactive', reason: 'missing' }

test('notification eligibility requires terminal known delivery and keeps every result identity separate', () => {
  const identity = eligibleResult(observation, run)!
  assert.ok(identity)
  for (const state of ['failed', 'launch_failed', 'timeout', 'cancelled']) assert.ok(eligibleResult(observation, { ...run, state: known(state) }))
  for (const state of ['running', 'cessation_uncertain', 'delegated', 'unavailable']) assert.equal(eligibleResult(observation, { ...run, state: known(state) }), null)
  for (const open of ['running', 'review_pending', 'native_pending', 'native_unconfirmed']) assert.equal(eligibleResult(observation, { ...run, open: known(open) }), null)
  assert.equal(eligibleResult(observation, { ...run, kind: known('native') }), null)
  assert.equal(eligibleResult(observation, { ...run, delivery: undefined }), null)
  assert.equal(eligibleResult(observation, { ...run, kind: known('review') }), null)
  // El id termina en un comando que el conductor ejecuta: uno que no es un solo segmento seguro no se avisa.
  for (const id of ['run\n./bin/otra-cosa', 'run; rm -rf x', 'a b', '..', '']) assert.equal(eligibleResult(observation, { ...run, id }), null)
  assert.ok(eligibleResult({ ...observation, complete: false }, run))
  for (const key of ['current', 'valid', 'compatible'] as const) assert.equal(eligibleResult({ ...observation, [key]: false }, run), null)
  const keys = [resultKey(identity, owner), resultKey(identity, fallback), resultKey({ ...identity, round: 1, launch: 1 }, owner),
    resultKey({ ...identity, round: 1, launch: 2 }, owner), resultKey({ ...identity, checkout: { ...checkout, root: '/other' } }, owner),
    resultKey({ ...identity, checkout: { ...checkout, id: 'other' } }, owner)]
  assert.equal(new Set(keys).size, keys.length)
})

test('notification routing preserves owner priority and requires a unique known fallback', () => {
  const base: RoutingInput = { owner, ownerSignal: live(), association: { kind: 'known', flow: 'flow' }, complete: true,
    candidates: [{ recipient: fallback, signal: live(fallback), flow: 'flow', known: true }] }
  assert.deepEqual(selectRecipient(base), { kind: 'selected', recipient: owner, instance: 'owner', source: 'owner' })
  assert.equal(selectRecipient({ ...base, association: { kind: 'absent' } }).kind, 'selected')
  const routing = { ...base, ownerSignal: inactive }
  assert.deepEqual(selectRecipient(routing), { kind: 'selected', recipient: fallback, instance: 'fallback', source: 'flow' })
  // Una dueña degradada no conserva la prioridad: elige el relevo, no la dueña.
  assert.deepEqual(selectRecipient({ ...routing, ownerSignal: { kind: 'degraded', signal: signal(owner, false) } }),
    { kind: 'selected', recipient: fallback, instance: 'fallback', source: 'flow' })
  for (const input of [
    { ...routing, complete: false }, { ...routing, candidates: [] },
    { ...routing, ownerSignal: { kind: 'unknown' as const, reason: 'unreadable' } },
    { ...routing, association: { kind: 'absent' as const } },
    { ...routing, association: { kind: 'conflict' as const, flows: ['flow', 'other'] } },
    { ...routing, candidates: [...base.candidates, { ...base.candidates[0], recipient: { ...fallback, session: 'third' } }] },
    { ...routing, candidates: [{ ...base.candidates[0], known: false }] },
    { ...routing, candidates: [{ ...base.candidates[0], signal: { kind: 'unknown' as const, reason: 'unreadable' } }] },
  ]) assert.equal(selectRecipient(input).kind, 'pending')
  assert.deepEqual(selectRecipient({ ...routing, complete: false, association: { kind: 'absent' },
    self: { recipient: owner, instance: 'self', eligible: true } }), { kind: 'selected', recipient: owner, instance: 'self', source: 'self' })
  // Una dueña de Codex no tiene avisador: el aviso va al relevo de Claude ligado al flujo.
  assert.deepEqual(selectRecipient({ ...routing, owner: { family: 'codex', session: 'codex' } }),
    { kind: 'selected', recipient: fallback, instance: 'fallback', source: 'flow' })
})

test('notification signals require both clocks and matching physical identity', () => {
  const input = { checkout, recipient: owner, content: signal(), now: 1001, mtimeMs: 1000, path: 'safe' as const }
  assert.equal(evaluateSignal(input).kind, 'live')
  assert.equal(evaluateSignal({ ...input, content: signal(owner, false) }).kind, 'degraded')
  assert.equal(evaluateSignal({ ...input, path: 'absent' }).kind, 'inactive')
  assert.equal(evaluateSignal({ ...input, path: 'unknown' }).kind, 'unknown')
  // Justo vencida por cualquiera de los dos relojes: SIGNAL_TTL_MS después de la fecha de la señal o del archivo.
  for (const patch of [{ now: 1000 + SIGNAL_TTL_MS }, { content: { ...signal(), updated_at: 0 }, now: SIGNAL_TTL_MS }, { mtimeMs: 0, now: SIGNAL_TTL_MS }]) {
    assert.equal(evaluateSignal({ ...input, ...patch }).kind, 'inactive')
  }
  for (const patch of [{ content: {} }, { content: signal(fallback) }, { content: { ...signal(), checkout: { ...checkout, root: '/other' } } },
    { mtimeMs: 2000 }, { content: { ...signal(), updated_at: 2000 } }, { mtimeMs: null }]) {
    assert.equal(evaluateSignal({ ...input, ...patch }).kind, 'unknown')
  }
})

test('notification attempts survive reloads and bound confirmed rejections without blind retries', () => {
  const identity = eligibleResult(observation, run)!
  const prepare = (record: NotificationRecord | null, now = 1000) => transitionNotification(record, { kind: 'prepare', identity, recipient: owner, instance: 'one' }, now)
  let record = prepare(null)
  assert.equal(mayAttempt(transitionNotification(record, { kind: 'reload' }, 1001), 1001), true)
  record = transitionNotification(record, { kind: 'submit' }, 1001)
  assert.equal(transitionNotification(record, { kind: 'reload' }, 1002).status, 'indeterminate')
  assert.equal(transitionNotification(record, { kind: 'failure' }, 1002).status, 'indeterminate')
  assert.equal(transitionNotification(record, { kind: 'response', response: {} }, 1002).status, 'indeterminate')
  assert.equal(transitionNotification(record, { kind: 'elapsed', ms: 26000, working: true, question: true }, 27001).status, 'submitting')
  // El plazo cuenta solo tiempo ocioso: justo antes de cumplirse, sigue en submitting.
  assert.equal(transitionNotification(record, { kind: 'elapsed', ms: SUBMIT_IDLE_TIMEOUT_MS - 1, working: false, question: false }, 11000).status, 'submitting')
  const timeout = transitionNotification(record, { kind: 'elapsed', ms: SUBMIT_IDLE_TIMEOUT_MS, working: false, question: false }, 11001)
  assert.equal(timeout.status, 'indeterminate')
  assert.equal(mayAttempt(timeout, 1e9), false)
  const accepted = transitionNotification(timeout, { kind: 'response', response: { text: 'aviso' } }, 12000)
  assert.equal(accepted.status, 'accepted')
  assert.equal(mayAttempt(accepted, 1e9), false)
  // Un drop tardío cierra el intento sin abrir los reintentos de un rechazo a tiempo.
  const lateDrop = transitionNotification(timeout, { kind: 'response', response: { drop: 'tarde' } }, 12000)
  assert.equal(lateDrop.status, 'rejected')
  assert.equal(lateDrop.next_attempt_at, null)
  assert.equal(mayAttempt(lateDrop, 1e9), false)
  // El criterio de operatividad del mod (register.tsx usa mayRecover): un rechazo cerrado sin fecha la quita, uno en
  // espera de reintento no, igual que indeterminate y exhausted la quitan.
  assert.equal(mayRecover(lateDrop), false)
  assert.equal(mayRecover({ ...lateDrop, next_attempt_at: 42_000 }), true)
  assert.equal(mayRecover(timeout), false)
  assert.equal(mayRecover(accepted), true)
  assert.equal(validNotificationRecord(lateDrop, identity, owner), true)
  let now = 12000
  for (let attempt = 1; attempt <= MAX_NOTIFICATION_ATTEMPTS; attempt++) {
    record = transitionNotification(record, { kind: 'response', response: { drop: 'rechazado' } }, now)
    assert.equal(record.attempts, attempt)
    if (attempt === MAX_NOTIFICATION_ATTEMPTS) break
    const delay = RETRY_DELAYS_MS[attempt - 1]!
    assert.equal(record.next_attempt_at, now + delay)
    assert.equal(mayAttempt(record, now + delay - 1), false)
    assert.equal(mayAttempt(record, now + delay), true)
    record = transitionNotification(record, { kind: 'reload' }, now + delay)
    now += delay
    record = transitionNotification(prepare(record, now), { kind: 'submit' }, now)
  }
  assert.equal(record.status, 'exhausted')
  assert.equal(mayAttempt(record, 1e9), false)
})
