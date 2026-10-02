import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chainFlow, chainSetup, fakeCalls, runBin } from './helpers.ts'
import { storeOf, controlOf, writeControl, promptFile, implReport, fixReport, markAll, classesFile } from './chain-cli-fixture.ts'

test('retry rechaza todo writer de fase incluso antiguo y orienta a sdd phase', () => {
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }] }, {}, {}] })
  chainFlow(s)
  const launched = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(launched.code, 0, JSON.stringify(launched.out))
  const id = launched.out.id
  runBin(s, ['wait', id, '--max', '30'])
  const before = fakeCalls(s).length
  const refused = (label: string) => {
    const r = runBin(s, ['run', '--retry', id])
    assert.deepEqual([r.code, r.out.code, r.out.next], [2, 'phase_writer', './bin/sdd-ai sdd phase f'], label)
  }
  refused('writer inicial')
  const control = controlOf(s, id)
  // Un control anterior a las cadenas, sin kind, también se reconoce por su vínculo con la fase.
  const { kind: _k, chain: _c, parent: _p, launch_from: _l, session_origin: _o, registry: _r, ...legacy } = control.phase
  writeControl(s, id, { ...control, phase: legacy })
  refused('writer anterior')
  writeControl(s, id, { ...control, phase: { ...control.phase, kind: 'fix', parent: 'x' } })
  refused('corrida encadenada')
  // Ninguna negativa invocó al writer.
  assert.equal(fakeCalls(s).length, before)

  // Un writer suelto se sigue relanzando.
  const loose = chainSetup({ writers: [{}, {}] })
  const first = runBin(loose, ['run', '--role', 'implement', '--prompt-file', promptFile()])
  runBin(loose, ['wait', first.out.id, '--max', '30'])
  const again = runBin(loose, ['run', '--retry', first.out.id])
  assert.equal(again.code, 0, JSON.stringify(again.out))
  runBin(loose, ['wait', again.out.id, '--max', '30'])
  assert.equal(fakeCalls(loose).length, 2)
})

