import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SddError } from '../src/types.ts'
import {
  type ChainInput, FIX_PROMPT_BUDGET, type ReceiptFacts, type RunFacts, chainState, checkClassification, derive, failureCounts, planEpoch, proposeClass, redRows, renderContinuationPrompt, renderFixPrompt,
  renderResumePrompt, unattestedRows,
} from '../src/sdd/chain.ts'
import { writerEnvelopeBytes } from '../src/writer.ts'
import type { ChainClass, ChainEntry, ChainTerminal, Classification, RunEntry } from '../src/sdd/phase-state.ts'
import type { RowResult } from '../src/sdd/verify-receipt.ts'
import type { TestRow, CommandRow } from '../src/sdd/verification-contract.ts'

const exec = (row: string, o: Partial<NonNullable<RowResult['execution']>> = {}) => ({
  row, started_at: 'a', ended_at: 'b', argv: ['node'], exit_code: 1, stdout_file: 'o', stderr_file: 'e', stdout_sha256: 'x', stderr_sha256: 'y', excerpt: 'exit 1; x', ...o,
})
const testRow: TestRow = {
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'none', obligation_reason: 'r', argv: ['node'], timeout_ms: 1000, expect: { exit_code: 0 },
  implementation_paths: ['src/a.ts'], test_paths: ['test/a.test.ts'], test_name: 'f da 2', report_format: 'tap',
}
const buildRow: CommandRow = { id: 'V2', acs: ['AC-1'], kind: 'build', obligation: 'none', obligation_reason: 'r', argv: ['node'], timeout_ms: 1000, expect: { exit_code: 0 } }
const tap = (ok: boolean) => `TAP version 13\n# Subtest: f da 2\n${ok ? 'ok' : 'not ok'} 1 - f da 2\n  ---\n  duration_ms: 1\n  ...\n1..1\n`

test('clasificación: el binario propone por regla y deja sin propuesta lo que no encaja', () => {
  assert.equal(proposeClass(testRow, { row: 'V1', outcome: 'failed', execution: exec('V1'), confirmation: { row: 'V1', obligation: 'red_on_revert', state: 'refuted', restored: true } }, tap(true)), 'contract')
  assert.equal(proposeClass(testRow, { row: 'V1', outcome: 'unavailable', execution: exec('V1', { exit_code: null, reason: 'timeout' }) }, null), 'environment')
  assert.equal(proposeClass(testRow, { row: 'V1', outcome: 'failed', execution: exec('V1') }, tap(false)), 'implementation')
  // El test de la fila no aparece en el TAP (un error de carga): sin propuesta.
  assert.equal(proposeClass(testRow, { row: 'V1', outcome: 'failed', execution: exec('V1') }, 'TAP version 13\nnot ok 1 - test/a.test.ts\n'), null)
  // Un build o un lint con salida distinta de cero no encaja en ninguna regla.
  assert.equal(proposeClass(buildRow, { row: 'V2', outcome: 'failed', execution: exec('V2') }, ''), null)
})

