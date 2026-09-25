import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  type Candidate, type Selection, changedRanges, freeze, freezeStable, readContext, snapshot,
} from './review/candidate.ts'
import { type Ledger, type RoundPlan, axesOf, decide, targets, undecided } from './review/ledger.ts'
import { checkBudget, renderMaterial, renderReviewPrompt, renderRoundPrompt } from './review/prompt.ts'
import { createRun, isAlive, newRunId, readJson, readStatus, runDir, setStatus, writeJsonAtomic } from './runs.ts'
import { type ArgvFile, type RoundRecord, supervise, writeReceipt } from './supervisor.ts'
import {
  type Conductor, type Family, type LaunchSpec, type Profile, READ_ONLY_ROLES, RETIRED_ROLES, type RejectedField, type RetryInfo,
  type Resolution, SddError, type Status, TERMINAL, type WorkerTask, isFamily, isReadOnlyRole, opposite, toNativeEffort,
} from './types.ts'
import { REFUTER_SYSTEM_PROMPT, claudeLaunch, claudeReviewLaunch } from './workers/claude.ts'
import { codexLaunch, codexReviewLaunch } from './workers/codex.ts'

type Env = Record<string, string | undefined>
interface Result { code: number; out: unknown }

const PKG_DIR = resolvePath(import.meta.dirname, '..')
const BIN_PATH = join(PKG_DIR, 'bin', 'sdd-ai')
const FAMILIES: Family[] = ['claude', 'codex']
/** Rondas de una revisión antes del checkpoint; cada `--extra` concede una más. */
const ROUND_CAP = 3

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
  const renamed = RETIRED_ROLES.get(values.role)
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
function launchSupervisor(dir: string, argv: ArgvFile, env: Env, fallback?: Conductor, argvName = 'argv.json'): void {
  writeJsonAtomic(join(dir, argvName), argv)
  setStatus(dir, fallback ? { state: 'launching', fallback } : { state: 'launching' })
  const supervisor = spawn(process.execPath, [BIN_PATH, '__supervise', dir, argvName], { detached: true, stdio: 'ignore', env: definedEnv(env) })
  supervisor.unref()
  // En un archivo propio y no en status.json: el supervisor ya puede estar escribiendo ese estado.
  if (supervisor.pid !== undefined) writeFileSync(join(dir, 'supervisor.pid'), String(supervisor.pid))
}

interface ReviewRequest {
  kind: 'review'; selection: Selection; author: Family; degradations: string[]
  overrides?: { families?: string; model?: string; effort?: string; deadline_sec?: number }
}

