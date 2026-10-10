import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { actorFlow, writer, implementationReport, launch, harvest, runBin, tasksPath, controlOf, legacyFlow, oldReport, documentFlow, documentContract, superviseDocument, approveFlowGates } from './task-actors-fixture.ts'

test('conserva tasks y corridas heredadas sin migrar y mantiene pendientes inline', () => {
  const s = actorFlow([{ id: 'T1', done: true }, { id: 'T2' }, { id: 'T3' }], [writer(implementationReport(['T2'], ['T3']))])
  const before = readFileSync(tasksPath(s), 'utf8')
  const approvals = readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.json'), 'utf8')
  const status = runBin(s, ['sdd', 'status', 'f'])
  assert.deepEqual([status.out.tasks.total, status.out.tasks.done, status.out.tasks.pending], [3, 1, 2])
  // Un documento sin actores conserva la salida de status anterior: sin los campos de responsabilidades.
  assert.equal('pending_assignments' in status.out.tasks, false)
  assert.equal('inline_pending' in status.out.tasks, false)
  const first = launch(s)
  assert.equal(first.code, 0, JSON.stringify(first.out))
  assert.deepEqual(controlOf(s, first.out.id).phase.pending, ['T2', 'T3'])
  harvest(s, first.out.id)
  assert.equal(readFileSync(tasksPath(s), 'utf8'), before)
  assert.equal(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.json'), 'utf8'), approvals)
  const record = join(s.repo, '.plans', 'f', 'sdd-ai-phases.json')
  const registryBefore = readFileSync(record, 'utf8')
  runBin(s, ['sdd', 'status', 'f'])
  assert.equal(readFileSync(record, 'utf8'), registryBefore)

  const old = legacyFlow(1, writer(oldReport(['T1'])))
  const c = controlOf(old.s, old.run)
  const oldTasks = readFileSync(tasksPath(old.s), 'utf8')
  assert.equal(c.phase.kind, undefined)
  const received = harvest(old.s, old.run)
  assert.deepEqual(received.out.contract, { admitted: true, missing_context: [] })
  assert.equal(readFileSync(tasksPath(old.s), 'utf8'), oldTasks)
  assert.deepEqual(controlOf(old.s, old.run), c)

  const doc = documentFlow([JSON.stringify(documentContract({ actors: false }))])
  const publication = superviseDocument(doc, { legacyContract: true })
  assert.equal(publication.result.outcome, 'published')
  assert.equal('task_actors' in publication.launch, false)
  const artifact = readFileSync(tasksPath(doc), 'utf8')
  runBin(doc, ['sdd', 'status', 'f'])
  assert.equal(readFileSync(tasksPath(doc), 'utf8'), artifact)
  assert.doesNotMatch(artifact, /actor:/)

  const inline = actorFlow([{ id: 'T1' }])
  writeFileSync(tasksPath(inline), '- [ ] texto sin identificador\n- [x] terminada\n')
  approveFlowGates(inline.repo)
  const original = readFileSync(tasksPath(inline), 'utf8')
  const st = runBin(inline, ['sdd', 'status', 'f'])
  assert.deepEqual([st.out.tasks.total, st.out.tasks.done, st.out.tasks.pending], [2, 1, 1])
  assert.equal(launch(inline).out.code, 'phase_inline')
  assert.equal(readFileSync(tasksPath(inline), 'utf8'), original)
})