test('clasificación: el archivo del conductor clasifica exactamente las filas rojas, con clase y razón', () => {
  const receipt = { id: 'R1', rows: [
    { row: 'V1', outcome: 'failed' as const }, { row: 'V2', outcome: 'unavailable' as const }, { row: 'V3', outcome: 'passed' as const },
    { row: 'V4', outcome: 'unrun' as const, execution: exec('V4', { exit_code: null, reason: 'manual' }) },
  ] }
  assert.deepEqual(redRows(receipt), ['V1', 'V2'])
  // La fila manual sin acreditar queda fuera: se acredita con sdd verify --attest.
  assert.deepEqual(unattestedRows(receipt), ['V4'])
  const ok = checkClassification(receipt, { receipt: 'R1', rows: [{ row: 'V1', class: 'implementation', reason: ' la suma ' }, { row: 'V2', class: 'environment', reason: 'timeout de red' }] })
  assert.deepEqual(ok, [{ row: 'V1', class: 'implementation', reason: 'la suma' }, { row: 'V2', class: 'environment', reason: 'timeout de red' }])
  const bad: Array<[string, unknown, RegExp]> = [
    ['otro recibo', { receipt: 'R2', rows: [] }, /R1/],
    ['fila inexistente', { receipt: 'R1', rows: [{ row: 'V9', class: 'implementation', reason: 'x' }] }, /V9 no está en el recibo/],
    ['fila que pasó', { receipt: 'R1', rows: [{ row: 'V3', class: 'implementation', reason: 'x' }] }, /V3 no está roja/],
    ['fila manual', { receipt: 'R1', rows: [{ row: 'V4', class: 'contract', reason: 'x' }] }, /V4 no está roja/],
    ['clase inválida', { receipt: 'R1', rows: [{ row: 'V1', class: 'bug', reason: 'x' }, { row: 'V2', class: 'environment', reason: 'x' }] }, /clase/],
    ['razón vacía', { receipt: 'R1', rows: [{ row: 'V1', class: 'implementation', reason: '  ' }, { row: 'V2', class: 'environment', reason: 'x' }] }, /razón/],
    ['repetida', { receipt: 'R1', rows: [{ row: 'V1', class: 'implementation', reason: 'x' }, { row: 'V1', class: 'implementation', reason: 'x' }] }, /dos veces/],
    ['sin clasificar', { receipt: 'R1', rows: [{ row: 'V1', class: 'implementation', reason: 'x' }] }, /faltan las filas rojas V2/],
  ]
  for (const [name, file, cause] of bad) {
    assert.throws(() => checkClassification(receipt, file), (e: unknown) => e instanceof SddError && e.code === 'classification_invalid' && cause.test(e.message), name)
  }
})

test('derivación: diseño manda sobre contrato, contrato sobre entorno, y el fix lleva solo implementación', () => {
  const r = (row: string, c: ChainClass) => ({ row, class: c })
  assert.deepEqual(derive([r('V1', 'implementation'), r('V2', 'environment')]), { kind: 'fix', rows: ['V1'], environment: ['V2'] })
  assert.deepEqual(derive([r('V2', 'environment')]), { kind: 'environment', rows: ['V2'] })
  assert.deepEqual(derive([r('V1', 'implementation'), r('V3', 'contract')]), { kind: 'contract', rows: ['V3'] })
  assert.deepEqual(derive([r('V1', 'implementation'), r('V3', 'contract'), r('V4', 'design')]), { kind: 'design', rows: ['V4'], contract: ['V3'] })
})

test('incidencias: una por recibo y fila de implementación, dentro de la época del plan', () => {
  const approvals = [
    { gate: 'spec', at: '2026-09-29T10:00:00Z' },
    { gate: 'plan', at: '2026-09-29T10:01:00Z', proof: { ref: 'p1' } },
    { gate: 'tasks', at: '2026-09-29T10:02:00Z', proof: { ref: 't1' } },
  ]
  assert.equal(planEpoch(approvals), 'p1')
  // Reaprobar el plan, aunque sea con la misma huella, abre otra época; reaprobar tasks, no.
  assert.equal(planEpoch([...approvals, { gate: 'plan', at: '2026-09-29T11:00:00Z', proof: { ref: 'p2' } }]), 'p2')
  assert.equal(planEpoch([...approvals, { gate: 'tasks', at: '2026-09-29T11:00:00Z', proof: { ref: 't2' } }]), 'p1')
  assert.equal(planEpoch([{ gate: 'plan-tasks', at: '2026-09-29T10:00:00Z' }]), 'at:2026-09-29T10:00:00Z')
  assert.equal(planEpoch([]), null)
  const c = (receipt: string, epoch: string, rows: Array<[string, ChainClass]>): Classification => ({
    receipt: { id: receipt, digest: `sha256:${'a'.repeat(64)}` }, epoch, at: '2026-09-29T12:00:00Z',
    rows: rows.map(([row, cls]) => ({ row, class: cls, proposed: null, reason: 'r' })),
  })
  const imp = { classifications: [
    c('R1', 'p1', [['V1', 'implementation'], ['V2', 'environment']]),
    c('R2', 'p1', [['V1', 'implementation']]),
    c('R2', 'p1', [['V1', 'implementation']]),
    c('R3', 'p0', [['V1', 'implementation']]),
  ] }
  assert.deepEqual([...failureCounts(imp, 'p1')], [['V1', 2]])
  assert.deepEqual([...failureCounts(imp, 'p0')], [['V1', 1]])
})

