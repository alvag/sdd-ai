import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import { RETRY_DELAYS_MS, resultKey, SIGNAL_TTL_MS, SUBMIT_IDLE_TIMEOUT_MS } from '../hooks/notification'
import { binding, known, REAL_ROOT, T0, unknown } from './fixtures/band-world'
import { NEVER_EFFECTS } from './fixtures/forbidden-effects'
import { NotificationWorld, notificationBarrier, STORE_LIMIT_BYTES } from './fixtures/notification-world'

let sessions = 0
function setup(on: On, store = new Map<string, unknown>()) {
  const world = new NotificationWorld(`notification-${++sessions}`, store)
  world.install(on)
  // El motor de pruebas no dibuja la línea nativa: el hook del mod pasa por next(e) y alguien tiene que responder.
  on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: 'native hint' }))
  const clock = mock.clock(on, { now: T0 + 1000 })
  return { world, clock }
}
// El Engine de pruebas no expone $.state: el reemplazo de generación se simula reescribiendo lo que el mod lee.
function generationReplacement(on: On) {
  let replaced = false
  on('state.get', { plugin: 'sdd-ai-mod', key: 'notification' }, async (_$, e, next) => {
    const read = await next(e)
    // La respuesta del hook envuelve la lectura del motor: { value: { value, version } }.
    const held = read.value as { value?: { generation: number }; version: number }
    const value = held.value
    return replaced && value ? { value: { ...held, value: { ...value, generation: value.generation + 1, instance: 'replacement' } } } : read
  })
  // Como un $.state.set único: vale hasta que el mod vuelve a escribir su estado.
  on('state.set', { plugin: 'sdd-ai-mod', key: 'notification' }, (_$, e, next) => { replaced = false; return next(e) })
  return () => { replaced = true }
}
async function adopt($: Engine, clock: MockClock, working = false, draft = false) {
  const hint = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'PromptHint', props: { hint: 'native hint', isWorking: working, isDraft: draft } })
  await clock.settle()
  return hint
}

test('terminal observations request receipt once per result and preserve plugin origin and draft', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.text).toContain('./bin/sdd-ai wait run')
  expect(world.requests[0]?.asUser).not.toBe(true)
  // Solo { text }, con el origen de plugin del mod.
  expect(world.requests[0]?.origin).toEqual({ kind: 'plugin', name: 'sdd-ai-mod' })
  expect(world.requests[0]?.extra).toEqual([])
  expect(world.records()[0]?.status).toBe('accepted')
  expect(world.signal()?.operational).toBe(true)
  await hint.redraw({ hint: 'native hint', isWorking: false, isDraft: false })
  await clock.advance(4000)
  expect(world.requests).toHaveLength(1)
  world.clearLive()
  world.publish(200, { notificationsVersion: 1, runs: [] })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('every successful or failed terminal is eligible but progress natives and uncertain cessation are not', async ($, on) => {
  const { world, clock } = setup(on)
  const terminals = ['done', 'failed', 'cancelled', 'timeout', 'launch_failed'].map(state => world.terminal(state, { state: known(state) }))
  const excluded = [world.terminal('running', { state: known('running'), open: known('running') }),
    world.terminal('uncertain', { state: known('cessation_uncertain') }), world.terminal('native', { kind: known('native') }),
    world.terminal('received-review', { kind: known('review'), open: known('review_pending') })]
  world.publish(100, { notificationsVersion: 1, runs: [...terminals, ...excluded] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(5)
  for (const state of ['done', 'failed', 'cancelled', 'timeout', 'launch_failed']) expect(world.requests.some(r => r.text.includes(`wait ${state}.`))).toBe(true)
  await hint.unmount()
})

test('reviews use launch identity and status without repeating received findings', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal('review', { kind: known('review'), delivery: known({ round: 2, launch: 1 }) })] })
  const hint = await adopt($, clock)
  await clock.advance(1000)
  expect(world.requests[0]?.text).toContain('ronda 2, lanzamiento 1')
  expect(world.requests[0]?.text).toContain('./bin/sdd-ai review status review')
  world.publish(200, { notificationsVersion: 1, runs: [world.terminal('review', { kind: known('review'), delivery: known({ round: 2, launch: 2 }) })] })
  await clock.advance(2000)
  expect(world.requests).toHaveLength(2)
  world.publish(300, { notificationsVersion: 1, runs: [world.terminal('review', { kind: known('review'), open: known('review_pending') })] })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(2)
  await hint.unmount()
})

