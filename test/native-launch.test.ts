import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelNative, confirm, launchState, release, reserve } from '../src/native-launch.ts'
import { createRun, readStatus, setStatus } from '../src/runs.ts'
import { makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const MODULE = join(import.meta.dirname, '..', 'src', 'native-launch.ts')

const nativeDir = () => mkdtempSync(join(tmpdir(), 'sdd-ai-native-'))

/** Un proceso hijo que espera al instante `at` y reserva: los dos compiten de verdad por el mismo archivo. */
function reserveAt(dir: string, id: string, at: number): Promise<string> {
  const script = 'const { reserve } = await import(process.env.MOD); while (Date.now() < Number(process.env.AT)); process.stdout.write(String(reserve(process.env.DIR, process.env.ID)))'
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MOD: MODULE, DIR: dir, ID: id, AT: String(at) }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  return new Promise((done) => child.on('close', () => done(out)))
}

test('de dos reservas simultáneas pasa exactamente una', async () => {
  for (let i = 0; i < 5; i++) {
    const dir = nativeDir()
    const at = Date.now() + 800
    const [a, b] = await Promise.all([reserveAt(dir, 'tu-a', at), reserveAt(dir, 'tu-b', at)])
    assert.deepEqual([a, b].sort(), ['false', 'true'], `vuelta ${i}`)
    const winner = a === 'true' ? 'tu-a' : 'tu-b'
    assert.equal(JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8')).tool_use_id, winner)
    assert.deepEqual(readdirSync(dir), ['launch.json'], 'no quedan temporales')
  }
})

test('un launch.json ilegible cuenta como reserva sin confirmar', () => {
  const dir = nativeDir()
  writeFileSync(join(dir, 'launch.json'), '{"tool_use_id": "tu-')
  assert.deepEqual(launchState(dir, { state: 'delegated' }), { kind: 'reserved', toolUseId: null, attempt: 0 })
  assert.equal(reserve(dir, 'tu-b'), false)
  assert.equal(confirm(dir, 'tu-b'), false)
  assert.equal(release(dir, 'tu-b'), false)
})

test('confirma o libera solo la reserva con su tool_use_id, y cada fallo suma un intento', () => {
  const dir = nativeDir()
  assert.deepEqual(launchState(dir, { state: 'delegated' }), { kind: 'pending', attempt: 0 })
  assert.equal(reserve(dir, 'tu-1'), true)
  assert.equal(release(dir, 'tu-otro'), false)
  assert.equal(release(dir, 'tu-1'), true)
  assert.deepEqual(launchState(dir, { state: 'delegated' }), { kind: 'pending', attempt: 1 })
  assert.equal(reserve(dir, 'tu-2'), true)
  assert.deepEqual(launchState(dir, { state: 'delegated' }), { kind: 'reserved', toolUseId: 'tu-2', attempt: 1 })
  assert.equal(confirm(dir, 'tu-1'), false)
  assert.equal(confirm(dir, 'tu-2'), true)
  assert.deepEqual(launchState(dir, { state: 'delegated' }), { kind: 'launched' })
  assert.equal(existsSync(join(dir, 'launch-failed-1.json')), true)
})

test('cancel descarta una nativa sin tocar procesos', () => {
  const repo = makeRepo()
  const nativeRun = (id: string) => {
    const dir = createRun(repo, id)
    writeFileSync(join(dir, 'native.json'), JSON.stringify({ agent: 'sdd-ai-explore', family: 'claude', role: 'explore' }))
    setStatus(dir, { state: 'delegated' })
    return dir
  }
  const cancel = (id: string) => {
    const r = spawnSync(process.execPath, [BIN, 'cancel', id], { cwd: repo, encoding: 'utf8' })
    return { code: r.status, out: JSON.parse(r.stdout || 'null') }
  }

  const reserved = nativeRun('20260101-0000-aaaa')
  assert.equal(reserve(reserved, 'tu-1'), true)
  assert.deepEqual(cancel('20260101-0000-aaaa'), { code: 0, out: { id: '20260101-0000-aaaa', state: 'cancelled' } })
  assert.equal(readStatus(reserved).state, 'cancelled')
  assert.equal(existsSync(join(reserved, 'cancel.request')), false)
  assert.equal(cancelNative(reserved), false, 'una nativa cancelada no se vuelve a cancelar')

  // Una nativa ya lanzada es del CLI: cancel no la toca.
  const launched = nativeRun('20260101-0000-bbbb')
  assert.equal(reserve(launched, 'tu-2'), true)
  assert.equal(confirm(launched, 'tu-2'), true)
  assert.deepEqual(cancel('20260101-0000-bbbb').out.state, 'delegated')
  assert.equal(readStatus(launched).state, 'delegated')
})
