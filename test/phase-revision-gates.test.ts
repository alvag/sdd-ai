import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { GATES, GATE_ARTIFACTS, resolve } from '../src/sdd/status.ts'
import { readFlow } from '../src/sdd/read.ts'
import { gateQuestionFor } from '../src/approval/question.ts'
import { answer, cleanup, cli, contracts, flowFile, json, makeFixture, put, record, revise, script, settle, snapshotFiles } from './phase-revision-fixture.ts'

test('la publicacion vence gates dependientes y desactiva la acreditacion por header', async () => {
  for (const depth of ['normal', 'completa'] as const) for (const artifact of ['spec', 'plan', 'tasks'] as const) {
    const s = makeFixture({ depth, artifact })
    try {
      const before = snapshotFiles(s)
      const start = revise(s); assert.equal(start.code, 0, JSON.stringify(start.out)); await settle(s, start.out.id)
      assert.equal(readFileSync(flowFile(s, 'handoff.md'), 'utf8'), before['handoff.md'])
      const oldHeader = /^---\n[\s\S]*?\n---\n/.exec(before['plan.md'])![0]
      assert.ok(readFileSync(flowFile(s, 'plan.md'), 'utf8').startsWith(oldHeader))
      const first = GATES[depth].findIndex((g) => GATE_ARTIFACTS[g].includes(artifact))
      const affected = GATES[depth].slice(first)
      assert.deepEqual(record(s).revisions!.barriers[0].gates, affected)
      for (let query = 0; query < 2; query++) {
        const status = cli(s, ['sdd', 'status', 'f']).out
        for (const gate of affected) assert.ok(!['approved', 'approved_unfingerprinted'].includes(status.gates.find((g: { gate: string }) => g.gate === gate).state))
        assert.ok(status.notes.some((n: { code: string; detail: string }) => n.code === 'header_ahead' && /plan\.md: status|handoff\.md: spec_approved_at/.test(n.detail)), JSON.stringify(status.notes))
        assert.ok(status.next.question)
      }
      // Reaprobación con huellas vigentes, una respuesta distinta por gate.
      for (const gate of affected) {
        const status = cli(s, ['sdd', 'status', 'f']).out
        answer(s, status.next.question)
        const approved = cli(s, ['sdd', 'approve', 'f', gate])
        assert.equal(approved.code, 0, JSON.stringify(approved.out))
        assert.equal(approved.out.gates.find((g: { gate: string }) => g.gate === gate).state, 'approved')
      }
      assert.equal(json<{ approvals: unknown[] }>(flowFile(s, 'sdd-ai-approvals.json')).approvals.length, affected.length)
    } finally { await cleanup(s) }
  }
  const logged = makeFixture({ depth: 'completa' })
  try {
    const fingerprints = readFlow(logged.repo, 'f').facts.fingerprints
    const approvals = GATES.completa.map((gate, i) => ({ gate, depth: 'completa', fingerprint: fingerprints[gate],
      previous: Object.fromEntries(GATES.completa.slice(0, i).map((previous) => [previous, fingerprints[previous]])), at: '2026-10-10T00:00:00Z' }))
    put(flowFile(logged, 'sdd-ai-approvals.json'), { schema_version: 1, approvals })
    const history = readFileSync(flowFile(logged, 'sdd-ai-approvals.json'), 'utf8')
    assert.ok(cli(logged, ['sdd', 'status', 'f']).out.notes.some((n: { code: string }) => n.code === 'approval_unproven'))
    const start = revise(logged); await settle(logged, start.out.id)
    const status = cli(logged, ['sdd', 'status', 'f']).out
    assert.ok(status.gates.every((g: { state: string }) => g.state === 'stale'))
    assert.equal(readFileSync(flowFile(logged, 'sdd-ai-approvals.json'), 'utf8'), history)
  } finally { await cleanup(logged) }
  const proven = makeFixture({ depth: 'completa' })
  try {
    for (const gate of GATES.completa) {
      answer(proven, gateQuestionFor('f', 'completa', gate, readFlow(proven.repo, 'f').facts.fingerprints))
      const approved = cli(proven, ['sdd', 'approve', 'f', gate])
      assert.equal(approved.code, 0, JSON.stringify(approved.out))
    }
    const history = readFileSync(flowFile(proven, 'sdd-ai-approvals.json'), 'utf8')
    assert.ok(JSON.parse(history).approvals.every((a: { proof?: unknown }) => a.proof))
    const start = revise(proven); assert.equal(start.code, 0, JSON.stringify(start.out)); await settle(proven, start.out.id)
    assert.ok(cli(proven, ['sdd', 'status', 'f']).out.gates.every((g: { state: string }) => g.state === 'stale'))
    assert.equal(readFileSync(flowFile(proven, 'sdd-ai-approvals.json'), 'utf8'), history)
    const registry = readFileSync(flowFile(proven, 'sdd-ai-phases.json'), 'utf8')
    try {
      writeFileSync(flowFile(proven, 'sdd-ai-phases.json'), '{')
      assert.notEqual(cli(proven, ['sdd', 'status', 'f']).code, 0)
      const closed = resolve(readFlow(proven.repo, 'f').facts)
      assert.ok(closed.blocked_reasons.some((r: { code: string }) => r.code === 'revisions_invalid'))
      assert.ok(closed.gates.every((g: { state: string }) => g.state !== 'approved_unfingerprinted'))
      assert.equal(readFileSync(flowFile(proven, 'sdd-ai-phases.json'), 'utf8'), '{')
    } finally { writeFileSync(flowFile(proven, 'sdd-ai-phases.json'), registry) }
  } finally { await cleanup(proven) }
  const same = makeFixture()
  try {
    script(same, [{ answer: JSON.stringify(contracts.spec) }])
    const start = revise(same); assert.equal((await settle(same, start.out.id)).out.outcome, 'no_changes')
    assert.deepEqual(record(same).revisions!.barriers, [])
    assert.ok(cli(same, ['sdd', 'status', 'f']).out.gates.every((g: { state: string }) => g.state === 'approved_unfingerprinted'))
  } finally { await cleanup(same) }
})
