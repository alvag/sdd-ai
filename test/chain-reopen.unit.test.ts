import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type ChainInput, type RunFacts, chainState, renderContinuationPrompt } from '../src/sdd/chain.ts'
import { WORKER_POLICY } from '../src/worker-policy.ts'
import { admitImplement, implementReportFormat } from '../src/sdd/phase.ts'
import { type ChainEntry, type Classification, type RunEntry, validatePhaseRecord } from '../src/sdd/phase-state.ts'

// El retorno al writer sin subprocesos: el estado de la cadena, la validación del registro, la admisión del reporte
// y el encargo de continuación, con datos en memoria. Solo importa símbolos que existen en la base.

const AT = '2026-09-29T20:00:00.000Z'
const DIG = `sha256:${'b'.repeat(64)}`
type H = NonNullable<RunFacts['harvest']>
const harvest = (o: Partial<H> = {}): H => ({ finished: true, endMark: true, inputsStable: true, integrity: true, delta: ['src/a.ts'], files: 1, completed: [], ...o })
const runEntry = (run: string, kind: RunEntry['kind'], parent: string | null, extra: Partial<RunEntry> = {}): RunEntry => ({ kind, run, parent, at: AT, ...extra })
const MATERIAL = { path: '.plans/f/defecto.md', digest: DIG }
const reopened = (tasks: string[]) => ({ tasks, context: MATERIAL })
function input(entries: ChainEntry[], facts: RunFacts[], o: Partial<ChainInput> & { classifications?: Classification[] } = {}): ChainInput {
  return {
    imp: { schema: 1, chains: [{ id: 'c1', entries, terminal: null }], classifications: o.classifications ?? [], events: [] },
    runs: new Map(facts.map((f) => [f.run, f])), receipt: o.receipt ?? null,
    approvals: [{ gate: 'plan', at: '2026-09-29T10:00:00.000Z', proof: { ref: 'p1' } }], open: o.open ?? ['T5', 'T7', 'T10', 'T11'], failed: new Set(),
  }
}

const SCOPE = ['T5', 'T7', 'T10', 'T11']
const R1 = { run: 'R1', kind: 'implement' as const, pending: SCOPE, harvest: harvest({ completed: ['T5', 'T7'] }) }
const E1 = runEntry('R1', 'implement', null, { pending: SCOPE })
const ret = (completed: string[]) => ({ run: 'R2', kind: 'continuation' as const, pending: SCOPE, harvest: harvest({ completed }) })
const E2 = runEntry('R2', 'continuation', 'R1', { pending: SCOPE, reopened: reopened(['T5', 'T7']) })

test('retorno: revoca las acreditaciones previas de las tasks reabiertas y sigue con ellas y las pendientes', () => {
  const before = chainState(input([E1], [R1]))
  assert.deepEqual([before.covered, before.unmarked], [['T5', 'T7'], ['T5', 'T7']])
  const s = chainState(input([E1, E2], [R1, ret(['T5'])]))
  assert.deepEqual(s.scope, SCOPE)
  assert.deepEqual(s.covered, ['T5'])
  assert.deepEqual(s.left, ['T7', 'T10', 'T11'])
  assert.ok(!s.unmarked.includes('T7'))
  assert.deepEqual(s.next, { kind: 'continue', left: ['T7', 'T10', 'T11'] })
})

test('retorno: volver a acreditar una task reabierta cuenta como progreso en una continuación y en un bloque', () => {
  for (const kind of ['continuation', 'block'] as const) {
    const R3 = { run: 'R3', kind, pending: ['T7', 'T10', 'T11'], harvest: harvest({ completed: ['T7'] }) }
    const s = chainState(input([E1, E2, runEntry('R3', kind, 'R2', { pending: ['T7', 'T10', 'T11'] })], [R1, ret(['T5']), R3]))
    assert.deepEqual([s.covered, s.left, s.next, s.derived], [['T5', 'T7'], ['T10', 'T11'], { kind: 'continue', left: ['T10', 'T11'] }, null], kind)
  }
  // Un retorno cortado y su reanudación: la revocación vive en la entrada original.
  const cut = { run: 'R2', kind: 'continuation' as const, pending: SCOPE, harvest: harvest({ finished: false, endMark: false, completed: ['T5', 'T7'] }) }
  const resumed = { run: 'R3', kind: 'continuation' as const, pending: SCOPE, harvest: harvest({ completed: ['T5'] }) }
  const s = chainState(input([E1, E2, runEntry('R3', 'continuation', 'R2', { pending: SCOPE, resumes: 'R2' })], [R1, cut, resumed]))
  assert.deepEqual([s.covered, s.left, s.next.kind], [['T5'], ['T7', 'T10', 'T11'], 'continue'])
})

test('retorno sin ninguna task done: sin progreso como una continuación y las reabiertas siguen sin acreditar', () => {
  const s = chainState(input([E1, E2], [R1, ret([])]))
  assert.deepEqual(s.covered, [])
  assert.deepEqual(s.left, SCOPE)
  assert.equal(s.next.kind, 'blocks_or_takeover')
})

