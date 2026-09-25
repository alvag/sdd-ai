import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { type RoleProfiles, agentName, agentsState, syncAgents } from './agents.ts'
import { detectConductor } from './conductor.ts'
import { effectiveFamilies, loadCrossModel, parseFamiliesFlag } from './config.ts'
import { doctor } from './doctor.ts'
import { repoRoot } from './git.ts'
import { loadCodexRoot, loadWorkers } from './profiles.ts'
import { nativeProfile, resolve } from './resolve.ts'
import type { Verdict } from './review/admit.ts'
import { type Candidate, type Selection, freeze, freezeStable, readContext } from './review/candidate.ts'
import { checkBudget, renderReviewPrompt } from './review/prompt.ts'
import { createRun, isAlive, newRunId, readJson, readStatus, runDir, setStatus, writeJsonAtomic } from './runs.ts'
import { type ArgvFile, supervise } from './supervisor.ts'
import {
  type Conductor, type Family, type Profile, READ_ONLY_ROLES, RETIRED_ROLES, type RejectedField, type RetryInfo,
  type Resolution, SddError, type Status, TERMINAL, type WorkerTask, isFamily, isReadOnlyRole, opposite, toNativeEffort,
} from './types.ts'
import { claudeLaunch, claudeReviewLaunch } from './workers/claude.ts'
import { codexLaunch, codexReviewLaunch } from './workers/codex.ts'

type Env = Record<string, string | undefined>
interface Result { code: number; out: unknown }

const PKG_DIR = resolvePath(import.meta.dirname, '..')
const BIN_PATH = join(PKG_DIR, 'bin', 'sdd-ai')
const FAMILIES: Family[] = ['claude', 'codex']

/** Tope por defecto de `wait`, por debajo del timeout del shell de cada conductor. */
export function defaultWaitMax(conductor: Family): number {
  return conductor === 'codex' ? 100 : 540
}

function inPath(cmd: string, env: Env): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return true
    } catch {
      // Sigue con el próximo directorio.
    }
  }
  return false
}

function definedEnv(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
}

function nativeProfiles(root: string, env: Env): RoleProfiles {
  const workers = loadWorkers(root)
  const codexRoot = loadCodexRoot(env)
  const entries = READ_ONLY_ROLES.map((role) => [role, {
    claude: nativeProfile('claude', role, workers, codexRoot), codex: nativeProfile('codex', role, workers, codexRoot),
  }])
  return Object.fromEntries(entries) as RoleProfiles
}

/** La caída propone la familia, el modelo y el esfuerzo del conductor; el usuario decide. */
function fallbackNext(id: string, c: Conductor): string {
  const args = [`--retry ${id}`, `--families ${c.family}`, `--conductor ${c.family}`]
  if (c.model) args.push(`--model ${c.model}`)
  if (c.effort) args.push(`--effort ${c.effort}`)
  return `pregunta al usuario si cae a ${c.family}; solo con un sí: ./bin/sdd-ai run ${args.join(' ')}`
}

