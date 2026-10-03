import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type SupervisorSpawn, runWriter } from '../src/cli.ts'
import { readStatus } from '../src/runs.ts'
import { openRuns } from '../src/open-runs.ts'
import { settleGroup } from '../src/supervisor.ts'
import { ownReservation } from '../src/writer-store.ts'
import { SddError } from '../src/types.ts'
import {
  BIN, cli, storeOf, lockOf, readJsonFile, writerSetup, whenRunning, implement, alive, deadPid, prepared,
  freezeInProcess, claimsOf,
} from './cli-run-fixture.ts'

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

test('el writer cuyo supervisor no arranca termina en launch_failed, wait lo devuelve y la reserva se libera', async () => {
  const s = writerSetup()
  const noProcess: SupervisorSpawn = () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref() {} })
    setImmediate(() => child.emit('error', new Error('spawn EAGAIN')))
    return child
  }
  const conductor = { family: 'claude' as const }
  await assert.rejects(() => runWriter({
    root: s.repo, env: s.env, conductor, resolution: { family: 'codex', via: 'process', origin: { model: 'heredado', effort: 'heredado' } },
    prompt: 'Encargo.', deadline: 30, request: { role: 'implement', conductor, deadline_sec: 30 }, source: '--prompt-file p.md', start: noProcess,
  }), (e: unknown) => e instanceof SddError && e.code === 'launch_failed')
  const [id] = readdirSync(join(s.repo, '.sdd-ai', 'runs'))
  assert.deepEqual([readStatus(join(s.repo, '.sdd-ai', 'runs', id)).state, readStatus(join(s.repo, '.sdd-ai', 'runs', id)).reason], ['launch_failed', 'supervisor_not_started'])
  assert.deepEqual([readStatus(storeOf(s.repo, id)).state, readStatus(storeOf(s.repo, id)).reason], ['launch_failed', 'supervisor_not_started'])
  const w = cli(s, ['wait', id, '--max', '30'])
  assert.deepEqual([w.code, w.out.state, w.out.reason], [1, 'launch_failed', 'supervisor_not_started'])
  assert.ok(w.ms < 5000, `wait tardó ${w.ms} ms`)
  assert.equal(ownReservation(s.repo), undefined)
})