test('retorno: no cuenta como fix ni cambia el conteo de fallos', () => {
  const classified: Classification = {
    receipt: { id: 'RC1', digest: DIG }, epoch: 'p1', at: AT, rows: [{ row: 'V1', class: 'implementation', proposed: null, reason: 'r' }],
  }
  const red = { id: 'RC1', digest: DIG, green: false, current: true, red: ['V1'], attested: [], unattested: [] }
  const all = { ...ret(SCOPE) }
  const opts = { open: [], receipt: red, classifications: [classified] }
  const noReturn = chainState(input([E1], [{ ...R1, harvest: harvest({ completed: SCOPE }) }], opts))
  const withReturn = chainState(input([E1, E2], [R1, all], opts))
  assert.deepEqual([withReturn.fixes, [...withReturn.counts]], [noReturn.fixes, [...noReturn.counts]])
  assert.deepEqual(withReturn.next, { kind: 'fix', receipt: 'RC1', rows: ['V1'] })
  // Después de un fix todavía cabe el segundo.
  const F1 = { run: 'F1', kind: 'fix' as const, pending: [], harvest: harvest() }
  const afterFix = chainState(input([E1, E2, runEntry('F1', 'fix', 'R2', { receipt: { id: 'RC1', digest: DIG } })], [R1, all, F1], opts))
  assert.equal(afterFix.fixes, 1)
  assert.equal(afterFix.next.kind, 'fix')
})

test('retorno: el reporte se admite solo con una entrada por cada task enviada', () => {
  const report = (ids: string[]) => `Listo.\n\n${JSON.stringify({
    phase: 'implement', missing_context: [],
    tasks: ids.map((id) => ({ id, completion: 'done', change_kind: 'defect', changed: 'x', deviation: null, check: 'V1' })),
  })}\n\nSTATUS: done\n`
  const sent = ['T5', 'T7', 'T10', 'T11']
  assert.notEqual(admitImplement(report(sent), sent, { explicit: true }).kind, 'inadmissible')
  assert.equal(admitImplement(report(['T5', 'T7', 'T10']), sent, { explicit: true }).kind, 'inadmissible')
  assert.equal(admitImplement(report([...sent, 'T12']), sent, { explicit: true }).kind, 'inadmissible')
  // Con el contrato no admitido, la cadena propone la toma.
  const s = chainState(input([E1, E2], [R1, { ...ret([]), harvest: harvest({ completed: null }) }]))
  assert.equal(s.next.kind, 'takeover')
})

test('encargo de continuación sin retorno: idéntico byte a byte al de antes', () => {
  const expected = [
    WORKER_POLICY,
    '# Continuación del flujo f',
    'Esta es la continuación de tu trabajo anterior en esta misma sesión, sobre el árbol que dejaste. Sigue con las tasks que quedaron pendientes: T4, T5. Lo que ya terminaste no se rehace. Una task que no termines va con `completion: pending`; no marques las tasks, eso lo hace el conductor.',
    implementReportFormat(),
    'Tu reporte trae una entrada por cada una de estas tasks (T4, T5), y solo esas.',
  ].join('\n\n') + '\n'
  assert.equal(renderContinuationPrompt('f', ['T4', 'T5']), expected)
})

const record = (entries: unknown[]) => ({
  schema_version: 1, last_run: null, phases: {},
  implement: { schema: 1, chains: [{ id: 'c1', entries, terminal: null }], classifications: [], events: [] },
})
const run = (extra: Record<string, unknown> = {}) => ({ kind: 'continuation', run: '20260929-2100-aaaa', parent: 'R1', at: AT, pending: ['T5', 'T7', 'T10'], ...extra })

test('registro: la entrada de un retorno valida sus tasks reabiertas y su material', () => {
  const ok = (e: unknown) => validatePhaseRecord(record([e]), 'f')
  const bad = (e: unknown, label: string) => assert.throws(() => ok(e), (x: { code?: string }) => x.code === 'phases_invalid', label)
  ok(run({ reopened: reopened(['T5', 'T7']) }))
  ok(run())
  bad(run({ kind: 'block', reopened: reopened(['T5']) }), 'tipo distinto de continuation')
  bad(run({ kind: 'implement', reopened: reopened(['T5']) }), 'implement')
  bad(run({ resumes: '20260929-2000-bbbb', reopened: reopened(['T5']) }), 'con resumes')
  const { pending: _p, ...noPending } = run({ reopened: reopened(['T5']) })
  bad(noPending, 'sin pending')
  bad(run({ reopened: reopened([]) }), 'tasks vacía')
  bad(run({ reopened: reopened(['T5', 'T5']) }), 'tasks repetida')
  bad(run({ reopened: reopened(['T99']) }), 'tasks fuera de pending')
  bad(run({ reopened: { tasks: ['T5'], context: { ...MATERIAL, extra: 1 } } }), 'context con clave extra')
  bad(run({ reopened: { tasks: ['T5'], context: { digest: DIG } } }), 'context sin path')
  bad(run({ reopened: { tasks: ['T5'], context: { path: MATERIAL.path, digest: 'sha256:xyz' } } }), 'digest mal formado')
  bad(run({ reopened: { tasks: ['T5'], context: MATERIAL, extra: 1 } }), 'clave extra en reopened')
})
