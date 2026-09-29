import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type SupervisorSpawn, defaultWaitMax, launchSupervisor } from '../src/cli.ts'
import { createRun, isDelivered, markDelivered, readStatus, setStatus, writeJsonAtomic } from '../src/runs.ts'
import { gitDirs } from '../src/git.ts'
import { openRuns } from '../src/open-runs.ts'
import { settleGroup, supervise } from '../src/supervisor.ts'
import { codexWriterLaunch } from '../src/workers/codex.ts'
import {
  type WriterControl, reserveWriter, runDirIdentity, runInventory, sensitiveInventory, writeControl,
} from '../src/writer-store.ts'
import { READ_ONLY_ROLES, SddError, TERMINAL } from '../src/types.ts'
import { makeFakeBin, makeRepo, warmFakeBin } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

interface Setup { repo: string; env: Record<string, string>; prompt: string; bin: string }

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
    CLAUDE_CODE_SESSION_ID: 's-claude',
    CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')),
    FAKE_MODE: opts.mode ?? 'ok-codex',
  }
  return { repo, env, prompt, bin }
}

function cli(s: Setup, args: string[], extraEnv: Record<string, string> = {}) {
  const started = Date.now()
  const r = spawnSync(BIN, args, { cwd: s.repo, env: { ...s.env, ...extraEnv }, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), ms: Date.now() - started, stderr: r.stderr }
}

const pick = (w: { code: number | null; out: { state?: string; result?: string } }) => ({ code: w.code, state: w.out.state, result: w.out.result })
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const nativeOf = (repo: string, id: string) => JSON.parse(readFileSync(join(repo, '.sdd-ai', 'runs', id, 'native.json'), 'utf8'))

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

test('run da búsqueda web por proceso solo a explore e investigate', () => {
  const launched = (s: Setup, role: string, extra: string[] = []): string[] => {
    const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', role, ...extra])
    assert.deepEqual([r.code, r.out.via], [0, 'process'], r.stderr)
    const w = cli(s, ['wait', r.out.id, '--max', '10'])
    assert.ok(TERMINAL.has(w.out.state), `${role}: ${w.out.state}`)
    return JSON.parse(readFileSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'argv.json'), 'utf8')).launch.args
  }
  const codex = setup({ families: '[codex]', bins: ['codex'] })
  for (const role of ['explore', 'investigate']) assert.ok(launched(codex, role).includes('web_search="live"'), role)
  assert.ok(launched(codex, 'design-review').includes('web_search="disabled"'))
  const claude = setup({ families: '[claude]', bins: ['claude'] })
  assert.ok(launched(claude, 'explore', ['--conductor', 'codex']).includes('--allowedTools=WebFetch,WebSearch'))
  assert.equal(launched(claude, 'design-review', ['--conductor', 'codex']).some((a) => a.startsWith('--allowedTools')), false)
})

test('vía nativa: sin agentes sincronizados es agents_stale; tras sync, delegated', () => {
  const s = setup({ families: '[claude]' })
  const stale = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(stale.code, 1)
  assert.deepEqual([stale.out.state, stale.out.reason], ['launch_failed', 'agents_stale'])
  assert.equal(cli(s, ['agents', 'sync']).code, 0)
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.family, r.out.agent], ['native', 'claude', 'sdd-ai-explore'])
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

const AS_CODEX = { CLAUDECODE: '', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's-codex' }

test('vía nativa Claude: el modelo distinto al del agente viaja; el esfuerzo se avisa', () => {
  const s = setup({ families: '[claude]' })
  cli(s, ['agents', 'sync'])
  const plain = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal('model' in plain.out || 'effort' in plain.out || 'warnings' in plain.out, false)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--model', 'sonnet', '--effort', 'alto'])
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.model, r.out.effort], ['native', 'sonnet', undefined])
  assert.match(r.out.warnings.join(' '), /esfuerzo/)
  // native.json guarda lo que run le mostró al conductor: en Claude, sin esfuerzo.
  assert.deepEqual(nativeOf(s.repo, r.out.id), { agent: r.out.agent, family: 'claude', role: 'explore', model: 'sonnet' })
})

test('vía nativa: el perfil del rol vive en su agente', () => {
  const s = setup({ families: '[claude]', workers: 'schema_version: 1\nroles:\n  design-review:\n    claude:\n      model: sonnet\n      effort: muy_alto\n' })
  cli(s, ['agents', 'sync'])
  assert.match(readFileSync(join(s.repo, '.claude/agents/sdd-ai-design-review.md'), 'utf8'), /\nmodel: sonnet\neffort: xhigh\n/)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', 'design-review'])
  assert.equal(r.code, 0)
  assert.equal(r.out.agent, 'sdd-ai-design-review')
  assert.equal('model' in r.out || 'effort' in r.out || 'warnings' in r.out, false)
})

test('vía nativa: cada rol responde con su agente', () => {
  const claude = setup({ families: '[claude]' })
  cli(claude, ['agents', 'sync'])
  const c = cli(claude, ['run', '--prompt-file', claude.prompt, '--role', 'code-review'])
  assert.deepEqual([c.code, c.out.family, c.out.agent], [0, 'claude', 'sdd-ai-code-review'])
  const codex = setup({ families: '[codex]' })
  cli(codex, ['agents', 'sync'], AS_CODEX)
  const x = cli(codex, ['run', '--prompt-file', codex.prompt, '--role', 'code-review'], AS_CODEX)
  assert.deepEqual([x.code, x.out.family, x.out.agent], [0, 'codex', 'sdd-ai-code-review'])
})

test('vía nativa Codex: el esfuerzo viaja para spawn_agent', () => {
  const s = setup({ families: '[codex]' })
  cli(s, ['agents', 'sync'], AS_CODEX)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--effort', 'maximo', '--model', 'gpt-prueba'], AS_CODEX)
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.effort, r.out.model], ['native', 'max', 'gpt-prueba'])
  assert.deepEqual(nativeOf(s.repo, r.out.id), { agent: r.out.agent, family: 'codex', role: 'explore', model: 'gpt-prueba', effort: 'max' })
})

test('wait informa el reintento', () => {
  const s = setup({ families: '[claude]', bins: ['claude'], mode: 'reject-model-claude' })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--model', 'no-existe'], AS_CODEX)
  assert.deepEqual([r.code, r.out.via], [0, 'process'])
  const w = cli(s, ['wait', r.out.id, '--max', '10'], AS_CODEX)
  assert.equal(w.code, 0)
  assert.equal(w.out.state, 'done')
  assert.deepEqual([w.out.retry.field, w.out.retry.requested], ['model', 'no-existe'])
  assert.match(w.out.warnings.join(' '), /modelo no-existe/)
})

