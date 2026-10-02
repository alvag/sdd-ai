import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type SupervisorSpawn, defaultWaitMax, launchSupervisor } from '../src/cli.ts'
import { createRun, isDelivered, markDelivered, readStatus, setStatus } from '../src/runs.ts'
import { gitDirs } from '../src/git.ts'
import { openRuns } from '../src/open-runs.ts'
import { supervise } from '../src/supervisor.ts'
import { SddError } from '../src/types.ts'
import {
  setup, cli, pick, sha, deliveredIn, git, storeOf, lockOf, readJsonFile, type WSetup, writerSetup, whenRunning,
  implement, orphanedWriter, alive, deadPid, prepared,
} from './cli-run-fixture.ts'

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
