import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, implement, readJsonFile, storeOf } from './cli-run-fixture.ts'
import { legacyLock, legacyWriter } from './legacy-reservation-fixture.ts'
import { parallelFixture, release } from './parallel-worktrees-fixture.ts'

test('un writer legacy mantiene exclusión global y admite recepción cosecha cancelación y consulta posterior sin migrar sus registros', async () => {
  for (const cancel of [false, true]) {
    const f = parallelFixture()
    try {
      const writer = await legacyWriter(f, f.left, 'legacy', [{ write: 'legacy.txt', content: 'legacy\n' }])
      const control = join(storeOf(f.left.repo, writer.id), 'control.json')
      const before = readFileSync(control)
      const locked = readFileSync(legacyLock(f.left.repo))
      assert.equal(implement(f.right).out.code, 'writer_open')
      assert.deepEqual(readFileSync(legacyLock(f.left.repo)), locked)
      if (cancel) cli(f.left, ['cancel', writer.id])
      else release(writer.barrier)
      const result = cli(f.left, ['wait', writer.id, '--max', '15'])
      assert.equal(result.out.state, cancel ? 'cancelled' : 'done', JSON.stringify(result.out))
      assert.equal(existsSync(legacyLock(f.left.repo)), false)
      assert.deepEqual(readFileSync(control), before)
      const record = readJsonFile(join(storeOf(f.left.repo, writer.id), 'harvest.json'))
      assert.equal(record.state, result.out.state)
      const terminal = readFileSync(join(storeOf(f.left.repo, writer.id), 'harvest.json'))
      // La consulta posterior de una corrida legacy terminada responde su estado, sin reescribir la cosecha.
      const again = cli(f.left, ['wait', writer.id, '--max', '1'])
      assert.equal(again.code, result.code, JSON.stringify(again.out))
      assert.equal(again.out.state, result.out.state)
      assert.deepEqual(readFileSync(join(storeOf(f.left.repo, writer.id), 'harvest.json')), terminal)
    } finally { await f.close() }
  }
})
