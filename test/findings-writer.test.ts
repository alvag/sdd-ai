import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainFlow, chainSetup, fakeCalls, runBin } from './helpers.ts'
import { controlOf, writeControl, redFlow, classesFile, BUILD_ROW, storeOf } from './chain-cli-fixture.ts'
import { FINDING, IMPLEMENT, FIX, report } from './findings-fixture.ts'

const wait = (s: Parameters<typeof runBin>[0], id: string) => runBin(s, ['wait', id, '--max', '30'])

test('wait entrega findings de implement y fix sin acreditar tareas ni cosechas inválidas', () => {
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: report({ ...IMPLEMENT, findings: [FINDING], missing_context: ['esquema'] }) }] })
  chainFlow(s)
  const r = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(r.code, 0, JSON.stringify(r))
  const w = wait(s, r.out.id)
  assert.deepEqual(w.out.findings, [FINDING])
  assert.deepEqual(w.out.contract.missing_context, ['esquema'])
  assert.deepEqual(w.out.left, ['T1'])
  assert.ok(w.out.failed.length)
  assert.ok(readFileSync(join(s.repo, '.plans/f/tasks.md'), 'utf8').includes('- [ ]'))
  const bad = chainSetup({ writers: [{ report: report({ ...IMPLEMENT, findings: [FINDING], extra: true }) }] })
  chainFlow(bad)
  const b = wait(bad, runBin(bad, ['sdd', 'phase', 'f']).out.id)
  assert.equal(b.out.contract.admitted, false)
  assert.equal('findings' in b.out, false)
  assert.ok(b.out.report.includes('reader'))
  const fix = redFlow([BUILD_ROW('V1', 1)], [{ report: report({ ...FIX, findings: [FINDING], missing_context: ['dato'] }) }])
  const f = runBin(fix.s, ['sdd', 'phase', 'f', '--classes', classesFile(fix.s, fix.receipt, [['V1', 'implementation']])])
  assert.equal(f.code, 0, JSON.stringify(f))
  const fw = wait(fix.s, f.out.id)
  assert.deepEqual(fw.out.findings, [FINDING])
  assert.deepEqual(fw.out.contract.missing_context, ['dato'])
  assert.ok(fw.out.failed.includes('sin cambios frente a su padre'))
  assert.equal(controlOf(fix.s, f.out.id).phase.findings, true)
  const flagged = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }, { runWrite: 'prompt.md', content: 'alterado' }], report: report({ ...IMPLEMENT, findings: [FINDING] }) }] })
  chainFlow(flagged)
  const flaggedWait = wait(flagged, runBin(flagged, ['sdd', 'phase', 'f']).out.id)
  assert.deepEqual(flaggedWait.out.findings, [FINDING])
  assert.ok(flaggedWait.out.failed.length)
  assert.ok(flaggedWait.out.run_altered.length)
  // Un fix con una clave ajena conserva el reporte, pero no admite ni acredita la corrección.
  const invalidReport = report({ ...FIX, findings: [FINDING], extra: true })
  const invalidFix = redFlow([BUILD_ROW('V1', 1)], [{ report: invalidReport }])
  const tasksFile = join(invalidFix.s.repo, '.plans', 'f', 'tasks.md')
  const tasksBefore = readFileSync(tasksFile, 'utf8')
  const invalidLaunch = runBin(invalidFix.s, ['sdd', 'phase', 'f', '--classes', classesFile(invalidFix.s, invalidFix.receipt, [['V1', 'implementation']])])
  assert.equal(invalidLaunch.code, 0, JSON.stringify(invalidLaunch))
  assert.equal(invalidLaunch.out.kind, 'fix')
  const invalidWait = wait(invalidFix.s, invalidLaunch.out.id)
  assert.equal(invalidWait.out.contract.admitted, false)
  assert.match(invalidWait.out.contract.cause, /clave no admitida "extra"/)
  for (const key of ['findings', 'findings_rejected', 'findings_missing']) assert.equal(key in invalidWait.out, false)
  assert.equal(invalidWait.out.report, invalidReport)
  assert.equal(invalidWait.out.end_mark, true)
  assert.ok(invalidWait.out.failed.length)
  assert.deepEqual(controlOf(invalidFix.s, invalidLaunch.out.id).phase.fix.rows.map((r: { id: string }) => r.id), ['V1'])
  assert.equal(readFileSync(tasksFile, 'utf8'), tasksBefore)
  assert.equal(fakeCalls(invalidFix.s).length, 2, 'no hay corrección de admisión del writer')
})

