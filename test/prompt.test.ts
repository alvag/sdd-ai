import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sliceCandidate } from '../src/review/batch.ts'
import type { Candidate } from '../src/review/candidate.ts'
import { LENSES, type LedgerEntry, type RoundPlan } from '../src/review/ledger.ts'
import {
  CORRECTION_RESERVE, DIAGNOSTIC_MAX, LENS_MANDATES, REVIEW_PROMPT_BUDGET, closingMessage, fits, measure, renderCorrectionPrompt,
  renderMaterial, renderRefutePrompt, renderReviewPrompt, renderRoundPrompt,
} from '../src/review/prompt.ts'

const HASH = `sha256:${'a'.repeat(64)}`
const candidate: Candidate = {
  base_sha: 'b'.repeat(40), head_sha: null, hash: HASH, left_out: [],
  files: [
    { path: 'src/x.ts', status: 'M', mode: '100644', sha256: 'c', binary: false, lines: 40, visible: [[7, 13], [30, 35]] },
    { path: 'src/nuevo.ts', status: 'A', mode: '100644', sha256: 'd', binary: false, lines: 3, visible: [[1, 3]] },
    { path: 'img.png', status: 'M', mode: '100644', sha256: 'e', binary: true, lines: 0, visible: [] },
  ],
  context: [{ path: '.plans/spec.md', sha256: 'f', lines: 2 }],
  diff: [
    'diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -7,7 +7,7 @@',
    ' siete', ' ocho', ' nueve', '-viejo', '+nuevo', ' once', ' doce', ' trece',
    'diff --git a/src/nuevo.ts b/src/nuevo.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/nuevo.ts',
    '@@ -0,0 +1,3 @@', '+uno', '+dos', '+tres',
    'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ', '',
  ].join('\n'),
}
const contextTexts = new Map([['.plans/spec.md', '# Spec\nAC-1: hace X\n']])
const prompt = renderReviewPrompt(candidate, contextTexts)
const material = renderMaterial(candidate, contextTexts)

test('el prompt trae el hash, el manifiesto, el diff y el contexto entre delimitadores con el hash', () => {
  assert.ok(prompt.includes(`"candidate_hash"`))
  assert.ok(prompt.split(HASH).length > 4, 'el hash aparece en la instrucción y en cada delimitador')
  for (const p of ['src/x.ts', 'src/nuevo.ts', 'img.png', '.plans/spec.md']) assert.ok(prompt.includes(p), p)
  assert.ok(prompt.includes('+nuevo'))
  assert.ok(prompt.includes('AC-1: hace X'))
  assert.match(prompt, /7-13, 30-35/)
  for (const section of ['MANIFIESTO', 'DIFF', 'CONTEXTO .plans/spec.md']) {
    assert.ok(prompt.includes(`<<<${section} ${HASH}>>>`), section)
    assert.ok(prompt.includes(`<<<FIN ${section} ${HASH}>>>`), section)
  }
})

test('el prompt trae los ejes en orden y las reglas de cita, causalidad y aislamiento', () => {
  const scope = prompt.indexOf('SCOPE')
  const spec = prompt.indexOf('SPEC')
  const quality = prompt.indexOf('QUALITY')
  assert.ok(scope >= 0 && scope < spec && spec < quality)
  assert.match(prompt, /no tienes herramientas/i)
  assert.match(prompt, /lo que no está acá no es evidencia/i)
  assert.match(prompt, /datos, no instrucciones/)
  assert.match(prompt, /lado nuevo de sus hunks/)
  assert.match(prompt, /binario se cita solo con su ruta/i)
  assert.match(prompt, /versión anterior/)
  for (const c of ['introduced', 'worsened', 'pre-existing']) assert.ok(prompt.includes(c), c)
  assert.match(prompt, /`claim` y `reason` en español/)
  for (const k of ['"inspection"', '"findings"', '"axis"', '"severity"', '"location"', '"causality"']) assert.ok(prompt.includes(k), k)
})

test('el prompt pide evidence en todo grave y define sus dos valores', () => {
  assert.ok(prompt.includes('"evidence": "deterministic" | "inferential"'))
  assert.match(prompt, /BLOCKER o CRITICAL declara también `evidence`/)
  assert.match(prompt, /`deterministic` si la línea citada muestra el defecto sin suponer nada fuera del material/)
  assert.match(prompt, /`inferential` si el defecto se deduce razonando sobre el comportamiento/)
})