test('work questions drafts and a folded band postpone only receipt and still renew the signal', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock, true)
  await clock.advance(3000)
  expect(world.requests).toHaveLength(0)
  expect(world.signal()?.operational).toBe(true)
  world.draft = { text: 'Texto de Max', cursor: 3 }
  await hint.redraw({ hint: 'native hint', isWorking: false, isDraft: true })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(0)
  expect(world.draft).toEqual({ text: 'Texto de Max', cursor: 3 })
  world.draft = { text: '', cursor: 0 }
  await hint.redraw({ hint: 'native hint', isWorking: false, isDraft: false })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('confirmed drops retry after 30 and 60 seconds and exhausted remains degraded until receipt', async ($, on) => {
  const { world, clock } = setup(on)
  world.replies = [{ drop: 'fixture' }, { drop: 'fixture' }, { drop: 'fixture' }]
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(1000)
  expect(world.records()[0]?.status).toBe('rejected')
  expect(world.signal()?.operational).toBe(true)
  const [first, second] = RETRY_DELAYS_MS
  await clock.advance(first - 1000)
  expect(world.requests).toHaveLength(1)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(2)
  await clock.advance(second + 1000)
  expect(world.requests).toHaveLength(3)
  expect(world.records()[0]?.status).toBe('exhausted')
  await clock.advance(3000)
  expect(world.signal()?.operational).toBe(false)
  world.publish(200, { notificationsVersion: 1, runs: [] })
  await clock.advance(1000)
  expect(world.signal()?.operational).toBe(true)
  await hint.unmount()
})

