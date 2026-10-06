import { expect, mock, test } from 'claude-code/testing'
import { stateRecorder } from './fixtures/presentation-engine'
import type { Attribution, PersistedCache } from '../types'
import { parseOutput } from '../hooks/output'
import { eligiblePersisted, lexicalPersistedPath, MAX_PERSISTED_BYTES, persistedContentFits, physicalPersistedPath, projectsRoot } from '../hooks/persisted-output'
import { completeOutput, PERSISTED, physicalStat, PROJECTS, savedResponse, PersistedWorld } from './fixtures/persisted-world'
import { REAL_ROOT, SESSION_ROOT, T0 } from './fixtures/band-world'
import { textCost } from '../hooks/render'

test('persisted paths require the exact lexical shape and physical containment without rejecting a linked root', () => {
  expect(projectsRoot(undefined, '/home/max')).toBe(PROJECTS)
  expect(projectsRoot('/config', '/home/max')).toBe('/config/projects')
  expect(projectsRoot('relative', '/home/max')).toBeNull()
  expect(projectsRoot(undefined, undefined)).toBeNull()
  expect(lexicalPersistedPath(PERSISTED)).toBe(true)
  expect(lexicalPersistedPath('/alias/projects/checkout/session/tool-results/result.txt')).toBe(true)
  for (const path of ['relative/projects/p/s/tool-results/f', '/outside/result.txt', `${PROJECTS}/p/../s/tool-results/f`, `${PROJECTS}/p/s/tool-results/`, `${PROJECTS}//s/tool-results/f`]) expect(lexicalPersistedPath(path)).toBe(false)
  const root = physicalStat('/physical/storage', 'dir')
  const file = physicalStat('/physical/storage/checkout/session/tool-results/result.txt')
  expect(physicalPersistedPath({ ...root, isLink: true }, file)).toBe(true)
  expect(physicalPersistedPath(root, { ...file, isLink: true })).toBe(true)
  for (const realPath of ['/outside/file', '/physical/storage-other/p/s/tool-results/f', '/physical/storage/p/s/f', '/physical/storage/p/s/tool-results/sub/f']) expect(physicalPersistedPath(root, physicalStat(realPath))).toBe(false)
  expect(physicalPersistedPath(root, { ...file, size: MAX_PERSISTED_BYTES + 1 })).toBe(false)
  expect(physicalPersistedPath(root, { ...file, kind: 'dir' })).toBe(false)
  expect(physicalPersistedPath({ ...root, kind: 'file' }, file)).toBe(false)
  expect(physicalPersistedPath(root, { ...file, realPath: undefined })).toBe(false)
  expect(persistedContentFits('x'.repeat(MAX_PERSISTED_BYTES))).toBe(true)
  expect(persistedContentFits('é'.repeat(MAX_PERSISTED_BYTES / 2 + 1))).toBe(false)
})

test('persisted eligibility excludes historical denied interrupted and background calls', () => {
  const response = savedResponse()
  expect(eligiblePersisted(response, true)).toEqual({ path: PERSISTED, output: response.result, isErrored: false })
  expect(eligiblePersisted(response, false)).toBeNull()
  expect(eligiblePersisted({ deny: 'No permitido' }, true)).toBeNull()
  for (const fields of [{ interrupted: true }, { isRunning: true }, { backgroundTaskId: 'bg' }, { backgroundedByUser: true }, { backgroundedByTurnAbort: true }, { backgroundedToDeliverMessage: true }, { timedOutAfterMs: 1000 }]) expect(eligiblePersisted({ ...response, result: { ...response.result, ...fields } }, true)).toBeNull()
})

test('complete persisted content uses the inline parser and never reconstructs mixed stderr', () => {
  const source = completeOutput(40)
  const text = JSON.stringify(source)
  const inline = parseOutput(text, false)
  const saved = parseOutput(savedResponse().result, false, text)
  expect(inline.kind).toBe('summary')
  expect(saved.kind).toBe('summary')
  if (inline.kind !== 'summary' || saved.kind !== 'summary') throw new Error('Salida válida rechazada')
  expect(saved.summary).toEqual(inline.summary)
  expect(saved.summary.ledger).toEqual(source.ledger)
  expect(parseOutput(savedResponse().result, false).kind).toBe('native')
  for (const content of ['{', `${text}\nwarning`, '{"ledger":[{"id":"invalid"}]}', `prefix\n${text}`]) expect(parseOutput(savedResponse().result, false, content).kind).toBe('native')
  for (const rows of [100, 300, 500]) {
    const large = completeOutput(rows)
    const result = parseOutput(savedResponse().result, false, JSON.stringify(large))
    expect(result.kind).toBe('summary')
    if (result.kind === 'summary') expect(result.summary.ledger).toEqual(large.ledger)
  }
  const domainError = parseOutput(savedResponse().result, false, '{"state":"blocked","code":"gate_pending"}')
  expect(domainError).toMatchObject({ kind: 'summary', summary: { state: 'blocked', code: 'gate_pending' } })
  expect(parseOutput({ ...savedResponse().result, interrupted: true }, true, text).kind).toBe('interrupted')
})

