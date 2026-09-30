import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentBranch, headCommit } from '../src/git.ts'
import { parseWorkers } from '../src/profiles.ts'
import { criteriaIds, readHeader } from '../src/sdd/markdown.ts'
import { type PlanContract, type SpecifyContract, type TasksContract, planHeaderFrom, renderPhasePrompt, renderSpec, renderTasks } from '../src/sdd/phase.ts'
import { readPhaseRecord } from '../src/sdd/phase-state.ts'
import { type FrozenLaunch, type PublishOutcome, freezeLaunch, publishPhase } from '../src/sdd/publish.ts'
import { readFlow } from '../src/sdd/read.ts'
import { resolve } from '../src/sdd/status.ts'
import { isPhaseRole, PHASE_ROLES } from '../src/types.ts'
import { makeFakeBin, makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

interface Setup { repo: string; env: Record<string, string>; bin: string }

function setup(opts: { families?: string; bins?: Array<'claude' | 'codex'>; mode?: string } = {}): Setup {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: ${opts.families ?? '[codex]'}\n  selection: full\n`)
  // PATH controlado: node para el shebang y solo los CLIs falsos pedidos, nunca los reales.
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const b of opts.bins ?? []) makeFakeBin(bin, b)
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? '',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 's-claude',
    CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')),
    FAKE_MODE: opts.mode ?? 'ok-codex',
  }
  return { repo, env, bin }
}

function cli(s: Setup, args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(BIN, args, { cwd: s.repo, env: { ...s.env, ...extraEnv }, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}

test('los roles de fase entran en workers.yml, run --role los rechaza y agents sync no los genera', () => {
  assert.deepEqual([...PHASE_ROLES], ['specify', 'plan', 'tasks'])
  assert.equal(isPhaseRole('plan'), true)
  assert.equal(isPhaseRole('implement'), false)

  const workers = parseWorkers('schema_version: 1\nroles:\n  specify:\n    codex: { model: gpt-x, effort: alto }\n  plan:\n    claude: { model: opus }\n  tasks: {}\n', 'workers.yml')
  assert.deepEqual(workers.roles.specify, { codex: { model: 'gpt-x', effort: 'alto' } })
  assert.deepEqual(workers.roles.plan, { claude: { model: 'opus' } })

  const s = setup({ bins: ['codex'] })
  const prompt = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(prompt, 'Encargo.\n')
  for (const role of PHASE_ROLES) {
    const r = cli(s, ['run', '--role', role, '--prompt-file', prompt])
    assert.equal(r.code, 2, r.stderr)
    assert.equal(r.out.code, 'usage', role)
    assert.match(r.out.message, /lo despacha sdd phase/, role)
  }
  assert.equal(existsSync(join(s.repo, '.sdd-ai', 'runs')) && readdirSync(join(s.repo, '.sdd-ai', 'runs')).length > 0, false)

  assert.equal(cli(s, ['agents', 'sync']).code, 0)
  const generated = [...readdirSync(join(s.repo, '.claude', 'agents')), ...readdirSync(join(s.repo, '.codex', 'agents'))]
  for (const role of PHASE_ROLES) assert.equal(generated.some((f) => f.startsWith(`sdd-ai-${role}.`)), false, role)
})

// Un flujo en disco en el paso que se pide, con los artefactos que ese paso ya tiene.
const HANDOFF = (depth = 'completa', approved = false) =>
  `---\nphase: specify\nprofundidad: ${depth}\nrisk: low\nchange_type: feat\nspec_approved_at: ${approved ? '2026-09-29T08:59:18-05:00' : 'null'}\n---\n\n# Handoff\n\nCuerpo.\n`
const SPEC_MD = '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** exporta. (pedido)\n- **AC-2:** encabezado. (pedido)\n'
const PLAN_MD = (depth = 'completa', status = 'plan-approved') =>
  `---\nid: f\nbranch: feature/f\nbase_commit: x\nchange_type: feat\nprofundidad: ${depth}\nrisk: low\nstatus: ${status}\ncreated_at: 2026-09-29T09:00:00-05:00\n---\n\n# Plan\n\n## Enfoque\n\nUno.\n`

function commit(repo: string): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: repo })
}