test('an idle timeout is indeterminate without resubmission and a late answer closes the attempt', async ($, on) => {
  const { world, clock } = setup(on)
  const barrier = notificationBarrier()
  world.barrier = op => op === 'prompt.submit' ? barrier.wait() : undefined
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  await clock.advance(SUBMIT_IDLE_TIMEOUT_MS + 1000)
  expect(world.records()[0]?.status).toBe('indeterminate')
  await clock.advance(3000)
  expect(world.requests).toHaveLength(1)
  expect(world.signal()?.operational).toBe(false)
  barrier.release()
  await clock.settle()
  await clock.advance(1000)
  expect(world.records()[0]?.status).toBe('accepted')
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('owner priority blocks fallback and unknown delivery never sustains operational silence', async ($, on) => {
  const { world, clock } = setup(on)
  world.seedSignal('owner', true, T0 + 1000)
  world.publish(100, { notificationsVersion: 1, bindings: [binding(world.session, 'flow')],
    runs: [world.terminal('foreign', { session: known('owner'), flow: known('flow') }), world.terminal('unknown', { delivery: unknown('delivery_unavailable') })] })
  const hint = await adopt($, clock)
  await clock.advance(1000)
  expect(world.requests).toHaveLength(0)
  expect(world.signal()?.operational).toBe(false)
  world.publish(200, { notificationsVersion: 1, bindings: [binding(world.session, 'flow')], runs: [world.terminal('foreign', { session: known('owner'), flow: known('flow') })] })
  await clock.advance(6000)
  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.text).toContain('wait foreign')
  await hint.unmount()
})

test('an inherited submitting record never sends blindly and becomes indeterminate', async ($, on) => {
  const { world, clock } = setup(on)
  const identity = { checkout: { id: 'f'.repeat(64), root: REAL_ROOT }, id: 'run', round: null, launch: null }
  const recipient = { family: 'claude' as const, session: world.session }
  const key = resultKey(identity, recipient)
  world.store.set(key, { schema_version: 1, identity, recipient, instance: 'old', status: 'submitting', attempts: 1, next_attempt_at: null, idle_ms: 0, updated_at: T0 })
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(0)
  expect(world.records()[0]?.status).toBe('indeterminate')
  expect(world.signal()?.operational).toBe(false)
  await hint.unmount()
})

for (const status of ['prepared', 'accepted'] as const) test(`adoption preserves inherited ${status} for the same recipient`, async ($, on) => {
  const { world, clock } = setup(on)
  const identity = { checkout: { id: 'f'.repeat(64), root: REAL_ROOT }, id: 'run', round: null, launch: null }
  const recipient = { family: 'claude' as const, session: world.session }
  world.store.set(resultKey(identity, recipient), { schema_version: 1, identity, recipient, instance: 'old', status,
    attempts: status === 'accepted' ? 1 : 0, next_attempt_at: null, idle_ms: 0, updated_at: T0 })
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(status === 'accepted' ? 0 : 1)
  await hint.unmount()
})

for (const point of ['prepared', 'submitting'] as const) test(`generation replacement at persisted ${point} prevents stale effects`, async ($, on) => {
  const { world, clock } = setup(on)
  const replace = generationReplacement(on)
  const barrier = notificationBarrier()
  let held = false
  world.barrier = (op, _key, value) => {
    if (!held && op === 'store.set' && (value as { status?: string })?.status === point) { held = true; return barrier.wait() }
    return undefined
  }
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  replace()
  barrier.release()
  await clock.settle()
  expect(world.requests).toHaveLength(0)
  // La instancia invalidada no recupera la autoridad por su cuenta: ciclos después sigue sin enviar ni reescribir el
  // estado del coordinador.
  await clock.advance(2000)
  expect(world.requests).toHaveLength(0)
  // Una identidad distinta y la vuelta a la original obligan a adoptar un coordinador nuevo, como una recarga real:
  // recién ese coordinador decide sobre el registro heredado.
  const original = world.session
  world.session = 'temporary-generation'
  await clock.advance(1000)
  world.session = original
  await clock.advance(2000)
  expect(world.requests).toHaveLength(point === 'prepared' ? 1 : 0)
  expect(world.records()[0]?.status).toBe(point === 'prepared' ? 'accepted' : 'indeterminate')
  await hint.unmount()
})

test('editing at the final draft barrier postpones the submission without altering the text', async ($, on) => {
  const { world, clock } = setup(on)
  const barrier = notificationBarrier()
  let once = false
  world.barrier = op => {
    if (op === 'prompt.read' && !once) { once = true; return barrier.wait() }
    return undefined
  }
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  world.draft = { text: 'Texto escrito durante la lectura', cursor: 7 }
  barrier.release()
  await clock.settle()
  expect(world.requests).toHaveLength(0)
  expect(world.draft.cursor).toBe(7)
  world.draft = { text: '', cursor: 0 }
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('a prompt queued behind work does not expire until ten idle seconds', async ($, on) => {
  const { world, clock } = setup(on)
  const barrier = notificationBarrier()
  world.barrier = op => op === 'prompt.submit' ? barrier.wait() : undefined
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  await hint.redraw({ hint: 'native hint', isWorking: true, isDraft: false })
  await clock.advance(26000)
  expect(world.records()[0]?.status).toBe('submitting')
  expect(world.signal()?.operational).toBe(true)
  barrier.release()
  await clock.settle()
  await clock.advance(1000)
  expect(world.records()[0]?.status).toBe('accepted')
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

// Qué pasa mientras dura cada fallo y después: sin la persistencia o el prompt no se envía y la señal se degrada; sin
// poder escribir la señal se sigue avisando, pero Stop no se calla (no hay señal vigente); un submit que falla queda
// indeterminado. Al recuperarse, ningún pendiente se pierde: se avisa una sola vez o queda para la recepción manual.
const during: Record<string, { requests: number; signal: 'degraded' | 'absent' }> = {
  'store.get': { requests: 0, signal: 'degraded' }, 'store.set': { requests: 0, signal: 'degraded' },
  'prompt.read': { requests: 0, signal: 'degraded' }, 'fs.write': { requests: 1, signal: 'absent' },
  'prompt.submit': { requests: 1, signal: 'degraded' },
}
for (const failure of Object.keys(during)) test(`notifier recovers conservatively from ${failure}`, async ($, on) => {
  const { world, clock } = setup(on)
  const expected = during[failure]!
  world.failure = failure
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(3000)
  expect(world.requests).toHaveLength(expected.requests)
  if (expected.signal === 'absent') expect(world.signal()).toBeNull()
  else expect(world.signal()?.operational).toBe(false)
  world.failure = null
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  if (failure === 'prompt.submit') {
    expect(world.records()[0]?.status).toBe('indeterminate')
    expect(world.signal()?.operational).toBe(false)
  } else {
    expect(world.records()[0]?.status).toBe('accepted')
    expect(world.signal()?.operational).toBe(true)
  }
  await hint.unmount()
})

test('a persistent failure writes one degraded signal and then lets it expire', async ($, on) => {
  const { world, clock } = setup(on)
  world.failure = 'store.get'
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.signal()?.operational).toBe(false)
  const written = world.signal()!.updated_at
  await clock.advance(SIGNAL_TTL_MS + 2000)
  // Ninguna renovación mientras dura la racha: la señal degradada vence y Stop vuelve a recordar.
  expect(world.signal()!.updated_at).toBe(written)
  expect(world.effects.filter(e => e.op === 'fs.write')).toHaveLength(1)
  await hint.unmount()
})

test('missing corrupt foreign incompatible and retained observations never request a new turn', async ($, on) => {
  const { world, clock } = setup(on)
  const hint = await adopt($, clock)
  const bad = [undefined, 99, 1.5] as const
  for (const notificationsVersion of bad) {
    world.publish(100, { notificationsVersion, runs: [world.terminal()] })
    await clock.advance(1000)
    expect(world.requests).toHaveLength(0)
    world.clearLive()
  }
  world.publish(100, { notificationsVersion: 1, root: '/foreign', runs: [world.terminal()] })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(0)
  world.clearLive()
  const name = world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  world.entries.set(`${REAL_ROOT}/.sdd-ai/projection/live/${name}`, { kind: 'file', text: '{' })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(0)
  world.clearLive()
  world.publish(200, { notificationsVersion: 1, runs: [world.terminal()] })
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  const last = world.signal()!.updated_at
  world.clearLive()
  await clock.advance(6000)
  expect(world.signal()!.updated_at).toBe(last)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('notice effects target only the own signal and complete result keys and never execute commands', async ($, on) => {
  const { world, clock } = setup(on)
  const prohibited: string[] = []
  for (const event of [...NEVER_EFFECTS, 'tool.call'] as const) {
    on(event, () => { prohibited.push(event); throw new Error('Efecto ajeno al aviso.') })
  }
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const snapshot = [...world.entries].filter(([path]) => !path.includes('/hooks/notifications'))
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(prohibited).toEqual([])
  expect(world.effects.filter(e => e.op === 'fs.write').every(e => e.key === world.signalPath())).toBe(true)
  // La clave completa: checkout, raíz, corrida, ronda, lanzamiento, familia y sesión destinataria.
  const identity = { checkout: { id: 'f'.repeat(64), root: REAL_ROOT }, id: 'run', round: null, launch: null }
  const key = resultKey(identity, { family: 'claude', session: world.session })
  expect(world.effects.filter(e => e.op.startsWith('store.')).every(e => e.key === key)).toBe(true)
  expect([...world.entries].filter(([path]) => !path.includes('/hooks/notifications') && !path.endsWith('/.sdd-ai/hooks'))).toEqual(snapshot)
  await hint.unmount()
})

test('AskUserQuestion continuation remains intact while its pending answer postpones notifications', async ($, on) => {
  const { world, clock } = setup(on)
  const question = notificationBarrier()
  let continued = 0
  const response = { deny: 'Respuesta de fixture intacta' }
  on('tool.call', { tool: 'AskUserQuestion' }, async () => { continued++; await question.wait(); return response })
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock, true)
  const answer = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'question', questions: [{ question: '¿Continuar?', header: 'Fixture',
    options: [{ label: 'Sí', description: 'Continuar' }, { label: 'No', description: 'Detener' }], multiSelect: false }] })
  await question.reached
  // El dato visual por sí solo no libera una pregunta cuya continuación sigue pendiente.
  await hint.redraw({ hint: 'native hint', isWorking: false, isDraft: false })
  await clock.advance(3000)
  expect(world.requests).toHaveLength(0)
  expect(world.signal()?.operational).toBe(true)
  question.release()
  expect(await answer).toEqual(response)
  expect(continued).toBe(1)
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('main turn continuations remain intact and a subagent completion does not clear working', async ($, on) => {
  const { world, clock } = setup(on)
  const starts: string[] = []; const completions: string[] = []
  on('turn.start', (_$, e) => { starts.push(e.turnId); return { turnId: e.turnId } })
  on('turn.complete', (_$, e) => { completions.push(e.turnId); return { text: e.answer } })
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock, true)
  expect(await $.turn.start({ text: 'Texto original', turnId: 'main' })).toEqual({ turnId: 'main' })
  expect(await $.turn.complete({ answer: 'Respuesta hija', durationMs: 1, isAborted: false, turnId: 'child', agentId: 'child', reason: 'answer' })).toEqual({ text: 'Respuesta hija' })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(0)
  expect(await $.turn.complete({ answer: 'Respuesta principal', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })).toEqual({ text: 'Respuesta principal' })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  expect(starts).toEqual(['main'])
  expect(completions).toEqual(['child', 'main'])
  await hint.unmount()
})

test('quota and corrupt records preserve pending results without sending and permit manual recovery', async ($, on) => {
  const { world, clock } = setup(on)
  const identity = { checkout: { id: 'f'.repeat(64), root: REAL_ROOT }, id: 'run', round: null, launch: null }
  const key = resultKey(identity, { family: 'claude', session: world.session })
  world.storeLimitBytes = 1
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(3000)
  expect(world.requests).toHaveLength(0)
  expect(world.signal()?.operational).toBe(false)
  world.storeLimitBytes = STORE_LIMIT_BYTES
  world.store.set(key, { status: 'accepted', attempts: 'unknown' })
  await clock.advance(3000)
  expect(world.requests).toHaveLength(0)
  expect(world.signal()?.operational).toBe(false)
  world.publish(200, { notificationsVersion: 1, runs: [] })
  await clock.advance(1000)
  expect(world.signal()?.operational).toBe(true)
  expect(world.store.get(key)).toEqual({ status: 'accepted', attempts: 'unknown' })
  await hint.unmount()
})

for (const op of ['store.get', 'store.set', 'fs.write']) test(`a blocked ${op} never accumulates operations or renews silence indefinitely`, async ($, on) => {
  const { world, clock } = setup(on)
  const barrier = notificationBarrier()
  let once = false
  world.barrier = current => {
    if (current === op && !once) { once = true; return barrier.wait() }
    return undefined
  }
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  const count = world.effects.filter(e => e.op === op).length
  await clock.advance(12000)
  expect(world.effects.filter(e => e.op === op)).toHaveLength(count)
  expect(world.signal()?.updated_at ?? T0).not.toBeGreaterThan(clock.now() - SIGNAL_TTL_MS)
  barrier.release()
  await clock.settle()
  await clock.advance(2000)
  // Liberada la operación, el aviso se recupera: una sola solicitud y una señal recién renovada.
  expect(world.requests).toHaveLength(1)
  expect(world.signal()!.updated_at).toBeGreaterThan(clock.now() - 2000)
  await hint.unmount()
})

test('a completely known own result in a partial collection can notify without silencing Stop', async ($, on) => {
  const { world, clock } = setup(on)
  const name = world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const path = `${REAL_ROOT}/.sdd-ai/projection/live/${name}`
  const doc = JSON.parse(world.entries.get(path)!.text!)
  doc.runs.availability = 'partial'; doc.runs.reason = { code: 'partial', detail: 'Inventario incompleto.' }
  world.entries.set(path, { kind: 'file', text: JSON.stringify(doc) })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  expect(world.signal()?.operational).toBe(false)
  await clock.advance(3000)
  expect(world.signal()?.operational).toBe(false)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('a noninterpretable submit result stays indeterminate until manual receipt removes the pending run', async ($, on) => {
  const { world, clock } = setup(on)
  world.replies.push({} as never)
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(4000)
  expect(world.requests).toHaveLength(1)
  expect(world.records()[0]?.status).toBe('indeterminate')
  expect(world.signal()?.operational).toBe(false)
  world.publish(200, { notificationsVersion: 1, runs: [] })
  await clock.advance(1000)
  expect(world.signal()?.operational).toBe(true)
  expect(world.records()[0]?.status).toBe('indeterminate')
  await hint.unmount()
})

for (const change of ['owner_signal', 'binding', 'candidates', 'identity']) test(`final revalidation postpones a fallback when ${change} changes`, async ($, on) => {
  const { world, clock } = setup(on)
  world.seedSignal(world.session, true, T0 + 1000)
  const barrier = notificationBarrier()
  let once = false
  world.barrier = op => {
    if (op === 'prompt.read' && !once) { once = true; return barrier.wait() }
    return undefined
  }
  const run = world.terminal('foreign', { session: known('owner'), flow: known('flow') })
  world.publish(100, { notificationsVersion: 1, bindings: [binding(world.session, 'flow')], runs: [run] })
  const hint = await adopt($, clock)
  await barrier.reached
  if (change === 'owner_signal') world.seedSignal('owner', true, clock.now())
  else if (change === 'binding') world.publish(200, { notificationsVersion: 1, bindings: [binding(world.session, 'other')], runs: [run] })
  else if (change === 'candidates') {
    world.seedSignal('second', true, clock.now())
    world.publish(200, { notificationsVersion: 1, bindings: [binding(world.session, 'flow'), binding('second', 'flow')], runs: [run] })
  } else world.session = 'new-session'
  barrier.release()
  await clock.settle()
  expect(world.requests).toHaveLength(0)
  expect(world.records()[0]?.status).toBe('prepared')
  await hint.unmount()
})

test('several results survive an unknown own result and remain individually deduplicated after redraws', async ($, on) => {
  const { world, clock } = setup(on)
  const runs = [world.terminal('a'), world.terminal('unknown', { delivery: unknown('delivery_unavailable') }), world.terminal('b')]
  world.publish(100, { notificationsVersion: 1, runs })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(2)
  expect(world.signal()?.operational).toBe(false)
  world.publish(200, { notificationsVersion: 1, runs: [world.terminal('a'), world.terminal('unknown'), world.terminal('b')] })
  await clock.advance(2000)
  expect(world.requests).toHaveLength(3)
  await hint.redraw({ hint: 'native hint', isWorking: false, isDraft: false })
  await clock.advance(3000)
  expect(world.requests).toHaveLength(3)
  expect(world.signal()?.operational).toBe(true)
  await hint.unmount()
})

test('render and fold changes themselves write no state files store entries or prompts', async ($, on) => {
  const { world, clock } = setup(on)
  const stateWrites: string[] = []
  on('state.set', (_$, e, next) => { stateWrites.push(e.key); return next(e) })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'native' }))
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const props = { hasSurvey: false, isWorking: false, maxRows: 0, bodyColumns: 80, scroll: { offset: 0, bodyRows: 0 }, view: {} }
  const band = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props })
  await band.redraw({ ...props, maxRows: 1 })
  await band.redraw(props)
  expect(stateWrites).toEqual([])
  expect(world.effects).toEqual([])
  expect(world.requests).toEqual([])
  await clock.settle()
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  await band.unmount()
})

test('late submission responses from a replaced generation cannot overwrite the persistent attempt', async ($, on) => {
  const { world, clock } = setup(on)
  const replace = generationReplacement(on)
  const barrier = notificationBarrier()
  world.barrier = op => op === 'prompt.submit' ? barrier.wait() : undefined
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  replace()
  const before = world.effects.filter(e => e.op === 'store.set').length
  barrier.release()
  await clock.settle()
  await clock.advance(2000)
  expect(world.effects.filter(e => e.op === 'store.set')).toHaveLength(before)
  expect(world.records()[0]?.status).toBe('submitting')
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

for (const segment of ['hooks', 'notifications', 'signal']) test(`an unsafe ${segment} path never authorizes a signal write or submission`, async ($, on) => {
  const { world, clock } = setup(on)
  world.seedSignal(world.session, true, clock.now())
  const path = segment === 'hooks' ? `${REAL_ROOT}/.sdd-ai/hooks`
    : segment === 'notifications' ? `${REAL_ROOT}/.sdd-ai/hooks/notifications` : world.signalPath()
  world.entries.set(path, { ...world.entries.get(path)!, isLink: true, realPath: '/foreign' })
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await clock.advance(6000)
  expect(world.requests).toHaveLength(0)
  expect(world.effects.filter(e => e.op === 'fs.write')).toEqual([])
  world.entries.set(path, { ...world.entries.get(path)!, isLink: false, realPath: path })
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('a blocked projection cannot notify from retained data and recovers the pending result after release', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, { notificationsVersion: 1, runs: [] })
  const hint = await adopt($, clock)
  const last = world.signal()!.updated_at
  const name = world.publish(200, { notificationsVersion: 1, runs: [world.terminal()] })
  const path = `${REAL_ROOT}/.sdd-ai/projection/live/${name}`
  const barrier = notificationBarrier()
  world.hold = current => current === path ? barrier.wait() : undefined
  await clock.advance(1000)
  await barrier.reached
  const reads = world.accesses.filter(e => e.op === 'read' && e.path === path).length
  await clock.advance(12000)
  expect(world.accesses.filter(e => e.op === 'read' && e.path === path)).toHaveLength(reads)
  expect(world.requests).toHaveLength(0)
  expect(world.signal()!.updated_at).toBe(last)
  world.hold = null
  barrier.release()
  await clock.settle()
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  expect(world.signal()?.operational).toBe(true)
  await hint.unmount()
})

test('fallback ambiguity keeps the result pending until exactly one live bound recipient remains', async ($, on) => {
  const { world, clock } = setup(on)
  world.seedSignal(world.session, true, clock.now())
  world.seedSignal('other', true, clock.now())
  world.seedSignal('owner', false, clock.now())
  const run = world.terminal('foreign', { session: known('owner'), flow: known('flow') })
  world.publish(100, { notificationsVersion: 1, runs: [run], bindings: [binding(world.session, 'flow'), binding('other', 'flow')] })
  const hint = await adopt($, clock)
  await clock.advance(1000)
  expect(world.requests).toHaveLength(0)
  world.seedSignal('other', false, clock.now())
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.text).toContain('wait foreign')
  await clock.advance(3000)
  expect(world.requests).toHaveLength(1)
  await hint.unmount()
})

test('a writer result is published as worker: done asks for wait and cessation_uncertain is never notified', async ($, on) => {
  const { world, clock } = setup(on)
  // La proyección publica los writers terminales con la clase worker: no hay una clase writer aparte.
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal('writer-done', { kind: known('worker') }),
    world.terminal('writer-uncertain', { kind: known('worker'), state: known('cessation_uncertain') })] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.text).toContain('./bin/sdd-ai wait writer-done')
  await hint.unmount()
})

