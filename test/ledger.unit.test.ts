import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Finding } from '../src/review/admit.ts'
import {
  LENSES, type Ledger, REVIEWERS, type Reviewer, applyRefutation, applyRound, axesOf, byProvenance, decide, disputable, lastRejection,
  openLedger, refutationBatch, targets, undecided,
} from '../src/review/ledger.ts'
import { SddError } from '../src/types.ts'

const f = (axis: Finding['axis'], severity: Finding['severity'], more: Partial<Finding> = {}): Finding =>
  ({ axis, severity, location: 'src/x.ts:8', claim: `${axis} ${severity}`, ...more })
const grave = (axis: Finding['axis'], causality: Finding['causality'], evidence: Finding['evidence'] = 'deterministic'): Finding =>
  f(axis, 'CRITICAL', { causality, evidence })

const stateOf = (l: Ledger, id: string) => l.entries.find((e) => e.id === id)?.state

function usage(fn: () => unknown, why: RegExp) {
  assert.throws(fn, (e: unknown) => e instanceof SddError && e.code === 'usage' && why.test(e.message))
}

test('la ronda 1 asigna F-1…F-n en orden, con todos los campos y la ronda', () => {
  const findings = [grave('scope', 'introduced', 'inferential'), f('quality', 'WARNING')]
  const l = openLedger(findings)
  assert.deepEqual(l.entries.map((e) => e.id), ['F-1', 'F-2'])
  assert.deepEqual(l.entries[0], {
    ...findings[0], id: 'F-1', round: 1, state: 'abierto', responses: [],
  })
  assert.equal(l.completed, 1)
  assert.equal(l.next_id, 3)
})

test('un grave preexistente nace fuera-de-alcance y no pide decisión', () => {
  const l = openLedger([grave('spec', 'pre-existing'), f('quality', 'WARNING', { causality: 'pre-existing' })])
  assert.deepEqual(l.entries.map((e) => e.state), ['fuera-de-alcance', 'abierto'])
  assert.deepEqual(undecided(l), ['F-2'])
  usage(() => decide(l, 'accept', ['F-1']), /F-1.*no espera/)
})

test('accept pasa a aceptado y reject con motivo a rechazado; no se muta el ledger recibido', () => {
  const l = openLedger([grave('scope', 'introduced'), grave('quality', 'introduced')])
  const a = decide(l, 'accept', ['F-1'])
  const b = decide(a, 'reject', ['F-2'], 'la línea ya valida el caso')
  assert.equal(stateOf(b, 'F-1'), 'aceptado')
  assert.equal(stateOf(b, 'F-2'), 'rechazado')
  assert.deepEqual(b.entries[1].decision, { action: 'reject', reason: 'la línea ya valida el caso', from: 'abierto', after_round: 1 })
  assert.equal(stateOf(l, 'F-1'), 'abierto')
  assert.deepEqual(undecided(b), [])
})

test('decide rechaza, sin cambiar nada, un reject sin motivo, un ID inexistente y una lista con uno inválido', () => {
  const l = openLedger([grave('scope', 'introduced'), grave('quality', 'introduced')])
  usage(() => decide(l, 'reject', ['F-1']), /motivo/)
  usage(() => decide(l, 'reject', ['F-1'], '   '), /motivo/)
  usage(() => decide(l, 'accept', ['F-9']), /F-9.*no existe/)
  usage(() => decide(l, 'accept', ['F-1', 'F-9']), /F-9/)
  usage(() => decide(l, 'accept', []), /ID/)
  assert.deepEqual(l.entries.map((e) => e.state), ['abierto', 'abierto'])
})

test('los IDs repetidos se deduplican', () => {
  const l = decide(openLedger([grave('scope', 'introduced')]), 'accept', ['F-1', 'F-1'])
  assert.equal(stateOf(l, 'F-1'), 'aceptado')
})