function flowAt(repo: string, step: 'specify' | 'plan' | 'tasks' | 'implement', depth = 'completa'): string {
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\n')
  writeFileSync(join(dir, 'handoff.md'), HANDOFF(depth, step !== 'specify'))
  if (step !== 'specify') writeFileSync(join(dir, 'spec.md'), SPEC_MD)
  if (step === 'tasks' || step === 'implement') writeFileSync(join(dir, 'plan.md'), PLAN_MD(depth, step === 'implement' ? 'tasks-ready' : 'plan-approved'))
  if (step === 'implement') writeFileSync(join(dir, 'tasks.md'), '# Tasks\n\n- [ ] **T1 — exportar**  · cubre: AC-1, AC-2\n  - **Pasos:** hacerlo.\n')
  return dir
}

const SPECIFY_C: SpecifyContract = {
  phase: 'specify', known_facts: [], assumptions: ['uno'], blocking_questions: [], missing_context: [],
  acceptance_criteria: [{ id: 'AC-1', text: 'exporta', authority: 'pedido', verification: 'test' }],
  problem: 'Problema.', background: 'Nada.', scope: 'Todo.',
}
const PLAN_CONTRACT: PlanContract = {
  phase: 'plan', assumptions: [], blocking_questions: [], missing_context: [],
  approach: 'Directo.', decisions: 'ninguno', files: '- `src/a.ts`',
  verification: {
    schema_version: 1,
    rows: [{ id: 'V1', acs: ['AC-1', 'AC-2'], kind: 'inspección', obligation: 'none', obligation_reason: 'lectura', argv: ['npm', 'test'], timeout_ms: 60000, expect: { exit_code: 0 } }],
  },
}
const TASKS_CONTRACT: TasksContract = {
  phase: 'tasks', assumptions: [], blocking_questions: [], missing_context: [],
  tasks: [{ id: 'T1', title: 'exportar', covers: ['AC-1', 'AC-2'], pattern: 'como a.ts', test: 'node --test', files: ['src/a.ts'], steps: ['hacerlo'] }],
}

function launchFor(repo: string, step: 'specify' | 'plan' | 'tasks', o: { request?: string; context?: string } = {}): FrozenLaunch {
  const read = readFlow(repo, 'f')
  const file = (text: string | undefined) => {
    if (text === undefined) return undefined
    const path = join(mkdtempSync(join(tmpdir(), 'sdd-ai-material-')), 'm.md')
    writeFileSync(path, text)
    return { path, bytes: Buffer.from(text) }
  }
  const header = read.facts.handoffHeader?.ok ? read.facts.handoffHeader.data : null
  const h = step === 'plan' ? planHeaderFrom('f', header, currentBranch(repo), headCommit(repo) ?? null, new Date()) : null
  const plan_header = h && 'header' in h ? (({ created_at: _c, ...rest }) => rest)(h.header) : undefined
  return freezeLaunch(read, { step, depth: 'completa', amended: false, request: file(o.request), context: file(o.context), ...(plan_header ? { plan_header, criteria: criteriaIds(SPEC_MD) } : {}) })
}

const causeOf = (o: PublishOutcome) => (o.kind === 'published' ? 'published' : o.cause)

test('la publicación de una fase escribe el artefacto desde los campos y el flujo pasa al gate', () => {
  const repo = makeRepo()
  commit(repo)
  const dir = flowAt(repo, 'specify')
  const launch = launchFor(repo, 'specify', { request: 'Quiero exportar.\n' })
  const out = publishPhase(repo, launch, SPECIFY_C)
  assert.deepEqual(out, { kind: 'published', artifact: '.plans/f/spec.md' })
  assert.equal(readFileSync(join(dir, 'spec.md'), 'utf8'), renderSpec(SPECIFY_C))
  const s = resolve(readFlow(repo, 'f').facts)
  assert.deepEqual([s.next.step, s.next.gate], ['gate', 'spec'])
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), [])

  // El plan lleva los valores congelados del header y la fecha de la escritura.
  execFileSync('git', ['checkout', '-q', '-b', 'feature/f'], { cwd: repo })
  const plan = makeRepo()
  commit(plan)
  execFileSync('git', ['checkout', '-q', '-b', 'feature/f'], { cwd: plan })
  const planDir = flowAt(plan, 'plan')
  const at = new Date('2026-09-29T15:00:00Z')
  assert.equal(causeOf(publishPhase(plan, launchFor(plan, 'plan'), PLAN_CONTRACT, at)), 'published')
  const header = readHeader(readFileSync(join(planDir, 'plan.md'), 'utf8'))
  assert.ok(header.ok)
  if (header.ok) {
    assert.deepEqual([header.data.branch, header.data.base_commit, header.data.profundidad, header.data.status], ['feature/f', headCommit(plan), 'completa', 'planned'])
    assert.equal(Date.parse(String(header.data.created_at)), at.getTime())
  }
  assert.deepEqual(resolve(readFlow(plan, 'f').facts).next.step, 'gate')

  const tasks = makeRepo()
  const tasksDir = flowAt(tasks, 'tasks')
  assert.equal(causeOf(publishPhase(tasks, launchFor(tasks, 'tasks'), TASKS_CONTRACT)), 'published')
  assert.equal(readFileSync(join(tasksDir, 'tasks.md'), 'utf8'), renderTasks(TASKS_CONTRACT))
})

