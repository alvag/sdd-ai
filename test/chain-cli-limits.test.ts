import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeCalls, runBin } from './helpers.ts'
import { readFlow } from '../src/sdd/read.ts'
import { implReport, fixReport, markAll, classesFile, redFlow, registry, legacyFlow, oldReport } from './chain-cli-fixture.ts'

test('limita rondas e incidencias por epoca humana', async () => {
  const { F_ROW, approveFlowGates } = await import('./helpers.ts')
  const still3 = { actions: [{ write: 'src/c.ts', content: `${Math.random()}\n` }], report: fixReport(['V1']) }
  const a = redFlow([F_ROW], [still3, { ...still3, actions: [{ write: 'src/d.ts', content: 'd\n' }] }])
  const classify = (receipt: string) => runBin(a.s, ['sdd', 'phase', 'f', '--classes', classesFile(a.s, receipt, [['V1', 'implementation']])])
  // Dos fix que no arreglan nada.
  const f1 = classify(a.receipt)
  runBin(a.s, ['wait', f1.out.id, '--max', '30'])
  const r2 = runBin(a.s, ['sdd', 'verify', 'f'])
  const f2 = classify(r2.out.receipt)
  assert.equal(f2.out.kind, 'fix', JSON.stringify(f2.out))
  runBin(a.s, ['wait', f2.out.id, '--max', '30'])
  // El rojo que sigue a la segunda corrección cierra la cadena con fix_cap al publicarse.
  const r3 = runBin(a.s, ['sdd', 'verify', 'f'])
  assert.equal(registry(a.s).implement.chains[0].terminal.code, 'fix_cap')
  const third = classify(r3.out.receipt)
  assert.equal(third.code, 2, JSON.stringify(third.out))
  assert.equal(fakeCalls(a.s).length, 3)
  // Tres incidencias de V1 en la época: failure_cap, también después de una toma.
  const counts = registry(a.s).implement.classifications.length
  assert.equal(counts, 3)
  writeFileSync(join(a.s.repo, 'src', 'e.ts'), 'e\n')
  const taken = runBin(a.s, ['sdd', 'verify', 'f', '--takeover'])
  assert.equal(taken.out.green, false)
  const st = runBin(a.s, ['sdd', 'status', 'f']).out.next
  assert.match(st.detail, /vuelve al plan o a la spec/, JSON.stringify(st))
  // Reaprobar solo tasks no reinicia el conteo; reaprobar el plan, sí.
  const approvals = join(a.s.repo, '.plans', 'f', 'sdd-ai-approvals.json')
  const log = JSON.parse(readFileSync(approvals, 'utf8'))
  log.approvals.push({ ...log.approvals.find((x: { gate: string }) => x.gate === 'tasks'), at: '2026-09-29T23:00:00.000Z' })
  writeFileSync(approvals, JSON.stringify(log))
  assert.match(runBin(a.s, ['sdd', 'status', 'f']).out.next.detail, /vuelve al plan o a la spec/)
  approveFlowGates(a.s.repo, Date.parse('2026-09-30T01:00:00.000Z'))
  assert.doesNotMatch(JSON.stringify(runBin(a.s, ['sdd', 'status', 'f']).out.next), /vuelve al plan o a la spec/)

  // El conteo cruza una toma y una cadena nueva: dos rojos en la primera cadena, el tercero en la segunda.
  const x = redFlow([F_ROW], [
    { actions: [{ write: 'src/c.ts', content: 'c\n' }], report: fixReport(['V1']) },
    { actions: [{ write: 'src/t2.ts', content: '2\n' }], report: implReport(['T2']) },
  ])
  const classifyX = (receipt: string) => runBin(x.s, ['sdd', 'phase', 'f', '--classes', classesFile(x.s, receipt, [['V1', 'implementation']])])
  runBin(x.s, ['wait', classifyX(x.receipt).out.id, '--max', '30'])
  runBin(x.s, ['sdd', 'verify', 'f'])
  writeFileSync(join(x.s.repo, 'src', 'e.ts'), 'e\n')
  const takenX = runBin(x.s, ['sdd', 'verify', 'f', '--takeover'])
  assert.equal(classifyX(takenX.out.receipt).out.code, 'no_fix')
  // Otra task y solo el gate de tasks reaprobado: la época del plan sigue, y una cadena nueva la toma.
  const tasksFile = join(x.s.repo, '.plans', 'f', 'tasks.md')
  const approveTasks = () => {
    const file = join(x.s.repo, '.plans', 'f', 'sdd-ai-approvals.json')
    const log = JSON.parse(readFileSync(file, 'utf8'))
    const fp = readFlow(x.s.repo, 'f').facts.fingerprints
    log.approvals.push({ gate: 'tasks', depth: 'completa', fingerprint: fp.tasks, previous: { spec: fp.spec, plan: fp.plan }, at: new Date(Date.now() + 1000).toISOString() })
    writeFileSync(file, JSON.stringify(log))
  }
  appendFileSync(tasksFile, '- [ ] **T2 — paso 2**  · cubre: AC-1\n')
  approveTasks()
  const c2 = runBin(x.s, ['sdd', 'phase', 'f'])
  assert.deepEqual([c2.code, c2.out.chain, c2.out.pending], [0, 'c2', ['T2']], JSON.stringify(c2.out))
  runBin(x.s, ['wait', c2.out.id, '--max', '30'])
  markAll(x.s)
  const redX = runBin(x.s, ['sdd', 'verify', 'f'])
  const capped = classifyX(redX.out.receipt)
  assert.equal(capped.code, 2, JSON.stringify(capped.out))
  assert.match(capped.out.message, /no lleva a un fix/)
  assert.deepEqual(registry(x.s).implement.chains.map((c: { terminal: { code: string } }) => c.terminal.code), ['takeover', 'failure_cap'])
  assert.equal(fakeCalls(x.s).length, 3)
  // Con el tope alcanzado, reaprobar solo las tasks no abre otra cadena; reaprobar el plan, sí.
  appendFileSync(tasksFile, '- [ ] **T3 — paso 3**  · cubre: AC-1\n')
  approveTasks()
  assert.equal(runBin(x.s, ['sdd', 'phase', 'f']).out.code, 'chain_closed')
  assert.equal(fakeCalls(x.s).length, 3)
  approveFlowGates(x.s.repo, Date.now() + 60_000)
  assert.equal(runBin(x.s, ['sdd', 'status', 'f']).out.next.command, './bin/sdd-ai sdd phase f')
})