test('an own run without a known family is never sustained as operational', async ($, on) => {
  const { world, clock } = setup(on)
  // Sin familia no hay dueña: no se puede avisar, así que la señal no acredita operatividad y Stop sigue recordando.
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal('nofamily', { session_family: unknown('owner_family_unavailable') })] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(0)
  expect(world.signal()?.operational).toBe(false)
  await hint.unmount()
})

test('work starting after prepared keeps the result prepared and sends it once the session is idle', async ($, on) => {
  const { world, clock } = setup(on)
  const barrier = notificationBarrier()
  let held = false
  world.barrier = (op, _key, value) => {
    if (!held && op === 'store.set' && (value as { status?: string })?.status === 'prepared') { held = true; return barrier.wait() }
    return undefined
  }
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  await hint.redraw({ hint: 'native hint', isWorking: true, isDraft: false })
  barrier.release()
  await clock.settle()
  // No se persistió submitting ni se perdió el aviso: sigue prepared, sin degradar la señal.
  expect(world.requests).toHaveLength(0)
  expect(world.records()[0]?.status).toBe('prepared')
  await hint.redraw({ hint: 'native hint', isWorking: false, isDraft: false })
  await clock.advance(1000)
  expect(world.requests).toHaveLength(1)
  // La respuesta del submit se procesa en el ciclo siguiente.
  await clock.advance(1000)
  expect(world.records()[0]?.status).toBe('accepted')
  await hint.unmount()
})