test('wait avisa la reanudación', () => {
  const s = setup({ families: '[claude]', bins: ['claude'], mode: 'hang-unless-resume-claude' })
  warmFakeBin(s.bin, 'claude')
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--deadline', '1'], AS_CODEX)
  assert.equal(r.code, 0)
  const w = cli(s, ['wait', r.out.id, '--max', '30'], AS_CODEX)
  assert.equal(w.out.state, 'done')
  assert.equal(w.out.resume.outcome, 'done')
  assert.equal(w.out.result, 'ok')
  assert.match(w.out.warnings.join(' '), /reanud/)
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

const runsIn = (repo: string) => {
  const runs = join(repo, '.sdd-ai', 'runs')
  return existsSync(runs) ? readdirSync(runs) : []
}

const requestOf = (repo: string, id: string) => JSON.parse(readFileSync(join(repo, '.sdd-ai', 'runs', id, 'request.json'), 'utf8'))

test('run guarda la sesión dueña según la familia del conductor', () => {
  // Las dos variables presentes: manda la de la familia del conductor, no la primera que aparezca.
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const claude = cli(s, ['run', '--prompt-file', s.prompt], { CODEX_SESSION_ID: 's-codex' })
  assert.equal(claude.code, 0, claude.stderr)
  assert.equal(requestOf(s.repo, claude.out.id).session, 's-claude')
  const x = setup({ families: '[claude]', bins: ['claude'] })
  const codex = cli(x, ['run', '--prompt-file', x.prompt], AS_CODEX)
  assert.equal(codex.code, 0, codex.stderr)
  assert.equal(requestOf(x.repo, codex.out.id).session, 's-codex')
  cli(s, ['wait', claude.out.id, '--max', '10'])
  cli(x, ['wait', codex.out.id, '--max', '10'], AS_CODEX)
})

test('run --retry hereda rol, overrides y familia del conductor', () => {
  // Conductor Codex declarado y familia Claude sin CLI: las dos corridas quedan en cli_missing.
  const s = setup({ families: '[claude]' })
  const first = cli(s, ['run', '--prompt-file', s.prompt, '--conductor', 'codex', '--role', 'code-review', '--model', 'sonnet', '--deadline', '900'])
  assert.equal(first.out.reason, 'cli_missing', JSON.stringify(first.out))
  const retry = cli(s, ['run', '--retry', first.out.id])
  assert.equal(retry.out.reason, 'cli_missing', JSON.stringify(retry.out))
  const req = requestOf(s.repo, retry.out.id)
  assert.deepEqual([req.role, req.overrides.model, req.overrides.deadline_sec, req.conductor.family], ['code-review', 'sonnet', 900, 'codex'])
  const plain = requestOf(s.repo, cli(s, ['run', '--prompt-file', s.prompt, '--conductor', 'codex']).out.id)
  assert.deepEqual([plain.role, plain.overrides.deadline_sec], ['explore', 600])
})

test('un fallback con modelo de la otra familia no hereda ese modelo', () => {
  const s = setup({ families: '[codex]' })
  const first = cli(s, ['run', '--prompt-file', s.prompt, '--families', 'codex', '--model', 'gpt-6-sol', '--role', 'design-review'])
  assert.equal(first.out.reason, 'cli_missing', JSON.stringify(first.out))
  const retry = cli(s, ['run', '--retry', first.out.id, '--families', 'claude', '--conductor', 'claude'])
  const req = requestOf(s.repo, retry.out.id)
  assert.equal(req.overrides.model, undefined)
  assert.equal(req.role, 'design-review')
})

test('un run nativo sin id de sesión falla sin crear la corrida', () => {
  const s = setup({ families: '[claude]' })
  assert.equal(cli(s, ['agents', 'sync']).code, 0)
  const r = cli(s, ['run', '--prompt-file', s.prompt], { CLAUDE_CODE_SESSION_ID: '' })
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'session_unknown')
  assert.deepEqual(runsIn(s.repo), [])
})

test('--role pr da el aviso de migración', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', 'pr'])
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'usage')
  assert.match(`${r.out.message} ${r.out.next}`, /code-review/)
  assert.deepEqual(runsIn(s.repo), [])
})

test('un rol con nombre de Object.prototype es desconocido', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  for (const role of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', role])
    assert.equal(r.code, 2, role)
    assert.equal(r.out.code, 'usage', role)
    assert.equal(r.out.message, `rol desconocido: ${role}`)
  }
  assert.deepEqual(runsIn(s.repo), [])
})

test('los roles de lectura conservan lanzadores, vías y resultado de wait', () => {
  const argsOf = (repo: string, id: string): string[] =>
    JSON.parse(readFileSync(join(repo, '.sdd-ai', 'runs', id, 'argv.json'), 'utf8')).launch.args
  const codex = setup({ families: '[codex]', bins: ['codex'] })
  const claude = setup({ families: '[claude]', bins: ['claude'], mode: 'ok-claude' })
  for (const role of READ_ONLY_ROLES) {
    const r = cli(codex, ['run', '--prompt-file', codex.prompt, '--role', role])
    assert.deepEqual([r.code, r.out.via, r.out.family], [0, 'process', 'codex'], role)
    const args = argsOf(codex.repo, r.out.id)
    assert.deepEqual(args.slice(0, 8), ['exec', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins'], role)
    assert.equal(args[args.indexOf('-s') + 1], 'read-only', role)
    assert.ok(args.includes('--output-last-message') && !args.includes('--ignore-rules'), role)
    assert.deepEqual(Object.values(pick(cli(codex, ['wait', r.out.id, '--max', '10']))), [0, 'done', 'ok'], role)

    const c = cli(claude, ['run', '--prompt-file', claude.prompt, '--role', role, '--conductor', 'codex'])
    assert.deepEqual([c.code, c.out.via, c.out.family], [0, 'process', 'claude'], role)
    const cargs = argsOf(claude.repo, c.out.id)
    assert.ok(cargs.includes('--safe-mode') && cargs.some((a) => a.startsWith('--tools=Read,Grep,Glob')), role)
    assert.equal(cargs.some((a) => /Edit|Write|Bash/.test(a)) || cargs.includes('--restricted'), false, role)
    assert.equal(cli(claude, ['wait', c.out.id, '--max', '10']).out.state, 'done', role)
  }
  const native = setup({ families: '[claude]' })
  assert.equal(cli(native, ['agents', 'sync']).code, 0)
  for (const role of READ_ONLY_ROLES) {
    const r = cli(native, ['run', '--prompt-file', native.prompt, '--role', role])
    assert.deepEqual([r.code, r.out.via, r.out.agent], [0, 'native', `sdd-ai-${role}`], role)
  }
})

test('--role code-review despacha', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', 'code-review'])
  assert.equal(r.code, 0)
  assert.equal(r.out.via, 'process')
  cli(s, ['wait', r.out.id, '--max', '10'])
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

test('si el supervisor no arranca, el lanzamiento sale con launch_failed y wait lo devuelve sin esperar', () => {
  const s = setup({ families: '[codex]' })
  const dir = createRun(s.repo, 'sin-supervisor')
  // Como un spawn que falla: sin pid, y el error llega en el tick siguiente.
  const noProcess: SupervisorSpawn = () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref() {} })
    setImmediate(() => child.emit('error', new Error('spawn EAGAIN')))
    return child
  }
  assert.throws(
    () => launchSupervisor(dir, { family: 'codex', deadline_sec: 30 }, {}, { fallback: { family: 'claude' } }, 'argv.json', noProcess),
    (e: unknown) => e instanceof SddError && e.code === 'launch_failed' && e.next === './bin/sdd-ai wait sin-supervisor',
  )
  assert.deepEqual([readStatus(dir).state, readStatus(dir).reason], ['launch_failed', 'supervisor_not_started'])
  assert.equal(existsSync(join(dir, 'supervisor.pid')), false)
  const w = cli(s, ['wait', 'sin-supervisor', '--max', '30'])
  assert.deepEqual([w.code, w.out.state, w.out.reason, w.out.fallback], [1, 'launch_failed', 'supervisor_not_started', undefined])
  assert.ok(w.ms < 1000, `wait tardó ${w.ms} ms`)
})

