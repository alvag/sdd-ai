import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { approve } from '../src/sdd/approve.ts'
import { readFlow } from '../src/sdd/read.ts'
import { SddError } from '../src/types.ts'
import { prove } from '../src/approval/proof.ts'
import { gateQuestionFor, renderForText } from '../src/approval/question.ts'
import { answerGate, askPair, codexItem, makeRepo, writeClaudeTranscript, writeCodexRollout } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

const SPEC = '# Spec\n\n- **AC-1:** algo observable. (pedido)\n'
const plan = (status: string, depth = 'completa') => `---\nid: f\nprofundidad: ${depth}\nstatus: ${status}\n---\n\n# Plan\n\n## Enfoque\n\nDirecto.\n`
const TASKS = '# Tasks\n\n- [x] **T1 — primera** · cubre: AC-1\n- [ ] **T2 — segunda** · cubre: AC-1\n'
const handoff = (depth = 'completa') => `---\nphase: implementing\nprofundidad: ${depth}\nspec_approved_at: 2026-09-27T18:31:17-05:00\n---\n\n# Handoff\n`

interface Out { code: number | null; out: Record<string, any> }

const sessions = new Map<string, Record<string, string>>()

/**
 * El entorno de una sesión de Claude Code de fixture, una por repo, con su transcript fuera del repo. Los
 * comandos no heredan la sesión real del proceso que corre los tests.
 */
function envOf(repo: string): Record<string, string> {
  let env = sessions.get(repo)
  if (env === undefined) {
    env = { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: outsideDir() }
    sessions.set(repo, env)
  }
  return env
}
const answer = (repo: string, id: string, gate: string) => answerGate(repo, envOf(repo), id, gate)

/** Corre `sdd-ai sdd …` con un tope de 5 s: un comando que abre un FIFO para leer se cuelga y no llega a responder. */
function sdd(repo: string, ...args: string[]): Out {
  const r = spawnSync(BIN, ['sdd', ...args], { cwd: repo, encoding: 'utf8', timeout: 5000, env: envOf(repo) })
  assert.equal(r.error, undefined, `sdd ${args.join(' ')}: ${String(r.error)}`)
  return { code: r.status, out: JSON.parse(r.stdout) }
}

function writeFlow(repo: string, id: string, files: Record<string, string>): string {
  const dir = join(repo, '.plans', id)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

const completa = (repo: string, id = 'f', status = 'implementing') =>
  writeFlow(repo, id, { 'spec.md': SPEC, 'plan.md': plan(status), 'tasks.md': TASKS, 'handoff.md': handoff() })
/** El árbol sin el `mtime` de los directorios: un lock temporal que se crea y se borra lo cambia y no cuenta como escritura. */
const files = (repo: string) => tree(repo).map((l) => (l.split(' ')[1] === 'd' ? l.split(' ').slice(0, 2).join(' ') : l))

/** Un flujo en el gate de la spec: sin plan, y con un handoff que todavía no la aprobó. */
const specOnly = (repo: string, id = 'f') =>
  writeFlow(repo, id, { 'spec.md': SPEC, 'handoff.md': '---\nprofundidad: completa\nspec_approved_at: null\n---\n\n# Handoff\n' })
const mkfifo = (path: string) => execFileSync('mkfifo', [path])
const outsideDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-outside-')))
const codes = (reasons: Array<{ code: string }>) => reasons.map((r) => r.code)

/** Cada ruta del repo con su tipo, tamaño y `mtime`, sin seguir enlaces. */
function tree(root: string, dir = root, acc: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    const st = lstatSync(p)
    acc.push(`${relative(root, p)} ${st.isDirectory() ? 'd' : 'f'} ${st.size} ${st.mtimeMs}`)
    if (st.isDirectory()) tree(root, p, acc)
  }
  return acc
}

test('sdd status lee el flujo sin escribir nada, no crea .sdd-ai y acepta --json', () => {
  const repo = makeRepo()
  completa(repo)
  const before = tree(repo)

  const plain = sdd(repo, 'status', 'f')
  const json = sdd(repo, 'status', 'f', '--json')
  const list = sdd(repo, 'status')
  assert.equal(plain.code, 0)
  assert.equal(json.code, 0)
  assert.equal(list.code, 0)
  assert.deepEqual(json.out, plain.out)
  assert.equal(plain.out.depth, 'completa')
  assert.deepEqual(plain.out.gates.map((g: { state: string }) => g.state), ['approved_unfingerprinted', 'approved_unfingerprinted', 'approved_unfingerprinted'])
  assert.deepEqual(plain.out.tasks, { total: 2, done: 1, pending: 1, first_pending: '**T2 — segunda** · cubre: AC-1' })
  // Con `.plans/` sin ignorar, el árbol está sucio: el writer de la fase no se lanza y el next dice por qué.
  const { detail, ...next } = plain.out.next
  assert.deepEqual(next, { step: 'implement', task: '**T2 — segunda** · cubre: AC-1' })
  assert.match(detail, /cambios sin commitear/)
  assert.equal(plain.out.paths.spec, '.plans/f/spec.md')
  assert.deepEqual(list.out.flows.map((f: { id: string }) => f.id), ['f'])

  assert.deepEqual(tree(repo), before)
  assert.equal(existsSync(join(repo, '.sdd-ai')), false)
})

