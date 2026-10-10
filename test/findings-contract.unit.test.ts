import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FINDINGS_TEMPLATE, FINDING_REPORT_SCHEMA } from '../src/findings.ts'
import * as phase from '../src/sdd/phase.ts'
import { admitSpecify, admitPlan, admitTasks, admitImplement, admitFix, renderPhasePrompt, renderSpec, renderPlan, renderTasks, type PlanHeader } from '../src/sdd/phase.ts'
import { renderFixPrompt, renderContinuationPrompt, renderResumePrompt, type FixPromptInput } from '../src/sdd/chain.ts'
import { FINDING, SPECIFY, PLAN, TASKS, IMPLEMENT, FIX, report } from './findings-fixture.ts'

const contracts = [SPECIFY, PLAN, TASKS, IMPLEMENT, FIX]
const admitters = [
  (c: unknown) => admitSpecify(JSON.stringify(c)),
  (c: unknown) => admitPlan(JSON.stringify(c), ['AC-1']),
  (c: unknown) => admitTasks(JSON.stringify(c), ['AC-1']),
  (c: unknown) => admitImplement(report(c), ['T1'], { explicit: true }),
  (c: unknown) => admitFix(report(c), ['V1']),
]

test('las cinco fases admiten findings válidos y contratos anteriores y rechazan claves ajenas', () => {
  contracts.forEach((c, i) => {
    const old = admitters[i](c)
    assert.equal(old.kind, 'admitted')
    if (old.kind === 'admitted') assert.equal('findings' in old.review, false)
    for (const findings of [[], [FINDING]]) {
      const a = admitters[i]({ ...c, findings })
      assert.equal(a.kind, 'admitted')
      if (a.kind === 'admitted') assert.deepEqual(a.review.findings, findings)
    }
    for (const key of ['unknown', 'findings_rejected', 'findings_missing']) assert.notEqual(admitters[i]({ ...c, [key]: [] }).kind, 'admitted')
    const { missing_context: _m, ...missing } = c
    assert.notEqual(admitters[i](missing).kind, 'admitted')
  })
  const { completion: _c, ...task } = IMPLEMENT.tasks[0]
  assert.equal(admitImplement(report({ ...IMPLEMENT, tasks: [task] }), ['T1']).kind, 'admitted')
  assert.equal(admitFix(report({ ...FIX, rows: [] }), ['V1']).kind, 'inadmissible')
})

test('un findings mal formado no vuelve inadmisible el contrato y llega aparte como rejected', () => {
  const { location: _l, ...withoutLocation } = FINDING
  const { commit: _c, ...withoutCommit } = FINDING.context
  const bad = [null, 4, { ...FINDING, extra: true }, withoutLocation, { ...FINDING, problem: '' },
    { ...FINDING, evidence: [] }, { ...FINDING, evidence: [''] }, { ...FINDING, context: null },
    { ...FINDING, context: withoutCommit }, { ...FINDING, context: { ...FINDING.context, extra: true } }, { ...FINDING, expected: 9 }]
  for (const raw of bad) {
    const a = phase.admitFindings([FINDING, raw])
    assert.deepEqual(a.findings, [FINDING])
    assert.equal(a.rejected.length, 1)
    assert.deepEqual([a.rejected[0].index, a.rejected[0].raw], [1, raw])
    assert.ok(a.rejected[0].error)
  }
  for (const value of [null, 'bad', {}, 5]) {
    const a = phase.admitFindings(value)
    assert.deepEqual(a.findings, [])
    assert.deepEqual([a.rejected[0].index, a.rejected[0].raw], [null, value])
  }
  contracts.forEach((c, i) => {
    const a = admitters[i]({ ...c, findings: [FINDING, ...bad] })
    assert.equal(a.kind, 'admitted')
    if (a.kind === 'admitted') {
      assert.deepEqual(a.review.findings, [FINDING])
      assert.equal(a.review.findings_rejected?.length, bad.length)
      const { findings: _f, findings_rejected: _r, ...rest } = a.review
      assert.deepEqual(rest, c)
    }
  })
  for (const active of [false, true]) {
    const a = admitImplement(report(IMPLEMENT), ['T1'], { explicit: true, findings: active })
    const b = admitFix(report(FIX), ['V1'], { findings: active })
    for (const r of [a, b]) {
      assert.equal(r.kind, 'admitted')
      if (r.kind === 'admitted') assert.equal(r.review.findings_missing, active ? true : undefined)
    }
  }
  const a = admitImplement(report({ ...IMPLEMENT, findings: null }), ['T1'], { explicit: true, findings: true })
  if (a.kind !== 'admitted') assert.fail('Contrato inadmisible')
  assert.deepEqual(a.review.findings, [])
  assert.equal(a.review.findings_missing, undefined)
})