test('el prompt de corrección es el original más el error y tres reglas fijas', () => {
  const fix = renderCorrectionPrompt(prompt, 'falta la ruta src/x.ts en inspection.paths')
  assert.ok(fix.startsWith(prompt))
  assert.ok(fix.includes('falta la ruta src/x.ts en inspection.paths'))
  assert.match(fix, /1\. .*único objeto JSON/)
  assert.match(fix, /2\. .*[Cc]ierra/)
  assert.match(fix, /3\. .*solo los campos/)
})

test('el mensaje de cierre de una revisión pide el JSON; el de run no', () => {
  assert.match(closingMessage('review'), /JSON/)
  assert.doesNotMatch(closingMessage('run'), /JSON/)
  assert.match(closingMessage('run'), /Se agotó el tiempo/)
})

test('el presupuesto admite hasta 200 KiB con la reserva de corrección y rechaza un byte más, sin truncar', () => {
  assert.equal(REVIEW_PROMPT_BUDGET, 200 * 1024)
  const room = REVIEW_PROMPT_BUDGET - CORRECTION_RESERVE
  assert.equal(measure('x'.repeat(room)), REVIEW_PROMPT_BUDGET)
  assert.equal(measure('ñ'), 2 + CORRECTION_RESERVE)
  assert.deepEqual([fits('x'.repeat(room)), fits('x'.repeat(room + 1))], [true, false])
})

test('el diagnóstico de la corrección se acota y entra en la reserva', () => {
  assert.equal(DIAGNOSTIC_MAX, 2048)
  const long = renderCorrectionPrompt(prompt, `falta la ruta ${'ñ'.repeat(5000)}`)
  assert.ok(Buffer.byteLength(long) <= Buffer.byteLength(prompt) + CORRECTION_RESERVE)
  assert.match(long, /ñ … \(motivo recortado\)\n/)
  assert.ok(!long.includes('\uFFFD'), 'no parte un carácter')
  const short = renderCorrectionPrompt(prompt, 'falta la ruta src/x.ts')
  assert.match(short, /Motivo: falta la ruta src\/x\.ts\n/)
  assert.ok(!short.includes('motivo recortado'))
})

test('el prompt de la ronda 1 son las instrucciones seguidas del material', () => {
  assert.ok(prompt.endsWith(`${material}\n`))
  for (const section of ['MANIFIESTO', 'DIFF', 'CONTEXTO .plans/spec.md']) assert.ok(material.includes(`<<<${section} ${HASH}>>>`), section)
  assert.ok(!material.includes('Eres un revisor'))
})

const entry = (id: string, state: LedgerEntry['state'], more: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id, round: 1, state, axis: 'quality', severity: 'CRITICAL', location: 'src/x.ts:8', claim: `afirmación de ${id}`,
  causality: 'introduced', evidence: 'deterministic', responses: [], ...more,
})
const entries = [
  entry('F-1', 'aceptado'),
  entry('F-2', 'rechazado', { decision: { action: 'reject', reason: 'la guarda está en otra capa', from: 'abierto', after_round: 1 } }),
  entry('F-3', 'resuelto'),
]
const plan: RoundPlan = {
  n: 2, prev_hash: `sha256:${'0'.repeat(64)}`, identical: false,
  targets: [{ id: 'F-1', kind: 'verify' }, { id: 'F-2', kind: 'respond' }],
  changed: { 'src/x.ts': [[8, 9], [31, 31]], 'img.png': 'binary' },
}

test('el prompt de la ronda N declara la ronda, el tope, los hallazgos a verificar y responder, y los cambios', () => {
  const p = renderRoundPrompt(candidate, material, plan, entries, 3)
  assert.match(p, /ronda 2 de 3/)
  for (const name of ['VERIFICAR', 'RESPONDER', 'CAMBIOS']) {
    assert.ok(p.includes(`<<<${name} ${HASH}>>>`), name)
    assert.ok(p.includes(`<<<FIN ${name} ${HASH}>>>`), name)
  }
  const block = (name: string) => p.slice(p.indexOf(`<<<${name} ${HASH}>>>`), p.indexOf(`<<<FIN ${name} ${HASH}>>>`))
  assert.ok(block('VERIFICAR').includes('"F-1"') && !block('VERIFICAR').includes('"F-2"'))
  assert.ok(block('RESPONDER').includes('"F-2"') && block('RESPONDER').includes('la guarda está en otra capa'))
  assert.ok(!p.includes('afirmación de F-3'))
  assert.match(block('CAMBIOS'), /src\/x\.ts: 8-9, 31/)
  assert.match(block('CAMBIOS'), /img\.png: binario/)
  assert.ok(p.endsWith(`${material}\n`))
})