test('un id inválido, de más de 128 caracteres o con enlaces simbólicos se rechaza con código 2 sin leer, y un flujo inexistente sale con 1', () => {
  const repo = makeRepo()
  completa(repo)
  const outside = outsideDir()

  // Cada id inválido apunta a un FIFO: leerlo colgaría el comando.
  mkdirSync(join(repo, '.plans', 'sub', 'x'), { recursive: true })
  mkfifo(join(repo, '.plans', 'sub', 'x', 'spec.md'))
  mkfifo(join(repo, '.plans', 'spec.md'))
  mkfifo(join(repo, 'spec.md'))
  for (const id of ['sub/x', '.', '..', 'a b', 'ñ', 'x'.repeat(129)]) {
    for (const args of [['status', id], ['approve', id, 'spec']]) {
      const r = sdd(repo, ...args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${JSON.stringify(r.out)}`)
      assert.equal(r.out.code, 'usage')
    }
  }

  // El flujo es un enlace a un directorio de afuera; spec.md enlaza a un FIFO o a un archivo regular de afuera.
  mkdirSync(join(outside, 'flow'))
  mkfifo(join(outside, 'flow', 'spec.md'))
  symlinkSync(join(outside, 'flow'), join(repo, '.plans', 'linked'))
  mkfifo(join(outside, 'fifo'))
  symlinkSync(join(outside, 'fifo'), join(writeFlow(repo, 'specfifo', { 'plan.md': plan('planned'), 'handoff.md': handoff() }), 'spec.md'))
  writeFileSync(join(outside, 'spec.md'), SPEC)
  symlinkSync(join(outside, 'spec.md'), join(writeFlow(repo, 'specfile', { 'plan.md': plan('planned'), 'handoff.md': handoff() }), 'spec.md'))
  // Un enlace a otro flujo de `.plans/` no sale del repo, y se rechaza igual: cada flujo tiene una sola identidad.
  symlinkSync(join(repo, '.plans', 'f'), join(repo, '.plans', 'alias'))
  for (const id of ['linked', 'alias', 'specfifo', 'specfile']) {
    const r = sdd(repo, 'status', id)
    assert.equal(r.code, 2, id)
    assert.equal(r.out.code, 'path_invalid', id)
  }

  // `.plans/` entero es un enlace.
  const other = makeRepo()
  mkdirSync(join(outside, 'plans', 'f'), { recursive: true })
  mkfifo(join(outside, 'plans', 'f', 'spec.md'))
  symlinkSync(join(outside, 'plans'), join(other, '.plans'))
  const linkedPlans = sdd(other, 'status', 'f')
  assert.equal(linkedPlans.code, 2)
  assert.equal(linkedPlans.out.code, 'path_invalid')

  for (const r of [sdd(repo, 'status', 'nope'), sdd(makeRepo(), 'status', 'nope')]) {
    assert.equal(r.code, 1)
    assert.equal(r.out.code, 'flow_not_found')
    assert.match(r.out.next, /\/sdd-flow/)
    assert.match(r.out.next, /\$sdd-flow/)
  }
})

test('sin id lista los directorios de .plans con el mismo next, y aísla los rotos, los enlaces y los ids inválidos', () => {
  const repo = makeRepo()
  completa(repo, 'ok')
  writeFlow(repo, 'estudios', { 'notas.md': '# Notas\n' })
  mkfifo(join(writeFlow(repo, 'fifo', { 'plan.md': plan('planned'), 'handoff.md': handoff() }), 'spec.md'))
  const outside = outsideDir()
  writeFileSync(join(outside, 'spec.md'), SPEC)
  symlinkSync(outside, join(repo, '.plans', 'link'))
  mkdirSync(join(repo, '.plans', 'x'.repeat(129)))
  completa(repo, join('archived', 'viejo'))
  writeFileSync(join(repo, '.plans', 'hallazgos.md'), '# Hallazgos\n')

  const r = sdd(repo, 'status')
  assert.equal(r.code, 0)
  const flows = Object.fromEntries(r.out.flows.map((f: { id: string }) => [f.id, f]))
  assert.deepEqual(Object.keys(flows), ['estudios', 'fifo', 'link', 'ok', 'x'.repeat(129)])
  for (const f of r.out.flows) assert.deepEqual(Object.keys(f), ['id', 'depth', 'next', 'blocked', 'blocked_reasons'])

  assert.deepEqual(flows.estudios.next, { step: 'no_artifacts' })
  assert.equal(flows.estudios.blocked, false)
  assert.deepEqual(codes(flows.fifo.blocked_reasons), ['artifact_unreadable'])
  assert.deepEqual(codes(flows.link.blocked_reasons), ['path_invalid'])
  assert.deepEqual(codes(flows['x'.repeat(129)].blocked_reasons), ['id_invalid'])
  for (const id of ['fifo', 'link', 'x'.repeat(129)]) {
    assert.equal(flows[id].blocked, true, id)
    assert.deepEqual(flows[id].next, { step: 'resolve_blockers' }, id)
  }
  assert.equal(flows.ok.depth, 'completa')
  for (const id of ['estudios', 'fifo', 'ok']) assert.deepEqual(flows[id].next, sdd(repo, 'status', id).out.next, id)

  const empty = sdd(makeRepo(), 'status')
  assert.equal(empty.code, 0)
  assert.deepEqual(empty.out, { flows: [] })
})

test('un directorio que solo tiene un registro corrupto está bloqueado y no en no_artifacts', () => {
  const repo = makeRepo()
  writeFlow(repo, 'solo', { 'sdd-ai-approvals.json': '{' })
  const r = sdd(repo, 'status', 'solo')
  assert.equal(r.code, 0)
  assert.deepEqual(codes(r.out.blocked_reasons), ['approvals_invalid'])
  assert.deepEqual(r.out.next, { step: 'resolve_blockers' })
})

test('un archivo regular que no se puede leer bloquea con artifact_unreadable, y el registro con approvals_invalid', (t) => {
  const repo = makeRepo()
  const dir = completa(repo)
  writeFileSync(join(dir, 'sdd-ai-approvals.json'), '{"schema_version":1,"approvals":[]}\n')
  const locked = [join(dir, 'spec.md'), join(dir, 'sdd-ai-approvals.json')]
  for (const p of locked) chmodSync(p, 0o000)
  try {
    try {
      readFileSync(locked[0])
      t.skip('el runner lee un archivo con permisos 000: corre como root')
      return
    } catch {
      // Lo esperado: la lectura falla.
    }
    const r = sdd(repo, 'status', 'f')
    assert.equal(r.code, 0)
    assert.deepEqual(codes(r.out.blocked_reasons).sort(), ['approvals_invalid', 'artifact_unreadable'])
    assert.deepEqual(r.out.next, { step: 'resolve_blockers' })
  } finally {
    for (const p of locked) chmodSync(p, 0o644)
  }
})

test('un plan o un handoff sin header, sin cierre o con claves duplicadas bloquean con header_invalid', () => {
  const repo = makeRepo()
  const cases: Record<string, Record<string, string>> = {
    'sin-header': { 'plan.md': '# Plan\n\nsin header\n' },
    'sin-cierre': { 'plan.md': '---\nprofundidad: completa\nstatus: planned\n\n# Plan\n' },
    duplicada: { 'handoff.md': '---\nprofundidad: completa\nprofundidad: normal\n---\n\n# Handoff\n' },
  }
  for (const [id, files] of Object.entries(cases)) {
    writeFlow(repo, id, { 'spec.md': SPEC, 'plan.md': plan('planned'), 'tasks.md': TASKS, 'handoff.md': handoff(), ...files })
    const r = sdd(repo, 'status', id)
    assert.equal(r.code, 0, id)
    assert.ok(codes(r.out.blocked_reasons).includes('header_invalid'), `${id}: ${JSON.stringify(r.out.blocked_reasons)}`)
    assert.deepEqual(r.out.next, { step: 'resolve_blockers' }, id)
  }
})

const REGISTRY = 'sdd-ai-approvals.json'
const LOCK = 'sdd-ai-approvals.lock'
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const registry = (dir: string) => JSON.parse(readFileSync(join(dir, REGISTRY), 'utf8'))
const gateStates = (out: Record<string, any>) => Object.fromEntries(out.gates.map((g: { gate: string; state: string }) => [g.gate, g.state]))
const corta = (status: string, spec = '- AC-1: algo observable.', tasks = '- [ ] T1 — hacerlo\n- [ ] T2 — probarlo') =>
  `---\nid: c\nprofundidad: corta\nstatus: ${status}\n---\n\n# Plan\n\n## Spec\n\n${spec}\n\n## Enfoque\n\nDirecto.\n\n## Tasks\n\n${tasks}\n`

/** Lanza `sdd approve` sin esperar: dos de estos compiten por el mismo flujo. */
function approveAsync(repo: string, gate: string): Promise<Out> {
  return new Promise((done) => {
    const child = spawn(BIN, ['sdd', 'approve', 'f', gate], { cwd: repo, env: envOf(repo) })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.on('close', (code) => done({ code, out: JSON.parse(stdout) }))
  })
}

test('approve registra el gate con su huella y las de los anteriores y responde el estado nuevo', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  const artifacts = ['spec.md', 'plan.md', 'tasks.md', 'handoff.md']
  const before = artifacts.map((n) => `${readFileSync(join(dir, n), 'utf8')} ${lstatSync(join(dir, n)).mtimeMs}`)

  answer(repo, 'f', 'spec')
  const spec = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(spec.code, 0, JSON.stringify(spec.out))
  assert.deepEqual(gateStates(spec.out), { spec: 'approved', plan: 'pending', tasks: 'pending' })
  assert.deepEqual(spec.out.next, { step: 'gate', gate: 'plan', artifacts: ['plan.md'] })
  const [first] = registry(dir).approvals
  assert.equal(registry(dir).schema_version, 1)
  assert.deepEqual(Object.keys(first), ['gate', 'depth', 'fingerprint', 'previous', 'at', 'proof'])
  assert.equal(first.gate, 'spec')
  assert.equal(first.depth, 'completa')
  assert.match(first.fingerprint, FINGERPRINT)
  assert.deepEqual(first.previous, {})
  assert.ok(!Number.isNaN(Date.parse(first.at)))

  answer(repo, 'f', 'plan')
  const plan = sdd(repo, 'approve', 'f', 'plan')
  assert.equal(plan.code, 0, JSON.stringify(plan.out))
  assert.deepEqual(gateStates(plan.out), { spec: 'approved', plan: 'approved', tasks: 'pending' })
  assert.ok(plan.out.notes.some((n: { code: string }) => n.code === 'header_behind'))
  const second = registry(dir).approvals[1]
  assert.equal(second.gate, 'plan')
  assert.deepEqual(second.previous, { spec: first.fingerprint })
  // Solo `status` trae la pregunta del gate siguiente.
  const { question, ...next } = sdd(repo, 'status', 'f').out.next
  assert.equal(typeof question?.question, 'string')
  assert.deepEqual({ ...sdd(repo, 'status', 'f').out, next }, plan.out)

  assert.deepEqual(artifacts.map((n) => `${readFileSync(join(dir, n), 'utf8')} ${lstatSync(join(dir, n)).mtimeMs}`), before)
  assert.equal(existsSync(join(dir, LOCK)), false)
})

test('approve rechaza sin escribir un gate inexistente, un artefacto faltante, tasks vacías, un gate anterior pendiente o un flujo bloqueado', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  const noTasks = writeFlow(repo, 'sin-tasks', { 'spec.md': SPEC, 'plan.md': plan('plan-approved'), 'handoff.md': handoff() })
  const prose = writeFlow(repo, 'prosa', { 'spec.md': SPEC, 'plan.md': plan('plan-approved'), 'tasks.md': '# Tasks\n\nTodavía sin tasks.\n', 'handoff.md': handoff() })
  const blocked = writeFlow(repo, 'bloqueado', { 'spec.md': SPEC, 'plan.md': plan('revisado'), 'tasks.md': TASKS, 'handoff.md': handoff() })
  const cases: Array<[string, string, string, string]> = [
    ['f', 'foo', 'gate_invalid', dir],
    ['f', 'single', 'gate_invalid', dir],
    ['sin-tasks', 'tasks', 'approve_rejected', noTasks],
    ['prosa', 'tasks', 'approve_rejected', prose],
    ['f', 'tasks', 'approve_rejected', dir],
    ['bloqueado', 'spec', 'approve_rejected', blocked],
  ]
  for (const [id, gate, code, flow] of cases) {
    const r = sdd(repo, 'approve', id, gate)
    assert.equal(r.code, 2, `${id} ${gate}`)
    assert.equal(r.out.code, code, `${id} ${gate}: ${JSON.stringify(r.out)}`)
    assert.notEqual(r.out.message, '')
    assert.equal(existsSync(join(flow, REGISTRY)), false, `${id} ${gate}`)
  }
})

test('un approve rechazado deja el directorio del flujo igual, sin lock ni registro', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  writeFlow(repo, 'bloqueado', { 'spec.md': SPEC, 'plan.md': plan('revisado'), 'tasks.md': TASKS, 'handoff.md': handoff() })
  const before = tree(repo)
  for (const [id, gate] of [['f', 'foo'], ['f', 'tasks'], ['bloqueado', 'spec']]) assert.equal(sdd(repo, 'approve', id, gate).code, 2)
  assert.deepEqual(tree(repo), before)
  assert.equal(existsSync(join(dir, LOCK)), false)
  assert.equal(existsSync(join(dir, REGISTRY)), false)
})

test('approve no registra si los artefactos cambian entre las dos lecturas', () => {
  const variants: Array<[string, (dir: string) => void]> = [
    ['spec', (dir) => appendFileSync(join(dir, 'spec.md'), '- **AC-2:** otra cosa. (pedido)\n')],
    ['plan', (dir) => writeFileSync(join(dir, 'plan.md'), plan('plan-approved'))],
  ]
  for (const [gate, change] of variants) {
    const repo = makeRepo()
    const dir = completa(repo, 'f', 'planned')
    let calls = 0
    const read: typeof readFlow = (root, id) => {
      calls++
      if (calls === 3) change(dir)
      return readFlow(root, id)
    }
    assert.throws(() => approve(repo, 'f', gate, new Date(), read), (e: unknown) => e instanceof SddError && e.code === 'artifacts_unstable')
    assert.equal(calls, 3)
    assert.equal(existsSync(join(dir, REGISTRY)), false, gate)
    assert.equal(existsSync(join(dir, LOCK)), false, gate)
  }
})

test('dos approve concurrentes sobre el mismo flujo no pierden entradas: uno registra y el otro se rechaza o registra después', async () => {
  for (let i = 0; i < 3; i++) {
    const repo = makeRepo()
    const dir = completa(repo, 'f', 'plan-approved')
    answer(repo, 'f', 'spec')
    answer(repo, 'f', 'plan')
    const results = await Promise.all([approveAsync(repo, 'spec'), approveAsync(repo, 'plan')])
    const approved = results.filter((r) => r.code === 0)
    assert.ok(approved.length >= 1, JSON.stringify(results.map((r) => r.out)))
    for (const r of results.filter((r) => r.code !== 0)) assert.equal(r.out.code, 'flow_busy', JSON.stringify(r.out))
    const gates = registry(dir).approvals.map((a: { gate: string }) => a.gate).sort()
    assert.deepEqual(gates, ['spec', 'plan'].filter((_, k) => results[k].code === 0).sort())
    assert.equal(existsSync(join(dir, LOCK)), false)
  }
})

test('un lock existente, también de un proceso muerto o que sea un enlace, rechaza approve sin leerlo ni reemplazarlo', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  writeFileSync(join(dir, LOCK), '999999\n')
  const dead = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(dead.code, 2)
  assert.equal(dead.out.code, 'flow_busy')
  assert.match(dead.out.next, new RegExp(LOCK.replaceAll('.', '\\.')))
  assert.equal(readFileSync(join(dir, LOCK), 'utf8'), '999999\n')
  assert.equal(existsSync(join(dir, REGISTRY)), false)

  const other = makeRepo()
  const linked = completa(other, 'f', 'planned')
  const outside = outsideDir()
  mkfifo(join(outside, 'lock'))
  symlinkSync(join(outside, 'lock'), join(linked, LOCK))
  const link = sdd(other, 'approve', 'f', 'spec')
  assert.equal(link.code, 2)
  assert.equal(link.out.code, 'path_invalid')
  assert.equal(readlinkSync(join(linked, LOCK)), join(outside, 'lock'))
  assert.equal(existsSync(join(linked, REGISTRY)), false)
})

const LOCK_TS = join(import.meta.dirname, '..', 'src', 'lock.ts')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Espera una línea de `stdout` de un hijo que empiece con `prefix`. */
function lineFrom(child: ReturnType<typeof spawn>, prefix: string): Promise<string> {
  return new Promise((done, fail) => {
    let buf = ''
    const on = (b: Buffer) => {
      buf += b.toString('utf8')
      const line = buf.split('\n').find((l) => l.startsWith(prefix))
      if (line !== undefined) {
        child.stdout?.off('data', on)
        done(line)
      }
    }
    child.stdout?.on('data', on)
    child.on('close', () => fail(new Error(`el hijo terminó sin escribir ${prefix}: ${buf}`)))
  })
}

test('un lock de un proceso muerto o reciclado, o sin lstart como los de 5a, rechaza enseguida sin robarlo', () => {
  const locks = [
    `${JSON.stringify({ pid: 999999, lstart: 'Mon Sep 28 10:00:00 2026' })}\n`,
    `${JSON.stringify({ pid: process.pid, lstart: 'Thu Jan  1 00:00:00 2001' })}\n`,
    '999999\n',
  ]
  for (const content of locks) {
    const repo = makeRepo()
    const dir = completa(repo, 'f', 'planned')
    writeFileSync(join(dir, LOCK), content)
    const started = Date.now()
    const r = sdd(repo, 'approve', 'f', 'spec')
    assert.ok(Date.now() - started < 4000, content)
    assert.equal(r.code, 2, content)
    assert.equal(r.out.code, 'flow_busy', `${content}: ${JSON.stringify(r.out)}`)
    assert.equal(readFileSync(join(dir, LOCK), 'utf8'), content)
    assert.equal(existsSync(join(dir, REGISTRY)), false)
  }
})

test('el lock nace completo: un competidor nunca lo ve vacío', async () => {
  const { withLock } = await import('../src/lock.ts')
  const dir = outsideDir()
  const lock = join(dir, 'x.lock')
  const seen = join(dir, 'visto')
  const stop = join(dir, 'fin')
  const probe = `const fs = require('fs'); const [lock, seen, stop] = process.argv.slice(1)
let complete = 0, empty = 0, partial = 0, flagged = false
process.stdout.write('listo\\n')
while (!fs.existsSync(stop)) {
  let t
  try { t = fs.readFileSync(lock, 'utf8') } catch { continue }
  if (t === '') empty++
  else { try { const v = JSON.parse(t); if (typeof v.pid === 'number') complete++; else partial++ } catch { partial++ } }
  if (complete > 0 && !flagged) { fs.writeFileSync(seen, ''); flagged = true }
}
process.stdout.write(JSON.stringify({ complete, empty, partial }) + '\\n')`
  const child = spawn(process.execPath, ['-e', probe, lock, seen, stop])
  await lineFrom(child, 'listo')
  const busy = () => new SddError('busy', 'ocupado')
  withLock(lock, busy, () => {
    const until = Date.now() + 5000
    while (!existsSync(seen) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  })
  for (let i = 0; i < 200; i++) withLock(lock, busy, () => undefined)
  const report = lineFrom(child, '{')
  writeFileSync(stop, '')
  const counts = JSON.parse(await report)
  assert.deepEqual({ empty: counts.empty, partial: counts.partial }, { empty: 0, partial: 0 })
  assert.ok(counts.complete >= 1, JSON.stringify(counts))
})

test('con un titular vivo que retiene el lock, el segundo comando espera y registra al soltarse', async () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  const release = join(outsideDir(), 'soltar')
  const holder = `import { withLock } from ${JSON.stringify(LOCK_TS)}
import { existsSync } from 'node:fs'
const [lock, release] = process.argv.slice(1)
withLock(lock, () => new Error('ocupado'), () => {
  process.stdout.write('tomado\\n')
  while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
})`
  const child = spawn(process.execPath, ['--input-type=module', '-e', holder, join(dir, LOCK), release])
  let r: Out
  try {
    await lineFrom(child, 'tomado')
    let finished = false
    answer(repo, 'f', 'spec')
    const second = approveAsync(repo, 'spec').then((x) => { finished = true; return x })
    await wait(800)
    assert.equal(finished, false)
    assert.equal(existsSync(join(dir, REGISTRY)), false)
    writeFileSync(release, '')
    r = await second
  } finally {
    writeFileSync(release, '')
    child.kill()
  }
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual(registry(dir).approvals.map((a: { gate: string }) => a.gate), ['spec'])
  assert.equal(existsSync(join(dir, LOCK)), false)
})

test('un registro corrupto, uno que parsea pero no cumple el esquema (un gate de otra profundidad, anteriores incompletos) o un artefacto ilegible bloquean status y approve los rechaza', () => {
  const repo = makeRepo()
  const fp = `sha256:${'a'.repeat(64)}`
  const entry = (gate: string, previous: Record<string, string>) => ({ gate, depth: 'completa', fingerprint: fp, previous, at: '2026-09-28T10:00:00.000Z' })
  const registries: Record<string, string> = {
    corrupto: '{"schema_version": 1, "approvals": [',
    'otra-profundidad': JSON.stringify({ schema_version: 1, approvals: [entry('single', { spec: fp, plan: fp })] }),
    incompletos: JSON.stringify({ schema_version: 1, approvals: [entry('tasks', { spec: fp })] }),
    'sin-version': JSON.stringify({ approvals: [] }),
  }
  for (const [id, text] of Object.entries(registries)) {
    const dir = completa(repo, id, 'planned')
    writeFileSync(join(dir, REGISTRY), text)
    const status = sdd(repo, 'status', id)
    assert.deepEqual(codes(status.out.blocked_reasons), ['approvals_invalid'], id)
    const r = sdd(repo, 'approve', id, 'spec')
    assert.equal(r.code, 2, id)
    assert.equal(r.out.code, 'approve_rejected', id)
    assert.equal(readFileSync(join(dir, REGISTRY), 'utf8'), text, id)
  }
  const fifo = writeFlow(repo, 'ilegible', { 'plan.md': plan('planned'), 'tasks.md': TASKS, 'handoff.md': handoff() })
  mkfifo(join(fifo, 'spec.md'))
  assert.deepEqual(codes(sdd(repo, 'status', 'ilegible').out.blocked_reasons), ['artifact_unreadable'])
  const r = sdd(repo, 'approve', 'ilegible', 'spec')
  assert.equal(r.out.code, 'approve_rejected')
  assert.equal(existsSync(join(fifo, REGISTRY)), false)
})

test('editar la spec aprobada la devuelve a su gate y reaprobarla deja vencidos plan y tasks', () => {
  const repo = makeRepo()
  const dir = completa(repo)
  for (const gate of ['spec', 'plan', 'tasks']) {
    answer(repo, 'f', gate)
    assert.equal(sdd(repo, 'approve', 'f', gate).code, 0, gate)
  }
  assert.deepEqual(gateStates(sdd(repo, 'status', 'f').out), { spec: 'approved', plan: 'approved', tasks: 'approved' })

  writeFileSync(join(dir, 'spec.md'), SPEC.replace('algo observable', 'algo más observable'))
  const edited = sdd(repo, 'status', 'f').out
  assert.deepEqual(gateStates(edited), { spec: 'stale', plan: 'stale', tasks: 'stale' })
  assert.deepEqual({ ...edited.next, question: undefined }, { step: 'gate', gate: 'spec', artifacts: ['spec.md'], question: undefined })

  answer(repo, 'f', 'spec')
  assert.equal(sdd(repo, 'approve', 'f', 'spec').code, 0)
  const reapproved = sdd(repo, 'status', 'f').out
  assert.deepEqual(gateStates(reapproved), { spec: 'approved', plan: 'stale', tasks: 'stale' })
  assert.deepEqual({ ...reapproved.next, question: undefined }, { step: 'gate', gate: 'plan', artifacts: ['plan.md'], question: undefined })
})

test('approve single rechaza una sección Spec o Tasks vacía', () => {
  const repo = makeRepo()
  for (const [id, text] of [['sin-spec', corta('planned', '')], ['sin-tasks', corta('planned', undefined, '')]]) {
    const dir = writeFlow(repo, id, { 'plan.md': text, 'handoff.md': handoff('corta') })
    const r = sdd(repo, 'approve', id, 'single')
    assert.equal(r.code, 2, id)
    assert.equal(r.out.code, 'approve_rejected', id)
    assert.equal(existsSync(join(dir, REGISTRY)), false, id)
  }
})

test('tras approve, los cambios inocuos no vencen plan-tasks ni single y los sustantivos sí', () => {
  const repo = makeRepo()
  const normal = writeFlow(repo, 'f', { 'spec.md': SPEC, 'plan.md': plan('planned', 'normal'), 'tasks.md': TASKS, 'handoff.md': handoff('normal') })
  for (const gate of ['spec', 'plan-tasks']) {
    answer(repo, 'f', gate)
    assert.equal(sdd(repo, 'approve', 'f', gate).code, 0, gate)
  }
  writeFileSync(join(normal, 'plan.md'), plan('implementing', 'normal'))
  writeFileSync(join(normal, 'tasks.md'), TASKS.replace('- [ ] **T2', '- [x] **T2'))
  assert.equal(gateStates(sdd(repo, 'status', 'f').out)['plan-tasks'], 'approved')
  writeFileSync(join(normal, 'tasks.md'), TASKS.replace('segunda', 'segunda, con otro paso'))
  assert.equal(gateStates(sdd(repo, 'status', 'f').out)['plan-tasks'], 'stale')

  const single = writeFlow(repo, 'c', { 'plan.md': corta('planned'), 'handoff.md': handoff('corta') })
  answer(repo, 'c', 'single')
  assert.equal(sdd(repo, 'approve', 'c', 'single').code, 0)
  writeFileSync(join(single, 'plan.md'), corta('implementing', undefined, '- [x] T1 — hacerlo\n- [ ] T2 — probarlo'))
  assert.deepEqual(gateStates(sdd(repo, 'status', 'c').out), { single: 'approved' })
  writeFileSync(join(single, 'plan.md'), corta('implementing', undefined, '- [x] T1 — hacerlo\n- [ ] T2 — probarlo dos veces'))
  assert.deepEqual(gateStates(sdd(repo, 'status', 'c').out), { single: 'stale' })
})

test('approve exige la respuesta del usuario y sin ella no escribe nada', () => {
  const repo = makeRepo()
  const dir = specOnly(repo)
  const before = files(repo)
  const question = sdd(repo, 'status', 'f').out.next.question
  const missing = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(missing.code, 2)
  assert.equal(missing.out.code, 'approval_missing', JSON.stringify(missing.out))
  assert.ok(missing.out.next.includes(question.question), missing.out.next)
  answerGate(repo, envOf(repo), 'f', 'spec', 'No aprobar')
  const contradicted = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(contradicted.out.code, 'approval_contradicted', JSON.stringify(contradicted.out))
  assert.deepEqual(files(repo), before)
  assert.equal(existsSync(join(dir, LOCK)), false)
})

test('approve con el entorno de un worker rechaza con runner_required', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  answer(repo, 'f', 'spec')
  const r = spawnSync(BIN, ['sdd', 'approve', 'f', 'spec'], { cwd: repo, encoding: 'utf8', timeout: 5000, env: { ...envOf(repo), SDD_AI_WORKER: '1' } })
  const out = JSON.parse(r.stdout)
  assert.equal(r.status, 2)
  assert.equal(out.code, 'runner_required')
  assert.match(out.next, /usuario/)
  assert.equal(existsSync(join(dir, REGISTRY)), false)
})

