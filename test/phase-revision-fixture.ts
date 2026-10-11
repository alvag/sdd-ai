import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { withLockAsync } from '../src/lock.ts'
import { type Family, SddError } from '../src/types.ts'
import { type Question } from '../src/approval/question.ts'
import { type ArtifactSelection, freezeArtifact } from '../src/review/artifact.ts'
import { snapshot } from '../src/review/candidate.ts'
import { type Ledger, openLedger, decide } from '../src/review/ledger.ts'
import { type DocumentContract, type SpecifyContract, type PlanContract, type TasksContract, renderSpec, renderPlan, renderTasks } from '../src/sdd/phase.ts'
import { type PhaseRecord, readPhaseRecord } from '../src/sdd/phase-state.ts'
import { type RevisionArtifact, type RevisionEntry } from '../src/sdd/revision-record.ts'
import { bytesHash } from '../src/sdd/read.ts'
import { claudeLaunch } from '../src/workers/claude.ts'
import { codexLaunch } from '../src/workers/codex.ts'
import { askPair, makeFakeBin, makeRepo, telemetryOff, writeClaudeTranscript, writeCodexRollout } from './helpers.ts'

export const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
export const contracts: Record<RevisionArtifact, DocumentContract> = {
  spec: { phase: 'specify', known_facts: [], assumptions: [], blocking_questions: [], missing_context: [],
    acceptance_criteria: [{ id: 'AC-1', text: 'Exporta el resultado.', authority: 'pedido', verification: 'inspección' }],
    problem: 'Publicar un resultado.', background: 'Pedido original.', scope: 'Un resultado.' } satisfies SpecifyContract,
  plan: { phase: 'plan', assumptions: [], blocking_questions: [], missing_context: [], approach: 'Exportar directamente.',
    decisions: 'ninguno', files: '- `src/a.ts`', verification: { schema_version: 1, rows: [{ id: 'V1', acs: ['AC-1'],
      kind: 'inspection', obligation: 'none', obligation_reason: 'lectura del resultado', argv: ['node', '--version'],
      timeout_ms: 60000, expect: { exit_code: 0 } }] } } satisfies PlanContract,
  tasks: { phase: 'tasks', assumptions: [], blocking_questions: [], missing_context: [], tasks: [{ id: 'T1', title: 'Exportar',
    actor: 'writer', covers: ['AC-1'], pattern: 'src/a.ts', test: 'V1', files: ['src/a.ts'], steps: ['Exportar el resultado.'] }] } satisfies TasksContract,
}
export interface DocumentStepScript {
  answer?: string; session?: string; reject_resume?: boolean; startup_failure?: boolean; execution_failure?: boolean; barrier?: string; hang?: boolean
}
export interface RevisionFixture {
  repo: string; work: string; bin: string; env: Record<string, string>; artifact: RevisionArtifact; family: Family
  depth: 'normal' | 'completa'; origin: string; review: string; session: string; selection: ArtifactSelection
}
export const json = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T
export function put(file: string, value: unknown): void { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`) }
export const flowFile = (s: RevisionFixture, name: string) => join(s.repo, '.plans', 'f', name)
export const runFile = (s: RevisionFixture, run: string, name: string) => join(s.repo, '.sdd-ai', 'runs', run, name)
export function record(s: RevisionFixture): PhaseRecord { return readPhaseRecord(s.repo, 'f', true) }
export function saveRecord(s: RevisionFixture, r: PhaseRecord): void { put(flowFile(s, 'sdd-ai-phases.json'), r) }
export function entries(s: RevisionFixture): RevisionEntry[] { return record(s).revisions?.entries ?? [] }
export function calls(s: RevisionFixture): string[][] {
  return existsSync(s.env.FAKE_CALLS_FILE) ? readFileSync(s.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)) : []
}
export function prompts(s: RevisionFixture): string[] {
  const file = `${s.env.FAKE_CALLS_FILE}.prompts`
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)) : []
}

/** No ejecuta los proveedores al comprobar PATH: ambos deben ser falsos locales o estar ausentes. */
export function assertProviders(s: RevisionFixture, env: Record<string, string> = s.env): void {
  for (const name of ['claude', 'codex']) {
    let resolved: string | undefined
    assert.equal(env.PATH, `${s.bin}:/usr/bin:/bin`, 'PATH debe conservar el aislamiento del fixture')
    for (const dir of env.PATH.split(':')) {
      const file = join(dir, name)
      try { accessSync(file, constants.X_OK); resolved = file; break } catch { /* No ejecutable en este directorio. */ }
    }
    assert.ok(resolved === undefined || resolved === join(s.bin, name), `${name} resuelve fuera del fixture: ${resolved}`)
    if (resolved) assert.ok(readFileSync(resolved, 'utf8').includes(`"${join(import.meta.dirname, 'fake-cli.ts')}"`), `${name} no apunta al CLI falso`)
  }
}
export function cli(s: RevisionFixture, args: string[], env: Record<string, string> = {}, timeoutMs = 20000) {
  const effectiveEnv = { ...s.env, ...env }
  assertProviders(s, effectiveEnv)
  const r = spawnSync(process.execPath, ['--import', join(import.meta.dirname, 'no-subprocess.ts'), BIN, ...args],
    { cwd: s.repo, env: effectiveEnv, encoding: 'utf8', timeout: timeoutMs })
  if (r.signal) throw new Error(`CLI ${args.join(' ')} murió por ${r.signal}; stdout=${r.stdout}; stderr=${r.stderr}`)
  if (r.error) throw new Error(`CLI ${args.join(' ')}: ${r.error.message}; stdout=${r.stdout}; stderr=${r.stderr}`, { cause: r.error })
  try { return { code: r.status, out: JSON.parse(r.stdout || 'null') as any, stderr: r.stderr } } catch (e) {
    throw new Error(`CLI ${args.join(' ')} terminó con ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`, { cause: e })
  }
}
export function concurrentCli(s: RevisionFixture, args: string[]) {
  assertProviders(s)
  const p = spawn(process.execPath, ['--import', join(import.meta.dirname, 'no-subprocess.ts'), BIN, ...args], { cwd: s.repo, env: s.env })
  let stdout = ''; let stderr = ''
  const promise = new Promise<ReturnType<typeof cli>>((resolve, reject) => {
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`CLI agotó 45 s: ${args.join(' ')}; stdout=${stdout}; stderr=${stderr}`)) }, 45000)
    p.stdout.on('data', (b) => { stdout += b }); p.stderr.on('data', (b) => { stderr += b })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => {
      clearTimeout(timer)
      try { resolve({ code, out: JSON.parse(stdout || 'null'), stderr }) } catch (e) { reject(new Error(`CLI terminó con ${code}; stdout=${stdout}; stderr=${stderr}`, { cause: e })) }
    })
  })
  // Observar enseguida evita un rechazo sin manejar si falla la preparación del caso.
  void promise.catch(() => {})
  return Object.assign(promise, { diagnostic: () => `stdout=${stdout}; stderr=${stderr}` })
}
export async function waitFor(file: string, timeout = 10000, diagnostic?: () => string): Promise<void> {
  const until = Date.now() + timeout
  while (!existsSync(file)) { assert.ok(Date.now() < until, `no apareció ${file}${diagnostic ? `; ${diagnostic()}` : ''}`); await sleep(20) }
}
export function script(s: RevisionFixture, steps: DocumentStepScript[]): void {
  // Conserva el índice de llamadas previas al cambiar el guion.
  put(s.env.FAKE_DOCUMENT_SCRIPT, [...Array.from({ length: calls(s).length }, () => ({})), ...steps])
}
export function corrected(artifact: RevisionArtifact, marker = 'Corregido'): DocumentContract {
  const c = structuredClone(contracts[artifact])
  if (c.phase === 'specify') { c.problem += ` ${marker}.`; c.scope += ` ${marker}.` }
  if (c.phase === 'plan') { c.approach += ` ${marker}.`; c.decisions = `${marker}.` }
  if (c.phase === 'tasks') { c.tasks[0].title += ` ${marker}`; c.tasks[0].steps.push(`${marker}.`) }
  return c
}
export function revise(s: RevisionFixture, extra: string[] = []) {
  return cli(s, ['sdd', 'phase', 'f', '--revise', s.artifact, '--review', s.review, ...extra])
}
export async function settle(s: RevisionFixture, run: string) {
  // El plazo total incluye cada consulta; ninguna puede exceder el tiempo restante.
  const until = Date.now() + 30000
  for (;;) {
    const remaining = until - Date.now()
    assert.ok(remaining > 0, `la corrida ${run} no terminó en 30 s`)
    const r = cli(s, ['wait', run, '--max', '1'], {}, Math.min(20000, remaining))
    assert.ok(r.out, r.stderr)
    if (['done', 'failed', 'timeout', 'launch_failed', 'cancelled'].includes(r.out.state)) return r
    assert.ok(Date.now() < until, JSON.stringify(r.out))
    await sleep(20)
  }
}
export function snapshotFiles(s: RevisionFixture): Record<string, string> {
  return Object.fromEntries(['spec.md', 'plan.md', 'tasks.md', 'handoff.md', 'sdd-ai-approvals.json'].map((name) => [name, existsSync(flowFile(s, name)) ? readFileSync(flowFile(s, name), 'utf8') : '<absent>']))
}
export function refreshReview(s: RevisionFixture, n = 1): void {
  const dir = dirname(runFile(s, s.review, 'request.json'))
  const frozen = freezeArtifact(s.repo, s.selection)
  put(join(dir, `candidate${n === 1 ? '' : `-r${n}`}.json`), frozen.candidate)
  snapshot(s.repo, frozen.candidate, dir, frozen.bytes)
  let ledger = openLedger([{ axis: 'quality', severity: 'WARNING', location: `${s.selection.artifact}:5`, claim: 'Aclara el resultado.' }], { artifact: true })
  ledger.completed = n
  ledger = decide(ledger, 'accept', ['F-1'])
  put(join(dir, 'ledger.json'), ledger)
  put(join(dir, 'status.json'), { state: 'done', round: n })
}
export function answer(s: RevisionFixture, q: Question, label = q.options[0].label): void {
  writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR, s.env.CLAUDE_CODE_SESSION_ID, askPair(s.env.CLAUDE_CODE_SESSION_ID, randomUUID(), q, label))
}
export function questionFrom(out: { next?: string }): Question {
  const text = out.next ?? ''
  const marker = 'selección simple: '
  const begin = text.indexOf(marker)
  assert.ok(begin >= 0, text)
  const end = text.indexOf('. En Codex', begin)
  assert.ok(end > begin + marker.length, `falta el cierre de la pregunta canónica: ${text}`)
  return JSON.parse(text.slice(begin + marker.length, end)) as Question
}
export function directedAnswer(s: RevisionFixture, reviewerAnswer: 'resolved' | 'unresolved' = 'unresolved'): string {
  return JSON.stringify({ candidate_hash: '$HASH', inspection: { status: 'completed', paths: [s.selection.artifact] },
    responses: [{ id: 'F-1', answer: reviewerAnswer, evidence: `${s.selection.artifact}:5` }], findings: [], unverifiable: [] })
}
export function holdFlowLock<T>(s: RevisionFixture, action: () => Promise<T>): Promise<T> {
  return withLockAsync(flowFile(s, 'sdd-ai-approvals.lock'), () => new SddError('fixture_lock_busy', 'lock del fixture ocupado'), action)
}
/** Solo fabrica estados de interrupción para recuperar; las publicaciones normales pasan por el binario. */
export function interrupted(s: RevisionFixture, template: RevisionEntry, o: {
  current: 'previous' | 'result' | 'third'; terminal?: 'published' | 'cancelled' | 'not_published'; registry_pending?: true
}) {
  const previous = readFileSync(flowFile(s, `${s.artifact}.md`), 'utf8')
  const result = `${previous}\nResultado de la publicación interrumpida.\n`
  const third = `${previous}\nEdición posterior del conductor.\n`
  const run = `interrupted-${randomUUID()}`
  const entry: RevisionEntry = { ...structuredClone(template), run, parent_run: template.run, state: 'active', result: undefined }
  put(runFile(s, run, 'request.json'), { kind: 'phase', flow: 'f', step: entry.phase, role: entry.phase, revision: true })
  put(runFile(s, run, 'status.json'), { state: o.terminal === 'cancelled' ? 'cancelled' : o.terminal ? 'done' : 'running', supervisor_pid: 99999999 /* PID fuera del rango del host: simula un supervisor muerto. */ })
  if (o.terminal) put(runFile(s, run, 'phase.json'), { outcome: o.terminal, state: o.terminal, artifact: entry.artifact,
    assumptions: [], blocking_questions: [], missing_context: [], ...(o.registry_pending ? { registry_pending: true } : {}) })
  const r = record(s)
  const gates = s.depth === 'normal' ? (s.artifact === 'spec' ? ['spec', 'plan-tasks'] : ['plan-tasks'])
    : s.artifact === 'spec' ? ['spec', 'plan', 'tasks'] : s.artifact === 'plan' ? ['plan', 'tasks'] : ['tasks']
  saveRecord(s, { ...r, revisions: { entries: [entry], active: { run, artifact: entry.artifact }, barriers: [],
    intent: { run, artifact: entry.artifact, previous_digest: bytesHash(previous), result_digest: bytesHash(result), gates } } })
  writeFileSync(flowFile(s, `${s.artifact}.md`), o.current === 'previous' ? previous : o.current === 'result' ? result : third)
  return { run, previous, result, third }
}
export function makeFixture(o: { artifact?: RevisionArtifact; family?: Family; depth?: 'normal' | 'completa'; bins?: Family[]; header?: boolean; approved?: boolean } = {}): RevisionFixture {
  const repo = makeRepo('sdd-ai-revision-')
  const work = mkdtempSync(join(tmpdir(), 'sdd-ai-revision-work-'))
  const bin = join(work, 'bin'); mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const family of o.bins ?? ['claude', 'codex']) makeFakeBin(bin, family)
  const family = o.family ?? 'codex'; const artifact = o.artifact ?? 'spec'; const depth = o.depth ?? 'normal'
  const s: RevisionFixture = { repo, work, bin, family, artifact, depth, origin: 'producer-run', review: 'review-run', session: randomUUID(),
    env: telemetryOff({ PATH: `${bin}:/usr/bin:/bin`, HOME: work, CLAUDE_CONFIG_DIR: join(work, 'claude'), CODEX_HOME: join(work, 'codex'),
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'human-session', FAKE_MODE: 'document-script', FAKE_CALLS_FILE: join(work, 'calls'), FAKE_DOCUMENT_SCRIPT: join(work, 'script.json') }),
    selection: { kind: artifact, artifact: `.plans/f/${artifact}.md`, inputs: artifact === 'spec' ? [{ role: 'request', path: 'request.md' }]
      : artifact === 'plan' ? [{ role: 'spec', path: '.plans/f/spec.md' }] : [{ role: 'spec', path: '.plans/f/spec.md' }, { role: 'plan', path: '.plans/f/plan.md' }], context: ['context.md'] },
  }
  assertProviders(s)
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'a.ts'), 'export const result = 1\n')
  writeFileSync(join(repo, '.gitignore'), '.sdd-ai/\n.plans/\n')
  execFileSync('git', ['add', '.gitignore', 'src/a.ts'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], { cwd: repo })
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [claude, codex]\n  selection: full\n')
  mkdirSync(join(repo, '.plans', 'f'), { recursive: true })
  const approved = o.approved ?? true
  writeFileSync(flowFile(s, 'handoff.md'), `---\nphase: specify\nprofundidad: ${depth}\nrisk: high\nchange_type: feat\nbranch: ${branch}\nspec_approved_at: ${approved ? '2026-10-10T00:00:00Z' : 'null'}\n---\n\n# Handoff\n\nContexto del conductor.\n`)
  const header = { id: 'f', branch, base_commit: base, change_type: 'feat' as const, profundidad: depth, risk: 'high' as const,
    status: 'planned' as const, created_at: '2026-10-10T00:00:00Z' }
  writeFileSync(flowFile(s, 'spec.md'), `${o.header ? '---\nstatus: original\n---\n\n' : ''}${renderSpec(contracts.spec as SpecifyContract)}`)
  const plan = renderPlan(contracts.plan as PlanContract, header, ['AC-1'])
  writeFileSync(flowFile(s, 'plan.md'), approved ? plan.replace('status: planned', 'status: tasks-ready') : plan)
  writeFileSync(flowFile(s, 'tasks.md'), `${o.header ? '---\nstatus: original\n---\n\n' : ''}${renderTasks(contracts.tasks as TasksContract)}`)
  writeFileSync(join(repo, 'request.md'), 'Publica un resultado.\n'); writeFileSync(join(repo, 'context.md'), 'El resultado es observable.\n')
  const step = artifact === 'spec' ? 'specify' : artifact
  const dir = dirname(runFile(s, s.origin, 'request.json')); mkdirSync(dir, { recursive: true })
  const task = { cwd: repo, promptFile: join(dir, 'prompt.md'), resultFile: join(dir, 'result.md'), sessionId: s.session, model: 'fake-model', effort: 'high' as const }
  const launch = family === 'claude' ? claudeLaunch(task) : codexLaunch(task)
  const sources = s.selection.inputs.map((i) => {
    const bytes = readFileSync(join(repo, i.path)); writeFileSync(join(dir, `${i.role}.md`), bytes)
    return { path: i.path, digest: bytesHash(bytes), copy: `.sdd-ai/runs/${s.origin}/${i.role}.md`, role: i.role }
  })
  put(join(dir, 'request.json'), { kind: 'phase', flow: 'f', step })
  put(join(dir, 'resolved.json'), { family, via: 'process', model: 'fake-model', effort: 'high', origin: { model: 'workers', effort: 'workers' } })
  put(join(dir, 'argv.json'), { family, launch, phase: { flow: 'f', step, task_actors: true, criteria: ['AC-1'], inputs: Object.fromEntries(sources.map((r) => [r.role, r.digest])), plan_header: header } })
  put(join(dir, 'contract.json'), contracts[artifact]); put(join(dir, 'producer.json'), { launch, session_id: s.session })
  put(join(dir, 'phase.json'), { outcome: 'published', artifact: s.selection.artifact }); put(join(dir, 'status.json'), { state: 'done', session_id: s.session })
  if (family === 'claude') writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR, s.session, [])
  else writeCodexRollout(s.env.CODEX_HOME, s.session, [])
  saveRecord(s, { schema_version: 1, last_run: { id: s.origin, step }, phases: {}, documents: { [step]: {
    phase: step, artifact: s.selection.artifact, run: s.origin, family, launch, session_id: s.session, sources, amendments: [], task_actors: true,
  } } })
  const reviewDir = dirname(runFile(s, s.review, 'request.json')); mkdirSync(reviewDir, { recursive: true })
  // `review start` guarda la selección con rutas absolutas; el fixture escribe la misma forma que el binario real.
  const abs = (p: string) => join(s.repo, p)
  const selection = { ...s.selection, artifact: abs(s.selection.artifact), inputs: s.selection.inputs.map((i) => ({ ...i, path: abs(i.path) })),
    context: s.selection.context.map(abs) }
  put(join(reviewDir, 'request.json'), { kind: 'review', flow: 'f', selection, author: family, degradations: [] })
  put(join(reviewDir, 'resolved.json'), { family: family === 'codex' ? 'claude' : 'codex', via: 'process', origin: { model: 'heredado', effort: 'heredado' } })
  refreshReview(s)
  script(s, [{ answer: JSON.stringify(corrected(artifact)) }])
  return s
}
export async function cleanup(s: RevisionFixture): Promise<void> {
  // El registro puede estar roto: se consultan todas las corridas, también las de creación.
  try {
    for (const run of readdirSync(join(s.repo, '.sdd-ai', 'runs'))) {
      try {
        const status = json<{ state: string; supervisor_pid?: number; worker_pid?: number }>(runFile(s, run, 'status.json'))
        // Los estados activos fabricados no tienen un proceso que atienda cancel ni escriba el terminal.
        const launched = status.supervisor_pid !== undefined || status.worker_pid !== undefined || existsSync(runFile(s, run, 'supervisor.pid'))
        if (launched && ['launching', 'running'].includes(status.state)) { cli(s, ['cancel', run]); await settle(s, run) }
      } catch { /* La limpieza no reemplaza el diagnóstico de la prueba. */ }
    }
  } catch { /* El caso pudo haber retirado el directorio de corridas. */ }
  try { rmSync(s.repo, { recursive: true, force: true }) } finally { rmSync(s.work, { recursive: true, force: true }) }
}
