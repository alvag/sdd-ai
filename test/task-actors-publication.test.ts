import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { documentContract, documentFlow, superviseDocument, launch, harvest, tasksPath } from './task-actors-fixture.ts'

test('tasks nuevas exigen actor y corridas anteriores conservan su contrato congelado', () => {
  const s = documentFlow([JSON.stringify(documentContract())])
  const started = launch(s)
  assert.equal(started.code, 0, JSON.stringify(started.out))
  const dir = join(s.repo, '.sdd-ai', 'runs', started.out.id)
  assert.equal(JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8')).task_actors, true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')).phase.task_actors, true)
  assert.equal(harvest(s, started.out.id).out.outcome, 'published')
  const text = readFileSync(tasksPath(s), 'utf8')
  for (const actor of ['writer', 'conductor', 'user']) assert.match(text, new RegExp(`actor: ${actor}`))
  const refused = superviseDocument(documentFlow([JSON.stringify(documentContract({ actors: false })), JSON.stringify(documentContract({ actors: false }))]))
  assert.equal(refused.result.outcome, 'not_admitted')
  const old = documentFlow([JSON.stringify(documentContract({ actors: false }))])
  const before = superviseDocument(old, { legacyContract: true })
  assert.equal(before.result.outcome, 'published')
  assert.equal('task_actors' in before.launch, false)
  assert.equal('task_actors' in before.argv.phase, false)
  assert.doesNotMatch(readFileSync(tasksPath(old), 'utf8'), /actor:/)
})

test('la corrección conserva versión y una ampliación congela contrato nuevo', () => {
  const corrected = superviseDocument(documentFlow([JSON.stringify(documentContract({ actors: false })), JSON.stringify(documentContract())]))
  assert.equal(corrected.result.outcome, 'published')
  assert.equal(corrected.launch.task_actors, true)
  const oldCorrection = superviseDocument(documentFlow(['{}', JSON.stringify(documentContract({ actors: false }))]), { legacyContract: true })
  assert.equal(oldCorrection.result.outcome, 'published')
  assert.equal('task_actors' in oldCorrection.launch, false)
  const s = documentFlow([JSON.stringify(documentContract({ missing: ['Falta una entrada del conductor'] })), JSON.stringify(documentContract())])
  const first = launch(s)
  assert.equal(harvest(s, first.out.id).out.outcome, 'awaiting_context')
  writeFileSync(join(s.repo, 'context.md'), 'Entrada sintética\n')
  const next = launch(s, '--context', 'context.md')
  assert.equal(next.code, 0, JSON.stringify(next.out))
  assert.notEqual(next.out.id, first.out.id)
  assert.equal(JSON.parse(readFileSync(join(s.repo, '.sdd-ai', 'runs', next.out.id, 'inputs.json'), 'utf8')).task_actors, true)
  assert.equal(harvest(s, next.out.id).out.outcome, 'published')
})

test('una recuperación sintética de Codex conserva la versión documental congelada', () => {
  for (const old of [false, true]) {
    const s = documentFlow(['__hang__', JSON.stringify(documentContract({ actors: !old }))])
    const recovered = superviseDocument(s, { legacyContract: old, recover: true })
    assert.equal(recovered.result.outcome, 'published')
    assert.equal(recovered.launch.task_actors, old ? undefined : true)
    assert.equal(recovered.argv.phase.task_actors, old ? undefined : true)
    assert.ok(recovered.metrics.attempts.some((a: { kind: string }) => a.kind === 'resume'), JSON.stringify(recovered.metrics))
  }
})