test('sdd approve --conductor elige la sesión cuando están las dos señales', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  const codexHome = outsideDir()
  const env = { ...envOf(repo), CODEX_THREAD_ID: 't-1', CODEX_SESSION_ID: 'c-1', CODEX_HOME: codexHome }
  const { facts } = readFlow(repo, 'f')
  const q = gateQuestionFor('f', 'completa', 'spec', facts.fingerprints)
  writeCodexRollout(codexHome, 'c-1', [codexItem('AgentMessage', renderForText(q)), codexItem('UserMessage', 'Aprobar', { id: 'um-1' })])
  const run = (...extra: string[]) => {
    const r = spawnSync(BIN, ['sdd', 'approve', 'f', 'spec', ...extra], { cwd: repo, encoding: 'utf8', timeout: 5000, env })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  assert.equal(run().out.code, 'conductor_unknown')
  assert.equal(run('--conductor', 'claude').out.code, 'approval_missing')
  assert.equal(existsSync(join(dir, REGISTRY)), false)
  assert.equal(run('--conductor', 'codex').code, 0)
  assert.deepEqual(registry(dir).approvals[0].proof, { runner: 'codex', source: 'rollout_message', ref: 'um-1', session: 'c-1', answered_at: '2026-09-28T12:00:00.000Z' })
})

