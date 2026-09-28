import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { approve } from '../src/sdd/approve.ts'
import { readFlow } from '../src/sdd/read.ts'
import { SddError } from '../src/types.ts'
import { makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

const SPEC = '# Spec\n\n- **AC-1:** algo observable. (pedido)\n'
const plan = (status: string, depth = 'completa') => `---\nid: f\nprofundidad: ${depth}\nstatus: ${status}\n---\n\n# Plan\n\n## Enfoque\n\nDirecto.\n`
const TASKS = '# Tasks\n\n- [x] **T1 — primera** · cubre: AC-1\n- [ ] **T2 — segunda** · cubre: AC-1\n'
const handoff = (depth = 'completa') => `---\nphase: implementing\nprofundidad: ${depth}\nspec_approved_at: 2026-09-27T18:31:17-05:00\n---\n\n# Handoff\n`

interface Out { code: number | null; out: Record<string, any> }

/** Corre `sdd-ai sdd …` con un tope de 5 s: un comando que abre un FIFO para leer se cuelga y no llega a responder. */
function sdd(repo: string, ...args: string[]): Out {
  const r = spawnSync(BIN, ['sdd', ...args], { cwd: repo, encoding: 'utf8', timeout: 5000 })
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
  assert.deepEqual(plain.out.next, { step: 'implement', task: '**T2 — segunda** · cubre: AC-1' })
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
    const child = spawn(BIN, ['sdd', 'approve', 'f', gate], { cwd: repo })
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

  const spec = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(spec.code, 0, JSON.stringify(spec.out))
  assert.deepEqual(gateStates(spec.out), { spec: 'approved', plan: 'pending', tasks: 'pending' })
  assert.deepEqual(spec.out.next, { step: 'gate', gate: 'plan', artifacts: ['plan.md'] })
  const [first] = registry(dir).approvals
  assert.equal(registry(dir).schema_version, 1)
  assert.deepEqual(Object.keys(first), ['gate', 'depth', 'fingerprint', 'previous', 'at'])
  assert.equal(first.gate, 'spec')
  assert.equal(first.depth, 'completa')
  assert.match(first.fingerprint, FINGERPRINT)
  assert.deepEqual(first.previous, {})
  assert.ok(!Number.isNaN(Date.parse(first.at)))

  const plan = sdd(repo, 'approve', 'f', 'plan')
  assert.equal(plan.code, 0, JSON.stringify(plan.out))
  assert.deepEqual(gateStates(plan.out), { spec: 'approved', plan: 'approved', tasks: 'pending' })
  assert.ok(plan.out.notes.some((n: { code: string }) => n.code === 'header_behind'))
  const second = registry(dir).approvals[1]
  assert.equal(second.gate, 'plan')
  assert.deepEqual(second.previous, { spec: first.fingerprint })
  assert.deepEqual(sdd(repo, 'status', 'f').out, plan.out)

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
    const results = await Promise.all([approveAsync(repo, 'spec'), approveAsync(repo, 'plan')])
    const approved = results.filter((r) => r.code === 0)
    assert.ok(approved.length >= 1, JSON.stringify(results.map((r) => r.out)))
    for (const r of results.filter((r) => r.code !== 0)) assert.equal(r.out.code, 'approve_in_progress', JSON.stringify(r.out))
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
  assert.equal(dead.out.code, 'approve_in_progress')
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
  for (const gate of ['spec', 'plan', 'tasks']) assert.equal(sdd(repo, 'approve', 'f', gate).code, 0, gate)
  assert.deepEqual(gateStates(sdd(repo, 'status', 'f').out), { spec: 'approved', plan: 'approved', tasks: 'approved' })

  writeFileSync(join(dir, 'spec.md'), SPEC.replace('algo observable', 'algo más observable'))
  const edited = sdd(repo, 'status', 'f').out
  assert.deepEqual(gateStates(edited), { spec: 'stale', plan: 'stale', tasks: 'stale' })
  assert.deepEqual(edited.next, { step: 'gate', gate: 'spec', artifacts: ['spec.md'] })

  assert.equal(sdd(repo, 'approve', 'f', 'spec').code, 0)
  const reapproved = sdd(repo, 'status', 'f').out
  assert.deepEqual(gateStates(reapproved), { spec: 'approved', plan: 'stale', tasks: 'stale' })
  assert.deepEqual(reapproved.next, { step: 'gate', gate: 'plan', artifacts: ['plan.md'] })
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
  for (const gate of ['spec', 'plan-tasks']) assert.equal(sdd(repo, 'approve', 'f', gate).code, 0, gate)
  writeFileSync(join(normal, 'plan.md'), plan('implementing', 'normal'))
  writeFileSync(join(normal, 'tasks.md'), TASKS.replace('- [ ] **T2', '- [x] **T2'))
  assert.equal(gateStates(sdd(repo, 'status', 'f').out)['plan-tasks'], 'approved')
  writeFileSync(join(normal, 'tasks.md'), TASKS.replace('segunda', 'segunda, con otro paso'))
  assert.equal(gateStates(sdd(repo, 'status', 'f').out)['plan-tasks'], 'stale')

  const single = writeFlow(repo, 'c', { 'plan.md': corta('planned'), 'handoff.md': handoff('corta') })
  assert.equal(sdd(repo, 'approve', 'c', 'single').code, 0)
  writeFileSync(join(single, 'plan.md'), corta('implementing', undefined, '- [x] T1 — hacerlo\n- [ ] T2 — probarlo'))
  assert.deepEqual(gateStates(sdd(repo, 'status', 'c').out), { single: 'approved' })
  writeFileSync(join(single, 'plan.md'), corta('implementing', undefined, '- [x] T1 — hacerlo\n- [ ] T2 — probarlo dos veces'))
  assert.deepEqual(gateStates(sdd(repo, 'status', 'c').out), { single: 'stale' })
})