async function run(args: string[], env: Env, cwd: string): Promise<Result> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      'prompt-file': { type: 'string' },
      role: { type: 'string', default: 'explore' },
      families: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      conductor: { type: 'string' },
      'conductor-model': { type: 'string' },
      'conductor-effort': { type: 'string' },
      deadline: { type: 'string', default: '600' },
      retry: { type: 'string' },
    },
  })
  if (env.SDD_AI_WORKER === '1') {
    throw new SddError('recursion', 'sdd-ai no se lanza desde un worker', { next: 'responde el encargo sin delegar' })
  }
  const renamed = RETIRED_ROLES[values.role]
  if (renamed) throw new SddError('usage', `el rol \`${values.role}\` ahora se llama \`${renamed}\``, { next: `usa --role ${renamed}` })
  if (values.role === 'implement') {
    throw new SddError('usage', 'el rol implement necesita un worker que escriba, y sdd-ai todavía solo tiene workers de solo lectura', {
      next: `usa uno de: ${READ_ONLY_ROLES.join(', ')}`,
    })
  }
  if (!isReadOnlyRole(values.role)) throw new SddError('usage', `rol desconocido: ${values.role}`, { next: `usa uno de: ${READ_ONLY_ROLES.join(', ')}` })
  const role = values.role
  const deadline = Number(values.deadline)
  if (!Number.isFinite(deadline) || deadline <= 0) throw new SddError('usage', `--deadline inválido: ${values.deadline}`)

  const root = repoRoot(cwd)
  const conductor = detectConductor(env, {
    conductor: values.conductor, conductorModel: values['conductor-model'], conductorEffort: values['conductor-effort'],
  })
  const config = loadCrossModel(root, FAMILIES.filter((f) => inPath(f, env)))
  const families = effectiveFamilies(config.families, values.families ? parseFamiliesFlag(values.families) : undefined)
  const workers = loadWorkers(root)
  const codexRoot = loadCodexRoot(env)
  const flags: Profile = {}
  if (values.model) flags.model = values.model
  if (values.effort) flags.effort = toNativeEffort(values.effort)
  const resolution = resolve({ conductor, families, workers, role, flags, codexRoot })

  let prompt: string
  if (values.retry) {
    prompt = readFileSync(join(runDir(root, values.retry), 'prompt.md'), 'utf8')
  } else if (values['prompt-file']) {
    const file = isAbsolute(values['prompt-file']) ? values['prompt-file'] : resolvePath(cwd, values['prompt-file'])
    if (!existsSync(file)) throw new SddError('usage', `no existe el archivo del encargo: ${file}`)
    prompt = readFileSync(file, 'utf8')
  } else {
    throw new SddError('usage', 'falta el encargo', { next: 'pasa --prompt-file <archivo> o --retry <id>' })
  }

  const id = newRunId()
  const dir = createRun(root, id)
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, prompt)
  writeJsonAtomic(join(dir, 'request.json'), {
    role, conductor, retry_of: values.retry,
    overrides: { families: values.families, model: values.model, effort: values.effort, deadline_sec: deadline },
  })
  writeJsonAtomic(join(dir, 'resolved.json'), resolution)

  if (resolution.via === 'native') {
    const profiles = nativeProfiles(root, env)
    const state = agentsState(root, PKG_DIR, resolution.family, role, profiles)
    if (state !== 'ok') {
      const detail = state === 'missing' ? 'no existe el agente generado' : 'el agente generado no coincide con sus fuentes'
      setStatus(dir, { state: 'launch_failed', reason: 'agents_stale', detail })
      return { code: 1, out: { id, state: 'launch_failed', reason: 'agents_stale', detail, next: './bin/sdd-ai agents sync y reabrir la sesión' } }
    }
    setStatus(dir, { state: 'delegated' })
    const out: Record<string, unknown> = { id, via: 'native', family: resolution.family, agent: agentName(role), prompt_file: promptFile }
    // El agente generado trae el perfil de su rol. Lo que la corrida resolvió distinto (un override, la
    // caída al conductor) viaja para que el conductor lo pase a su herramienta.
    const agent = profiles[role][resolution.family]
    const warnings: string[] = []
    if (resolution.model !== undefined && resolution.model !== agent.model) out.model = resolution.model
    if (resolution.effort !== undefined && resolution.effort !== agent.effort) {
      if (resolution.family === 'claude') {
        warnings.push(`Claude Code no permite fijar el esfuerzo de un subagente por llamada: el worker usa ${agent.effort ?? 'el esfuerzo por defecto'} y no ${resolution.effort}`)
      } else {
        out.effort = resolution.effort
      }
    }
    if (warnings.length > 0) out.warnings = warnings
    return { code: 0, out }
  }

  if (!inPath(resolution.family, env)) {
    const detail = `${resolution.family} no está en PATH`
    setStatus(dir, { state: 'launch_failed', reason: 'cli_missing', detail, fallback: conductor })
    return { code: 1, out: { id, state: 'launch_failed', reason: 'cli_missing', detail, fallback: conductor, next: fallbackNext(id, conductor) } }
  }

  const task: WorkerTask = { cwd: root, promptFile, resultFile: join(dir, 'result.md'), sessionId: randomUUID() }
  if (resolution.model) task.model = resolution.model
  if (resolution.effort) task.effort = resolution.effort
  const launch = resolution.family === 'claude' ? claudeLaunch(task) : codexLaunch(task)
  launchSupervisor(dir, { family: resolution.family, launch, deadline_sec: deadline }, env, conductor)
  return { code: 0, out: { id, via: 'process', family: resolution.family } }
}

