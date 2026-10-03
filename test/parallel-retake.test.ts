import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, git } from './cli-run-fixture.ts'
import { arrived, branchFlow, checkoutLock, commitArgs, groupCeased, kill, parallelFixture, prepareCommit, refsLock, release } from './parallel-worktrees-fixture.ts'

/**
 * Dónde se detiene cada interrupción. Sin entrada (`branch`, `commit`), en post-checkout o pre-commit, el hook por
 * defecto; `commit-produced` en post-commit, con el commit ya hecho; `branch-before` en reference-transaction, antes
 * de crear la ref, con un hook que falla para que Git aborte la transacción.
 */
const HOOKS: Record<string, Record<string, string>> = {
  'commit-produced': { SDD_TEST_HOOK: 'post-commit' },
  'commit-produced-foreign': { SDD_TEST_HOOK: 'post-commit' },
  'branch-before': { SDD_TEST_HOOK: 'reference-prepared', SDD_TEST_HOOK_FAIL: '1' },
  'branch-before-foreign': { SDD_TEST_HOOK: 'reference-prepared', SDD_TEST_HOOK_FAIL: '1' },
}

test('liberar manualmente tras una interrupción conserva la intención y permite retomar branch o commit sin duplicar ni sobrescribir cambios incompatibles', async () => {
  for (const operation of ['branch-before', 'branch', 'commit', 'commit-produced', 'branch-before-foreign', 'commit-produced-foreign']) {
    const f = parallelFixture()
    try {
      const isBranch = operation.startsWith('branch')
      const foreign = operation.endsWith('-foreign')
      const id = isBranch ? 'branch-flow' : 'f'
      const recordFile = join(f.left.repo, '.plans', id, isBranch ? 'handoff.md' : 'sdd-ai-phases.json')
      const digest = isBranch ? undefined : prepareCommit(f.left)
      if (isBranch) branchFlow(f.left, id)
      const gate = f.barrier(operation)
      const args = digest ? commitArgs(digest) : ['sdd', 'branch', id, '--apply']
      const run = f.launch(f.left, args, { SDD_TEST_BARRIER: gate, ...HOOKS[operation] })
      await arrived(gate)
      if (operation.startsWith('branch-before')) {
        // Solo muere el CLI: el hijo Git, ya liberado, aborta su transacción por el hook que falla.
        process.kill(run.child.pid!, 'SIGKILL')
        release(gate)
      } else kill(run.child.pid!)
      await run.done
      // Liberar a mano exige el cese de toda la operación, también de Git y sus hooks: el grupo del CLI.
      await groupCeased(run.child.pid!)
      const head = git(f.left.repo, 'rev-parse', 'HEAD')
      const count = git(f.left.repo, 'rev-list', '--count', 'HEAD')
      const recorded = readFileSync(recordFile)
      const branch = isBranch ? /^branch: (.+)$/m.exec(recorded.toString())![1] : undefined
      if (operation.startsWith('branch-before')) assert.equal(git(f.left.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`), '')
      for (const file of [checkoutLock(f.left), refsLock(f.left), join(f.left.repo, '.plans', id, 'sdd-ai-approvals.lock')]) if (existsSync(file)) unlinkSync(file)
      // Liberar las reservas no deshace Git ni toca los registros.
      assert.equal(git(f.left.repo, 'rev-parse', 'HEAD'), head)
      assert.deepEqual(readFileSync(recordFile), recorded)
      if (foreign) {
        // Un cambio ajeno entre la interrupción y la retoma: la retoma lo informa y no lo pisa.
        if (isBranch) {
          writeFileSync(join(f.left.repo, 'src/a.ts'), 'export const f = () => 9\n')
          const refused = cli(f.left, args)
          assert.equal(refused.out.code, 'tree_dirty', JSON.stringify(refused.out))
          assert.equal(readFileSync(join(f.left.repo, 'src/a.ts'), 'utf8'), 'export const f = () => 9\n')
        } else {
          git(f.left.repo, 'commit', '--allow-empty', '-qm', 'foreign')
          const ahead = git(f.left.repo, 'rev-parse', 'HEAD')
          const refused = cli(f.left, args)
          // La intención registrada es de otro padre: el commit ajeno no se toma por el del intento.
          assert.equal(refused.out.code, 'intent_stale', JSON.stringify(refused.out))
          assert.equal(git(f.left.repo, 'rev-parse', 'HEAD'), ahead)
        }
        assert.deepEqual(readFileSync(recordFile), recorded, 'el registro no se reescribe ante un cambio ajeno')
        continue
      }
      const repeated = cli(f.left, args)
      assert.equal(repeated.code, 0, JSON.stringify(repeated.out))
      const finished = git(f.left.repo, 'rev-list', '--count', 'HEAD')
      assert.equal(Number(finished), Number(count) + (operation === 'commit' ? 1 : 0))
      // Un commit ya producido se reconoce y se conserva: HEAD es el mismo hash, no un reemplazo con el mismo padre.
      if (operation === 'commit-produced') assert.equal(git(f.left.repo, 'rev-parse', 'HEAD'), head)
      if (!isBranch) {
        // La retoma completa el registro y el header del flujo.
        assert.match(readFileSync(join(f.left.repo, '.plans', id, 'plan.md'), 'utf8'), /^status: committed$/m)
        const record = JSON.parse(readFileSync(recordFile, 'utf8'))
        assert.equal(record.commit?.state, 'done', 'el registro de fases da el commit por terminado')
        assert.equal(record.commit?.sha, git(f.left.repo, 'rev-parse', 'HEAD'))
      }
      if (isBranch) {
        // La rama registrada existe, HEAD está en ella y el handoff quedó completo.
        assert.notEqual(git(f.left.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`), '')
        assert.equal(git(f.left.repo, 'symbolic-ref', '--short', 'HEAD'), branch)
        assert.match(readFileSync(recordFile, 'utf8'), /^phase: plan$/m)
      }
      // Repetir otra vez no duplica nada.
      const again = cli(f.left, args)
      assert.equal(again.code, 0, JSON.stringify(again.out))
      assert.equal(git(f.left.repo, 'rev-list', '--count', 'HEAD'), finished)
      if (operation === 'commit-produced') assert.equal(git(f.left.repo, 'rev-parse', 'HEAD'), head)
      if (isBranch) assert.equal(git(f.left.repo, 'symbolic-ref', '--short', 'HEAD'), branch)
    } finally { await f.close() }
  }
})