test('una decisión se cambia antes de la ronda siguiente y no después', () => {
  const l = openLedger([grave('scope', 'introduced'), grave('quality', 'introduced')])
  const a = decide(decide(l, 'accept', ['F-1', 'F-2']), 'reject', ['F-2'], 'no aplica')
  assert.equal(stateOf(a, 'F-2'), 'rechazado')
  const back = decide(a, 'accept', ['F-2'])
  assert.equal(stateOf(back, 'F-2'), 'aceptado')
  const r2 = applyRound(a, 2, [
    { id: 'F-1', answer: 'resolved' },
    { id: 'F-2', answer: 'withdrawn' },
  ], [])
  usage(() => decide(r2, 'reject', ['F-1'], 'cambio de idea'), /F-1.*no espera/)
  usage(() => decide(r2, 'accept', ['F-2']), /F-2.*no espera/)
})

test('sobre en-disputa, accept da aceptado y reject da cerrado, y la decisión se puede cambiar', () => {
  let l = decide(openLedger([grave('scope', 'introduced')]), 'reject', ['F-1'], 'es intencional')
  l = applyRound(l, 2, [{ id: 'F-1', answer: 'maintained', evidence: 'src/x.ts:9' }], [])
  assert.equal(stateOf(l, 'F-1'), 'en-disputa')
  assert.deepEqual(undecided(l), ['F-1'])
  const closed = decide(l, 'reject', ['F-1'], 'lo decide la persona: es intencional')
  assert.equal(stateOf(closed, 'F-1'), 'cerrado')
  assert.deepEqual(undecided(closed), [])
  assert.equal(stateOf(decide(closed, 'accept', ['F-1']), 'F-1'), 'aceptado')
  assert.equal(stateOf(decide(l, 'accept', ['F-1']), 'F-1'), 'aceptado')
})

test('un aceptado que volvió unresolved se puede decidir otra vez, sin bloquear la ronda', () => {
  let l = decide(openLedger([grave('scope', 'introduced')]), 'accept', ['F-1'])
  l = applyRound(l, 2, [{ id: 'F-1', answer: 'unresolved', evidence: 'src/x.ts:8' }], [])
  assert.equal(stateOf(l, 'F-1'), 'aceptado')
  assert.deepEqual(undecided(l), [])
  assert.equal(stateOf(decide(l, 'accept', ['F-1']), 'F-1'), 'aceptado')
  assert.equal(stateOf(decide(l, 'reject', ['F-1'], 'la evidencia no convence'), 'F-1'), 'rechazado')
})

test('targets: verify por cada aceptado y respond por cada rechazado, en orden de ID', () => {
  let l = openLedger([grave('scope', 'introduced'), grave('quality', 'introduced'), f('spec', 'WARNING'), grave('spec', 'pre-existing')])
  l = decide(decide(l, 'reject', ['F-1'], 'no'), 'accept', ['F-2', 'F-3'])
  assert.deepEqual(targets(l), [
    { id: 'F-1', kind: 'respond' }, { id: 'F-2', kind: 'verify' }, { id: 'F-3', kind: 'verify' },
  ])
})

test('las respuestas cambian estados según su tabla y quedan registradas', () => {
  let l = openLedger([grave('scope', 'introduced'), grave('quality', 'introduced'), grave('spec', 'introduced'), grave('scope', 'worsened')])
  l = decide(decide(l, 'accept', ['F-1', 'F-2']), 'reject', ['F-3', 'F-4'], 'motivo')
  l = applyRound(l, 2, [
    { id: 'F-1', answer: 'resolved' },
    { id: 'F-2', answer: 'unresolved', evidence: 'src/x.ts:8', note: 'sigue igual' },
    { id: 'F-3', answer: 'withdrawn' },
    { id: 'F-4', answer: 'maintained', evidence: 'src/x.ts:9' },
  ], [])
  assert.deepEqual(l.entries.map((e) => e.state), ['resuelto', 'aceptado', 'cerrado', 'en-disputa'])
  assert.deepEqual(l.entries[1].responses, [{ round: 2, answer: 'unresolved', evidence: 'src/x.ts:8', note: 'sigue igual' }])
  assert.equal(l.completed, 2)
})

test('cada regresión entra con un ID nuevo y la ronda en que se emitió', () => {
  let l = decide(openLedger([grave('scope', 'introduced'), f('quality', 'WARNING')]), 'accept', ['F-1', 'F-2'])
  l = applyRound(l, 2, [{ id: 'F-1', answer: 'resolved' }, { id: 'F-2', answer: 'resolved' }],
    [grave('quality', 'introduced', 'inferential'), grave('spec', 'pre-existing')])
  assert.deepEqual(l.entries.slice(2).map((e) => [e.id, e.round, e.state]), [
    ['F-3', 2, 'abierto'], ['F-4', 2, 'fuera-de-alcance'],
  ])
  assert.equal(l.next_id, 5)
})

