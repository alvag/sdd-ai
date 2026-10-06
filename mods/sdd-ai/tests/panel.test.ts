import type { RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { paneRegistry } from './fixtures/presentation-engine'
import { panelTree, runsTree } from '../hooks/panel'
import { parseObservation, refreshViews } from '../hooks/projection'
import type { SessionViews } from '../types'
import { binding, flowEntry, known, nameOf, observationText, pending, REAL_ROOT, run, SESSION_ROOT, T0, unknown, World, writer } from './fixtures/band-world'
import { guardCommandRegistration, NEVER_EFFECTS } from './fixtures/forbidden-effects'

test('the missing runs count is reserved before long headers so a hidden run is always counted', () => {
  const id = 'f'.repeat(930)
  const memory = views({ bindings: [binding('panel-session', id)], flows: [flowEntry(id)], runs: [pending('only', 'panel-session')] })
  for (const draw of [panelTree, runsTree]) {
    const content = texts(draw(memory, 1000, 160, T0))
    expect(content.join('').length).toBeLessThanOrEqual(1000)
    const shown = content.some(text => text.startsWith('only'))
    // La corrida se ve o, si no entra, el aviso la cuenta: nunca desaparece sin decirlo.
    expect(shown || content.includes('faltan 1 corridas')).toBe(true)
  }
})

function texts(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (!tree || typeof tree !== 'object') return []
  return ((tree as { children?: unknown[] }).children ?? []).flatMap(texts)
}
function views(parts: Parameters<typeof observationText>[1] = {}): SessionViews {
  const name = nameOf(100)
  const result = parseObservation(observationText(name, parts), name, REAL_ROOT)
  if (result.kind !== 'valid') throw new Error('Fixture inválido')
  return refreshViews(result, { session: 'panel-session', root: REAL_ROOT }, undefined, T0 + 1000)
}

test('panel and runs show source values and preserve unknown associations without inventing approvals', () => {
  const gates = ['pending', 'approved', 'approved_unfingerprinted', 'stale'].map((state, index) => ({ gate: `gate-${index}`, artifacts: ['spec.md'], state }))
  const memory = views({ bindings: [binding('panel-session', 'demo')], flows: [{ ...flowEntry('demo'), view: known({
    id: 'demo', next: { step: 'implement' }, gates, tasks: { total: 3, done: 1, pending: 2, first_pending: 'T2' },
    blocked_reasons: [{ code: 'gate_pending', detail: 'Falta aprobar el gate.' }],
  }) }], runs: [run('writer', 'panel-session'), pending('result', 'panel-session', { flow: known('other-flow') }),
    run('foreign', 'another-session'), run('unattributed', 'panel-session', { session: unknown('not_recorded') })], writer: writer('writer', 'panel-session') })
  const panel = texts(panelTree(memory, 90000, 80, T0 + 3000)).join('\n')
  const runs = texts(runsTree(memory, 90000, 48, T0 + 3000)).join('\n')
  for (const state of ['pending', 'approved', 'approved_unfingerprinted', 'stale']) expect(panel.includes(state)).toBe(true)
  for (const expected of ['Flujo demo', 'paso observado implement', 'total 3', 'hechas 1', 'pendientes 2', 'primera pendiente T2', 'Bloqueo gate_pending: Falta aprobar el gate.']) expect(panel.includes(expected)).toBe(true)
  for (const text of [panel, runs]) {
    for (const expected of ['writer protegido', 'clase: worker', 'result', 'ejecución: done', 'apertura: undelivered', 'flujo: other-flow', '1 corridas omitidas por falta de atribución']) expect(text.includes(expected)).toBe(true)
    expect(text.includes('foreign')).toBe(false)
    expect(text.includes('unattributed')).toBe(false)
    expect(text.split('writer protegido').length - 1).toBe(1)
  }
  expect(runs.includes('Tasks:')).toBe(false)
})

test('panel distinguishes unavailable data known absence and retained readings', () => {
  const empty = views()
  const text = texts(panelTree(empty, 90000, 80, T0)).join('\n')
  expect(text.includes('Sin flujo ligado')).toBe(true)
  expect(text.includes('Sin corridas propias abiertas')).toBe(true)
  const unavailable: SessionViews = { ...empty, selection: null, observedAt: null, unavailable: 'identity_changed' }
  const lost = texts(panelTree(unavailable, 90000, 80, T0)).join('\n')
  expect(lost.includes('identity_changed')).toBe(true)
  expect(lost.includes('Observado hace')).toBe(false)
  expect(lost.includes('Sin corridas propias')).toBe(false)
  expect(texts(panelTree({ ...empty, retained: true }, 90000, 80, T0)).join('\n').includes('Última lectura de esta identidad')).toBe(true)
  const uncertain = views({ runs: [run('unknown', 'panel-session', { session: unknown('not_recorded') })] })
  expect(texts(runsTree(uncertain, 90000, 80, T0)).join('\n').includes('No se puede comprobar la ausencia')).toBe(true)
})

test('panel limits complete run entries counts the missing suffix and splits Text at 8000 characters', () => {
  const source = Array.from({ length: 100 }, (_, index) => pending(`run-${String(index).padStart(3, '0')}`, 'panel-session'))
  const memory = views({ runs: source })
  for (const draw of [panelTree, runsTree]) {
    const content = texts(draw(memory, 1000, 48, T0))
    const rows = content.filter(text => text.startsWith('run-'))
    expect(content.join('').length).toBeLessThanOrEqual(1000)
    expect(rows.length).toBeLessThan(100)
    expect(content.includes(`faltan ${100 - rows.length} corridas`)).toBe(true)
    for (let i = 0; i < rows.length; i++) expect(rows[i]?.startsWith(`run-${String(i).padStart(3, '0')}`)).toBe(true)
  }
  const long = views({ runs: [run('long', 'panel-session', { flow: known('x'.repeat(20000)) })] })
  expect(texts(panelTree(long, 90000, 80, T0)).every(text => text.length <= 8000)).toBe(true)
})

test('panel identifies an unreadable bound flow and a partial run inventory without inventing details', () => {
  const memory = views({ bindings: [binding('panel-session', 'demo')], flows: [{ ...flowEntry('demo'), availability: 'unavailable',
    reason: { code: 'flow_unreadable', detail: 'No se pudo leer.' }, view: unknown('flow_unreadable') }] })
  // La colección del fixture es explícitamente parcial: no deducir ausencia de los elementos conocidos.
  memory.selection!.runs.availability = 'partial'
  memory.selection!.runs.reason = { code: 'partial', detail: 'Listado incompleto.' }
  const content = texts(panelTree(memory, 90000, 80, T0)).join('\n')
  expect(content.includes('Flujo demo')).toBe(true)
  expect(content.includes('Vista del flujo no disponible')).toBe(true)
  expect(content.includes('Inventario partial: Listado incompleto.')).toBe(true)
  expect(content.includes('Tasks:')).toBe(false)
  expect(content.includes('Sin corridas propias abiertas')).toBe(false)
})

const paneProps: RenderPropsOf['Pane'] = { title: 'fixture', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} }
const commandInput = (command: string) => ({ command, args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

test('immediate panel commands alternate engine panes return no context and redraw within five seconds', async ($, on) => {
  const world = new World('panel-engine-session')
  world.install(on)
  const panes = paneRegistry(on, { guard: true })
  guardCommandRegistration(on)
  const forbidden: string[] = []
  for (const event of [...NEVER_EFFECTS, 'prompt.submit', 'fs.write', 'store.set'] as const) on(event, () => {
    forbidden.push(event); throw new Error(`Efecto ajeno al panel: ${event}`)
  })
  const clock = mock.clock(on, { now: T0 + 1000 })
  const turns: string[] = []
  on('turn.start', (_$, e) => { turns.push(e.turnId); return { turnId: e.turnId } })
  world.publish(100, { bindings: [binding(world.session, 'demo')], flows: [flowEntry('demo')], runs: [pending('first', world.session)] })
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'turno ya en curso', turnId: 'panel-active-turn' })
  const beforeCommands = [...world.entries]
  expect(await $.command.run(commandInput('sdd-panel'))).toEqual({})
  expect([...world.entries]).toEqual(beforeCommands)
  expect(panes.find('sdd-panel')?.isShown).toBe(true)
  expect(panes.find('sdd-panel')?.isFocused).toBe(false)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'Pane', requestId: 'sdd-panel', props: paneProps })
  expect(texts(await ui.drawn()).join('\n').includes('first')).toBe(true)
  world.publish(200, { bindings: [binding(world.session, 'demo')], flows: [flowEntry('demo')], runs: [pending('second', world.session)] })
  await clock.advance(1000)
  expect(texts(await ui.drawn()).join('\n').includes('second')).toBe(true)
  expect(texts(await ui.drawn()).join('\n').includes('first')).toBe(false)
  expect(await $.command.run(commandInput('sdd-runs'))).toEqual({})
  expect(panes.find('sdd-runs')?.isShown).toBe(true)
  // El panel quedó abierto pero detrás de la lista: el comando lo vuelve a mostrar en vez de cerrarlo.
  expect(panes.find('sdd-panel')?.isShown).toBe(false)
  await $.command.run(commandInput('sdd-panel'))
  expect(panes.find('sdd-panel')?.isShown).toBe(true)
  await $.command.run(commandInput('sdd-panel'))
  expect(panes.find('sdd-panel')).toBe(undefined)
  // La persona cerró la lista con Escape: el motor ya no la lista y el comando la vuelve a abrir.
  panes.personClose('sdd-runs')
  await $.command.run(commandInput('sdd-runs'))
  expect(panes.find('sdd-runs')?.isShown).toBe(true)
  expect(forbidden).toEqual([])
  expect(turns).toEqual(['panel-active-turn'])
  expect(world.violations()).toEqual([])
  await ui.unmount()
})

test('panel commands use an existing pane after adoption and stop after an unplaced open', async ($, on) => {
  const world = new World('panel-adoption-session')
  world.install(on)
  const clock = mock.clock(on, { now: T0 + 1000 })
  let unplaced = false
  const panes = paneRegistry(on, { unplaced: () => unplaced })
  const effects = panes.effects
  panes.preopen('sdd-panel', 'pane de una carga anterior')
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  effects.length = 0
  expect(await $.command.run(commandInput('sdd-panel'))).toEqual({})
  expect(effects).toEqual(['close:sdd-panel'])
  unplaced = true
  effects.length = 0
  expect(await $.command.run(commandInput('sdd-runs'))).toEqual({})
  expect(effects).toEqual(['open:sdd-runs'])
  expect(panes.find('sdd-runs')?.isPlaced).toBe(false)
  // Sin lugar, el comando no reintenta ni cierra: el pane queda registrado sin mostrar.
  effects.length = 0
  await clock.settle()
  expect(effects).toEqual([])
})
