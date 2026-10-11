import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { GATES, GATE_ARTIFACTS, resolve } from '../src/sdd/status.ts'
import { readFlow } from '../src/sdd/read.ts'
import { gateQuestionFor } from '../src/approval/question.ts'
import { answer, cleanup, cli, contracts, flowFile, json, makeFixture, put, record, revise, script, settle, snapshotFiles } from './phase-revision-fixture.ts'

test('la publicacion vence gates dependientes y desactiva la acreditacion por header', async () => {
  for (const depth of ['normal', 'completa'] as const) for (const artifact of ['spec', 'plan', 'tasks'] as const) for (const credit of ['header', 'logged', 'proven']) {
    const s = makeFixture({ depth, artifact })
    try {
      if (credit === 'logged') {
        const fingerprints = readFlow(s.repo, 'f').facts.fingerprints
        const approvals = GATES[depth].map((gate, i) => ({ gate, depth, fingerprint: fingerprints[gate],
          previous: Object.fromEntries(GATES[depth].slice(0, i).map((previous) => [previous, fingerprints[previous]])), at: '2026-10-10T00:00:00Z' }))
        put(flowFile(s, 'sdd-ai-approvals.json'), { schema_version: 1, approvals })
        assert.ok(cli(s, ['sdd', 'status', 'f']).out.notes.some((n: { code: string }) => n.code === 'approval_unproven'))
      }
      if (credit === 'proven') for (const gate of GATES[depth]) {
        answer(s, gateQuestionFor('f', depth, gate, readFlow(s.repo, 'f').facts.fingerprints))
        const approved = cli(s, ['sdd', 'approve', 'f', gate]); assert.equal(approved.code, 0, JSON.stringify(approved.out))
      }
      const previousApprovals = credit === 'header' ? [] : json<{ approvals: unknown[] }>(flowFile(s, 'sdd-ai-approvals.json')).approvals
      const before = snapshotFiles(s)
      const start = revise(s); assert.equal(start.code, 0, JSON.stringify(start.out)); await settle(s, start.out.id)
      assert.equal(readFileSync(flowFile(s, 'handoff.md'), 'utf8'), before['handoff.md'])
      const oldHeader = /^---\n[\s\S]*?\n---\n/.exec(before['plan.md'])![0]
      assert.ok(readFileSync(flowFile(s, 'plan.md'), 'utf8').startsWith(oldHeader))
      const first = GATES[depth].findIndex((g) => GATE_ARTIFACTS[g].includes(artifact))
      const affected = GATES[depth].slice(first)
      const unaffected = GATES[depth].slice(0, first)
      assert.deepEqual(record(s).revisions!.barriers[0].gates, affected)
      // Cada consulta usa un proceso nuevo: comprueba que la barrera persiste entre sesiones.
      for (let query = 0; query < 2; query++) {
        const status = cli(s, ['sdd', 'status', 'f']).out
        for (const gate of affected) assert.ok(!['approved', 'approved_unfingerprinted'].includes(status.gates.find((g: { gate: string }) => g.gate === gate).state))
        if (credit === 'header') assert.ok(status.notes.some((n: { code: string; detail: string }) => n.code === 'header_ahead' && /plan\.md: status|handoff\.md: spec_approved_at/.test(n.detail)), JSON.stringify(status.notes))
        for (const gate of unaffected) assert.equal(status.gates.find((g: { gate: string }) => g.gate === gate).state, credit === 'header' ? 'approved_unfingerprinted' : 'approved')
        assert.ok(status.next.question)
      }
      if (credit !== 'header') assert.deepEqual(json<{ approvals: unknown[] }>(flowFile(s, 'sdd-ai-approvals.json')).approvals, previousApprovals)
      if (credit === 'header') {
        // Con solo header y barrera, ignorar el registro roto rehabilitaría la aprobación.
        const registry = readFileSync(flowFile(s, 'sdd-ai-phases.json'), 'utf8')
        try {
          writeFileSync(flowFile(s, 'sdd-ai-phases.json'), '{')
          assert.notEqual(cli(s, ['sdd', 'status', 'f']).code, 0)
          const closed = resolve(readFlow(s.repo, 'f').facts)
          assert.ok(closed.blocked_reasons.some((r) => r.code === 'revisions_invalid'))
          assert.ok(closed.gates.every((g) => g.state !== 'approved_unfingerprinted'))
        } finally { writeFileSync(flowFile(s, 'sdd-ai-phases.json'), registry) }
      }
      // Reaprobación con huellas vigentes, una respuesta distinta por gate.
      for (const gate of affected) {
        const status = cli(s, ['sdd', 'status', 'f']).out
        answer(s, status.next.question)
        const approved = cli(s, ['sdd', 'approve', 'f', gate])
        assert.equal(approved.code, 0, JSON.stringify(approved.out))
        assert.equal(approved.out.gates.find((g: { gate: string }) => g.gate === gate).state, 'approved')
      }
      const final = cli(s, ['sdd', 'status', 'f']).out
      for (const gate of unaffected) assert.equal(final.gates.find((g: { gate: string }) => g.gate === gate).state, credit === 'header' ? 'approved_unfingerprinted' : 'approved')
      assert.ok(final.gates.every((g: { state: string }) => ['approved', 'approved_unfingerprinted'].includes(g.state)))
      assert.equal(final.next.step, 'implement')
      const approvals = json<{ approvals: unknown[] }>(flowFile(s, 'sdd-ai-approvals.json')).approvals
      assert.equal(approvals.length, previousApprovals.length + affected.length)
      assert.deepEqual(approvals.slice(0, previousApprovals.length), previousApprovals)
    } finally { await cleanup(s) }
  }
  const same = makeFixture()
  try {
    script(same, [{ answer: JSON.stringify(contracts.spec) }])
    const start = revise(same); assert.equal(start.code, 0, JSON.stringify(start.out)); assert.equal((await settle(same, start.out.id)).out.outcome, 'no_changes')
    assert.deepEqual(record(same).revisions!.barriers, [])
    assert.ok(cli(same, ['sdd', 'status', 'f']).out.gates.every((g: { state: string }) => g.state === 'approved_unfingerprinted'))
  } finally { await cleanup(same) }
})
