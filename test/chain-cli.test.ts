import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChainSetup, chainFlow, chainSetup, fakeCalls, fakePrompts, runBin } from './helpers.ts'
import { readFlow } from '../src/sdd/read.ts'

// Las cadenas de writers de `implement`, de punta a punta por el binario, con el CLI falso y sus sesiones
// en directorios temporales.

const storeOf = (s: ChainSetup, id: string) => join(s.repo, '.git', 'sdd-ai', 'runs', id)
const controlOf = (s: ChainSetup, id: string) => JSON.parse(readFileSync(join(storeOf(s, id), 'control.json'), 'utf8'))
const writeControl = (s: ChainSetup, id: string, c: unknown) => writeFileSync(join(storeOf(s, id), 'control.json'), JSON.stringify(c))
const promptFile = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(file, 'Encargo de prueba.\n')
  return file
}

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

/** El reporte de una corrida de implement con completitud explícita, antes de la marca de fin. */
const implReport = (done: string[], pending: string[] = []) => `Hice lo que pude.\n\n${JSON.stringify({
  phase: 'implement', missing_context: [],
  tasks: [...done.map((id) => ({ id, completion: 'done' })), ...pending.map((id) => ({ id, completion: 'pending' }))]
    .map((t) => ({ ...t, change_kind: 'behavior_change', changed: t.completion === 'done' ? 'hecho' : 'no llegué', deviation: null, check: 'V1' })),
})}\n\nSTATUS: done\n`

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

const fixReport = (rows: string[]) => `Corregí.\n\n${JSON.stringify({ phase: 'fix', missing_context: [], rows: rows.map((id) => ({ id, changed: 'la suma', deviation: null })) })}\n\nSTATUS: done\n`
const markAll = (s: ChainSetup) => {
  const file = join(s.repo, '.plans', 'f', 'tasks.md')
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'))
}
const classesFile = (s: ChainSetup, receipt: string, rows: Array<[string, string]>) => {
  const file = join(s.repo, '.plans', 'f', `classes-${receipt}.json`)
  writeFileSync(file, JSON.stringify({ receipt, rows: rows.map(([row, c]) => ({ row, class: c, reason: 'f devuelve 3' })) }))
  return file
}

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

test('la toma declara el arbol y cierra la cadena del writer', () => {
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) }] })
  chainFlow(s)
  const first = runBin(s, ['sdd', 'phase', 'f'])
  runBin(s, ['wait', first.out.id, '--max', '30'])
  markAll(s)
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.green, false)
  // El conductor corrige a mano: verify no corre sobre un árbol que no declaró.
  writeFileSync(join(s.repo, 'src', 'a.ts'), 'export const f = () => 2\n')
  const refused = runBin(s, ['sdd', 'verify', 'f'])
  assert.deepEqual([refused.code, refused.out.code, refused.out.detail], [2, 'tree_not_harvest', 'src/a.ts'], JSON.stringify(refused.out))
  assert.match(refused.out.next, /--takeover/)
  const receipts = () => JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).verify.receipts.length
  assert.equal(receipts(), 1, 'la negativa no publicó ningún recibo')

  const taken = runBin(s, ['sdd', 'verify', 'f', '--takeover', '--reason', 'corregí la suma a mano'])
  assert.equal(taken.out.green, true, JSON.stringify(taken.out))
  const record = () => JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).implement
  let imp = record()
  const [chain] = imp.chains
  assert.deepEqual([chain.entries.at(-1).kind, chain.entries.at(-1).parent, chain.entries.at(-1).reason, chain.terminal.code],
    ['takeover', first.out.id, 'corregí la suma a mano', 'takeover'])
  const receipt = JSON.parse(readFileSync(join(s.repo, '.git', 'sdd-ai', 'verify', taken.out.receipt, 'receipt.json'), 'utf8'))
  assert.equal(receipt.writer.takeover, chain.entries.at(-1).id)

  // Una edición nueva exige otra toma, encadenada a la anterior.
  writeFileSync(join(s.repo, 'src', 'a.ts'), 'export const f = () => 5\n')
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'tree_not_harvest')
  const second = runBin(s, ['sdd', 'verify', 'f', '--takeover'])
  assert.equal(second.out.green, false)
  imp = record()
  assert.deepEqual(imp.chains[0].entries.slice(-2).map((e: { kind: string }) => e.kind), ['takeover', 'takeover'])
  assert.equal(imp.chains[0].entries.at(-1).parent, imp.chains[0].entries.at(-2).id)
  // Con la cadena cerrada por la toma no hay fix: el rojo lo resuelve el conductor.
  const cls = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, second.out.receipt, [['V1', 'implementation']])])
  assert.equal(cls.code, 2, JSON.stringify(cls.out))
  assert.match(cls.out.next, /--takeover/)
  assert.equal(fakeCalls(s).length, 1, 'ningún writer después de la toma')
  // Un mapa de toma alterado o ausente no acredita el árbol: verify no lo puede comparar y se niega.
  const mapFile = join(s.repo, '.git', 'sdd-ai', imp.chains[0].entries.at(-1).map.ref)
  writeFileSync(mapFile, readFileSync(mapFile, 'utf8').replace('{', '{"src/x.ts":"100644 0",'))
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'tree_not_harvest')
  rmSync(mapFile)
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'tree_not_harvest')

  // Un flujo sin writer de fase no tiene nada que tomar.
  const inline = chainSetup()
  chainFlow(inline)
  markAll(inline)
  assert.equal(runBin(inline, ['sdd', 'verify', 'f', '--takeover']).out.code, 'usage')
})

