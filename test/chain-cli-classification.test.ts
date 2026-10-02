import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChainSetup, chainFlow, chainSetup, fakeCalls, fakePrompts, runBin } from './helpers.ts'
import { storeOf, implReport, fixReport, markAll, classesFile, BUILD_ROW, redFlow, LOUD_ROW } from './chain-cli-fixture.ts'

test('clasifica todas las filas rojas y deriva cada mezcla', async () => {
  const rows = [(await import('./helpers.ts')).F_ROW, BUILD_ROW('V2', 1), BUILD_ROW('V3', 0)]
  const phaseWith = (s: ChainSetup, receipt: string, cls: Array<[string, string]>) => runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, receipt, cls)])

  // Propuestas: la fila de test que falla, implementación; el build no encaja en ninguna regla.
  const a = redFlow(rows, [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) }])
  const ask = runBin(a.s, ['sdd', 'phase', 'f'])
  assert.equal(ask.out.code, 'classification_required')
  assert.match(ask.out.detail, /V1: implementation\nV2: sin propuesta/)
  // Rechazos de forma, sin lanzar nada.
  for (const [cls, cause] of [
    [[['V1', 'implementation'], ['V9', 'environment']], /V9 no está en el recibo/],
    [[['V1', 'implementation'], ['V2', 'environment'], ['V3', 'environment']], /V3 no está roja/],
    [[['V1', 'implementation']], /faltan las filas rojas V2/],
    [[['V1', 'bug'], ['V2', 'environment']], /clase/],
  ] as Array<[Array<[string, string]>, RegExp]>) {
    const r = phaseWith(a.s, a.receipt, cls)
    assert.deepEqual([r.code, r.out.code], [2, 'classification_invalid'], JSON.stringify(r.out))
    assert.match(r.out.message, cause)
  }
  assert.equal(fakeCalls(a.s).length, 1)
  // Implementación con entorno: el fix lleva solo la fila de implementación.
  const fix = phaseWith(a.s, a.receipt, [['V1', 'implementation'], ['V2', 'environment']])
  assert.equal(fix.out.kind, 'fix', JSON.stringify(fix.out))
  runBin(a.s, ['wait', fix.out.id, '--max', '30'])
  const prompt = fakePrompts(a.s).at(-1)!
  assert.match(prompt, /### V1\n/)
  assert.doesNotMatch(prompt, /### V2\n/)
  assert.match(prompt, /Clase: implementation\. Razón del conductor: f devuelve 3/)
  // La clasificación queda registrada una sola vez: otra distinta para el mismo recibo se rechaza.
  const other = phaseWith(a.s, a.receipt, [['V1', 'environment'], ['V2', 'environment']])
  assert.notEqual(other.code, 0)

  // Contrato: no hay fix, y enmendar Verification vence el gate del plan.
  const b = redFlow(rows)
  const contract = phaseWith(b.s, b.receipt, [['V1', 'implementation'], ['V2', 'contract']])
  assert.deepEqual([contract.code, contract.out.code], [2, 'no_fix'], JSON.stringify(contract.out))
  assert.match(contract.out.next, /enmienda ## Verification/)
  const plan = join(b.s.repo, '.plans', 'f', 'plan.md')
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('process.exit(1)', 'process.exit(0)'))
  const gates = runBin(b.s, ['sdd', 'status', 'f']).out.gates
  assert.equal(gates.find((g: { gate: string }) => g.gate === 'plan').state, 'stale')
  assert.equal(fakeCalls(b.s).length, 1)

  // Diseño: la cadena se cierra con back_to_plan.
  const c = redFlow(rows)
  const design = phaseWith(c.s, c.receipt, [['V1', 'implementation'], ['V2', 'design']])
  assert.deepEqual([design.code, design.out.code], [2, 'back_to_plan'], JSON.stringify(design.out))
  const imp = JSON.parse(readFileSync(join(c.s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).implement
  assert.equal(imp.chains[0].terminal.code, 'back_to_plan')

  // Solo entorno: repetir verify.
  const d = redFlow(rows)
  const env = phaseWith(d.s, d.receipt, [['V1', 'environment'], ['V2', 'environment']])
  assert.deepEqual([env.code, env.out.code], [2, 'no_fix'], JSON.stringify(env.out))
  assert.match(env.out.next, /corre de nuevo \.\/bin\/sdd-ai sdd verify f/)

  // Más propuestas: una fila que no se pudo lanzar es del entorno; una confirmación refutada, del contrato.
  const unavailable = { ...BUILD_ROW('V4', 0), argv: ['/nonexistent/sdd-ai-sin-binario'] }
  const refuted = {
    id: 'V5', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert', obligation_reason: 'fixture de cadena',
    argv: [process.execPath, '--test', '--test-reporter=tap', 'test/b.test.ts'], timeout_ms: 30000, expect: { exit_code: 0 },
    implementation_paths: ['src/a.ts'], test_paths: ['test/b.test.ts'], test_name: 'b pasa', report_format: 'tap',
  }
  const e = chainSetup({ writers: [{ actions: [
    { write: 'src/a.ts', content: 'export const f = () => 3\n' },
    { write: 'test/b.test.ts', content: "import { test } from 'node:test'\ntest('b pasa', () => {})\n" },
  ], report: implReport(['T1']) }] })
  chainFlow(e, { rows: [(await import('./helpers.ts')).F_ROW, unavailable, refuted] })
  runBin(e, ['wait', runBin(e, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  markAll(e)
  const redE = runBin(e, ['sdd', 'verify', 'f'])
  const askE = runBin(e, ['sdd', 'phase', 'f'])
  assert.equal(askE.out.code, 'classification_required', JSON.stringify(askE.out))
  assert.match(askE.out.detail, /V1: implementation/)
  assert.match(askE.out.detail, /V4: environment/)
  assert.match(askE.out.detail, /V5: contract/)
  // Una razón vacía no se admite.
  const blank = join(e.repo, '.plans', 'f', 'classes-blank.json')
  writeFileSync(blank, JSON.stringify({ receipt: redE.out.receipt, rows: [['V1', 'implementation'], ['V4', 'environment'], ['V5', 'contract']].map(([row, c]) => ({ row, class: c, reason: row === 'V1' ? '  ' : 'r' })) }))
  const noReason = runBin(e, ['sdd', 'phase', 'f', '--classes', blank])
  assert.deepEqual([noReason.code, noReason.out.code], [2, 'classification_invalid'], JSON.stringify(noReason.out))
  assert.match(noReason.out.message, /razón/)
  assert.equal(fakeCalls(e).length, 1)
})

test('congela todos los defectos y limita bytes sin perder filas', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `V${i + 1}`)
  const a = redFlow(ids.map(LOUD_ROW), [{ actions: [{ write: 'src/c.ts', content: 'c\n' }], report: fixReport(ids) }])
  const fix = runBin(a.s, ['sdd', 'phase', 'f', '--classes', classesFile(a.s, a.receipt, ids.map((id) => [id, 'implementation']))])
  assert.equal(fix.out.kind, 'fix', JSON.stringify(fix.out))
  const w = runBin(a.s, ['wait', fix.out.id, '--max', '30'])
  // El encargo congelado entra en el tope con su envoltorio, y trae todas las filas con comando, código y extracto.
  const frozen = readFileSync(join(storeOf(a.s, fix.out.id), 'prompt.md'), 'utf8')
  assert.ok(Buffer.byteLength(frozen) <= 64 * 1024, String(Buffer.byteLength(frozen)))
  for (const id of ids) assert.match(frozen, new RegExp(`### ${id}\\n- Comando: .*\\n- Código de salida: 1\\n- Extracto: exit 1; `))
  const control = JSON.parse(readFileSync(join(storeOf(a.s, fix.out.id), 'control.json'), 'utf8'))
  assert.deepEqual(control.phase.fix.trimmed, ids)
  assert.deepEqual(control.phase.fix.rows.map((r: { id: string }) => r.id), ids)
  assert.ok(w.out.warnings.some((x: string) => /recortó los tramos/.test(x)), JSON.stringify(w.out.warnings))

  // Si ni sin tramos entra, no hay corrida: se orienta a la toma.
  const b = redFlow(ids.map(LOUD_ROW))
  const file = join(b.s.repo, '.plans', 'f', 'classes-big.json')
  writeFileSync(file, JSON.stringify({ receipt: b.receipt, rows: ids.map((row) => ({ row, class: 'implementation', reason: 'r'.repeat(4000) })) }))
  const over = runBin(b.s, ['sdd', 'phase', 'f', '--classes', file])
  assert.deepEqual([over.code, over.out.code], [2, 'fix_over_budget'], JSON.stringify(over.out))
  assert.match(over.out.next, /--takeover/)
  assert.equal(fakeCalls(b.s).length, 1)
})
