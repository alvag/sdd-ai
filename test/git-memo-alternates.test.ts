import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { gitDirs, indexEnv } from '../src/git.ts'
import { withGitQueryScope } from '../src/git-memo.ts'
import { cleanGitEnv, listenGitMemo, makeGitMemoRepo, withGitEnv } from './git-memo-fixture.ts'

test('alternates se relee cuando aparece cambia y desaparece y sus objetos siguen siendo accesibles', () => {
  const a = makeGitMemoRepo()
  const b = makeGitMemoRepo()
  const c = makeGitMemoRepo()
  const events = listenGitMemo()
  const blob = (root: string, text: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, env: cleanGitEnv(), input: text, encoding: 'utf8' }).trim()
  const bBlob = blob(b.root, 'alternate b\n')
  const cBlob = blob(c.root, 'alternate c\n')
  try { withGitEnv({}, () => withGitQueryScope('call', () => {
    const gitDir = gitDirs(a.root).gitDir
    const file = join(gitDir, 'objects', 'info', 'alternates')
    const scratch = join(a.root, 'scratch')
    // Como buildIndex: el directorio de objetos propio tiene que existir para que Git acepte el entorno.
    mkdirSync(`${scratch}.objects`, { recursive: true })
    const read = () => indexEnv({ root: a.root, gitDir }, scratch)
    const ordinary = read().GIT_ALTERNATE_OBJECT_DIRECTORIES
    assert.equal(read().GIT_ALTERNATE_OBJECT_DIRECTORIES, ordinary)
    const check = (root: string, sha: string, text: string) => {
      const alternate = join(root, '.git', 'objects')
      writeFileSync(file, `${alternate}\n`)
      const env = read()
      assert.equal(env.GIT_ALTERNATE_OBJECT_DIRECTORIES, [ordinary, alternate].join(delimiter))
      assert.equal(execFileSync('git', ['--git-dir', gitDir, 'cat-file', 'blob', sha], { env: cleanGitEnv(env), encoding: 'utf8' }), text)
      assert.equal(readFileSync(file, 'utf8'), `${alternate}\n`)
    }
    check(b.root, bBlob, 'alternate b\n')
    check(c.root, cBlob, 'alternate c\n')
    rmSync(file)
    assert.equal(read().GIT_ALTERNATE_OBJECT_DIRECTORIES, ordinary)
    assert.throws(() => execFileSync('git', ['--git-dir', gitDir, 'cat-file', 'blob', cBlob], { env: cleanGitEnv(), stdio: 'pipe' }))
    assert.ok(events.events.filter((e) => e.kind === 'hit' && e.query === 'objects').length >= 4)
  })) } finally { events.stop(); a.cleanup(); b.cleanup(); c.cleanup() }
})