/** Revisor y refutador de una ronda, cada uno con su sesión y su directorio vacío. */
function reviewLaunches(root: string, dir: string, tag: string, reviewer: Resolution, refuter: Resolution): { launch: LaunchSpec; refuter_launch: LaunchSpec } {
  const task = (name: string, p: Resolution): WorkerTask & { scratch: string } => {
    const t: WorkerTask & { scratch: string } = {
      cwd: root, promptFile: join(dir, `prompt${name}.md`), resultFile: join(dir, `result${name}.md`), sessionId: randomUUID(),
      scratch: mkdtempSync(join(tmpdir(), 'sdd-ai-review-')),
    }
    if (p.model) t.model = p.model
    if (p.effort) t.effort = p.effort
    return t
  }
  const r = task(tag, reviewer)
  const f = task(`${tag}-refute`, refuter)
  return {
    launch: reviewer.family === 'claude' ? claudeReviewLaunch(r) : codexReviewLaunch(r),
    refuter_launch: refuter.family === 'claude' ? claudeReviewLaunch({ ...f, systemPrompt: REFUTER_SYSTEM_PROMPT }) : codexReviewLaunch(f),
  }
}

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
  const workers = loadWorkers(root)
  const codexRoot = loadCodexRoot(env)
  // El autor ocupa el lugar del conductor: la familia opuesta a él es la que revisa.
  const resolution = resolve({ conductor: { family: author }, families, workers, role: 'code-review', flags, codexRoot })
  const family = resolution.family
  const degradations = family === author ? ['same_family'] : []
  // El refutador es de la familia del revisor, con el perfil de su propio rol.
  const refuter = resolve({ conductor: { family: opposite(family) }, families: [family], workers, role: 'refute', flags: {}, codexRoot })

  const selection: Selection = { base: values.base, context: values.context.map((p) => (isAbsolute(p) ? p : resolvePath(cwd, p))) }
  if (values.head) selection.head = values.head
  const candidate = freezeStable(root, selection)
  const contextTexts = readContext(root, candidate)
  const prompt = renderReviewPrompt(candidate, contextTexts)
  checkBudget(prompt)
  if (!inPath(family, env)) {
    throw new SddError('cli_missing', `${family} no está en PATH`, { next: `revisa con --families ${opposite(family)} y acepta la degradación` })
  }

  const id = newRunId()
  const dir = createRun(root, id)
  writeFileSync(join(dir, 'prompt.md'), prompt)
  writeJsonAtomic(join(dir, 'candidate.json'), candidate)
  const request: ReviewRequest & Record<string, unknown> = {
    kind: 'review', selection, author, degradations, conductor,
    overrides: { families: values.families, model: values.model, effort: values.effort, deadline_sec: deadline },
  }
  writeJsonAtomic(join(dir, 'request.json'), request)
  writeJsonAtomic(join(dir, 'resolved.json'), resolution)
  writeJsonAtomic(join(dir, 'resolved-refute.json'), refuter)
  writeFileSync(join(dir, 'material.md'), renderMaterial(candidate, contextTexts))
  snapshot(root, candidate, dir)

  const { launch, refuter_launch } = reviewLaunches(root, dir, '', resolution, refuter)
  launchSupervisor(dir, {
    family, launch, deadline_sec: deadline, kind: 'review', candidate: join(dir, 'candidate.json'),
    round: 1, tag: '', material: join(dir, 'material.md'), refuter_launch,
  }, env)
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
 * se movió; sin `--head`, reconstruye con la misma base y el mismo contexto sobre el árbol. Si la
 * reconstrucción falla, cuenta como `stale`.
 */
function freshness(root: string, req: ReviewRequest, c: Candidate, head: string | undefined): { stale: boolean; ref_moved?: boolean } {
  try {
    if (c.head_sha) {
      const again = freeze(root, { base: c.base_sha, head: c.head_sha, context: req.selection.context })
      const moved = !resolvesTo(root, head, c.head_sha) || !resolvesTo(root, req.selection.base, c.base_sha)
      return { stale: again.hash !== c.hash, ref_moved: moved }
    }
    return { stale: freeze(root, { base: req.selection.base, context: req.selection.context }).hash !== c.hash }
  } catch {
    return { stale: true }
  }
}

const tagOf = (n: number) => (n === 1 ? '' : `-r${n}`)

/** El ref que revisó la ronda `n`: el de `review start` en la 1, el de su `round-r<n>.json` después. */
function headOf(dir: string, req: ReviewRequest, n: number): string | undefined {
  if (n === 1) return req.selection.head
  const file = join(dir, `round${tagOf(n)}.json`)
  return existsSync(file) ? readJson<RoundPlan>(file).head : undefined
}

/**
 * El paso siguiente, por prioridad: esperar, relanzar una ronda que no terminó, decidir, preguntar
 * por las disputas, el checkpoint del tope, corregir y lanzar, y por último la vigencia.
 */
