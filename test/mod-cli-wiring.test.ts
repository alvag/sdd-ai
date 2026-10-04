import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOD_ADOPTION_MESSAGE, MOD_PATH } from '../src/mod-copies.ts'
import { modFixture, write } from './mod-fixture.ts'

test('doctor and agents sync report the mod copy and its adoption', () => {
  const c = modFixture()
  try {
    assert.equal(c.cli(['doctor']).out.mod.copies[0].state, 'missing')
    const sync = c.cli(['agents', 'sync'])
    assert.equal(sync.code, 0, sync.stderr)
    assert.ok(sync.out.written.some((path: string) => path.includes(MOD_PATH)))
    assert.ok(sync.out.next.includes(MOD_ADOPTION_MESSAGE))
    assert.match(sync.out.next, /\/reload-plugins/)
    // Los CLIs falsos no anuncian sus flags, así que doctor no llega a ok: el contraste es la recomendación del mod,
    // ausente con la copia vigente y presente con la desactualizada. Que el mod cuente para ok lo prueba V5.
    const current = c.cli(['doctor'])
    assert.equal(current.out.mod.copies[0].state, 'ok')
    assert.equal(current.out.mod.next, undefined)
    write(c.root, `${MOD_PATH}/hooks/register.tsx`, 'stale')
    const stale = c.cli(['doctor'])
    assert.equal(stale.code, 1)
    assert.equal(stale.out.mod.copies[0].state, 'stale')
    assert.equal(stale.out.mod.next, './bin/sdd-ai agents sync')
  } finally { c.dispose() }
})