const fixInput = (n: number, out = 'línea ✓\n'.repeat(2000)) => ({
  flow: 'f', receipt: 'R1', paths: { spec: '.plans/f/spec.md', plan: '.plans/f/plan.md', tasks: '.plans/f/tasks.md' },
  rows: Array.from({ length: n }, (_, i) => ({
    id: `V${i + 1}`, argv: ['node', '--test', 'test/a.test.ts'], exit_code: i === 0 ? null : 1, no_exit: i === 0 ? 'timeout' : undefined,
    excerpt: 'exit 1; not ok 1 - f da 2', class: 'implementation', reason: `la fila ${i + 1}`, confirmation: 'refuted: el test pasa sin el cambio',
    stdout: `${out}FIN-STDOUT`, stderr: 'error ```raro```\nFIN-STDERR',
  })),
})

test('encargo de fix: todas las filas con comando, código o su ausencia, extracto, clase, razón y tramos, sin los insumos', () => {
  const r = renderFixPrompt(fixInput(2), FIX_PROMPT_BUDGET)
  assert.ok(!('over_budget' in r))
  const { prompt, trimmed } = r as { prompt: string; trimmed: string[] }
  assert.deepEqual(trimmed, [])
  for (const id of ['V1', 'V2']) assert.match(prompt, new RegExp(`### ${id}`))
  assert.match(prompt, /Código de salida: sin código \(timeout\)/)
  assert.match(prompt, /Código de salida: 1/)
  assert.match(prompt, /Razón del conductor: la fila 2/)
  assert.match(prompt, /Confirmación: refuted/)
  assert.match(prompt, /FIN-STDOUT/)
  // Un tramo con backticks va en una cerca más larga, así no rompe el encargo.
  assert.match(prompt, /````text\nerror ```raro```/)
  assert.match(prompt, /"phase": "fix"/)
  assert.match(prompt, /V1, V2\), y solo esas/)
  // No lleva los insumos inline: solo sus rutas.
  assert.match(prompt, /spec en `\.plans\/f\/spec\.md`/)
  assert.doesNotMatch(prompt, /<<<INSUMO/)
  // Cada canal va hasta 4 KiB, sin cortar un carácter por la mitad.
  const tail = /Final de stdout \(hasta 4096 bytes\):\n```text\n([\s\S]*?)\n```/.exec(prompt)![1]
  assert.ok(Buffer.byteLength(tail) <= 4096)
  assert.ok(!tail.startsWith('�'))
})

test('encargo de fix: con el tope se recortan los tramos parejo y nunca se omite una fila', () => {
  const input = fixInput(8)
  const budget = 20_000
  const r = renderFixPrompt(input, budget) as { prompt: string; trimmed: string[] }
  assert.ok(Buffer.byteLength(r.prompt) <= budget)
  for (let i = 1; i <= 8; i++) assert.match(r.prompt, new RegExp(`### V${i}\n`))
  assert.deepEqual(r.trimmed, input.rows.map((x) => x.id))
  // Con muy poco lugar por fila, los tramos se quitan todos.
  const bare = renderFixPrompt(fixInput(8, ''), 1e9) as { prompt: string }
  const minimal = renderFixPrompt(input, Buffer.byteLength(bare.prompt) + 100) as { prompt: string; trimmed: string[] }
  assert.doesNotMatch(minimal.prompt, /Final de stdout/)
  assert.equal(minimal.trimmed.length, 8)
  // Si ni sin tramos entra, no hay encargo.
  assert.deepEqual(renderFixPrompt(input, 500), { over_budget: true })
})

