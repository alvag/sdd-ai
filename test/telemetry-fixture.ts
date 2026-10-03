import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRun, newRunId, writeJsonAtomic } from '../src/runs.ts'
import type { ArgvFile } from '../src/supervisor.ts'
import { makeFakeBin, makeRepo } from './helpers.ts'

export const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
export const FAKE = join(import.meta.dirname, 'fake-cli.ts')
export const TEST_DAY = '2030-06-15'
export const CLOCK_OFFSET = Date.parse(`${TEST_DAY}T12:00:00.000Z`) - Date.now()
export type Line = Record<string, any>
export interface TelemetryFixture {
  root: string; home: string; env: Record<string, string>; dispose(): void
}

/**
 * El override heredado se retira: los casos de archivo deben medir la preferencia del usuario. `dispose` borra
 * el repositorio y el home solo si los creó la fixture.
 */
export function telemetryFixture(given?: string, sharedHome?: string): TelemetryFixture {
  const root = given ?? makeRepo()
  const home = sharedHome ?? realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-telemetry-home-')))
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
  delete env.SDD_AI_TELEMETRY
  delete env.NODE_TEST_CONTEXT
  env.HOME = home
  env.CODEX_HOME = join(home, 'codex')
  env.CLAUDE_CONFIG_DIR = join(home, 'claude')
  const dispose = () => {
    if (!sharedHome) rmSync(home, { recursive: true, force: true })
    if (given === undefined) rmSync(root, { recursive: true, force: true })
  }
  return { root, home, env, dispose }
}

export function preference(f: TelemetryFixture, value: string): void {
  mkdirSync(join(f.home, '.sdd-ai'), { recursive: true })
  writeFileSync(join(f.home, '.sdd-ai', 'config.yml'), value)
}

export function telemetryLines(home: string): Line[] {
  const dir = join(home, '.sdd-ai', 'telemetry')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.[0-9a-f-]{36}\.jsonl$/.test(n) && lstatSync(join(dir, n)).isFile()).flatMap((n) =>
    readFileSync(join(dir, n), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Line))
}

export async function eventually<T>(read: () => T | undefined, timeout = 15_000): Promise<T> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = read()
    if (value !== undefined) return value
    await sleep(25)
  }
  throw new Error('la condición observable no llegó')
}

export function prepareAttempt(f: TelemetryFixture, extra: Partial<ArgvFile> = {}, args: string[] = []) {
  // Un id tiene 2 bytes aleatorios por minuto: con decenas de corridas en el mismo minuto, uno puede repetirse.
  let id = newRunId()
  while (existsSync(join(f.root, '.sdd-ai', 'runs', id))) id = newRunId()
  const dir = createRun(f.root, id)
  writeFileSync(join(dir, 'prompt.md'), 'PRIVATE_PROMPT_MARKER\n')
  // Sin pedido, prune no puede leer la corrida y la conserva como ilegible.
  writeJsonAtomic(join(dir, 'request.json'), { role: 'explore' })
  const family = extra.family ?? 'codex'
  const bin = mkdtempSync(join(f.home, 'bin-'))
  makeFakeBin(bin, family)
  const resultArgs = ['--output-last-message', join(dir, 'result.md')]
  const launchArgs = family === 'claude' ? ['--output-format', 'stream-json', ...args]
    : args[0] === 'exec' && args[1] === 'resume' ? ['exec', 'resume', ...resultArgs, ...args.slice(2)]
    : ['exec', ...resultArgs, ...(args[0] === 'exec' ? args.slice(1) : args)]
  const argv: ArgvFile = {
    family: 'codex', deadline_sec: 30, grace_ms: 50, resume_sec: 5,
    execution: { root: f.root, run: id, flow: null, step: null, role: 'explore', requested: { model: 'requested-model', effort: 'high' } },
    launch: { cmd: join(bin, family), args: launchArgs, cwd: f.root, stdinFile: join(dir, 'prompt.md') },
    ...extra,
  }
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  return { id, dir, argv }
}

export function launchAttempt(f: TelemetryFixture, prepared: ReturnType<typeof prepareAttempt>, mode = 'ok-codex', extraEnv: Record<string, string> = {}) {
  const env = { ...f.env, FAKE_MODE: mode, FAKE_CALLS_FILE: join(prepared.dir, 'calls'), ...extraEnv }
  const child = spawn(process.execPath, [BIN, '__supervise', prepared.dir], { env, cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', (b) => { stdout += String(b) })
  child.stderr.on('data', (b) => { stderr += String(b) })
  const done = new Promise<{ code: number | null; out: Line; stderr: string }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      try { resolve({ code, out: JSON.parse(stdout || 'null') as Line, stderr }) } catch (e) { reject(e) }
    })
  })
  return { child, done }
}

export async function runAttempt(f: TelemetryFixture, extra: Partial<ArgvFile> = {}, mode = 'ok-codex', args: string[] = [], extraEnv: Record<string, string> = {}) {
  const prepared = prepareAttempt(f, extra, args)
  const result = await launchAttempt(f, prepared, mode, extraEnv).done
  assert.equal(result.code, 0, result.stderr)
  return { ...prepared, ...result }
}

export const metrics = (dir: string): Line[] => JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8')).attempts
export function command(f: TelemetryFixture, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: f.root, env: { ...f.env, ...extra }, encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, out: JSON.parse(r.stdout || 'null') as Line, stderr: r.stderr }
}

export function controlledClock(f: TelemetryFixture): void {
  f.env.NODE_OPTIONS = `--import ${join(import.meta.dirname, 'telemetry-clock-preload.ts')}`
  f.env.SDD_AI_TEST_CLOCK_OFFSET_MS = String(CLOCK_OFFSET)
}