test('un id de corrida que no es un segmento se rechaza en cada comando sin tocar nada fuera del almacén', () => {
  const s = setup({ families: '[codex]' })
  const outside = join(s.repo, 'fuera')
  mkdirSync(outside)
  writeFileSync(join(outside, 'status.json'), '{"state":"done"}')
  const commands = (id: string) => [
    ['wait', id, '--max', '1'], ['cancel', id], ['review', 'status', id], ['review', 'decide', id, 'accept', 'F-1'],
    ['review', 'round', id], ['run', '--retry', id],
  ]
  for (const id of ['../../fuera', 'a/b', '.', '..']) {
    for (const args of commands(id)) {
      const r = cli(s, args)
      assert.notEqual(r.code, 0, args.join(' '))
      assert.equal(r.out.code, 'usage', args.join(' '))
      assert.ok(r.out.message.includes(id), args.join(' '))
    }
  }
  assert.deepEqual(readdirSync(outside), ['status.json'])
  assert.equal(readFileSync(join(outside, 'status.json'), 'utf8'), '{"state":"done"}')
  const dir = createRun(s.repo, 'valida')
  setStatus(dir, { state: 'failed', reason: 'x' })
  assert.deepEqual(pick(cli(s, ['wait', 'valida', '--max', '1'])), { code: 1, state: 'failed', result: undefined })
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

const deliveredIn = (repo: string, id: string) => existsSync(join(repo, '.sdd-ai', 'runs', id, 'delivered.json'))

test('una consulta desde otra sesión no marca la entrega', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0, r.stderr)
  const other = cli(s, ['wait', r.out.id, '--max', '10'], { CLAUDE_CODE_SESSION_ID: 's-otra' })
  assert.equal(other.out.state, 'done')
  assert.equal(deliveredIn(s.repo, r.out.id), false)
  assert.equal(cli(s, ['wait', r.out.id, '--max', '10']).out.state, 'done')
  assert.equal(deliveredIn(s.repo, r.out.id), true)
})

test('la entrega usa la familia guardada aunque el entorno tenga señales de los dos CLIs', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0, r.stderr)
  const w = cli(s, ['wait', r.out.id, '--max', '10'], { CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's-codex' })
  assert.equal(w.out.state, 'done')
  assert.equal(deliveredIn(s.repo, r.out.id), true)
})

test('una ronda o un relanzamiento nuevos quedan sin entregar', () => {
  const s = setup({ families: '[codex]' })
  const dir = createRun(s.repo, '20260101-0000-aaaa')
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ session: 's-claude', conductor: { family: 'claude' } }))
  const done = setStatus(dir, { state: 'done', round: 1, launch: 1 })
  markDelivered(dir, done, { CLAUDE_CODE_SESSION_ID: 's-claude' })
  assert.equal(isDelivered(dir, done), true)
  assert.equal(isDelivered(dir, setStatus(dir, { round: 2 })), false)
  assert.equal(isDelivered(dir, setStatus(dir, { round: 1, launch: 2 })), false)
  // Una respuesta que no se pudo armar no queda entregada.
  const broken = createRun(s.repo, '20260101-0000-bbbb')
  writeFileSync(join(broken, 'request.json'), JSON.stringify({ session: 's-claude', conductor: { family: 'claude' } }))
  setStatus(broken, { state: 'done' })
  const w = cli(s, ['wait', '20260101-0000-bbbb', '--max', '1'])
  assert.notEqual(w.code, 0)
  assert.equal(existsSync(join(broken, 'delivered.json')), false)
})


// --- El writer: run --role implement, wait y cancel ---

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const storeOf = (repo: string, id: string) => join(repo, '.git', 'sdd-ai', 'runs', id)
const lockOf = (repo: string) => join(repo, '.git', 'sdd-ai', 'writer.lock')
const readJsonFile = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

interface WSetup extends Setup { base: string }

/** Un repo con un commit, `.sdd-ai/` ignorado como lo deja `run` y el writer falso con su guion. */
function writerSetup(opts: { families?: string; bins?: Array<'claude' | 'codex'>; script?: object; empty?: boolean } = {}): WSetup {
  const s = setup({ families: opts.families ?? '[codex]', bins: opts.bins ?? ['codex'], mode: 'writer' })
  writeFileSync(join(s.repo, '.sdd-ai', '.gitignore'), '*\n')
  git(s.repo, 'config', 'user.name', 'Test')
  git(s.repo, 'config', 'user.email', 'test@example.com')
  s.env.FAKE_WRITER = JSON.stringify(opts.script ?? {})
  if (opts.empty) return { ...s, base: '' }
  writeFileSync(join(s.repo, 'a.txt'), 'uno\ndos\n')
  writeFileSync(join(s.repo, 'borrar.txt'), 'b\n')
  writeFileSync(join(s.repo, 'mover.txt'), Array.from({ length: 30 }, (_, i) => `línea ${i}\n`).join(''))
  writeFileSync(join(s.repo, 'script.sh'), '#!/bin/sh\n')
  git(s.repo, 'add', '-A')
  git(s.repo, 'commit', '-qm', 'base')
  return { ...s, base: git(s.repo, 'rev-parse', 'HEAD') }
}

/** Espera a que el writer esté corriendo: su grupo ya quedó registrado en el almacén. */
async function whenRunning(repo: string, id: string): Promise<{ pid: number; pgid: number; lstart: string | null; argvHash: string }> {
  const until = Date.now() + 15_000
  for (;;) {
    const file = join(storeOf(repo, id), 'control.json')
    const group = existsSync(file) ? readJsonFile(file).group : undefined
    if (group) return group
    if (Date.now() > until) throw new Error(`el writer ${id} no arrancó`)
    await sleep(50)
  }
}

const implement = (s: Setup, extra: string[] = [], env: Record<string, string> = {}) =>
  cli(s, ['run', '--role', 'implement', '--prompt-file', s.prompt, ...extra], env)

test('implement sale por proceso con la familia resuelta y registra la base, también con la familia del conductor', () => {
  for (const [families, bins, expected] of [['[codex, claude]', ['codex', 'claude'], 'codex'], ['[claude]', ['claude'], 'claude']] as const) {
    const s = writerSetup({ families, bins: [...bins] })
    const r = implement(s)
    assert.equal(r.code, 0, JSON.stringify(r.out))
    assert.deepEqual([r.out.via, r.out.family, r.out.base], ['process', expected, s.base])
    assert.equal(readJsonFile(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'request.json')).base, s.base)
    assert.equal(readJsonFile(join(storeOf(s.repo, r.out.id), 'control.json')).base, s.base)
    assert.equal(existsSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'native.json')), false)
    assert.equal(cli(s, ['wait', r.out.id, '--max', '20']).out.state, 'done')
  }
})

test('implement sin commit en HEAD se rechaza sin crear corrida', () => {
  const s = writerSetup({ empty: true })
  const r = implement(s)
  assert.deepEqual([r.code, r.out.code], [2, 'no_head'])
  assert.deepEqual(runsIn(s.repo), [])
  assert.equal(existsSync(lockOf(s.repo)), false)
})

test('sin poder escribir el almacén, implement falla con control_unavailable y un next que pide escalar, sin tocar el árbol', () => {
  const s = writerSetup()
  chmodSync(join(s.repo, '.git'), 0o500)
  let r
  try {
    r = implement(s)
  } finally {
    chmodSync(join(s.repo, '.git'), 0o755)
  }
  assert.deepEqual([r.code, r.out.code], [2, 'control_unavailable'])
  assert.match(r.out.next, /salir del sandbox \(escalada\)/)
  assert.deepEqual(runsIn(s.repo), [])
  assert.equal(git(s.repo, 'status', '--porcelain'), '')
})

test('implement con el árbol sucio se rechaza, también con --retry y la caída, nombra los archivos y remite a preguntar', () => {
  const s = writerSetup({ families: '[codex, claude]', bins: ['codex', 'claude'] })
  const first = implement(s)
  assert.equal(cli(s, ['wait', first.out.id, '--max', '20']).out.state, 'done')
  git(s.repo, 'checkout', '-q', '--', '.')
  git(s.repo, 'clean', '-qfd')
  writeFileSync(join(s.repo, 'a.txt'), 'sucio\n')
  writeFileSync(join(s.repo, 'suelto.txt'), 'x\n')
  const runsBefore = runsIn(s.repo)
  for (const extra of [[], ['--retry', first.out.id], ['--families', 'claude', '--conductor', 'claude']]) {
    const r = extra[0] === '--retry' ? cli(s, ['run', ...extra]) : implement(s, extra)
    assert.deepEqual([r.code, r.out.code], [2, 'tree_dirty'], JSON.stringify(extra))
    assert.match(r.out.message, /a\.txt/)
    assert.match(r.out.message, /suelto\.txt/)
    assert.match(r.out.next, /pregunta al usuario si conserva el cambio o lo revierte/)
    assert.match(r.out.next, /sdd-ai no hace stash, commit ni revert/)
  }
  assert.deepEqual(runsIn(s.repo), runsBefore)
  assert.equal(existsSync(lockOf(s.repo)), false)
  assert.equal(readFileSync(join(s.repo, 'a.txt'), 'utf8'), 'sucio\n')
})

