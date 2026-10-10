import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { withGitQueryScope } from '../src/git-memo.ts'
import { consumerApis, gitIn, listenGitMemo, makeGitMemoRepo, withGitAndSwitchesEnvAsync, worktreeConfigBytes } from './git-memo-fixture.ts'

test('los consumidores conservan la indisponibilidad y prune conserva candidatos ausentes protegidos o cambiados', async () => {
  const fixture = makeGitMemoRepo()
  const root = fixture.root
  const linked = `${root}-linked`
  gitIn(root, 'worktree', 'add', '-qb', 'linked', linked)
  const api = await consumerApis()
  const events = listenGitMemo()
  try { await withGitAndSwitchesEnvAsync({}, async () => withGitQueryScope('call', () => {
    assert.deepEqual(api.openRuns(root), [])
    assert.deepEqual(api.openRuns(linked), [])
    assert.deepEqual(api.openRuns(linked), [])
    assert.ok(events.events.some((e) => e.kind === 'hit' && e.query === 'gitDirs'))
    const ctx = api.pruneContext(root, 0, Date.now() + 86400000)
    assert.deepEqual(api.planPrune(ctx).candidates, [])
    const unavailable = api.reuseWorktreeConfig(linked)
    assert.equal(unavailable.state, 'blocked')
    assert.ok(unavailable.errors.some((e) => e.code === 'source_unavailable'))
    assert.equal(api.reuseWorktreeConfig(root).state, 'blocked')
    mkdirSync(join(root, '.sdd-ai'), { recursive: true })
    for (const [name, bytes] of Object.entries(worktreeConfigBytes)) writeFileSync(join(root, '.sdd-ai', name), bytes)
    const copied = api.reuseWorktreeConfig(linked)
    assert.equal(copied.state, 'copied', JSON.stringify(copied.errors))
    for (const [name, bytes] of Object.entries(worktreeConfigBytes)) assert.equal(readFileSync(join(linked, '.sdd-ai', name), 'utf8'), bytes)
    writeFileSync(join(root, '.sdd-ai', 'config.yml'), 'cross_model: { schema_version: 99 }\n')
    assert.equal(api.reuseWorktreeConfig(linked).state, 'unchanged', 'la configuración local conserva autoridad ante un cambio en la fuente')
    assert.equal(readFileSync(join(linked, '.sdd-ai', 'config.yml'), 'utf8'), worktreeConfigBytes['config.yml'])

    const tmp = join(root, '.sdd-ai', 'tmp', 'candidate')
    mkdirSync(tmp, { recursive: true })
    writeFileSync(join(tmp, 'content'), 'before')
    const planned = api.planPrune(ctx)
    const candidate = planned.candidates.find((c) => c.kind === 'tmp' && c.id === 'candidate')
    assert.ok(candidate)
    writeFileSync(join(tmp, 'content'), 'after')
    assert.deepEqual(api.pruneUnit(ctx, candidate), { deleted: false, reason: 'changed' })
    assert.ok(existsSync(join(tmp, 'content')))
    const id = '20260101-0000-abcd'
    const run = join(root, '.sdd-ai', 'runs', id)
    mkdirSync(run, { recursive: true })
    writeFileSync(join(run, 'request.json'), JSON.stringify({ session: 'fixture-session' }))
    writeFileSync(join(run, 'status.json'), JSON.stringify({ state: 'done' }))
    writeFileSync(join(run, 'delivered.json'), JSON.stringify({ round: null, launch: null }))
    const protectable = api.planPrune(ctx).candidates.find((c) => c.kind === 'run' && c.id === id)
    assert.ok(protectable)
    writeFileSync(join(run, 'status.json'), JSON.stringify({ state: 'running' }))
    assert.deepEqual(api.pruneUnit(ctx, protectable), { deleted: false, reason: 'open' })
    assert.ok(existsSync(run))

    // El registro de worktrees conserva este checkout ausente; prune no lo convierte en disponible.
    rmSync(linked, { recursive: true })
    assert.equal(api.writersDir(linked), undefined)
    assert.ok(api.localRunInventory(linked).unavailable.includes('writers'))
    assert.doesNotThrow(() => api.planPrune(ctx))
    assert.ok(existsSync(tmp))
    assert.throws(() => gitDirs(linked))
  })) } finally { events.stop(); rmSync(linked, { recursive: true, force: true }); fixture.cleanup() }
})
