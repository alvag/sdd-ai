import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { alive, cli, git } from './cli-run-fixture.ts'
import { arrived, parallelFixture, release, verifyBarrierFlow } from './parallel-worktrees-fixture.ts'

test('writer y verify se solapan en ambos órdenes y dos verify confirman y restauran únicamente sus checkouts con el recibo en el directorio Git de cada uno', async () => {
  for (const order of ['writer-first', 'verify-first', 'verify-verify']) {
    const f = parallelFixture()
    try {
      const gate = f.barrier('verify')
      verifyBarrierFlow(f.right, gate, order === 'verify-verify')
      let writer: Awaited<ReturnType<typeof f.writer>> | undefined
      let other: ReturnType<typeof f.launch> | undefined
      let otherGate: string | undefined
      // El estado de referencia se toma antes de lanzar nada: comparar contra un estado intermedio (por ejemplo, con
      // las rutas revertidas por una confirmación en curso) ocultaría una alteración que no se restauró.
      const indexes = [f.left, f.right].map((s) => readFileSync(join(gitDirs(s.repo).gitDir, 'index')))
      const heads = [f.left, f.right].map((s) => git(s.repo, 'rev-parse', 'HEAD'))
      const leftBefore = ['src/a.ts', 'src/b.ts'].map((path) => readFileSync(join(f.left.repo, path)))
      if (order === 'writer-first') writer = await f.writer(f.left, 'writer')
      if (order === 'verify-verify') {
        otherGate = f.barrier('second-verify')
        verifyBarrierFlow(f.left, otherGate, true)
        other = f.launch(f.left, ['sdd', 'verify', 'f'])
        await arrived(otherGate)
      }
      const verifier = f.launch(f.right, ['sdd', 'verify', 'f'])
      // Con la base, el segundo verbo responde writer_open antes de llegar a la barrera.
      const outcome = await Promise.race([arrived(gate).then(() => 'arrived'), verifier.done])
      assert.equal(outcome, 'arrived', JSON.stringify(outcome))
      if (order === 'verify-first') writer = await f.writer(f.left, 'writer')
      if (writer) assert.ok(alive(writer.group.pid))
      if (other) assert.ok(alive(other.child.pid!))
      assert.ok(alive(verifier.child.pid!))
      const rightCode = readFileSync(join(f.right.repo, 'src/a.ts'), 'utf8')
      if (order === 'verify-verify') {
        assert.equal(rightCode, 'export const f = () => 1\n')
        for (const s of [f.left, f.right]) {
          assert.equal(readFileSync(join(s.repo, 'src/b.ts'), 'utf8'), 'export const b = 1\n')
          assert.equal(statSync(join(s.repo, 'src/b.ts')).mode & 0o777, 0o644)
        }
      }
      for (const [i, path] of ['src/a.ts', 'src/b.ts'].entries()) assert.deepEqual(readFileSync(join(f.left.repo, path)), leftBefore[i])
      // Se libera una sola verificación por vez: la restauración del checkout derecho no puede tocar al izquierdo,
      // que sigue detenido con sus rutas revertidas.
      release(gate)
      const result = await verifier.done
      assert.equal(result.code, 0, JSON.stringify(result.out))
      const localStore = join(gitDirs(f.right.repo).gitDir, 'sdd-ai', 'verify')
      const rightReceipt = join(localStore, result.out.receipt, 'receipt.json')
      assert.ok(existsSync(rightReceipt), rightReceipt)
      const rightBytes = readFileSync(rightReceipt)
      if (order === 'verify-verify') {
        assert.equal(readFileSync(join(f.right.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 2\n')
        assert.equal(readFileSync(join(f.left.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 1\n', 'el verify izquierdo sigue detenido y revertido')
      }
      if (otherGate) release(otherGate)
      if (writer) release(writer.barrier)
      if (other) {
        const second = await other.done
        assert.equal(second.code, 0, JSON.stringify(second.out))
        const leftReceipt = join(gitDirs(f.left.repo).gitDir, 'sdd-ai', 'verify', second.out.receipt, 'receipt.json')
        assert.ok(existsSync(leftReceipt), leftReceipt)
        assert.notEqual(leftReceipt, rightReceipt)
        assert.deepEqual(readFileSync(rightReceipt), rightBytes)
      }
      if (writer) assert.equal(cli(f.left, ['wait', writer.id, '--max', '15']).out.state, 'done')
      if (order === 'verify-verify') {
        assert.equal(readFileSync(join(f.right.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 2\n')
        assert.equal(readFileSync(join(f.left.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 2\n')
        for (const s of [f.left, f.right]) {
          assert.equal(readFileSync(join(s.repo, 'src/b.ts'), 'utf8'), 'export const b = 2\n')
          assert.equal(statSync(join(s.repo, 'src/b.ts')).mode & 0o777, 0o755)
        }
      } else {
        assert.equal(readFileSync(join(f.right.repo, 'src/a.ts'), 'utf8'), rightCode)
        for (const [i, path] of ['src/a.ts', 'src/b.ts'].entries()) assert.deepEqual(readFileSync(join(f.left.repo, path)), leftBefore[i])
      }
      for (const [i, s] of [f.left, f.right].entries()) {
        assert.equal(git(s.repo, 'rev-parse', 'HEAD'), heads[i])
        assert.deepEqual(readFileSync(join(gitDirs(s.repo).gitDir, 'index')), indexes[i])
      }
    } finally { await f.close() }
  }
})
