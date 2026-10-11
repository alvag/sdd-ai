import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { renderTasks, type TasksContract } from '../src/sdd/phase.ts'
import { calls, cleanup, cli, contracts, corrected, entries, flowFile, json, makeFixture, put, record, refreshReview, revise, runFile, saveRecord, script, settle, snapshotFiles, waitFor } from './phase-revision-fixture.ts'

test('la adopcion heredada exige origen verificable y no transforma corridas vivas', async () => {
  for (const mode of ['valid', 'missing', 'ambiguous', 'wrong-path', 'wrong-source', 'wrong-contract', 'session-unknown']) {
    const s = makeFixture()
    try {
      const r = record(s); delete r.documents; saveRecord(s, r)
      if (mode === 'missing') rmSync(`${s.repo}/.sdd-ai/runs/${s.origin}`, { recursive: true })
      if (mode === 'ambiguous') cpSync(`${s.repo}/.sdd-ai/runs/${s.origin}`, `${s.repo}/.sdd-ai/runs/other-origin`, { recursive: true })
      if (mode === 'wrong-path') put(runFile(s, s.origin, 'phase.json'), { outcome: 'published', artifact: '.plans/f/plan.md' })
      if (mode === 'wrong-source') writeFileSync(runFile(s, s.origin, 'request.md'), 'Otro pedido.\n')
      if (mode === 'wrong-contract') put(runFile(s, s.origin, 'contract.json'), corrected('spec'))
      if (mode === 'session-unknown') {
        const producer = json<{ launch: unknown; session_id?: string }>(runFile(s, s.origin, 'producer.json')); delete producer.session_id
        put(runFile(s, s.origin, 'producer.json'), producer)
      }
      const before = snapshotFiles(s)
      const start = revise(s)
      if (mode === 'valid') {
        assert.equal(start.code, 0, JSON.stringify(start.out)); await settle(s, start.out.id)
        assert.equal(entries(s).at(-1)!.origin_run, s.origin); assert.equal(entries(s).at(-1)!.session_id, s.session)
        assert.equal(calls(s).length, 1)
      } else {
        assert.equal(start.out.code, mode === 'ambiguous' ? 'origin_ambiguous' : mode === 'session-unknown' ? 'session_unrecoverable' : 'origin_missing', JSON.stringify(start.out))
        assert.equal(calls(s).length, 0); assert.deepEqual(snapshotFiles(s), before)
      }
    } finally { await cleanup(s) }
  }
  const legacy = makeFixture({ artifact: 'tasks' })
  try {
    const original = structuredClone(contracts.tasks) as TasksContract
    delete original.tasks[0].actor
    writeFileSync(flowFile(legacy, 'tasks.md'), renderTasks(original))
    put(runFile(legacy, legacy.origin, 'contract.json'), original)
    const argv = json<{ phase: { task_actors?: true } }>(runFile(legacy, legacy.origin, 'argv.json'))
    delete argv.phase.task_actors; put(runFile(legacy, legacy.origin, 'argv.json'), argv)
    const r = record(legacy); delete r.documents; saveRecord(legacy, r)
    refreshReview(legacy)
    const changed = structuredClone(original); changed.tasks[0].title += ' corregido'
    script(legacy, [{ answer: JSON.stringify(changed) }])
    const before = snapshotFiles(legacy)
    const start = revise(legacy); assert.equal(start.code, 0, JSON.stringify(start.out))
    assert.equal((await settle(legacy, start.out.id)).out.outcome, 'published')
    assert.equal(readFileSync(flowFile(legacy, 'tasks.md'), 'utf8'), renderTasks(changed))
    assert.doesNotMatch(readFileSync(flowFile(legacy, 'tasks.md'), 'utf8'), /actor:/)
    assert.equal(json<{ phase: { task_actors?: true } }>(runFile(legacy, start.out.id, 'argv.json')).phase.task_actors, undefined)
    for (const [name, bytes] of Object.entries(before)) if (name !== 'tasks.md') assert.equal(snapshotFiles(legacy)[name], bytes)
    assert.equal(entries(legacy)[0].session_id, legacy.session); assert.equal(calls(legacy).length, 1)
  } finally { await cleanup(legacy) }
  const live = makeFixture({ approved: false })
  const barrier = join(live.work, 'release')
  try {
    for (const name of ['spec.md', 'plan.md', 'tasks.md']) rmSync(flowFile(live, name))
    saveRecord(live, { schema_version: 1, last_run: null, phases: {} })
    script(live, [{ barrier, answer: JSON.stringify(contracts.spec) }])
    const start = cli(live, ['sdd', 'phase', 'f', '--request', 'request.md']); assert.equal(start.code, 0, JSON.stringify(start.out))
    await waitFor(`${barrier}.ready`)
    assert.equal(json<{ phase: { revision?: unknown } }>(runFile(live, start.out.id, 'argv.json')).phase.revision, undefined)
    writeFileSync(barrier, '')
    assert.equal((await settle(live, start.out.id)).out.outcome, 'published')
    assert.equal(record(live).revisions, undefined)
    assert.equal(record(live).documents!.specify!.run, start.out.id)
  } finally { writeFileSync(barrier, ''); await cleanup(live) }
})

test('la ampliacion de creacion con context conserva su significado junto a la devolucion', async () => {
  for (const repeated of [false, true]) {
    const s = makeFixture({ approved: false })
    try {
      for (const name of ['spec.md', 'plan.md', 'tasks.md']) rmSync(flowFile(s, name))
      saveRecord(s, { schema_version: 1, last_run: null, phases: {} })
      const c = structuredClone(contracts.spec); c.blocking_questions = ['¿Qué resultado?']
      script(s, [{ answer: JSON.stringify(c) }])
      const first = cli(s, ['sdd', 'phase', 'f', '--request', 'request.md'])
      assert.equal(first.code, 0, JSON.stringify(first.out)); assert.equal((await settle(s, first.out.id)).out.outcome, 'awaiting_context')
      assert.equal(record(s).phases.specify!.awaiting!.run, first.out.id)
      assert.equal(record(s).revisions, undefined)
      writeFileSync(`${s.repo}/answers.md`, 'Max: el resultado público.\n')
      script(s, [{ answer: JSON.stringify(repeated ? c : contracts.spec) }])
      const second = cli(s, ['sdd', 'phase', 'f', '--context', 'answers.md'])
      assert.equal(second.code, 0, JSON.stringify(second.out))
      assert.equal((await settle(s, second.out.id)).out.outcome, repeated ? 'closed_inline' : 'published')
      const state = record(s).phases.specify!
      assert.equal(state.awaiting, undefined); assert.equal(state.amended!.consumed, true)
      assert.equal(Boolean(state.inline), repeated); assert.equal(record(s).revisions, undefined)
      assert.equal(calls(s).length, 2)
      const prompt = readFileSync(runFile(s, second.out.id, 'prompt.md'), 'utf8')
      assert.ok(prompt.includes('Max: el resultado público.')); assert.match(prompt, /Ampliación/)
      if (repeated) assert.notEqual(cli(s, ['sdd', 'phase', 'f', '--context', 'answers.md']).code, 0)
    } finally { await cleanup(s) }
  }
})
