import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { gateQuestionFor } from '../src/approval/question.ts'
import { readFlow } from '../src/sdd/read.ts'
import { resolve } from '../src/sdd/status.ts'
import { answer, calls, cleanup, cli, concurrentCli, corrected, entries, flowFile, interrupted, makeFixture, put, record, revise, runFile, saveRecord, script, settle, snapshotFiles, waitFor } from './phase-revision-fixture.ts'

test('la correccion excluye otras escrituras y approve bajo el lock del flujo', async () => {
  const s = makeFixture()
  const barrier = join(s.work, 'release')
  try {
    answer(s, gateQuestionFor('f', 'normal', 'spec', readFlow(s.repo, 'f').facts.fingerprints))
    assert.equal(cli(s, ['sdd', 'approve', 'f', 'spec']).code, 0)
    script(s, [{ barrier, answer: JSON.stringify(corrected('spec')) }])
    const contenders = await Promise.all([concurrentCli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--review', s.review]),
      concurrentCli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--review', s.review])])
    const admitted = contenders.find((r) => r.code === 0)!
    assert.ok(admitted, JSON.stringify(contenders)); assert.equal(contenders.filter((r) => r.code === 0).length, 1)
    assert.equal(contenders.find((r) => r.code !== 0)!.out.code, 'revision_running')
    await waitFor(`${barrier}.ready`)
    assert.equal(calls(s).length, 1)
    const before = snapshotFiles(s)
    for (const args of [
      ['sdd', 'phase', 'f', '--revise', 'spec', '--review', s.review],
      ['sdd', 'phase', 'f', '--request', 'request.md'], ['sdd', 'phase', 'f'],
      ['sdd', 'phase', 'f', '--context', 'context.md'], ['sdd', 'approve', 'f', 'spec'],
      ['sdd', 'approve', 'f', s.depth === 'normal' ? 'plan-tasks' : 'tasks'],
    ]) {
      const rejected = cli(s, args)
      assert.equal(rejected.out.code, 'revision_running', JSON.stringify(rejected.out))
      assert.equal(rejected.out.next, `./bin/sdd-ai wait ${admitted.out.id}`)
    }
    assert.equal(calls(s).length, 1); assert.deepEqual(snapshotFiles(s), before)
    // Selecciones reales de las cuatro fases: la reserva se comprueba antes del despacho.
    for (const step of ['specify', 'plan', 'tasks', 'implement']) {
      try {
        if (step === 'specify') {
          for (const name of ['spec.md', 'plan.md', 'tasks.md']) rmSync(flowFile(s, name))
          writeFileSync(flowFile(s, 'handoff.md'), before['handoff.md'].replace(/spec_approved_at: .*/, 'spec_approved_at: null'))
        } else if (step === 'plan') { rmSync(flowFile(s, 'plan.md')); rmSync(flowFile(s, 'tasks.md')) }
        else if (step === 'tasks') {
          rmSync(flowFile(s, 'tasks.md'))
          writeFileSync(flowFile(s, 'plan.md'), before['plan.md'].replace('status: tasks-ready', 'status: planned'))
        }
        assert.equal(resolve(readFlow(s.repo, 'f').facts).next.step, step)
        const rejected = cli(s, ['sdd', 'phase', 'f', ...(step === 'specify' ? ['--request', 'request.md'] : [])])
        assert.equal(rejected.out.code, 'revision_running'); assert.equal(calls(s).length, 1)
      } finally {
        for (const [name, bytes] of Object.entries(before)) writeFileSync(flowFile(s, name), bytes)
      }
    }
    // La aprobación vigente también necesita exclusión al recuperar y sincronizar su header.
    writeFileSync(flowFile(s, 'handoff.md'), before['handoff.md'].replace(/spec_approved_at: .*/, 'spec_approved_at: null'))
    assert.equal(cli(s, ['sdd', 'approve', 'f', 'spec']).out.code, 'revision_running')
    assert.equal(readFileSync(flowFile(s, 'sdd-ai-approvals.json'), 'utf8'), before['sdd-ai-approvals.json'])
    assert.match(readFileSync(flowFile(s, 'handoff.md'), 'utf8'), /spec_approved_at: null/)
    writeFileSync(flowFile(s, 'handoff.md'), before['handoff.md'])
    assert.equal(record(s).revisions!.active!.run, admitted.out.id)
    writeFileSync(barrier, '')
    await settle(s, admitted.out.id)
    assert.equal(record(s).revisions!.active, undefined)
    assert.equal(record(s).revisions!.intent!.resolved, true)
    assert.notEqual(cli(s, ['sdd', 'phase', 'f']).out.code, 'revision_running')
    const pending = interrupted(s, entries(s).at(-1)!, { current: 'third' })
    const status = cli(s, ['sdd', 'status', 'f']).out
    assert.ok(status.blocked_reasons.some((r: { code: string }) => r.code === 'revision_pending'))
    assert.equal(record(s).revisions!.intent!.resolved, undefined)
    assert.equal(record(s).revisions!.active!.run, pending.run)
    const refused = revise(s)
    assert.equal(refused.out.code, 'review_candidate_changed', JSON.stringify(refused.out))
    assert.equal(entries(s)[0].state, 'conflict')
    assert.equal(record(s).revisions!.intent!.resolved, true)
    assert.equal(record(s).revisions!.active, undefined); assert.equal(calls(s).length, 1)
  } finally { writeFileSync(barrier, ''); await cleanup(s) }
  for (const unreadable of [false, true]) {
    const phase = makeFixture()
    try {
      const r = record(phase); r.last_run = { id: 'document-active', step: 'plan' }; saveRecord(phase, r)
      put(runFile(phase, 'document-active', 'request.json'), { kind: 'phase', flow: 'f', step: 'plan' })
      if (unreadable) writeFileSync(runFile(phase, 'document-active', 'status.json'), '{')
      else put(runFile(phase, 'document-active', 'status.json'), { state: 'running' })
      const before = readFileSync(flowFile(phase, 'spec.md'), 'utf8')
      const rejected = revise(phase)
      assert.equal(rejected.out.code, unreadable ? 'activity_unknown' : 'phase_running', JSON.stringify(rejected.out))
      assert.equal(calls(phase).length, 0); assert.equal(entries(phase).length, 0)
      assert.equal(readFileSync(flowFile(phase, 'spec.md'), 'utf8'), before)
    } finally { await cleanup(phase) }
  }
})
