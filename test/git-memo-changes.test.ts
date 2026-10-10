import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { channel } from 'node:diagnostics_channel'
import { main } from '../src/cli.ts'
import type { GitMemoEvent } from '../src/git-memo.ts'
import { gitDirs } from '../src/git.ts'
import { cleanGitEnv, configureFixtureBuild, createFixture, gitIn, interceptExecFileSync, listenGitMemo, SOURCE_ROOT, withGitAndSwitchesEnvAsync } from './git-memo-fixture.ts'

/** El contenido que deja un cambio externo en src/a.ts del fixture (el original devuelve 2). */
const CHANGED_SOURCE = 'export const f = () => 3\n'

test('verify y commit rechazan cambios de contenido y HEAD en sus ventanas de comprobación', async () => {
  const verify = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'verify', checkout: 'principal' })
  const commit = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'commit', checkout: 'principal' })
  const final = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'commit', checkout: 'linked' })
  const events = listenGitMemo()
  try { await withGitAndSwitchesEnvAsync(cleanGitEnv(), async () => {
    configureFixtureBuild(verify.root, `require('node:fs').writeFileSync('src/a.ts', ${JSON.stringify(CHANGED_SOURCE)})`)
    // Cada hit de gitDirs anota si en ese momento el archivo conservaba su contenido original, es decir, si la fila
    // todavía no lo había cambiado.
    const source = join(verify.root, 'src', 'a.ts')
    const original = readFileSync(source, 'utf8')
    const hitsBeforeChange: number[] = []
    const onHit = (message: unknown) => {
      const event = message as GitMemoEvent
      if (event.kind === 'hit' && event.query === 'gitDirs' && readFileSync(source, 'utf8') === original) hitsBeforeChange.push(event.seq)
    }
    channel('sdd-ai:git-memo').subscribe(onHit)
    let checked
    try { checked = await main(['sdd', 'verify', 'f'], cleanGitEnv(), verify.root) } finally { channel('sdd-ai:git-memo').unsubscribe(onHit) }
    assert.equal(checked.code, 0, JSON.stringify(checked.out))
    assert.equal((checked.out as { green: boolean }).green, false)
    assert.ok(hitsBeforeChange.length > 0, 'verify alcanzó el memo antes del cambio')
    assert.equal(readFileSync(source, 'utf8'), CHANGED_SOURCE)

    const before = gitIn(commit.root, 'rev-parse', 'HEAD')
    const userIndex = gitIn(commit.root, 'ls-files', '--stage', '-z')
    const drafted = await main(['sdd', 'commit', 'f', '--subject', 'fixture candidate'], cleanGitEnv(), commit.root)
    assert.equal(drafted.code, 0, JSON.stringify(drafted.out))
    const digest = (drafted.out as { digest: string }).digest
    const committed = join(commit.root, 'src', 'a.ts')
    const approved = readFileSync(committed, 'utf8')
    writeFileSync(committed, CHANGED_SOURCE)
    const apply = ['sdd', 'commit', 'f', '--subject', 'fixture candidate', '--apply', '--digest', digest]
    const changed = await main(apply, cleanGitEnv(), commit.root)
    assert.notEqual(changed.code, 0, JSON.stringify(changed.out))
    // Un cambio antes de aplicar: el recibo deja de cubrir el contenido y la aplicación devuelve el flujo a verify, antes
    // incluso de comparar el digest del ensayo.
    assert.equal((changed.out as { code: string }).code, 'step_not_commit')
    assert.match((changed.out as { message: string }).message, /verify/)
    assert.equal(gitIn(commit.root, 'rev-parse', 'HEAD'), before)
    assert.equal(gitIn(commit.root, 'ls-files', '--stage', '-z'), userIndex)
    // Un cambio dentro de la ventana de la aplicación: el recibo ya se validó y commitOnce está armando el árbol. Lo
    // rechaza la comparación con lo aprobado en el ensayo (digest inválido).
    writeFileSync(committed, approved)
    let rewrites = 0
    const restoreWindow = interceptExecFileSync({ match(argv, opts, stack) {
      return resolve(String(opts.cwd)) === resolve(commit.root) && argv.includes('read-tree') && stack.includes('commitOnce')
    }, before() { if (rewrites++ === 0) writeFileSync(committed, CHANGED_SOURCE) } })
    try {
      const windowed = await main(apply, cleanGitEnv(), commit.root)
      assert.equal(rewrites, 1, 'la intercepción llegó a commitOnce')
      assert.equal((windowed.out as { code: string }).code, 'digest_mismatch', JSON.stringify(windowed.out))
      assert.match((windowed.out as { message: string }).message, /src\/a\.ts/)
      assert.equal(gitIn(commit.root, 'rev-parse', 'HEAD'), before)
      assert.equal(gitIn(commit.root, 'ls-files', '--stage', '-z'), userIndex)
    } finally { restoreWindow() }

    const head = gitIn(final.root, 'rev-parse', 'HEAD')
    const tree = gitIn(final.root, 'rev-parse', 'HEAD^{tree}')
    const alternate = gitIn(final.root, 'commit-tree', tree, '-p', head, '-m', 'external head')
    const branch = gitIn(final.root, 'symbolic-ref', 'HEAD')
    const ref = join(gitDirs(final.root).commonDir, branch)
    const finalIndex = gitIn(final.root, 'ls-files', '--stage', '-z')
    const draft = await main(['sdd', 'commit', 'f', '--subject', 'fixture candidate'], cleanGitEnv(), final.root)
    assert.equal(draft.code, 0, JSON.stringify(draft.out))
    let mutations = 0
    const restore = interceptExecFileSync({ match(argv, opts, stack) {
      return resolve(String(opts.cwd)) === resolve(final.root) && argv.includes('HEAD^{commit}') && stack.includes('commitOnce')
    }, before() {
      if (mutations++ === 0) { mkdirSync(dirname(ref), { recursive: true }); writeFileSync(ref, `${alternate}\n`) }
    } })
    try {
      const applied = await main(['sdd', 'commit', 'f', '--subject', 'fixture candidate', '--apply', '--digest', (draft.out as { digest: string }).digest], cleanGitEnv(), final.root)
      assert.notEqual(applied.code, 0, JSON.stringify(applied.out))
      assert.equal((applied.out as { code: string }).code, 'head_moved')
      assert.ok(mutations > 0, 'la intercepción llegó a la comprobación final de commitOnce')
      assert.equal(gitIn(final.root, 'rev-parse', 'HEAD'), alternate)
      assert.equal(gitIn(final.root, 'ls-files', '--stage', '-z'), finalIndex)
      assert.equal(readFileSync(join(final.root, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')
    } finally { restore() }
  }) } finally { events.stop(); verify.cleanup(); commit.cleanup(); final.cleanup() }
})
