import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Admission, admit, admitRefutation, admitRound } from '../src/review/admit.ts'
import type { RoundPlan } from '../src/review/ledger.ts'
import type { Candidate } from '../src/review/candidate.ts'

const HASH = `sha256:${'a'.repeat(64)}`
const candidate: Candidate = {
  base_sha: 'b'.repeat(40), head_sha: null, hash: HASH, left_out: [], diff: '',
  files: [
    { path: 'src/x.ts', status: 'M', mode: '100644', sha256: 'c', binary: false, lines: 40, visible: [[7, 13], [30, 35]] },
    { path: 'src/nuevo.ts', status: 'A', mode: '100644', sha256: 'd', binary: false, lines: 3, visible: [[1, 3]] },
    { path: 'img.png', status: 'M', mode: '100644', sha256: 'e', binary: true, lines: 0, visible: [] },
  ],
  context: [{ path: '.plans/spec.md', sha256: 'f', lines: 12 }],
}
const PATHS = ['src/x.ts', 'src/nuevo.ts', 'img.png']

function review(over: Record<string, unknown> = {}, finding: Record<string, unknown> | null = {}): Record<string, unknown> {
  const f = { axis: 'quality', severity: 'WARNING', location: 'src/x.ts:8', claim: 'nombre poco claro', ...finding }
  return { candidate_hash: HASH, inspection: { status: 'completed', paths: PATHS }, findings: finding === null ? [] : [f], ...over }
}

const run = (text: string): Admission => admit(text, candidate)
const json = (o: unknown) => JSON.stringify(o)

function inadmissible(text: string, why: RegExp) {
  const a = run(text)
  assert.equal(a.kind, 'inadmissible', `se esperaba inadmisible: ${text.slice(0, 80)}`)
  if (a.kind === 'inadmissible') assert.match(a.error, why)
}

test('se admite un JSON válido, también rodeado de prosa o de un bloque de código', () => {
  for (const text of [json(review()), `Acá va mi revisión:\n${json(review())}\nListo.`, `\`\`\`json\n${json(review())}\n\`\`\``,
    `Uso {x} como ejemplo y después respondo: ${json(review())}`]) {
    const a = run(text)
    assert.equal(a.kind, 'admitted', text.slice(0, 60))
  }
})

test('se admiten citas visibles: un rango del hunk, el contexto y un binario por su ruta', () => {
  for (const location of ['src/x.ts:30-35', 'src/nuevo.ts:1', '.plans/spec.md:12', 'img.png']) {
    assert.equal(run(json(review({}, { location }))).kind, 'admitted', location)
  }
})

test('se rechaza si no hay exactamente un objeto con candidate_hash', () => {
  inadmissible(`${json(review())}\n${json(review())}`, /exactamente un objeto/)
  inadmissible('no pude revisar', /exactamente un objeto/)
  inadmissible(json(review()).slice(0, -3), /exactamente un objeto/)
})

test('se rechaza un hash distinto', () => {
  inadmissible(json(review({ candidate_hash: `sha256:${'9'.repeat(64)}` })), /candidate_hash/)
})

test('se rechaza una cobertura incompleta, con rutas de más o repetidas', () => {
  inadmissible(json(review({ inspection: { status: 'completed', paths: ['src/x.ts', 'img.png'] } })), /faltan.*src\/nuevo\.ts/)
  inadmissible(json(review({ inspection: { status: 'completed', paths: [...PATHS, 'otro.ts'] } })), /otro\.ts/)
  inadmissible(json(review({ inspection: { status: 'completed', paths: [...PATHS, 'img.png'] } })), /repetid/)
})

test('se rechazan citas que el revisor no pudo ver', () => {
  inadmissible(json(review({}, { location: 'src/y.ts:3' })), /src\/y\.ts/)
  inadmissible(json(review({}, { location: 'src/x.ts:20' })), /src\/x\.ts:20/)
  inadmissible(json(review({}, { location: 'src/x.ts:12-14' })), /src\/x\.ts:12-14/)
  inadmissible(json(review({}, { location: 'src/x.ts' })), /línea/)
  inadmissible(json(review({}, { location: 'img.png:1' })), /binario/)
  inadmissible(json(review({}, { location: '.plans/spec.md:13' })), /spec\.md:13/)
})

test('se rechazan un grave sin causalidad, campos desconocidos y valores fuera del enum', () => {
  inadmissible(json(review({}, { severity: 'BLOCKER' })), /causality/)
  inadmissible(json(review({ approved: true })), /approved/)
  inadmissible(json(review({}, { confidence: 'high' })), /confidence/)
  inadmissible(json(review({}, { severity: 'MAJOR' })), /severity/)
  inadmissible(json(review({}, { axis: 'style' })), /axis/)
})

