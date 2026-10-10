import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitDirs, indexEnv, repoRoot } from '../src/git.ts'
import { withGitQueryScope, withoutGitQueryMemo } from '../src/git-memo.ts'
import { countGitQueries, gitIn, listenGitMemo, makeGitMemoRepo, withGitEnv, writeGitFile, assertSamePath } from './git-memo-fixture.ts'

test('las estampas reutilizan el estado estable y detectan cada cambio de disposición sin subprocesos', () => {
  const fixture = makeGitMemoRepo()
  const { root } = fixture
  const observed = listenGitMemo()
  const counter = countGitQueries()
  try { withGitEnv({}, () => withGitQueryScope('call', () => {
    const read = () => {
      const top = repoRoot(root); const dirs = gitDirs(root)
      return { top, dirs, objects: indexEnv({ root, gitDir: dirs.gitDir }, join(root, 'scratch')).GIT_ALTERNATE_OBJECT_DIRECTORIES }
    }
    // Tras cada cambio de disposición, la primera lectura consulta Git de nuevo las consultas que ese cambio afecta y
    // reutiliza las demás; la segunda reutiliza todas. Las dos devuelven el valor vigente, que el test conoce por las
    // rutas que él mismo arma: entre un cambio y el siguiente no se lanza ningún otro proceso.
    const ALL = ['repoRoot', 'gitDirs', 'objects']
    const repeat = (gitDir: string, commonDir = gitDir, relaunched = ALL) => {
      const start = counter.launches.length
      const first = read()
      assert.deepEqual(counter.launches.slice(start).map((q) => q.query).sort(), [...relaunched].sort(), 'la primera lectura consulta Git de nuevo lo que el cambio afecta')
      const again = counter.launches.length
      const second = read()
      assert.equal(counter.launches.length - again, 0, 'la segunda lectura reutiliza las tres entradas')
      assert.deepEqual(second, first)
      assertSamePath(first.top, root)
      assertSamePath(first.dirs.gitDir, gitDir)
      assertSamePath(first.dirs.commonDir, commonDir)
      assertSamePath(first.objects!, join(commonDir, 'objects'))
    }
    // La configuración se estampa en las tres consultas (AC-17): un cambio de `config` o `config.worktree` puede cambiar
    // la raíz y los directorios que informa Git, y una configuración mal formada hace fallar también la de objetos.
    const CONFIG = ALL
    repeat(join(root, '.git'))
    assert.equal(observed.events.filter((e) => e.kind === 'hit').length, 3)
    // Se conserva el directorio anterior hasta terminar: el SO no puede reciclar su inodo aquí.
    renameSync(join(root, '.git'), join(root, 'previous-git'))
    cpSync(join(root, 'previous-git'), join(root, '.git'), { recursive: true })
    repeat(join(root, '.git'))
    renameSync(join(root, '.git'), join(root, 'git-a'))
    writeGitFile(root, join(root, 'git-a'))
    repeat(join(root, 'git-a'))
    cpSync(join(root, 'git-a'), join(root, 'git-b'), { recursive: true })
    writeGitFile(root, join(root, 'git-b'))
    repeat(join(root, 'git-b'))
    renameSync(join(root, 'git-b'), join(root, 'git-b-old'))
    cpSync(join(root, 'git-b-old'), join(root, 'git-b'), { recursive: true })
    repeat(join(root, 'git-b'))
    const config = join(root, 'git-b', 'config')
    const original = readFileSync(config, 'utf8')
    writeFileSync(config, original + '\n[memo]\n value = a\n')
    repeat(join(root, 'git-b'), join(root, 'git-b'), CONFIG)
    writeFileSync(join(root, 'git-b', 'config.worktree'), '[memo]\n value = a\n')
    repeat(join(root, 'git-b'), join(root, 'git-b'), CONFIG)
    rmSync(join(root, 'git-b', 'config.worktree'))
    repeat(join(root, 'git-b'), join(root, 'git-b'), CONFIG)
    cpSync(join(root, 'git-b'), join(root, 'common'), { recursive: true })
    writeFileSync(join(root, 'git-b', 'commondir'), '../common\n')
    repeat(join(root, 'git-b'), join(root, 'common'))
    cpSync(join(root, 'common'), join(root, 'common-b'), { recursive: true })
    writeFileSync(join(root, 'git-b', 'commondir'), '../common-b\n')
    repeat(join(root, 'git-b'), join(root, 'common-b'))
    rmSync(join(root, 'git-b', 'commondir'))
    repeat(join(root, 'git-b'))
    renameSync(join(root, 'git-b', 'objects'), join(root, 'git-b', 'old-objects'))
    cpSync(join(root, 'git-b', 'old-objects'), join(root, 'git-b', 'objects'), { recursive: true })
    const beforeObjects = counter.launches.filter((q) => q.query === 'objects').length
    read(); read()
    assert.equal(counter.launches.filter((q) => q.query === 'objects').length - beforeObjects, 1)
    const nested = join(root, 'nested')
    mkdirSync(nested)
    assertSamePath(repoRoot(nested), root)
    assertSamePath(repoRoot(nested), root)
    cpSync(join(root, 'git-b'), join(nested, '.git'), { recursive: true })
    assertSamePath(repoRoot(nested), nested)
    assertSamePath(repoRoot(nested), nested)
    rmSync(join(nested, '.git'), { recursive: true })
    assertSamePath(repoRoot(nested), root)
    assertSamePath(repoRoot(nested), root)
    // Un `.git` que aparece en un directorio intermedio entre el cwd y la raíz, no en el cwd.
    const deep = join(nested, 'x', 'y')
    mkdirSync(deep, { recursive: true })
    assertSamePath(repoRoot(deep), root)
    assertSamePath(repoRoot(deep), root)
    cpSync(join(root, 'git-b'), join(nested, 'x', '.git'), { recursive: true })
    assertSamePath(repoRoot(deep), join(nested, 'x'))
    rmSync(join(nested, 'x'), { recursive: true })
    renameSync(nested, join(root, 'nested-old'))
    assert.throws(() => repoRoot(nested), { code: 'not_a_repo' })
    mkdirSync(nested)
    const movedStart = counter.launches.filter((q) => q.query === 'repoRoot').length
    assertSamePath(repoRoot(nested), root)
    assertSamePath(repoRoot(nested), root)
    assert.equal(counter.launches.filter((q) => q.query === 'repoRoot').length - movedStart, 1)
    rmSync(join(root, '.git'))
    assert.throws(() => repoRoot(root), { code: 'not_a_repo' })
    assert.throws(() => gitDirs(root))
    writeGitFile(root, join(root, 'git-b'))
    assertSamePath(repoRoot(root), root)
    assert.ok(observed.events.some((e) => e.kind === 'discard' && e.reason === 'stale_stamp'))
  })) } finally { counter.restore(); observed.stop(); fixture.cleanup() }
  // Un repositorio movido dentro del ámbito: va en el test que nombra V4, para que el recibo lo acredite.
  movedRepository()
  brokenRecognition()
})

