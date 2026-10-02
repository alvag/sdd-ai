import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type DigestInput, commitDigest, commitMessage } from '../src/sdd/commit.ts'

test('el digest del commit cambia con el contenido, el modo, el mensaje, el recibo o la revisión y no con HEAD', () => {
  const d: DigestInput = { flow: 'f', base: 'a'.repeat(40), entries: [['b', `100644 ${'b'.repeat(40)}`], ['a', null]],
    message: 'feat: agrega algo\n', receipt: { id: 'r', digest: `sha256:${'c'.repeat(64)}` }, review: 'review-1' }
  const original = commitDigest(d)
  assert.equal(commitDigest({ ...d, entries: [...d.entries].reverse() }), original)
  for (const changed of [
    { ...d, entries: [['b', `100644 ${'d'.repeat(40)}`], ['a', null]] as Array<[string, string | null]> },
    { ...d, entries: [['b', `100755 ${'b'.repeat(40)}`], ['a', null]] as Array<[string, string | null]> },
    { ...d, message: 'fix: corrige algo\n' }, { ...d, receipt: { ...d.receipt, id: 'other' } },
    { ...d, receipt: { ...d.receipt, digest: `sha256:${'e'.repeat(64)}` } }, { ...d, review: 'review-2' },
    { ...d, base: 'f'.repeat(40) },
  ]) assert.notEqual(commitDigest(changed), original)
  // HEAD no es parte de DigestInput: que el ensayo repetido sobre otro HEAD dé el mismo digest lo prueban las de la CLI.
})

test('el mensaje del commit toma el tipo, el ticket del flujo o de la rama y los extras, sin firmas', () => {
  const m = { changeType: 'feat', flowId: 'PQTCH2025-332', branch: 'feature/OTHER-123', subject: 'agrega algo',
    plan: '# Plan\n\n## Extras (fuera de AC)\n\n- E1 — primero\n- E-2 — segundo\n- otro\n\n## Verify\n- E3 — fuera\n' }
  assert.equal(commitMessage(m), 'feat(PQTCH2025-332): agrega algo\n\n- E1 — primero\n- E-2 — segundo\n')
  assert.equal(commitMessage({ ...m, flowId: 'f', plan: '' }), 'feat(OTHER-123): agrega algo\n')
  assert.equal(commitMessage({ ...m, flowId: 'f', branch: 'feature/f', plan: '' }), 'feat: agrega algo\n')
  assert.doesNotMatch(commitMessage(m), /Co-Authored-By|Signed-off-by/)
  assert.throws(() => commitMessage({ ...m, changeType: 'plain' }), { code: 'change_type_invalid' })
  for (const subject of ['', ' ', 'dos\nlíneas', 'dos\rlíneas', 'Mayúscula', 'Árbol', 'a'.repeat(72)]) {
    assert.throws(() => commitMessage({ ...m, subject }), { code: 'subject_invalid' })
  }
  // La primera línea tiene que medir menos de 72 puntos de código; con `feat: ` adelante, el asunto llega a 65.
  const limit = 72
  const longest = limit - 1 - 'feat: '.length
  assert.equal([...commitMessage({ ...m, flowId: 'f', branch: null, plan: '', subject: 'a'.repeat(longest) }).split('\n')[0]].length, limit - 1)
  assert.throws(() => commitMessage({ ...m, flowId: 'f', branch: null, subject: 'a'.repeat(longest + 1) }), { code: 'subject_invalid' })
  // Un carácter fuera del BMP ocupa dos unidades UTF-16 pero es un solo punto de código.
  const astral = `${'a'.repeat(longest - 1)}😀`
  assert.equal(commitMessage({ ...m, flowId: 'f', branch: null, plan: '', subject: astral }), `feat: ${astral}\n`)
})
