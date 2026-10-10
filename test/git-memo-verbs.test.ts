import assert from 'node:assert/strict'
import { test } from 'node:test'
import { realpathSync } from 'node:fs'
import { main } from '../src/cli.ts'
import { gitDirs, repoRoot, withGitMemo } from '../src/git.ts'
import { withGitQueryScope, type GitMemoEvent } from '../src/git-memo.ts'
import { channel } from 'node:diagnostics_channel'
import { cleanGitEnv, countGitQueries, createFixture, gitIn, listenGitMemo, SOURCE_ROOT, withGitAndSwitchesEnvAsync } from './git-memo-fixture.ts'

test('verify y commit reutilizan cada consulta estable por ámbito y consultan nuevamente al terminar', async () => {
  const verify = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'verify', checkout: 'principal' })
  const commit = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'commit', checkout: 'linked' })
  const observed = listenGitMemo()
  const counter = countGitQueries()
  // La raíz física de cada miss, resuelta en el momento del evento (la clave de gitDirs ya es la identidad física;
  // repoRoot y objects llevan la ruta de entrada). Un directorio que después se borra no rompe el conteo.
  const physical = new Map<number, string>()
  const resolveMiss = (message: unknown) => {
    const event = message as GitMemoEvent
    if (event.kind !== 'miss') return
    const input = JSON.parse(event.key)[1]
    if (Array.isArray(input)) { physical.set(event.seq, JSON.stringify(input)); return }
    try { physical.set(event.seq, realpathSync(input)) } catch { physical.set(event.seq, `${input} (no existe)`) }
  }
  channel('sdd-ai:git-memo').subscribe(resolveMiss)
  try { await withGitAndSwitchesEnvAsync(cleanGitEnv(), async () => {
    const verified = await main(['sdd', 'verify', 'f'], cleanGitEnv(), verify.root)
    assert.equal(verified.code, 0, JSON.stringify(verified.out))
    assert.equal((verified.out as { green: boolean }).green, true)
    assert.ok(observed.events.some((e) => e.kind === 'hit' && e.query === 'repoRoot'))
    assert.ok(observed.events.some((e) => e.kind === 'hit' && e.query === 'gitDirs'))
    assert.ok(observed.events.some((e) => e.kind === 'hit' && e.query === 'objects'))
    const head = gitIn(commit.root, 'rev-parse', 'HEAD')
    const draft = await main(['sdd', 'commit', 'f', '--subject', 'fixture candidate'], cleanGitEnv(), commit.root)
    assert.equal(draft.code, 0, JSON.stringify(draft.out))
    const digest = (draft.out as { digest: string }).digest
    assert.ok(digest)
    const applied = await main(['sdd', 'commit', 'f', '--subject', 'fixture candidate', '--apply', '--digest', digest], cleanGitEnv(), commit.root)
    assert.equal(applied.code, 0, JSON.stringify(applied.out))
    assert.notEqual(gitIn(commit.root, 'rev-parse', 'HEAD'), head)
    assert.equal(gitIn(commit.root, 'rev-parse', 'HEAD^'), head)
    const misses = observed.events.filter((e) => e.kind === 'miss')
    const seen = new Set<string>()
    for (const e of misses) { const key = JSON.stringify([e.call, e.scope, e.query, e.key]); assert.ok(!seen.has(key), key); seen.add(key) }
    assert.equal(observed.events.filter((e) => e.kind === 'discard').length, 0)
    // A lo sumo una consulta memorizable (miss) por consulta, raíz física y ámbito: dos grafías de la misma raíz entre
    // la recuperación y el verbo contarían dos. Las que explica un bypass de la lista cerrada no cuentan (AC-4).
    const launched = new Map<string, number>()
    for (const e of misses) {
      const key = JSON.stringify([e.call, e.scope, e.query, physical.get(e.seq)])
      launched.set(key, (launched.get(key) ?? 0) + 1)
    }
    for (const [key, n] of launched) assert.equal(n, 1, `consulta repetida con el repositorio estable: ${key}`)
    const reasons = new Set(observed.events.filter((e) => e.kind === 'bypass').map((e) => e.reason))
    assert.ok([...reasons].every((reason) => ['no_scope', 'legacy', 'redirect_env', 'stamp_unreadable', 'config_include'].includes(reason)), [...reasons].join(', '))
    // Las tres llamadas (verify, ensayo y aplicación) reutilizan al menos una consulta.
    const calls = [...new Set(misses.map((e) => e.call))]
    assert.equal(calls.length, 3)
    for (const [i, name] of ['verify', 'ensayo de commit', 'aplicación de commit'].entries()) {
      assert.ok(observed.events.some((e) => e.kind === 'hit' && e.call === calls[i]), `${name} alcanzó el memo`)
    }
    assert.ok(counter.launches.filter((q) => q.query === 'repoRoot' && q.scope === null).length >= 3, 'finally consulta de nuevo')
    const start = observed.events.length
    await withGitQueryScope('call', async () => {
      gitDirs(verify.root)
      withGitMemo(() => { gitDirs(verify.root); gitDirs(verify.root); repoRoot(verify.root) })
      gitDirs(verify.root)
      await main(['sdd', 'status', 'f'], cleanGitEnv(), verify.root)
    })
    const tail = observed.events.slice(start)
    assert.ok(tail.some((e) => e.kind === 'bypass' && e.reason === 'legacy'))
    assert.ok(tail.some((e) => e.kind === 'bypass' && e.reason === 'no_scope' && e.query === 'repoRoot'))
    assert.ok(tail.some((e) => e.kind === 'hit' && e.query === 'gitDirs'))
  }) } finally { channel('sdd-ai:git-memo').unsubscribe(resolveMiss); counter.restore(); observed.stop(); verify.cleanup(); commit.cleanup() }
})
