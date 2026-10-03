import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { alive, cli, readJsonFile, storeOf } from './cli-run-fixture.ts'
import { checkoutLock, parallelFixture, release } from './parallel-worktrees-fixture.ts'

test('con el mismo id de corrida en dos checkouts wait y cancel en uno no liberan la reserva del otro y el control cosechas y registros de cada uno quedan en su directorio Git', async () => {
  const f = parallelFixture()
  try {
    const previous = await f.writer(f.right, 'finished')
    release(previous.barrier)
    assert.equal(cli(f.right, ['wait', previous.id, '--max', '15']).out.state, 'done')
    const active = await f.writer(f.left, 'active')
    // Una corrida que solo existe en el otro checkout no se encuentra desde este.
    assert.equal(cli(f.right, ['wait', active.id, '--max', '1']).out.code, 'run_not_found')
    const old = storeOf(f.right.repo, previous.id)
    const dir = storeOf(f.right.repo, active.id)
    renameSync(old, dir)
    for (const file of ['control.json', 'harvest.json']) {
      const data = readJsonFile(join(dir, file))
      data.id = active.id
      if (file === 'harvest.json') data.patchFile = join(dir, 'diff.patch')
      writeFileSync(join(dir, file), JSON.stringify(data))
    }
    // Con la implementación de la base (la confirmación por reversión), la reserva es el writer.lock global. Se
    // compara la que exista para que, sobre la base, falle la liberación ajena y no esta lectura.
    const lock = existsSync(checkoutLock(f.left)) ? checkoutLock(f.left) : join(gitDirs(f.left.repo).commonDir, 'sdd-ai', 'writer.lock')
    const bytes = readFileSync(lock)
    const leftStore = storeOf(f.left.repo, active.id)
    const leftRecords = () => Object.fromEntries(['control.json', 'argv.json', 'prompt.md', 'request.json']
      .filter((file) => existsSync(join(leftStore, file))).map((file) => [file, readFileSync(join(leftStore, file))]))
    const recordsBefore = leftRecords()
    for (const args of [['wait', active.id, '--max', '1'], ['cancel', active.id]]) {
      // El otro checkout recibe y cancela su propia corrida, ya cosechada: responde su estado terminal.
      const own = cli(f.right, args)
      assert.equal(own.code, 0, `${args[0]}: ${JSON.stringify(own.out)}`)
      assert.equal(own.out.state, 'done', `${args[0]}: ${JSON.stringify(own.out)}`)
      assert.equal(existsSync(lock), true, 'la recepción ajena no libera al writer activo')
      assert.deepEqual(readFileSync(lock), bytes)
      assert.ok(alive(active.group.pid))
    }
    // Cada checkout guarda sus corridas en su directorio Git, y los registros del otro quedan intactos.
    assert.notEqual(dir, leftStore)
    assert.ok(dir.startsWith(gitDirs(f.right.repo).gitDir) && leftStore.startsWith(gitDirs(f.left.repo).gitDir))
    assert.deepEqual(leftRecords(), recordsBefore)
    assert.equal(existsSync(join(leftStore, 'harvest.json')), false, 'la cosecha del otro checkout no toca la corrida activa')
    release(active.barrier)
  } finally { await f.close() }
})
