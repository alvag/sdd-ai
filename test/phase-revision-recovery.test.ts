import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { calls, cleanup, cli, corrected, directedAnswer, entries, flowFile, interrupted, makeFixture, record, revise, saveRecord, script, settle, snapshotFiles, waitFor } from './phase-revision-fixture.ts'

test('las consultas recuperan procedencia y publicacion sin repetir efectos', async (t) => {
  const s = makeFixture()
  try {
    const barrier = join(s.work, 'first-release')
    script(s, [{ barrier, answer: JSON.stringify(corrected('spec')) }])
    const start = revise(s); assert.equal(start.code, 0, JSON.stringify(start.out)); await waitFor(`${barrier}.ready`)
    const before = readFileSync(flowFile(s, 'spec.md'), 'utf8')
    for (let n = 0; n < 2; n++) {
      const running = cli(s, ['wait', start.out.id, '--max', '0']).out
      assert.equal(running.revision.state, 'active'); assert.equal(running.revision.origin_run, s.origin)
      assert.equal(running.revision.session_id, s.session)
      assert.equal(cli(s, ['sdd', 'status', 'f']).out.revisions.at(-1).state, 'active')
    }
    assert.equal(calls(s).length, 1); assert.equal(readFileSync(flowFile(s, 'spec.md'), 'utf8'), before)
    writeFileSync(barrier, ''); await settle(s, start.out.id)
    const template = structuredClone(entries(s).at(-1)!)
    const count = calls(s).length
    const bytes = readFileSync(flowFile(s, 'spec.md'), 'utf8')
    for (let n = 0; n < 2; n++) {
      const view = cli(s, ['wait', start.out.id, '--max', '0']).out
      assert.equal(view.outcome, 'published'); assert.equal(view.revision.origin_run, s.origin)
      assert.equal(view.revision.family, s.family); assert.equal(view.revision.session_mode, 'same')
      assert.deepEqual(view.revision.accepted, ['F-1']); assert.ok(view.revision.materials.length)
      assert.equal(cli(s, ['sdd', 'status', 'f']).out.revisions.at(-1).result.state, 'published')
    }
    assert.equal(calls(s).length, count); assert.equal(readFileSync(flowFile(s, 'spec.md'), 'utf8'), bytes)
    for (const scenario of [
      { current: 'previous' as const, expected: 'not_published' }, { current: 'result' as const, expected: 'published' }, { current: 'third' as const, expected: 'conflict' },
      { current: 'third' as const, terminal: 'published' as const, registry_pending: true as const, expected: 'published' },
      { current: 'previous' as const, terminal: 'cancelled' as const, expected: 'not_published' }, { current: 'third' as const, terminal: 'cancelled' as const, expected: 'conflict' },
    ]) {
      const point = interrupted(s, template, scenario)
      const frozenRegistry = readFileSync(flowFile(s, 'sdd-ai-phases.json'), 'utf8')
      const observed = cli(s, ['sdd', 'status', 'f'])
      assert.equal(readFileSync(flowFile(s, 'sdd-ai-phases.json'), 'utf8'), frozenRegistry)
      assert.ok(observed.out.blocked_reasons.some((r: { code: string }) => r.code === 'revision_pending'))
      const expected = scenario.expected
      const recovered = cli(s, ['wait', point.run, '--max', '0']).out
      assert.equal(recovered.outcome, expected, JSON.stringify(recovered))
      assert.equal(record(s).revisions!.intent!.resolved, true); assert.equal(record(s).revisions!.active, undefined)
      assert.equal(entries(s)[0].result!.state, expected)
      assert.equal(record(s).revisions!.barriers.length, expected === 'not_published' ? 0 : 1)
      const current = point[scenario.current]
      assert.equal(readFileSync(flowFile(s, 'spec.md'), 'utf8'), current)
      if (scenario.terminal && scenario.terminal !== expected) {
        assert.deepEqual(recovered.terminal_superseded, { terminal: scenario.terminal, registered: expected })
        assert.deepEqual(cli(s, ['sdd', 'status', 'f']).out.revisions[0].terminal_superseded, recovered.terminal_superseded)
      }
      const again = cli(s, ['wait', point.run, '--max', '0']).out
      assert.equal(again.outcome, expected); assert.equal(calls(s).length, count)
    }
    // cancel después del rename confirma publicación, aunque el supervisor murió sin terminal.
    const renamed = interrupted(s, template, { current: 'result' })
    assert.equal(cli(s, ['cancel', renamed.run]).out.outcome, 'published')
    assert.equal(entries(s)[0].result!.state, 'published'); assert.equal(record(s).revisions!.barriers.length, 1)
    // Sin intención, un supervisor muerto se orienta a cancel y libera la reserva.
    const orphan = interrupted(s, template, { current: 'previous' })
    const r = record(s); delete r.revisions!.intent; saveRecord(s, r)
    const view = cli(s, ['wait', orphan.run, '--max', '0']).out
    assert.equal(view.state, 'orphan'); assert.equal(view.next, `./bin/sdd-ai cancel ${orphan.run}`)
    cli(s, ['cancel', orphan.run]); assert.equal(entries(s)[0].state, 'cancelled'); assert.equal(record(s).revisions!.active, undefined)
    for (const terminal of ['cancelled', 'not_published'] as const) {
      const point = interrupted(s, template, { current: 'previous', terminal, registry_pending: true })
      const r = record(s); delete r.revisions!.intent; saveRecord(s, r)
      const closed = cli(s, ['wait', point.run, '--max', '0']).out
      assert.equal(closed.outcome, terminal); assert.notEqual(closed.state, 'orphan')
      assert.equal(entries(s)[0].state, terminal); assert.equal(record(s).revisions!.active, undefined)
      assert.equal(record(s).revisions!.barriers.length, 0)
      assert.equal(readFileSync(flowFile(s, 'spec.md'), 'utf8'), point.previous)
      assert.equal(cli(s, ['wait', point.run, '--max', '0']).out.outcome, terminal)
      assert.equal(calls(s).length, count)
    }
    // Los verbos recuperan antes de decidir una aprobación o una escritura nueva.
    interrupted(s, template, { current: 'result' })
    const beforeApprove = snapshotFiles(s); const callsBefore = calls(s).length
    const approved = cli(s, ['sdd', 'approve', 'f', 'spec'])
    assert.equal(approved.out.code, 'approval_missing', JSON.stringify(approved.out))
    assert.deepEqual(snapshotFiles(s), beforeApprove); assert.equal(calls(s).length, callsBefore)
    assert.equal(entries(s)[0].result!.state, 'published'); assert.equal(record(s).revisions!.active, undefined)
    interrupted(s, template, { current: 'result' })
    const refused = revise(s)
    assert.equal(refused.out.code, 'review_candidate_changed', JSON.stringify(refused.out)); assert.equal(calls(s).length, callsBefore)
    assert.equal(entries(s)[0].result!.state, 'published'); assert.equal(record(s).revisions!.active, undefined)
    // review round recupera la intención, pero cancel posterior conserva ese resultado.
    const reviewPoint = interrupted(s, template, { current: 'result' })
    script(s, [{ answer: directedAnswer(s) }])
    const round = cli(s, ['review', 'round', s.review]); assert.equal(round.code, 0, JSON.stringify(round.out))
    await settle(s, s.review)
    assert.equal(entries(s)[0].result!.state, 'published')
    assert.equal(cli(s, ['cancel', reviewPoint.run]).out.outcome, 'published')
    assert.equal(record(s).revisions!.barriers.length, 1)
  } finally { await cleanup(s) }

  const flag = (file: string, on: boolean) => spawnSync(process.platform === 'darwin' ? 'chflags' : 'chattr',
    [process.platform === 'darwin' ? (on ? 'uchg' : 'nouchg') : (on ? '+i' : '-i'), file], { encoding: 'utf8' })
  for (const immutable of ['target', 'registry']) {
    const fixture = makeFixture()
    const barrier = join(fixture.work, 'release')
    const file = flowFile(fixture, immutable === 'target' ? 'spec.md' : 'sdd-ai-phases.json')
    let marked = false
    try {
      script(fixture, [{ barrier, answer: JSON.stringify(corrected('spec')) }])
      const start = revise(fixture); assert.equal(start.code, 0, JSON.stringify(start.out)); await waitFor(`${barrier}.ready`)
      const before = readFileSync(flowFile(fixture, 'spec.md'), 'utf8')
      const mark = flag(file, true)
      marked = mark.status === 0
      if (!marked) {
        assert.notEqual(process.platform, 'darwin', `chflags obligatorio en macOS: ${mark.stderr}`)
        t.diagnostic(`omitido: marca inmutable de ${immutable} sin permiso o soporte en ${process.platform}`)
        continue
      }
      writeFileSync(barrier, '')
      const finished = await settle(fixture, start.out.id)
      assert.equal(finished.out.outcome, 'not_published', JSON.stringify(finished.out))
      assert.equal(finished.out.cause, immutable === 'target' ? 'publish_interrupted' : 'intent_unwritable')
      assert.equal(readFileSync(flowFile(fixture, 'spec.md'), 'utf8'), before)
      if (immutable === 'target') assert.equal(record(fixture).revisions!.intent!.resolved, true)
      else assert.equal(finished.out.registry_pending, true)
      assert.equal(flag(file, false).status, 0); marked = false
      cli(fixture, ['wait', start.out.id, '--max', '0'])
      assert.equal(record(fixture).revisions!.active, undefined)
      script(fixture, [{ answer: JSON.stringify(corrected('spec')) }])
      const next = revise(fixture); assert.equal(next.code, 0, JSON.stringify(next.out)); await settle(fixture, next.out.id)
    } finally {
      if (marked) flag(file, false)
      writeFileSync(barrier, ''); await cleanup(fixture)
    }
  }
})
