import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRun, readStatus, writeJsonAtomic } from '../src/runs.ts'
import { type ArgvFile, cleanEnv, supervise } from '../src/supervisor.ts'
import type { Family } from '../src/types.ts'
import { makeRepo } from './helpers.ts'

const FAKE = join(import.meta.dirname, 'fake-cli.ts')

function prepare(family: Family, mode: string, over: Partial<ArgvFile> = {}): string {
  const dir = createRun(makeRepo(), 'r')
  writeFileSync(join(dir, 'prompt.md'), 'encargo')
  const argv: ArgvFile = {
    family,
    launch: { cmd: process.execPath, args: [FAKE, '--output-last-message', join(dir, 'result.md')], cwd: dir, stdinFile: join(dir, 'prompt.md') },
    deadline_sec: 30,
    ...over,
  }
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  process.env.FAKE_MODE = mode
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  return dir
}

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() > until) throw new Error('timeout esperando la condición')
    await sleep(50)
  }
}

test('Claude que responde bien termina en done con resultado y sesión', async () => {
  const dir = prepare('claude', 'ok-claude')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.equal(readFileSync(join(dir, 'result.md'), 'utf8'), 'ok')
  assert.equal(s.session_id, '473db793-e2bb-4560-88d1-4c62af94b3eb')
  assert.equal(readStatus(dir).state, 'done')
})

test('Codex que responde bien usa el resultado de --output-last-message', async () => {
  const dir = prepare('codex', 'ok-codex')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.equal(s.session_id, '01a0d50b-9af4-7e53-b865-7e4250ac277a')
})

test('Codex sin auth es launch_failed por auth', async () => {
  const s = await supervise(prepare('codex', 'no-auth-codex'))
  assert.equal(s.state, 'launch_failed')
  assert.equal(s.reason, 'auth')
})

test('Claude que sale limpio sin resultado es failed por empty_result', async () => {
  const s = await supervise(prepare('claude', 'empty-claude'))
  assert.equal(s.state, 'failed')
  assert.equal(s.reason, 'empty_result')
})

test('el tope mata el grupo', async () => {
  const dir = prepare('claude', 'hang-child', { deadline_sec: 1, grace_ms: 200 })
  const s = await supervise(dir)
  assert.equal(s.state, 'timeout')
  const pids = readFileSync(join(dir, 'pids'), 'utf8')
  const status = await waitFor(() => {
    const r = spawnSync('ps', ['-p', pids]).status
    return r === 1 ? r : undefined
  }, 2000)
  assert.equal(status, 1)
})

test('una cancelación termina en cancelled', async () => {
  const dir = prepare('claude', 'hang-child')
  const running = supervise(dir)
  const pid = await waitFor(() => (existsSync(join(dir, 'status.json')) ? readStatus(dir).worker_pid : undefined))
  await sleep(300)
  writeFileSync(join(dir, 'cancel.request'), '')
  process.kill(-pid, 'SIGTERM')
  const s = await running
  assert.equal(s.state, 'cancelled')
})

test('una cancelación pedida antes de lanzar no llega a lanzar al worker', async () => {
  const dir = prepare('claude', 'hang-child')
  writeFileSync(join(dir, 'cancel.request'), '')
  const s = await supervise(dir)
  assert.equal(s.state, 'cancelled')
  assert.equal(existsSync(join(dir, 'pids')), false)
})

test('el supervisor atiende una cancelación sin que nadie mate al worker', async () => {
  const dir = prepare('claude', 'hang-child')
  const started = Date.now()
  const running = supervise(dir)
  await waitFor(() => (existsSync(join(dir, 'status.json')) ? readStatus(dir).worker_pid : undefined))
  writeFileSync(join(dir, 'cancel.request'), '')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.ok(Date.now() - started < 5000, 'la cancelación tardó demasiado')
})

test('una cancelación que el worker ignora termina con SIGKILL tras la gracia', async () => {
  const dir = prepare('claude', 'ignore-term', { grace_ms: 200 })
  const started = Date.now()
  const running = supervise(dir)
  await waitFor(() => (existsSync(join(dir, 'status.json')) ? readStatus(dir).worker_pid : undefined))
  writeFileSync(join(dir, 'cancel.request'), '')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.ok(Date.now() - started < 5000, 'el worker que ignora SIGTERM siguió vivo')
})

test('un CLI que no existe es launch_failed por cli_missing', async () => {
  const dir = prepare('claude', 'ok-claude')
  const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as ArgvFile
  writeJsonAtomic(join(dir, 'argv.json'), { ...argv, launch: { ...argv.launch, cmd: '/no/existe/claude', args: [] } })
  const s = await supervise(dir)
  assert.equal(s.state, 'launch_failed')
  assert.equal(s.reason, 'cli_missing')
})

test('cleanEnv quita las señales de sesión del conductor y marca al worker', () => {
  const env = cleanEnv({
    PATH: 'p', HOME: 'h', CLAUDECODE: '1', CLAUDE_EFFORT: 'x', CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 't',
    CODEX_SESSION_ID: 's', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_CI: '1', CODEX_HOME: 'c',
  })
  assert.deepEqual(env, { PATH: 'p', HOME: 'h', CODEX_HOME: 'c', SDD_AI_WORKER: '1' })
})