test('completa parciales con continuaciones y bloques limitados por progreso', () => {
  const recall = join(mkdtempSync(join(tmpdir(), 'sdd-ai-recall-')), 'recall')
  const s = chainSetup({
    writers: [
      // El writer inicial hace T1 y deja T2 a T5.
      { actions: [{ write: 'src/t1.ts', content: '1\n' }], report: implReport(['T1'], ['T2', 'T3', 'T4', 'T5']), remember: 'GIRASOL' },
      // La continuación reanuda la sesión, recuerda y hace T2.
      { actions: [{ write: 'src/t2.ts', content: '2\n' }], report: implReport(['T2'], ['T3', 'T4', 'T5']), recall },
      // Otra continuación que declara todo hecho sin tocar el árbol: no acredita ni progresa.
      { report: implReport(['T3', 'T4', 'T5']) },
      // Un bloque con sesión nueva hace T3 y T4 de sus tres.
      { actions: [{ write: 'src/t3.ts', content: '3\n' }, { write: 'src/t4.ts', content: '4\n' }], report: implReport(['T3', 'T4'], ['T5']) },
      // Otro bloque hace T5.
      { actions: [{ write: 'src/t5.ts', content: '5\n' }], report: implReport(['T5']) },
    ],
  })
  chainFlow(s, { tasks: 5 })
  const phase = (...extra: string[]) => runBin(s, ['sdd', 'phase', 'f', ...extra])
  const wait = (id: string) => runBin(s, ['wait', id, '--max', '30'])

  const r1 = phase()
  assert.equal(r1.code, 0, JSON.stringify(r1.out))
  assert.deepEqual([r1.out.kind, r1.out.pending], ['implement', ['T1', 'T2', 'T3', 'T4', 'T5']])
  const w1 = wait(r1.out.id)
  assert.deepEqual([w1.out.partial, w1.out.left], [true, ['T2', 'T3', 'T4', 'T5']], JSON.stringify(w1.out))
  assert.ok(w1.out.failed.some((f: string) => /cosecha parcial: quedan T2/.test(f)))
  assert.doesNotMatch(w1.out.next, /review start/)
  assert.match(w1.out.next, /sigue con T2, T3, T4, T5/)

  const r2 = phase()
  assert.equal(r2.code, 0, JSON.stringify(r2.out))
  assert.deepEqual([r2.out.kind, r2.out.pending], ['continuation', ['T2', 'T3', 'T4', 'T5']])
  const w2 = wait(r2.out.id)
  assert.deepEqual(w2.out.left, ['T3', 'T4', 'T5'], JSON.stringify(w2.out))
  // La continuación reanudó la misma sesión: el writer recordó lo del primer turno.
  const calls = fakeCalls(s)
  assert.ok(calls[1].includes('resume'), JSON.stringify(calls[1]))
  assert.equal(readFileSync(recall, 'utf8'), 'GIRASOL')

  const r3 = phase()
  assert.equal(r3.code, 0, JSON.stringify(r3.out))
  const w3 = wait(r3.out.id)
  assert.deepEqual([w3.out.left, w3.out.delta], [['T3', 'T4', 'T5'], []], JSON.stringify(w3.out))
  assert.ok(w3.out.failed.includes('sin cambios frente a su padre'))
  // Sin progreso no se ofrece otra continuación: bloques o toma.
  const again = phase()
  assert.deepEqual([again.code, again.out.code], [2, 'no_progress'], JSON.stringify(again.out))
  assert.match(again.out.next, /--blocks/)

  const b1 = phase('--blocks')
  assert.equal(b1.code, 0, JSON.stringify(b1.out))
  assert.deepEqual([b1.out.kind, b1.out.pending], ['block', ['T3', 'T4', 'T5']])
  assert.deepEqual(wait(b1.out.id).out.left, ['T5'])
  assert.ok(!fakeCalls(s)[3].includes('resume'), 'el bloque abre una sesión nueva')
  const b2 = phase('--blocks')
  assert.deepEqual(b2.out.pending, ['T5'])
  const w5 = wait(b2.out.id)
  assert.deepEqual(w5.out.left, [], JSON.stringify(w5.out))
  // El candidato acumulado trae los cambios de todas las corridas.
  assert.deepEqual(w5.out.files.map((f: { path: string }) => f.path).sort(), ['src/t1.ts', 'src/t2.ts', 'src/t3.ts', 'src/t4.ts', 'src/t5.ts'])
  // Ninguna continuación ni bloque gastó el cupo de correcciones.
  const imp = JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).implement
  assert.deepEqual(imp.chains[0].entries.map((e: { kind: string }) => e.kind), ['implement', 'continuation', 'continuation', 'block', 'block'])
  assert.equal(imp.chains[0].terminal, null)

  // Un bloque que no completa ninguna task nueva cierra la cadena: el supervisor escribe no_progress al cosechar.
  const n = chainSetup({ writers: [
    { actions: [{ write: 'src/t1.ts', content: '1\n' }], report: implReport(['T1'], ['T2']) },
    { report: implReport([], ['T2']) },
  ] })
  chainFlow(n, { tasks: 2 })
  runBin(n, ['wait', runBin(n, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  const blk = runBin(n, ['sdd', 'phase', 'f', '--blocks'])
  runBin(n, ['wait', blk.out.id, '--max', '30'])
  assert.equal(JSON.parse(readFileSync(join(n.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).implement.chains[0].terminal.code, 'no_progress')
  assert.equal(runBin(n, ['sdd', 'phase', 'f']).out.code, 'chain_closed')
})

test('encadena sesiones y conserva el diff acumulado', () => {
  const recall = join(mkdtempSync(join(tmpdir(), 'sdd-ai-recall-')), 'recall')
  const s = chainSetup({
    writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }, { write: 'src/b.ts', content: 'b\n' }], report: implReport(['T1']), remember: 'TRÉBOL' },
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']), recall },
    ],
  })
  chainFlow(s)
  const first = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(first.code, 0, JSON.stringify(first.out))
  const w1 = runBin(s, ['wait', first.out.id, '--max', '30'])
  assert.deepEqual(w1.out.left, [], JSON.stringify(w1.out))
  markAll(s)
  const red = runBin(s, ['sdd', 'verify', 'f'])
  assert.equal(red.out.green, false, JSON.stringify(red.out))
  // Sin clasificar, sdd phase propone la clase por fila y pide el archivo.
  const ask = runBin(s, ['sdd', 'phase', 'f'])
  assert.deepEqual([ask.code, ask.out.code], [2, 'classification_required'], JSON.stringify(ask.out))
  assert.match(ask.out.detail, /V1: implementation/)
  const fix = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, red.out.receipt, [['V1', 'implementation']])])
  assert.equal(fix.code, 0, JSON.stringify(fix.out))
  assert.equal(fix.out.kind, 'fix')
  assert.notEqual(fix.out.id, first.out.id)
  const w2 = runBin(s, ['wait', fix.out.id, '--max', '30'])
  assert.equal(w2.code, 0, JSON.stringify(w2.out))
  // La corrección reanudó la sesión del writer inicial desde el árbol de su cosecha.
  const calls = fakeCalls(s)
  assert.ok(calls[1].includes('resume'), JSON.stringify(calls[1]))
  assert.equal(readFileSync(recall, 'utf8'), 'TRÉBOL')
  // Su cosecha es el acumulado desde la base: los cambios de las dos corridas; su delta, solo lo suyo.
  assert.deepEqual(w2.out.files.map((f: { path: string }) => f.path).sort(), ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(w2.out.delta, ['src/a.ts'])
  assert.deepEqual(w2.out.forced_symptom, [])
  const green = runBin(s, ['sdd', 'verify', 'f'])
  assert.equal(green.out.green, true, JSON.stringify(green.out))
  const imp = JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).implement
  assert.deepEqual(imp.chains[0].entries.map((e: { kind: string; parent: string | null }) => [e.kind, e.parent]), [['implement', null], ['fix', first.out.id]])
  assert.equal(imp.chains[0].entries[1].receipt.id, red.out.receipt)
  assert.equal(imp.classifications[0].rows[0].proposed, 'implementation')
  const control = JSON.parse(readFileSync(join(storeOf(s, fix.out.id), 'control.json'), 'utf8'))
  assert.deepEqual([control.phase.kind, control.phase.parent, control.phase.session_origin], ['fix', first.out.id, first.out.id])
})