test('la publicación de una fase no pisa ni sigue enlaces, y no escribe si algo cambió desde el lanzamiento', () => {
  const at = (step: 'specify' | 'plan' | 'tasks', o: { request?: string; context?: string } = {}) => {
    const repo = makeRepo()
    commit(repo)
    execFileSync('git', ['checkout', '-q', '-b', 'feature/f'], { cwd: repo })
    const dir = flowAt(repo, step)
    return { repo, dir, launch: launchFor(repo, step, o) }
  }
  const contract = { specify: SPECIFY_C, plan: PLAN_CONTRACT, tasks: TASKS_CONTRACT }

  const appeared = at('specify', { request: 'p' })
  writeFileSync(join(appeared.dir, 'spec.md'), 'la escribió otro\n')
  assert.equal(causeOf(publishPhase(appeared.repo, appeared.launch, SPECIFY_C)), 'step_changed')
  assert.equal(readFileSync(join(appeared.dir, 'spec.md'), 'utf8'), 'la escribió otro\n')

  // Un enlace colgante no cambia el paso, pero ocupa el nombre: no se sigue ni se reemplaza.
  const linked = at('tasks')
  const target = join(mkdtempSync(join(tmpdir(), 'sdd-ai-afuera-')), 'tasks.md')
  symlinkSync(target, join(linked.dir, 'tasks.md'))
  const linkedOut = publishPhase(linked.repo, linked.launch, TASKS_CONTRACT)
  assert.notEqual(causeOf(linkedOut), 'published')
  assert.equal(existsSync(target), false)
  assert.equal(readlinkSync(join(linked.dir, 'tasks.md')), target)

  const changes: Array<[string, 'specify' | 'plan' | 'tasks', (x: ReturnType<typeof at>) => void]> = [
    ['el pedido', 'specify', (x) => writeFileSync(x.launch.request_path ?? '', 'otro pedido')],
    ['la spec', 'plan', (x) => writeFileSync(join(x.dir, 'spec.md'), `${SPEC_MD}\notra línea\n`)],
    ['el plan', 'tasks', (x) => writeFileSync(join(x.dir, 'plan.md'), `${PLAN_MD()}\notra línea\n`)],
    ['el contexto', 'plan', (x) => writeFileSync(x.launch.context_path ?? '', 'otro contexto')],
    ['el header del handoff', 'plan', (x) => writeFileSync(join(x.dir, 'handoff.md'), readFileSync(join(x.dir, 'handoff.md'), 'utf8').replace('risk: low', 'risk: high'))],
    ['la rama', 'plan', (x) => execFileSync('git', ['checkout', '-q', '-b', 'otra'], { cwd: x.repo })],
    ['HEAD', 'plan', (x) => commit(x.repo)],
  ]
  for (const [what, step, change] of changes) {
    const x = at(step, { request: 'p', context: 'c' })
    change(x)
    const out = publishPhase(x.repo, x.launch, contract[step])
    assert.equal(causeOf(out), 'inputs_changed', `${what}: ${JSON.stringify(out)}`)
    assert.equal(existsSync(join(x.dir, `${step === 'specify' ? 'spec' : step}.md`)), false, what)
  }
  // Solo el cuerpo del handoff: el conductor lo reescribe en cada paso y no cuenta.
  const body = at('plan')
  writeFileSync(join(body.dir, 'handoff.md'), `${readFileSync(join(body.dir, 'handoff.md'), 'utf8')}\nOtro párrafo.\n`)
  assert.equal(causeOf(publishPhase(body.repo, body.launch, PLAN_CONTRACT)), 'published')

  const moved = at('plan')
  rmSync(join(moved.dir, 'spec.md'))
  assert.equal(causeOf(publishPhase(moved.repo, moved.launch, PLAN_CONTRACT)), 'step_changed')
  const depth = at('plan')
  assert.equal(causeOf(publishPhase(depth.repo, { ...depth.launch, depth: 'normal' }, PLAN_CONTRACT)), 'step_changed')

  // Un header de plan con menos profundidad que la del handoff deja el flujo bloqueado: no se publica.
  const blocked = at('plan')
  const lower = { ...blocked.launch, plan_header: { ...(blocked.launch.plan_header as NonNullable<FrozenLaunch['plan_header']>), profundidad: 'normal' } }
  const blockedOut = publishPhase(blocked.repo, lower, PLAN_CONTRACT)
  assert.equal(causeOf(blockedOut), 'candidate_blocked', JSON.stringify(blockedOut))
  assert.equal(existsSync(join(blocked.dir, 'plan.md')), false)

  const readonly = at('tasks')
  chmodSync(readonly.dir, 0o555)
  try {
    assert.equal(causeOf(publishPhase(readonly.repo, readonly.launch, TASKS_CONTRACT)), 'write_failed')
  } finally {
    chmodSync(readonly.dir, 0o755)
  }
  assert.deepEqual(readdirSync(readonly.dir).sort(), ['handoff.md', 'plan.md', 'spec.md'])
})