test('encargo de continuación y encargo de reanudación: solo lo que sigue, con su contrato y sin ordenar checks', () => {
  const c = renderContinuationPrompt('f', ['T4', 'T5'])
  assert.match(c, /pendientes: T4, T5/)
  assert.match(c, /"completion": "done" \| "pending"/)
  assert.match(c, /\(T4, T5\), y solo esas/)
  const r = renderResumePrompt('f', '20260929-2100-aaaa', 'fix', ['V1'])
  assert.match(r, /20260929-2100-aaaa/)
  assert.match(r, /contrato de `fix`/)
  assert.match(r, /las filas V1/)
  for (const p of [c, r, (renderFixPrompt(fixInput(1), FIX_PROMPT_BUDGET) as { prompt: string }).prompt]) {
    assert.doesNotMatch(p, /corre (las )?pruebas|ejecuta (las )?pruebas|npm test/i)
  }
  assert.ok(writerEnvelopeBytes() > 0)
})

// ── Estado de cadena ─────────────────────────────────────────────────────────────────────────────────

const AT = '2026-09-29T20:00:00.000Z'
const DIG = `sha256:${'b'.repeat(64)}`
type H = NonNullable<RunFacts['harvest']>
const harvest = (o: Partial<H> = {}): H => ({ finished: true, endMark: true, inputsStable: true, integrity: true, delta: ['src/a.ts'], files: 1, completed: [], ...o })
const runEntry = (run: string, kind: RunEntry['kind'], parent: string | null, extra: Partial<RunEntry> = {}): RunEntry => ({ kind, run, parent, at: AT, ...extra })
function input(entries: ChainEntry[], facts: RunFacts[], o: Partial<ChainInput> & { terminal?: ChainTerminal | null; classifications?: Classification[] } = {}): ChainInput {
  return {
    imp: { schema: 1, chains: [{ id: 'c1', entries, terminal: o.terminal ?? null }], classifications: o.classifications ?? [], events: [] },
    runs: new Map(facts.map((f) => [f.run, f])), receipt: o.receipt ?? null,
    approvals: o.approvals ?? [{ gate: 'plan', at: '2026-09-29T10:00:00.000Z', proof: { ref: 'p1' } }], open: o.open ?? ['T1', 'T2', 'T3'], failed: o.failed ?? new Set(),
  }
}
const classified = (receipt: string, rows: Array<[string, ChainClass]>, epoch = 'p1'): Classification => ({
  receipt: { id: receipt, digest: DIG }, epoch, at: AT, rows: rows.map(([row, c]) => ({ row, class: c, proposed: null, reason: 'r' })),
})
const red = (id: string, rows = ['V1']): ReceiptFacts => ({ id, digest: DIG, green: false, current: true, red: rows, unattested: [] })

test('estado de cadena: cobertura acumulada, continuación con progreso y salida sin progreso', () => {
  const none = chainState({ imp: { schema: 1, chains: [], classifications: [], events: [] }, runs: new Map(), receipt: null, approvals: [], open: ['T1'], failed: new Set() })
  assert.equal(none.next.kind, 'start')

  const R1 = { run: 'R1', kind: 'implement' as const, pending: ['T1', 'T2', 'T3'], harvest: harvest({ completed: ['T1'] }) }
  const a = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2', 'T3'] })], [R1]))
  assert.deepEqual([a.covered, a.left, a.next], [['T1'], ['T2', 'T3'], { kind: 'continue', left: ['T2', 'T3'] }])

  // Una continuación que declara hechas las pendientes sin cambiar nada no acredita ni progresa.
  const R2 = { run: 'R2', kind: 'continuation' as const, pending: ['T2', 'T3'], harvest: harvest({ completed: ['T2', 'T3'], delta: [] }) }
  const b = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2', 'T3'] }), runEntry('R2', 'continuation', 'R1')], [R1, R2]))
  assert.deepEqual([b.left, b.next.kind], [['T2', 'T3'], 'blocks_or_takeover'])

  // Un bloque sin progreso cierra la cadena con no_progress.
  const R3 = { run: 'R3', kind: 'block' as const, pending: ['T2'], harvest: harvest({ completed: [], delta: [] }) }
  const c = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2', 'T3'] }), runEntry('R2', 'continuation', 'R1'), runEntry('R3', 'block', 'R2')], [R1, R2, R3]))
  assert.deepEqual([c.derived?.code, c.next.kind], ['no_progress', 'takeover'])

  // Una corrida sin marca final se reanuda; una en curso se espera; una cuyo lanzamiento falló no es eslabón.
  const cut = { run: 'R4', kind: 'continuation' as const, pending: ['T2', 'T3'], harvest: harvest({ endMark: false, finished: false }) }
  const d = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2', 'T3'] }), runEntry('R4', 'continuation', 'R1')], [R1, cut]))
  assert.deepEqual(d.next, { kind: 'resume', run: 'R4' })
  // Lo que declaró una corrida cortada no cuenta: si su reanudación deja pendiente T2, T2 sigue pendiente.
  const cutDone = { ...cut, harvest: harvest({ endMark: false, finished: false, completed: ['T2', 'T3'] }) }
  const resumed = { run: 'R7', kind: 'continuation' as const, pending: ['T2', 'T3'], harvest: harvest({ completed: ['T3'] }) }
  const e = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2', 'T3'] }), runEntry('R4', 'continuation', 'R1'),
    runEntry('R7', 'continuation', 'R4', { resumes: 'R4' })], [R1, cutDone, resumed]))
  assert.deepEqual([e.covered, e.left], [['T1', 'T3'], ['T2']])
  const open = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1'] }), runEntry('R5', 'continuation', 'R1')], [R1, { run: 'R5', pending: [] }]))
  assert.deepEqual(open.next, { kind: 'wait', run: 'R5' })
  const failed = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2', 'T3'] }), runEntry('R6', 'continuation', 'R1')], [R1], { failed: new Set(['R6']) }))
  assert.equal((failed.last as RunEntry).run, 'R1')
  // Insumos cambiados o integridad perdida: no es padre de nada.
  const moved = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1'] })], [{ ...R1, harvest: harvest({ integrity: false }) }]))
  assert.equal(moved.next.kind, 'takeover')
})

