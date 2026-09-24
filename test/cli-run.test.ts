import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { defaultWaitMax } from '../src/cli.ts'
import { createRun, readStatus, setStatus } from '../src/runs.ts'
import { makeFakeBin, makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

interface Setup { repo: string; env: Record<string, string>; prompt: string }

function setup(opts: { families?: string; bins?: Array<'claude' | 'codex'>; mode?: string; workers?: string } = {}): Setup {
  const repo = makeRepo()
  if (opts.families !== undefined) {
    mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
    writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: ${opts.families}\n  selection: full\n`)
  }
  if (opts.workers !== undefined) writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), opts.workers)
  // PATH controlado: node para el shebang y solo los CLIs falsos pedidos, nunca los reales.
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const b of opts.bins ?? []) makeFakeBin(bin, b)
  const prompt = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(prompt, 'Encargo de prueba.\n')
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? '',
    CLAUDECODE: '1',
    CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')),
    FAKE_MODE: opts.mode ?? 'ok-codex',
  }
  return { repo, env, prompt }
}

function cli(s: Setup, args: string[], extraEnv: Record<string, string> = {}) {
  const started = Date.now()
  const r = spawnSync(BIN, args, { cwd: s.repo, env: { ...s.env, ...extraEnv }, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), ms: Date.now() - started, stderr: r.stderr }
}

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('run por proceso responde en menos de 1 s', () => {
  // Un worker que nunca termina: si run esperara al worker, este test no respondería a tiempo.
  const s = setup({ families: '[codex]', bins: ['codex'], mode: 'hang-child' })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.out.via, 'process')
  assert.equal(r.out.family, 'codex')
  assert.ok(r.ms < 1000, `run tardó ${r.ms} ms`)
  assert.equal(cli(s, ['cancel', r.out.id]).code, 0)
  assert.equal(cli(s, ['wait', r.out.id, '--max', '10']).out.state, 'cancelled')
})

test('run por proceso seguido de wait entrega el resultado', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0, r.stderr)
  const w = cli(s, ['wait', r.out.id, '--max', '10'])
  assert.equal(w.code, 0, JSON.stringify(w.out))
  assert.equal(w.out.state, 'done')
  assert.equal(w.out.result, 'ok')
})

test('vía nativa: sin agentes sincronizados es agents_stale; tras sync, delegated', () => {
  const s = setup({ families: '[claude]' })
  const stale = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(stale.code, 1)
  assert.deepEqual([stale.out.state, stale.out.reason], ['launch_failed', 'agents_stale'])
  assert.equal(cli(s, ['agents', 'sync']).code, 0)
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.family, r.out.agent], ['native', 'claude', 'sdd-worker'])
  assert.equal(readFileSync(r.out.prompt_file, 'utf8'), readFileSync(s.prompt, 'utf8'))
  assert.equal(readStatus(join(s.repo, '.sdd-ai', 'runs', r.out.id)).state, 'delegated')
})

test('CLI ausente: launch_failed por cli_missing con la propuesta de caída', () => {
  const s = setup({ families: '[codex]' })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--conductor-model', 'claude-opus-5-5'], { CLAUDE_EFFORT: 'xhigh' })
  assert.equal(r.code, 1)
  assert.deepEqual([r.out.state, r.out.reason, r.out.fallback.family], ['launch_failed', 'cli_missing', 'claude'])
  // La caída lleva la familia, el modelo y el esfuerzo del conductor.
  assert.match(r.out.next, /--families claude .*--model claude-opus-5-5 --effort xhigh/)
})

const AS_CODEX = { CLAUDECODE: '', CODEX_THREAD_ID: 't' }

test('vía nativa Claude: el modelo distinto al del agente viaja; el esfuerzo se avisa', () => {
  const s = setup({ families: '[claude]' })
  cli(s, ['agents', 'sync'])
  const plain = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal('model' in plain.out || 'effort' in plain.out || 'warnings' in plain.out, false)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--model', 'sonnet', '--effort', 'alto'])
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.model, r.out.effort], ['native', 'sonnet', undefined])
  assert.match(r.out.warnings.join(' '), /esfuerzo/)
})

test('vía nativa: el perfil de otro rol viaja si difiere del agente', () => {
  const s = setup({ families: '[claude]', workers: 'schema_version: 1\nroles:\n  design-review:\n    claude:\n      model: sonnet\n' })
  cli(s, ['agents', 'sync'])
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', 'design-review'])
  assert.equal(r.code, 0)
  assert.equal(r.out.model, 'sonnet')
})

test('vía nativa Codex: el esfuerzo viaja para spawn_agent', () => {
  const s = setup({ families: '[codex]' })
  cli(s, ['agents', 'sync'], AS_CODEX)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--effort', 'maximo'], AS_CODEX)
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.effort], ['native', 'max'])
})

test('la caída desde Codex conserva el esfuerzo que declara el conductor', () => {
  const s = setup({ families: '[claude]' })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--conductor-model', 'gpt-6-sol', '--conductor-effort', 'alto'], AS_CODEX)
  assert.equal(r.out.reason, 'cli_missing')
  assert.match(r.out.next, /--families codex .*--model gpt-6-sol --effort high/)
})

test('retry reutiliza el prompt congelado y sale por la vía nativa', () => {
  const s = setup({ families: '[codex]' })
  const first = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(first.out.reason, 'cli_missing')
  cli(s, ['agents', 'sync'])
  const retry = cli(s, ['run', '--retry', first.out.id, '--families', 'claude'])
  assert.equal(retry.code, 0)
  assert.equal(retry.out.via, 'native')
  const runs = join(s.repo, '.sdd-ai', 'runs')
  assert.equal(JSON.parse(readFileSync(join(runs, retry.out.id, 'request.json'), 'utf8')).retry_of, first.out.id)
  assert.equal(readFileSync(join(runs, retry.out.id, 'prompt.md'), 'utf8'), readFileSync(join(runs, first.out.id, 'prompt.md'), 'utf8'))
})

test('un worker no puede lanzar otro sdd-ai', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt], { SDD_AI_WORKER: '1' })
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'recursion')
})

test('sin config: config_missing y la config sigue sin existir', () => {
  const s = setup({ bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'config_missing')
  assert.equal(existsSync(join(s.repo, '.sdd-ai', 'config.yml')), false)
})

test('run no modifica la config', () => {
  const s = setup({ families: '[codex]', bins: ['codex'], workers: 'schema_version: 1\nroles:\n  explore:\n    codex:\n      model: gpt-x\n' })
  const files = ['config.yml', 'workers.yml'].map((f) => join(s.repo, '.sdd-ai', f))
  const before = files.map(sha)
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0)
  cli(s, ['wait', r.out.id, '--max', '10'])
  assert.deepEqual(files.map(sha), before)
})

test('run registra el PID del supervisor en su propio archivo', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  const pid = Number(readFileSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'supervisor.pid'), 'utf8'))
  assert.ok(Number.isInteger(pid) && pid > 0)
  cli(s, ['wait', r.out.id, '--max', '10'])
})

test('wait detecta un supervisor que murió antes de marcar running', () => {
  const s = setup({ families: '[codex]' })
  const dir = createRun(s.repo, 'sin-arrancar')
  setStatus(dir, { state: 'launching' })
  writeFileSync(join(dir, 'supervisor.pid'), String(2 ** 22 - 1))
  const r = cli(s, ['wait', 'sin-arrancar', '--max', '2'])
  assert.equal(r.code, 1)
  assert.deepEqual([r.out.state, r.out.reason], ['failed', 'supervisor_lost'])
})

test('wait detecta un supervisor muerto', () => {
  const s = setup({ families: '[codex]' })
  const dir = createRun(s.repo, 'huerfana')
  setStatus(dir, { state: 'running', supervisor_pid: 2 ** 22 - 1 })
  const r = cli(s, ['wait', 'huerfana', '--max', '2'])
  assert.equal(r.code, 1)
  assert.deepEqual([r.out.state, r.out.reason], ['failed', 'supervisor_lost'])
})

test('cancel corta una corrida en curso', async () => {
  const s = setup({ families: '[codex]', bins: ['codex'], mode: 'hang-child' })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  const dir = join(s.repo, '.sdd-ai', 'runs', r.out.id)
  const until = Date.now() + 5000
  while (!(existsSync(join(dir, 'status.json')) && readStatus(dir).worker_pid) && Date.now() < until) await sleep(50)
  assert.equal(cli(s, ['cancel', r.out.id]).code, 0)
  const w = cli(s, ['wait', r.out.id, '--max', '5'])
  assert.equal(w.out.state, 'cancelled')
})

test('el tope por defecto de wait depende del conductor', () => {
  assert.equal(defaultWaitMax('claude'), 540)
  assert.equal(defaultWaitMax('codex'), 100)
})
