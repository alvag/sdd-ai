import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { alive, cli } from './cli-run-fixture.ts'
import { STALE_DIGEST, arrived, branchFlow, checkoutLock, commitArgs, parallelFixture, prepareCommit, refsLock, release, snapshot, verifyBarrierFlow } from './parallel-worktrees-fixture.ts'

test('branch y commit serializan sus aplicaciones completas con refs_busy y liberan tras éxito o fallo sin bloquear writers ni verify ajenos', async () => {
  for (const pair of ['branch-branch', 'branch-commit', 'commit-commit']) {
    const f = parallelFixture('linked-linked')
    try {
      branchFlow(f.left, 'first')
      branchFlow(f.right, 'second')
      const secondDigest = pair.endsWith('commit') ? prepareCommit(f.right) : undefined
      const firstDigest = pair.startsWith('commit') ? prepareCommit(f.left) : undefined
      const barrier = f.barrier(pair)
      const first = f.launch(f.left, firstDigest ? commitArgs(firstDigest) : ['sdd', 'branch', 'first', '--apply'], { SDD_TEST_BARRIER: barrier })
      await arrived(barrier)
      const before = snapshot(f.right)
      const blocked = cli(f.right, secondDigest ? commitArgs(secondDigest) : ['sdd', 'branch', 'second', '--apply'])
      assert.equal(blocked.out.code, 'refs_busy', JSON.stringify(blocked.out))
      assert.deepEqual(snapshot(f.right), before)
      assert.match(blocked.out.next, /reintenta.*termine/)
      assert.ok(alive(first.child.pid!))
      assert.ok(existsSync(checkoutLock(f.left)) && existsSync(refsLock(f.left)))
      if (secondDigest) assert.equal(cli(f.right, commitArgs(STALE_DIGEST)).out.code, 'refs_busy')
      // Mientras la primera sigue, en otro checkout se lanzan y terminan un writer y un verify.
      const writer = await f.writer(f.main, 'unrelated')
      release(writer.barrier)
      assert.equal(cli(f.main, ['wait', writer.id, '--max', '15']).out.state, 'done')
      assert.ok(alive(first.child.pid!))
      const verifyGate = f.barrier('unrelated-verify')
      verifyBarrierFlow(f.main, verifyGate)
      const verify = f.launch(f.main, ['sdd', 'verify', 'f'])
      await arrived(verifyGate)
      assert.ok(alive(first.child.pid!))
      release(verifyGate)
      assert.equal((await verify.done).code, 0)
      release(barrier)
      assert.equal((await first.done).code, 0)
      assert.equal(existsSync(checkoutLock(f.left)), false)
      assert.equal(existsSync(refsLock(f.left)), false)
    } finally { await f.close() }
  }
  for (const operation of ['branch', 'commit']) {
    const failed = parallelFixture()
    try {
      branchFlow(failed.left, 'failure')
      const digest = operation === 'commit' ? prepareCommit(failed.left) : undefined
      const barrier = failed.barrier('failure')
      const run = failed.launch(failed.left, digest ? commitArgs(digest) : ['sdd', 'branch', 'failure', '--apply'],
        { SDD_TEST_BARRIER: barrier, SDD_TEST_HOOK_FAIL: '1' })
      await arrived(barrier)
      release(barrier)
      assert.equal((await run.done).out.code, operation === 'commit' ? 'commit_failed' : 'branch_create_failed')
      assert.equal(existsSync(checkoutLock(failed.left)), false)
      assert.equal(existsSync(refsLock(failed.left)), false)
    } finally { await failed.close() }
  }
})

test('un writer que ya corría en otro checkout sigue progresando mientras se aplica branch', async () => {
  const f = parallelFixture('linked-linked')
  try {
    branchFlow(f.left, 'first')
    const active = await f.writer(f.main, 'already-active')
    const barrier = f.barrier('branch')
    const first = f.launch(f.left, ['sdd', 'branch', 'first', '--apply'], { SDD_TEST_BARRIER: barrier })
    await arrived(barrier)
    assert.ok(alive(active.group.pid))
    release(active.barrier)
    assert.equal(cli(f.main, ['wait', active.id, '--max', '15']).out.state, 'done')
    assert.ok(alive(first.child.pid!))
    release(barrier)
    assert.equal((await first.done).code, 0)
  } finally { await f.close() }
})