test('orienta de cosecha a verify y revisa solo el verde vigente', () => {
  const s = chainSetup({
    writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) },
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) },
    ],
  })
  chainFlow(s)
  const status = () => runBin(s, ['sdd', 'status', 'f']).out.next
  const first = runBin(s, ['sdd', 'phase', 'f'])
  const w1 = runBin(s, ['wait', first.out.id, '--max', '30'])
  // Una cosecha completa va a verify, no a la revisión.
  assert.match(w1.out.next, /sdd verify f/)
  assert.doesNotMatch(w1.out.next, /review start/)
  assert.match(status().detail, /marca en tasks.md las tasks acreditadas \(T1\)/)
  markAll(s)
  assert.deepEqual([status().step, status().command], ['verify', './bin/sdd-ai sdd verify f'])
  const red = runBin(s, ['sdd', 'verify', 'f'])
  // Un rojo va a clasificar y resolver, nunca a la revisión.
  const afterRed = status()
  assert.deepEqual([afterRed.step, afterRed.command], ['verify', `./bin/sdd-ai sdd phase f --classes .plans/f/classes-${red.out.receipt}.json`], JSON.stringify(afterRed))
  // Con las propuestas y la plantilla del archivo de clases.
  assert.match(afterRed.detail, /V1: implementation/)
  assert.match(afterRed.detail, /plantilla: /)
  assert.doesNotMatch(JSON.stringify(afterRed), /review start/)
  const fix = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, red.out.receipt, [['V1', 'implementation']])])
  const w2 = runBin(s, ['wait', fix.out.id, '--max', '30'])
  assert.match(w2.out.next, /sdd verify f/)
  assert.doesNotMatch(w2.out.next, /review start/)
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.green, true)
  // El verde vigente propone una sola revisión, del candidato acumulado de la última cosecha.
  const green = status()
  assert.deepEqual([green.step, green.command], ['review_and_commit', `./bin/sdd-ai review start --harvest ${fix.out.id} --base ${s.base} --author codex --flow f`], JSON.stringify(green))
  // Sin el control del writer no hay comando de revisión que armar: la consulta dice qué falta.
  const fixControl = join(storeOf(s, fix.out.id), 'control.json')
  const saved = readFileSync(fixControl, 'utf8')
  writeFileSync(fixControl, '{')
  const noControl = status()
  assert.match(noControl.detail ?? '', /no se pudo leer el control/, JSON.stringify(noControl))
  assert.equal(noControl.command, undefined)
  writeFileSync(fixControl, saved)
  // Si la cadena no se puede leer, las consultas lo dicen en vez de proponer el comando de un writer suelto.
  writeFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), '{')
  const broken = status()
  assert.match(broken.detail ?? '', /no se pudo leer la cadena del writer/, JSON.stringify(broken))
  assert.doesNotMatch(JSON.stringify(broken), /review start/)
  assert.match(runBin(s, ['wait', fix.out.id, '--max', '30']).out.next, /revisa el registro de fases/)
})

