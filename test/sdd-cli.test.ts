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
/** La fecha que trae el handoff de los fixtures; `approve` la reemplaza por el `at` de la aprobación registrada. */
const HANDOFF_SPEC_APPROVED_AT = '2026-09-27T18:31:17-05:00'
const handoff = (depth = 'completa') => `---\nphase: implementing\nprofundidad: ${depth}\nspec_approved_at: ${HANDOFF_SPEC_APPROVED_AT}\n---\n\n# Handoff\n`

interface Out { code: number | null; out: Record<string, any> }

const sessions = new Map<string, Record<string, string>>()

/**
 * El entorno de una sesión de Claude Code de fixture, una por repo, con su transcript fuera del repo. Los
 * comandos no heredan la sesión real del proceso que corre los tests.
 */
function envOf(repo: string): Record<string, string> {
  let env = sessions.get(repo)
  if (env === undefined) {
    env = { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: outsideDir(), SDD_AI_PROJECTION: 'off' }
    sessions.set(repo, env)
  }
  return env
}
const answer = (repo: string, id: string, gate: string) => answerGate(repo, envOf(repo), id, gate)

/** Corre `sdd-ai sdd …` con un tope de 5 s: un comando que abre un FIFO para leer se cuelga y no llega a responder. */
function sdd(repo: string, ...args: string[]): Out {
  const r = spawnSync(process.execPath, [BIN, 'sdd', ...args], { cwd: repo, encoding: 'utf8', timeout: 5000, env: envOf(repo) })
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

// Catálogo independiente del productor: un cambio accidental en STEPS no cambia lo esperado.
const statusSteps = ['no_artifacts', 'depth', 'specify', 'branch', 'plan', 'tasks', 'gate', 'external_gate',
  'implement', 'verify', 'review_and_commit', 'push', 'open_pr', 'archive', 'resolve_blockers'] as const
const stepArgs = (step: string): string[][] => [['--step', step], [`--step=${step}`]]
const statusList = (repo: string) => {
  const result = sdd(repo, 'status')
  assert.equal(result.code, 0, JSON.stringify(result.out))
  return result.out.flows as Array<Record<string, any>>
}
const selectedStatus = (repo: string, flows: Array<Record<string, any>>, step: string, ...args: string[]) => {
  const result = sdd(repo, 'status', ...args)
  assert.equal(result.code, 0, JSON.stringify(result.out))
  const expected = flows.filter((entry) => entry.next.step === step)
  assert.deepEqual(result.out, { flows: expected })
  assert.deepEqual(result.out.flows.map((entry: Record<string, any>) => entry.id), expected.map((entry) => entry.id))
  return result
}
const usageStatus = (repo: string, args: string[]) => {
  const result = sdd(repo, 'status', ...args)
  assert.equal(result.code, 2, JSON.stringify(result.out))
  assert.equal(result.out.state, 'error')
  assert.equal(result.out.code, 'usage')
  return result.out.message as string
}
const phaseFixture = (repo: string, id: string, record: Record<string, unknown>) =>
  writeFileSync(join(repo, '.plans', id, 'sdd-ai-phases.json'), JSON.stringify(record))
const emptyPhaseFixture = () => ({ schema_version: 1, last_run: null, phases: {} })
const planFixture = (repo: string, id: string) => writeFlow(repo, id, {
  'spec.md': SPEC, 'handoff.md': handoff().replace('phase: implementing', `phase: implementing\nbranch: feature/${id}`),
})

test('sdd status --step admite los quince pasos y ambas sintaxis con y sin --json', () => {
  const repo = makeRepo()
  for (const step of statusSteps) for (const args of stepArgs(step)) for (const json of [[], ['--json']]) {
    const result = sdd(repo, 'status', ...args, ...json)
    assert.equal(result.code, 0, `${args}: ${JSON.stringify(result.out)}`)
    assert.deepEqual(result.out, { flows: [] })
  }
})

test('sdd status --step conserva exactamente la seleccion del listado calculado', () => {
  const repo = makeRepo()
  planFixture(repo, 'a-plan')
  completa(repo, 'b-implement')
  planFixture(repo, 'c-plan')
  phaseFixture(repo, 'c-plan', { ...emptyPhaseFixture(), phases: { plan: { inline: { run: 'R2', at: '2026-10-13T00:00:00Z' } } } })
  const flows = statusList(repo)
  assert.deepEqual(flows.map((entry) => entry.id), ['a-plan', 'b-implement', 'c-plan'])
  assert.equal(flows[0].next.step, 'plan')
  assert.notEqual(flows[1].next.step, 'plan')
  assert.equal(flows[2].next.step, 'plan')
  assert.equal(flows[0].next.command, './bin/sdd-ai sdd phase a-plan')
  assert.match(flows[2].next.detail, /inline/)
  assert.match(flows[1].next.detail, /cambios sin commitear/)
  for (const step of statusSteps) for (const args of stepArgs(step)) {
    selectedStatus(repo, flows, step, ...args, '--json')
  }
})

test('sdd status --step devuelve flows vacio sin coincidencias ni flujos listables', () => {
  const populated = makeRepo()
  completa(populated)
  const reference = statusList(populated)
  assert.ok(reference.length > 0)
  assert.ok(reference.every((entry) => entry.next.step !== 'push'))
  const excluded = makeRepo()
  completa(excluded, 'archived/old')
  writeFlow(excluded, 'notes', { 'notes.md': '# Notas\n' })
  writeFileSync(join(excluded, '.plans', 'loose.md'), '# Suelto\n')
  for (const repo of [populated, makeRepo(), excluded]) for (const args of stepArgs('push')) {
    const result = sdd(repo, 'status', ...args)
    assert.equal(result.code, 0)
    assert.deepEqual(result.out, { flows: [] })
  }
})

test('sdd status --step rechaza valores invalidos ausentes y repetidos con diagnostico', () => {
  const repo = makeRepo()
  for (const value of ['unknown-step', 'PLAN', ' plan', 'plan ', '']) for (const args of stepArgs(value)) {
    const message = usageStatus(repo, args)
    assert.ok(message.includes(JSON.stringify(value)), message)
    for (const step of statusSteps) assert.ok(message.includes(step), message)
  }
  for (const args of [
    ['--step', 'plan', '--step', 'plan'], ['--step', 'plan', '--step', 'tasks'],
    ['--step=plan', '--step=plan'], ['--step=plan', '--step=tasks'],
    ['--step', 'plan', '--step=plan'], ['--step=plan', '--step', 'tasks'],
  ]) assert.equal(usageStatus(repo, args), '--step solo puede aparecer una vez')
  assert.equal(usageStatus(repo, ['--step']), "Option '--step <value>' argument missing")
  const ambiguous = usageStatus(repo, ['--step', '--json'])
  assert.ok(ambiguous.includes("Option '--step' argument is ambiguous"))
  assert.ok(ambiguous.includes("Did you forget to specify the option argument for '--step'?"))
  // Después de --, el texto no es una segunda opción: conserva el diagnóstico de combinación con id.
  assert.equal(usageStatus(repo, ['--step=plan', '--', '--step=plan']), '--step solo se admite en el listado sin id')
})

test('sdd status --step con id rechaza todos los ordenes y ambas sintaxis', () => {
  const repo = makeRepo()
  completa(repo, 'existing')
  for (const id of ['existing', 'missing']) for (const option of stepArgs('plan')) {
    for (const args of [[id, ...option], [...option, id]]) for (const json of [[], ['--json']]) {
      assert.equal(usageStatus(repo, [...args, ...json]), '--step solo se admite en el listado sin id')
    }
  }
})

test('sdd status sin --step conserva listado detalle y errores con y sin --json', () => {
  const repo = makeRepo()
  completa(repo, 'ok')
  specOnly(repo, 'a-gate')
  completa(repo, 'archived/old')
  writeFlow(repo, 'notes', { 'notes.md': '# Notas\n' })
  writeFileSync(join(repo, '.plans', 'loose.md'), '# Suelto\n')
  const invalid = 'x'.repeat(129)
  mkdirSync(join(repo, '.plans', invalid))
  const flows = statusList(repo)
  assert.deepEqual(flows.map((entry) => entry.id), ['a-gate', 'ok', invalid])
  assert.equal(flows[0].next.step, 'gate')
  assert.equal(flows[1].depth, 'completa')
  assert.equal(flows[1].next.step, 'implement')
  assert.equal(flows[1].next.task, 'T2')
  assert.match(flows[1].next.detail, /cambios sin commitear/)
  assert.equal(flows[1].blocked, false)
  assert.deepEqual(flows[1].blocked_reasons, [])
  assert.deepEqual(codes(flows[2].blocked_reasons), ['id_invalid'])
  assert.equal(flows[2].blocked, true)
  assert.deepEqual(flows[2].next, { step: 'resolve_blockers' })
  for (const entry of flows) assert.deepEqual(Object.keys(entry), ['id', 'depth', 'next', 'blocked', 'blocked_reasons'])
  assert.deepEqual(sdd(repo, 'status', '--json'), { code: 0, out: { flows } })
  const detail = sdd(repo, 'status', 'ok')
  assert.equal(detail.code, 0)
  assert.equal(detail.out.id, 'ok')
  assert.equal(detail.out.depth, 'completa')
  assert.deepEqual(detail.out.next, flows[1].next)
  assert.deepEqual(detail.out.tasks, { total: 2, done: 1, pending: 1, first_pending: '**T2 — segunda** · cubre: AC-1' })
  assert.deepEqual(detail.out.gates.map((gate: { state: string }) => gate.state), ['approved_unfingerprinted', 'approved_unfingerprinted', 'approved_unfingerprinted'])
  assert.equal(detail.out.paths.spec, '.plans/ok/spec.md')
  assert.deepEqual(sdd(repo, 'status', 'ok', '--json'), detail)
  for (const [id, exit, code] of [['sub/x', 2, 'usage'], ['missing', 1, 'flow_not_found']] as const) {
    const plain = sdd(repo, 'status', id)
    assert.equal(plain.code, exit)
    assert.equal(plain.out.state, 'error')
    assert.equal(plain.out.code, code)
    assert.equal(typeof plain.out.message, 'string')
    assert.deepEqual(sdd(repo, 'status', id, '--json'), plain)
  }
  for (const json of [[], ['--json']]) assert.equal(usageStatus(repo, ['ok', 'missing', ...json]), 'sdd status recibe un solo id')
})

test('sdd status --step conserva guardas entradas bloqueadas y errores globales', () => {
  const repo = makeRepo()
  completa(repo, 'ok')
  const invalid = 'x'.repeat(129)
  mkfifo(join(writeFlow(repo, invalid, {}), 'spec.md'))
  mkfifo(join(writeFlow(repo, 'fifo', { 'plan.md': plan('planned'), 'handoff.md': handoff() }), 'spec.md'))
  const outside = outsideDir()
  mkfifo(join(outside, 'spec.md'))
  symlinkSync(outside, join(repo, '.plans', 'linked'))
  symlinkSync(join(outside, 'spec.md'), join(writeFlow(repo, 'artifact-link', { 'plan.md': plan('planned') }), 'spec.md'))
  const locked = join(completa(repo, 'locked'), 'spec.md')
  chmodSync(locked, 0o000)
  try {
    const flows = statusList(repo)
    for (const [id, code] of [['fifo', 'artifact_unreadable'], ['linked', 'path_invalid'],
      ['artifact-link', 'path_invalid'], [invalid, 'id_invalid']]) {
      const entry = flows.find((entry) => entry.id === id)!
      assert.equal(entry.blocked, true)
      assert.deepEqual(codes(entry.blocked_reasons), [code])
      assert.deepEqual(entry.next, { step: 'resolve_blockers' })
    }
    let readable = false
    try { readFileSync(locked); readable = true } catch { /* El permiso impide leer en hosts sin privilegios. */ }
    if (!readable) assert.deepEqual(codes(flows.find((entry) => entry.id === 'locked')!.blocked_reasons), ['artifact_unreadable'])
    for (const step of statusSteps) selectedStatus(repo, flows, step, '--step', step)
  } finally { chmodSync(locked, 0o600) }
  for (const kind of ['link', 'file']) {
    const other = makeRepo()
    if (kind === 'link') symlinkSync(outside, join(other, '.plans'))
    else writeFileSync(join(other, '.plans'), 'not a directory')
    const plain = sdd(other, 'status')
    assert.equal(plain.code, 2)
    assert.equal(plain.out.code, 'path_invalid')
    assert.equal(plain.out.state, 'error')
    for (const args of stepArgs('resolve_blockers')) assert.deepEqual(sdd(other, 'status', ...args), plain)
  }
})

test('sdd status --step usa el paso final con revisiones invalidas y corrida activa', () => {
  const repo = makeRepo()
  planFixture(repo, 'broken')
  writeFileSync(join(repo, '.plans', 'broken', 'sdd-ai-phases.json'), '{')
  mkfifo(join(writeFlow(repo, 'blocked', { 'plan.md': plan('planned') }), 'spec.md'))
  planFixture(repo, 'active')
  phaseFixture(repo, 'active', { ...emptyPhaseFixture(), last_run: { id: 'R1', step: 'plan' } })
  const run = join(repo, '.sdd-ai', 'runs', 'R1')
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'status.json'), JSON.stringify({ state: 'running' }))
  planFixture(repo, 'minimal')
  phaseFixture(repo, 'minimal', emptyPhaseFixture())
  planFixture(repo, 'absent')
  const flows = statusList(repo)
  const broken = flows.find((entry) => entry.id === 'broken')!
  assert.equal(broken.blocked, true)
  assert.deepEqual(codes(broken.blocked_reasons), ['revisions_invalid'])
  assert.equal(broken.next.step, 'plan')
  assert.notEqual(broken.next.step, 'resolve_blockers')
  assert.equal(broken.next.command, undefined)
  assert.match(broken.next.detail, /registro de fases/)
  assert.equal(flows.find((entry) => entry.id === 'blocked')!.next.step, 'resolve_blockers')
  assert.equal(flows.find((entry) => entry.id === 'active')!.next.command, './bin/sdd-ai wait R1')
  for (const id of ['minimal', 'absent']) assert.equal(flows.find((entry) => entry.id === id)!.next.command, `./bin/sdd-ai sdd phase ${id}`)
  for (const step of statusSteps) {
    const result = selectedStatus(repo, flows, step, '--step', step)
    if (step === broken.next.step) assert.ok(result.out.flows.some((entry: { id: string }) => entry.id === 'broken'))
    if (step === 'resolve_blockers') assert.ok(result.out.flows.every((entry: { id: string }) => entry.id !== 'broken'))
  }
})