/** Un repo con config de familias, CLIs falsos y un flujo en el paso pedido. */
function phaseSetup(step: 'specify' | 'plan' | 'tasks' | 'implement', o: { families?: string; bins?: Array<'claude' | 'codex'>; depth?: string; mode?: string } = {}) {
  const s = setup({ families: o.families ?? '[codex]', bins: o.bins ?? ['codex'], mode: o.mode ?? 'ok-codex' })
  commit(s.repo)
  execFileSync('git', ['checkout', '-q', '-b', 'feature/f'], { cwd: s.repo })
  const dir = flowAt(s.repo, step, o.depth)
  writeFileSync(join(s.repo, 'pedido.md'), 'Quiero exportar a CSV.\n')
  return { ...s, dir }
}

const runsOf = (repo: string) => (existsSync(join(repo, '.sdd-ai', 'runs')) ? readdirSync(join(repo, '.sdd-ai', 'runs')) : [])
const snapshotOf = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
const runFile = (repo: string, id: string, name: string) => readFileSync(join(repo, '.sdd-ai', 'runs', id, name), 'utf8')

test('sdd phase lanza la fase vigente por proceso con el prompt del binario', () => {
  const s = phaseSetup('specify')
  const r = cli(s, ['sdd', 'phase', 'f', '--request', 'pedido.md'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.via, r.out.family, r.out.flow, r.out.step], ['process', 'codex', 'f', 'specify'])
  assert.equal(r.out.next, `./bin/sdd-ai wait ${r.out.id}`)
  const request = JSON.parse(runFile(s.repo, r.out.id, 'request.json'))
  assert.deepEqual([request.kind, request.flow, request.step, request.amended, request.role], ['phase', 'f', 'specify', false, 'specify'])
  assert.equal(runFile(s.repo, r.out.id, 'request.md'), 'Quiero exportar a CSV.\n')
  const prompt = runFile(s.repo, r.out.id, 'prompt.md')
  assert.equal(prompt, renderPhasePrompt('specify', { id: 'f', depth: 'completa', step: 'specify' }, { request: 'Quiero exportar a CSV.\n' }))
  const argv = JSON.parse(runFile(s.repo, r.out.id, 'argv.json'))
  assert.deepEqual([argv.kind, argv.phase.flow, argv.phase.step, argv.phase.root], ['phase', 'f', 'specify', s.repo])
  assert.equal(JSON.parse(runFile(s.repo, r.out.id, 'inputs.json')).inputs.request, `sha256:${createHash('sha256').update('Quiero exportar a CSV.\n').digest('hex')}`)
  assert.deepEqual(readPhaseRecord(s.repo, 'f').last_run, { id: r.out.id, step: 'specify' })

  // Sin --request en la primera corrida de specify, o con un pedido vacío o que no es texto, no se crea corrida.
  const t = phaseSetup('specify')
  const refused: Array<[string[], string, RegExp]> = [
    [[], 'request_required', /pedido/],
    [['--request', 'vacio.md'], 'usage', /vacío/],
    [['--request', 'binario.md'], 'usage', /binario|UTF-8/],
    [['--request', 'no-existe.md'], 'usage', /no existe/],
  ]
  writeFileSync(join(t.repo, 'vacio.md'), '  \n')
  writeFileSync(join(t.repo, 'binario.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
  for (const [args, code, message] of refused) {
    const x = cli(t, ['sdd', 'phase', 'f', ...args])
    assert.equal(x.code, 2, JSON.stringify(x.out))
    assert.equal(x.out.code, code, JSON.stringify(x.out))
    assert.match(x.out.message, message)
  }
  assert.deepEqual(runsOf(t.repo), [])

  // En otra fase, --request es un error de uso.
  const p = phaseSetup('plan')
  const extra = cli(p, ['sdd', 'phase', 'f', '--request', 'pedido.md'])
  assert.deepEqual([extra.code, extra.out.code], [2, 'usage'])
  const plan = cli(p, ['sdd', 'phase', 'f'])
  assert.equal(plan.code, 0, JSON.stringify(plan.out))
  const planPrompt = runFile(p.repo, plan.out.id, 'prompt.md')
  assert.ok(planPrompt.includes(`<<<INSUMO spec\n${SPEC_MD}\nINSUMO spec>>>`))
  const frozen = JSON.parse(runFile(p.repo, plan.out.id, 'inputs.json'))
  assert.deepEqual([frozen.plan_header.branch, frozen.plan_header.base_commit], ['feature/f', headCommit(p.repo)])
})

test('sdd phase se niega cuando el paso no es una fase', () => {
  const cases: Array<[string, (repo: string, dir: string) => void]> = [
    ['gate', (_repo, dir) => writeFileSync(join(dir, 'spec.md'), SPEC_MD)],
    ['no_artifacts', (_repo, dir) => rmSync(join(dir, 'handoff.md'))],
    ['depth', (_repo, dir) => {
      rmSync(join(dir, 'handoff.md'))
      writeFileSync(join(dir, 'spec.md'), SPEC_MD)
    }],
    ['external_gate', (_repo, dir) => {
      writeFileSync(join(dir, 'handoff.md'), HANDOFF('completa', true).replace('phase: specify\n', 'phase: implementing\ngate_status: awaiting\n'))
      writeFileSync(join(dir, 'spec.md'), SPEC_MD)
      writeFileSync(join(dir, 'plan.md'), PLAN_MD('completa', 'tasks-ready'))
      writeFileSync(join(dir, 'tasks.md'), '# Tasks\n\n- [ ] **T1 — x**  · cubre: AC-1\n')
    }],
    ['resolve_blockers', (_repo, dir) => writeFileSync(join(dir, 'handoff.md'), '---\nprofundidad: [\n---\n')],
    ['verify', (_repo, dir) => {
      writeFileSync(join(dir, 'handoff.md'), HANDOFF('completa', true))
      writeFileSync(join(dir, 'spec.md'), SPEC_MD)
      writeFileSync(join(dir, 'plan.md'), PLAN_MD('completa', 'implementing'))
      writeFileSync(join(dir, 'tasks.md'), '# Tasks\n\n- [x] **T1 — x**  · cubre: AC-1\n')
    }],
  ]
  for (const [step, arrange] of cases) {
    const s = phaseSetup('specify')
    arrange(s.repo, s.dir)
    const before = snapshotOf(s.dir)
    const r = cli(s, ['sdd', 'phase', 'f', '--request', 'pedido.md'])
    assert.equal(r.code, 2, `${step}: ${JSON.stringify(r.out)}`)
    assert.equal(r.out.code, 'not_a_phase', `${step}: ${JSON.stringify(r.out)}`)
    assert.match(r.out.message, new RegExp(step), step)
    assert.deepEqual(runsOf(s.repo), [], step)
    assert.deepEqual(snapshotOf(s.dir), before, step)
  }
})

test('sdd phase se niega en profundidad corta', () => {
  const s = phaseSetup('specify', { depth: 'corta' })
  const r = cli(s, ['sdd', 'phase', 'f', '--request', 'pedido.md'])
  assert.deepEqual([r.code, r.out.code], [2, 'phase_inline'])
  assert.match(r.out.message, /corta/)
  assert.match(r.out.message, /inline/)
  assert.deepEqual(runsOf(s.repo), [])
})

test('la fase va por proceso aunque la familia sea la del conductor, y un CLI ausente no cae de familia', () => {
  const s = phaseSetup('plan', { families: '[claude]', bins: ['claude'], mode: 'ok-claude' })
  const r = cli(s, ['sdd', 'phase', 'f'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.via, r.out.family], ['process', 'claude'])
  assert.equal(JSON.parse(runFile(s.repo, r.out.id, 'resolved.json')).via, 'process')
  assert.equal(existsSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'native.json')), false)

  const missing = phaseSetup('plan', { families: '[codex, claude]', bins: [] })
  const m = cli(missing, ['sdd', 'phase', 'f'])
  assert.equal(m.code, 1, JSON.stringify(m.out))
  assert.deepEqual([m.out.state, m.out.reason, m.out.fallback.family], ['launch_failed', 'cli_missing', 'claude'])
  assert.equal(m.out.next, 'pregunta al usuario si cae a claude; solo con un sí: ./bin/sdd-ai sdd phase f --families claude --conductor claude')
  assert.equal(JSON.parse(runFile(missing.repo, m.out.id, 'status.json')).state, 'launch_failed')
})