test('la tanda de refutación: solo graves inferenciales, introducidos o empeorados, abiertos y de esa ronda', () => {
  const l = openLedger([
    grave('scope', 'introduced', 'inferential'),
    grave('quality', 'worsened', 'inferential'),
    grave('spec', 'introduced', 'deterministic'),
    grave('spec', 'pre-existing', 'inferential'),
    f('quality', 'WARNING', { causality: 'introduced', evidence: 'inferential' }),
  ])
  assert.deepEqual(refutationBatch(l, 1).map((e) => e.id), ['F-1', 'F-2'])
  assert.deepEqual(refutationBatch(l, 2), [])
  let r2 = decide(l, 'accept', ['F-1', 'F-2', 'F-3', 'F-5'])
  r2 = applyRound(r2, 2, ['F-1', 'F-2', 'F-3', 'F-5'].map((id) => ({ id, answer: 'resolved' as const })),
    [grave('scope', 'introduced', 'inferential')])
  assert.deepEqual(refutationBatch(r2, 2).map((e) => e.id), ['F-6'])
})

test('refuted pasa a refutado; corroborated e inconclusive siguen abiertos con su resultado', () => {
  const l = openLedger([grave('scope', 'introduced', 'inferential'), grave('quality', 'introduced', 'inferential'), grave('spec', 'introduced', 'inferential')])
  const r = applyRefutation(l, { results: [
    { id: 'F-1', result: 'refuted', evidence: 'src/x.ts:7', note: 'la guarda está arriba' },
    { id: 'F-2', result: 'corroborated', evidence: 'src/x.ts:8' },
    { id: 'F-3', result: 'inconclusive', evidence: 'src/x.ts:8' },
  ] })
  assert.deepEqual(r.entries.map((e) => e.state), ['refutado', 'abierto', 'abierto'])
  assert.deepEqual(r.entries[0].refutation, { result: 'refuted', evidence: 'src/x.ts:7', note: 'la guarda está arriba' })
  assert.equal(r.entries[2].refutation?.result, 'inconclusive')
  assert.deepEqual(undecided(r), ['F-2', 'F-3'])
})

test('un refutador que falla deja toda la tanda inconclusive con el motivo, nunca refutada', () => {
  const l = openLedger([grave('scope', 'introduced', 'inferential'), grave('quality', 'introduced', 'inferential')])
  const r = applyRefutation(l, { failed: 'timeout', ids: ['F-1', 'F-2'] })
  assert.deepEqual(r.entries.map((e) => [e.state, e.refutation]), [
    ['abierto', { result: 'inconclusive', reason: 'timeout' }],
    ['abierto', { result: 'inconclusive', reason: 'timeout' }],
  ])
})

test('los ejes: un grave introducido o empeorado vigente hace fallar su eje', () => {
  for (const state of ['abierto', 'aceptado', 'rechazado', 'en-disputa'] as const) {
    let l = openLedger([grave('scope', 'introduced'), grave('quality', 'worsened')])
    if (state === 'aceptado') l = decide(l, 'accept', ['F-1', 'F-2'])
    if (state === 'rechazado') l = decide(l, 'reject', ['F-1', 'F-2'], 'no')
    if (state === 'en-disputa') {
      l = decide(l, 'reject', ['F-1', 'F-2'], 'no')
      l = applyRound(l, 2, [{ id: 'F-1', answer: 'maintained', evidence: 'src/x.ts:8' }, { id: 'F-2', answer: 'maintained', evidence: 'src/x.ts:8' }], [])
    }
    assert.deepEqual(l.entries.map((e) => e.state), [state, state])
    assert.deepEqual(axesOf(l), { scope: 'fail', spec: 'ok', quality: 'fail' }, state)
  }
})

