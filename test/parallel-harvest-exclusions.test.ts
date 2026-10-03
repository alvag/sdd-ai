import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { cli, git } from './cli-run-fixture.ts'
import { branchFlow, commitArgs, parallelFixture, prepareCommit, release } from './parallel-worktrees-fixture.ts'

test('la cosecha ignora refs ajenas sueltas y empaquetadas estado de otros checkouts mantenimiento y temporales Git sin perder el cambio propio', async () => {
  const f = parallelFixture()
  try {
    // Refs ajenas de todos los espacios: unas existían antes del writer (empaquetadas) y otras aparecen mientras corre.
    const namespaces = ['refs/heads/other', 'refs/tags/other', 'refs/remotes/origin', 'refs/notes/other']
    const before = namespaces.map((ns) => `${ns}/before`)
    const during = [...namespaces.map((ns) => `${ns}/during`), 'refs/stash']
    for (const ref of before) git(f.main.repo, 'update-ref', ref, f.main.base)
    git(f.main.repo, 'pack-refs', '--all', '--prune')
    const w = await f.writer(f.right, 'harvest', [{ write: 'own.txt', content: 'own\n' }])
    const { commonDir } = gitDirs(f.right.repo)
    const moved = git(f.main.repo, 'commit-tree', `${f.main.base}^{tree}`, '-p', f.main.base, '-m', 'foreign')
    // Las de antes se mueven o se borran; las nuevas se crean, se mueven y siguen ahí al cosechar.
    git(f.main.repo, 'update-ref', before[0], moved)
    git(f.main.repo, 'update-ref', before[1], moved)
    git(f.main.repo, 'update-ref', '-d', before[2])
    git(f.main.repo, 'update-ref', '-d', before[3])
    for (const ref of during) {
      git(f.main.repo, 'update-ref', ref, f.main.base)
      git(f.main.repo, 'update-ref', ref, moved)
    }
    // Una parte queda empaquetada y otra suelta al cosechar.
    git(f.main.repo, 'pack-refs', '--all', '--prune')
    git(f.main.repo, 'update-ref', 'refs/heads/other/loose', moved)
    git(f.main.repo, 'switch', '-c', 'another-main')
    for (const name of ['ORIG_HEAD', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'MERGE_MSG', 'config.worktree', 'gc.log', 'gc.pid', 'packed-refs.lock', 'config.lock', 'unknown.lock', 'REBASE_HEAD', 'BISECT_LOG', 'MERGE_HEAD']) writeFileSync(join(commonDir, name), 'other\n')
    writeFileSync(join(commonDir, 'info', 'sparse-checkout'), 'other\n')
    for (const dir of ['rr-cache/new', 'rebase-merge', 'rebase-apply', 'sequencer', 'bisect']) {
      mkdirSync(join(commonDir, dir), { recursive: true })
      writeFileSync(join(commonDir, dir, 'state'), 'other\n')
    }
    release(w.barrier)
    const result = cli(f.right, ['wait', w.id, '--max', '15'])
    assert.deepEqual(result.out.flagged, [], JSON.stringify(result.out))
    assert.deepEqual(result.out.files.map((file: { path: string }) => file.path), ['own.txt'])
    assert.equal(result.out.head_moved, false)
    assert.doesNotMatch(result.out.next, /revertir|toma/)
  } finally { await f.close() }
})

test('branch y commit del principal no aparecen en la cosecha de un writer enlazado', async () => {
  const f = parallelFixture()
  try {
    const writer = await f.writer(f.right, 'linked', [{ write: 'own.txt', content: 'own\n' }])
    branchFlow(f.main, 'main-flow')
    assert.equal(cli(f.main, ['sdd', 'branch', 'main-flow', '--apply']).code, 0)
    const digest = prepareCommit(f.main)
    assert.equal(cli(f.main, commitArgs(digest)).code, 0)
    release(writer.barrier)
    const result = cli(f.right, ['wait', writer.id, '--max', '15'])
    assert.deepEqual(result.out.flagged, [])
    assert.deepEqual(result.out.files.map((file: { path: string }) => file.path), ['own.txt'])
  } finally { await f.close() }
})
