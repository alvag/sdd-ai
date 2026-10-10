import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidateFingerprint } from '../src/git.ts'
import { attestQuestion } from '../src/approval/question.ts'
import { attestRow, prepareVerify } from '../src/sdd/verify.ts'
import { releaseReservation } from '../src/writer-store.ts'
import { readFlow } from '../src/sdd/read.ts'
import { resolve } from '../src/sdd/status.ts'
import { actorFlow, implementationReport, writer, launch, harvest, mark, runBin, verifyFlow, approveAll, answered, asyncCode, final, MANUAL_ROW } from './task-actors-fixture.ts'

const automatic = { id: 'V1', acs: ['AC-1'], kind: 'inspection', obligation: 'none', obligation_reason: 'Caracterización de guardas',
  argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 10000, expect: { exit_code: 0 } }
const rows = [automatic, MANUAL_ROW]

test('verify cuenta cualquier actor y conserva gate escritor abierto toma y prueba humana', async () => {
  for (const actors of [['writer'], ['conductor'], ['user'], ['writer', 'conductor', 'user']]) {
    const { repo } = verifyFlow({ rows, done: false })
    const file = join(repo, '.plans', 'f', 'tasks.md')
    writeFileSync(file, '# Tasks\n\n' + actors.map((actor, i) => `- [ ] **T${i + 1} — Acción** · actor: ${actor} · cubre: AC-1, AC-2\n`).join(''))
    approveAll(repo)
    assert.equal(resolve(readFlow(repo, 'f').facts).tasks.pending, actors.length)
    assert.equal(await asyncCode(() => prepareVerify(repo, 'f', 'final')), 'verify_not_now')
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('[ ]', '[x]'))
    const start = prepareVerify(repo, 'f', 'final')
    assert.equal(releaseReservation(start.reservation).state, 'released')
  }

  const unapproved = verifyFlow({ rows })
  writeFileSync(join(unapproved.repo, '.plans', 'f', 'sdd-ai-approvals.json'), '{"schema_version":1,"approvals":[]}\n')
  assert.equal(await asyncCode(() => prepareVerify(unapproved.repo, 'f', 'final')), 'plan_not_approved')
  const stale = verifyFlow({ rows })
  const stalePlan = join(stale.repo, '.plans', 'f', 'plan.md')
  writeFileSync(stalePlan, readFileSync(stalePlan, 'utf8') + '\nCambio del plan\n')
  assert.equal(await asyncCode(() => prepareVerify(stale.repo, 'f', 'final')), 'verify_not_now')
  const open = verifyFlow({ rows })
  const store = join(open.repo, '.git', 'sdd-ai', 'runs', '20261009-1200-bbbb')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'control.json'), JSON.stringify({ id: '20261009-1200-bbbb', phase: { flow: 'f', pending: ['T1'], inputs: {}, handoff_header: '' } }))
  assert.equal(await asyncCode(() => prepareVerify(open.repo, 'f', 'final')), 'writer_open')

  const s = actorFlow([{ id: 'T1' }], [writer(implementationReport(['T1']))])
  const run = launch(s)
  harvest(s, run.out.id)
  mark(s, ['T1'])
  writeFileSync(join(s.repo, 'src', 'extra.ts'), 'export const extra = 1\n')
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'tree_not_harvest')
  const taken = runBin(s, ['sdd', 'verify', 'f', '--takeover', '--reason', 'Acción previa del conductor'])
  assert.equal(taken.out.green, true, JSON.stringify(taken.out))

  const { repo, base } = verifyFlow({ rows })
  const tasks = join(repo, '.plans', 'f', 'tasks.md')
  writeFileSync(tasks, '- [x] **T1 — Observación previa** · actor: user · cubre: AC-1, AC-2\n  - missing_context: observación realizada\n')
  approveAll(repo)
  const before = await final(repo)
  assert.equal(before.receipt.rows.find((r) => r.row === 'V1')?.outcome, 'passed')
  assert.equal(before.receipt.rows.find((r) => r.row === 'V2')?.outcome, 'unrun')
  const start = prepareVerify(repo, 'f', 'final')
  releaseReservation(start.reservation)
  const candidate = candidateFingerprint(repo, 'f', base)
  const q = attestQuestion('f', 'V2', MANUAL_ROW.observation, candidate, start.planFingerprint)
  // Una respuesta válida registrada en otra sesión no acredita la fila en esta.
  const otherSession = answered(q, 'Acreditar')
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', { ...otherSession, CLAUDE_CODE_SESSION_ID: 'no-answer' })), 'approval_missing')
  const wrong = answered(attestQuestion('f', 'V99', MANUAL_ROW.observation, candidate, start.planFingerprint), 'Acreditar')
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', wrong)), 'approval_missing')
  const movedCandidate = answered(q, 'Acreditar')
  writeFileSync(join(repo, 'src', 'other.ts'), 'export const other = 1\n')
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', movedCandidate)), 'approval_missing')
  const plan = join(repo, '.plans', 'f', 'plan.md')
  const oldPlanQuestion = attestQuestion('f', 'V2', MANUAL_ROW.observation, candidateFingerprint(repo, 'f', base), start.planFingerprint)
  const movedPlan = answered(oldPlanQuestion, 'Acreditar')
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('Uno.', 'Dos.'))
  approveAll(repo)
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', movedPlan)), 'approval_missing')
  const current = prepareVerify(repo, 'f', 'final')
  releaseReservation(current.reservation)
  const correct = answered(attestQuestion('f', 'V2', MANUAL_ROW.observation, candidateFingerprint(repo, 'f', base), current.planFingerprint), 'Acreditar')
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V1', correct)), 'usage')
  const ref = attestRow(repo, 'f', 'V2', correct)
  assert.equal(ref.row, 'V2')
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', correct)), 'approval_reused')
  assert.equal((await final(repo)).receipt.green, true)
})
