import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { alive, cli, deadPid, implement } from './cli-run-fixture.ts'
import { legacyGroup, legacyReservation, legacyRun, legacyVerify } from './legacy-reservation-fixture.ts'
import { checkoutLock, parallelFixture, release } from './parallel-worktrees-fixture.ts'

/** El contenido de `src/a.ts` en la base del fixture, y el del candidato que la verificación legacy había revertido. */
const BASE_CONTENT = 'export const f = () => 1\n'
const CANDIDATE_CONTENT = 'export const f = () => 2\n'

test('verify branch y commit legacy conservan exclusión global y recuperación propia mientras la reserva nueva del principal no bloquea al enlazado', async () => {
  const f = parallelFixture()
  try {
    const main = await f.writer(f.main, 'principal')
    const linked = await f.writer(f.right, 'linked')
    assert.ok(alive(main.group.pid) && alive(linked.group.pid))
    assert.equal(existsSync(checkoutLock(f.main)), true)
    release(main.barrier); release(linked.barrier)
    cli(f.main, ['wait', main.id, '--max', '15']); cli(f.right, ['wait', linked.id, '--max', '15'])
    for (const kind of ['verify', 'branch', 'commit'] as const) {
      const lock = legacyReservation(f.main.repo, `old-${kind}`, kind)
      const before = readFileSync(lock)
      assert.equal(implement(f.right).out.code, 'writer_open', kind)
      assert.deepEqual(readFileSync(lock), before)
      unlinkSync(lock)
      const orphan = legacyReservation(f.main.repo, `dead-${kind}`, kind, deadPid())
      const result = implement(f.right)
      if (kind === 'verify') {
        assert.equal(result.code, 0, JSON.stringify(result.out))
        cli(f.right, ['wait', result.out.id, '--max', '15'])
        assert.equal(existsSync(orphan), false)
      } else {
        assert.equal(result.out.code, 'writer_open')
        assert.ok(result.out.next.includes(orphan))
        assert.match(result.out.next, /hooks.*hijos/)
        assert.equal(existsSync(orphan), true)
        unlinkSync(orphan)
      }
    }
    const group = legacyGroup()
    const linkedTree = readFileSync(join(f.right.repo, 'src/a.ts'))
    const verifyLock = legacyVerify(f.main, 'old-verify-group', group.pid)
    try {
      assert.equal(implement(f.right).out.code, 'writer_open')
      assert.ok(existsSync(verifyLock))
      assert.equal(readFileSync(join(f.main.repo, 'src/a.ts'), 'utf8'), BASE_CONTENT)
    } finally { await group.stop() }
    const launched = implement(f.right)
    assert.equal(launched.code, 0, JSON.stringify(launched.out))
    cli(f.right, ['wait', launched.out.id, '--max', '15'])
    assert.equal(existsSync(verifyLock), false)
    assert.equal(readFileSync(join(f.main.repo, 'src/a.ts'), 'utf8'), BASE_CONTENT)
    cli(f.main, ['sdd', 'status', 'f'])
    assert.equal(readFileSync(join(f.main.repo, 'src/a.ts'), 'utf8'), CANDIDATE_CONTENT)
    assert.deepEqual(readFileSync(join(f.right.repo, 'src/a.ts')), linkedTree)
  } finally { await f.close() }
})

test('wait de una corrida legacy cosechada en un checkout no borra el writer.lock legacy con el mismo id de otro checkout', async () => {
  const f = parallelFixture()
  try {
    const id = 'legacy-owner'
    legacyRun(f.right, id)
    const lock = legacyReservation(f.main.repo, id)
    const before = readFileSync(lock)
    cli(f.right, ['wait', id, '--max', '1'])
    assert.equal(existsSync(lock), true, 'wait no libera un propietario distinto con el mismo id')
    assert.deepEqual(readFileSync(lock), before)
    unlinkSync(lock)
  } finally { await f.close() }
})
