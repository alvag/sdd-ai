import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { boundProjection, collectProjection, publishProjection } from '../src/projection.ts'
import { PROJECTION_MAX_BYTES, known, unknown, validateProjection } from '../src/projection-types.ts'
import type { Projection } from '../src/projection-types.ts'
import { readFlow } from '../src/sdd/read.ts'
import { TEST_BOOT, fixtureJson, latestProjection, observation, projectionDocument, projectionFixture, projectionFlow, projectionRun } from './projection-fixture.ts'
import { cmd, final, verifyFlow } from './sdd-verify-fixture.ts'

function rejects(document: unknown, field: string): void {
  const result = validateProjection(document)
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.reason.includes(field), result.reason)
}

test('projection preserves checkout ownership openness and detailed flow facts without worker content', async () => {
  const f = projectionFixture()
  try {
    const a = f.worktree('a'); const b = f.worktree('b')
    f.flow('alpha', 'planned', a); f.flow('beta', 'done', b)
    f.binding('session-a', 'alpha', a); f.binding('session-b', 'beta', b)
    f.run('anonymous', {}, 'running', a)
    const worker = f.run('worker', { session: 'session-a', flow: 'alpha', prompt: 'PRIVATE INPUT' }, 'running', a)
    writeFileSync(join(worker, 'stdout.log'), 'PRIVATE OUTPUT')
    writeFileSync(join(worker, 'transcript.jsonl'), 'PRIVATE TRANSCRIPT')
    f.run('other', { session: 'session-b', flow: 'beta' }, 'running', b)
    const writer = f.writer('writer', 'cessation_uncertain', 'session-a', 'alpha', a)
    rmSync(writer.run, { recursive: true })
    let document = collectProjection(a, observation())
    assert.equal(validateProjection(document).ok, true)
    assert.equal(document.writer.item?.state.value, 'cessation_uncertain')
    assert.equal(document.writer.item?.live.value, true)
    assert.equal(document.runs.items.find((r) => r.id === 'anonymous')?.session.value, null)
    assert.equal(document.runs.items.find((r) => r.id === 'anonymous')?.flow.value, null)
    assert.equal(document.runs.items.some((r) => r.id === 'other'), false)
    assert.equal(document.bindings.items[0].flow.value?.id, 'alpha')
    const other = collectProjection(b, observation())
    assert.notEqual(document.checkout.id, other.checkout.id)
    assert.deepEqual(other.runs.items.map((r) => r.id), ['other'])
    assert.equal(other.flows.items[0].status.value, 'done')
    assert.equal(JSON.stringify(document).includes('PRIVATE'), false)
    const normalWriter = f.writer('normal-writer', 'running', 'session-b', 'beta', b)
    assert.equal(collectProjection(b, observation()).writer.item?.state.value, 'running')
    rmSync(normalWriter.run, { recursive: true })
    assert.equal(collectProjection(b, observation()).writer.item?.id, 'normal-writer')
    const closed = f.run('closed', { session: 'unbound-session' }, 'done', a)
    fixtureJson(join(closed, 'delivered.json'), { round: null, launch: null })
    assert.equal(collectProjection(a, observation()).bindings.items.find((binding) => binding.id === 'unbound-session')?.flow.reason?.code, 'unbound')
    writeFileSync(join(a, '.sdd-ai', 'hooks', 'route', 'broken-session.json'), '{')
    assert.equal(collectProjection(a, observation()).bindings.availability, 'partial')
    rmSync(join(a, '.sdd-ai', 'hooks', 'route', 'broken-session.json'))

    // El registro protegido prevalece sobre una corrida visible alterada.
    fixtureJson(join(writer.run, 'request.json'), { session: 'impostor', flow: 'beta' })
    writeFileSync(join(writer.run, 'status.json'), 'corrupt')
    writeFileSync(join(writer.run, 'delivered.json'), 'corrupt')
    document = collectProjection(a, observation())
    assert.equal(document.writer.item?.session.value, 'session-a')
    assert.equal(document.writer.item?.state.value, 'cessation_uncertain')

    fixtureJson(join(worker, 'status.json'), { state: 'done' })
    assert.equal(collectProjection(a, observation()).runs.items.find((r) => r.id === 'worker')?.open.value, 'undelivered')
    fixtureJson(join(worker, 'delivered.json'), { round: null, launch: null })
    assert.equal(collectProjection(a, observation()).runs.items.some((r) => r.id === 'worker'), false)
    const native = f.run('native', { session: 'session-a' }, 'delegated', a)
    fixtureJson(join(native, 'native.json'), { agent: 'sdd-ai-explore', family: 'claude', role: 'explore' })
    assert.equal(collectProjection(a, observation()).runs.items.find((r) => r.id === 'native')?.open.value, 'native_pending')
    fixtureJson(join(native, 'launch.json'), { tool_use_id: 'dispatch' })
    assert.equal(collectProjection(a, observation()).runs.items.find((r) => r.id === 'native')?.open.value, 'native_unconfirmed')
    fixtureJson(join(native, 'launched.json'), { tool_use_id: 'dispatch' })
    assert.equal(collectProjection(a, observation()).runs.items.some((r) => r.id === 'native'), false)
    const review = f.run('review', { session: 'session-a', kind: 'review' }, 'done', a)
    fixtureJson(join(review, 'delivered.json'), { round: null, launch: null })
    fixtureJson(join(review, 'ledger.json'), { completed: 1, next_id: 2, entries: [{ id: 'F1', state: 'abierto' }] })
    assert.equal(collectProjection(a, observation()).runs.items.find((r) => r.id === 'review')?.open.value, 'review_pending')
    fixtureJson(join(review, 'ledger.json'), { completed: 1, next_id: 2, entries: [{ id: 'F1', state: 'resuelto' }] })
    assert.equal(collectProjection(a, observation()).runs.items.some((r) => r.id === 'review'), false)

    fixtureJson(join(a, '.plans', 'alpha', 'sdd-ai-phases.json'), {
      schema_version: 1, last_run: { id: 'anonymous', step: 'plan' }, phases: {}, reviews: ['review'],
    })
    assert.equal(collectProjection(a, observation()).runs.items.find((r) => r.id === 'anonymous')?.flow.value, 'alpha')
    f.flow('conflict', 'planned', a)
    fixtureJson(join(a, '.plans', 'conflict', 'sdd-ai-phases.json'), {
      schema_version: 1, last_run: { id: 'anonymous', step: 'plan' }, phases: {},
    })
    const conflict = collectProjection(a, observation()).runs.items.find((r) => r.id === 'anonymous')!
    assert.equal(conflict.flow.value, null)
    assert.equal(conflict.flow.reason?.code, 'association_conflict')
    writeFileSync(join(a, '.sdd-ai', 'runs', 'anonymous', 'status.json'), '{')
    document = collectProjection(a, observation())
    assert.equal(document.runs.availability, 'partial')
    assert.equal(document.writer.item?.state.value, 'cessation_uncertain')
    assert.equal(validateProjection(document).ok, true)
    assert.equal(collectProjection(f.root, observation()).flows.availability, 'available')
    assert.deepEqual(collectProjection(f.root, observation()).flows.items, [])
    mkdirSync(join(f.root, '.plans'))
    symlinkSync(join(a, '.plans', 'alpha'), join(f.root, '.plans', 'broken'))
    assert.equal(collectProjection(f.root, observation()).flows.items[0].availability, 'unavailable')
    rmSync(join(f.root, '.plans'), { recursive: true })
    writeFileSync(join(f.root, '.plans'), 'not a directory')
    assert.equal(collectProjection(f.root, observation()).flows.availability, 'unavailable')

    const compare = async (root: string, id: string) => {
      const projected = collectProjection(root, observation()).flows.items.find((flow) => flow.id === id)!
      const result = await main(['sdd', 'status', id], {}, root)
      assert.equal(result.code, 0)
      assert.deepEqual(projected.view.value, result.out)
      assert.equal(projected.observed_at, observation().observed_at)
      return projected.view.value!
    }
    const dir = join(a, '.plans', 'alpha')
    assert.equal((await compare(a, 'alpha')).next.step, 'gate')
    const facts = readFlow(a, 'alpha').facts
    fixtureJson(join(dir, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [{
      gate: 'spec', depth: 'completa', fingerprint: facts.fingerprints.spec, previous: {}, at: '2026-10-05T00:00:00Z',
    }] })
    writeFileSync(join(dir, 'spec.md'), readFileSync(join(dir, 'spec.md'), 'utf8') + '\nNuevo criterio.\n')
    assert.equal((await compare(a, 'alpha')).gates[0].state, 'stale')
    rmSync(join(dir, 'sdd-ai-approvals.json'))
    rmSync(join(dir, 'plan.md'))
    writeFileSync(join(dir, 'handoff.md'), '---\nprofundidad: completa\nbranch: feature/fixture\nspec_approved_at: 2026-10-05T00:00:00Z\n---\n')
    fixtureJson(join(dir, 'sdd-ai-phases.json'), { schema_version: 1, last_run: null,
      phases: { plan: { awaiting: { run: 'anonymous', blocking_questions: [], missing_context: ['context'] } } } })
    assert.match((await compare(a, 'alpha')).next.command ?? '', /--context/)
    f.flow('ready', 'implementing', b)
    assert.equal((await compare(b, 'ready')).tasks.pending, 1)
    writeFileSync(join(b, '.plans', 'ready', 'tasks.md'), '# Tasks\n\n- [x] **T1 — tarea** · cubre: AC-1\n')
    assert.equal((await compare(b, 'ready')).next.step, 'verify')
    mkdirSync(join(b, '.plans', 'archived'))
    renameSync(join(b, '.plans', 'beta'), join(b, '.plans', 'archived', 'beta'))
    assert.equal(collectProjection(b, observation()).flows.items.some((flow) => flow.id === 'beta'), false)

    const verified = verifyFlow({ implement: false, rows: [cmd('V1', [process.execPath, '-e',
      "process.exit(require('node:fs').readFileSync('src/a.ts', 'utf8').includes('=> 2') ? 0 : 1)"], { acs: ['AC-1', 'AC-2'] })] })
    try {
      assert.equal((await compare(verified.repo, 'f')).next.step, 'verify')
      assert.equal((await final(verified.repo)).receipt.green, false)
      assert.equal((await compare(verified.repo, 'f')).next.step, 'verify')
      writeFileSync(join(verified.repo, 'src', 'a.ts'), 'export const f = () => 2\n')
      assert.equal((await final(verified.repo)).receipt.green, true)
      assert.equal((await compare(verified.repo, 'f')).next.step, 'review_and_commit')
      writeFileSync(join(verified.repo, 'src', 'a.ts'), 'export const f = () => 3\n')
      assert.equal((await compare(verified.repo, 'f')).next.step, 'verify')
    } finally { rmSync(verified.repo, { recursive: true, force: true }) }
  } finally { f.dispose() }
})