test('sdd status trae next.question en el paso gate', () => {
  const repo = makeRepo()
  specOnly(repo)
  const out = sdd(repo, 'status', 'f').out
  assert.deepEqual(out.next.question, gateQuestionFor('f', 'completa', 'spec', readFlow(repo, 'f').facts.fingerprints))
  assert.deepEqual(Object.keys(out.next), ['step', 'gate', 'artifacts', 'question'])
  const other = makeRepo()
  completa(other, 'f', 'implementing')
  assert.equal('question' in sdd(other, 'status', 'f').out.next, false)
})

test('una respuesta posterior a la lectura, también una que llega antes de la escritura, no revoca la decisión', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  const env = envOf(repo)
  const q = answer(repo, 'f', 'spec')
  const late: typeof prove = (o) => {
    const proof = prove(o)
    writeClaudeTranscript(env.CLAUDE_CONFIG_DIR, env.CLAUDE_CODE_SESSION_ID, askPair(env.CLAUDE_CODE_SESSION_ID, 'tu-late', q, 'No aprobar'))
    return proof
  }
  approve(repo, 'f', 'spec', new Date(), readFlow, late, env)
  const [entry] = registry(dir).approvals
  assert.equal(entry.gate, 'spec')
  assert.notEqual(entry.proof.ref.split(':')[0], 'tu-late')
  assert.throws(() => approve(repo, 'f', 'spec', new Date(), readFlow, prove, env), (e: unknown) => e instanceof SddError && e.code === 'approval_contradicted')
})