test('con un writer abierto y el árbol sucio prevalece el rechazo por writer abierto', async () => {
  const s = writerSetup({ script: { hang: true } })
  const open = implement(s)
  assert.equal(open.code, 0)
  await whenRunning(s.repo, open.out.id)
  writeFileSync(join(s.repo, 'a.txt'), 'sucio\n')
  const r = implement(s)
  assert.deepEqual([r.code, r.out.code], [2, 'writer_open'])
  assert.match(r.out.message, new RegExp(open.out.id))
  assert.equal(cli(s, ['cancel', open.out.id]).code, 0)
  assert.equal(cli(s, ['wait', open.out.id, '--max', '20']).out.state, 'cancelled')
})

test('de dos run implement simultáneos queda una sola corrida', async () => {
  for (let round = 0; round < 5; round++) {
    const s = writerSetup()
    const launch = () => new Promise<{ code: number | null; out: { id?: string; code?: string } }>((res) => {
      const child = spawn(BIN, ['run', '--role', 'implement', '--prompt-file', s.prompt], { cwd: s.repo, env: s.env })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('close', (code) => res({ code, out: JSON.parse(out || 'null') }))
    })
    const results = await Promise.all([launch(), launch()])
    const ok = results.filter((r) => r.code === 0)
    assert.equal(ok.length, 1, `vuelta ${round}: ${JSON.stringify(results)}`)
    assert.equal(results.find((r) => r.code !== 0)?.out.code, 'writer_open', `vuelta ${round}`)
    assert.deepEqual(runsIn(s.repo), [ok[0].out.id])
    assert.equal(cli(s, ['wait', ok[0].out.id ?? '', '--max', '20']).out.state, 'done')
  }
})

const EDITS = [
  { append: 'a.txt', content: 'tres\n' }, { delete: 'borrar.txt' }, { rename: ['mover.txt', 'movido.txt'] },
  { write: 'nuevo.txt', content: 'nuevo\n' }, { binary: 'imagen.bin' }, { chmod: ['script.sh', '755'] }, { symlink: ['a.txt', 'enlace'] },
]

test('wait de un writer trae base, archivos con estado y líneas, binarios, modos, enlaces y renombres', () => {
  const s = writerSetup({ script: { actions: EDITS, report: 'Cambié los archivos.\nSTATUS: done' } })
  const r = implement(s)
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.deepEqual([w.code, w.out.state, w.out.base], [0, 'done', s.base], JSON.stringify(w.out))
  const byPath = new Map<string, { status: string; added: number | null; removed: number | null; binary: boolean; from?: string; modeBefore?: string; modeAfter?: string }>(
    w.out.files.map((f: { path: string }) => [f.path, f]))
  assert.deepEqual([...byPath.keys()].sort(), ['a.txt', 'borrar.txt', 'enlace', 'imagen.bin', 'movido.txt', 'nuevo.txt', 'script.sh'])
  assert.deepEqual([byPath.get('a.txt')?.status, byPath.get('a.txt')?.added, byPath.get('a.txt')?.removed], ['M', 1, 0])
  assert.equal(byPath.get('borrar.txt')?.status, 'D')
  assert.deepEqual([byPath.get('movido.txt')?.status, byPath.get('movido.txt')?.from], ['R', 'mover.txt'])
  assert.deepEqual([byPath.get('nuevo.txt')?.status, byPath.get('nuevo.txt')?.added], ['A', 1])
  assert.deepEqual([byPath.get('imagen.bin')?.binary, byPath.get('imagen.bin')?.added], [true, null])
  assert.deepEqual([byPath.get('script.sh')?.modeBefore, byPath.get('script.sh')?.modeAfter], ['100644', '100755'])
  assert.equal(byPath.get('enlace')?.modeAfter, '120000')
  assert.equal(w.out.diff, join(storeOf(s.repo, r.out.id), 'diff.patch'))
  assert.ok(readFileSync(w.out.diff).length > 0)
  assert.deepEqual([w.out.report, w.out.end_mark, w.out.flagged, w.out.run_altered, w.out.head_moved],
    ['Cambié los archivos.\nSTATUS: done', true, [], [], false])
})

test('next propone review start --harvest con base y autor solo con marca, cambio no vacío, sin señalados y HEAD en la base', () => {
  for (const [families, bins, author] of [['[codex]', ['codex'], 'codex'], ['[claude]', ['claude'], 'claude']] as const) {
    const s = writerSetup({ families, bins: [...bins], script: { actions: [{ write: 'nuevo.txt', content: 'n\n' }] } })
    const r = implement(s)
    const w = cli(s, ['wait', r.out.id, '--max', '20'])
    assert.equal(w.out.failed, undefined, JSON.stringify(w.out))
    assert.match(w.out.next, new RegExp(`\\./bin/sdd-ai review start --harvest ${r.out.id} --base ${s.base} --author ${author}$`))
  }
})

test('sin marca, vacío, con señalados o con HEAD movido, next remite a preguntar o a relanzar', () => {
  const cases: Array<[string, object, RegExp, RegExp]> = [
    ['sin marca', { actions: [{ write: 'n.txt', content: 'n\n' }], report: 'Listo.' }, /marca de fin/, /conserva el cambio o lo revierte/i],
    ['vacío', { actions: [] }, /el cambio está vacío/, /no hay nada que conservar ni revertir .*run --retry/],
    ['señalado', { actions: [{ write: 'n.txt', content: 'n\n' }, { write: '.claude/settings.json', content: '{}' }] }, /rutas señaladas: \.claude/, /conserva el cambio o lo revierte/],
    ['HEAD movido', { actions: [{ write: 'n.txt', content: 'n\n' }, { write: '.git/HEAD', content: 'ref: refs/heads/otra\n' }] }, /HEAD ya no es la base/, /conserva el cambio o lo revierte/],
  ]
  for (const [name, script, failed, next] of cases) {
    const s = writerSetup({ script })
    const r = implement(s)
    const w = cli(s, ['wait', r.out.id, '--max', '20'])
    assert.equal(w.out.state, 'done', name)
    assert.match(w.out.failed.join('; '), failed, name)
    assert.match(w.out.next, next, name)
    assert.doesNotMatch(w.out.next, /review start/, name)
  }
})

test('un writer que reescribe su request, su prompt, su argv o su status no cambia la base ni la cosecha y sale señalado', () => {
  const s = writerSetup({
    script: {
      actions: [
        { write: 'nuevo.txt', content: 'n\n' },
        { runWrite: 'request.json', content: '{"role":"explore","base":"0000000000000000000000000000000000000000"}' },
        { runWrite: 'prompt.md', content: 'otro encargo' },
        { runWrite: 'argv.json', content: '{}' },
        { runWrite: 'status.json', content: '{"state":"done"}' },
      ],
    },
  })
  const r = implement(s)
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.deepEqual([w.out.state, w.out.base], ['done', s.base])
  assert.deepEqual(w.out.files.map((f: { path: string }) => f.path), ['nuevo.txt'])
  assert.deepEqual(w.out.run_altered.map((f: { path: string }) => f.path).sort(), ['./argv.json', './prompt.md', './request.json', './status.json'])
  assert.match(w.out.failed.join('; '), /alteró su corrida/)
})