test('projection bounds utf8 bytes and declares ordered omissions or mandatory inventory unavailability', () => {
  const f = projectionFixture()
  try {
    const document = projectionDocument(f.root)
    const large = '界'.repeat(400_000)
    const flow = (id: string, status: string) => {
      const item = projectionFlow(id, { status: known(status) })
      item.view.value!.next.detail = large
      return item
    }
    document.flows.items = [flow('z-done', 'done'), flow('linked', 'done'), flow('a-done', 'done'), flow('active', 'planned'), flow('optional', 'planned')]
    document.runs.items = [projectionRun('running', { flow: known('active') })]
    document.writer.item = { id: 'running', availability: 'available', reason: null, state: known('running'),
      open: known('running'), session: known('session'), flow: known('active'), live: known(true) }
    document.bindings.items = [{ id: 'session', availability: 'available', reason: null,
      flow: known({ id: 'linked', step: 'implement', gate: null, at: '2026-10-05T00:00:00Z' }) }]
    const before = JSON.stringify(document)
    const bounded = boundProjection(document)
    assert.equal(JSON.stringify(document), before)
    assert.ok(Buffer.byteLength(JSON.stringify(bounded) + '\n', 'utf8') < PROJECTION_MAX_BYTES)
    assert.deepEqual(bounded.flows.items.map((item) => item.id), ['linked', 'active', 'optional'])
    assert.deepEqual(bounded.runs, document.runs)
    assert.deepEqual(bounded.writer, document.writer)
    assert.equal(bounded.omissions.find((o) => o.reason.code === 'size_done_flows')?.count, 2)
    assert.equal(validateProjection(bounded).ok, true)
    document.flows.items.push(flow('extra', 'planned'))
    const second = boundProjection(document)
    assert.equal(second.omissions[0].reason.code, 'size_done_flows')
    assert.equal(second.omissions[1].reason.code, 'size_unassociated_flows')
    assert.deepEqual(second.flows.items.map((item) => item.id), ['linked', 'active', 'optional'])
    document.runs.items[0].id = 'r'.repeat(PROJECTION_MAX_BYTES)
    const unavailable = boundProjection(document)
    assert.equal(unavailable.runs.availability, 'unavailable')
    assert.equal(unavailable.writer.availability, 'unavailable')
    assert.equal(unavailable.flows.availability, 'unavailable')
    assert.equal(unavailable.omissions.find((o) => o.collection === 'runs')?.count, 1)
    assert.equal(unavailable.omissions.find((o) => o.collection === 'writer')?.count, 1)
    assert.ok(Buffer.byteLength(JSON.stringify(unavailable) + '\n', 'utf8') < PROJECTION_MAX_BYTES)
    assert.equal(validateProjection(unavailable).ok, true)
    assert.equal(publishProjection(f.root, projectionDocument, { boot: () => TEST_BOOT }).kind, 'published')
    const published = publishProjection(f.root, (_root, stamp) => ({ ...document, observation: stamp }), { boot: () => TEST_BOOT })
    assert.equal(published.kind, 'published')
    assert.equal(latestProjection(f.root)?.runs.reason?.code, 'size_unavailable')
  } finally { f.dispose() }
})

