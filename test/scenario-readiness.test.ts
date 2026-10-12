import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { awaitObservation, ownProcesses, requirePublicationBudget, requireTerminal, ScenarioError, withOwned } from './scenario-readiness.ts'
import { projectionFixture, publicationScript, fixtureJson } from './projection-fixture.ts'

const errorCode = (code: string) => (error: unknown) => error instanceof ScenarioError && error.code === code

for (const [name, detail] of [
  ['un acuse que nunca llega falla con diagnóstico', { acknowledgement: null }],
  ['un archivo pids incompleto falla con diagnóstico', { pids: [123] }],
  ['un cambio incompleto falla con diagnóstico', { added: true, modified: false }],
  ['un intento guionado ausente falla con diagnóstico', { attempts: ['initial'], expected: 'profile_retry' }],
] as const) {
  test(name, async () => {
    await assert.rejects(awaitObservation(name, () => ({ detail }), 100), (e) => {
      assert.ok(errorCode('observation_timeout')(e))
      assert.ok((e as Error).message.includes(JSON.stringify(detail)))
      return true
    })
  })
}

test('un PID cuya identidad cambió no se señala', async () => {
  let changed = false
  const signals: string[] = []
  const owned = ownProcesses({
    read: () => ({ pgid: 123, lstart: changed ? 'otro inicio' : 'inicio', argvHash: 'hash' }),
    probe: () => 'alive', signal: (_, signal) => { signals.push(signal) },
  })
  owned.add(123)
  changed = true
  await owned.disposeOwned(100)
  assert.deepEqual(signals, [])
})

test('un cese que no se acredita produce un error de cleanup y conserva el directorio', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdd-ai-cleanup-negative-'))
  const owned = ownProcesses({ read: () => ({ pgid: 123, lstart: 'inicio', argvHash: 'hash' }), probe: () => 'alive', signal: () => {} })
  owned.add(123); owned.directory(directory)
  try {
    await assert.rejects(owned.disposeOwned(100), errorCode('cleanup_uncertain'))
    assert.equal(existsSync(directory), true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('una consulta EPERM no acredita ausencia ni permite borrar el directorio', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdd-ai-cleanup-unknown-'))
  let unknown = false
  const signals: string[] = []
  const owned = ownProcesses({ read: () => ({ pgid: 123, lstart: 'inicio', argvHash: 'hash' }), probe: () => unknown ? 'unknown' : 'alive', signal: (_, s) => { signals.push(s) } })
  owned.add(123); owned.directory(directory); unknown = true
  try {
    await assert.rejects(owned.disposeOwned(100), errorCode('cleanup_uncertain'))
    assert.equal(existsSync(directory), true); assert.deepEqual(signals, [])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('el fallo original precede al error de cleanup en el AggregateError', async () => {
  const original = new Error('fallo del escenario')
  const owned = ownProcesses({ read: () => ({ pgid: 123, lstart: 'inicio', argvHash: 'hash' }), probe: () => 'alive', signal: () => {} })
  owned.add(123)
  await assert.rejects(withOwned(owned, async () => { throw original }, 100), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.equal(e.errors[0], original)
    assert.ok(errorCode('cleanup_uncertain')(e.errors[1]))
    return true
  })
})

test('cessation_uncertain no satisface el estado terminal del escenario', () => {
  assert.throws(() => requireTerminal('cessation_uncertain', 'cancelled'), errorCode('cessation_uncertain'))
})

test('un proceso que ignora SIGTERM recibe SIGKILL y acredita su cese', async () => {
  const owned = ownProcesses()
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false
  child.stdout!.on('data', () => { ready = true })
  const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
  owned.add(child.pid!)
  owned.completion(() => closed)
  await withOwned(owned, async () => {
    await awaitObservation('proceso con SIGTERM ignorado preparado', () => ({ value: ready ? true : undefined, detail: { ready } }))
  })
  assert.equal(child.signalCode, 'SIGKILL')
})

test('un deadline de publicación alcanzado falla aunque el pedido publique', async () => {
  const f = projectionFixture()
  await withOwned(f.owned, async () => {
    const source = join(f.scratch, 'source.json'); fixtureJson(source, ['old'])
    const barrier = f.barrier('held')
    f.start(publicationScript(f.root, source, { barrier: barrier.path, stage: 'claimed', requested: process.hrtime.bigint(), systemBoot: true }))
    await barrier.arrived()
    const measure = join(f.scratch, 'measure.jsonl')
    const request = f.start(`import { publishNow } from ${JSON.stringify(new URL('../src/projection.ts', import.meta.url).href)};
      process.env.SDD_AI_PROJECTION_MEASURE = ${JSON.stringify(measure)};
      publishNow(${JSON.stringify(f.root)}, 'test', 'cli', Date.now(), BigInt(${JSON.stringify(String(process.hrtime.bigint()))}), { queueWaitMs: 300 });`)
    const result = await request.done
    assert.equal(result.code, 0, result.stderr)
    const events = readFileSync(`${measure}.trace.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.some((e) => e.event === 'queue_wait_finished' && e.deadline_reached === true))
    assert.throws(() => requirePublicationBudget(events, true), errorCode('publication_budget_expired'))
    barrier.release()
  })
})
