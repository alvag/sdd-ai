import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { channel } from 'node:diagnostics_channel'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { main } from '../src/cli.ts'
import { gitDirs, repoRoot } from '../src/git.ts'
import { currentGitQueryScope, withGitQueryScope, type GitMemoEvent } from '../src/git-memo.ts'
import { abortFixtureVerify, cleanGitEnv, countGitQueries, createFixture, GONE_PID, gitIn, listenGitMemo, prepareWaitingWriter, reservationApis, scopesOfCall, SOURCE_ROOT, supervisorApis, withGitAndSwitchesEnvAsync, assertSamePath, writeGitFile } from './git-memo-fixture.ts'

test('main y las iteraciones aíslan el memo incluso con solapamiento rechazo y aborto', async () => {
  const a = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'verify', checkout: 'principal' })
  const b = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'verify', checkout: 'linked' })
  const observed = listenGitMemo()
  const counter = countGitQueries()
  try { await withGitAndSwitchesEnvAsync({}, async () => {
    const ids: number[] = []
    await withGitQueryScope('call', async () => {
      gitDirs(a.root); gitDirs(a.root)
      for (let i = 0; i < 2; i++) await withGitQueryScope('iteration', async () => {
        ids.push(currentGitQueryScope().scope!)
        gitDirs(a.root); await sleep(1); gitDirs(a.root)
      })
      gitDirs(a.root)
    })
    assert.notEqual(ids[0], ids[1])
    for (const id of ids) {
      assert.equal(counter.launches.filter((q) => q.scope === id && q.query === 'gitDirs').length, 1)
      assert.ok(observed.events.some((e) => e.scope === id && e.kind === 'hit'))
    }
    const start = observed.events.length
    const results = await Promise.all([
      main(['sdd', 'verify', 'f'], cleanGitEnv(), a.root),
      main(['sdd', 'verify', 'f'], cleanGitEnv(), b.root),
    ])
    for (const result of results) assert.equal(result.code, 0, JSON.stringify(result.out))
    const calls = new Set(observed.events.slice(start).filter((e) => e.kind === 'hit').map((e) => e.call))
    assert.equal(calls.size, 2, 'las main solapadas tienen contextos propios')
    for (const call of calls) {
      const roots = new Set(counter.launches.filter((q) => q.call === call && q.query === 'repoRoot' && q.scope !== null).map((q) => q.cwd))
      assert.equal(roots.size, 1)
    }
    // Un ámbito de llamada que termina con excepción o rechazo (como el de main) no deja entradas a la llamada siguiente.
    const freshMiss = () => {
      const from = observed.events.length
      withGitQueryScope('call', () => repoRoot(a.root))
      const own = observed.events.slice(from).filter((e) => e.query === 'repoRoot')
      assert.equal(own[0]?.kind, 'miss', 'la llamada siguiente consulta Git de nuevo')
    }
    assert.throws(() => withGitQueryScope('call', () => { repoRoot(a.root); throw new Error('sync failure') }), /sync failure/)
    freshMiss()
    await assert.rejects(withGitQueryScope('call', async () => { repoRoot(a.root); await sleep(1); throw new Error('rejection') }), /rejection/)
    freshMiss()
    assert.equal(currentGitQueryScope().scope, null)
    let late!: Promise<string>
    withGitQueryScope('call', () => { repoRoot(a.root); late = sleep(5).then(() => repoRoot(a.root)) })
    const lateStart = observed.events.length
    assertSamePath(await late, a.root)
    assert.ok(observed.events.slice(lateStart).some((e) => e.kind === 'bypass' && e.reason === 'no_scope'))
    const supervisor = await supervisorApis()
    const settling: Array<{ scope: number | null; call: number | null }> = []
    const deferred: Array<Promise<{ scope: number | null; call: number | null }>> = []
    await withGitQueryScope('call', async () => {
      const call = currentGitQueryScope().call
      // Una identidad que no designa ningún proceso: settleGroup solo señala cuando el sondeo responde 'alive', y este
      // sondeo nunca lo hace; aun si lo hiciera, el PID no existe.
      const result = await supervisor.settleGroup({ pid: GONE_PID, pgid: GONE_PID, lstart: null, argvHash: '' }, 1000, () => {
        settling.push(currentGitQueryScope())
        deferred.push(sleep(1).then(() => currentGitQueryScope()))
        return settling.length === 3 ? 'gone' : 'unknown'
      })
      assert.equal(result, 'gone')
      assert.equal(settling.length, 3)
      assert.equal(new Set(settling.map((s) => s.scope)).size, 3)
      assert.ok(settling.every((s) => s.scope !== null && s.call === call))
      assert.ok((await Promise.all(deferred)).every((s) => s.scope === null && s.call === call))
    })
    assert.equal(currentGitQueryScope().scope, null)
    const beforeAbort = readFileSync(join(a.root, 'src', 'a.ts'), 'utf8')
    const aborted = await withGitQueryScope('call', () => abortFixtureVerify(a.root))
    assert.equal(aborted.receipt.green, false)
    assert.ok(aborted.receipt.rows.some((row) => row.execution?.reason === 'interrupted'))
    assert.equal(aborted.receipt.before.tree, aborted.receipt.after.tree)
    assert.equal(readFileSync(join(a.root, 'src', 'a.ts'), 'utf8'), beforeAbort)
    const reservations = await reservationApis()
    assert.equal(reservations.ownReservation(a.root), undefined)
    assert.equal(currentGitQueryScope().scope, null)
    const afterAbort = observed.events.length
    const next = await main(['sdd', 'status', 'f'], cleanGitEnv(), a.root)
    assert.equal(next.code, 0, JSON.stringify(next.out))
    assert.equal(observed.events.slice(afterAbort).find((e) => e.query === 'repoRoot')?.kind, 'miss', 'tras el aborto, la llamada siguiente consulta Git de nuevo')

    // Dos vueltas reales de waitWriter: el cambio sucede durante sleep, con la vuelta anterior cerrada.
    const pending = prepareWaitingWriter(b.root)
    const gitA = gitIn(b.root, 'rev-parse', '--absolute-git-dir')
    const gitB = join(dirname(gitA), 'memo-replacement')
    cpSync(gitA, gitB, { recursive: true })
    const replacementStore = join(gitB, 'sdd-ai', 'runs', pending.id)
    const diagnostics = channel('sdd-ai:git-memo')
    /**
     * Programa `mutate` 50 ms después del primer miss de gitDirs de una vuelta de wait. Los ámbitos de la llamada y de
     * las vueltas los identifica scopesOfCall sobre los eventos de esta espera, como en git-memo-legacy.test.ts.
     */
    const duringIteration = (mutate: () => void) => {
      const start = observed.events.length
      const state: { scheduled: boolean; timer?: NodeJS.Timeout } = { scheduled: false }
      const listener = (message: unknown) => {
        const event = message as GitMemoEvent
        if (state.scheduled || event.kind !== 'miss' || event.query !== 'gitDirs') return
        let callScope: number
        try { callScope = scopesOfCall(observed.events.slice(start)).callScope } catch { return }
        if (event.scope === callScope) return
        state.scheduled = true
        state.timer = setTimeout(mutate, 50)
      }
      diagnostics.subscribe(listener)
      return { start, state, stop() { diagnostics.unsubscribe(listener); clearTimeout(state.timer) } }
    }
    const replacing = duringIteration(() => {
      writeGitFile(b.root, gitB)
      writeFileSync(join(replacementStore, 'harvest.json'), JSON.stringify(pending.harvest))
    })
    try {
      const waited = await main(['wait', pending.id, '--max', '5'], cleanGitEnv(), b.root)
      assert.equal(waited.code, 0, JSON.stringify(waited.out))
      assert.equal((waited.out as { state: string }).state, 'done')
      assert.equal(replacing.state.scheduled, true)
      const waitEvents = observed.events.slice(replacing.start)
      const { callScope, iterations } = scopesOfCall(waitEvents)
      assert.ok(new Set(waitEvents.filter((e) => e.kind === 'miss' && e.query === 'gitDirs' && iterations.has(e.scope)).map((e) => e.scope)).size >= 2)
      assert.ok(waitEvents.some((e) => e.kind === 'hit' && iterations.has(e.scope) && e.query === 'gitDirs'))
      assert.ok(waitEvents.some((e) => e.kind === 'hit' && e.scope === callScope), 'la main también alcanza un hit')
    } finally { replacing.stop() }

    const lost = prepareWaitingWriter(b.root, '20260101-0000-bcde')
    const deleting = duringIteration(() => rmSync(b.root, { recursive: true }))
    try {
      // Con el checkout borrado, la estampa no se puede leer: el memo hace bypass y la consulta Git de la vuelta se lanza
      // igual que sin memo, con un cwd que ya no existe. La base rechaza de la misma forma (ENOENT de spawnSync git):
      // se comprobó el 2026-10-09 con un snapshot `git archive` de c9c3443 y este mismo escenario.
      await assert.rejects(main(['wait', lost.id, '--max', '5'], cleanGitEnv(), b.root), { code: 'ENOENT', syscall: 'spawnSync git' })
      assert.equal(deleting.state.scheduled, true)
      assert.ok(observed.events.slice(deleting.start).some((e) => e.kind === 'bypass' && e.reason === 'stamp_unreadable'), 'la estampa ilegible lleva a una consulta fresca')
      const absent = await main(['wait', lost.id, '--max', '0'], cleanGitEnv(), b.root)
      assert.notEqual(absent.code, 0)
      assert.equal((absent.out as { code: string }).code, 'not_a_repo')
    } finally { deleting.stop() }
  }) } finally { counter.restore(); observed.stop(); a.cleanup(); b.cleanup() }
})