test('a source replaced by a FIFO or a link leaves only its entity unavailable without blocking the observation', () => {
  const f = projectionFixture()
  try {
    f.run('valid', { session: 's' })
    // Un FIFO sin escritor en lugar de `status.json`: abrirlo para leer bloquearía si no se abriera sin esperar.
    const fifo = f.run('fifo', { session: 's' })
    rmSync(join(fifo, 'status.json'))
    execFileSync('mkfifo', [join(fifo, 'status.json')])
    // Un enlace a un estado legible fuera de la corrida tampoco se sigue.
    const linked = f.run('linked', { session: 's' })
    const outside = join(f.scratch, 'status.json')
    fixtureJson(outside, { state: 'running' })
    rmSync(join(linked, 'status.json'))
    symlinkSync(outside, join(linked, 'status.json'))
    const document = collectProjection(f.root, observation())
    assert.equal(validateProjection(document).ok, true)
    assert.equal(document.runs.availability, 'partial')
    assert.deepEqual(document.runs.items.map((run) => [run.id, run.availability, run.state.value]),
      [['fifo', 'unavailable', null], ['linked', 'unavailable', null], ['valid', 'available', 'running']])
  } finally { f.dispose() }
})

test('size degradation omits the fewest optional flows in order and serializes each flow a bounded number of times', () => {
  const document = projectionDocument('/fixture/checkout')
  const serialized = new Map<string, number>()
  const detail = 'x'.repeat(20_000)
  document.flows.items = Array.from({ length: 300 }, (_, i) => {
    const id = `flow-${String(299 - i).padStart(3, '0')}`
    const item = projectionFlow(id, { status: known(i % 5 === 0 ? 'done' : 'planned') })
    item.view.value!.next.detail = detail
    // Cuenta cada vez que se serializa el flujo, sin cambiar lo que se serializa.
    Object.defineProperty(item, 'toJSON', { value() { serialized.set(id, (serialized.get(id) ?? 0) + 1); return { ...this } } })
    return item
  })
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) + '\n', 'utf8')
  const bounded = boundProjection(document)
  assert.ok(size(bounded) < PROJECTION_MAX_BYTES)
  assert.equal(validateProjection(JSON.parse(JSON.stringify(bounded))).ok, true)
  // Primero los done y después los demás, cada grupo por id; lo omitido es un prefijo de ese orden.
  const group = (done: boolean) => document.flows.items.filter((flow) => (flow.status.value === 'done') === done).map((flow) => flow.id).sort()
  const order = [...group(true), ...group(false)]
  const kept = new Set(bounded.flows.items.map((flow) => flow.id))
  const omitted = order.filter((id) => !kept.has(id))
  assert.deepEqual(omitted, order.slice(0, omitted.length))
  assert.deepEqual(bounded.flows.items.map((flow) => flow.id), document.flows.items.map((flow) => flow.id).filter((id) => kept.has(id)))
  assert.deepEqual(bounded.omissions.map((o) => [o.reason.code, o.count]), [['size_done_flows', 60], ['size_unassociated_flows', omitted.length - 60]])
  // Se omite lo mínimo: con el último omitido de vuelta, no entraría.
  const last = omitted.at(-1)!
  const oneLess = { ...bounded, flows: { ...bounded.flows, items: document.flows.items.filter((flow) => kept.has(flow.id) || flow.id === last) },
    omissions: bounded.omissions.map((o) => (o.reason.code === 'size_unassociated_flows' ? { ...o, count: o.count - 1 } : o)) }
  assert.ok(size(oneLess) >= PROJECTION_MAX_BYTES)
  // Cada flujo se mide una vez, además de la comprobación inicial y la final: el trabajo no crece con lo omitido.
  serialized.clear()
  boundProjection(document)
  assert.ok(Math.max(...serialized.values()) <= 3, JSON.stringify(Math.max(...serialized.values())))
})

