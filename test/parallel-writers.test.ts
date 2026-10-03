import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { alive, cli, git, readJsonFile, storeOf } from './cli-run-fixture.ts'
import { parallelFixture, release } from './parallel-worktrees-fixture.ts'

test('dos writers permanecen activos y cosechan árboles independientes entre principal y enlazado y entre dos enlazados', async () => {
  // Las dos topologías van en el mismo test, sin subtests: la confirmación de `sdd verify` exige que el rojo sobre la
  // base sea del test nombrado, y el de una subprueba no cuenta. Un fallo dice en qué topología ocurrió.
  for (const topology of ['main-linked', 'linked-linked'] as const) {
    const f = parallelFixture(topology)
    try {
      const a = await f.writer(f.left, 'left', [{ write: 'left.txt', content: 'left\n' }])
      // La admisión del segundo es la primera aserción que discrimina el protocolo global.
      const b = await f.writer(f.right, 'right', [{ write: 'right.txt', content: 'right\n' }])
      assert.ok(alive(a.group.pid) && alive(b.group.pid))
      const indexes = [f.left, f.right].map((s) => readFileSync(join(gitDirs(s.repo).gitDir, 'index')))
      release(a.barrier); release(b.barrier)
      for (const [s, w, name] of [[f.left, a, 'left.txt'], [f.right, b, 'right.txt']] as const) {
        const result = cli(s, ['wait', w.id, '--max', '15'])
        assert.equal(result.code, 0, JSON.stringify(result.out))
        assert.deepEqual(result.out.files.map((file: { path: string }) => file.path), [name])
        assert.deepEqual(result.out.flagged, [])
        assert.equal(git(s.repo, 'rev-parse', 'HEAD'), s.base)
        const patch = readFileSync(join(storeOf(s.repo, w.id), 'diff.patch'), 'utf8')
        assert.match(patch, new RegExp(name))
        assert.doesNotMatch(patch, new RegExp(name === 'left.txt' ? 'right.txt' : 'left.txt'))
        assert.equal(existsSync(join(s.repo, name === 'left.txt' ? 'right.txt' : 'left.txt')), false)
        const control = readJsonFile(join(storeOf(s.repo, w.id), 'control.json'))
        assert.equal(control.checkout.root, s.repo)
        assert.equal(control.checkout.gitDir, gitDirs(s.repo).gitDir)
      }
      for (const [i, s] of [f.left, f.right].entries()) assert.deepEqual(readFileSync(join(gitDirs(s.repo).gitDir, 'index')), indexes[i])
    } catch (e) {
      throw new Error(`${topology}: ${(e as Error).message}`, { cause: e })
    } finally { await f.close() }
  }
})