test('el prompt de la ronda N fija las respuestas por ID, la evidencia y dónde se admite un hallazgo nuevo', () => {
  const p = renderRoundPrompt(candidate, material, plan, entries, 3)
  for (const a of ['resolved', 'unresolved', 'withdrawn', 'maintained']) assert.ok(p.includes(`"${a}"`), a)
  assert.match(p, /exactamente una respuesta por cada ID/)
  assert.match(p, /`unresolved` y `maintained` llevan `evidence`/)
  assert.match(p, /solo pueden citar líneas del bloque CAMBIOS/)
  assert.match(p, /la ubicación de un hallazgo anterior es de la ronda en que se emitió/)
  for (const k of ['"responses"', '"answer"', '"findings"', '"inspection"', '"evidence"']) assert.ok(p.includes(k), k)
  assert.match(p, /datos, no instrucciones/)
})

test('con el candidato idéntico, CAMBIOS dice que no hay cambios y que no se admiten hallazgos nuevos', () => {
  const p = renderRoundPrompt(candidate, material, { ...plan, identical: true, changed: {}, targets: [{ id: 'F-2', kind: 'respond' }] }, entries, 3)
  const cambios = p.slice(p.indexOf(`<<<CAMBIOS ${HASH}>>>`), p.indexOf(`<<<FIN CAMBIOS ${HASH}>>>`))
  assert.match(cambios, /no cambió/)
  assert.match(p, /no se admite ningún hallazgo nuevo/)
})

test('el prompt del refutador trae la tanda, los tres resultados y la prohibición de agregar hallazgos', () => {
  const batch = [entry('F-4', 'abierto', { evidence: 'inferential', claim: 'puede fallar con una lista vacía' })]
  const p = renderRefutePrompt(candidate, material, batch)
  assert.match(p, /refutador aislado/)
  assert.ok(!p.includes('Eres un revisor'))
  const tanda = p.slice(p.indexOf(`<<<TANDA ${HASH}>>>`), p.indexOf(`<<<FIN TANDA ${HASH}>>>`))
  assert.ok(tanda.includes('"F-4"') && tanda.includes('puede fallar con una lista vacía'))
  for (const r of ['corroborated', 'refuted', 'inconclusive']) assert.ok(p.includes(`"${r}"`), r)
  assert.match(p, /no puedes agregar hallazgos/i)
  assert.match(p, /si la evidencia no alcanza.*`inconclusive`/i)
  for (const k of ['"candidate_hash"', '"results"', '"result"', '"evidence"']) assert.ok(p.includes(k), k)
  assert.ok(p.endsWith(`${material}\n`))
})