test('projection contract validates entities unknown facts and unavailable collections independently of domain files', () => {
  const f = projectionFixture()
  try {
    const document = projectionDocument(f.root)
    document.runs.items = [projectionRun('worker'), projectionRun('review', { kind: known('review'), session: known('session-a'), flow: known('flow-a'),
      progress: known({ phase: 'review', round: 1, launch: 2, planned: ['risk:1'],
        retained: [{ round: 1, key: 'base:1', launch: 1, state: 'done', admission: known('admitted') }], completed: [], total: 2,
        active: known({ key: 'risk:1', reviewer: known('risk'), batch: known(1) }) }) })]
    document.flows.items = [projectionFlow('flow-a'), projectionFlow('finished', { status: known('done') })]
    document.bindings.items = [{ id: 'session-a', availability: 'available', reason: null,
      flow: known({ id: 'flow-a', step: 'implement', gate: null, at: '2026-10-05T00:00:00Z' }) },
    { id: 'session-b', availability: 'available', reason: null, flow: unknown('unbound', 'La sesión no tiene liga.') }]
    document.writer.item = { id: 'writer', availability: 'available', reason: null, state: known('cessation_uncertain'), open: known('undelivered'),
      session: known('session-a'), flow: known('flow-a'), live: known(true) }
    const result = validateProjection(JSON.parse(JSON.stringify(document)))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.document.runs.items[0].session.value, null)
      assert.equal(result.document.runs.items[1].progress.value?.total, 2)
      assert.equal(result.document.writer.item?.state.value, 'cessation_uncertain')
      assert.equal(result.document.flows.items[1].status.value, 'done')
      assert.equal(result.document.bindings.items[0].flow.value?.id, 'flow-a')
    }
    assert.equal(JSON.stringify(document).includes('prompt'), false)
    assert.equal(JSON.stringify(document).includes('transcript'), false)
    assert.equal(JSON.stringify(document).includes('stdout'), false)
    const empty = projectionDocument(f.root)
    assert.equal(validateProjection(empty).ok, true)
    empty.flows = { availability: 'unavailable', reason: { code: 'unreadable', detail: 'No se pudo leer el catálogo.' }, items: [] }
    assert.equal(validateProjection(empty).ok, true)
    assert.notDeepEqual(document.flows, empty.flows)
    empty.flows.reason = null
    rejects(empty, 'flows.reason')
  } finally { f.dispose() }
})