const BUILD_ROW = (id: string, code: number) => ({
  id, acs: ['AC-1'], kind: 'build', obligation: 'none', obligation_reason: 'fixture de cadena',
  argv: [process.execPath, '-e', `process.exit(${code})`], timeout_ms: 30000, expect: { exit_code: 0 },
})

/** Un flujo con el writer inicial ya cosechado, las tasks marcadas y un recibo final rojo. */
function redFlow(rows: unknown[], writers: object[] = []): { s: ChainSetup; receipt: string; first: string } {
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) }, ...writers] })
  chainFlow(s, { rows })
  const first = runBin(s, ['sdd', 'phase', 'f']).out.id
  runBin(s, ['wait', first, '--max', '30'])
  markAll(s)
  const red = runBin(s, ['sdd', 'verify', 'f'])
  assert.equal(red.out.green, false, JSON.stringify(red.out))
  return { s, receipt: red.out.receipt, first }
}

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

const LOUD_ROW = (id: string) => ({
  id, acs: ['AC-1'], kind: 'build', obligation: 'none', obligation_reason: 'fixture de cadena',
  argv: [process.execPath, '-e', `process.stdout.write('${id}-'.repeat(3000)); process.exit(1)`], timeout_ms: 30000, expect: { exit_code: 0 },
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

const registry = (s: ChainSetup) => JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8'))

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

test('exige completitud explicita y rechaza contratos mal formados', () => {
  // Un contrato sin completion no se admite: la cosecha no es padre de nada.
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'x\n' }], report: `Hecho.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: [{ id: 'T1', change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'V1' }] })}\n\nSTATUS: done\n` }] })
  chainFlow(s)
  const first = runBin(s, ['sdd', 'phase', 'f'])
  const w = runBin(s, ['wait', first.out.id, '--max', '30'])
  assert.ok(w.out.failed.some((f: string) => /contrato de la fase no se admitió: .*completion/.test(f)), JSON.stringify(w.out.failed))
  assert.match(w.out.next, /contrato del writer no se admitió/)
  assert.equal(runBin(s, ['sdd', 'phase', 'f']).out.code, 'chain_closed')
  // Con completion, la prosa no cuenta: pending sigue pendiente aunque el reporte diga que terminó.
  const p = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'x\n' }], report: `Terminé todo.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: [{ id: 'T1', completion: 'pending', change_kind: 'behavior_change', changed: 'casi', deviation: null, check: 'V1' }] })}\n\nSTATUS: done\n` }] })
  chainFlow(p)
  const wp = runBin(p, ['wait', runBin(p, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  assert.deepEqual([wp.out.partial, wp.out.left], [true, ['T1']])
})

test('valida el padre y las huellas antes de lanzar', async () => {
  const { F_ROW, approveFlowGates } = await import('./helpers.ts')
  const git = (s: ChainSetup, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: s.repo, encoding: 'utf8' }).trim()
  // Un árbol editado después de la cosecha: la continuación se niega, nombra la ruta y no toca nada.
  const partial = () => {
    const s = chainSetup({ writers: [{ actions: [{ write: 'src/t1.ts', content: '1\n' }], report: implReport(['T1'], ['T2']) }, { hang: true, report: implReport(['T2']) }, {}] })
    chainFlow(s, { tasks: 2 })
    runBin(s, ['wait', runBin(s, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
    return s
  }
  const a = partial()
  writeFileSync(join(a.repo, 'src', 'mia.ts'), 'mía\n')
  const edited = runBin(a, ['sdd', 'phase', 'f'])
  assert.deepEqual([edited.code, edited.out.code, edited.out.detail], [2, 'tree_not_parent', 'src/mia.ts'], JSON.stringify(edited.out))
  assert.equal(readFileSync(join(a.repo, 'src', 'mia.ts'), 'utf8'), 'mía\n')
  assert.equal(fakeCalls(a).length, 1)

  // HEAD movido: la cadena no sigue.
  const b = partial()
  git(b, 'add', '-A')
  git(b, 'commit', '-qm', 'a mano')
  assert.equal(runBin(b, ['sdd', 'phase', 'f']).out.code, 'head_moved')

  // Dos lanzamientos sobre el mismo padre: el segundo se niega mientras el primero corre.
  const c = partial()
  const first = runBin(c, ['sdd', 'phase', 'f'])
  assert.equal(first.code, 0, JSON.stringify(first.out))
  const second = runBin(c, ['sdd', 'phase', 'f'])
  assert.equal(second.out.code, 'phase_running', JSON.stringify(second.out))
  runBin(c, ['cancel', first.out.id])
  runBin(c, ['wait', first.out.id, '--max', '30'])

  // El recibo tiene que ser el último, íntegro y del candidato de ahora.
  const d = redFlow([F_ROW])
  const receiptFile = join(d.s.repo, '.git', 'sdd-ai', 'verify', d.receipt, 'receipt.json')
  const original = readFileSync(receiptFile, 'utf8')
  writeFileSync(receiptFile, original.replace('"green": false', '"green": false '))
  assert.equal(runBin(d.s, ['sdd', 'phase', 'f', '--classes', classesFile(d.s, d.receipt, [['V1', 'implementation']])]).out.code, 'receipt_not_red')
  writeFileSync(receiptFile, original)
  writeFileSync(join(d.s.repo, 'src', 'otra.ts'), 'x\n')
  assert.equal(runBin(d.s, ['sdd', 'phase', 'f', '--classes', classesFile(d.s, d.receipt, [['V1', 'implementation']])]).out.code, 'receipt_not_red')
  assert.equal(fakeCalls(d.s).length, 1)
  // Un recibo que ya no es el último: verify corrió otra vez sobre el mismo candidato.
  const g = redFlow([F_ROW])
  const newer = runBin(g.s, ['sdd', 'verify', 'f'])
  assert.notEqual(newer.out.receipt, g.receipt)
  const stale = runBin(g.s, ['sdd', 'phase', 'f', '--classes', classesFile(g.s, g.receipt, [['V1', 'implementation']])])
  assert.equal(stale.out.code, 'classification_invalid', JSON.stringify(stale.out))
  assert.equal(fakeCalls(g.s).length, 1)
  // HEAD movido después del recibo: la corrección no se lanza.
  const h = redFlow([F_ROW])
  git(h.s, 'add', '-A')
  git(h.s, 'commit', '-qm', 'a mano')
  const moved = runBin(h.s, ['sdd', 'phase', 'f', '--classes', classesFile(h.s, h.receipt, [['V1', 'implementation']])])
  assert.deepEqual([moved.code, moved.out.code], [2, 'head_moved'], JSON.stringify(moved.out))
  assert.equal(fakeCalls(h.s).length, 1)
  // La huella del plan cambió y se reaprobó: el recibo de antes ya no sirve para corregir.
  const k = redFlow([F_ROW])
  const plan = join(k.s.repo, '.plans', 'f', 'plan.md')
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('Uno.', 'Uno, con otra huella.'))
  approveFlowGates(k.s.repo, Date.parse('2026-09-30T01:00:00.000Z'))
  const replanned = runBin(k.s, ['sdd', 'phase', 'f', '--classes', classesFile(k.s, k.receipt, [['V1', 'implementation']])])
  assert.equal(replanned.out.code, 'receipt_not_red', JSON.stringify(replanned.out))
  assert.equal(fakeCalls(k.s).length, 1)
  // Una familia que no se resuelve no deja una entrada registrada sin control.
  const q = chainSetup({ writers: [{ report: implReport(['T1']) }] })
  chainFlow(q)
  writeFileSync(join(q.repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [nada]\n  selection: full\n')
  const unresolved = runBin(q, ['sdd', 'phase', 'f'])
  assert.equal(unresolved.code, 2, JSON.stringify(unresolved.out))
  const qPhases = join(q.repo, '.plans', 'f', 'sdd-ai-phases.json')
  assert.equal(existsSync(qPhases) ? (JSON.parse(readFileSync(qPhases, 'utf8')).implement?.chains.length ?? 0) : 0, 0)
  assert.equal(fakeCalls(q).length, 0)

  // Un registro alterado durante la corrida invalida la entrega sin perder el vínculo con la fase.
  const e = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'x\n' }, { append: '.plans/f/sdd-ai-phases.json', content: ' ' }], report: implReport(['T1']) }] })
  chainFlow(e)
  const run = runBin(e, ['sdd', 'phase', 'f']).out.id
  const w = runBin(e, ['wait', run, '--max', '30'])
  assert.ok(w.out.failed.some((f: string) => /insumos/.test(f)), JSON.stringify(w.out.failed))
  assert.equal(JSON.parse(readFileSync(join(storeOf(e, run), 'control.json'), 'utf8')).phase.flow, 'f')
  assert.match(w.out.next, /toma/)

  // Una entrada registrada sin control: status orienta a cancel, cancel la marca y la cadena relanza su inicial.
  const o = chainSetup({ writers: [{ report: implReport(['T1']) }] })
  chainFlow(o)
  const phases = join(o.repo, '.plans', 'f', 'sdd-ai-phases.json')
  const ghost = '20260929-2359-dead'
  writeFileSync(phases, JSON.stringify({ schema_version: 1, last_run: null, phases: {}, implement: { schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'implement', run: ghost, parent: null, at: '2026-09-29T23:59:00.000Z', pending: ['T1'] }], terminal: null }], classifications: [], events: [] } }))
  assert.equal(runBin(o, ['sdd', 'status', 'f']).out.next.command, `./bin/sdd-ai cancel ${ghost}`)
  assert.equal(runBin(o, ['cancel', ghost]).out.state, 'launch_failed')
  // Cancelarla otra vez no agrega otro evento: la entrada ya está marcada.
  assert.equal(runBin(o, ['cancel', ghost]).out.state, 'launch_failed')
  assert.equal(JSON.parse(readFileSync(phases, 'utf8')).implement.events.length, 1)
  const relaunch = runBin(o, ['sdd', 'phase', 'f'])
  assert.deepEqual([relaunch.code, relaunch.out.chain, relaunch.out.kind], [0, 'c1', 'implement'], JSON.stringify(relaunch.out))
  // El relanzamiento conserva la base que registró la entrada: con HEAD movido después, se niega.
  const m = chainSetup({ writers: [{ report: implReport(['T1']) }] })
  chainFlow(m)
  const lost = '20260929-2358-beef'
  const at0 = '2026-09-29T23:58:00.000Z'
  writeFileSync(join(m.repo, '.plans', 'f', 'sdd-ai-phases.json'), JSON.stringify({ schema_version: 1, last_run: null, phases: {}, implement: {
    schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'implement', run: lost, parent: null, base: m.base, at: at0, pending: ['T1'] }], terminal: null }],
    classifications: [], events: [{ kind: 'launch_failed', at: at0, chain: 'c1', run: lost, detail: 'no arrancó' }],
  } }))
  git(m, 'commit', '--allow-empty', '-qm', 'otro')
  const rebased = runBin(m, ['sdd', 'phase', 'f'])
  assert.deepEqual([rebased.code, rebased.out.code], [2, 'head_moved'], JSON.stringify(rebased.out))
  assert.equal(fakeCalls(m).length, 0)
})

