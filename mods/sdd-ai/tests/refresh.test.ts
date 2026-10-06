import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { stateRecorder } from './fixtures/presentation-engine'
import type { SessionViews } from '../types'
import type { Engine, MockClock } from 'claude-code/testing'
import { displayWidth } from '../hooks/band'
import {
  binding, flowEntry, LIVE, nameOf, observationText, paths, pending, REAL_ROOT, review, run, SESSION_ROOT, T0, World, writer, known,
} from './fixtures/band-world'

const PROPS: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 160, scroll: { offset: 0, bodyRows: 8 }, view: {} }
const NATIVE = 'native:AbovePrompt'
/** Lo que no debe pasar nunca por refrescar o dibujar la banda: avisos, turnos, prompts ni llamadas al modelo. */
const QUIET = ['ui.toast', 'ui.status', 'ui.notice', 'prompt.submit', 'prompt.fill', 'model.complete', 'model.fork', 'session.append'] as const

let sessions = 0
/**
 * Cada test usa su propia sesión: el estado de la banda que guarda el motor no depende del test anterior. `clockOn`
 * envuelve el `on` con que el reloj simulado registra sus hooks: el motor no admite un segundo hook del mismo evento,
 * así que un test que quiere retener una respuesta de `$.clock` envuelve el del reloj en vez de registrar otro.
 */
function setup(on: On, clockOn: (on: On) => On = (inner) => inner) {
  const world = new World(`refresh-session-${++sessions}`)
  world.install(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: NATIVE }))
  const noise: string[] = []
  for (const name of QUIET) on(name, () => {
    noise.push(name)
    throw new Error(`unexpected effect: ${name}`)
  })
  const clock = mock.clock(clockOn(on), { now: T0 + 1_000 })
  return { world, clock, noise }
}

type Mounted = { find: (query: { type: string }) => Promise<{ text: string } | undefined>; drawn: () => Promise<unknown> }
const shown = async (ui: Mounted): Promise<string | undefined> => (await ui.find({ type: 'Text' }))?.text
/** Las consultas de identidad: antes y después de leer; si sigue trabada, una por período. */
const reads = (world: World) => world.accesses.filter((access) => access.op === 'stat' && access.path === world.sessionRoot).length
/** Las lecturas que llegaron a listar `live/`. */
const listings = (world: World) => world.accesses.filter((access) => access.op === 'list').length

/** Traba el `$.fs.read` de la observación `name` hasta que el test lo suelta. */
function stallReadOf(world: World, name: string) {
  let release = () => {}
  const stalled = new Promise<void>((resolve) => { release = resolve })
  world.hold = (path) => (path.endsWith(name) ? stalled : undefined)
  return {
    release: () => {
      world.hold = null
      release()
    },
    reads: () => world.accesses.filter((access) => access.op === 'read' && access.path.endsWith(name)).length,
  }
}

/** Una compuerta que retiene a quien la espera hasta que el test la abre, y cuenta cuántos esperan. */
function gate() {
  let open = () => {}
  const closed = new Promise<void>((resolve) => { open = resolve })
  const held = { count: 0, active: true }
  return {
    held,
    wait: (): Promise<void> | undefined => {
      if (!held.active) return undefined
      held.count++
      return closed
    },
    open: () => {
      held.active = false
      open()
    },
  }
}

/** Una observación con la sesión ligada al flujo `demo`, una revisión suya en curso y nada más. */
const bound = (world: World) => ({
  flows: [flowEntry('demo')], bindings: [binding(world.session, 'demo')], runs: [review('r1', world.session, { flow: known('demo') })],
})
const REVIEW_LINE = 'demo · paso implement · revisión · ronda 2 · reliability lote 1 · 3/5'