test('sdd status --step no cambia artefactos fases aprobaciones ni corridas', () => {
  const withRun = makeRepo()
  completa(withRun)
  phaseFixture(withRun, 'f', { ...emptyPhaseFixture(), last_run: { id: 'R1', step: 'implement' } })
  writeFileSync(join(withRun, '.plans', 'f', 'sdd-ai-approvals.json'), JSON.stringify({ schema_version: 1, approvals: [] }))
  const run = join(withRun, '.sdd-ai', 'runs', 'R1')
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'status.json'), JSON.stringify({ state: 'running' }))
  const withoutRun = makeRepo()
  completa(withoutRun)
  const snapshot = (repo: string) => {
    const inventory = files(repo)
    const bytes: Record<string, string> = {}
    const visit = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name), st = lstatSync(path)
        if (st.isDirectory()) visit(path)
        else if (st.isFile()) bytes[relative(repo, path)] = readFileSync(path).toString('base64')
      }
    }
    visit(repo)
    return { inventory, bytes }
  }
  for (const repo of [withRun, withoutRun]) {
    Object.assign(envOf(repo), { SDD_AI_PROJECTION: 'off', SDD_AI_TELEMETRY: 'off' })
    const beforeReference = snapshot(repo)
    const flows = statusList(repo)
    assert.deepEqual(snapshot(repo), beforeReference)
    const matching = flows[0].next.step as string
    const absent = statusSteps.find((step) => flows.every((entry) => entry.next.step !== step))!
    assert.ok(flows.some((entry) => entry.next.step === matching))
    assert.ok(absent)
    for (const step of [matching, absent]) for (const args of stepArgs(step)) {
      const before = snapshot(repo)
      const result = selectedStatus(repo, flows, step, ...args)
      if (step === matching) assert.ok(result.out.flows.length > 0)
      else assert.deepEqual(result.out, { flows: [] })
      assert.deepEqual(snapshot(repo), before)
    }
    for (const [args, diagnostic] of [
      [['--step', 'unknown-step'], '"unknown-step"'],
      [['--step=plan', '--step=plan'], '--step solo puede aparecer una vez'],
      [['f', '--step=plan'], '--step solo se admite en el listado sin id'],
      [['--step'], "Option '--step <value>' argument missing"],
    ] as Array<[string[], string]>) {
      const before = snapshot(repo)
      assert.ok(usageStatus(repo, args).includes(diagnostic))
      assert.deepEqual(snapshot(repo), before)
    }
    if (repo === withoutRun) assert.equal(existsSync(join(repo, '.sdd-ai')), false)
  }
})

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
  assert.deepEqual(next, { step: 'implement', task: 'T2' })
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
  assert.deepEqual(Object.keys(flows), ['fifo', 'link', 'ok', 'x'.repeat(129)])
  for (const f of r.out.flows) assert.deepEqual(Object.keys(f), ['id', 'depth', 'next', 'blocked', 'blocked_reasons'])

  assert.deepEqual(sdd(repo, 'status', 'estudios').out.next, { step: 'no_artifacts' })
  assert.deepEqual(codes(flows.fifo.blocked_reasons), ['artifact_unreadable'])
  assert.deepEqual(codes(flows.link.blocked_reasons), ['path_invalid'])
  assert.deepEqual(codes(flows['x'.repeat(129)].blocked_reasons), ['id_invalid'])
  for (const id of ['fifo', 'link', 'x'.repeat(129)]) {
    assert.equal(flows[id].blocked, true, id)
    assert.deepEqual(flows[id].next, { step: 'resolve_blockers' }, id)
  }
  assert.equal(flows.ok.depth, 'completa')
  for (const id of ['fifo', 'ok']) assert.deepEqual(flows[id].next, sdd(repo, 'status', id).out.next, id)

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
    const child = spawn(process.execPath, [BIN, 'sdd', 'approve', 'f', gate], { cwd: repo, env: envOf(repo) })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.on('close', (code) => done({ code, out: JSON.parse(stdout) }))
  })
}