/**
 * Un writer de fase como los de antes de las cadenas, activo al adoptar el cambio: mientras corre, su control
 * pierde el kind y el registro la clave implement; al terminar, su cosecha queda sin entries ni delta.
 */
function legacyFlow(tasks: number, writer: object): { s: ChainSetup; run: string } {
  const go = join(mkdtempSync(join(tmpdir(), 'sdd-ai-go-')), 'seguir')
  const s = chainSetup({ writers: [{ ...writer, waitFor: go }] })
  chainFlow(s, { tasks })
  const run = runBin(s, ['sdd', 'phase', 'f']).out.id
  const control = JSON.parse(readFileSync(join(storeOf(s, run), 'control.json'), 'utf8'))
  const { flow, pending, inputs, handoff_header } = control.phase
  writeControl(s, run, { ...control, phase: { flow, pending, inputs, handoff_header } })
  const phases = join(s.repo, '.plans', 'f', 'sdd-ai-phases.json')
  const { implement: _i, ...rest } = JSON.parse(readFileSync(phases, 'utf8'))
  writeFileSync(phases, JSON.stringify(rest))
  writeFileSync(go, '')
  runBin(s, ['wait', run, '--max', '30'])
  const harvest = join(storeOf(s, run), 'harvest.json')
  const { entries: _e, delta: _d, ...old } = JSON.parse(readFileSync(harvest, 'utf8'))
  writeFileSync(harvest, JSON.stringify(old))
  return { s, run }
}