test('estado de cadena: verify, clasificación, fix con tope de dos y failure_cap por época', () => {
  const R1 = { run: 'R1', kind: 'implement' as const, pending: ['T1'], harvest: harvest({ completed: ['T1'] }) }
  const e1 = [runEntry('R1', 'implement', null, { pending: ['T1'] })]
  assert.equal(chainState(input(e1, [R1])).next.kind, 'verify')
  assert.deepEqual(chainState(input(e1, [R1], { receipt: red('RC1') })).next, { kind: 'classify', receipt: 'RC1' })
  assert.deepEqual(chainState(input(e1, [R1], { receipt: red('RC1', ['V1', 'V2']), classifications: [classified('RC1', [['V1', 'implementation'], ['V2', 'environment']])] })).next,
    { kind: 'fix', receipt: 'RC1', rows: ['V1'] })
  assert.equal(chainState(input(e1, [R1], { receipt: red('RC1', ['V3']), classifications: [classified('RC1', [['V3', 'contract']])] })).next.kind, 'amend_contract')
  assert.equal(chainState(input(e1, [R1], { receipt: red('RC1', ['V4']), classifications: [classified('RC1', [['V4', 'design']])] })).next.kind, 'back_to_plan')
  assert.equal(chainState(input(e1, [R1], { receipt: { ...red('RC1'), green: true, red: [] } })).next.kind, 'review')
  // Un recibo de otro candidato no vale: se verifica de nuevo.
  assert.equal(chainState(input(e1, [R1], { receipt: { ...red('RC1'), current: false } })).next.kind, 'verify')

  // Dos fix y el rojo siguiente: fix_cap.
  const F1 = { run: 'F1', kind: 'fix' as const, pending: [], harvest: harvest() }
  const F2 = { run: 'F2', kind: 'fix' as const, pending: [], harvest: harvest() }
  const two = [...e1, runEntry('F1', 'fix', 'R1'), runEntry('F2', 'fix', 'F1')]
  const capped = chainState(input(two, [R1, F1, F2], { receipt: red('RC3') }))
  assert.deepEqual([capped.fixes, capped.derived?.code, capped.next.kind], [2, 'fix_cap', 'takeover'])
  // Un fix vacío deja el mismo candidato: con cupo, vuelve el fix desde el mismo recibo.
  const empty = chainState(input([...e1, runEntry('F1', 'fix', 'R1')], [R1, { ...F1, harvest: harvest({ delta: [] }) }],
    { receipt: red('RC1'), classifications: [classified('RC1', [['V1', 'implementation']])] }))
  assert.deepEqual([empty.fixes, empty.next], [1, { kind: 'fix', receipt: 'RC1', rows: ['V1'] }])

  // Una corrección que deshizo todo deja el candidato acumulado vacío: no se verifica, va a la toma.
  const emptied = chainState(input([...e1, runEntry('F1', 'fix', 'R1')], [R1, { ...F1, harvest: harvest({ files: 0 }) }], { receipt: { ...red('RC1'), current: false } }))
  assert.equal(emptied.next.kind, 'takeover')

  // Tres fallos de la misma fila en la época: failure_cap; en otra época no cuentan.
  const three = [classified('A', [['V1', 'implementation']]), classified('B', [['V1', 'implementation']]), classified('C', [['V1', 'implementation']])]
  assert.equal(chainState(input(e1, [R1], { classifications: three })).derived?.code, 'failure_cap')
  assert.equal(chainState(input(e1, [R1], { classifications: three, approvals: [{ gate: 'plan', at: AT, proof: { ref: 'p2' } }] })).derived, null)
})