test('todo grave declara evidence, también un preexistente, con uno de sus dos valores', () => {
  inadmissible(json(review({}, { severity: 'CRITICAL', causality: 'introduced' })), /evidence.*deterministic \| inferential/)
  inadmissible(json(review({}, { severity: 'BLOCKER', causality: 'pre-existing' })), /evidence/)
  inadmissible(json(review({}, { severity: 'CRITICAL', causality: 'introduced', evidence: 'probable' })), /evidence/)
  const a = run(json(review({}, { severity: 'CRITICAL', causality: 'introduced', evidence: 'inferential' })))
  assert.equal(a.kind, 'admitted')
  if (a.kind === 'admitted') assert.equal(a.review.findings[0].evidence, 'inferential')
  assert.equal(run(json(review({}, { severity: 'WARNING' }))).kind, 'admitted')
})

test('un revisor que declara que no pudo inspeccionar da unavailable; sin motivo es inadmisible', () => {
  const a = run(json(review({ inspection: { status: 'unavailable', paths: [], reason: 'el diff llegó cortado' } }, null)))
  assert.deepEqual(a, { kind: 'unavailable', reason: 'el diff llegó cortado' })
  inadmissible(json(review({ inspection: { status: 'unavailable', paths: [] } }, null)), /reason/)
})

const plan: RoundPlan = {
  n: 2, prev_hash: `sha256:${'0'.repeat(64)}`, identical: false,
  targets: [{ id: 'F-1', kind: 'verify' }, { id: 'F-2', kind: 'respond' }],
  changed: { 'src/x.ts': [[9, 11]], 'img.png': 'binary' },
}
const okResponses = [{ id: 'F-1', answer: 'resolved' }, { id: 'F-2', answer: 'withdrawn' }]
const roundReview = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ candidate_hash: HASH, inspection: { status: 'completed', paths: PATHS }, responses: okResponses, findings: [], ...over })
const regression = (location: string) => ({ axis: 'quality', severity: 'WARNING', location, claim: 'regresión' })

function roundInadmissible(o: Record<string, unknown>, why: RegExp, p: RoundPlan = plan) {
  const a = admitRound(json(o), candidate, p)
  assert.equal(a.kind, 'inadmissible', json(o).slice(0, 120))
  if (a.kind === 'inadmissible') assert.match(a.error, why)
}

test('admitRound admite una respuesta por ID y una regresión dentro de lo que cambió', () => {
  const a = admitRound(json(roundReview({
    responses: [{ id: 'F-1', answer: 'unresolved', evidence: 'src/x.ts:10', note: 'sigue' }, { id: 'F-2', answer: 'maintained', evidence: 'src/x.ts:31' }],
    findings: [regression('src/x.ts:9-11'), regression('img.png')],
  })), candidate, plan)
  assert.equal(a.kind, 'admitted')
  if (a.kind !== 'admitted') return
  assert.deepEqual(a.review.responses, [
    { id: 'F-1', answer: 'unresolved', evidence: 'src/x.ts:10', note: 'sigue' },
    { id: 'F-2', answer: 'maintained', evidence: 'src/x.ts:31' },
  ])
  assert.equal(a.review.findings.length, 2)
  assert.equal(a.review.candidate_hash, HASH)
})

test('admitRound rechaza una respuesta que falta, una de más, una repetida o de un tipo que no corresponde', () => {
  roundInadmissible(roundReview({ responses: [okResponses[0]] }), /falta.*F-2/)
  roundInadmissible(roundReview({ responses: [...okResponses, { id: 'F-3', answer: 'resolved' }] }), /F-3/)
  roundInadmissible(roundReview({ responses: [...okResponses, okResponses[0]] }), /F-1.*repetid/)
  roundInadmissible(roundReview({ responses: [{ id: 'F-1', answer: 'withdrawn' }, okResponses[1]] }), /F-1.*resolved \| unresolved/)
  roundInadmissible(roundReview({ responses: [okResponses[0], { id: 'F-2', answer: 'resolved' }] }), /F-2.*withdrawn \| maintained/)
  roundInadmissible(roundReview({ responses: [okResponses[0], { id: 'F-2', answer: 'ignored' }] }), /answer/)
  roundInadmissible(roundReview({ responses: [{ ...okResponses[0], extra: 1 }, okResponses[1]] }), /extra/)
})

test('admitRound exige evidencia visible en unresolved y maintained', () => {
  roundInadmissible(roundReview({ responses: [{ id: 'F-1', answer: 'unresolved' }, okResponses[1]] }), /F-1.*evidence/)
  roundInadmissible(roundReview({ responses: [okResponses[0], { id: 'F-2', answer: 'maintained' }] }), /F-2.*evidence/)
  roundInadmissible(roundReview({ responses: [{ id: 'F-1', answer: 'unresolved', evidence: 'src/x.ts:20' }, okResponses[1]] }), /src\/x\.ts:20/)
})