test('un archivo que el writer agrega o cambia en su corrida sale señalado', () => {
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runWrite: 'result.md', content: 'falso' }] } })
  const r = implement(s)
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  const added = w.out.run_altered.find((f: { path: string }) => f.path === './result.md')
  assert.deepEqual([added?.before, added?.after?.type], [undefined, 'file'])
})

test('un status terminal escrito por el writer no hace volver a wait', async () => {
  const s = writerSetup({ script: { actions: [{ runWrite: 'status.json', content: '{"state":"done"}' }], hang: true } })
  const r = implement(s)
  await whenRunning(s.repo, r.out.id)
  const w = cli(s, ['wait', r.out.id, '--max', '1'])
  assert.deepEqual([w.code, w.out.state], [3, 'running'])
  assert.equal(cli(s, ['cancel', r.out.id]).code, 0)
  assert.equal(cli(s, ['wait', r.out.id, '--max', '20']).out.state, 'cancelled')
})

test('--retry de un writer relanza el encargo, el rol, las familias, el perfil y el plazo del almacén', () => {
  const s = writerSetup({
    families: '[codex, claude]', bins: ['codex', 'claude'],
    script: {
      actions: [
        { runWrite: 'prompt.md', content: 'encargo cambiado' },
        { runWrite: 'request.json', content: '{"role":"explore","overrides":{"families":"claude","deadline_sec":5}}' },
      ],
    },
  })
  const prompts = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompts-')), 'p.jsonl')
  const first = implement(s, ['--families', 'codex', '--model', 'gpt-x', '--effort', 'low', '--deadline', '77'], { FAKE_PROMPTS_FILE: prompts })
  assert.equal(cli(s, ['wait', first.out.id, '--max', '20']).out.state, 'done')
  git(s.repo, 'clean', '-qfd')
  const again = cli(s, ['run', '--retry', first.out.id], { FAKE_PROMPTS_FILE: prompts })
  assert.equal(again.code, 0, JSON.stringify(again.out))
  assert.equal(cli(s, ['wait', again.out.id, '--max', '20']).out.state, 'done')
  const control = readJsonFile(join(storeOf(s.repo, again.out.id), 'control.json'))
  assert.equal(control.prompt, 'Encargo de prueba.\n')
  assert.deepEqual([control.family, control.request.role, control.request.families, control.request.model, control.request.effort, control.request.deadline_sec],
    ['codex', 'implement', 'codex', 'gpt-x', 'low', 77])
  const sent = readFileSync(prompts, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string)
  assert.equal(sent.length, 2)
  for (const p of sent) {
    assert.match(p, /Encargo de prueba\./)
    assert.doesNotMatch(p, /encargo cambiado/)
  }
})

test('después de lanzar, sdd-ai no escribe nada en .sdd-ai/runs/<id>: enlaces plantados en diff.patch, en los logs de la reanudación, en result.md, en las métricas o en el propio directorio no se siguen', () => {
  const outside = mkdtempSync(join(tmpdir(), 'sdd-ai-afuera-'))
  const witness = (name: string) => join(outside, name)
  for (const n of ['patch', 'log', 'result', 'metrics']) writeFileSync(witness(n), `testigo ${n}\n`)
  const plant = [['diff.patch', 'patch'], ['stdout-resume.log', 'log'], ['result.md', 'result'], ['metrics.json', 'metrics']]
    .map(([name, w]) => ({ runLink: [name, witness(w)] }))
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, ...plant], hangUnlessResume: true } })
  const r = implement(s, ['--deadline', '2'])
  const w = cli(s, ['wait', r.out.id, '--max', '40'])
  assert.equal(w.out.state, 'done', JSON.stringify(w.out))
  for (const n of ['patch', 'log', 'result', 'metrics']) assert.equal(readFileSync(witness(n), 'utf8'), `testigo ${n}\n`, n)
  assert.deepEqual(w.out.run_altered.map((f: { path: string }) => f.path).sort(), ['./diff.patch', './metrics.json', './result.md', './stdout-resume.log'])
  assert.equal(readdirSync(outside).length, 4)

  // El directorio entero, reemplazado por un enlace a otro lado.
  const target = mkdtempSync(join(tmpdir(), 'sdd-ai-destino-'))
  const s2 = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runSwap: target }] } })
  const r2 = implement(s2)
  const w2 = cli(s2, ['wait', r2.out.id, '--max', '20'])
  assert.equal(w2.out.state, 'done')
  assert.deepEqual(readdirSync(target), [])
  assert.ok(w2.out.run_altered.some((f: { path: string; after?: { type: string } }) => f.path === '.' && f.after?.type === 'link'))
})

test('un writer que falla, vence o se cancela entrega la cosecha tras el cese y next remite a preguntar', async () => {
  const edit = { write: 'nuevo.txt', content: 'n\n' }
  const failed = writerSetup({ script: { actions: [edit], exit: 1, report: '' } })
  const f = cli(failed, ['wait', implement(failed).out.id, '--max', '20'])
  assert.equal(f.out.state, 'failed')

  const late = writerSetup({ script: { actions: [edit], hang: true, resumeFail: true } })
  const t = cli(late, ['wait', implement(late, ['--deadline', '1']).out.id, '--max', '40'])
  assert.equal(t.out.state, 'timeout')

  const stopped = writerSetup({ script: { actions: [edit], hang: true } })
  const id = implement(stopped).out.id
  await whenRunning(stopped.repo, id)
  await sleep(300)
  assert.equal(cli(stopped, ['cancel', id]).code, 0)
  const c = cli(stopped, ['wait', id, '--max', '20'])
  assert.equal(c.out.state, 'cancelled')

  for (const w of [f, t, c]) {
    assert.deepEqual(w.out.files.map((x: { path: string }) => x.path), ['nuevo.txt'], w.out.state)
    assert.match(w.out.next, /pregunta al usuario si conserva el cambio o lo revierte; sdd-ai no revierte nada/i, w.out.state)
    assert.equal(w.code, 1)
  }
  for (const s of [failed, late, stopped]) assert.equal(existsSync(lockOf(s.repo)), false)
})

test('sin cambios, next dice que no hay nada que conservar y ofrece relanzar', () => {
  for (const [script, why] of [[{ actions: [] }, /terminó sin cambios/], [{ actions: [], exit: 1, report: '' }, /terminó en failed/]] as const) {
    const s = writerSetup({ script })
    const r = implement(s)
    const w = cli(s, ['wait', r.out.id, '--max', '20'])
    assert.match(w.out.next, /no hay nada que conservar ni revertir/)
    assert.match(w.out.next, why)
    assert.match(w.out.next, new RegExp(`run --retry ${r.out.id}`))
  }
})

/** Un writer vivo con el supervisor muerto: el líder termina y queda un proceso de su grupo. */
async function orphanedWriter(): Promise<{ s: WSetup; id: string; group: { pid: number; pgid: number; lstart: string | null; argvHash: string }; child: number }> {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'sdd-ai-pid-')), 'pid')
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }], child: true, hang: true } })
  const id = implement(s, [], { FAKE_PID_FILE: pidFile }).out.id
  const group = await whenRunning(s.repo, id)
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') await sleep(50)
  const child = Number(readFileSync(pidFile, 'utf8').split(',')[1])
  process.kill(Number(readFileSync(join(storeOf(s.repo, id), 'supervisor.pid'), 'utf8')), 'SIGKILL')
  process.kill(group.pid, 'SIGKILL')
  await sleep(200)
  return { s, id, group, child }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('con el supervisor muerto y un proceso del grupo del writer vivo, aunque el líder haya terminado, wait devuelve cese incierto sin cosecha y la reserva sigue tomada', async () => {
  const { s, id, group, child } = await orphanedWriter()
  try {
    assert.equal(alive(group.pid), false)
    const w = cli(s, ['wait', id, '--max', '5'])
    assert.deepEqual([w.code, w.out.state, w.out.reason], [1, 'cessation_uncertain', 'group_alive'])
    assert.match(w.out.next, /detente y pregúntale al usuario/)
    assert.match(w.out.next, new RegExp(`cancel ${id} --writer-gone`))
    assert.equal(existsSync(join(storeOf(s.repo, id), 'harvest.json')), false)
    assert.equal(readJsonFile(lockOf(s.repo)).id, id)
    assert.equal(alive(child), true)
  } finally {
    process.kill(-group.pgid, 'SIGKILL')
  }
})