test('wait entrega findings_rejected de una entrega admitida con un hallazgo mal formado', () => {
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: report({ ...IMPLEMENT, findings: [FINDING, { problem: 'sin respaldo' }] }) }] })
  chainFlow(s)
  const r = runBin(s, ['sdd', 'phase', 'f'])
  const w = wait(s, r.out.id)
  assert.equal(w.out.contract.admitted, true)
  assert.deepEqual(w.out.findings, [FINDING])
  assert.equal(w.out.findings_rejected[0].index, 1)
  assert.deepEqual(w.out.findings_rejected[0].raw, { problem: 'sin respaldo' })
  assert.deepEqual(w.out.contract.findings_rejected, w.out.findings_rejected)
  assert.deepEqual(w.out.left, ['T1'])
  const fix = redFlow([BUILD_ROW('V1', 1)], [{ report: report({ ...FIX, findings: 'no es lista' }) }])
  const f = runBin(fix.s, ['sdd', 'phase', 'f', '--classes', classesFile(fix.s, fix.receipt, [['V1', 'implementation']])])
  const fw = wait(fix.s, f.out.id)
  assert.equal(fw.out.contract.admitted, true)
  assert.deepEqual(fw.out.findings, [])
  assert.equal(fw.out.findings_rejected[0].index, null)
  assert.equal(fw.out.findings_missing, undefined)
})

test('un writer nuevo sin findings queda marcado findings_missing y la reanudación de una corrida anterior no', () => {
  for (const legacy of [false, true]) {
    const s = chainSetup({ writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: 'Interrumpido\n' },
      { report: report({ ...IMPLEMENT, tasks: IMPLEMENT.tasks.map((t) => ({ ...t, completion: 'done' })) }) },
    ] })
    chainFlow(s)
    const r = runBin(s, ['sdd', 'phase', 'f'])
    wait(s, r.out.id)
    const origin = controlOf(s, r.out.id)
    assert.equal(origin.phase.findings, true)
    if (legacy) {
      const { findings: _f, ...old } = origin.phase
      writeControl(s, r.out.id, { ...origin, phase: old })
    }
    const resumed = runBin(s, ['sdd', 'phase', 'f'])
    assert.equal(resumed.code, 0, JSON.stringify(resumed))
    const c = controlOf(s, resumed.out.id)
    assert.equal(c.phase.resumes, r.out.id)
    assert.equal(c.phase.findings, legacy ? undefined : true)
    const w = wait(s, resumed.out.id)
    assert.equal(w.out.contract.admitted, true)
    assert.equal(w.out.findings_missing, legacy ? undefined : true)
    assert.equal('findings' in w.out, false)
    assert.equal(readFileSync(join(storeOf(s, resumed.out.id), 'prompt.md'), 'utf8').includes('findings'), false)
  }
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: report(IMPLEMENT) }] })
  chainFlow(s)
  const w = wait(s, runBin(s, ['sdd', 'phase', 'f']).out.id)
  assert.equal(w.out.findings_missing, true)

  for (const legacy of [false, true]) {
    const fix = redFlow([BUILD_ROW('V1', 1)], [
      { actions: [{ write: 'src/fix.ts', content: '1\n' }], report: 'Interrumpido\n' },
      { report: report(FIX) },
    ])
    const first = runBin(fix.s, ['sdd', 'phase', 'f', '--classes', classesFile(fix.s, fix.receipt, [['V1', 'implementation']])])
    wait(fix.s, first.out.id)
    const origin = controlOf(fix.s, first.out.id)
    if (legacy) {
      const { findings: _f, ...old } = origin.phase
      writeControl(fix.s, first.out.id, { ...origin, phase: old })
    }
    const resumed = runBin(fix.s, ['sdd', 'phase', 'f'])
    assert.equal(resumed.code, 0, JSON.stringify(resumed))
    assert.equal(controlOf(fix.s, resumed.out.id).phase.findings, legacy ? undefined : true)
    const fw = wait(fix.s, resumed.out.id)
    assert.equal(fw.out.contract.admitted, true)
    assert.equal(fw.out.findings_missing, legacy ? undefined : true)
  }

  const partial = chainSetup({ writers: [
    { actions: [{ write: 'src/one.ts', content: '1\n' }], report: report({ ...IMPLEMENT, tasks: [{ ...IMPLEMENT.tasks[0], completion: 'done' }, { ...IMPLEMENT.tasks[0], id: 'T2' }], findings: [] }) },
    { report: report({ ...IMPLEMENT, tasks: [{ ...IMPLEMENT.tasks[0], id: 'T2' }], findings: [FINDING] }) },
    { actions: [{ write: 'src/two.ts', content: '2\n' }], report: report({ ...IMPLEMENT, tasks: [{ ...IMPLEMENT.tasks[0], id: 'T2', completion: 'done' }], findings: [] }) },
  ] })
  chainFlow(partial, { tasks: 2 })
  wait(partial, runBin(partial, ['sdd', 'phase', 'f']).out.id)
  const continuation = runBin(partial, ['sdd', 'phase', 'f'])
  assert.equal(continuation.out.kind, 'continuation', JSON.stringify(continuation))
  assert.equal(controlOf(partial, continuation.out.id).phase.findings, true)
  assert.deepEqual(wait(partial, continuation.out.id).out.findings, [FINDING])
  const block = runBin(partial, ['sdd', 'phase', 'f', '--blocks'])
  assert.equal(block.out.kind, 'block', JSON.stringify(block))
  assert.equal(controlOf(partial, block.out.id).phase.findings, true)
  assert.deepEqual(wait(partial, block.out.id).out.findings, [])
})