function roundNext(id: string, dir: string, req: ReviewRequest, s: Status, round: number, ledger: Ledger, stale: boolean): string {
  if (!TERMINAL.has(s.state)) return `./bin/sdd-ai wait ${id}`
  if (s.state !== 'done') {
    const head = headOf(dir, req, round)
    const parts = [`./bin/sdd-ai review round ${id}`]
    if (head) parts.push(`--head ${shellArg(head)}`)
    if (ledger.completed >= ROUND_CAP) parts.push('--extra')
    return `la ronda ${round} terminó en ${s.state}; pregunta al usuario si la relanza: ${parts.join(' ')}`
  }
  const disputes = ledger.entries.filter((e) => e.state === 'en-disputa').map((e) => e.id)
  const pending = undecided(ledger).filter((x) => !disputes.includes(x))
  if (pending.length > 0) {
    return `decide cada hallazgo (${pending.join(', ')}): ./bin/sdd-ai review decide ${id} accept <F-n>… para corregirlo, o reject <F-n>… --reason "<motivo verificable>"`
  }
  if (disputes.length > 0) {
    return `pregunta al usuario por cada disputa (${disputes.join(', ')}): aceptar el hallazgo (./bin/sdd-ai review decide ${id} accept <F-n>) o mantener el rechazo (./bin/sdd-ai review decide ${id} reject <F-n> --reason "<motivo>")`
  }
  const goals = targets(ledger)
  if (goals.length > 0 && ledger.completed >= ROUND_CAP) {
    return `se completaron ${ledger.completed} rondas y quedan hallazgos vigentes: pregunta al usuario si quiere una ronda más (./bin/sdd-ai review round ${id} --extra) o dejar la revisión como está`
  }
  const verify = goals.filter((t) => t.kind === 'verify').map((t) => t.id)
  if (verify.length > 0) return `corrige los aceptados (${verify.join(', ')}) y lanza ./bin/sdd-ai review round ${id}`
  if (goals.length > 0) return `lanza ./bin/sdd-ai review round ${id} para que el revisor responda los rechazos`
  if (stale) return `el diff cambió desde la revisión; revisa de nuevo: ${restartCommand(req)}`
  return 'la revisión está vigente; el recibo informa y no autoriza commit ni push'
}

interface Receipt { tool_events: string[]; degradations: string[]; reviewer: { model_effective: string | null } }

/** Lo que el conductor necesita de una revisión: estado, revisor, ledger, ejes, vigencia y el paso siguiente. */
function reviewView(root: string, id: string, dir: string, s: Status): Result {
  const req = readJson<ReviewRequest>(join(dir, 'request.json'))
  const resolved = readJson<Resolution>(join(dir, 'resolved.json'))
  const round = s.round ?? 1
  const reviewer = { family: resolved.family, model: resolved.model ?? null, effort: resolved.effort ?? null }
  const code = s.state === 'done' || !TERMINAL.has(s.state) ? 0 : 1
  const common: Record<string, unknown> = {}
  if (s.reason) common.reason = s.reason
  if (s.detail) common.detail = s.detail
  const warnings = profileWarnings(s)
  if (warnings.length > 0) common.warnings = warnings
  if (s.resume) common.resume = s.resume

  const ledgerFile = join(dir, 'ledger.json')
  if (!existsSync(ledgerFile)) {
    const c = readJson<Candidate>(join(dir, 'candidate.json'))
    const out: Record<string, unknown> = {
      id, state: s.state, round, candidate_hash: c.hash, reviewer, degradations: req.degradations,
      ...freshness(root, req, c, req.selection.head), ...common,
    }
    if (!TERMINAL.has(s.state)) out.next = `./bin/sdd-ai wait ${id}`
    else if (out.stale === true) out.next = `el diff cambió desde la revisión; revisa de nuevo: ${restartCommand(req)}`
    else out.next = `pregunta al usuario si revisa de nuevo: ${restartCommand(req)}`
    return { code, out }
  }

  const ledger = readJson<Ledger>(ledgerFile)
  const c = readJson<Candidate>(join(dir, `candidate${tagOf(ledger.completed)}.json`))
  const receipt = readJson<Receipt>(join(dir, 'receipt.json'))
  const rounds = existsSync(join(dir, 'rounds.json')) ? readJson<{ rounds: RoundRecord[] }>(join(dir, 'rounds.json')).rounds : []
  const fresh = freshness(root, req, c, headOf(dir, req, ledger.completed))
  const disputes = ledger.entries.filter((e) => e.state === 'en-disputa').map((e) => e.id)
  const out: Record<string, unknown> = {
    id, state: s.state, round, completed: ledger.completed, candidate_hash: c.hash,
    reviewer: { ...reviewer, model_effective: receipt.reviewer.model_effective },
    degradations: receipt.degradations, ...fresh,
    axes: axesOf(ledger), ledger: ledger.entries,
    pending: undecided(ledger).filter((x) => !disputes.includes(x)), disputes,
    refuted: ledger.entries.filter((e) => e.state === 'refutado').map((e) => e.id),
    inconclusive: ledger.entries.filter((e) => e.state !== 'refutado' && e.refutation?.result === 'inconclusive').map((e) => e.id),
    tool_events: rounds.filter((r) => r.state === 'done').at(-1)?.tool_events ?? receipt.tool_events,
    ...common,
    next: roundNext(id, dir, req, s, round, ledger, fresh.stale),
  }
  return { code, out }
}