test('cancel no señala un grupo cuya identidad no coincide y ofrece --writer-gone', async () => {
  const { s, id, group, child } = await orphanedWriter()
  try {
    const file = join(storeOf(s.repo, id), 'control.json')
    writeFileSync(file, JSON.stringify({ ...readJsonFile(file), group: { ...group, pid: child, argvHash: 'otro' } }))
    const r = cli(s, ['cancel', id])
    assert.deepEqual([r.code, r.out.state, r.out.reason], [1, 'cessation_uncertain', 'identity_mismatch'])
    assert.match(r.out.next, new RegExp(`cancel ${id} --writer-gone`))
    await sleep(300)
    assert.equal(alive(child), true)
    assert.equal(readJsonFile(lockOf(s.repo)).id, id)
    // Con la confirmación del usuario: congela y libera sin señalar.
    const gone = cli(s, ['cancel', id, '--writer-gone'])
    assert.deepEqual([gone.code, gone.out.state], [0, 'cancelled'])
    assert.equal(existsSync(lockOf(s.repo)), false)
    assert.equal(alive(child), true)
  } finally {
    process.kill(-group.pgid, 'SIGKILL')
  }
})

test('cancel con la identidad acreditada detiene el grupo, congela y libera', async () => {
  const { s, id, group, child } = await orphanedWriter()
  const file = join(storeOf(s.repo, id), 'control.json')
  // El líder terminó: el grupo se acredita por el proceso que sigue vivo en él.
  const seen = execFileSync('ps', ['-ww', '-o', 'pgid=,lstart=,command=', '-p', String(child)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s(.*)$/.exec(seen.split('\n')[0]) ?? []
  const argvHash = createHash('sha256').update((m[3] ?? '').trim()).digest('hex')
  writeFileSync(file, JSON.stringify({ ...readJsonFile(file), group: { pid: child, pgid: group.pgid, lstart: m[2], argvHash } }))
  const r = cli(s, ['cancel', id])
  assert.deepEqual([r.code, r.out.state], [0, 'cancelled'], JSON.stringify(r.out))
  assert.equal(alive(child), false)
  assert.equal(existsSync(lockOf(s.repo)), false)
  const w = cli(s, ['wait', id, '--max', '5'])
  assert.deepEqual([w.out.state, w.out.files.map((f: { path: string }) => f.path)], ['cancelled', ['n.txt']])
})

/** Un PID que ya terminó. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

/**
 * Una corrida de writer preparada a mano, sin supervisor: la reserva, la corrida visible, el control y
 * un estado con un supervisor que ya no existe.
 */
function prepared(s: WSetup, opts: { spawning?: boolean; group?: object; session?: string } = {}): string {
  const id = `prep-${Math.random().toString(16).slice(2, 8)}`
  assert.equal(reserveWriter(s.repo, id).ok, true)
  const dir = createRun(s.repo, id)
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ role: 'implement', session: opts.session ?? 's-claude' }))
  writeFileSync(join(dir, 'prompt.md'), 'x')
  const task = { cwd: s.repo, promptFile: join(storeOf(s.repo, id), 'prompt.md'), resultFile: join(storeOf(s.repo, id), 'result.md'), sessionId: 'S' }
  writeControl(s.repo, {
    id, base: s.base, family: 'codex', prompt: 'x', session: opts.session ?? 's-claude', checkout: { root: s.repo, ...gitDirs(s.repo) },
    request: { role: 'implement', conductor: { family: 'claude' }, deadline_sec: 60 },
    preLaunch: runInventory(s.repo, id), inventory: sensitiveInventory(s.repo), runDir: runDirIdentity(s.repo, id) ?? { dev: 0, ino: 0 },
    ...(opts.spawning ? { spawning: new Date().toISOString() } : {}), ...(opts.group ? { group: opts.group } : {}),
  } as WriterControl)
  writeFileSync(join(storeOf(s.repo, id), 'prompt.md'), 'x')
  writeJsonAtomic(join(storeOf(s.repo, id), 'argv.json'), { family: 'codex', deadline_sec: 60, kind: 'writer', root: s.repo, id, launch: codexWriterLaunch(task) })
  writeJsonAtomic(join(storeOf(s.repo, id), 'status.json'), { state: 'running', supervisor_pid: deadPid() })
  return id
}

test('si el árbol cambia entre run y el arranque del writer, el supervisor no lanza y deja tree_changed con la reserva libre', async () => {
  const s = writerSetup()
  const id = prepared(s)
  writeFileSync(join(s.repo, 'a.txt'), 'del usuario\n')
  const calls = join(mkdtempSync(join(tmpdir(), 'sdd-ai-calls-')), 'calls')
  process.env.FAKE_CALLS_FILE = calls
  try {
    await supervise(storeOf(s.repo, id), 'argv.json')
  } finally {
    delete process.env.FAKE_CALLS_FILE
  }
  const h = readJsonFile(join(storeOf(s.repo, id), 'harvest.json'))
  assert.deepEqual([h.state, h.reason], ['launch_failed', 'tree_changed'])
  assert.match(h.detail, /a\.txt/)
  assert.equal(existsSync(calls), false)
  assert.equal(existsSync(lockOf(s.repo)), false)
  assert.match(cli(s, ['wait', id, '--max', '5']).out.next, /conserva el cambio o lo revierte/i)
})

test('la reserva se libera al congelar la cosecha y el resultado sigue sin entregar hasta wait', async () => {
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }] } })
  const id = implement(s).out.id
  const until = Date.now() + 20_000
  while (!existsSync(join(storeOf(s.repo, id), 'harvest.json')) && Date.now() < until) await sleep(50)
  assert.equal(existsSync(lockOf(s.repo)), false)
  assert.deepEqual(openRuns(s.repo).map((r) => [r.id, r.session, r.open]), [[id, 's-claude', 'undelivered']])
  assert.equal(cli(s, ['wait', id, '--max', '5']).out.state, 'done')
  assert.deepEqual(openRuns(s.repo), [])
})

test('una reserva sin control de un run todavía vivo no se libera, y la de un run muerto sí, también con cancel sin directorio de corrida', () => {
  const s = writerSetup()
  const { gitDir } = gitDirs(s.repo)
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()
  mkdirSync(join(s.repo, '.git', 'sdd-ai'), { recursive: true })
  writeFileSync(lockOf(s.repo), JSON.stringify({ id: 'lanzando', pid: process.pid, lstart, gitDir }))
  const live = cli(s, ['cancel', 'lanzando'])
  assert.deepEqual([live.code, live.out.state], [1, 'launching'])
  assert.equal(readJsonFile(lockOf(s.repo)).id, 'lanzando')
  writeFileSync(lockOf(s.repo), JSON.stringify({ id: 'huerfana', pid: deadPid(), lstart: null, gitDir }))
  assert.equal(existsSync(join(s.repo, '.sdd-ai', 'runs', 'huerfana')), false)
  const dead = cli(s, ['cancel', 'huerfana'])
  assert.deepEqual([dead.code, dead.out.state], [0, 'released'])
  assert.equal(existsSync(lockOf(s.repo)), false)
})