/** Deja la corrida en `launching` y lanza al supervisor desprendido, que sobrevive al shell del conductor. */
function launchSupervisor(dir: string, argv: ArgvFile, env: Env, fallback?: Conductor): void {
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  setStatus(dir, fallback ? { state: 'launching', fallback } : { state: 'launching' })
  const supervisor = spawn(process.execPath, [BIN_PATH, '__supervise', dir], { detached: true, stdio: 'ignore', env: definedEnv(env) })
  supervisor.unref()
  // En un archivo propio y no en status.json: el supervisor ya puede estar escribiendo ese estado.
  if (supervisor.pid !== undefined) writeFileSync(join(dir, 'supervisor.pid'), String(supervisor.pid))
}

interface ReviewRequest { kind: 'review'; selection: Selection; author: Family; degradations: string[] }

/**
 * Congela el candidato, arma el prompt y lanza al revisor por proceso, siempre aislado y de la familia
 * opuesta al autor si la config la incluye. Vuelve enseguida: la admisión corre en el supervisor.
 */
async function reviewStart(args: string[], env: Env, cwd: string): Promise<Result> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      context: { type: 'string', multiple: true, default: [] },
      author: { type: 'string' },
      families: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      conductor: { type: 'string' },
      'conductor-model': { type: 'string' },
      'conductor-effort': { type: 'string' },
      deadline: { type: 'string', default: '1800' },
    },
  })
  if (env.SDD_AI_WORKER === '1') {
    throw new SddError('recursion', 'sdd-ai no se lanza desde un worker', { next: 'responde el encargo sin delegar' })
  }
  if (!values.base) throw new SddError('usage', 'falta --base', { next: './bin/sdd-ai review start --base <ref> [--head <ref>] [--context <ruta>]' })
  const deadline = Number(values.deadline)
  if (!Number.isFinite(deadline) || deadline <= 0) throw new SddError('usage', `--deadline inválido: ${values.deadline}`)

  const root = repoRoot(cwd)
  const conductor = detectConductor(env, {
    conductor: values.conductor, conductorModel: values['conductor-model'], conductorEffort: values['conductor-effort'],
  })
  if (values.author !== undefined && !isFamily(values.author)) throw new SddError('usage', `--author inválido: ${values.author}`, { next: 'usa claude o codex' })
  const author: Family = values.author ?? conductor.family
  const config = loadCrossModel(root, FAMILIES.filter((f) => inPath(f, env)))
  const families = effectiveFamilies(config.families, values.families ? parseFamiliesFlag(values.families) : undefined)
  const flags: Profile = {}
  if (values.model) flags.model = values.model
  if (values.effort) flags.effort = toNativeEffort(values.effort)
  // El autor ocupa el lugar del conductor: la familia opuesta a él es la que revisa.
  const resolution = resolve({
    conductor: { family: author }, families, workers: loadWorkers(root), role: 'code-review', flags, codexRoot: loadCodexRoot(env),
  })
  const family = resolution.family
  const degradations = family === author ? ['same_family'] : []

  const selection: Selection = { base: values.base, context: values.context.map((p) => (isAbsolute(p) ? p : resolvePath(cwd, p))) }
  if (values.head) selection.head = values.head
  const candidate = freezeStable(root, selection)
  const prompt = renderReviewPrompt(candidate, readContext(root, candidate))
  checkBudget(prompt)
  if (!inPath(family, env)) {
    throw new SddError('cli_missing', `${family} no está en PATH`, { next: `revisa con --families ${opposite(family)} y acepta la degradación` })
  }

  const id = newRunId()
  const dir = createRun(root, id)
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, prompt)
  writeJsonAtomic(join(dir, 'candidate.json'), candidate)
  const request: ReviewRequest & Record<string, unknown> = {
    kind: 'review', selection, author, degradations, conductor,
    overrides: { families: values.families, model: values.model, effort: values.effort, deadline_sec: deadline },
  }
  writeJsonAtomic(join(dir, 'request.json'), request)
  writeJsonAtomic(join(dir, 'resolved.json'), resolution)

  const task: WorkerTask & { scratch: string } = {
    cwd: root, promptFile, resultFile: join(dir, 'result.md'), sessionId: randomUUID(),
    scratch: mkdtempSync(join(tmpdir(), 'sdd-ai-review-')),
  }
  if (resolution.model) task.model = resolution.model
  if (resolution.effort) task.effort = resolution.effort
  const launch = family === 'claude' ? claudeReviewLaunch(task) : codexReviewLaunch(task)
  launchSupervisor(dir, { family, launch, deadline_sec: deadline, kind: 'review', candidate: join(dir, 'candidate.json') }, env)
  return {
    code: 0,
    out: {
      id, via: 'process', family, degradations, candidate_hash: candidate.hash,
      files: candidate.files.map((f) => f.path), left_out: candidate.left_out, next: `./bin/sdd-ai wait ${id}`,
    },
  }
}

