import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Candidate } from '../src/review/candidate.ts'
import {
  REVIEW_PROMPT_BUDGET, checkBudget, closingMessage, renderCorrectionPrompt, renderReviewPrompt,
} from '../src/review/prompt.ts'
import { SddError } from '../src/types.ts'

const HASH = `sha256:${'a'.repeat(64)}`
const candidate: Candidate = {
  base_sha: 'b'.repeat(40), head_sha: null, hash: HASH, left_out: [],
  files: [
    { path: 'src/x.ts', status: 'M', mode: '100644', sha256: 'c', binary: false, lines: 40, visible: [[7, 13], [30, 35]] },
    { path: 'src/nuevo.ts', status: 'A', mode: '100644', sha256: 'd', binary: false, lines: 3, visible: [[1, 3]] },
    { path: 'img.png', status: 'M', mode: '100644', sha256: 'e', binary: true, lines: 0, visible: [] },
  ],
  context: [{ path: '.plans/spec.md', sha256: 'f', lines: 2 }],
  diff: 'diff --git a/src/x.ts b/src/x.ts\n@@ -7,7 +7,7 @@\n-viejo\n+nuevo\n',
}
const prompt = renderReviewPrompt(candidate, new Map([['.plans/spec.md', '# Spec\nAC-1: hace X\n']]))

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

test('el presupuesto admite hasta 200 KiB y rechaza un byte más, sin truncar', () => {
  assert.equal(REVIEW_PROMPT_BUDGET, 200 * 1024)
  checkBudget('x'.repeat(REVIEW_PROMPT_BUDGET))
  assert.throws(() => checkBudget('x'.repeat(REVIEW_PROMPT_BUDGET + 1)), (e: unknown) =>
    e instanceof SddError && e.code === 'prompt_too_large' && e.detail === `${REVIEW_PROMPT_BUDGET + 1} > ${REVIEW_PROMPT_BUDGET}`)
})