/** Escribe las respuestas guionadas del hijo y devuelve el entorno que las usa. */
function scripted(s: { repo: string }, answers: unknown[]): Record<string, string> {
  const file = join(mkdtempSync(join(tmpdir(), 'sdd-ai-answers-')), 'answers.json')
  writeFileSync(file, JSON.stringify(answers.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))))
  return { FAKE_MODE: 'scripted', FAKE_ANSWERS: file, FAKE_CALLS_FILE: `${file}.calls` }
}

const SPECIFY_JSON = { ...SPECIFY_C }
const waitFor = (s: Setup, id: string, env: Record<string, string> = {}) => cli(s, ['wait', id, '--max', '20'], env)

test('wait de una fase devuelve el next de sdd status después de publicar', () => {
  const s = phaseSetup('specify')
  const env = scripted(s, [SPECIFY_JSON])
  const r = cli(s, ['sdd', 'phase', 'f', '--request', 'pedido.md'], env)
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const w = waitFor(s, r.out.id, env)
  assert.equal(w.code, 0, JSON.stringify(w.out))
  assert.deepEqual([w.out.state, w.out.outcome, w.out.artifact], ['done', 'published', '.plans/f/spec.md'])
  const status = cli(s, ['sdd', 'status', 'f'])
  assert.deepEqual(w.out.next, status.out.next)
  assert.equal(w.out.next.step, 'gate')
})