test('estado de cadena: la toma cierra la cadena, y solo una aprobación posterior abre otra', () => {
  const R1 = { run: 'R1', kind: 'implement' as const, pending: ['T1', 'T2'], harvest: harvest({ completed: ['T1'] }) }
  const taken: ChainEntry[] = [runEntry('R1', 'implement', null, { pending: ['T1', 'T2'] }), { kind: 'takeover', id: 't1', parent: 'R1', at: '2026-09-29T21:00:00.000Z', map: { ref: 'takeovers/t1.json', digest: DIG } }]
  const s = chainState(input(taken, [R1], { receipt: red('RC1'), classifications: [classified('RC1', [['V1', 'implementation']])] }))
  assert.deepEqual([s.derived?.code, s.next.kind], ['takeover', 'conductor'])
  // Los demás rojos de la cadena cerrada se derivan por clase: sin clasificar, contrato y entorno.
  assert.deepEqual(chainState(input(taken, [R1], { receipt: red('RC2') })).next, { kind: 'classify', receipt: 'RC2' })
  assert.equal(chainState(input(taken, [R1], { receipt: red('RC2'), classifications: [classified('RC2', [['V1', 'contract']])] })).next.kind, 'amend_contract')
  assert.equal(chainState(input(taken, [R1], { receipt: red('RC2'), classifications: [classified('RC2', [['V1', 'environment']])] })).next.kind, 'repeat_verify')
  const reopened = chainState(input(taken, [R1], { approvals: [{ gate: 'tasks', at: '2026-09-29T22:00:00.000Z', proof: { ref: 't2' } }], open: ['T2'] }))
  assert.equal(reopened.next.kind, 'start')
  // Con el tope de fallos de la época, reaprobar solo las tasks no abre otra cadena.
  const three = ['A', 'B', 'C'].map((r) => classified(r, [['V1', 'implementation']]))
  const cappedReopen = chainState(input(taken, [R1], {
    classifications: three, open: ['T2'],
    approvals: [{ gate: 'plan', at: '2026-09-29T10:00:00.000Z', proof: { ref: 'p1' } }, { gate: 'tasks', at: '2026-09-29T22:00:00.000Z', proof: { ref: 't2' } }],
  }))
  assert.equal(cappedReopen.next.kind, 'conductor')
  // Un bloque sin progreso ya cerrado: sin aprobación posterior no nace otra cadena.
  const closed = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2'] })], [R1], { terminal: { code: 'no_progress', at: '2026-09-29T21:00:00.000Z', detail: 'x' } }))
  assert.equal(closed.next.kind, 'conductor')
  // Legacy exige además una toma posterior.
  const legacy = chainState(input([runEntry('R1', 'implement', null, { pending: ['T1', 'T2'] })], [R1],
    { terminal: { code: 'legacy', at: '2026-09-29T21:00:00.000Z', detail: 'x' }, approvals: [{ gate: 'tasks', at: '2026-09-29T22:00:00.000Z' }], open: ['T2'] }))
  assert.equal(legacy.next.kind, 'conductor')
})
