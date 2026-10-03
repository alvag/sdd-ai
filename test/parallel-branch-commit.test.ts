import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alive, cli, git } from './cli-run-fixture.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { arrived, branchFlow, checkoutLock, commitArgs, parallelFixture, prepareCommit, release, verifyBarrierFlow } from './parallel-worktrees-fixture.ts'

test('branch y commit se consultan y aplican mientras otro checkout mantiene un writer o verify activo', async () => {
  for (const holder of ['writer', 'verify']) {
    const f = parallelFixture()
    try {
      branchFlow(f.right, 'other-branch')
      let writer: Awaited<ReturnType<typeof f.writer>> | undefined
      let verify: ReturnType<typeof f.launch> | undefined
      const gate = f.barrier(holder)
      if (holder === 'writer') writer = await f.writer(f.left, 'writer')
      else {
        verifyBarrierFlow(f.left, gate)
        verify = f.launch(f.left, ['sdd', 'verify', 'f'])
        await arrived(gate)
      }
      const tree = readFileSync(join(f.left.repo, 'src/a.ts'))
      // Con la implementación de la base (la confirmación por reversión), la reserva del otro checkout es el
      // writer.lock global. Se compara la que exista para que, sobre la base, falle el rechazo de branch y no esta lectura.
      const lock = existsSync(checkoutLock(f.left)) ? checkoutLock(f.left) : join(gitDirs(f.left.repo).commonDir, 'sdd-ai', 'writer.lock')
      const reservation = readFileSync(lock)
      const preview = cli(f.right, ['sdd', 'branch', 'other-branch'])
      const result = cli(f.right, ['sdd', 'branch', 'other-branch', '--apply'])
      assert.equal(result.code, 0, JSON.stringify(result.out))
      assert.equal(preview.code, 0)
      // La consulta tampoco presenta la reserva del otro checkout como bloqueo, ni general ni de la salida `new`.
      const blocking = [...preview.out.blockers, ...preview.out.exits.flatMap((e: { blockers: { code: string }[] }) => e.blockers)]
        .map((b: { code: string }) => b.code)
      assert.ok(!blocking.includes('writer_open') && !blocking.includes('refs_busy'), JSON.stringify(blocking))
      // Los efectos en el checkout que aplica: la rama creada, con HEAD en ella y el handoff al día.
      assert.equal(git(f.right.repo, 'symbolic-ref', '--short', 'HEAD'), result.out.branch)
      assert.match(readFileSync(join(f.right.repo, '.plans', 'other-branch', 'handoff.md'), 'utf8'), new RegExp(`^branch: ${result.out.branch}$`, 'm'))
      const digest = prepareCommit(f.right)
      const parent = git(f.right.repo, 'rev-parse', 'HEAD')
      const committed = cli(f.right, commitArgs(digest))
      assert.equal(committed.code, 0, JSON.stringify(committed.out))
      // El commit queda hecho sobre el HEAD anterior y su registro lo da por terminado.
      assert.equal(git(f.right.repo, 'rev-parse', 'HEAD^'), parent)
      assert.equal(git(f.right.repo, 'rev-parse', 'HEAD'), committed.out.sha)
      assert.match(readFileSync(join(f.right.repo, '.plans', 'f', 'plan.md'), 'utf8'), /^status: committed$/m)
      assert.equal(git(f.left.repo, 'rev-parse', 'HEAD'), f.left.base)
      assert.ok(alive(writer?.group.pid ?? verify!.child.pid!))
      assert.deepEqual(readFileSync(join(f.left.repo, 'src/a.ts')), tree)
      assert.deepEqual(readFileSync(lock), reservation)
      if (writer) release(writer.barrier)
      else { release(gate); assert.equal((await verify!.done).code, 0) }
    } finally { await f.close() }
  }
})
