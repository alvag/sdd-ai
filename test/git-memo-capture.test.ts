import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs, indexEnv, repoRoot } from '../src/git.ts'
import { withGitQueryScope } from '../src/git-memo.ts'
import { classifyGitQuery, interceptExecFileSync, listenGitMemo, makeGitMemoRepo, withGitEnv, writeGitFile, assertSamePath } from './git-memo-fixture.ts'

test('solo se guardan capturas estables y coherentes incluso ante cambios que vuelven al estado inicial', () => {
  const fixture = makeGitMemoRepo()
  const { root } = fixture
  const events = listenGitMemo()
  try { withGitEnv({}, () => {
    const gitA = join(root, '.git')
    const gitB = join(root, 'git-b')
    cpSync(gitA, gitB, { recursive: true })
    const alias = join(root, 'alias')
    writeGitFile(alias, gitA)
    const nested = join(root, 'nested')
    mkdirSync(nested)
    const reads = {
      repoRoot: () => repoRoot(nested),
      gitDirs: () => gitDirs(alias).gitDir,
      objects: () => indexEnv({ root, gitDir: gitA }, join(root, 'scratch')).GIT_ALTERNATE_OBJECT_DIRECTORIES,
    }
    for (const query of ['repoRoot', 'gitDirs', 'objects'] as const) {
      withGitQueryScope('call', () => {
        assert.equal(reads[query](), reads[query]())
        assert.ok(events.events.some((e) => e.kind === 'hit' && e.query === query))
      })
      let calls = 0
      const change = () => {
        if (query === 'repoRoot') cpSync(gitB, join(nested, '.git'), { recursive: true })
        if (query === 'gitDirs') writeGitFile(alias, gitB)
        if (query === 'objects') writeFileSync(join(gitA, 'commondir'), '../git-b\n')
      }
      const undo = () => {
        if (query === 'repoRoot') rmSync(join(nested, '.git'), { recursive: true, force: true })
        if (query === 'gitDirs') writeGitFile(alias, gitA)
        if (query === 'objects') rmSync(join(gitA, 'commondir'), { force: true })
      }
      const restore = interceptExecFileSync({ match(argv) { return classifyGitQuery(argv) === query },
        before() { if (++calls === 1) change() }, after() { if (calls === 1) undo() } })
      try { withGitQueryScope('call', () => {
        const transient = reads[query]()
        assertSamePath(transient, query === 'repoRoot' ? nested : query === 'gitDirs' ? gitB : join(gitB, 'objects'))
        const current = reads[query]()
        assert.notEqual(transient, current)
        assert.equal(reads[query](), current)
        assert.equal(calls, 2)
        assert.ok(events.events.some((e) => e.query === query && e.kind === 'discard' && e.reason === 'incoherent'))
      }) } finally { restore(); undo() }

      // Una captura con extremos distintos tampoco se guarda.
      calls = 0
      const restoreUnstable = interceptExecFileSync({ match(argv) { return classifyGitQuery(argv) === query },
        before() { if (++calls === 1) change() } })
      try { withGitQueryScope('call', () => {
        reads[query](); reads[query]()
        assert.equal(calls, 2)
        assert.ok(events.events.some((e) => e.query === query && e.kind === 'discard' && e.reason === 'unstable'))
      }) } finally { restoreUnstable(); undo() }

      // La disposición vuelve a A antes de que Git la consulte: su respuesta coherente sí se conserva.
      calls = 0
      const restoreCoherent = interceptExecFileSync({ match(argv) { return classifyGitQuery(argv) === query },
        before() { calls++; change(); undo() } })
      try { withGitQueryScope('call', () => {
        assert.equal(reads[query](), reads[query]())
        assert.equal(calls, 1)
      }) } finally { restoreCoherent(); undo() }
      calls = 0
      const restoreEnvironment = interceptExecFileSync({ match(argv) { return classifyGitQuery(argv) === query },
        after() { if (++calls === 1) process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '1' } })
      // Solo cuentan los eventos de este bloque: los anteriores ya tienen un descarte `unstable` de la misma consulta.
      const environmentStart = events.events.length
      try { withGitQueryScope('iteration', () => {
        reads[query](); reads[query]()
        assert.equal(calls, 2)
        const own = events.events.slice(environmentStart).filter((e) => e.query === query)
        assert.equal(own[0]?.kind, 'miss')
        assert.ok(own.some((e) => e.kind === 'discard' && e.reason === 'unstable' && e.ref === own[0].seq), 'la discrepancia del entorno descarta la captura')
        assert.ok(!own.some((e) => e.kind === 'store' && e.ref === own[0].seq), 'una captura con el entorno cambiado no se guarda')
      }) } finally { restoreEnvironment(); delete process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM }
    }
    // Si el destino desaparece después de la respuesta, la captura posterior no puede guardarla.
    let calls = 0
    const restoreUnreadable = interceptExecFileSync({ match(argv) { return classifyGitQuery(argv) === 'gitDirs' },
      after() { if (++calls === 1) rmSync(join(alias, '.git')) } })
    try { withGitQueryScope('iteration', () => {
      reads.gitDirs()
      writeGitFile(alias, gitA)
      reads.gitDirs()
      assert.equal(calls, 2)
      assert.ok(events.events.some((e) => e.query === 'gitDirs' && e.kind === 'discard' && e.reason === 'stamp_unreadable'))
    }) } finally { restoreUnreadable(); writeGitFile(alias, gitA) }
  }) } finally { events.stop(); fixture.cleanup() }
})