test('wait de una fase no devuelve el documento ni el contrato', () => {
  const s = phaseSetup('specify')
  const env = scripted(s, [SPECIFY_JSON])
  const r = cli(s, ['sdd', 'phase', 'f', '--request', 'pedido.md'], env)
  const w = waitFor(s, r.out.id, env)
  assert.deepEqual(w.out.assumptions, ['uno'])
  for (const key of ['result', 'contract', 'document', 'known_facts', 'acceptance_criteria']) assert.equal(key in w.out, false, key)

  const asking = phaseSetup('specify')
  const askEnv = scripted(asking, [{ ...SPECIFY_JSON, blocking_questions: ['¿CSV o TSV?'], missing_context: ['el esquema'] }])
  const a = waitFor(asking, cli(asking, ['sdd', 'phase', 'f', '--request', 'pedido.md'], askEnv).out.id, askEnv)
  assert.deepEqual([a.out.state, a.out.outcome, a.out.blocking_questions, a.out.missing_context], ['done', 'awaiting_context', ['¿CSV o TSV?'], ['el esquema']])
  assert.equal('artifact' in a.out, false)
  assert.equal(a.out.next.command, './bin/sdd-ai sdd phase f --context <archivo>')

  const bad = phaseSetup('specify')
  const badEnv = scripted(bad, ['no hay JSON', 'tampoco'])
  const b = waitFor(bad, cli(bad, ['sdd', 'phase', 'f', '--request', 'pedido.md'], badEnv).out.id, badEnv)
  assert.deepEqual([b.out.state, b.out.reason, b.out.outcome], ['unavailable', 'inadmissible_twice', 'not_admitted'])
  assert.match(b.out.cause, /exactamente un objeto JSON con phase/)
  assert.equal('result' in b.out, false)

  const missing = phaseSetup('plan', { families: '[codex, claude]', bins: [] })
  const m = cli(missing, ['sdd', 'phase', 'f'])
  const mw = waitFor(missing, m.out.id)
  assert.deepEqual([mw.out.state, mw.out.reason], ['launch_failed', 'cli_missing'])
  assert.equal(mw.out.next, 'pregunta al usuario si cae a claude; solo con un sí: ./bin/sdd-ai sdd phase f --families claude --conductor claude')
})