test('con control sin spawning y el supervisor muerto, el writer nunca se lanzó: con el árbol en la base, cancel libera sin cosecha; con el árbol cambiado, deja launch_failed con tree_changed', () => {
  const clean = writerSetup()
  const id = prepared(clean)
  const r = cli(clean, ['cancel', id])
  assert.deepEqual([r.code, r.out.state], [0, 'cancelled'])
  const w = cli(clean, ['wait', id, '--max', '5'])
  assert.deepEqual([w.out.state, w.out.reason, w.out.files], ['cancelled', 'not_launched', []])
  assert.equal(existsSync(lockOf(clean.repo)), false)

  const changed = writerSetup()
  const id2 = prepared(changed)
  writeFileSync(join(changed.repo, 'a.txt'), 'otro\n')
  const r2 = cli(changed, ['cancel', id2])
  assert.deepEqual([r2.out.state, r2.out.reason], ['launch_failed', 'tree_changed'])
  assert.equal(existsSync(lockOf(changed.repo)), false)
})

test('con spawning y sin identidad registrada, el cese es incierto y solo --writer-gone libera', () => {
  const s = writerSetup()
  const id = prepared(s, { spawning: true })
  const r = cli(s, ['cancel', id])
  assert.deepEqual([r.code, r.out.state, r.out.reason], [1, 'cessation_uncertain', 'no_identity'])
  const w = cli(s, ['wait', id, '--max', '2'])
  assert.deepEqual([w.code, w.out.state], [1, 'cessation_uncertain'])
  assert.equal(readJsonFile(lockOf(s.repo)).id, id)
  const gone = cli(s, ['cancel', id, '--writer-gone'])
  assert.deepEqual([gone.code, gone.out.state], [0, 'cancelled'])
  assert.equal(existsSync(lockOf(s.repo)), false)
})

test('dos worktrees comparten la reserva y tienen almacenes de corrida separados, y wait, cancel y --retry desde el otro worktree fallan con run_not_found', async () => {
  const s = writerSetup({ script: { hang: true } })
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-wt-'))), 'wt')
  git(s.repo, 'worktree', 'add', '-q', wt, '-b', 'otra')
  mkdirSync(join(wt, '.sdd-ai'))
  for (const f of ['.gitignore', 'config.yml']) writeFileSync(join(wt, '.sdd-ai', f), readFileSync(join(s.repo, '.sdd-ai', f)))
  const other: WSetup = { ...s, repo: wt }
  const id = implement(s).out.id
  await whenRunning(s.repo, id)
  const again = implement(other)
  assert.deepEqual([again.out.code, again.out.message.includes(id)], ['writer_open', true])
  for (const args of [['wait', id, '--max', '1'], ['cancel', id], ['run', '--retry', id]]) {
    const r = cli(other, args)
    assert.deepEqual([r.code, r.out.code], [1, 'run_not_found'], args.join(' '))
  }
  assert.equal(existsSync(join(gitDirs(wt).gitDir, 'sdd-ai', 'runs', id)), false)
  assert.equal(readJsonFile(lockOf(s.repo)).id, id)
  assert.equal(cli(s, ['cancel', id]).code, 0)
  assert.equal(cli(s, ['wait', id, '--max', '20']).out.state, 'cancelled')
})

/** Corre `freezeHarvest` en un proceso aparte y devuelve el registro que obtuvo. */
function freezeInProcess(repo: string, id: string, pauseMs = 0): Promise<string> {
  const script = `import { freezeHarvest } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'writer-store.ts'))};`
    + `import { setTimeout as sleep } from 'node:timers/promises';`
    + `const r = await freezeHarvest(process.argv[1], process.argv[2], { state: 'done' }, 'ok\\nSTATUS: done', { beforeRescue: () => sleep(${pauseMs}) });`
    + 'process.stdout.write(JSON.stringify(r))'
  return new Promise((res, rej) => {
    execFile(process.execPath, ['--input-type=module', '-e', script, repo, id], (err, out) => (err ? rej(err) : res(out)))
  })
}

const claimsOf = (repo: string, id: string) => readdirSync(storeOf(repo, id)).filter((f) => /^harvest\.claim\.\d+$/.test(f)).sort()

test('dos freezeHarvest simultáneos publican una sola cosecha', async () => {
  const s = writerSetup()
  const id = prepared(s)
  writeFileSync(join(s.repo, 'n.txt'), 'n\n')
  const [a, b] = await Promise.all([freezeInProcess(s.repo, id), freezeInProcess(s.repo, id)])
  assert.equal(a, b)
  assert.deepEqual(claimsOf(s.repo, id), ['harvest.claim.1'])
  assert.deepEqual(JSON.parse(a).files.map((f: { path: string }) => f.path), ['n.txt'])
  assert.equal(existsSync(lockOf(s.repo)), false)
})

test('un reclamante que muere entre la reclamación y la publicación no bloquea la cosecha', async () => {
  const s = writerSetup()
  const id = prepared(s)
  writeFileSync(join(storeOf(s.repo, id), 'harvest.claim.1'), JSON.stringify({ pid: deadPid(), lstart: null }))
  const r = JSON.parse(await freezeInProcess(s.repo, id))
  assert.equal(r.state, 'done')
  assert.deepEqual(claimsOf(s.repo, id), ['harvest.claim.1', 'harvest.claim.2'])
  assert.equal(existsSync(join(storeOf(s.repo, id), 'harvest.json')), true)
})

test('dos rescatadores de una reclamación muerta, con una pausa entre la comprobación y el rescate, publican una sola cosecha', async () => {
  const s = writerSetup()
  const id = prepared(s)
  writeFileSync(join(storeOf(s.repo, id), 'harvest.claim.1'), JSON.stringify({ pid: deadPid(), lstart: null }))
  const [a, b] = await Promise.all([freezeInProcess(s.repo, id, 400), freezeInProcess(s.repo, id, 400)])
  assert.equal(a, b)
  assert.deepEqual(claimsOf(s.repo, id), ['harvest.claim.1', 'harvest.claim.2'])
})

test('una caída entre la publicación del registro y la liberación deja el terminal legible y la reserva se libera en la recuperación', () => {
  const s = writerSetup()
  const id = prepared(s)
  const record = { state: 'done', base: s.base, tree: '', files: [], patchFile: join(storeOf(s.repo, id), 'diff.patch'), flagged: [], runAltered: [], headMoved: false, report: 'ok\nSTATUS: done', endMark: true }
  writeFileSync(join(storeOf(s.repo, id), 'diff.patch'), '')
  writeFileSync(join(storeOf(s.repo, id), 'harvest.json'), JSON.stringify(record))
  assert.equal(readJsonFile(lockOf(s.repo)).id, id)
  const w = cli(s, ['wait', id, '--max', '5'])
  assert.deepEqual([w.code, w.out.state], [0, 'done'])
  assert.equal(existsSync(lockOf(s.repo)), false)
})

test('un descendiente que sobrevive al líder con el supervisor vivo lleva a SIGKILL del grupo y, si no cesa, a cese incierto con la reserva tomada', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'sdd-ai-pid-')), 'pid')
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }], child: true } })
  const id = implement(s, [], { FAKE_PID_FILE: pidFile }).out.id
  const w = cli(s, ['wait', id, '--max', '30'])
  assert.equal(w.out.state, 'done', JSON.stringify(w.out))
  const child = Number(readFileSync(pidFile, 'utf8').split(',')[1])
  assert.equal(alive(child), false)
  // Si el grupo no cesa con SIGKILL, el supervisor no lo da por terminado.
  const g = { pid: 99999, pgid: 99999, lstart: null, argvHash: '' }
  assert.equal(await settleGroup(g, 300, () => 'alive'), 'alive')
  assert.equal(await settleGroup(g, 300, () => 'unknown'), 'unknown')
  assert.equal(await settleGroup(g, 300, () => 'gone'), 'gone')
})