test('persisted reads are scheduled once per attributed call and preserve the complete Bash response', async ($, on) => {
  const persistedState = stateRecorder<PersistedCache>(on, 'persisted')
  const world = new PersistedWorld('persisted-session')
  world.install(on)
  world.entries.set(PROJECTS, { kind: 'dir', realPath: '/physical/projects', isLink: true })
  const source = completeOutput(100)
  world.saved(PERSISTED, JSON.stringify(source), '/physical/projects/checkout/session/tool-results/result.txt')
  const secondPath = `${PROJECTS}/checkout/session/tool-results/second.txt`
  world.saved(secondPath, '{"state":"blocked","code":"gate_pending"}', '/physical/projects/checkout/session/tool-results/second.txt')
  const clock = mock.clock(on, { now: T0 })
  const responses = { first: savedResponse(), second: savedResponse(secondPath) }
  on('tool.call', { tool: 'Bash' }, (_$, e) => responses[e.tool_use_id as keyof typeof responses])
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const id of ['first', 'second'] as const) {
    expect(await $.tool.call({ tool: 'Bash', tool_use_id: id, command: './bin/sdd-ai review status example' })).toEqual(responses[id])
    await clock.settle()
  }
  const cache = persistedState.value()!
  expect(cache.entries.first).toMatchObject({ status: 'summary', identity: { session: world.session, root: REAL_ROOT }, path: PERSISTED, summary: { ledger: source.ledger } })
  expect(cache.entries.second).toMatchObject({ status: 'summary', path: secondPath, summary: { state: 'blocked', code: 'gate_pending' } })
  await clock.advance(3000)
  expect(world.accesses.filter(access => access.op === 'read' && [PERSISTED, secondPath].includes(access.path)).map(access => access.path)).toEqual([PERSISTED, secondPath])
  expect(world.environment).toEqual(['CLAUDE_CONFIG_DIR', 'HOME', 'CLAUDE_CONFIG_DIR', 'HOME'])
})

for (const scenario of ['outside', 'dotdot', 'symlink', 'oversized', 'growth', 'denied', 'missing', 'corrupt', 'mixed', 'ledger', 'background', 'interrupted', 'foreign', 'ambiguous'] as const)
  test(`persisted ${scenario} preserves unavailable presentation and never retries`, async ($, on) => {
    const persistedState = stateRecorder<PersistedCache>(on, 'persisted')
    const world = new PersistedWorld(`persisted-${scenario}`)
    world.install(on)
    world.config = '/configured'
    const root = '/configured/projects'
    world.entries.set(root, { kind: 'dir', realPath: root })
    const path = scenario === 'outside' ? '/outside/file.txt' : scenario === 'dotdot' ? `${root}/p/../s/tool-results/f` : `${root}/p/s/tool-results/f`
    const content = scenario === 'corrupt' ? '{' : scenario === 'mixed' ? '{"state":"done"}\nstderr' : scenario === 'ledger' ? '{"ledger":[{"id":"invalid"}]}' : scenario === 'growth' ? 'x'.repeat(MAX_PERSISTED_BYTES + 1) : '{"state":"done"}'
    if (scenario !== 'missing') world.saved(path, content, scenario === 'symlink' ? '/outside/f' : path, scenario === 'oversized' ? MAX_PERSISTED_BYTES + 1 : 100)
    if (scenario === 'symlink') world.entries.get(path)!.isLink = true
    if (scenario === 'denied') world.unreadable.add(path)
    const response = savedResponse(path)
    if (scenario === 'background') Object.assign(response.result, { backgroundTaskId: 'bg' })
    if (scenario === 'interrupted') response.result.interrupted = true
    on('tool.call', { tool: 'Bash' }, () => response)
    const clock = mock.clock(on, { now: T0 })
    await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(await $.tool.call({ tool: 'Bash', tool_use_id: scenario, command: scenario === 'foreign' ? 'cat file' : scenario === 'ambiguous' ? './bin/sdd-ai review status example; ./bin/sdd-ai review status other' : './bin/sdd-ai review status example' })).toEqual(response)
    await clock.settle()
    await clock.advance(3000)
    const entry = persistedState.value()?.entries[scenario]
    expect(entry?.status).toBe(['background', 'interrupted', 'foreign', 'ambiguous'].includes(scenario) ? undefined : 'unavailable')
    const reads = world.accesses.filter(access => access.op === 'read' && access.path === path)
    expect(reads.length).toBe(['growth', 'denied', 'corrupt', 'mixed', 'ledger'].includes(scenario) ? 1 : 0)
  })

