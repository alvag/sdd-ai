import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { cli, readJsonFile } from './cli-run-fixture.ts'
import { groupCeased, arrived, checkoutLock, kill, parallelFixture, verifyBarrierFlow } from './parallel-worktrees-fixture.ts'

/** El grupo que verify anotó en su reserva, cuando ya lo anotó: un entero mayor que 1. */
async function registeredGroup(lock: string): Promise<number> {
  const until = Date.now() + 10000
  for (;;) {
    const group = readJsonFile(lock).group
    if (Number.isInteger(group) && group > 1) return group
    assert.ok(Date.now() < until, `verify no registró el grupo de la fila en ${lock}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('verify interrumpido retiene reserva y contenido mientras vive su fila y restaura después del cese sin pisar un tercer contenido ni otro checkout', async () => {
  for (const conflict of [false, true]) {
    const f = parallelFixture()
    try {
      const gate = f.barrier('confirmation')
      verifyBarrierFlow(f.left, gate, true)
      const other = readFileSync(join(f.right.repo, 'src/a.ts'))
      const otherSecond = readFileSync(join(f.right.repo, 'src/b.ts'))
      const run = f.launch(f.left, ['sdd', 'verify', 'f'])
      await arrived(gate)
      // La fila puede anunciar su llegada antes de que el padre registre su grupo en la reserva: se espera a leerlo.
      const group = await registeredGroup(checkoutLock(f.left))
      assert.equal(readFileSync(join(f.left.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 1\n')
      assert.equal(readFileSync(join(f.left.repo, 'src/b.ts'), 'utf8'), 'export const b = 1\n')
      assert.equal(statSync(join(f.left.repo, 'src/b.ts')).mode & 0o777, 0o644)
      kill(run.child.pid!)
      // La fila tiene un grupo independiente: no comparte el del CLI interrumpido.
      const retained = cli(f.left, ['sdd', 'status', 'f'])
      assert.ok(existsSync(checkoutLock(f.left)), JSON.stringify(retained.out))
      assert.equal(readFileSync(join(f.left.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 1\n')
      const intent = join(gitDirs(f.left.repo).gitDir, 'sdd-ai', 'verify', 'restore-intent.json')
      assert.ok(existsSync(intent))
      kill(group)
      // Si el grupo no cesa, la prueba falla con ese motivo y no más adelante con un resultado de restauración confuso.
      await groupCeased(group)
      if (conflict) writeFileSync(join(f.left.repo, 'src/a.ts'), 'third content\n')
      const restored = cli(f.left, ['sdd', 'status', 'f'])
      if (conflict) {
        assert.equal(restored.out.code, 'restore_conflict', JSON.stringify(restored.out))
        assert.equal(readFileSync(join(f.left.repo, 'src/a.ts'), 'utf8'), 'third content\n')
        assert.ok(existsSync(intent))
        assert.equal(readFileSync(join(f.left.repo, 'src/b.ts'), 'utf8'), 'export const b = 1\n')
        assert.equal(statSync(join(f.left.repo, 'src/b.ts')).mode & 0o777, 0o644)
      } else {
        assert.equal(restored.code, 0, JSON.stringify(restored.out))
        assert.equal(readFileSync(join(f.left.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 2\n')
        assert.equal(existsSync(intent), false)
        assert.equal(existsSync(checkoutLock(f.left)), false)
        assert.equal(readFileSync(join(f.left.repo, 'src/b.ts'), 'utf8'), 'export const b = 2\n')
        assert.equal(statSync(join(f.left.repo, 'src/b.ts')).mode & 0o777, 0o755)
      }
      assert.deepEqual(readFileSync(join(f.right.repo, 'src/a.ts')), other)
      assert.deepEqual(readFileSync(join(f.right.repo, 'src/b.ts')), otherSecond)
      await run.done
    } finally { await f.close() }
  }
})
