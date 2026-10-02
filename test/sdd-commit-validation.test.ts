import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, statSync } from 'node:fs'
import { runBin } from './helpers.ts'
import {
  subject, FOREIGN_DIGEST, file, text, put, planPath, registry, writeRegistry, success, draft, apply, snapshot,
  unchanged, refused, committable,
} from './sdd-commit-fixture.ts'

test('sdd commit rechaza sin tocar nada un change_type inválido y un asunto vacío, de varias líneas, con mayúscula inicial o demasiado largo', () => {
  const { s } = committable()
  for (const value of ['', ' ', 'dos\nlíneas', 'dos\rlíneas', 'Mayúscula', 'a'.repeat(72)]) {
    const before = snapshot(s)
    assert.equal(draft(s, value).out.code, 'subject_invalid')
    assert.equal(apply(s, FOREIGN_DIGEST, value).out.code, 'subject_invalid')
    unchanged(s, before)
  }
  put(s, planPath, text(s, planPath).replace('change_type: feat', 'change_type: invalid'))
  refused(s, 'change_type_invalid', FOREIGN_DIGEST)
})

test('el registro de fases rechaza un commit cuya fecha no es un instante ISO completo', () => {
  const { s } = committable()
  success(apply(s, success(draft(s)).digest))
  const r = registry(s)
  // Solo fecha, sin hora, también se rechaza: el registro guarda el instante del commit.
  for (const at of ['October 1, 2026', '2026-10-01', 'invalid']) {
    writeRegistry(s, { ...r, commit: { ...r.commit, at } })
    const invalidBefore = snapshot(s)
    assert.equal(draft(s).out.code, 'phases_invalid')
    unchanged(s, invalidBefore)
  }
})

test('sdd commit --apply sin digest o con uno que no coincide no toca nada', () => {
  const { s } = committable()
  const before = snapshot(s)
  const missing = runBin(s, ['sdd', 'commit', 'f', '--subject', subject, '--apply'])
  assert.equal(missing.out.code, 'usage'); unchanged(s, before)
  const mismatch = apply(s, FOREIGN_DIGEST)
  assert.equal(mismatch.out.code, 'digest_mismatch'); unchanged(s, before)
  assert.equal(runBin(s, ['sdd', 'commit', 'f', '--subject', subject, '--digest', 'x']).out.code, 'usage')
  unchanged(s, before)
})

test('sin escritura en el directorio de Git, sdd commit --apply se niega con git_unwritable antes de tocar el índice', (t) => {
  // root escribe aunque el directorio sea 0555: ahí chmod no simula el sandbox.
  if (process.getuid?.() === 0) return t.skip('corre como root: chmod no quita la escritura')
  const { s } = committable()
  const d = success(draft(s))
  const before = snapshot(s)
  for (const dir of ['.git/objects', '.git/refs']) {
    const mode = statSync(file(s, dir)).mode & 0o7777
    chmodSync(file(s, dir), 0o555)
    try {
      const r = apply(s, d.digest)
      assert.equal(r.out.code, 'git_unwritable', JSON.stringify(r.out))
      assert.match(r.out.next, /escalada/)
      unchanged(s, before)
    } finally { chmodSync(file(s, dir), mode) }
  }
})
