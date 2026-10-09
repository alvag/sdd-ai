import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs, repoRoot } from '../src/git.ts'
import { main } from '../src/cli.ts'
import { withGitQueryScope } from '../src/git-memo.ts'
import { cleanGitEnv, configureFixtureBuild, countGitQueries, createFixture, gitIn, listenGitMemo, makeGitMemoRepo, SOURCE_ROOT, spawnControlledWriter, withGitAndSwitchesEnvAsync, writeGitFile, assertSamePath } from './git-memo-fixture.ts'

test('los fallos no persisten y las mutaciones propias y de subprocesos se observan en el mismo ámbito', async () => {
  const fixture = makeGitMemoRepo()
  const verification = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'verify', checkout: 'principal' })
  const root = fixture.root
  const events = listenGitMemo(); const count = countGitQueries()
  try { await withGitAndSwitchesEnvAsync({}, async () => {
    await withGitQueryScope('call', async () => {
      const original = gitDirs(root)
      assert.deepEqual(gitDirs(root), original)
      assert.ok(events.events.some((e) => e.kind === 'hit' && e.query === 'gitDirs'))
      const fresh = join(root, 'fresh')
      mkdirSync(fresh)
      assertSamePath(repoRoot(fresh), root)
      gitIn(fresh, 'init', '-q')
      assertSamePath(repoRoot(fresh), fresh)
      assertSamePath(repoRoot(fresh), fresh)
      renameSync(join(fresh, '.git'), join(root, 'fresh-git'))
      assertSamePath(repoRoot(fresh), root)
      writeGitFile(fresh, join(root, 'fresh-git'))
      assertSamePath(repoRoot(fresh), fresh)
      cpSync(join(root, 'fresh-git'), join(root, 'replacement'), { recursive: true })
      const writer = spawnControlledWriter({ root, onSignal: 'exit', steps: [
        { path: 'fresh/.git', content: `gitdir: ${join(root, 'replacement')}\n`, delay_ms: 30 },
      ] })
      try {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const { readFileSync } = await import('node:fs')
          try { if (JSON.parse(readFileSync(writer.state, 'utf8')).step === 1) break } catch { /* Todavía no publicó. */ }
          await new Promise((r) => setTimeout(r, 10))
        }
        assert.equal(gitDirs(fresh).gitDir, join(root, 'replacement'))
        assert.equal(gitDirs(fresh).gitDir, join(root, 'replacement'))
      } finally { await writer.cleanup() }
      const target = join(root, 'subprocess-git')
      execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { cpSync,writeFileSync } from 'node:fs'; cpSync(${JSON.stringify(join(root, 'replacement'))},${JSON.stringify(target)},{recursive:true}); writeFileSync(${JSON.stringify(join(fresh, '.git'))},${JSON.stringify(`gitdir: ${target}\n`)});`], { env: cleanGitEnv() })
      assert.equal(gitDirs(fresh).gitDir, target)
      rmSync(join(fresh, '.git'))
      assertSamePath(repoRoot(fresh), root)
      rmSync(join(root, '.git'), { recursive: true })
      assert.throws(() => repoRoot(root), { code: 'not_a_repo' })
      assert.throws(() => repoRoot(root), { code: 'not_a_repo' })
      gitIn(root, 'init', '-q')
      assertSamePath(repoRoot(root), root)
      const calls = count.launches.filter((q) => q.query === 'repoRoot' && q.cwd === root)
      assert.ok(calls.length >= 3, 'los errores no se memorizan')
    })
    // Dentro de una vuelta: un hook de Git cambia la disposición entre dos lecturas, y la siguiente la ve. El hook va al
    // directorio Git del fixture y el commit fija `core.hooksPath` a ese directorio, así que un `core.hooksPath` global
    // del host no lo desvía ni agrega otros hooks. La identidad del commit la fija cleanGitEnv (GIT_AUTHOR_* y
    // GIT_COMMITTER_*), que usa gitIn, aunque el repositorio se haya reinicializado.
    const hooked = join(root, 'hooked')
    mkdirSync(hooked)
    const gitDir = gitIn(root, 'rev-parse', '--absolute-git-dir')
    cpSync(gitDir, join(root, 'hooked-git'), { recursive: true })
    const hooks = join(gitDir, 'fixture-hooks')
    mkdirSync(hooks)
    const slash = (path: string) => path.split('\\').join('/')
    writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\nprintf 'gitdir: %s\\n' '${slash(join(root, 'hooked-git'))}' > '${slash(join(hooked, '.git'))}'\n`)
    chmodSync(join(hooks, 'post-commit'), 0o755)
    withGitQueryScope('iteration', () => {
      const start = events.events.length
      assertSamePath(repoRoot(hooked), root); assertSamePath(repoRoot(hooked), root)
      assert.deepEqual(events.events.slice(start).filter((e) => e.query === 'repoRoot').map((e) => e.kind), ['miss', 'store', 'hit'], 'la vuelta reutiliza la raíz estable')
      const afterHook = events.events.length
      gitIn(root, '-c', `core.hooksPath=${hooks}`, 'commit', '--allow-empty', '-qm', 'hook')
      assertSamePath(repoRoot(hooked), hooked)
      assertSamePath(repoRoot(hooked), hooked)
      const kinds = events.events.slice(afterHook).filter((e) => e.query === 'repoRoot').map((e) => e.kind)
      assert.deepEqual(kinds.slice(0, 2), ['discard', 'miss'], 'el cambio del hook descarta la entrada y consulta Git de nuevo')
      assert.equal(kinds.at(-1), 'hit')
    })
    configureFixtureBuild(verification.root, `
const fs = require('node:fs');
fs.cpSync('.git/objects', '.git/objects-next', { recursive: true });
fs.renameSync('.git/objects', '.git/objects-previous');
fs.renameSync('.git/objects-next', '.git/objects');
fs.rmSync('.git/objects-previous', { recursive: true });
`)
    const start = events.events.length
    const checked = await main(['sdd', 'verify', 'f'], cleanGitEnv(), verification.root)
    assert.equal(checked.code, 0, JSON.stringify(checked.out))
    assert.equal((checked.out as { green: boolean }).green, true, 'el reemplazo conserva los objetos y el candidato')
    const during = events.events.slice(start)
    const hit = during.findIndex((e) => e.kind === 'hit' && e.query === 'objects')
    const discard = during.findIndex((e) => e.kind === 'discard' && e.query === 'objects' && e.reason === 'stale_stamp')
    assert.ok(hit >= 0 && discard > hit, 'la fila cambia una identidad después de alcanzar el memo')
    assert.ok(during.slice(discard + 1).some((e) => e.kind === 'miss' && e.query === 'objects'))
  }) } finally { count.restore(); events.stop(); verification.cleanup(); fixture.cleanup() }
})
