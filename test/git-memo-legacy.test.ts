import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { channel } from 'node:diagnostics_channel'
import { main } from '../src/cli.ts'
import { gitDirs } from '../src/git.ts'
import type { GitMemoEvent } from '../src/git-memo.ts'
import { cleanGitEnv, legacyScenarios, listenGitMemo, makeGitMemoRepo, prepareWaitingWriter, reservationApis, scopesOfCall, SOURCE_ROOT, spawnControlledWriter, withGitAndSwitchesEnvAsync, writeGitFile, writeLegacyControl } from './git-memo-fixture.ts'

test('los controles anteriores y writers vivos conservan autoridad almacén identidad y evolución', async () => {
  const fixture = makeGitMemoRepo(); const root = fixture.root
  const gitA = join(root, 'git-a'); const gitB = join(root, 'git-b')
  renameSync(join(root, '.git'), gitA); writeGitFile(root, gitA)
  const pending = prepareWaitingWriter(root)
  writeLegacyControl(root, pending.id, pending.control, { id: pending.id, pid: process.pid, lstart: null, gitDir: gitA })
  cpSync(gitA, gitB, { recursive: true })
  const alternateStore = join(gitB, 'sdd-ai', 'runs', pending.id)
  const original = readFileSync(join(pending.store, 'control.json'), 'utf8')
  const events = listenGitMemo()
  // El writer arranca en la primera vuelta de wait, así que sus pasos ocurren durante la espera y no antes.
  let writer: ReturnType<typeof spawnControlledWriter> | undefined
  let waitStart: number | undefined
  const diagnostics = channel('sdd-ai:git-memo')
  const startWriter = (message: unknown) => {
    const event = message as GitMemoEvent
    if (writer || event.kind !== 'miss' || event.query !== 'gitDirs' || waitStart === undefined) return
    const own = events.events.slice(waitStart)
    if (event.scope === scopesOfCall(own).callScope) return
    writer = spawnControlledWriter({ root: alternateStore, onSignal: 'exit', steps: [
      { path: join(root, '.git'), content: `gitdir: ${gitB}\n`, delay_ms: 50 },
      { path: 'harvest.json', content: JSON.stringify(pending.harvest), delay_ms: 50 },
    ] })
  }
  try {
    const api = await reservationApis()
    diagnostics.subscribe(startWriter)
    await withGitAndSwitchesEnvAsync({}, async () => {
      // Los escenarios de controles anteriores; el writer vivo se compara en la matriz de equivalencia.
      const previousControls = legacyScenarios().filter((s) => s.name.startsWith('legacy-control-'))
      assert.equal(previousControls.length, 2, 'los dos escenarios de controles anteriores (con checkout congelado y sin él)')
      for (const scenario of previousControls) {
        const previous = makeGitMemoRepo()
        try {
          await scenario.prepare(previous.root, cleanGitEnv())
          const beforeEvents = events.events.length
          const observed = await scenario.run(SOURCE_ROOT, previous.root, cleanGitEnv())
          const json = observed.output?.json as { control: unknown; again: unknown; before: unknown; after: { state: string }; reservation: { version: number }; released: { state: string } }
          assert.deepEqual(json.control, json.again)
          assert.equal(json.before, null)
          assert.equal(json.after.state, 'done')
          assert.equal(json.reservation.version, 1)
          assert.equal(json.released.state, 'released')
          assert.ok(events.events.slice(beforeEvents).some((e) => e.kind === 'hit' && e.query === 'gitDirs'), 'la lectura del control anterior alcanzó el memo')
        } finally { previous.cleanup() }
      }
      waitStart = events.events.length
      const result = await main(['wait', pending.id, '--max', '5'], cleanGitEnv(), root)
      assert.equal(result.code, 0, JSON.stringify(result.out))
      assert.equal((result.out as { state: string }).state, 'done')
      assert.ok(writer, 'el writer arrancó durante la espera')
      // Solo los eventos de esta llamada a wait: sus vueltas son los ámbitos de su llamada distintos del de la llamada.
      const { iterations } = scopesOfCall(events.events.slice(waitStart))
      assert.ok(iterations.size >= 2, 'la evolución se vio en una vuelta posterior')
      assert.ok(events.events.slice(waitStart).some((e) => e.kind === 'hit' && e.query === 'gitDirs' && iterations.has(e.scope)), 'una vuelta alcanzó un hit')
      const control = api.readControl(root, pending.id)
      assert.equal(control.checkout.gitDir, gitA)
      assert.equal(api.controlStore(root, control), pending.store)
      assert.equal(gitDirs(root).gitDir, gitB)
      assert.equal(readFileSync(join(pending.store, 'control.json'), 'utf8'), original)
      assert.equal(readFileSync(join(alternateStore, 'control.json'), 'utf8'), original)
      assert.equal(existsSync(join(gitA, 'sdd-ai', 'writer.lock')), false, 'se libera la reserva del control congelado')
      assert.equal(existsSync(join(gitB, 'sdd-ai', 'writer.lock')), true, 'la copia en el localizador nuevo no adquiere autoridad')
      for (const dir of [pending.store, alternateStore]) assert.ok(readdirSync(dir).every((name) => !name.includes('git-memo')))
      assert.equal(writer.child.exitCode, null, 'el writer de prueba permanece vivo hasta su limpieza explícita')
    })
  } finally { diagnostics.unsubscribe(startWriter); events.stop(); await writer?.cleanup(); fixture.cleanup() }
})
