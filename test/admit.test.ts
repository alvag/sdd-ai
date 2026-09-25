import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Admission, type Finding, admit, verdict } from '../src/review/admit.ts'
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

test('un revisor que declara que no pudo inspeccionar da unavailable; sin motivo es inadmisible', () => {
  const a = run(json(review({ inspection: { status: 'unavailable', paths: [], reason: 'el diff llegó cortado' } }, null)))
  assert.deepEqual(a, { kind: 'unavailable', reason: 'el diff llegó cortado' })
  inadmissible(json(review({ inspection: { status: 'unavailable', paths: [] } }, null)), /reason/)
})

const f = (axis: Finding['axis'], severity: Finding['severity'], causality?: Finding['causality']): Finding =>
  ({ axis, severity, location: 'src/x.ts:8', claim: 'x', ...(causality ? { causality } : {}) })

test('los ejes salen de los hallazgos: un grave introducido o empeorado hace fallar su eje', () => {
  const v = verdict([f('scope', 'CRITICAL', 'introduced'), f('quality', 'WARNING')])
  assert.deepEqual([v.scope, v.spec, v.quality], ['fail', 'ok', 'ok'])
  assert.equal(verdict([f('quality', 'BLOCKER', 'worsened')]).quality, 'fail')
})

test('un grave preexistente va aparte y no hace fallar ningún eje', () => {
  const pre = f('spec', 'BLOCKER', 'pre-existing')
  const v = verdict([pre])
  assert.deepEqual([v.scope, v.spec, v.quality], ['ok', 'ok', 'ok'])
  assert.deepEqual(v.out_of_scope, [pre])
  assert.deepEqual(v.findings, [])
})

test('SPEC con solo advertencias queda en warn', () => {
  const v = verdict([f('spec', 'WARNING'), f('spec', 'SUGGESTION')])
  assert.equal(v.spec, 'warn')
  assert.equal(verdict([f('spec', 'SUGGESTION')]).spec, 'ok')
})