/** Registra la decisión del conductor (o de la persona, en una disputa) y devuelve la vista actualizada. */
function reviewDecide(args: string[], cwd: string): Result {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { reason: { type: 'string' } } })
  const [id, action, ...ids] = positionals
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai review decide <id> accept|reject <F-n>… [--reason <motivo>]' })
  const root = repoRoot(cwd)
  const dir = runDir(root, id)
  if (!TERMINAL.has(readStatus(dir).state)) {
    throw new SddError('usage', 'la ronda está en curso: se decide cuando termine', { next: `./bin/sdd-ai wait ${id}` })
  }
  const file = join(dir, 'ledger.json')
  if (!existsSync(file)) throw new SddError('usage', 'la revisión no tiene hallazgos admitidos que decidir', { next: `./bin/sdd-ai review status ${id}` })
  if (action !== 'accept' && action !== 'reject') {
    throw new SddError('usage', `acción desconocida: ${action ?? ''}`, { next: 'usa accept o reject' })
  }
  writeJsonAtomic(file, decide(readJson<Ledger>(file), action, ids, values.reason))
  writeReceipt(dir)
  return reviewView(root, id, dir, readStatus(dir))
}

/**
 * La ronda siguiente: congela el candidato corregido con la base y el contexto de la ronda 1 y lanza
 * la pasada dirigida con el mismo revisor, en una sesión nueva. Todo lo que puede impedirla se
 * comprueba antes de escribir un archivo de la ronda.
 */