test('la ampliación de una fase espera el contexto, relanza una vez y cierra inline si vuelve a faltar', () => {
  const s = phaseSetup('specify')
  const asking = { ...SPECIFY_JSON, blocking_questions: ['¿CSV o TSV?'], missing_context: [] }
  const env = scripted(s, [asking, '__fail__', asking])
  const first = cli(s, ['sdd', 'phase', 'f', '--request', 'pedido.md'], env)
  assert.equal(waitFor(s, first.out.id, env).out.outcome, 'awaiting_context')
  assert.equal(existsSync(join(s.dir, 'spec.md')), false)
  writeFileSync(join(s.repo, 'pedido.md'), 'Otro pedido, que la ampliación no relee.\n')

  // Sin --context se niega; --request en la ampliación y un contexto vacío son errores; nada de eso consume la ampliación.
  const refused: Array<[string[], string]> = [
    [[], 'context_required'], [['--context', 'contexto.md', '--request', 'pedido.md'], 'usage'], [['--context', 'vacio.md'], 'usage'],
  ]
  writeFileSync(join(s.repo, 'contexto.md'), 'Es CSV.\n')
  writeFileSync(join(s.repo, 'vacio.md'), '\n')
  for (const [args, code] of refused) {
    const r = cli(s, ['sdd', 'phase', 'f', ...args], env)
    assert.deepEqual([r.code, r.out.code], [2, code], JSON.stringify(r.out))
  }
  assert.match(cli(s, ['sdd', 'phase', 'f'], env).out.detail, /¿CSV o TSV\?/)
  assert.deepEqual(runsOf(s.repo), [first.out.id])

  // Una ampliación que falla antes de publicar deja la fase esperando: se puede volver a lanzar con --context.
  const failed = cli(s, ['sdd', 'phase', 'f', '--context', 'contexto.md'], env)
  assert.equal(failed.code, 0, JSON.stringify(failed.out))
  assert.equal(failed.out.amended, true)
  const prompt = runFile(s.repo, failed.out.id, 'prompt.md')
  assert.ok(prompt.includes('<<<INSUMO request\nQuiero exportar a CSV.\n\nINSUMO request>>>'))
  assert.ok(prompt.includes('<<<CONTEXTO ampliación\nEs CSV.\n\nCONTEXTO ampliación>>>'))
  assert.equal(runFile(s.repo, failed.out.id, 'context.md'), 'Es CSV.\n')
  assert.notEqual(waitFor(s, failed.out.id, env).out.state, 'done')
  assert.deepEqual(readPhaseRecord(s.repo, 'f').phases.specify?.amended, { run: failed.out.id, consumed: false })

  const again = cli(s, ['sdd', 'phase', 'f', '--context', 'contexto.md'], env)
  const closed = waitFor(s, again.out.id, env)
  assert.equal(closed.out.outcome, 'closed_inline')
  assert.equal(closed.out.next.command, undefined)
  assert.match(closed.out.next.detail, /inline/)
  for (const args of [[], ['--context', 'contexto.md']]) {
    const r = cli(s, ['sdd', 'phase', 'f', ...args], env)
    assert.deepEqual([r.code, r.out.code], [2, 'phase_inline'], JSON.stringify(r.out))
  }

  // Una ampliación que publica consume la ampliación; --context sin ampliación es un error de uso.
  const p = phaseSetup('specify')
  const penv = scripted(p, [asking, SPECIFY_JSON])
  waitFor(p, cli(p, ['sdd', 'phase', 'f', '--request', 'pedido.md'], penv).out.id, penv)
  writeFileSync(join(p.repo, 'contexto.md'), 'Es CSV.\n')
  const published = waitFor(p, cli(p, ['sdd', 'phase', 'f', '--context', 'contexto.md'], penv).out.id, penv)
  assert.equal(published.out.outcome, 'published')
  assert.deepEqual(readPhaseRecord(p.repo, 'f').phases.specify, { amended: { run: published.out.id, consumed: true } })
  const plan = phaseSetup('plan')
  writeFileSync(join(plan.repo, 'contexto.md'), 'algo\n')
  const stray = cli(plan, ['sdd', 'phase', 'f', '--context', 'contexto.md'])
  assert.deepEqual([stray.code, stray.out.code], [2, 'usage'])
})

