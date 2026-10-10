import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tasksFingerprint, singleFingerprint, combinedFingerprint, countTasks } from '../src/sdd/markdown.ts'
import { type FlowFacts, type GateId, type Depth, resolve } from '../src/sdd/status.ts'

test('cambiar actor vence la huella y el gate pero cambiar checkbox conserva su vigencia', () => {
  const original = '- [ ] **T1 — Código**  · actor: writer  · cubre: AC-1\n'
  const checked = original.replace('[ ]', '[x]')
  const reassigned = original.replace('writer', 'conductor')
  const plan = (tasks: string) => `# Plan\n\n## Spec\n\nPedido\n\n## Tasks\n\n${tasks}`
  const fingerprints = (depth: Depth, tasks: string): Partial<Record<GateId, string>> => depth === 'corta'
    ? { single: singleFingerprint(plan(tasks)) }
    : { spec: 'sha256:spec', plan: 'sha256:plan', tasks: tasksFingerprint(tasks), 'plan-tasks': combinedFingerprint({ plan: 'sha256:plan', tasks: tasksFingerprint(tasks) }) }
  assert.equal(tasksFingerprint(original), tasksFingerprint(checked))
  assert.notEqual(tasksFingerprint(original), tasksFingerprint(reassigned))
  assert.equal(singleFingerprint(plan(original)), singleFingerprint(plan(checked)))
  assert.notEqual(singleFingerprint(plan(original)), singleFingerprint(plan(reassigned)))
  for (const depth of ['corta', 'normal', 'completa'] as const) {
    const old = fingerprints(depth, original)
    const gate: GateId = depth === 'corta' ? 'single' : depth === 'normal' ? 'plan-tasks' : 'tasks'
    const facts = (tasks: string): FlowFacts => ({ id: 'f', files: { spec: depth === 'corta' ? 'absent' : 'present', plan: 'present', tasks: depth === 'corta' ? 'absent' : 'present', handoff: 'present' },
      planHeader: { ok: true, data: { profundidad: depth, status: 'tasks-ready' }, body: '' },
      handoffHeader: { ok: true, data: { profundidad: depth, spec_approved_at: '2026-09-29' }, body: '' },
      planSections: { spec: depth === 'corta' ? 'present' : 'absent', tasks: depth === 'corta' ? 'present' : 'absent' },
      tasksFile: depth === 'corta' ? null : countTasks(tasks), tasksSection: depth === 'corta' ? countTasks(tasks) : null,
      fingerprints: fingerprints(depth, tasks), log: { state: 'ok', approvals: [{ gate, depth, fingerprint: old[gate]!, previous: {}, at: '2026-09-29T00:00:00Z' }] }, paths: {}, hasRemote: true })
    assert.equal(resolve(facts(checked)).gates.find((g) => g.gate === gate)?.state, 'approved')
    assert.equal(resolve(facts(reassigned)).gates.find((g) => g.gate === gate)?.state, 'stale')
    if (depth !== 'corta') {
      const dependent = facts(checked)
      if (dependent.log.state !== 'ok') throw new Error('fixture sin aprobaciones')
      dependent.log.approvals[0].previous = { spec: old.spec, ...(depth === 'completa' ? { plan: old.plan } : {}) }
      assert.equal(resolve(dependent).gates.find((g) => g.gate === gate)?.state, 'approved')
      // Las dependencias del gate siguen participando en su vigencia; marcar no las neutraliza.
      dependent.fingerprints.spec = 'sha256:spec-modificada'
      assert.equal(resolve(dependent).gates.find((g) => g.gate === gate)?.state, 'stale')
    }
  }
})