test('a stuck notice never stops the band from refreshing', async ($, on) => {
  const { world, clock } = setup(on)
  const bandWrites: unknown[] = []
  on('state.set', { plugin: 'sdd-ai-mod', key: 'band' }, (_$, e, next) => { bandWrites.push(e.value); return next(e) })
  const barrier = notificationBarrier()
  world.barrier = op => op === 'store.get' ? barrier.wait() : undefined
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  const before = bandWrites.length
  world.publish(200, { notificationsVersion: 1, bindings: [binding(world.session, 'flow')], runs: [world.terminal()] })
  await clock.advance(3000)
  expect(bandWrites.length).toBeGreaterThan(before)
  barrier.release()
  await clock.settle()
  await hint.unmount()
})

test('an unobserved interval is not counted as idle time for a queued notice', async ($, on) => {
  const { world, clock } = setup(on)
  const barrier = notificationBarrier()
  world.barrier = op => op === 'prompt.submit' ? barrier.wait() : undefined
  const name = world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  // La proyección deja de estar disponible: no se sabe si Claude trabajaba en ese intervalo.
  const path = `${REAL_ROOT}/.sdd-ai/projection/live/${name}`
  const saved = world.entries.get(path)!
  world.entries.set(path, { kind: 'file', text: '{' })
  await clock.advance(SUBMIT_IDLE_TIMEOUT_MS + 5000)
  world.entries.set(path, saved)
  await clock.advance(1000)
  expect(world.records()[0]?.status).toBe('submitting')
  barrier.release()
  await clock.settle()
  await hint.unmount()
})