test('approve registra el gate con su huella y las de los anteriores y responde el estado nuevo', () => {
  const repo = makeRepo()
  const dir = completa(repo, 'f', 'planned')
  const artifacts = ['spec.md', 'plan.md', 'tasks.md', 'handoff.md']
  const read = (n: string) => ({ text: readFileSync(join(dir, n), 'utf8'), mtime: lstatSync(join(dir, n)).mtimeMs })
  const before = Object.fromEntries(artifacts.map((n) => [n, read(n)]))

  answer(repo, 'f', 'spec')
  const spec = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(spec.code, 0, JSON.stringify(spec.out))
  assert.deepEqual(gateStates(spec.out), { spec: 'approved', plan: 'pending', tasks: 'pending' })
  const { question: specQuestion, ...specNext } = spec.out.next
  assert.deepEqual(specNext, { step: 'gate', gate: 'plan', artifacts: ['plan.md'] })
  assert.equal(typeof specQuestion?.question, 'string')
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
  assert.ok(!plan.out.notes.some((n: { code: string }) => n.code === 'header_behind'))
  const second = registry(dir).approvals[1]
  assert.equal(second.gate, 'plan')
  assert.deepEqual(second.previous, { spec: first.fingerprint })
  // `approve` responde lo mismo que `status`, con la pregunta del gate siguiente.
  assert.equal(typeof plan.out.next.question?.question, 'string')
  assert.deepEqual(sdd(repo, 'status', 'f').out, plan.out)

  // La spec y las tasks no se tocan; approve solo sincroniza el status del plan y la fecha del handoff.
  for (const name of ['spec.md', 'tasks.md']) assert.deepEqual(read(name), before[name])
  assert.equal(read('plan.md').text, before['plan.md'].text.replace('status: planned', 'status: plan-approved'))
  assert.equal(read('handoff.md').text, before['handoff.md'].text.replace(`spec_approved_at: ${HANDOFF_SPEC_APPROVED_AT}`, `spec_approved_at: ${first.at}`))
  assert.equal(existsSync(join(dir, LOCK)), false)
})

