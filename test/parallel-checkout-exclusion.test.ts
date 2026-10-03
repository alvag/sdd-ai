import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, cli, git, implement, readJsonFile } from './cli-run-fixture.ts'
import { chainFlow } from './helpers.ts'
import { arrived, branchFlow, checkoutLock, commitArgs, duplicateFlow, parallelFixture, prepareCommit, refsLock, release, snapshot, verifyBarrierFlow } from './parallel-worktrees-fixture.ts'

test('cambiar a una rama existente y aplicar branch o commit se excluyen con writer verify y otras aplicaciones del mismo checkout en ambos órdenes', async () => {
  const f = parallelFixture()
  try {
    branchFlow(f.left, 'switch-flow')
    const path = join(f.left.repo, '.plans', 'switch-flow', 'handoff.md')
    git(f.left.repo, 'branch', 'recorded', f.left.base)
    writeFileSync(path, readFileSync(path, 'utf8').replace('---\n', `---\nbranch: recorded\nbase_commit: ${f.left.base}\n`))
    const writer = await f.writer(f.left, 'local')
    const before = snapshot(f.left)
    const switched = cli(f.left, ['sdd', 'branch', 'switch-flow', '--apply'])
    assert.equal(switched.out.code, 'writer_open', 'switch debe reservar HEAD antes de modificarlo')
    assert.deepEqual(snapshot(f.left), before)
    assert.ok(alive(writer.group.pid))
    release(writer.barrier)
    assert.equal(cli(f.left, ['wait', writer.id, '--max', '15']).out.state, 'done')
    branchFlow(f.left, 'first')
    branchFlow(f.left, 'second')
    const barrier = f.barrier('branch')
    const branch = f.launch(f.left, ['sdd', 'branch', 'first', '--apply'], { SDD_TEST_BARRIER: barrier })
    await arrived(barrier)
    assert.equal(implement(f.left).out.code, 'refs_busy')
    assert.equal(cli(f.left, ['sdd', 'branch', 'second', '--apply']).out.code, 'refs_busy')
    assert.ok(alive(branch.child.pid!))
    release(barrier)
    assert.equal((await branch.done).code, 0)
    const verifyGate = f.barrier('verify')
    verifyBarrierFlow(f.left, verifyGate)
    const verify = f.launch(f.left, ['sdd', 'verify', 'f'])
    await arrived(verifyGate)
    assert.equal(implement(f.left).out.code, 'writer_open')
    branchFlow(f.left, 'verify-blocked')
    assert.equal(cli(f.left, ['sdd', 'branch', 'verify-blocked', '--apply']).out.code, 'writer_open')
    release(verifyGate)
    assert.equal((await verify.done).code, 0)
    const digest = prepareCommit(f.left)
    const hook = f.barrier('commit')
    const commit = f.launch(f.left, commitArgs(digest), { SDD_TEST_BARRIER: hook })
    await arrived(hook)
    assert.equal(implement(f.left).out.code, 'refs_busy')
    assert.equal(cli(f.left, ['sdd', 'branch', 'second', '--apply']).out.code, 'refs_busy')
    release(hook)
    assert.equal((await commit.done).code, 0)
    assert.equal(existsSync(checkoutLock(f.left)), false)
    assert.equal(existsSync(refsLock(f.left)), false)
  } finally { await f.close() }
  for (const holder of ['writer', 'verify', 'branch', 'commit'] as const) {
    const matrix = parallelFixture()
    try {
      const s = matrix.left
      const digest = prepareCommit(s)
      const verifyGate = matrix.barrier('verify-owner')
      duplicateFlow(s, 'verify-owner', verifyGate)
      duplicateFlow(s, 'verify-contender', matrix.barrier('never-run'))
      branchFlow(s, 'branch-owner')
      branchFlow(s, 'branch-contender')
      const candidate = join(s.repo, 'src/a.ts')
      if (holder !== 'commit') writeFileSync(candidate, 'export const f = () => 1\n')
      let writer: Awaited<ReturnType<typeof matrix.writer>> | undefined
      let processRun: ReturnType<typeof matrix.launch> | undefined
      const gate = holder === 'verify' ? verifyGate : matrix.barrier(holder)
      if (holder === 'writer') writer = await matrix.writer(s, 'writer-owner')
      else {
        processRun = matrix.launch(s, holder === 'verify' ? ['sdd', 'verify', 'verify-owner']
          : holder === 'branch' ? ['sdd', 'branch', 'branch-owner', '--apply'] : commitArgs(digest),
        holder === 'verify' ? {} : { SDD_TEST_BARRIER: gate })
        await arrived(gate)
      }
      const code = holder === 'writer' || holder === 'verify' ? 'writer_open' : 'refs_busy'
      const identity = readJsonFile(checkoutLock(s))
      const lockBytes = readFileSync(checkoutLock(s))
      const holderAlive = () => {
        assert.ok(alive(writer?.group.pid ?? processRun!.child.pid!))
      }
      for (const args of [
        ['sdd', 'branch', 'branch-contender', '--apply'],
        ['sdd', 'verify', 'verify-contender'],
      ]) {
        const before = snapshot(s)
        const rejected = cli(s, args)
        assert.equal(rejected.out.code, code, JSON.stringify(rejected.out))
        assert.ok(rejected.out.message.includes(identity.id), JSON.stringify(rejected.out))
        assert.deepEqual(readFileSync(checkoutLock(s)), lockBytes)
        assert.deepEqual(snapshot(s), before)
        holderAlive()
      }
      assert.equal(implement(s).out.code, code)
      // Otro flujo de commit evita que el lock del flujo dueño produzca el rechazo.
      const target = holder === 'commit' ? 'verify-contender' : 'f'
      const before = snapshot(s)
      const rejected = cli(s, ['sdd', 'commit', target, '--subject', 'feat: candidate', '--apply', '--digest', digest])
      assert.equal(rejected.out.code, code, JSON.stringify(rejected.out))
      assert.ok(rejected.out.message.includes(identity.id), JSON.stringify(rejected.out))
      assert.deepEqual(readFileSync(checkoutLock(s)), lockBytes)
      assert.deepEqual(snapshot(s), before)
      holderAlive()
      if (writer) {
        release(writer.barrier)
        assert.equal(cli(s, ['wait', writer.id, '--max', '15']).out.state, 'done')
      } else {
        release(gate)
        assert.equal((await processRun!.done).code, 0)
      }
    } finally { await matrix.close() }
  }
})