test('adopta writers antiguos como cadenas cerradas con completitud manual', () => {
  const { s, run } = legacyFlow(2, { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: oldReport(['T1', 'T2']) })
  // Se admite con el contrato de entonces, sin inferir completitud de su prosa.
  const w = runBin(s, ['wait', run, '--max', '30'])
  assert.deepEqual(w.out.contract, { admitted: true, missing_context: [] })
  assert.equal(w.out.left, undefined)
  // Con tasks sin marcar, las termina el conductor con una toma; no es padre de nada.
  const st = runBin(s, ['sdd', 'status', 'f']).out.next
  assert.match(st.detail, /tasks sin marcar \(T1, T2\)/, JSON.stringify(st))
  assert.equal(runBin(s, ['sdd', 'phase', 'f']).out.code, 'chain_closed')
  assert.equal(runBin(s, ['sdd', 'phase', 'f', '--blocks']).out.code, 'chain_closed')
  assert.equal(fakeCalls(s).length, 1, 'no se relanza')
  const imp = JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).implement
  assert.deepEqual([imp.chains[0].entries[0].run, imp.chains[0].terminal.code], [run, 'legacy'])
  // Con todas marcadas y el árbol de su cosecha, verify corre; un rojo de implementación lo resuelve el conductor.
  markAll(s)
  assert.equal(runBin(s, ['sdd', 'status', 'f']).out.next.command, './bin/sdd-ai sdd verify f')
  const red = runBin(s, ['sdd', 'verify', 'f'])
  assert.equal(red.out.green, false, JSON.stringify(red.out))
  const cls = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, red.out.receipt, [['V1', 'implementation']])])
  assert.equal(cls.out.code, 'no_fix', JSON.stringify(cls.out))
  assert.match(cls.out.next, /--takeover/)
  assert.equal(fakeCalls(s).length, 1)
  // Los demás rojos se derivan por clase como con la cadena abierta: primero se clasifican; un contrato se enmienda.
  const again = runBin(s, ['sdd', 'verify', 'f'])
  assert.match(runBin(s, ['sdd', 'status', 'f']).out.next.detail, /clasifica las filas rojas/)
  const contract = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, again.out.receipt, [['V1', 'contract']])])
  assert.equal(contract.out.code, 'no_fix', JSON.stringify(contract.out))
  assert.match(contract.out.next, /enmienda ## Verification/)
  assert.equal(fakeCalls(s).length, 1)
})