test('approve trae en next el comando de la fase', () => {
  const repo = makeRepo()
  const dir = specOnly(repo)
  writeFileSync(join(dir, 'handoff.md'), readFileSync(join(dir, 'handoff.md'), 'utf8').replace('profundidad: completa', 'branch: feature/f\nprofundidad: completa'))

  answer(repo, 'f', 'spec')
  const spec = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(spec.code, 0, JSON.stringify(spec.out))
  assert.deepEqual(spec.out.next, { step: 'plan', artifacts: ['plan.md'], command: './bin/sdd-ai sdd phase f' })
  assert.deepEqual(sdd(repo, 'status', 'f').out, spec.out)
})

test('sdd approve de la spec devuelve el paso branch con el comando de sdd branch', () => {
  const repo = makeRepo()
  specOnly(repo)
  answer(repo, 'f', 'spec')
  const r = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual(r.out.next, { step: 'branch', command: './bin/sdd-ai sdd branch f' })
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
  const r = spawnSync(process.execPath, [BIN, 'sdd', 'approve', 'f', 'spec'], { cwd: repo, encoding: 'utf8', timeout: 5000, env: { ...envOf(repo), SDD_AI_WORKER: '1' } })
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
    const r = spawnSync(process.execPath, [BIN, 'sdd', 'approve', 'f', 'spec', ...extra], { cwd: repo, encoding: 'utf8', timeout: 5000, env })
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

test('sdd status omite publicación sin remoto y conserva los pasos con remoto', () => {
  const doneTasks = TASKS.replace('- [ ] **T2', '- [x] **T2')
  const local = makeRepo()
  for (const [id, status, prUrl] of [
    ['committed', 'committed', ''], ['pushed-no-pr', 'pushed', ''], ['pushed-pr', 'pushed', 'pr_url: https://example.test/pr/1\n'],
  ] as const) {
    const dir = completa(local, id, status)
    writeFileSync(join(dir, 'tasks.md'), doneTasks)
    if (prUrl) {
      const withPr = plan(status).replace('---\n\n# Plan', `${prUrl}---\n\n# Plan`)
      assert.notEqual(withPr, plan(status), 'el plan lleva pr_url')
      writeFileSync(join(dir, 'plan.md'), withPr)
    }
    assert.deepEqual(sdd(local, 'status', id).out.next, { step: 'archive' }, id)
  }
  const flows = Object.fromEntries(sdd(local, 'status').out.flows.map((f: { id: string; next: unknown }) => [f.id, f.next]))
  assert.deepEqual(flows.committed, { step: 'archive' })

  const remote = makeRepo()
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/repo.git'], { cwd: remote })
  for (const [id, status, step] of [['committed', 'committed', 'push'], ['pushed', 'pushed', 'open_pr']] as const) {
    const dir = completa(remote, id, status)
    writeFileSync(join(dir, 'tasks.md'), doneTasks)
    assert.deepEqual(sdd(remote, 'status', id).out.next, { step }, id)
  }
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
  assert.equal(approve(repo, 'f', 'spec', new Date(), readFlow, prove, env).gates[0].state, 'approved')
  assert.deepEqual(registry(dir).approvals, [entry])
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
  answer(repo, 'f', 'spec')
  assert.equal(sdd(repo, 'approve', 'f', 'spec').code, 0)
  writeFileSync(join(dir, 'spec.md'), SPEC)
  const r = sdd(repo, 'approve', 'f', 'spec')
  assert.equal(r.out.code, 'approval_reused', JSON.stringify(r.out))
  assert.equal(registry(dir).approvals.length, 2)
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