test('admitRound rechaza una regresión fuera de lo que cambió, y cualquiera con el candidato idéntico', () => {
  roundInadmissible(roundReview({ findings: [regression('src/x.ts:8')] }), /src\/x\.ts:8.*cambi/)
  roundInadmissible(roundReview({ findings: [regression('src/x.ts:11-12')] }), /src\/x\.ts:11-12/)
  roundInadmissible(roundReview({ findings: [regression('src/nuevo.ts:1')] }), /src\/nuevo\.ts:1/)
  roundInadmissible(roundReview({ findings: [regression('.plans/spec.md:1')] }), /spec\.md:1/)
  roundInadmissible(roundReview({ findings: [{ ...regression('src/x.ts:9'), severity: 'CRITICAL', causality: 'introduced' }] }), /evidence/)
  const identical = { ...plan, identical: true, changed: {}, targets: [{ id: 'F-2', kind: 'respond' as const }] }
  roundInadmissible(roundReview({ responses: [okResponses[1]], findings: [regression('src/x.ts:9')] }), /idéntico/, identical)
  assert.equal(admitRound(json(roundReview({ responses: [okResponses[1]] })), candidate, identical).kind, 'admitted')
})

test('admitRound comparte con la ronda 1 el hash, la cobertura y unavailable', () => {
  roundInadmissible(roundReview({ candidate_hash: `sha256:${'9'.repeat(64)}` }), /candidate_hash/)
  roundInadmissible(roundReview({ inspection: { status: 'completed', paths: ['src/x.ts'] } }), /faltan/)
  roundInadmissible(roundReview({ approved: true }), /approved/)
  const a = admitRound(json(roundReview({ inspection: { status: 'unavailable', paths: [], reason: 'sin material' } })), candidate, plan)
  assert.deepEqual(a, { kind: 'unavailable', reason: 'sin material' })
  assert.equal(admitRound(`${json(roundReview())}\n${json(roundReview())}`, candidate, plan).kind, 'inadmissible')
})

const refutation = (results: unknown[], over: Record<string, unknown> = {}) => json({ candidate_hash: HASH, results, ...over })

test('admitRefutation admite un resultado por ID con evidencia visible', () => {
  const a = admitRefutation(refutation([
    { id: 'F-4', result: 'refuted', evidence: 'src/x.ts:7', note: 'la guarda está arriba' },
    { id: 'F-5', result: 'inconclusive', evidence: '.plans/spec.md:2' },
  ]), candidate, ['F-4', 'F-5'])
  assert.equal(a.kind, 'admitted')
  if (a.kind === 'admitted') assert.deepEqual(a.review.results.map((r) => r.result), ['refuted', 'inconclusive'])
})

test('admitRefutation rechaza IDs que faltan, sobran o se repiten, valores fuera del enum y evidencia inválida', () => {
  const no = (text: string, why: RegExp) => {
    const a = admitRefutation(text, candidate, ['F-4', 'F-5'])
    assert.equal(a.kind, 'inadmissible', text)
    if (a.kind === 'inadmissible') assert.match(a.error, why)
  }
  const r4 = { id: 'F-4', result: 'refuted', evidence: 'src/x.ts:7' }
  const r5 = { id: 'F-5', result: 'corroborated', evidence: 'src/x.ts:8' }
  no(refutation([r4]), /falta.*F-5/)
  no(refutation([r4, r5, { ...r5, id: 'F-6' }]), /F-6/)
  no(refutation([r4, r5, r4]), /F-4.*repetid/)
  no(refutation([{ ...r4, result: 'false' }, r5]), /result/)
  no(refutation([{ id: 'F-4', result: 'refuted' }, r5]), /F-4.*evidence/)
  no(refutation([{ ...r4, evidence: 'src/x.ts:20' }, r5]), /src\/x\.ts:20/)
  no(refutation([r4, r5], { findings: [] }), /findings/)
  no(refutation([r4, r5], { candidate_hash: 'sha256:otro' }), /candidate_hash/)
})

test('una evidencia con texto después de la cita se rechaza diciendo dónde va la explicación', () => {
  const a = admitRefutation(refutation([{ id: 'F-4', result: 'corroborated', evidence: 'src/x.ts:8: la guarda no está' }]), candidate, ['F-4'])
  assert.equal(a.kind, 'inadmissible')
  if (a.kind === 'inadmissible') assert.match(a.error, /evidence es solo la cita ruta:línea; la explicación va en note/)
  const r = admitRound(json(roundReview({ responses: [{ id: 'F-1', answer: 'unresolved', evidence: 'src/x.ts:10 sigue igual' }, okResponses[1]] })), candidate, plan)
  assert.equal(r.kind, 'inadmissible')
  if (r.kind === 'inadmissible') assert.match(r.error, /la explicación va en note/)
})

test('la procedencia no la declara el modelo: se rechazan revisor y lote', () => {
  inadmissible(json(review({}, { reviewer: 'risk' })), /campo no admitido "reviewer" en findings\[0\]/)
  inadmissible(json(review({}, { batch: 2 })), /campo no admitido "batch" en findings\[0\]/)
})
