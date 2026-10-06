import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectProjection } from '../src/projection.ts'
import { validateProjection } from '../src/projection-types.ts'
import { associationFor, collectRunAssociations } from '../src/run-association.ts'
import { notificationFixture } from './notification-fixture.ts'
import { fixtureJson, observation, projectionDocument } from './projection-fixture.ts'

test('projection publishes notification identities without inferring unknown delivery', () => {
  const f = notificationFixture()
  try {
    const request = { session: 'owner', conductor: { family: 'claude' } }
    f.run('worker', request, 'done')
    const review = f.run('review', { ...request, kind: 'review' }, 'failed')
    fixtureJson(join(review, 'status.json'), { state: 'failed', round: 2, launch: 3 })
    f.run('unknown-review', { ...request, kind: 'review' }, 'failed')
    const writer = f.writer('writer', 'done', 'owner')
    fixtureJson(join(writer.store, 'harvest.json'), { state: 'done' })
    fixtureJson(join(writer.run, 'request.json'), { session: 'forged', conductor: { family: 'claude' } })
    const doc = collectProjection(f.root, observation())
    assert.equal(validateProjection(doc).ok, true)
    assert.equal(doc.notifications_version, 1)
    const worker = doc.runs.items.find(r => r.id === 'worker')!
    assert.deepEqual(worker.delivery?.value, { round: null, launch: null })
    assert.equal(worker.session_family?.value, 'claude')
    assert.deepEqual(doc.runs.items.find(r => r.id === 'review')?.delivery?.value, { round: 2, launch: 3 })
    assert.equal(doc.runs.items.find(r => r.id === 'unknown-review')?.delivery?.value, null)
    assert.equal(doc.runs.items.find(r => r.id === 'writer')?.session_family?.value, 'codex')
    assert.equal(doc.runs.items.find(r => r.id === 'writer')?.session.value, 'owner')
    assert.deepEqual(doc.runs.items.find(r => r.id === 'writer')?.delivery?.value, { round: null, launch: null })
    assert.equal(existsSync(join(review, 'delivered.json')), false)
    assert.equal(existsSync(join(writer.store, 'delivered.json')), false)
    fixtureJson(join(review, 'delivered.json'), { round: 2, launch: 3 })
    assert.equal(collectProjection(f.root, observation()).runs.items.some(r => r.id === 'review'), false)
    fixtureJson(join(review, 'status.json'), { state: 'failed', round: 2, launch: 4 })
    assert.deepEqual(collectProjection(f.root, observation()).runs.items.find(r => r.id === 'review')?.delivery?.value, { round: 2, launch: 4 })
    assert.equal(validateProjection(projectionDocument(f.root)).ok, true)
    // Una extensión incompatible no invalida la presentación y no deja pasar sus campos sin validar.
    const incompatible = validateProjection({ ...doc, notifications_version: 99 })
    assert.ok(incompatible.ok)
    if (incompatible.ok) {
      assert.equal(incompatible.document.notifications_version, undefined)
      assert.ok(incompatible.document.runs.items.every(r => r.delivery === undefined && r.session_family === undefined))
    }
    // Tampoco una versión que no es un entero, ni una extensión sin versión con contenido arbitrario.
    assert.equal(validateProjection({ ...doc, notifications_version: 1.5 }).ok, true)
    const unversioned = validateProjection({ ...doc, notifications_version: undefined,
      runs: { ...doc.runs, items: doc.runs.items.map(r => ({ ...r, delivery: { x: 'salida del worker' }, session_family: 42 })) } })
    assert.ok(unversioned.ok)
    if (unversioned.ok) assert.ok(unversioned.document.runs.items.every(r => r.delivery === undefined && r.session_family === undefined))
    worker.delivery = { value: { round: -1, launch: null }, reason: null }
    assert.equal(validateProjection(doc).ok, false)
  } finally { f.dispose() }
})