const oldReport = (ids: string[]) => `Hice el cambio.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: ids.map((id) => ({ id, change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'c' })) })}\n\nSTATUS: done\n`

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

test('la cadena no introduce estados gates ni operaciones git automaticas', () => {
  const s = chainSetup({
    writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) },
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) },
    ],
  })
  chainFlow(s)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: s.repo, encoding: 'utf8' }).trim()
  const dir = join(s.repo, '.plans', 'f')
  const handoff = readFileSync(join(dir, 'handoff.md'), 'utf8')
  const approvals = readFileSync(join(dir, 'sdd-ai-approvals.json'), 'utf8')
  const planHeader = () => { const t = readFileSync(join(dir, 'plan.md'), 'utf8'); return t.slice(0, t.indexOf('\n---\n', 4) + 5) }
  const headerBefore = planHeader()
  const commits = git('rev-list', '--all')
  const steps = new Set<string>()
  const see = () => steps.add(runBin(s, ['sdd', 'status', 'f']).out.next.step)
  const first = runBin(s, ['sdd', 'phase', 'f'])
  runBin(s, ['wait', first.out.id, '--max', '30'])
  see()
  markAll(s)
  see()
  const red = runBin(s, ['sdd', 'verify', 'f'])
  see()
  const fix = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, red.out.receipt, [['V1', 'implementation']])])
  runBin(s, ['wait', fix.out.id, '--max', '30'])
  see()
  runBin(s, ['sdd', 'verify', 'f'])
  see()
  // Los pasos son los del ciclo de siempre, y el header del plan solo pasa por estados conocidos.
  for (const step of steps) assert.ok(['implement', 'verify', 'review_and_commit'].includes(step), step)
  const headerAfter = planHeader()
  const status = /^status: (.*)$/m.exec(headerAfter)![1]
  assert.ok(['planned', 'plan-approved', 'tasks-ready', 'implementing', 'verified', 'committed', 'pushed', 'pr-open', 'done'].includes(status), status)
  // Fuera de status, el header del plan queda byte a byte como estaba.
  assert.equal(headerAfter.replace(/^status: .*$/m, ''), headerBefore.replace(/^status: .*$/m, ''))
  // Nada aprobó un gate, commiteó, stageó ni tocó el handoff.
  assert.equal(readFileSync(join(dir, 'handoff.md'), 'utf8'), handoff)
  assert.equal(readFileSync(join(dir, 'sdd-ai-approvals.json'), 'utf8'), approvals)
  assert.equal(git('rev-list', '--all'), commits)
  assert.equal(git('diff', '--cached', '--name-only'), '')
})