test('los ejes: resuelto, cerrado, refutado y fuera-de-alcance no hacen fallar nada', () => {
  let l = openLedger([grave('scope', 'introduced'), grave('quality', 'introduced'), grave('spec', 'introduced', 'inferential'), grave('spec', 'pre-existing')])
  l = applyRefutation(l, { results: [{ id: 'F-3', result: 'refuted', evidence: 'src/x.ts:7' }] })
  l = decide(decide(l, 'accept', ['F-1']), 'reject', ['F-2'], 'no')
  l = applyRound(l, 2, [{ id: 'F-1', answer: 'resolved' }, { id: 'F-2', answer: 'withdrawn' }], [])
  assert.deepEqual(l.entries.map((e) => e.state), ['resuelto', 'cerrado', 'refutado', 'fuera-de-alcance'])
  assert.deepEqual(axesOf(l), { scope: 'ok', spec: 'ok', quality: 'ok' })
})

test('un aceptado sigue contando hasta que una ronda lo observa resolved', () => {
  let l = decide(openLedger([grave('quality', 'introduced')]), 'accept', ['F-1'])
  assert.equal(axesOf(l).quality, 'fail')
  l = applyRound(l, 2, [{ id: 'F-1', answer: 'unresolved', evidence: 'src/x.ts:8' }], [])
  assert.equal(axesOf(l).quality, 'fail')
  l = applyRound(l, 3, [{ id: 'F-1', answer: 'resolved' }], [])
  assert.equal(axesOf(l).quality, 'ok')
})

test('SPEC con solo advertencias vigentes queda en warn; una sugerencia no', () => {
  assert.equal(axesOf(openLedger([f('spec', 'WARNING'), f('spec', 'SUGGESTION')])).spec, 'warn')
  assert.equal(axesOf(openLedger([f('spec', 'SUGGESTION')])).spec, 'ok')
  let l = decide(openLedger([f('spec', 'WARNING')]), 'accept', ['F-1'])
  l = applyRound(l, 2, [{ id: 'F-1', answer: 'resolved' }], [])
  assert.equal(axesOf(l).spec, 'ok')
})

test('los IDs siguen el orden fijo base, lentes y lote', () => {
  const at = (reviewer: Reviewer, batch: number) => ({ ...f('quality', 'WARNING'), claim: `${reviewer}-${batch}`, reviewer, batch })
  const shuffled = [at('risk', 2), at('base', 2), at('readability', 1), at('base', 1), at('risk', 1), at('resilience', 1)]
  const l = openLedger(byProvenance(shuffled))
  assert.deepEqual(l.entries.map((e) => [e.id, e.claim, e.reviewer, e.batch]), [
    ['F-1', 'base-1', 'base', 1], ['F-2', 'base-2', 'base', 2], ['F-3', 'risk-1', 'risk', 1],
    ['F-4', 'risk-2', 'risk', 2], ['F-5', 'resilience-1', 'resilience', 1], ['F-6', 'readability-1', 'readability', 1],
  ])
  assert.deepEqual(REVIEWERS, ['base', ...LENSES])
  const next = applyRound(l, 2, [], byProvenance([at('base', 2), at('base', 1)]))
  assert.deepEqual(next.entries.slice(6).map((e) => [e.id, e.batch]), [['F-7', 1], ['F-8', 2]])
})

const ofSpec = (over: Partial<Finding> = {}): Finding =>
  ({ axis: 'spec', severity: 'CRITICAL', location: '.plans/spec.md:3', claim: 'la spec se contradice', evidence: 'inferential', of: '.plans/spec.md', ...over })

test('un defecto de otro archivo queda informativo: fuera del veredicto, de decide y de round', () => {
  const l = openLedger([ofSpec()], { artifact: true })
  assert.equal(l.artifact, true)
  assert.equal(stateOf(l, 'F-1'), 'informativo')
  assert.deepEqual(axesOf(l), { scope: 'ok', spec: 'ok', quality: 'ok' })
  assert.deepEqual([undecided(l), targets(l)], [[], []])
  usage(() => decide(l, 'accept', ['F-1']), /F-1 no espera decisión: es informativo/)
})

test('un grave pre-existing del artefacto hace fallar su eje', () => {
  const l = openLedger([grave('quality', 'pre-existing')], { artifact: true })
  assert.equal(stateOf(l, 'F-1'), 'abierto')
  assert.equal(axesOf(l).quality, 'fail')
  // Sin artefacto, sigue fuera de alcance como en un diff.
  assert.equal(stateOf(openLedger([grave('quality', 'pre-existing')]), 'F-1'), 'fuera-de-alcance')
})