test('una segunda sdd phase con la corrida activa se niega nombrándola', () => {
  const s = phaseSetup('plan', { mode: 'hang-always-session' })
  const first = cli(s, ['sdd', 'phase', 'f'], { FAKE_FAMILY: 'codex' })
  assert.equal(first.code, 0, JSON.stringify(first.out))
  try {
    const second = cli(s, ['sdd', 'phase', 'f'])
    assert.deepEqual([second.code, second.out.code], [2, 'phase_running'])
    assert.match(second.out.message, new RegExp(first.out.id))
    assert.equal(second.out.next, `./bin/sdd-ai wait ${first.out.id}`)
    assert.deepEqual(runsOf(s.repo), [first.out.id])
    assert.equal(cli(s, ['sdd', 'status', 'f']).out.next.command, `./bin/sdd-ai wait ${first.out.id}`)
  } finally {
    cli(s, ['cancel', first.out.id])
    waitFor(s, first.out.id)
  }
})

test('wait de una fase devuelve el next de sdd status también en implement, con la cosecha aparte', () => {
  const s = phaseSetup('implement', { mode: 'writer' })
  writeFileSync(join(s.repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\npedido.md\n')
  const report = `Listo.\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: [{ id: 'T1', completion: 'done', change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'V1' }] })}\nSTATUS: done\n`
  const env = { FAKE_WRITER: JSON.stringify({ actions: [{ write: 'nuevo.txt', content: 'x\n' }], report }) }
  const r = cli(s, ['sdd', 'phase', 'f'], env)
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const w = cli(s, ['wait', r.out.id, '--max', '30'], env)
  assert.equal(w.code, 0, JSON.stringify(w.out))
  // Una cosecha completa de fase va a verify antes que a la revisión.
  assert.match(w.out.next, /sdd verify f/)
  assert.doesNotMatch(w.out.next, /review start/)
  assert.deepEqual(w.out.flow_next, cli(s, ['sdd', 'status', 'f']).out.next)
  assert.equal(w.out.flow_next.step, 'implement')
})

test('sdd phase lanza la fase vigente por proceso y no la lanza si el flujo cambió mientras esperaba el lock', async () => {
  const s = phaseSetup('plan')
  const lock = join(s.dir, 'sdd-ai-approvals.lock')
  // Un titular vivo del lock: el verbo lee el flujo y espera, sin robarlo.
  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, lstart: null })}\n`)
  const child = spawn(BIN, ['sdd', 'phase', 'f'], { cwd: s.repo, env: s.env })
  let stdout = ''
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
  const closed = new Promise<number | null>((done) => child.on('close', done))
  const until = Date.now() + 15_000
  while (!readdirSync(s.dir).some((f) => f.startsWith('sdd-ai-approvals.lock.') && f.endsWith('.tmp'))) {
    assert.ok(Date.now() < until, 'el verbo no llegó a esperar el lock')
    await new Promise((r) => setTimeout(r, 20))
  }
  writeFileSync(join(s.dir, 'spec.md'), `${SPEC_MD}\n- **AC-3:** otro. (pedido)\n`)
  rmSync(lock)
  assert.equal(await closed, 2, stdout)
  assert.equal(JSON.parse(stdout).code, 'artifacts_unstable')
  assert.deepEqual(runsOf(s.repo), [])
  assert.deepEqual(readPhaseRecord(s.repo, 'f').last_run, null)
})