/** El arranque de una sesión en la terminal, y su primera lectura. */
async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('the band starts with the session and redraws by itself when the projection changes', async ($, on) => {
  const viewsState = stateRecorder<SessionViews>(on, 'views')
  const { world, clock, noise } = setup(on)
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  // Una sola línea: un Text que se trunca en vez de partirse.
  expect(viewsState.value()).toMatchObject({
    identity: { session: world.session, root: REAL_ROOT }, observedAt: T0, readAt: T0 + 1000, retained: false,
    selection: { binding: { flow: { id: 'demo', step: 'implement' } }, runs: { items: [{ run: { id: 'r1' } }] } },
  })
  expect(await ui.drawn()).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' } })
  // Otro proceso publica: la banda cambia en el período siguiente, sin redibujar a mano ni turnos nuevos.
  world.publish(200, { ...bound(world), runs: [], writer: writer('w1', world.session, { state: known('cessation_uncertain'), open: known('undelivered'), flow: known('demo') }) })
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('demo · paso implement · writer · cese incierto')
  expect(viewsState.value()?.selection?.runs.items.map(item => item.run.id)).toEqual(['w1'])
  expect(reads(world)).toBe(4)
  // Mientras nada cambia, la banda tampoco: no hay avance por el paso del tiempo.
  await clock.advance(5_000)
  expect(await shown(ui)).toBe('demo · paso implement · writer · cese incierto')
  expect(noise).toEqual([])
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a refused write of the detailed views never stops the band from updating', async ($, on) => {
  stateRecorder<SessionViews>(on, 'views', { deny: () => true })
  const { world, clock, noise } = setup(on)
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  world.publish(200, { ...bound(world), runs: [], writer: writer('w1', world.session, { state: known('cessation_uncertain'), open: known('undelivered'), flow: known('demo') }) })
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('demo · paso implement · writer · cese incierto')
  expect(noise).toEqual([])
  await ui.unmount()
})

test('a session that adopts the mod already open starts the refresh from the band once', async ($, on) => {
  const { world, clock, noise } = setup(on)
  world.publish(100, bound(world))
  // Sin `session.start`: el dibujo programa el arranque y el refresco escribe el estado desde su temporizador.
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await clock.settle()
  expect(await shown(ui)).toBe(REVIEW_LINE)
  expect(reads(world)).toBe(2)
  // Un `session.start` posterior, otro dibujo y otro sitio no arrancan un segundo refresco.
  await start($, clock)
  await ui.redraw()
  const other = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await clock.settle()
  expect(reads(world)).toBe(2)
  await clock.advance(3_000)
  expect(reads(world)).toBe(8)
  expect(await shown(other)).toBe(REVIEW_LINE)
  expect(noise).toEqual([])
  expect(world.violations()).toEqual([])
  await ui.unmount()
  await other.unmount()
})

test('a new session id or root retires the data of the previous identity before reading', async ($, on) => {
  const viewsState = stateRecorder<SessionViews>(on, 'views')
  const { world, clock } = setup(on)
  const first = world.session
  const second = `${first}-cleared`
  world.publish(100, {
    flows: [flowEntry('demo'), flowEntry('other', 'specify')], bindings: [binding(first, 'demo'), binding(second, 'other')],
    runs: [review('r1', first, { flow: known('demo') })], writer: writer('w1', second, { flow: known('other') }),
  })
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  // Un `/clear` sigue con otro id y sin `session.start`. Mientras la lectura de la nueva identidad tarda, la banda ya no
  // muestra la anterior.
  let release = () => {}
  world.hold = () => new Promise<void>((resolve) => { release = resolve })
  world.session = second
  await clock.advance(1_000)
  expect(await shown(ui)).toBe(NATIVE)
  expect(viewsState.value()).toEqual({
    identity: { session: second, root: REAL_ROOT }, observedAt: null, readAt: T0 + 2000, retained: false, selection: null, unavailable: 'identity_changed',
  })
  world.hold = null
  release()
  await clock.settle()
  expect(await shown(ui)).toBe('other · paso specify · writer · en curso')
  expect(viewsState.value()?.identity.session).toBe(second)
  // Otra raíz con `live/` vacío: se agotan los intentos y no hay una última lectura de esta identidad que conservar.
  world.checkout('/work/second', '/private/work/second')
  world.sessionRoot = '/work/second'
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  // Una raíz sin `.sdd-ai/`: la proyección no está disponible.
  world.checkout('/work/third', '/private/work/third', false)
  world.sessionRoot = '/work/third'
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  // De vuelta en la primera, la banda vuelve a leer la identidad actual.
  world.sessionRoot = SESSION_ROOT
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('other · paso specify · writer · en curso')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a response completed after a session change cannot restore the previous detailed identity', async ($, on) => {
  const viewsState = stateRecorder<SessionViews>(on, 'views')
  const { world, clock } = setup(on)
  const first = world.session
  world.publish(100, bound(world))
  await start($, clock)
  const stuck = stallReadOf(world, world.publish(200, bound(world)))
  await clock.advance(1000)
  world.session = `${first}-new`
  stuck.release()
  await clock.settle()
  expect(viewsState.value()).toEqual({
    identity: { session: world.session, root: REAL_ROOT }, observedAt: null, readAt: T0 + 2000, retained: false, selection: null, unavailable: 'identity_changed',
  })
  await clock.advance(1000)
  expect(viewsState.value()?.selection?.runs.items).toEqual([])
  expect(world.violations()).toEqual([])
})