test('los prompts de fase y corrección piden findings y conservan el contrato al reanudar', () => {
  for (const step of ['specify', 'plan', 'tasks', 'implement'] as const) {
    const prompt = renderPhasePrompt(step, { id: 'f', depth: 'normal', step, pending: ['T1'] }, { request: 'x', spec: 'x', plan: 'x', tasks: renderTasks(TASKS) })
    assert.ok(prompt.includes('"findings": []'))
    assert.ok(prompt.includes(FINDING_REPORT_SCHEMA))
    assert.ok(prompt.includes('también con preguntas bloqueantes o contexto faltante'))
  }
  const input: FixPromptInput = { flow: 'f', receipt: 'r', paths: { spec: 'spec.md', plan: 'plan.md', tasks: 'tasks.md' },
    rows: [{ id: 'V1', argv: ['node'], exit_code: 1, excerpt: 'falló', class: 'defect', reason: 'defecto', stdout: 'á'.repeat(5000), stderr: 'falló'.repeat(5000) }] }
  const full = renderFixPrompt(input, 100000)
  if ('over_budget' in full) assert.fail('Presupuesto amplio')
  assert.ok(full.prompt.includes(FINDING_REPORT_SCHEMA))
  const trimmed = renderFixPrompt(input, Buffer.byteLength(full.prompt) - 1000)
  if ('over_budget' in trimmed) assert.fail('Debe recortar')
  assert.ok(Buffer.byteLength(trimmed.prompt) <= Buffer.byteLength(full.prompt) - 1000)
  assert.ok(trimmed.prompt.includes('### V1'))
  assert.deepEqual(renderFixPrompt(input, 1), { over_budget: true })
  assert.ok(renderContinuationPrompt('f', ['T1']).includes(FINDING_REPORT_SCHEMA))
  const resume = renderResumePrompt('f', 'old', 'implement', ['T1'])
  assert.ok(resume.includes('mismo contrato'))
  assert.equal(resume.includes('findings'), false)
  assert.equal(renderResumePrompt('f', 'old', 'fix', ['V1']).includes('findings'), false)
  assert.equal(renderSpec({ ...SPECIFY, findings: [FINDING] }), renderSpec(SPECIFY))
  assert.equal(renderTasks({ ...TASKS, findings: [FINDING] }), renderTasks(TASKS))
  const header: PlanHeader = { id: 'f', branch: 'feature/f', base_commit: 'abc', change_type: 'feat', profundidad: 'normal', risk: 'low', status: 'planned', created_at: '2026-10-06T00:00:00-05:00' }
  assert.equal(renderPlan({ ...PLAN, findings: [FINDING] }, header, ['AC-1']), renderPlan(PLAN, header, ['AC-1']))
})

test('la skill reproduce literalmente la plantilla vacía del registro', () => {
  const skill = readFileSync(new URL('../skills/sdd-ai/SKILL.md', import.meta.url), 'utf8')
  const match = /```markdown sdd-ai-findings-template\n([\s\S]*?)```/.exec(skill)
  assert.ok(match)
  assert.equal(match[1], FINDINGS_TEMPLATE)
})