/** Un argumento listo para pegar en la shell: tal cual si es seguro, entre comillas simples si no. */
function shellArg(s: string): string {
  return /^[\w./@:+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`
}

function restartCommand(req: ReviewRequest): string {
  const parts = ['./bin/sdd-ai review start', `--base ${shellArg(req.selection.base)}`]
  if (req.selection.head) parts.push(`--head ${shellArg(req.selection.head)}`)
  for (const c of req.selection.context) parts.push(`--context ${shellArg(c)}`)
  parts.push(`--author ${req.author}`)
  return parts.join(' ')
}

function resolvesTo(root: string, ref: string | undefined, sha: string | null): boolean {
  if (!ref || !sha) return true
  try {
    return freeze(root, { base: ref, context: [] }).base_sha === sha
  } catch {
    return false
  }
}

/**
 * Vigencia del candidato: con `--head`, reconstruye con los SHAs congelados y solo informa si el ref
 * se movió; sin `--head`, reconstruye con la misma selección. Si la reconstrucción falla, cuenta como
 * `stale`.
 */
function freshness(root: string, req: ReviewRequest, c: Candidate): { stale: boolean; ref_moved?: boolean } {
  try {
    if (c.head_sha) {
      const again = freeze(root, { base: c.base_sha, head: c.head_sha, context: req.selection.context })
      const moved = !resolvesTo(root, req.selection.head, c.head_sha) || !resolvesTo(root, req.selection.base, c.base_sha)
      return { stale: again.hash !== c.hash, ref_moved: moved }
    }
    return { stale: freeze(root, req.selection).hash !== c.hash }
  } catch {
    return { stale: true }
  }
}

/** Lo que el conductor necesita de una revisión: estado, revisor, veredicto, vigencia y el paso siguiente. */
function reviewView(root: string, id: string, dir: string, s: Status): Result {
  const req = readJson<ReviewRequest>(join(dir, 'request.json'))
  const c = readJson<Candidate>(join(dir, 'candidate.json'))
  const resolved = readJson<Resolution>(join(dir, 'resolved.json'))
  const out: Record<string, unknown> = {
    id, state: s.state, candidate_hash: c.hash,
    reviewer: { family: resolved.family, model: resolved.model ?? null, effort: resolved.effort ?? null },
    degradations: req.degradations, ...freshness(root, req, c),
  }
  if (s.reason) out.reason = s.reason
  if (s.detail) out.detail = s.detail
  const warnings = profileWarnings(s)
  if (warnings.length > 0) out.warnings = warnings
  if (s.state === 'done' && existsSync(join(dir, 'verdict.json'))) {
    const v = readJson<Verdict>(join(dir, 'verdict.json'))
    const receipt = readJson<{ tool_events: string[]; degradations: string[]; reviewer: { model_effective: string | null } }>(join(dir, 'receipt.json'))
    Object.assign(out, {
      reviewer: { ...(out.reviewer as object), model_effective: receipt.reviewer.model_effective },
      axes: { scope: v.scope, spec: v.spec, quality: v.quality }, findings: v.findings, out_of_scope: v.out_of_scope,
      tool_events: receipt.tool_events, degradations: receipt.degradations,
    })
  }
  if (!TERMINAL.has(s.state)) out.next = `./bin/sdd-ai wait ${id}`
  else if (out.stale === true) out.next = `el diff cambió desde la revisión; revisa de nuevo: ${restartCommand(req)}`
  else if (s.state === 'done') out.next = 'la revisión está vigente; el recibo informa y no autoriza commit ni push'
  else out.next = `pregunta al usuario si revisa de nuevo: ${restartCommand(req)}`
  return { code: s.state === 'done' || !TERMINAL.has(s.state) ? 0 : 1, out }
}

async function review(args: string[], env: Env, cwd: string): Promise<Result> {
  const [sub, ...rest] = args
  if (sub === 'start') return reviewStart(rest, env, cwd)
  if (sub === 'status') {
    const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} })
    const id = positionals[0]
    if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai review status <id>' })
    const root = repoRoot(cwd)
    const dir = runDir(root, id)
    return reviewView(root, id, dir, readStatus(dir))
  }
  throw new SddError('usage', `subcomando desconocido: review ${sub ?? ''}`, { next: 'usa review start | review status' })
}

/** PID que `run` anotó al lanzar el supervisor, para cubrir el tramo previo a `running`. */
function readSupervisorPid(dir: string): number | undefined {
  const file = join(dir, 'supervisor.pid')
  if (!existsSync(file)) return undefined
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

const FIELD_NAMES: Record<RejectedField, string> = { model: 'el modelo', effort: 'el esfuerzo' }

/** El reintento cambió el perfil pedido: el usuario tiene que verlo, con el diagnóstico tal cual. */
function retryWarning(r: RetryInfo): string {
  return `el CLI rechazó ${FIELD_NAMES[r.field]} ${r.requested}; se reintentó sin él (efectivo: ${r.effective}). Diagnóstico: ${r.diagnostic}`
}

function profileWarnings(s: Status): string[] {
  const warnings: string[] = []
  if (s.retry) warnings.push(retryWarning(s.retry))
  if (s.resume) warnings.push(`se agotó el tope; se reanudó la misma sesión una vez (${s.resume.outcome ?? 'en curso'})`)
  return warnings
}

function report(root: string, id: string, dir: string, s: Status): Result {
  const request = existsSync(join(dir, 'request.json')) ? readJson<{ kind?: string }>(join(dir, 'request.json')) : {}
  if (request.kind === 'review' && TERMINAL.has(s.state)) return reviewView(root, id, dir, s)
  const out: Record<string, unknown> = { id, state: s.state }
  if (s.reason) out.reason = s.reason
  if (s.detail) out.detail = s.detail
  if (s.session_id) out.session_id = s.session_id
  if (s.state === 'done') out.result = readFileSync(join(dir, s.result_file ?? 'result.md'), 'utf8')
  if (s.retry) out.retry = s.retry
  if (s.resume) out.resume = s.resume
  const warnings = profileWarnings(s)
  if (warnings.length > 0) out.warnings = warnings
  if (s.state === 'launch_failed' && s.fallback) {
    out.fallback = s.fallback
    out.next = fallbackNext(id, s.fallback)
  }
  return { code: s.state === 'done' || s.state === 'delegated' ? 0 : 1, out }
}

async function wait(args: string[], env: Env, cwd: string): Promise<Result> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { max: { type: 'string' } } })
  const id = positionals[0]
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai wait <id>' })
  const root = repoRoot(cwd)
  const dir = runDir(root, id)
  let max: number
  if (values.max !== undefined) {
    max = Number(values.max)
    if (!Number.isFinite(max) || max < 0) throw new SddError('usage', `--max inválido: ${values.max}`)
  } else {
    try {
      max = defaultWaitMax(detectConductor(env, {}).family)
    } catch {
      max = defaultWaitMax('codex')
    }
  }

  const until = Date.now() + max * 1000
  for (;;) {
    let s = readStatus(dir)
    if (TERMINAL.has(s.state)) return report(root, id, dir, s)
    const supervisorPid = s.supervisor_pid ?? readSupervisorPid(dir)
    if (supervisorPid !== undefined && !isAlive(supervisorPid)) {
      // El supervisor pudo escribir el estado final justo antes de terminar.
      s = readStatus(dir)
      if (TERMINAL.has(s.state)) return report(root, id, dir, s)
      s = setStatus(dir, { state: 'failed', reason: 'supervisor_lost', detail: `el supervisor ${supervisorPid} terminó sin escribir un estado final` })
      return report(root, id, dir, s)
    }
    if (Date.now() >= until) return { code: 3, out: { id, state: s.state, next: `./bin/sdd-ai wait ${id}` } }
    await sleep(250)
  }
}

function cancel(args: string[], cwd: string): Result {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} })
  const id = positionals[0]
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai cancel <id>' })
  const dir = runDir(repoRoot(cwd), id)
  const s = readStatus(dir)
  if (TERMINAL.has(s.state)) return { code: 0, out: { id, state: s.state } }
  writeFileSync(join(dir, 'cancel.request'), new Date().toISOString())
  if (s.worker_pid !== undefined) {
    try {
      process.kill(-s.worker_pid, 'SIGTERM')
    } catch {
      // El worker ya terminó; el supervisor verá cancel.request al cerrar.
    }
  }
  return { code: 0, out: { id, state: 'cancel_requested', next: `./bin/sdd-ai wait ${id}` } }
}

function agents(args: string[], env: Env, cwd: string): Result {
  if (args[0] !== 'sync') throw new SddError('usage', `subcomando desconocido: agents ${args[0] ?? ''}`, { next: './bin/sdd-ai agents sync' })
  const root = repoRoot(cwd)
  const { written, removed } = syncAgents(root, PKG_DIR, nativeProfiles(root, env))
  return { code: 0, out: { written, removed, next: 'reabre la sesión para que el CLI cargue los agentes y la skill' } }
}

export async function main(argv: string[], env: Env, cwd: string): Promise<Result> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case 'run': return await run(rest, env, cwd)
      case 'review': return await review(rest, env, cwd)
      case 'wait': return await wait(rest, env, cwd)
      case 'cancel': return cancel(rest, cwd)
      case 'agents': return agents(rest, env, cwd)
      case 'doctor': {
        const report = doctor()
        return { code: report.ok ? 0 : 1, out: report }
      }
      case '__supervise': return { code: 0, out: await supervise(rest[0]) }
      default:
        throw new SddError('usage', `comando desconocido: ${cmd ?? ''}`, { next: 'usa run | review | wait | cancel | agents sync | doctor' })
    }
  } catch (e) {
    if (e instanceof SddError) {
      return { code: e.code === 'run_not_found' ? 1 : 2, out: { state: 'error', code: e.code, message: e.message, detail: e.detail, next: e.next } }
    }
    if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      return { code: 2, out: { state: 'error', code: 'usage', message: (e as Error).message } }
    }
    throw e
  }
}