async function reviewRound(args: string[], env: Env, cwd: string): Promise<Result> {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true, options: { head: { type: 'string' }, extra: { type: 'boolean', default: false } },
  })
  const id = positionals[0]
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai review round <id> [--head <ref>] [--extra]' })
  if (env.SDD_AI_WORKER === '1') {
    throw new SddError('recursion', 'sdd-ai no se lanza desde un worker', { next: 'responde el encargo sin delegar' })
  }
  const root = repoRoot(cwd)
  const dir = runDir(root, id)
  if (!TERMINAL.has(readStatus(dir).state)) {
    throw new SddError('usage', 'la ronda anterior sigue en curso', { next: `./bin/sdd-ai wait ${id}` })
  }
  const req = readJson<ReviewRequest>(join(dir, 'request.json'))
  const ledgerFile = join(dir, 'ledger.json')
  if (!existsSync(ledgerFile)) {
    throw new SddError('usage', 'la revisión no tiene una ronda 1 completada', { next: `pregunta al usuario si revisa de nuevo: ${restartCommand(req)}` })
  }
  const ledger = readJson<Ledger>(ledgerFile)
  if (values.extra && ledger.completed < ROUND_CAP) {
    throw new SddError('usage', `--extra solo concede una ronda más allá del tope de ${ROUND_CAP}; esta revisión completó ${ledger.completed}`, {
      next: `./bin/sdd-ai review round ${id}`,
    })
  }
  const pending = undecided(ledger)
  if (pending.length > 0) {
    throw new SddError('usage', `hay hallazgos sin decidir: ${pending.join(', ')}`, {
      next: `./bin/sdd-ai review decide ${id} accept|reject ${pending.join(' ')} [--reason <motivo>]`,
    })
  }
  const goals = targets(ledger)
  if (goals.length === 0) {
    throw new SddError('usage', 'no hay nada que verificar ni responder', { next: `./bin/sdd-ai review status ${id}` })
  }
  if (ledger.completed >= ROUND_CAP && !values.extra) {
    throw new SddError('round_cap', `la revisión ya hizo ${ROUND_CAP} rondas y quedan hallazgos vigentes`, {
      next: `pregunta al usuario si quiere una ronda más (./bin/sdd-ai review round ${id} --extra) o dejar la revisión como está`,
    })
  }

  const n = ledger.completed + 1
  const tag = `-r${n}`
  const prev = readJson<Candidate>(join(dir, `candidate${ledger.completed === 1 ? '' : `-r${ledger.completed}`}.json`))
  const first = readJson<Candidate>(join(dir, 'candidate.json'))
  const selection: Selection = { base: first.base_sha, context: req.selection.context }
  if (values.head) selection.head = values.head
  const candidate = freezeStable(root, selection)
  const identical = candidate.hash === prev.hash
  if (identical && goals.some((t) => t.kind === 'verify')) {
    throw new SddError('usage', 'el candidato es idéntico al de la ronda anterior y hay aceptados que verificar', {
      next: 'corrige los aceptados antes de lanzar la ronda siguiente',
    })
  }
  // Los blobs son lo único que se escribe antes de las últimas comprobaciones: la comparación con la
  // ronda anterior los necesita. Si la ronda no se lanza, se quitan.
  const written = snapshot(root, candidate, dir)
  let plan: RoundPlan
  let material: string
  let prompt: string
  const resolved = readJson<Resolution>(join(dir, 'resolved.json'))
  try {
    plan = { n, prev_hash: prev.hash, identical, targets: goals, changed: identical ? {} : changedRanges(prev, candidate, dir) }
    if (values.head) plan.head = values.head
    material = renderMaterial(candidate, readContext(root, candidate))
    prompt = renderRoundPrompt(candidate, material, plan, ledger.entries, ROUND_CAP)
    checkBudget(prompt)
    if (!inPath(resolved.family, env)) {
      throw new SddError('cli_missing', `${resolved.family} no está en PATH`, { next: 'instala o expone el CLI del revisor de la ronda 1' })
    }
  } catch (e) {
    for (const f of written) rmSync(f, { force: true })
    throw e
  }

  writeJsonAtomic(join(dir, `candidate${tag}.json`), candidate)
  writeFileSync(join(dir, `material${tag}.md`), material)
  writeFileSync(join(dir, `prompt${tag}.md`), prompt)
  writeJsonAtomic(join(dir, `round${tag}.json`), plan)
  const { launch, refuter_launch } = reviewLaunches(root, dir, tag, resolved, readJson<Resolution>(join(dir, 'resolved-refute.json')))
  // La ronda arranca con un estado limpio: nada de la anterior (motivo, reanudación, cancelación) la alcanza.
  writeJsonAtomic(join(dir, 'status.json'), { state: 'launching', round: n })
  rmSync(join(dir, 'cancel.request'), { force: true })
  launchSupervisor(dir, {
    family: resolved.family, launch, deadline_sec: req.overrides?.deadline_sec ?? 1800, kind: 'review',
    candidate: join(dir, `candidate${tag}.json`), round: n, tag, plan: join(dir, `round${tag}.json`),
    material: join(dir, `material${tag}.md`), refuter_launch, extra: values.extra,
  }, env, undefined, `argv${tag}.json`)
  return {
    code: 0,
    out: {
      id, round: n, family: resolved.family, candidate_hash: candidate.hash, identical, targets: goals,
      changed: Object.keys(plan.changed), left_out: candidate.left_out, next: `./bin/sdd-ai wait ${id}`,
    },
  }
}

async function review(args: string[], env: Env, cwd: string): Promise<Result> {
  const [sub, ...rest] = args
  if (sub === 'start') return reviewStart(rest, env, cwd)
  if (sub === 'decide') return reviewDecide(rest, cwd)
  if (sub === 'round') return reviewRound(rest, env, cwd)
  if (sub === 'status') {
    const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} })
    const id = positionals[0]
    if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai review status <id>' })
    const root = repoRoot(cwd)
    const dir = runDir(root, id)
    return reviewView(root, id, dir, readStatus(dir))
  }
  throw new SddError('usage', `subcomando desconocido: review ${sub ?? ''}`, { next: 'usa review start | status | decide | round' })
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
      case '__supervise': return { code: 0, out: await supervise(rest[0], rest[1]) }
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
