import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chainFlow, chainSetup, runBin } from './helpers.ts'
import { storeOf, implReport, fixReport, markAll, classesFile, BUILD_ROW, redFlow, registry } from './chain-cli-fixture.ts'

test('senala pruebas rojas tocadas solo por el delta de correccion', async () => {
  const { F_ROW } = await import('./helpers.ts')
  // Un fix que toca la prueba de la fila roja: señal.
  const a = redFlow([F_ROW], [{ actions: [{ write: 'test/a.test.ts', content: "import { test } from 'node:test'\ntest('f da 2', () => {})\n" }], report: fixReport(['V1']) }])
  const fa = runBin(a.s, ['sdd', 'phase', 'f', '--classes', classesFile(a.s, a.receipt, [['V1', 'implementation']])])
  assert.deepEqual(runBin(a.s, ['wait', fa.out.id, '--max', '30']).out.forced_symptom, [{ row: 'V1', path: 'test/a.test.ts' }])
  // Uno que solo toca la implementación: sin señal.
  const b = redFlow([F_ROW], [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) }])
  const fb = runBin(b.s, ['sdd', 'phase', 'f', '--classes', classesFile(b.s, b.receipt, [['V1', 'implementation']])])
  assert.deepEqual(runBin(b.s, ['wait', fb.out.id, '--max', '30']).out.forced_symptom, [])
  // El padre ya había tocado la prueba; el fix no: lo heredado no dispara la señal.
  const c = chainSetup({
    writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }, { write: 'test/a.test.ts', content: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n// tocado\n" }], report: implReport(['T1']) },
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) },
    ],
  })
  chainFlow(c, { rows: [F_ROW] })
  runBin(c, ['wait', runBin(c, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  markAll(c)
  const red = runBin(c, ['sdd', 'verify', 'f'])
  const fc = runBin(c, ['sdd', 'phase', 'f', '--classes', classesFile(c, red.out.receipt, [['V1', 'implementation']])])
  const wc = runBin(c, ['wait', fc.out.id, '--max', '30'])
  assert.deepEqual([wc.out.delta, wc.out.forced_symptom], [['src/a.ts'], []])
  // Sin el recibo de entrada la señal no se puede evaluar: va null y la cosecha lo dice, no como una lista vacía.
  const receiptFile = join(c.repo, '.git', 'sdd-ai', 'verify', red.out.receipt, 'receipt.json')
  rmSync(receiptFile)
  const unknown = runBin(c, ['wait', fc.out.id, '--max', '30'])
  assert.equal(unknown.out.forced_symptom, null)
  assert.ok(unknown.out.failed.some((f: string) => /no se pudo evaluar la señal de síntoma forzado/.test(f)), JSON.stringify(unknown.out.failed))
})

test('no verifica entregas interrumpidas ni correcciones vacias', async () => {
  const { F_ROW } = await import('./helpers.ts')
  // Un writer sin marca final: no es candidato; se reanuda.
  const s = chainSetup({
    writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: 'Me cortaron.\n' },
      { report: implReport(['T1']) },
    ],
  })
  chainFlow(s, { rows: [F_ROW] })
  const first = runBin(s, ['sdd', 'phase', 'f'])
  const w = runBin(s, ['wait', first.out.id, '--max', '30'])
  assert.match(w.out.next, new RegExp(`reanuda la corrida ${first.out.id}`))
  assert.doesNotMatch(w.out.next, /review start|^corre \.\/bin\/sdd-ai sdd verify f$/)
  assert.equal(runBin(s, ['sdd', 'phase', 'f', '--blocks']).out.code, 'blocks_not_apt')
  const resumed = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(resumed.code, 0, JSON.stringify(resumed.out))
  const wr = runBin(s, ['wait', resumed.out.id, '--max', '30'])
  // La reanudación se mide con el padre de la corrida original: acredita lo que ya estaba escrito.
  assert.deepEqual([wr.out.delta, wr.out.left], [['src/a.ts'], []], JSON.stringify(wr.out))
  const entries = registry(s).implement.chains[0].entries
  assert.deepEqual([entries[1].kind, entries[1].resumes], ['implement', first.out.id])

  // Un fix vacío no es candidato y gasta su ronda: el siguiente fix sale del mismo recibo.
  const e = redFlow([F_ROW], [{ report: fixReport(['V1']) }, { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) }])
  const f1 = runBin(e.s, ['sdd', 'phase', 'f', '--classes', classesFile(e.s, e.receipt, [['V1', 'implementation']])])
  const w1 = runBin(e.s, ['wait', f1.out.id, '--max', '30'])
  assert.ok(w1.out.failed.includes('sin cambios frente a su padre'))
  assert.match(w1.out.next, /lanza el fix/)
  const f2 = runBin(e.s, ['sdd', 'phase', 'f'])
  assert.equal(f2.out.kind, 'fix', JSON.stringify(f2.out))
  assert.equal(registry(e.s).implement.chains[0].entries.filter((x: { kind: string }) => x.kind === 'fix').length, 2)

  // Un fix cortado se reanuda antes de mirar el recibo, con las mismas filas.
  const g = redFlow([F_ROW], [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: 'me cortaron\n' }, { report: fixReport(['V1']) }])
  const gf = runBin(g.s, ['sdd', 'phase', 'f', '--classes', classesFile(g.s, g.receipt, [['V1', 'implementation']])])
  runBin(g.s, ['wait', gf.out.id, '--max', '30'])
  const gr = runBin(g.s, ['sdd', 'phase', 'f'])
  assert.equal(gr.out.kind, 'fix', JSON.stringify(gr.out))
  const control = JSON.parse(readFileSync(join(storeOf(g.s, gr.out.id), 'control.json'), 'utf8'))
  assert.deepEqual([control.phase.resumes, control.phase.fix.rows.map((r: { id: string }) => r.id)], [gf.out.id, ['V1']])

  // Un recibo rojo sin filas rojas porque una fila escribió en el árbol: defecto del contrato, sin fix.
  const mut = redFlow([{ ...BUILD_ROW('V1', 0), argv: [process.execPath, '-e', "require('node:fs').writeFileSync('src/sucio.ts', 'x')"] }])
  const st = runBin(mut.s, ['sdd', 'status', 'f']).out.next
  assert.match(st.detail, /una fila cambió el árbol: es un defecto del contrato/, JSON.stringify(st))
  assert.equal(runBin(mut.s, ['sdd', 'phase', 'f']).out.code, 'receipt_not_red')
})