test('una omisión del artefacto citada en un insumo cuenta para el veredicto', () => {
  const l = openLedger([f('spec', 'CRITICAL', { location: '.plans/spec.md:7', evidence: 'inferential' })], { artifact: true })
  assert.equal(stateOf(l, 'F-1'), 'abierto')
  assert.equal(axesOf(l).spec, 'fail')
})

test('en un artefacto, una regresión de la ronda N se abre aunque traiga causalidad pre-existing', () => {
  const l = decide(openLedger([f('quality', 'CRITICAL', { evidence: 'inferential' })], { artifact: true }), 'accept', ['F-1'])
  const next = applyRound(l, 2, [{ id: 'F-1', answer: 'resolved' }], [grave('scope', 'pre-existing')])
  assert.equal(next.artifact, true)
  assert.deepEqual(next.entries.map((e) => [e.id, e.state]), [['F-1', 'resuelto'], ['F-2', 'abierto']])
})

/** Un ledger con F-1 en disputa después de la ronda 2: el conductor lo rechazó y el revisor lo mantuvo. */
function disputed(): Ledger {
  const l = decide(openLedger([grave('scope', 'introduced'), grave('quality', 'introduced')]), 'reject', ['F-1'], 'es intencional')
  return applyRound(l, 2, [{ id: 'F-1', answer: 'maintained' }], [])
}
const proofOf = (ref: string) => ({ runner: 'claude' as const, source: 'ask_user_question' as const, ref, session: 's-1', answered_at: '2026-09-28T12:00:00.000Z' })

test('disputable y lastRejection: una disputa, su redecisión en la misma ronda y el motivo del último rechazo', () => {
  const l = disputed()
  const [f1, f2] = l.entries
  assert.equal(disputable(f1!, 2), true)
  assert.equal(disputable(f2!, 2), false)
  assert.equal(lastRejection(f1!), 'es intencional')
  assert.equal(lastRejection(f2!), undefined)
  const accepted = decide(l, 'accept', ['F-1'], undefined, { 'F-1': proofOf('r-1') })
  const e = accepted.entries[0]!
  assert.equal(e.state, 'aceptado')
  assert.equal(disputable(e, 2), true)
  assert.equal(disputable(e, 3), false)
  assert.equal(lastRejection(e), 'es intencional')
})

test('decide con pruebas guarda en superseded la decisión reemplazada de una disputa o con prueba, y no la de un hallazgo común', () => {
  const l = disputed()
  const once = decide(l, 'accept', ['F-1'], undefined, { 'F-1': proofOf('r-1') })
  assert.deepEqual(once.entries[0]!.decision, { action: 'accept', from: 'en-disputa', after_round: 2, proof: proofOf('r-1') })
  assert.deepEqual(once.entries[0]!.superseded, [{ action: 'reject', reason: 'es intencional', from: 'abierto', after_round: 1 }])
  const twice = decide(once, 'reject', ['F-1'], 'es intencional', { 'F-1': proofOf('r-2') })
  assert.deepEqual(twice.entries[0]!.superseded?.map((d) => d.action), ['reject', 'accept'])
  assert.deepEqual(twice.entries[0]!.decision?.proof, proofOf('r-2'))
  assert.equal(twice.entries[0]!.state, 'cerrado')

  // Un hallazgo común se redecide como siempre, y una decisión con prueba se guarda aunque ya no sea una disputa.
  const common = decide(decide(l, 'accept', ['F-2']), 'reject', ['F-2'], 'no aplica')
  assert.equal(common.entries[1]!.superseded, undefined)
  const withProof = decide(decide(l, 'accept', ['F-2'], undefined, { 'F-2': proofOf('r-3') }), 'reject', ['F-2'], 'no aplica')
  assert.deepEqual(withProof.entries[1]!.superseded?.map((d) => d.proof?.ref), ['r-3'])
  assert.deepEqual(decide(l, 'accept', ['F-2']), decide(l, 'accept', ['F-2'], undefined, {}))
})