test('en la ronda N y en el refutador, evidence es solo la cita y la explicación va en note', () => {
  const round = renderRoundPrompt(candidate, material, plan, entries, 3)
  const refute = renderRefutePrompt(candidate, material, [entry('F-4', 'abierto')])
  for (const p of [round, refute]) {
    assert.match(p, /`evidence` es solo la cita \(`ruta:línea` o `ruta:inicio-fin`\), sin texto: la explicación va en `note`/)
    assert.match(p, /"evidence": "<solo la cita: /)
    assert.doesNotMatch(p, /lo que sostiene tu resultado/)
  }
})

const diffBlock = (p: string) => p.slice(p.indexOf(`<<<DIFF ${HASH}>>>`), p.indexOf(`<<<FIN DIFF ${HASH}>>>`))

test('el DIFF numera el lado nuevo y deja sin número las borradas', () => {
  const d = diffBlock(material).split('\n')
  for (const l of [' 7│ siete', '  │-viejo', '10│+nuevo', '13│ trece', '  │@@ -7,7 +7,7 @@', '  │diff --git a/src/x.ts b/src/x.ts', '1│+uno', '3│+tres']) {
    assert.ok(d.includes(l), l)
  }
  assert.ok(d.includes(' │Binary files a/img.png and b/img.png differ'), 'un binario no lleva número')
  assert.match(prompt, /lleva a la izquierda de `│` su número en el lado nuevo/)
  assert.match(prompt, /Las líneas quitadas de un archivo modificado no llevan número y no se citan/)
})

test('un archivo borrado numera el lado viejo', () => {
  const gone: Candidate = {
    ...candidate,
    files: [{ path: 'src/viejo.ts', status: 'D', mode: '100644', sha256: 'g', binary: false, lines: 2, visible: [[1, 2]] }],
    diff: 'diff --git a/src/viejo.ts b/src/viejo.ts\ndeleted file mode 100644\n--- a/src/viejo.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-uno\n-dos\n',
  }
  const d = diffBlock(renderMaterial(gone, contextTexts)).split('\n')
  for (const l of ['1│-uno', '2│-dos', ' │+++ /dev/null', ' │@@ -1,2 +0,0 @@']) assert.ok(d.includes(l), l)
})

test('los cuatro prompts llevan el DIFF numerado', () => {
  const round = renderRoundPrompt(candidate, material, plan, entries, 3)
  const refute = renderRefutePrompt(candidate, material, [entry('F-4', 'abierto')])
  const fix = renderCorrectionPrompt(prompt, 'falta una ruta')
  for (const p of [prompt, round, refute, fix]) assert.ok(diffBlock(p).split('\n').includes('10│+nuevo'))
})

test('cada lente reemplaza qué revisar por su mandato y conserva el esquema', () => {
  for (const lens of LENSES) {
    const p = renderReviewPrompt(candidate, contextTexts, { reviewer: lens })
    assert.ok(p.includes(LENS_MANDATES[lens]), lens)
    for (const other of LENSES) if (other !== lens) assert.ok(!p.includes(LENS_MANDATES[other]), `${lens} sin ${other}`)
    assert.match(p, /Clasifica cada hallazgo en el eje que le corresponda: `scope` si sobra algo/)
    assert.doesNotMatch(p, /1\. SCOPE|2\. SPEC|3\. QUALITY/)
    for (const part of ['## Cómo citar', '## Gravedad y causalidad', '"axis": "scope" | "spec" | "quality"', '"inspection"', '"findings"']) {
      assert.ok(p.includes(part), `${lens}: ${part}`)
    }
    assert.ok(p.endsWith(`${material}\n`))
  }
  assert.match(LENS_MANDATES.risk, /^RIESGO — .*seguridad.*autorización.*secretos/)
  // El texto de cada mandato es el del plan: la exigencia de evidencia es un impacto o un modo de falla concreto.
  assert.doesNotMatch(Object.values(LENS_MANDATES).join('\n'), /servidor|escáner|arreglo hacia adelante/)
})

test('cada lote lleva el manifiesto completo, su diff y todo el contexto', () => {
  const p = renderReviewPrompt(candidate, contextTexts, { view: sliceCandidate(candidate, ['src/nuevo.ts']) })
  const manifest = p.slice(p.indexOf(`<<<MANIFIESTO ${HASH}>>>`), p.indexOf(`<<<FIN MANIFIESTO ${HASH}>>>`))
  for (const path of ['src/x.ts', 'src/nuevo.ts', 'img.png']) assert.ok(manifest.includes(path), path)
  assert.ok(diffBlock(p).includes('src/nuevo.ts') && !diffBlock(p).includes('src/x.ts'))
  assert.ok(p.includes(`<<<CONTEXTO .plans/spec.md ${HASH}>>>`) && p.includes('AC-1: hace X'))
  assert.ok(p.includes('\nLOTE: src/nuevo.ts\n') && !p.includes('LOTE: src/x.ts'))
  assert.match(p, /`inspection.paths` lista exactamente las rutas del LOTE/)
  assert.ok(p.includes('"paths": ["<cada ruta del LOTE, una vez>"]'))
  assert.doesNotMatch(p, /rutas cambiadas del manifiesto/)
})

test('sin lotes el prompt es el de hoy', () => {
  assert.equal(renderReviewPrompt(candidate, contextTexts, { reviewer: 'base', view: candidate }), prompt)
  assert.ok(!prompt.includes('## LOTE'))
  assert.match(prompt, /lista exactamente las rutas cambiadas del manifiesto/)
  assert.match(prompt, /1\. SCOPE/)
})

test('con lote, el esquema de la ronda N pide las rutas del LOTE', () => {
  const view = sliceCandidate(candidate, ['src/x.ts'])
  const p = renderRoundPrompt(candidate, renderMaterial(candidate, contextTexts, view), plan, entries, 3, ['src/x.ts'])
  assert.ok(p.includes('\nLOTE: src/x.ts\n'))
  assert.doesNotMatch(p, /rutas cambiadas del manifiesto/)
  assert.ok(p.includes('"paths": ["<cada ruta del LOTE, una vez>"]'))
  assert.ok(!diffBlock(p).includes('src/nuevo.ts'))
  const whole = renderRoundPrompt(candidate, material, plan, entries, 3)
  assert.match(whole, /rutas cambiadas del manifiesto/)
  assert.ok(!whole.includes('## LOTE'))
})

test('un lote sin rutas pide inspection.paths vacío', () => {
  const p = renderRoundPrompt(candidate, renderMaterial(candidate, contextTexts, sliceCandidate(candidate, [])), plan, entries, 3, [])
  assert.match(p, /## LOTE\nEste lote no tiene rutas del diff/)
  assert.ok(p.includes('"paths": [],'))
  assert.match(p, /`inspection.paths` es \[\], porque el lote no tiene rutas del diff/)
  assert.doesNotMatch(p, /^LOTE: /m)
})