test('un writer que termina antes de leer su hora de inicio deja la identidad sin lstart y la corrida se cosecha igual', () => {
  const s = writerSetup({ script: { silent: true } })
  const id = implement(s).out.id
  const w = cli(s, ['wait', id, '--max', '20'])
  assert.equal(w.out.state, 'launch_failed')
  const group = readJsonFile(join(storeOf(s.repo, id), 'control.json')).group
  assert.equal(group.lstart, null)
  assert.equal(existsSync(join(storeOf(s.repo, id), 'harvest.json')), true)
  assert.equal(existsSync(lockOf(s.repo)), false)
})

test('un writer Codex sin archivo de resultado termina done con el reporte del stream', () => {
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }], report: 'Del stream.\nSTATUS: done' } })
  const id = implement(s).out.id
  const argv = readJsonFile(join(storeOf(s.repo, id), 'argv.json'))
  assert.equal(argv.launch.args.includes('--output-last-message'), false)
  const w = cli(s, ['wait', id, '--max', '20'])
  assert.deepEqual([w.out.state, w.out.report, w.out.end_mark], ['done', 'Del stream.\nSTATUS: done', true])
})

test('una cancel.request plantada por el writer en su corrida no cancela nada', () => {
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runWrite: 'cancel.request', content: 'x' }] } })
  const id = implement(s).out.id
  assert.equal(cli(s, ['wait', id, '--max', '20']).out.state, 'done')
})

test('un prompt.md cambiado en la corrida antes del reintento por perfil no llega al reintento', () => {
  const prompts = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompts-')), 'p.jsonl')
  const s = writerSetup({ script: { actions: [{ runWrite: 'prompt.md', content: 'encargo cambiado' }], rejectModel: true } })
  const id = implement(s, ['--model', 'no-existe'], { FAKE_PROMPTS_FILE: prompts }).out.id
  const w = cli(s, ['wait', id, '--max', '20'])
  assert.equal(w.out.state, 'done', JSON.stringify(w.out))
  assert.ok(w.out.warnings?.some((x: string) => /rechazó el modelo no-existe/.test(x)))
  const sent = readFileSync(prompts, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string)
  assert.equal(sent.length, 2)
  for (const p of sent) assert.match(p, /Encargo de prueba\./)

  // Un primer intento que ya cambió el árbol no se reintenta: se congela lo que dejó.
  const withDelta = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }], rejectModel: true } })
  const id2 = implement(withDelta, ['--model', 'no-existe']).out.id
  const w2 = cli(withDelta, ['wait', id2, '--max', '20'])
  assert.deepEqual([w2.out.state, w2.out.reason, w2.out.files.map((f: { path: string }) => f.path)], ['launch_failed', 'model_rejected', ['n.txt']])
})

test('sin poder escribir el almacén, wait anota la entrega en la corrida y cancel pide escalar', async () => {
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }] } })
  const id = implement(s).out.id
  const until = Date.now() + 20_000
  while (!existsSync(join(storeOf(s.repo, id), 'harvest.json')) && Date.now() < until) await sleep(50)
  await sleep(100)
  const sdd = join(s.repo, '.git', 'sdd-ai')
  const dirs = execFileSync('find', [sdd, '-type', 'd'], { encoding: 'utf8' }).trim().split('\n')
  for (const d of dirs) chmodSync(d, 0o555)
  let w
  try {
    w = cli(s, ['wait', id, '--max', '5'])
  } finally {
    for (const d of dirs) chmodSync(d, 0o755)
  }
  assert.equal(w.out.state, 'done')
  assert.equal(existsSync(join(storeOf(s.repo, id), 'delivered.json')), false)
  assert.equal(existsSync(join(s.repo, '.sdd-ai', 'runs', id, 'delivered.json')), true)
  assert.deepEqual(openRuns(s.repo), [])

  // Un writer en curso no se puede cancelar sin escribir el almacén: pide escalar.
  const hung = writerSetup({ script: { hang: true } })
  const hid = implement(hung).out.id
  await whenRunning(hung.repo, hid)
  const hdirs = execFileSync('find', [join(hung.repo, '.git', 'sdd-ai'), '-type', 'd'], { encoding: 'utf8' }).trim().split('\n')
  for (const d of hdirs) chmodSync(d, 0o555)
  let c
  try {
    c = cli(hung, ['cancel', hid])
  } finally {
    for (const d of hdirs) chmodSync(d, 0o755)
  }
  assert.deepEqual([c.code, c.out.code], [2, 'control_unavailable'])
  assert.match(c.out.next, /escalada/)
  assert.equal(cli(hung, ['cancel', hid]).code, 0)
  assert.equal(cli(hung, ['wait', hid, '--max', '20']).out.state, 'cancelled')
})

test('una entrega que el writer dejó en su corrida antes de la cosecha no cuenta', async () => {
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runWrite: 'delivered.json', content: '{"round":null,"launch":null}' }] } })
  const id = implement(s).out.id
  const until = Date.now() + 20_000
  while (!existsSync(join(storeOf(s.repo, id), 'harvest.json')) && Date.now() < until) await sleep(50)
  assert.deepEqual(openRuns(s.repo).map((r) => r.open), ['undelivered'])
})

test('implement con --conductor y sin variables de sesión se despacha, sin sesión dueña en el control', () => {
  const s = writerSetup({ families: '[claude]', bins: ['claude'] })
  const env = { ...s.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_SESSION_ID
  const r = spawnSync(BIN, ['run', '--role', 'implement', '--prompt-file', s.prompt, '--conductor', 'claude'], { cwd: s.repo, env, encoding: 'utf8' })
  const out = JSON.parse(r.stdout || 'null')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual([out.via, out.family], ['process', 'claude'])
  assert.equal(readJsonFile(join(s.repo, '.sdd-ai', 'runs', out.id, 'resolved.json')).via, 'process')
  assert.equal(readJsonFile(join(storeOf(s.repo, out.id), 'control.json')).session, undefined)
  assert.equal(cli(s, ['wait', out.id, '--max', '20']).out.state, 'done')
})

test('una entrega con fecha futura que el writer dejó en su corrida no cuenta', async () => {
  const s = writerSetup({
    script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runWrite: 'delivered.json', content: '{"round":null,"launch":null}' }, { runFuture: 'delivered.json' }] },
  })
  const id = implement(s).out.id
  const until = Date.now() + 20_000
  while (!existsSync(join(storeOf(s.repo, id), 'harvest.json')) && Date.now() < until) await sleep(50)
  assert.deepEqual(openRuns(s.repo).map((r) => r.open), ['undelivered'])
})

test('un .sdd-ai/runs reemplazado por un enlace sale señalado y la entrega no se escribe a través de él', async () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'sdd-ai-afuera-')), 'runs')
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runsSwap: outside }] } })
  const id = implement(s).out.id
  const until = Date.now() + 20_000
  while (!existsSync(join(storeOf(s.repo, id), 'harvest.json')) && Date.now() < until) await sleep(50)
  await sleep(100)
  const sdd = join(s.repo, '.git', 'sdd-ai')
  const dirs = execFileSync('find', [sdd, '-type', 'd'], { encoding: 'utf8' }).trim().split('\n')
  for (const d of dirs) chmodSync(d, 0o555)
  let w
  try {
    w = cli(s, ['wait', id, '--max', '5'])
  } finally {
    for (const d of dirs) chmodSync(d, 0o755)
  }
  assert.ok(w.out.flagged.some((f: { path: string; after?: { type: string } }) => f.path === '.sdd-ai/runs' && f.after?.type === 'link'), JSON.stringify(w.out.flagged))
  assert.equal(existsSync(join(outside, id, 'delivered.json')), false)
})