test('run associations preserve conflicts and uncertainty without touching domain records', () => {
  const f = notificationFixture()
  try {
    f.run('run', { session: 'owner', conductor: { family: 'claude' }, flow: 'alpha' }, 'done')
    assert.deepEqual(associationFor(collectRunAssociations(f.root), 'unbound', { kind: 'absent' }), { kind: 'absent' })
    const alpha = f.flow('alpha')
    const registry = join(alpha, 'sdd-ai-phases.json')
    fixtureJson(registry, { schema_version: 1, last_run: { id: 'run', step: 'plan' }, phases: {}, reviews: [] })
    const before = readFileSync(registry, 'utf8')
    assert.deepEqual(associationFor(collectRunAssociations(f.root), 'run', { kind: 'known', flow: 'alpha' }), { kind: 'known', flow: 'alpha' })
    assert.equal(collectProjection(f.root, observation()).runs.items[0].flow.value, 'alpha')
    const beta = f.flow('beta')
    fixtureJson(join(beta, 'sdd-ai-phases.json'), { schema_version: 1, last_run: { id: 'run', step: 'plan' }, phases: {} })
    assert.deepEqual(associationFor(collectRunAssociations(f.root), 'run', { kind: 'absent' }), { kind: 'conflict', flows: ['alpha', 'beta'] })
    writeFileSync(join(beta, 'sdd-ai-phases.json'), '{')
    assert.equal(associationFor(collectRunAssociations(f.root), 'run', { kind: 'known', flow: 'alpha' }).kind, 'unknown')
    assert.equal(collectProjection(f.root, observation()).runs.items[0].flow.reason?.code, 'association_unavailable')
    assert.equal(readFileSync(registry, 'utf8'), before)
    const writer = f.writer('protected', 'running', 'owner', 'alpha')
    fixtureJson(join(writer.run, 'request.json'), { flow: 'forged', session: 'other' })
    // El inventario incompleto sigue impidiendo afirmar una asociación única.
    assert.equal(collectProjection(f.root, observation()).runs.items.find(r => r.id === 'protected')?.flow.value, null)
    fixtureJson(join(beta, 'sdd-ai-phases.json'), { schema_version: 1, last_run: null, phases: {} })
    assert.equal(collectProjection(f.root, observation()).runs.items.find(r => r.id === 'protected')?.flow.value, 'alpha')
  } finally { f.dispose() }
})

test('association inventory includes every phase reference and implementation chain except takeovers', () => {
  const f = notificationFixture()
  try {
    const dir = f.flow('flow')
    fixtureJson(join(dir, 'sdd-ai-phases.json'), { schema_version: 1, last_run: { id: 'last', step: 'plan' },
      phases: { plan: { awaiting: { run: 'awaiting', blocking_questions: [], missing_context: [] },
        amended: { run: 'amended', consumed: true }, inline: { run: 'inline', at: '2026-10-05T00:00:00Z' } } }, reviews: ['review'],
      implement: { schema: 1, chains: [{ id: 'chain', terminal: null, entries: [
        { kind: 'implement', run: 'writer', parent: null, at: '2026-10-05T00:00:00Z' },
        { kind: 'takeover', id: 'takeover', parent: 'writer', at: '2026-10-05T00:00:00Z', map: { ref: 'map', digest: 'sha256:' + 'a'.repeat(64) } },
      ] }], classifications: [], events: [] } })
    const index = collectRunAssociations(f.root)
    assert.equal(index.complete, true)
    for (const id of ['last', 'awaiting', 'amended', 'inline', 'review', 'writer']) {
      assert.deepEqual(associationFor(index, id, { kind: 'absent' }), { kind: 'known', flow: 'flow' })
    }
    assert.deepEqual(associationFor(index, 'takeover', { kind: 'absent' }), { kind: 'absent' })
  } finally { f.dispose() }
})

test('a request flow that is not a flow leaves the run unrecorded, as before the extraction', () => {
  const f = notificationFixture()
  try {
    for (const [id, flow] of [['null-flow', null], ['empty-flow', ''], ['number-flow', 3]] as const) {
      f.run(id, { session: 'owner', conductor: { family: 'claude' }, flow }, 'done')
    }
    const doc = collectProjection(f.root, observation())
    for (const id of ['null-flow', 'empty-flow', 'number-flow']) {
      assert.equal(doc.runs.items.find(r => r.id === id)?.flow.reason?.code, 'not_recorded')
    }
  } finally { f.dispose() }
})
