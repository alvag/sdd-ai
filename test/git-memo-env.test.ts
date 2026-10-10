import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs, indexEnv, repoRoot } from '../src/git.ts'
import { GIT_QUERY_ENV, GIT_REDIRECT_ENV, withGitQueryScope } from '../src/git-memo.ts'
import { classifyGitQuery, countGitQueries, interceptExecFileSync, listenGitMemo, makeGitMemoRepo, withGitEnv, assertSamePath } from './git-memo-fixture.ts'

test('las seis variables separan claves y las variables de redirección impiden memorizar', () => {
  const fixture = makeGitMemoRepo()
  const { root } = fixture
  const objects = join(root, 'objects')
  mkdirSync(objects)
  const events = listenGitMemo()
  const counter = countGitQueries()
  const redirect: readonly string[] = GIT_REDIRECT_ENV
  const reads = [() => repoRoot(root), () => gitDirs(root), () => indexEnv({ root, gitDir: join(root, '.git') }, join(root, 'scratch'))] as const
  try { withGitEnv({}, () => withGitQueryScope('call', () => {
    for (const read of reads) { read(); read() }
    for (const query of ['repoRoot', 'gitDirs', 'objects']) assert.ok(events.events.some((e) => e.kind === 'hit' && e.query === query))
    // Las claves con las seis variables ausentes: una variable vacía no puede caer en ellas.
    const absent = new Set(events.events.map((e) => e.key))
    for (const name of GIT_QUERY_ENV) {
      const start = events.events.length
      for (const value of ['', name === 'GIT_OBJECT_DIRECTORY' ? objects : name === 'GIT_CEILING_DIRECTORIES' ? root : '1']) {
        const valueStart = events.events.length
        process.env[name] = value
        for (const read of reads) {
          const before = counter.launches.length
          // Las variables vacías o inválidas pueden hacer fallar Git: esos fallos tampoco se guardan.
          for (let i = 0; i < 2; i++) { try { read() } catch { /* Resultado Git legítimo. */ } }
          if (redirect.includes(name)) assert.equal(counter.launches.length - before, 2)
        }
        if (value === '') {
          const empty = events.events.slice(valueStart).map((e) => e.key)
          assert.ok(empty.length > 0 && empty.every((key) => !absent.has(key)), `${name}: vacía y ausente dan claves distintas`)
        }
      }
      delete process.env[name]
      const keys = new Set(events.events.slice(start).map((e) => e.key))
      assert.ok(keys.size >= 6, `${name}: ausencia y valores no deben colisionar`)
      if (redirect.includes(name)) {
        assert.ok(events.events.slice(start).every((e) => e.kind === 'bypass' && e.reason === 'redirect_env'))
      }
    }
    process.env.GIT_OBJECT_DIRECTORY = objects
    assertSamePath(reads[2]().GIT_ALTERNATE_OBJECT_DIRECTORIES, objects)
    delete process.env.GIT_OBJECT_DIRECTORY
    let captureCalls = 0
    const restore = interceptExecFileSync({ match: (argv) => classifyGitQuery(argv) === 'repoRoot',
      before() { if (++captureCalls === 1) process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '1' } })
    try { withGitQueryScope('iteration', () => {
      reads[0](); reads[0]()
      assert.equal(captureCalls, 2)
      assert.ok(events.events.some((e) => e.kind === 'discard' && e.reason === 'unstable'))
    }) } finally { restore(); delete process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM }
  })) } finally { counter.restore(); events.stop(); fixture.cleanup() }
})