test('current y completar el handoff se aplican con un writer de otro flujo activo en el mismo checkout', async () => {
  const f = parallelFixture()
  try {
    branchFlow(f.left, 'current-flow')
    git(f.left.repo, 'switch', '-c', 'current-branch')
    const writer = await f.writer(f.left, 'clean')
    const bytes = readFileSync(checkoutLock(f.left))
    const result = cli(f.left, ['sdd', 'branch', 'current-flow', '--apply', '--current'])
    assert.equal(result.code, 0, JSON.stringify(result.out))
    const path = join(f.left.repo, '.plans', 'current-flow', 'handoff.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace('phase: plan', 'phase: specify'))
    assert.equal(cli(f.left, ['sdd', 'branch', 'current-flow', '--apply']).code, 0)
    assert.deepEqual(readFileSync(checkoutLock(f.left)), bytes)
    assert.equal(existsSync(refsLock(f.left)), false)
    assert.ok(alive(writer.group.pid))
    release(writer.barrier)
    assert.equal(cli(f.left, ['wait', writer.id, '--max', '15']).out.state, 'done')
    const dirty = await f.writer(f.left, 'dirty', [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], { after: true })
    const dirtyBytes = readFileSync(checkoutLock(f.left))
    assert.equal(cli(f.left, ['sdd', 'branch', 'current-flow', '--apply', '--current']).out.code, 'tree_dirty')
    assert.deepEqual(readFileSync(checkoutLock(f.left)), dirtyBytes)
    assert.equal(existsSync(refsLock(f.left)), false)
    release(dirty.barrier)
    assert.equal(cli(f.left, ['wait', dirty.id, '--max', '15']).out.state, 'done')
    writeFileSync(join(f.left.repo, 'src/a.ts'), 'export const f = () => 1\n')
    chainFlow({ ...f.left, calls: '', prompts: '' })
    const own = await f.writer(f.left, 'own-phase', [], { phase: true })
    // Con el writer de fase del propio flujo en curso, `--current` y completar el handoff siguen bloqueados por él
    // (phase_running), no por la reserva del checkout, de la que están exentos.
    for (const args of [['--current'], []]) {
      const refused = cli(f.left, ['sdd', 'branch', 'f', '--apply', ...args])
      assert.notEqual(refused.code, 0, JSON.stringify(refused.out))
      assert.ok(String(refused.out.detail).includes('phase_running'), JSON.stringify(refused.out))
    }
    release(own.barrier)
  } finally { await f.close() }
})