test('persisted summaries redraw both sites preserve the original and share a bounded group budget', async ($, on) => {
  const world = new PersistedWorld('persisted-render-session')
  world.install(on)
  world.entries.set(PROJECTS, { kind: 'dir', realPath: PROJECTS })
  const sources = [completeOutput(500), completeOutput(450)]
  const paths = [PERSISTED, `${PROJECTS}/checkout/session/tool-results/another.txt`]
  const responses = sources.map((source, i) => {
    const content = JSON.stringify(source)
    world.saved(paths[i]!, content)
    return savedResponse(paths[i], content.length)
  })
  const originals: unknown[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    const response = responses[Number(e.tool_use_id)]
    if (!response) throw new Error(`Respuesta de prueba ausente: ${e.tool_use_id}`)
    return response
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    originals.push(e.props)
    return $.ui.resolve(e).Text({ children: 'referencia original al archivo' })
  })
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const command = './bin/sdd-ai review status example'
  for (let index = 0; index < 2; index++) {
    expect(await $.tool.call({ tool: 'Bash', tool_use_id: String(index), command })).toEqual(responses[index])
    await clock.settle()
  }
  const props = { tool: 'Bash', tool_use_id: '0', output: responses[0]!.result, isErrored: false }
  const single = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: { columns: 166, rows: 50 }, props })
  expect(await single.find({ type: 'Text', text: 'state: done' })).toBeTruthy()
  expect(await single.find({ type: 'Text', text: 'referencia original al archivo' })).toBeTruthy()
  expect(originals.at(-1)).toEqual(props)
  const calls = responses.map((response, index) => ({ tool: 'Bash', tool_use_id: String(index), input: { command }, output: response.result, isRunning: false, isErrored: false, isInterrupted: false }))
  const group = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: { columns: 166, rows: 50 }, props: { calls, isActive: false, isExpanded: false } })
  expect(textCost(await group.drawn())).toBeLessThanOrEqual(90000)
  const texts = (await group.findAll({ type: 'Text' })).map(item => item.text)
  expect(texts.filter(text => text.startsWith('faltan ') && text.endsWith('el original las contiene')).length).toBe(2)
  expect(texts.filter(text => text === 'state: done').length).toBe(2)
  expect(texts.every(text => text.length <= 8000)).toBe(true)
  for (let redraw = 0; redraw < 3; redraw++) { await single.redraw(); await group.redraw() }
  expect(world.accesses.filter(access => access.op === 'read' && paths.includes(access.path)).map(access => access.path)).toEqual(paths)
  await single.unmount(); await group.unmount()
})

test('historical attribution and summaries are discarded on adoption without a retrospective file read', async ($, on) => {
  const world = new PersistedWorld('persisted-historical-session')
  // Lo que dejó una carga anterior: la atribución de una llamada y su resumen guardado.
  stateRecorder<Attribution>(on, 'attribution', { seedIds: { old: { command: './bin/sdd-ai review status example' } } })
  const persistedState = stateRecorder<PersistedCache>(on, 'persisted', { seed: { load: 'previous-load', entries: { old: {
    identity: { session: world.session, root: REAL_ROOT }, path: PERSISTED, status: 'summary', summary: { extra: [], state: 'historical' }, isErrored: false,
  } } } })
  world.install(on)
  on('ui.render', { component: 'ToolResult' }, ($, e) => $.ui.resolve(e).Text({ children: 'presentación nativa' }))
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(persistedState.value()?.entries).toEqual({})
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', props: { tool: 'Bash', tool_use_id: 'old', output: savedResponse().result, isErrored: false } })
  await ui.redraw()
  expect(world.accesses.filter(access => access.path === PERSISTED)).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'state: historical' })).toBe(undefined)
  await ui.unmount()
})

test('a failed cache write prevents reads and late content cannot become a summary for a new identity', async ($, on) => {
  let fail = true
  stateRecorder<PersistedCache>(on, 'persisted', { deny: () => fail })
  const world = new PersistedWorld('persisted-failed-state')
  world.install(on)
  world.entries.set(PROJECTS, { kind: 'dir', realPath: PROJECTS })
  world.saved(PERSISTED, '{"state":"done"}')
  on('tool.call', { tool: 'Bash' }, () => savedResponse())
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', tool_use_id: 'failed-state', command: './bin/sdd-ai review status example' })
  await clock.settle()
  expect(world.accesses.filter(access => access.op === 'read' && access.path === PERSISTED)).toEqual([])
  fail = false
  // El estado vuelve a estar disponible: el intento fallido no se repite.
  await clock.advance(3000)
  expect(world.accesses.filter(access => access.op === 'read' && access.path === PERSISTED)).toEqual([])
})

test('a persisted read finishing after the session changed is unavailable and never reused', async ($, on) => {
  const persistedState = stateRecorder<PersistedCache>(on, 'persisted')
  const world = new PersistedWorld('persisted-late-session')
  world.install(on)
  world.entries.set(PROJECTS, { kind: 'dir', realPath: PROJECTS })
  world.saved(PERSISTED, '{"state":"done"}')
  let release = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  world.hold = path => path === PERSISTED ? blocked : undefined
  on('tool.call', { tool: 'Bash' }, () => savedResponse())
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: SESSION_ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', tool_use_id: 'late', command: './bin/sdd-ai review status example' })
  await clock.settle()
  expect(persistedState.value()?.entries.late?.status).toBe('pending')
  world.session = 'persisted-new-session'
  world.hold = null; release()
  await clock.settle()
  expect(persistedState.value()?.entries.late?.status).toBe('unavailable')
  expect(world.accesses.filter(access => access.op === 'read' && access.path === PERSISTED).length).toBe(1)
})