test('una respuesta a la huella anterior no aprueba la actual', () => {
  const repo = makeRepo()
  const dir = specOnly(repo)
  answer(repo, 'f', 'spec')
  writeFileSync(join(dir, 'spec.md'), SPEC.replace('algo observable', 'algo distinto'))
  const fresh = sdd(repo, 'status', 'f').out.next.question
  const r = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(r.out.code, 'approval_missing', JSON.stringify(r.out))
  assert.ok(r.out.next.includes(fresh.question))
  assert.equal(existsSync(join(dir, REGISTRY)), false)
})

test('una prueba usada rechaza con approval_reused', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  answer(repo, 'f', 'spec')
  assert.equal(sdd(repo, 'approve', 'f', 'spec').code, 0)
  writeFileSync(join(dir, 'spec.md'), SPEC.replace('algo observable', 'algo distinto'))
  assert.equal(gateStates(sdd(repo, 'status', 'f').out).spec, 'stale')
  writeFileSync(join(dir, 'spec.md'), SPEC)
  const r = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(r.out.code, 'approval_reused', JSON.stringify(r.out))
  assert.equal(registry(dir).approvals.length, 1)
})

test('la entrada registrada trae proof con runner, source, ref, session y answered_at', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  answer(repo, 'f', 'spec')
  assert.equal(sdd(repo, 'approve', 'f', 'spec').code, 0)
  const { proof } = registry(dir).approvals[0]
  assert.deepEqual(Object.keys(proof), ['runner', 'source', 'ref', 'session', 'answered_at'])
  assert.deepEqual({ runner: proof.runner, source: proof.source, session: proof.session },
    { runner: 'claude', source: 'ask_user_question', session: envOf(repo).CLAUDE_CODE_SESSION_ID })
  assert.match(proof.ref, /^tu-[0-9a-f]+:[0-9a-f]{16}$/)

  // Un registro de 5a, sin proof, se sigue leyendo; uno con una prueba incompleta no sirve.
  const old = completa(repo, 'viejo', 'planned')
  const { proof: _, ...legacy } = registry(dir).approvals[0]
  writeFileSync(join(old, REGISTRY), JSON.stringify({ schema_version: 1, approvals: [legacy] }))
  const status = sdd(repo, 'status', 'viejo').out
  assert.equal(gateStates(status).spec, 'approved')
  assert.deepEqual(codes(status.blocked_reasons), [])
  const broken = completa(repo, 'roto', 'planned')
  writeFileSync(join(broken, REGISTRY), JSON.stringify({ schema_version: 1, approvals: [{ ...legacy, proof: { ...proof, ref: '' } }] }))
  assert.deepEqual(codes(sdd(repo, 'status', 'roto').out.blocked_reasons), ['approvals_invalid'])
})