/**
 * Lo que Git exige para reconocer un directorio Git (HEAD, refs y objects) está en la estampa: si falta, la consulta
 * con memo da lo mismo que sin memo, también el error.
 */
function brokenRecognition() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-git-memo-head-')))
  const repo = join(base, 'repo'); const nested = join(repo, 'nested')
  mkdirSync(nested, { recursive: true })
  gitIn(repo, 'init', '-q')
  const outcome = (read: () => unknown) => { try { return { ok: true, value: read() } } catch { return { ok: false } } }
  try { withGitEnv({}, () => withGitQueryScope('call', () => {
    assertSamePath(repoRoot(nested), repo)
    for (const name of ['HEAD', 'refs', 'objects']) {
      const path = join(repo, '.git', name); const aside = `${path}.aside`
      renameSync(path, aside)
      try {
        assert.deepEqual(outcome(() => repoRoot(nested)), outcome(() => withoutGitQueryMemo(() => repoRoot(nested))), `repoRoot sin ${name}`)
      } finally { renameSync(aside, path) }
      assertSamePath(repoRoot(nested), repo)
    }
  })) } finally { rmSync(base, { recursive: true, force: true }) }
}

/** Un repositorio movido dentro del ámbito no devuelve sus rutas anteriores. */
function movedRepository() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-git-memo-moved-')))
  const parent = join(base, 'a'); const repo = join(parent, 'repo')
  mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init', '-q')
  const observed = listenGitMemo()
  try { withGitEnv({}, () => withGitQueryScope('call', () => {
    const original = gitDirs(repo)
    assert.deepEqual(gitDirs(repo), original)
    // Un rename conserva el inodo, así que la clave de gitDirs y su estampa (sin rutas) no cambian: el ancla del
    // valor sí, porque las rutas guardadas ya no existen.
    const renamed = join(parent, 'renamed')
    renameSync(repo, renamed)
    const start = observed.events.length
    assertSamePath(gitDirs(renamed).gitDir, join(renamed, '.git'))
    assert.ok(observed.events.slice(start).some((e) => e.kind === 'discard' && e.reason === 'stale_stamp' && e.query === 'gitDirs'))
    // El padre se mueve y queda un enlace en la ruta anterior: las rutas guardadas siguen existiendo, pero su ruta real
    // es otra.
    renameSync(renamed, repo)
    assertSamePath(gitDirs(repo).gitDir, join(repo, '.git'))
    const moved = join(base, 'b')
    renameSync(parent, moved)
    symlinkSync(moved, parent, process.platform === 'win32' ? 'junction' : 'dir')
    const linked = observed.events.length
    const dirs = gitDirs(repo)
    // La entrada guardada citaba la ruta anterior: se descarta y la consulta nueva devuelve la ruta real vigente, que
    // como cadena es distinta de la guardada.
    assert.ok(observed.events.slice(linked).some((e) => e.kind === 'discard' && e.reason === 'stale_stamp' && e.query === 'gitDirs'), 'el padre movido descarta la entrada')
    assert.ok(observed.events.slice(linked).some((e) => e.kind === 'miss' && e.query === 'gitDirs'), 'y consulta Git de nuevo')
    assertSamePath(dirs.gitDir, join(moved, 'repo', '.git'))
    assert.notEqual(resolve(dirs.gitDir), resolve(parent, 'repo', '.git'))
    assertSamePath(repoRoot(repo), join(moved, 'repo'))
  })) } finally { observed.stop(); rmSync(base, { recursive: true, force: true }) }
}