test('projection contract rejects unsupported versions missing fields and worker contents', () => {
  const document = projectionDocument('/fixture/checkout')
  rejects({ ...document, schema_version: 2 }, 'schema_version')
  const { bindings: _bindings, ...missing } = document
  rejects(missing, 'bindings')
  rejects({ ...document, prompt: 'private' }, 'prompt')
  const run = projectionRun('r')
  rejects({ ...document, runs: { ...document.runs, items: [{ ...run, stdout: 'private' }] } }, 'stdout')
  rejects({ ...document, runs: { ...document.runs, items: [{ ...run, session: { value: null, reason: null } }] } }, 'session')
  rejects({ ...document, runs: { ...document.runs, items: [{ ...run, session: { value: 's', reason: { code: 'unknown', detail: 'Desconocido.' } } }] } }, 'session')
  rejects({ ...document, runs: { ...document.runs, items: [run, run] } }, 'items')
  rejects({ ...document, checkout: { ...document.checkout, root: 'relative' } }, 'root')
  rejects({ ...document, observation: { ...document.observation, m0: '1' } }, 'm0')
  rejects({ ...document, observation: { ...document.observation, boot: 'bad' } }, 'boot')
  rejects({ ...document, observation: { ...document.observation, publisher: { pid: process.pid + 1, kind: 'unknown' } } }, 'observation.id')
})