test('an owner signal with a fresh date but an expired file no longer holds priority', async ($, on) => {
  const { world, clock } = setup(on)
  world.seedSignal(world.session, true, clock.now())
  // La fecha del contenido es actual pero la del archivo venció: las dos se comprueban por separado.
  world.seedSignal('owner', true, clock.now())
  const ownerPath = world.signalPath('owner')
  world.entries.set(ownerPath, { ...world.entries.get(ownerPath)!, mtimeMs: clock.now() - SIGNAL_TTL_MS - 1000 })
  world.publish(100, { notificationsVersion: 1, bindings: [binding(world.session, 'flow')],
    runs: [world.terminal('foreign', { session: known('owner'), flow: known('flow') })] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.text).toContain('wait foreign')
  await hint.unmount()
})

test('an owner signal with a fresh file but an expired date no longer holds priority', async ($, on) => {
  const { world, clock } = setup(on)
  world.seedSignal(world.session, true, clock.now())
  // El caso inverso: el archivo es reciente pero la fecha del contenido venció.
  world.seedSignal('owner', true, clock.now() - SIGNAL_TTL_MS - 1000)
  const ownerPath = world.signalPath('owner')
  world.entries.set(ownerPath, { ...world.entries.get(ownerPath)!, mtimeMs: clock.now() })
  world.publish(100, { notificationsVersion: 1, bindings: [binding(world.session, 'flow')],
    runs: [world.terminal('foreign', { session: known('owner'), flow: known('flow') })] })
  const hint = await adopt($, clock)
  await clock.advance(2000)
  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.text).toContain('wait foreign')
  await hint.unmount()
})

test('a late drop after an idle timeout closes the attempt without retry and keeps Stop reminding', async ($, on) => {
  const { world, clock } = setup(on)
  const barrier = notificationBarrier()
  world.barrier = op => op === 'prompt.submit' ? barrier.wait() : undefined
  world.replies = [{ drop: 'tarde' }]
  world.publish(100, { notificationsVersion: 1, runs: [world.terminal()] })
  const hint = await adopt($, clock)
  await barrier.reached
  await clock.advance(SUBMIT_IDLE_TIMEOUT_MS + 1000)
  expect(world.records()[0]?.status).toBe('indeterminate')
  barrier.release()
  await clock.settle()
  await clock.advance(RETRY_DELAYS_MS[1] + 5000)
  // Rechazado sin fecha: no hay reintento, y mientras siga pendiente la señal no acredita operatividad.
  expect(world.records()[0]?.status).toBe('rejected')
  expect(world.records()[0]?.next_attempt_at).toBeNull()
  expect(world.requests).toHaveLength(1)
  expect(world.signal()?.operational).toBe(false)
  await hint.unmount()
})