test('cancel no marca como fallida una corrida que llego a su control mientras esperaba el lock', async () => {
  const { spawn } = await import('node:child_process')
  const s = chainSetup({ writers: [{ hang: true, report: implReport(['T1']) }] })
  chainFlow(s)
  const run = runBin(s, ['sdd', 'phase', 'f']).out.id
  // El supervisor registra el grupo del writer en el control: hasta entonces, el control es suyo.
  for (let i = 0; i < 100 && controlOf(s, run).group === undefined; i++) await new Promise((done) => setTimeout(done, 50))
  assert.ok(controlOf(s, run).group, 'el writer quedó lanzado')
  // La corrida se ve como una entrada sin control: su control se aparta mientras otro proceso tiene el lock del flujo.
  const control = join(storeOf(s, run), 'control.json')
  renameSync(control, `${control}.aparte`)
  const flag = join(mkdtempSync(join(tmpdir(), 'sdd-ai-hold-')), 'soltar')
  const lockTs = join(import.meta.dirname, '..', 'src', 'lock.ts')
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { withLock } from ${JSON.stringify(lockTs)}
import { existsSync } from 'node:fs'
const until = Date.now() + 60000
withLock(${JSON.stringify(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.lock'))}, () => new Error('ocupado'), () => {
  process.stdout.write('tomado\\n')
  while (!existsSync(${JSON.stringify(flag)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
})`])
  // La señal puede llegar partida, y el proceso puede terminar antes de darla: en ese caso la prueba falla.
  await new Promise<void>((done, fail) => {
    let seen = ''
    holder.stdout.on('data', (b: Buffer) => { seen += b.toString('utf8'); if (seen.includes('tomado')) done() })
    holder.on('exit', (code) => fail(new Error(`el proceso que toma el lock terminó antes de tomarlo (${code})`)))
  })
  const out: Buffer[] = []
  const cancel = spawn(join(import.meta.dirname, '..', 'bin', 'sdd-ai'), ['cancel', run], { cwd: s.repo, env: s.env })
  cancel.stdout.on('data', (b: Buffer) => out.push(b))
  const exited = new Promise<void>((done) => cancel.on('close', () => done()))
  // Quien espera un lock deja su archivo `<lock>.<pid>.<azar>.tmp` junto a él: cuando aparece el de cancel, ya
  // vio la entrada sin control y espera. Recién ahí el lanzamiento termina y deja su control.
  const waiting = () => readdirSync(join(s.repo, '.plans', 'f')).some((f) => f.startsWith(`sdd-ai-approvals.lock.${cancel.pid}.`))
  try {
    for (let i = 0; i < 200 && !waiting(); i++) await new Promise((done) => setTimeout(done, 25))
    assert.ok(waiting(), 'cancel quedó esperando el lock del flujo')
    renameSync(`${control}.aparte`, control)
  } finally {
    // También si la prueba falla: el lock se suelta y el control vuelve a su lugar.
    if (existsSync(`${control}.aparte`)) renameSync(`${control}.aparte`, control)
    writeFileSync(flag, '')
  }
  await exited
  const result = JSON.parse(Buffer.concat(out).toString('utf8'))
  assert.notEqual(result.state, 'launch_failed', JSON.stringify(result))
  assert.deepEqual(registry(s).implement.events, [])
  runBin(s, ['wait', run, '--max', '30'])
})