test('projection contract preserves valid entities alongside unavailable entities without inventing facts', () => {
  const document = projectionDocument('/fixture/checkout')
  const corrupt = projectionRun('corrupt', { availability: 'unavailable', reason: { code: 'unreadable', detail: 'Estado ilegible.' },
    kind: unknown('unreadable', 'Clase desconocida.'), state: unknown('unreadable', 'Estado desconocido.'),
    open: unknown('unreadable', 'Apertura desconocida.'), live: unknown('unreadable', 'Actividad desconocida.') })
  document.runs = { availability: 'partial', reason: { code: 'unreadable_entity', detail: 'Una corrida no se pudo leer.' }, items: [projectionRun('valid'), corrupt] }
  assert.equal(validateProjection(document).ok, true)
  document.runs.availability = 'unavailable'
  rejects(document, 'runs.items')
  document.runs.availability = 'available'; document.runs.reason = null
  rejects(document, 'runs')
})

test('projection contract validates logical job identity counts admissions and flow view facts', () => {
  const document: Projection = projectionDocument('/fixture/checkout')
  const progress = { phase: 'review' as const, round: 1, launch: 2, planned: ['risk:1'],
    retained: [{ round: 1, key: 'base:1', launch: 1, state: 'done' as const, admission: known('admitted' as const) }],
    completed: [{ round: 1, key: 'risk:1', launch: 2, state: 'failed' as const, admission: unknown<'admitted' | 'inadmissible'>('not_admitted', 'El trabajo falló.') }],
    total: 2, active: unknown<{ key: string; reviewer: ReturnType<typeof known<string>>; batch: ReturnType<typeof known<number>> }>('inactive', 'No hay trabajo activo.') }
  document.runs.items = [projectionRun('review', { kind: known('review'), progress: known(progress) })]
  assert.equal(validateProjection(document).ok, true)
  progress.total = 3
  rejects(document, 'total')
  progress.total = 2; progress.completed[0].round = 2
  rejects(document, 'identidad')
  document.runs.items = []
  document.flows.items = [projectionFlow('f')]
  document.flows.items[0].view = known({ ...projectionFlow('other').view.value!, id: 'other' })
  rejects(document, 'view.id')
  document.flows.items = [projectionFlow('f')]
  document.flows.items[0].view.value!.tasks.pending = 2
  rejects(document, 'tasks')
  document.flows.items = []
  document.observation = { ...observation(), read_finished_at: 1 }
  assert.equal(validateProjection(document).ok, true, 'el reloj de pared puede retroceder durante la observación')
})
