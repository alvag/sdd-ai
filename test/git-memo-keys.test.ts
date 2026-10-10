import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import { gitDirs, indexEnv, repoRoot } from '../src/git.ts'
import { withGitQueryScope } from '../src/git-memo.ts'
import { countGitQueries, gitIn, listenGitMemo, makeGitMemoRepo, withGitEnv, assertSamePath } from './git-memo-fixture.ts'

test('las claves del host unen separadores y alias de gitDirs y nunca unen checkouts distintos', (t) => {
  const a = makeGitMemoRepo(); const b = makeGitMemoRepo()
  const linked = `${a.root}-linked`
  gitIn(a.root, 'worktree', 'add', '-qb', 'linked', linked)
  const alias = join(a.root, 'Alias')
  symlinkSync(a.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const events = listenGitMemo(); const count = countGitQueries()
  try { withGitEnv({}, () => withGitQueryScope('call', () => {
    const dirs = gitDirs(a.root)
    assert.deepEqual(gitDirs(a.root + sep), dirs)
    assert.deepEqual(gitDirs(join(a.root, '.', 'Alias', '..')), dirs)
    assert.deepEqual(gitDirs(alias), dirs)
    assert.equal(count.launches.filter((q) => q.query === 'gitDirs').length, 1)
    assert.ok(events.events.some((e) => e.kind === 'hit' && e.query === 'gitDirs'))
    assert.notDeepEqual(gitDirs(b.root), dirs)
    const linkedDirs = gitDirs(linked)
    assert.notEqual(linkedDirs.gitDir, dirs.gitDir)
    assert.equal(linkedDirs.commonDir, dirs.commonDir)
    assert.deepEqual(gitDirs(linked + sep), linkedDirs)
    assertSamePath(repoRoot(linked), linked)
    assert.ok(indexEnv({ root: linked, gitDir: linkedDirs.gitDir }, join(linked, 'scratch')).GIT_ALTERNATE_OBJECT_DIRECTORIES)
    const variant = a.root.toUpperCase()
    const identity = statSync(a.root, { bigint: true })
    const exists = existsSync(variant) && statSync(variant, { bigint: true }).dev === identity.dev && statSync(variant, { bigint: true }).ino === identity.ino
    t.diagnostic(`alias de mayúsculas del host: ${exists}; separador: ${sep}`)
    if (exists) {
      // gitDirs une las variantes de mayúsculas por identidad física: la variante reutiliza la entrada y no lanza Git.
      const gitDirsBefore = count.launches.filter((q) => q.query === 'gitDirs').length
      assert.deepEqual(gitDirs(variant), dirs)
      assert.equal(count.launches.filter((q) => q.query === 'gitDirs').length - gitDirsBefore, 0, 'la variante de mayúsculas reutiliza la entrada de gitDirs')
      const expectedRoot = gitIn(a.root, 'rev-parse', '--show-toplevel')
      const expectedVariant = gitIn(variant, 'rev-parse', '--show-toplevel')
      const expectedObjects = gitIn(a.root, '--git-dir', join(a.root, '.git'), 'rev-parse', '--path-format=absolute', '--git-path', 'objects')
      const expectedVariantObjects = gitIn(variant, '--git-dir', join(variant, '.git'), 'rev-parse', '--path-format=absolute', '--git-path', 'objects')
      const rootQueries = count.launches.filter((q) => q.query === 'repoRoot').length
      const objectQueries = count.launches.filter((q) => q.query === 'objects').length
      assertSamePath(repoRoot(a.root), expectedRoot)
      assertSamePath(repoRoot(variant), expectedVariant)
      const first = indexEnv({ root: a.root, gitDir: join(a.root, '.git') }, join(a.root, 'scratch'))
      const second = indexEnv({ root: variant, gitDir: join(variant, '.git') }, join(a.root, 'scratch'))
      assert.equal(first.GIT_ALTERNATE_OBJECT_DIRECTORIES, expectedObjects)
      assert.equal(second.GIT_ALTERNATE_OBJECT_DIRECTORIES, expectedVariantObjects)
      assert.equal(count.launches.filter((q) => q.query === 'repoRoot').length - rootQueries, 2)
      assert.equal(count.launches.filter((q) => q.query === 'objects').length - objectQueries, 2)
    }
    const lower = join(b.root, 'case-checkout'); const upper = join(b.root, 'CASE-CHECKOUT')
    mkdirSync(lower)
    const caseSensitive = !existsSync(upper)
    t.diagnostic(`directorios distintos solo por mayúsculas: ${caseSensitive}`)
    if (caseSensitive) {
      mkdirSync(upper)
      gitIn(lower, 'init', '-q'); gitIn(upper, 'init', '-q')
      const lowerDirs = gitDirs(lower); const upperDirs = gitDirs(upper)
      assert.notDeepEqual(lowerDirs, upperDirs)
      assert.deepEqual(gitDirs(lower), lowerDirs)
      assert.deepEqual(gitDirs(upper), upperDirs)
    }
  })) } finally { count.restore(); events.stop(); rmSync(linked, { recursive: true, force: true }); a.cleanup(); b.cleanup() }
})