test('a stalled read is never joined by another and stops the previous read from passing as current', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  // La lectura siguiente se traba en una observación más nueva: su `$.fs.read` no resuelve hasta que el test la suelta.
  const stuck = stallReadOf(world, world.publish(200, { ...bound(world), runs: [], writer: writer('w1', world.session, { flow: known('demo') }) }))
  await clock.advance(1_000)
  expect(listings(world)).toBe(2)
  // Durante diez segundos, la banda sigue con la lectura anterior.
  await clock.advance(9_000)
  expect(await shown(ui)).toBe(REVIEW_LINE)
  // Pasado el plazo, la conserva marcada como última lectura, nunca como actual.
  await clock.advance(1_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura`)
  // Mientras la trabada sigue pendiente no arranca otra lectura: no se acumulan. La identidad se vuelve a consultar en
  // cada período, y la antigüedad sigue al reloj.
  const identities = reads(world)
  await clock.advance(60_000)
  expect(listings(world)).toBe(2)
  expect(stuck.reads()).toBe(1)
  expect(reads(world) - identities).toBe(60)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura · observada hace 72 s`)
  // Cuando termina, su respuesta tardía no se escribe, y recién entonces arranca la siguiente lectura.
  stuck.release()
  await clock.settle()
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura · observada hace 72 s`)
  await clock.advance(1_000)
  expect(listings(world)).toBe(3)
  // Es una lectura actual: sin la marca, y con la antigüedad de su observación, que tiene una corrida viva.
  expect(await shown(ui)).toBe('demo · paso implement · writer · en curso · observada hace 73 s')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a first read that never finishes leaves the band unavailable and starts no other read', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  // Un `$.fs.read` que no resuelve nunca.
  world.hold = () => new Promise<void>(() => {})
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(NATIVE)
  await clock.advance(10_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  await clock.advance(120_000)
  expect(listings(world)).toBe(1)
  expect(world.accesses.filter((access) => access.op === 'read')).toHaveLength(1)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  await ui.unmount()
})

test('a new session during a stalled read retires the previous data at once and the next read is of the new one', async ($, on) => {
  const viewsState = stateRecorder<SessionViews>(on, 'views')
  const { world, clock } = setup(on)
  const first = world.session
  const second = `${first}-cleared`
  const parts = {
    flows: [flowEntry('demo'), flowEntry('other', 'specify')], bindings: [binding(first, 'demo'), binding(second, 'other')],
    runs: [review('r1', first, { flow: known('demo') })], writer: writer('w1', second, { flow: known('other') }),
  }
  world.publish(100, parts)
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  const stuck = stallReadOf(world, world.publish(200, parts))
  await clock.advance(11_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura`)
  expect(viewsState.value()).toMatchObject({ identity: { session: first, root: REAL_ROOT }, retained: true, observedAt: T0 })
  // Un `/clear` mientras la lectura sigue trabada: el período siguiente consulta la identidad y retira los datos y la
  // memoria de la sesión anterior, sin arrancar otra lectura.
  world.session = second
  const identities = reads(world)
  await clock.advance(1_000)
  expect(reads(world) - identities).toBe(1)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  expect(viewsState.value()).toMatchObject({ identity: { session: second, root: REAL_ROOT }, selection: null, observedAt: null, retained: false, unavailable: 'identity_changed' })
  await clock.advance(5_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  expect(listings(world)).toBe(2)
  expect(stuck.reads()).toBe(1)
  // La respuesta tardía de la trabada, que era de la sesión anterior, no se escribe; la lectura siguiente ya es de la
  // nueva.
  stuck.release()
  await clock.settle()
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  expect(viewsState.value()?.identity.session).toBe(second)
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('other · paso specify · writer · en curso')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a stalled presentation whose clock answers after the session changed writes nothing of the previous one', async ($, on) => {
  // `$.clock.now()` se puede retener: `holdNow` decide, consulta por consulta, si la respuesta espera.
  let holdNow: () => Promise<void> | undefined = () => undefined
  const { world, clock } = setup(on, (inner) => ((event: string, ...rest: unknown[]) => {
    if (event === 'clock.now') {
      const hook = rest[rest.length - 1] as (...args: unknown[]) => unknown
      rest[rest.length - 1] = async (...args: unknown[]) => {
        await holdNow()
        return hook(...args)
      }
    }
    return (inner as (...args: unknown[]) => unknown)(event, ...rest)
  }) as On)
  const written: string[] = []
  on('state.set', { plugin: 'sdd-ai-mod', key: 'band' }, (_$, e, next) => {
    written.push(e.value.identity.session)
    return next(e)
  })
  const first = world.session
  const second = `${first}-cleared`
  const parts = {
    flows: [flowEntry('demo'), flowEntry('other', 'specify')], bindings: [binding(first, 'demo'), binding(second, 'other')],
    runs: [review('r1', first, { flow: known('demo') })], writer: writer('w1', second, { flow: known('other') }),
  }
  world.publish(100, parts)
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  const stuck = stallReadOf(world, world.publish(200, parts))
  await clock.advance(11_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura`)
  // En el período siguiente pasa la hora del período y se retiene la de su presentación, que ya capturó la primera
  // sesión. Ninguna otra consulta espera.
  const late = gate()
  let calls = 0
  holdNow = () => (++calls === 2 ? late.wait() : undefined)
  await clock.advance(1_000)
  expect(late.held.count).toBe(1)
  // Un `/clear` mientras esa presentación espera: los períodos siguientes ya saben de la segunda sesión. La hora de la
  // presentación pendiente llega cuando la lectura de la primera tendría antigüedad.
  world.session = second
  await clock.advance(55_000)
  const from = written.length
  late.open()
  await clock.settle()
  // La presentación pendiente no escribe los datos de la primera sesión con su hora tardía.
  expect(written.slice(from)).toEqual([])
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura`)
  // El período siguiente presenta la sesión vigente: la memoria de la anterior ya no vale.
  await clock.advance(1_000)
  expect(written.slice(from)).toEqual([second])
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  stuck.release()
  await clock.settle()
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('other · paso specify · writer · en curso · observada hace 70 s')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a new checkout root during a stalled read retires the previous data and memory at once', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  const stuck = stallReadOf(world, world.publish(200, bound(world)))
  await clock.advance(11_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura`)
  // La misma sesión pasa a otro checkout, que tiene su propia proyección.
  const secondReal = '/private/work/second'
  world.checkout('/work/second', secondReal)
  world.publish(300, { ...bound(world), runs: [], writer: writer('w1', world.session, { flow: known('demo') }), root: secondReal }, 'a', paths(secondReal).live)
  world.sessionRoot = '/work/second'
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  // De vuelta en el primero, su memoria ya se retiró: no vuelve como última lectura.
  world.sessionRoot = SESSION_ROOT
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  world.sessionRoot = '/work/second'
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  expect(listings(world)).toBe(2)
  expect(stuck.reads()).toBe(1)
  // La respuesta tardía, del checkout anterior, no se escribe; la lectura siguiente es la del checkout nuevo.
  stuck.release()
  await clock.settle()
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('demo · paso implement · writer · en curso')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a band state that does not answer during a stalled read holds a single presentation', async ($, on) => {
  const { world, clock } = setup(on)
  // El estado de la banda no responde mientras la compuerta está cerrada. Nada lo escribe mientras tanto, así que el
  // dibujo no lo vuelve a leer: cada espera es del refresco.
  let state = { held: { count: 0, active: false }, wait: (): Promise<void> | undefined => undefined, open: () => {} }
  on('state.get', { plugin: 'sdd-ai-mod', key: 'band' }, async (_$, e, next) => {
    await state.wait()
    return next(e)
  })
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  // La lectura se traba en su `$.fs.read`, y la presentación de la trabada, en el estado.
  const stuck = stallReadOf(world, world.publish(200, { ...bound(world), runs: [], writer: writer('w1', world.session, { flow: known('demo') }) }))
  await clock.advance(10_000)
  state = gate()
  await clock.advance(1_000)
  expect(state.held.count).toBe(1)
  // Los períodos siguientes consultan la identidad, pero no lanzan otra presentación mientras esa siga pendiente.
  const identities = reads(world)
  await clock.advance(60_000)
  expect(state.held.count).toBe(1)
  expect(reads(world) - identities).toBe(60)
  expect(listings(world)).toBe(2)
  // Cuando el estado responde, la presentación pendiente termina con la hora en que se escribe, y las siguientes siguen.
  state.open()
  await clock.settle()
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura · observada hace 72 s`)
  await clock.advance(1_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura · observada hace 73 s`)
  stuck.release()
  await clock.settle()
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('demo · paso implement · writer · en curso · observada hace 74 s')

  // Una lectura trabada en el mismo estado: suma una sola presentación pendiente, no una por período.
  state = gate()
  await clock.advance(1_000)
  expect(state.held.count).toBe(1)
  await clock.advance(20_000)
  expect(state.held.count).toBe(2)
  expect(listings(world)).toBe(3)
  state.open()
  await clock.settle()
  await clock.advance(1_000)
  expect(listings(world)).toBe(5)
  expect(await shown(ui)).toBe('demo · paso implement · writer · en curso · observada hace 96 s')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('an identity query that does not answer during a stalled read is never repeated and the band keeps presenting', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  const stuck = stallReadOf(world, world.publish(200, bound(world)))
  await clock.advance(11_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura`)
  // `$.session.root()` deja de responder: una sola consulta queda pendiente, y la banda sigue presentando la trabada con
  // la última identidad que se supo.
  const root = gate()
  world.holdRoot = root.wait
  await clock.advance(61_000)
  expect(root.held.count).toBe(1)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura · observada hace 73 s`)
  world.holdRoot = null
  root.open()
  stuck.release()
  await clock.settle()
  await clock.advance(1_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · observada hace 74 s`)
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a stat or listing that fails for another reason than absence is unreadable and never falls back', async ($, on) => {
  const { world, clock, noise } = setup(on)
  const older = world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  const newest = `${LIVE}/${world.publish(200, bound(world))}`
  const { store, projection } = paths(REAL_ROOT)
  const cases: [string, () => void][] = [
    ['newest', () => world.failingStats.add(newest)],
    ['live', () => world.failingStats.add(LIVE)],
    ['projection', () => world.failingStats.add(projection)],
    ['store', () => world.failingStats.add(store)],
    ['session root', () => world.failingStats.add(SESSION_ROOT)],
    ['listing', () => world.failingLists.add(LIVE)],
  ]
  for (const [name, arrange] of cases) {
    arrange()
    const from = world.accesses.length
    await clock.advance(1_000)
    // Existe y no se pudo consultar: no se lee la anterior, que sigue legible, ni se reintenta como una desaparición, que
    // conservaría la última lectura.
    expect(await shown(ui), name).toBe('sdd-ai: no disponible · no se pudo leer la observación')
    expect(world.accesses.slice(from).filter((access) => access.op === 'read' && access.path.endsWith(older)), name).toEqual([])
    expect(world.accesses.slice(from).filter((access) => access.op === 'list').length, name).toBeLessThanOrEqual(1)
    world.failingStats.clear()
    world.failingLists.clear()
    await clock.advance(1_000)
    expect(await shown(ui), `${name} recuperado`).toBe(REVIEW_LINE)
  }
  expect(noise).toEqual([])
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a permission failure under a path that contains ENOENT is unreadable and not retried as an absence', async ($, on) => {
  const { world, clock } = setup(on)
  const real = '/private/work/ENOENT'
  world.checkout('/work/ENOENT', real)
  world.sessionRoot = '/work/ENOENT'
  const live = paths(real).live
  world.publish(100, { ...bound(world), root: real }, 'a', live)
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  // El rechazo dice EACCES, y la ruta, ENOENT: no se vuelve a listar ni se conserva la lectura anterior.
  world.failingLists.add(live)
  const from = listings(world)
  await clock.advance(1_000)
  expect(listings(world) - from).toBe(1)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · no se pudo leer la observación')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('vanished observations are retried and exhausted attempts keep the last valid read marked', async ($, on) => {
  const { world, clock } = setup(on)
  const older = world.publish(100, bound(world))
  // La más nueva desaparece entre el listado y su `stat`: se lee la siguiente de la misma lista.
  const newer = world.publish(200, { ...bound(world), runs: [] })
  world.ghosts.add(newer)
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  // Desaparecen todas en cada listado: tres listados y se conserva la última lectura, marcada.
  world.ghosts.add(older)
  const lists = () => world.accesses.filter((access) => access.op === 'list').length
  const before = lists()
  await clock.advance(1_000)
  expect(lists() - before).toBe(3)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura`)
  // Con una corrida viva, la última lectura también dice su antigüedad pasados 60 segundos.
  await clock.set(T0 + 61_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura · observada hace 61 s`)
  // Un `live/` que falta mientras otro publicador lo aparta también se reintenta.
  world.entries.delete(LIVE)
  await clock.advance(1_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · última lectura · observada hace 62 s`)
  // Una lectura que falla con el archivo todavía ahí no es una desaparición: no está disponible.
  world.entries.set(LIVE, { kind: 'dir' })
  world.ghosts.clear()
  const fresh = world.publish(300, bound(world), 'b')
  world.unreadable.add(`${LIVE}/${fresh}`)
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · no se pudo leer la observación')
  // Retirados los datos, unos intentos agotados después no los resucitan.
  world.unreadable.clear()
  world.ghosts.add(fresh).add(older).add(newer)
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: no disponible · sin proyección')
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('each unreadable projection is told apart from the empty state without notices and recovers', async ($, on) => {
  const { world, clock, noise } = setup(on)
  const valid = world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  const newest = `${LIVE}/${nameOf(900)}`
  const store = paths(REAL_ROOT).store
  const cases: { name: string; arrange: () => void; line: string; unread?: boolean }[] = [
    { name: 'FIFO', arrange: () => world.entries.set(newest, { kind: 'other' }), line: 'la observación no es un archivo regular' },
    { name: 'directory', arrange: () => world.entries.set(newest, { kind: 'dir' }), line: 'la observación es un directorio' },
    { name: 'link', arrange: () => world.entries.set(newest, { kind: 'file', isLink: true, realPath: '/etc/passwd', text: '{}' }), line: 'la proyección pasa por un enlace' },
    { name: 'too large', arrange: () => world.entries.set(newest, { kind: 'file', size: 4 * 1024 * 1024 + 1, text: '{}' }), line: 'la observación pasa de 4 MiB', unread: true },
    { name: 'corrupt', arrange: () => world.entries.set(newest, { kind: 'file', text: '{"schema_version":1' }), line: 'observación corrupta' },
    { name: 'incompatible', arrange: () => world.entries.set(newest, { kind: 'file', text: observationText(nameOf(900), { schemaVersion: 2 }) }), line: 'versión incompatible' },
    { name: 'foreign', arrange: () => world.entries.set(newest, { kind: 'file', text: observationText(nameOf(900), { ...bound(world), root: '/elsewhere' }) }), line: 'la observación es de otro checkout' },
    { name: 'live link', arrange: () => world.entries.set(LIVE, { kind: 'dir', isLink: true }), line: 'la proyección pasa por un enlace' },
    { name: 'store file', arrange: () => world.entries.set(store, { kind: 'file', text: '' }), line: 'el directorio de la proyección no es un directorio' },
    { name: 'no store', arrange: () => world.entries.delete(store), line: 'sin proyección' },
  ]
  for (const { name, arrange, line, unread } of cases) {
    arrange()
    const from = world.accesses.length
    await clock.advance(1_000)
    // La más nueva no sirve: no se cae a la anterior, que sigue en `live/`, ni al estado vacío.
    expect(await shown(ui), name).toBe(`sdd-ai: no disponible · ${line}`)
    expect(world.entries.has(`${LIVE}/${valid}`)).toBe(true)
    // Una observación demasiado grande ni se lee.
    if (unread) expect(world.accesses.slice(from).filter((access) => access.op === 'read')).toEqual([])
    // Se recupera con la siguiente observación compatible.
    world.entries.delete(newest)
    world.entries.set(store, { kind: 'dir' })
    world.entries.set(LIVE, { kind: 'dir' })
    await clock.advance(1_000)
    expect(await shown(ui), `${name} recuperado`).toBe(REVIEW_LINE)
  }
  // Sin liga ni actividad propia, el estado vacío explícito es otra cosa.
  world.publish(950, { flows: [flowEntry('demo')], runs: [run('ajena', 'otra-sesion')] })
  await clock.advance(1_000)
  expect(await shown(ui)).toBe('sdd-ai: sin flujo ligado ni actividad en esta sesión')
  expect(noise).toEqual([])
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('a flooded live directory is not listed again for three seconds', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  for (let i = 0; i < 256; i++) world.entries.set(`${LIVE}/tmp-${i}`, { kind: 'file', text: '' })
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe('sdd-ai: no disponible · demasiadas entradas en live/')
  const lists = () => world.accesses.filter((access) => access.op === 'list').length
  expect(lists()).toBe(1)
  await clock.advance(2_000)
  expect(lists()).toBe(1)
  // Pasada la pausa vuelve a listar; el siguiente publicador apartó `live/` y la banda se recupera.
  world.clearLive()
  world.publish(200, bound(world))
  await clock.advance(1_000)
  expect(lists()).toBe(2)
  expect(await shown(ui)).toBe(REVIEW_LINE)
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('the band yields to surveys rows and other surfaces and fits the body width', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await shown(ui)).toBe(REVIEW_LINE)
  for (const props of [{ ...PROPS, hasSurvey: true }, { ...PROPS, maxRows: 0 }, { ...PROPS, bodyColumns: 0 }]) {
    await ui.redraw(props)
    expect(await shown(ui), JSON.stringify(props)).toBe(NATIVE)
  }
  // Más angosta: el nombre del flujo se acorta primero y el paso y el progreso siguen enteros, en una línea.
  await ui.redraw({ ...PROPS, bodyColumns: 64 })
  const narrow = await shown(ui)
  expect(narrow).toBe('paso implement · revisión · ronda 2 · reliability lote 1 · 3/5')
  expect(displayWidth(narrow ?? '')).toBeLessThanOrEqual(64)
  // La banda no trae controles propios: plegarla es del motor.
  expect(await ui.find({ type: 'Button' } as { type: string })).toBeUndefined()
  // En el escritorio el sitio queda como está.
  const desktop = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await shown(desktop)).toBe(NATIVE)
  await ui.unmount()
  await desktop.unmount()
})

test('age appears only with a live run after sixty seconds and progress never moves by itself', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await clock.set(T0 + 60_000)
  expect(await shown(ui)).toBe(REVIEW_LINE)
  await clock.set(T0 + 61_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · observada hace 61 s`)
  await clock.set(T0 + 180_000)
  expect(await shown(ui)).toBe(`${REVIEW_LINE} · observada hace 3 min`)
  // Sin corridas vivas no hay antigüedad, por vieja que sea la observación.
  world.publish(200, { flows: [flowEntry('demo')], bindings: [binding(world.session, 'demo')], runs: [pending('p1', world.session, { flow: known('demo') })] })
  await clock.set(T0 + 300_000)
  expect(await shown(ui)).toBe('demo · paso implement · worker · sin entregar')
  await ui.unmount()
})

test('the mod reads only the checkout identity and the live directory', async ($, on) => {
  const { world, clock } = setup(on)
  world.publish(100, bound(world))
  const gone = world.publish(200, bound(world))
  world.ghosts.add(gone)
  await start($, clock)
  await clock.advance(3_000)
  expect(world.accesses.some((access) => access.op === 'read')).toBe(true)
  expect(world.violations()).toEqual([])
  // La comprobación falla si el mod lee, lista o consulta otra ruta.
  const outside = [
    { op: 'read' as const, path: '/etc/passwd' },
    { op: 'read' as const, path: `${paths(REAL_ROOT).projection}/otra` },
    { op: 'read' as const, path: `${LIVE}/sub/${nameOf(1)}` },
    { op: 'list' as const, path: paths(REAL_ROOT).projection },
    { op: 'stat' as const, path: SESSION_ROOT, resolve: false },
    { op: 'stat' as const, path: `${REAL_ROOT}/src`, resolve: false },
    { op: 'stat' as const, path: paths(REAL_ROOT).store, resolve: true },
    { op: 'stat' as const, path: '/private/work', resolve: true },
  ]
  for (const access of outside) expect(world.violations([access]), access.path).toHaveLength(1)
})
