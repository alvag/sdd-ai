import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { type RoleProfiles, agentName, agentsState, syncAgents } from './agents.ts'
import { detectConductor } from './conductor.ts'
import { effectiveFamilies, loadCrossModel, parseFamiliesFlag } from './config.ts'
import { doctor } from './doctor.ts'
import { repoRoot } from './git.ts'
import { cancelNative } from './native-launch.ts'
import { loadCodexRoot, loadWorkers } from './profiles.ts'
import { nativeProfile, resolve } from './resolve.ts'
import { renderArtifactMaterial, renderArtifactPrompt, renderArtifactRoundPrompt } from './review/artifact-prompt.ts'
import {
  type ArtifactSelection, artifactDelta, freezeArtifact, inputsUnchanged, isArtifact, validateArtifactArgs,
} from './review/artifact.ts'
import {
  type Candidate, type Selection, baseOf, changedRanges, freeze, freezeStable, freezeStableWith, readContext, snapshot,
} from './review/candidate.ts'
import { type PlannedJob, planJobs, planRoundJobs, sliceCandidate } from './review/batch.ts'
import {
  type Ledger, REVIEWERS, type Reviewer, type RoundPlan, axesOf, decide, targets, undecided, withProvenance,
} from './review/ledger.ts'
import { fits, renderMaterial, renderReviewPrompt } from './review/prompt.ts'
import { type Risk, type RiskRecord, classify, classifyDelta, readRisk } from './review/risk.ts'
import { createRun, isAlive, markDelivered, newRunId, ownerSession, readJson, readStatus, runDir, setStatus, writeJsonAtomic } from './runs.ts'
import {
  ARTIFACT_NOTE, type ArgvFile, type JobRecord, type ReviewJob, type RoundRecord, declaredBatches, jobSummary, supervise, writeReceipt,
} from './supervisor.ts'
import {
  type Conductor, type Family, type NativeProfile, type Profile, READ_ONLY_ROLES, RETIRED_ROLES, type RejectedField, type RetryInfo,
  type Resolution, SddError, type Status, TERMINAL, WEB_ROLES, type WorkerTask, isFamily, isReadOnlyRole, opposite, toNativeEffort,
} from './types.ts'
import { claudeLaunch } from './workers/claude.ts'
import { codexLaunch } from './workers/codex.ts'

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

/** Lo que `run` deja en `request.json` y un reintento vuelve a leer. */
interface RunRequest {
  role?: string; conductor?: Conductor
  overrides?: { families?: string; model?: string; effort?: string; deadline_sec?: number }
}

interface RunFlags { role?: string; families?: string; model?: string; effort?: string; conductor?: string; deadline?: string }

/**
 * Lo que un reintento toma de la corrida original. El rol y el plazo se heredan cada uno si falta.
 * Familias, modelo, esfuerzo y conductor van juntos o no van: un fallback fija familia y conductor, y
 * el modelo o el esfuerzo de la familia que faltó no le sirven a la otra.
 */
function inheritRetry(values: RunFlags, original: RunRequest): void {
  values.role ??= original.role
  if (values.deadline === undefined && original.overrides?.deadline_sec !== undefined) values.deadline = String(original.overrides.deadline_sec)
  if ([values.families, values.model, values.effort, values.conductor].some((v) => v !== undefined)) return
  values.families = original.overrides?.families
  values.model = original.overrides?.model
  values.effort = original.overrides?.effort
  values.conductor = original.conductor?.family
}

async function run(args: string[], env: Env, cwd: string): Promise<Result> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      'prompt-file': { type: 'string' },
      role: { type: 'string' },
      families: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      conductor: { type: 'string' },
      'conductor-model': { type: 'string' },
      'conductor-effort': { type: 'string' },
      deadline: { type: 'string' },
      retry: { type: 'string' },
    },
  })
  if (env.SDD_AI_WORKER === '1') {
    throw new SddError('recursion', 'sdd-ai no se lanza desde un worker', { next: 'responde el encargo sin delegar' })
  }
  if (values.retry) {
    const request = join(runDir(repoRoot(cwd), values.retry), 'request.json')
    inheritRetry(values, existsSync(request) ? readJson<RunRequest>(request) : {})
  }
  const roleArg = values.role ?? 'explore'
  const renamed = RETIRED_ROLES.get(roleArg)
  if (renamed) throw new SddError('usage', `el rol \`${roleArg}\` ahora se llama \`${renamed}\``, { next: `usa --role ${renamed}` })
  if (roleArg === 'implement') {
    throw new SddError('usage', 'el rol implement necesita un worker que escriba, y sdd-ai todavía solo tiene workers de solo lectura', {
      next: `usa uno de: ${READ_ONLY_ROLES.join(', ')}`,
    })
  }
  if (!isReadOnlyRole(roleArg)) throw new SddError('usage', `rol desconocido: ${roleArg}`, { next: `usa uno de: ${READ_ONLY_ROLES.join(', ')}` })
  const role = roleArg
  const deadlineArg = values.deadline ?? '600'
  const deadline = Number(deadlineArg)
  if (!Number.isFinite(deadline) || deadline <= 0) throw new SddError('usage', `--deadline inválido: ${deadlineArg}`)

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
  const session = ownerSession(env, conductor.family)
  // Una nativa la lanza el conductor desde su sesión: sin ese dato, sus hooks nunca la reconocerían.
  if (resolution.via === 'native' && !session) {
    throw new SddError('session_unknown', 'falta el id de la sesión del conductor', { next: 'corre sdd-ai desde una sesión de Claude Code o de Codex' })
  }

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
    role, conductor, session, retry_of: values.retry,
    overrides: { families: values.families, model: values.model, effort: values.effort, deadline_sec: deadline },
  })
  writeJsonAtomic(join(dir, 'resolved.json'), resolution)

  if (resolution.via === 'native') {
    const profiles = nativeProfiles(root, env)
    const state = agentsState(root, PKG_DIR, resolution.family, role, profiles)
    if (state !== 'ok') {
      const detail = state === 'missing' ? 'no existe el agente generado' : 'el agente generado no coincide con sus fuentes'
      markDelivered(dir, setStatus(dir, { state: 'launch_failed', reason: 'agents_stale', detail }), env)
      return { code: 1, out: { id, state: 'launch_failed', reason: 'agents_stale', detail, next: './bin/sdd-ai agents sync y reabrir la sesión' } }
    }
    const native: NativeProfile = { agent: agentName(role), family: resolution.family, role }
    // El agente generado trae el perfil de su rol. Lo que la corrida resolvió distinto (un override, la
    // caída al conductor) viaja para que el conductor lo pase a su herramienta.
    const agent = profiles[role][resolution.family]
    const warnings: string[] = []
    if (resolution.model !== undefined && resolution.model !== agent.model) native.model = resolution.model
    if (resolution.effort !== undefined && resolution.effort !== agent.effort) {
      if (resolution.family === 'claude') {
        warnings.push(`Claude Code no permite fijar el esfuerzo de un subagente por llamada: el worker usa ${agent.effort ?? 'el esfuerzo por defecto'} y no ${resolution.effort}`)
      } else {
        native.effort = resolution.effort
      }
    }
    writeJsonAtomic(join(dir, 'native.json'), native)
    setStatus(dir, { state: 'delegated' })
    const out: Record<string, unknown> = { id, via: 'native', family: native.family, agent: native.agent, prompt_file: promptFile }
    if (native.model !== undefined) out.model = native.model
    if (native.effort !== undefined) out.effort = native.effort
    if (warnings.length > 0) out.warnings = warnings
    return { code: 0, out }
  }

  if (!inPath(resolution.family, env)) {
    const detail = `${resolution.family} no está en PATH`
    markDelivered(dir, setStatus(dir, { state: 'launch_failed', reason: 'cli_missing', detail, fallback: conductor }), env)
    return { code: 1, out: { id, state: 'launch_failed', reason: 'cli_missing', detail, fallback: conductor, next: fallbackNext(id, conductor) } }
  }

  const task: WorkerTask = { cwd: root, promptFile, resultFile: join(dir, 'result.md'), sessionId: randomUUID() }
  if (resolution.model) task.model = resolution.model
  if (resolution.effort) task.effort = resolution.effort
  if (WEB_ROLES.has(role)) task.web = true
  const launch = resolution.family === 'claude' ? claudeLaunch(task) : codexLaunch(task)
  launchSupervisor(dir, { family: resolution.family, launch, deadline_sec: deadline }, env, { fallback: conductor })
  return { code: 0, out: { id, via: 'process', family: resolution.family } }
}

/** Deja la corrida en `launching` y lanza al supervisor desprendido, que sobrevive al shell del conductor. */
function launchSupervisor(dir: string, argv: ArgvFile, env: Env, status: Partial<Status>, argvName = 'argv.json'): void {
  writeJsonAtomic(join(dir, argvName), argv)
  setStatus(dir, { ...status, state: 'launching' })
  const supervisor = spawn(process.execPath, [BIN_PATH, '__supervise', dir, argvName], { detached: true, stdio: 'ignore', env: definedEnv(env) })
  supervisor.unref()
  // En un archivo propio y no en status.json: el supervisor ya puede estar escribiendo ese estado.
  if (supervisor.pid !== undefined) writeFileSync(join(dir, 'supervisor.pid'), String(supervisor.pid))
}

interface ReviewRequest {
  /** Un diff, o un artefacto con sus insumos: una corrida anterior a los artefactos siempre es un diff. */
  kind: 'review'; selection: Selection | ArtifactSelection; author: Family; degradations: string[]
  overrides?: { families?: string; model?: string; effort?: string; deadline_sec?: number }
  /** El nivel congelado al empezar; una corrida anterior a la clasificación no lo trae. */
  risk?: RiskRecord
}

/**
 * El número del lanzamiento siguiente de una ronda: uno más que el mayor que ya dejó su argv. Se cuenta
 * del directorio porque un supervisor que murió no deja registro.
 */
function nextLaunch(dir: string, tag: string): number {
  const pattern = new RegExp(`^argv${tag}-l(\\d+)`)
  const used = readdirSync(dir).map((f) => pattern.exec(f)?.[1]).filter((k) => k !== undefined).map(Number)
  return Math.max(0, ...used) + 1
}

/** Escribe el prompt de cada trabajo planificado con el prefijo de su lanzamiento. */
function writeJobs(dir: string, prefix: string, jobs: PlannedJob[]): ReviewJob[] {
  return jobs.map(({ text, ...j }) => {
    const prompt = join(dir, `prompt${prefix}-${j.key}.md`)
    writeFileSync(prompt, text)
    return { ...j, prompt }
  })
}

/** La selección de un diff. Solo se llama en ramas de diff: un artefacto tiene la suya. */
function diffSelection(req: ReviewRequest): Selection {
  if (isArtifact(req.selection)) throw new Error('la revisión es de un artefacto, no de un diff')
  return req.selection
}

/** Un delta con riesgo alto: la ronda no corre y se propone reiniciar con lentes, con el mismo head. */
function riskHigh(req: ReviewRequest, delta: Risk, head: string | undefined): SddError {
  const sel = diffSelection(req)
  const selection: Selection = { base: sel.base, context: sel.context }
  if (head) selection.head = head
  const restart = restartCommand({ ...req, selection, risk: { ...readRisk(req), forced: true } })
  return new SddError('risk_high', 'la corrección introduce riesgo alto', {
    detail: delta.reasons.map((r) => `${r.signal} en ${r.path}: ${r.detail}`).join(', '),
    next: `pregunta al usuario si reinicia la revisión con lentes: ${restart}`,
  })
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
      risk: { type: 'string' },
      artifact: { type: 'string' },
      kind: { type: 'string' },
      request: { type: 'string' },
      spec: { type: 'string' },
      plan: { type: 'string' },
    },
  })
  if (env.SDD_AI_WORKER === '1') {
    throw new SddError('recursion', 'sdd-ai no se lanza desde un worker', { next: 'responde el encargo sin delegar' })
  }
  const abs = (p: string) => (isAbsolute(p) ? p : resolvePath(cwd, p))
  let artifact: ArtifactSelection | undefined
  if (values.artifact !== undefined) {
    const { kind, inputs } = validateArtifactArgs(values)
    artifact = { artifact: abs(values.artifact), kind, inputs: inputs.map((i) => ({ role: i.role, path: abs(i.path) })), context: values.context.map(abs) }
  } else if (values.kind !== undefined || values.request !== undefined || values.spec !== undefined || values.plan !== undefined) {
    throw new SddError('usage', '--kind, --request, --spec y --plan solo se usan con --artifact')
  }
  if (!artifact && !values.base) throw new SddError('usage', 'falta --base', { next: './bin/sdd-ai review start --base <ref> [--head <ref>] [--context <ruta>] [--risk high]' })
  if (values.risk !== undefined && values.risk !== 'high') {
    throw new SddError('usage', '--risk solo acepta high: el nivel se sube, nunca se baja')
  }
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
  const role = artifact ? 'design-review' : 'code-review'
  const resolution = resolve({ conductor: { family: author }, families, workers, role, flags, codexRoot })
  const family = resolution.family
  const degradations = family === author ? ['same_family'] : []
  if (artifact) {
    return startArtifact({
      root, env, sel: artifact, family, resolution, author, degradations, conductor, deadline,
      overrides: { families: values.families, model: values.model, effort: values.effort, deadline_sec: deadline },
    })
  }
  // El refutador es de la familia del revisor, con el perfil de su propio rol.
  const refuter = resolve({ conductor: { family: opposite(family) }, families: [family], workers, role: 'refute', flags: {}, codexRoot })

  const selection: Selection = { base: values.base ?? '', context: values.context.map(abs) }
  if (values.head) selection.head = values.head
  const candidate = freezeStable(root, selection)
  const classified = classify(candidate)
  const forced = values.risk === 'high'
  const risk: RiskRecord = { level: forced ? 'high' : classified.level, classified: classified.level, reasons: classified.reasons, forced }
  const contextTexts = readContext(root, candidate)
  // Todo se mide antes de crear la corrida: si algún prompt no entra, no queda nada escrito.
  const { reviewers, batches, jobs } = planFirstRound(candidate, contextTexts, risk)
  if (!inPath(family, env)) {
    throw new SddError('cli_missing', `${family} no está en PATH`, { next: `revisa con --families ${opposite(family)} y acepta la degradación` })
  }

  const id = newRunId()
  const dir = createRun(root, id)
  const planned = writeJobs(dir, '-l1', jobs)
  writeJsonAtomic(join(dir, 'candidate.json'), candidate)
  const request: ReviewRequest & Record<string, unknown> = {
    kind: 'review', selection, author, degradations, conductor,
    overrides: { families: values.families, model: values.model, effort: values.effort, deadline_sec: deadline }, risk,
  }
  const session = ownerSession(env, conductor.family)
  if (session) request.session = session
  writeJsonAtomic(join(dir, 'request.json'), request)
  writeJsonAtomic(join(dir, 'resolved.json'), resolution)
  writeJsonAtomic(join(dir, 'resolved-refute.json'), refuter)
  writeFileSync(join(dir, 'material.md'), renderMaterial(candidate, contextTexts))
  snapshot(root, candidate, dir)

  launchSupervisor(dir, {
    family, deadline_sec: deadline, kind: 'review', candidate: join(dir, 'candidate.json'), round: 1, tag: '', launch_n: 1,
    reviewer_resolution: resolution, refuter_resolution: refuter, jobs: planned, batches, risk,
  }, env, { round: 1, launch: 1 }, 'argv-l1.json')
  return {
    code: 0,
    out: {
      id, via: 'process', family, degradations, candidate_hash: candidate.hash,
      risk: { level: risk.level, reasons: risk.reasons, forced: risk.forced }, reviewers,
      ...(batches.length > 1 ? { batches: batches.map((paths, i) => ({ n: i + 1, paths })) } : {}),
      files: candidate.files.map((f) => f.path), left_out: candidate.left_out, next: `./bin/sdd-ai wait ${id}`,
    },
  }
}

/** Un argumento listo para pegar en la shell: tal cual si es seguro, entre comillas simples si no. */
function shellArg(s: string): string {
  return /^[\w./@:+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`
}

function restartCommand(req: ReviewRequest): string {
  if (isArtifact(req.selection)) {
    const sel = req.selection
    const parts = ['./bin/sdd-ai review start', `--artifact ${shellArg(sel.artifact)}`, `--kind ${sel.kind}`]
    for (const i of sel.inputs) parts.push(`--${i.role} ${shellArg(i.path)}`)
    for (const c of sel.context) parts.push(`--context ${shellArg(c)}`)
    parts.push(`--author ${req.author}`)
    return parts.join(' ')
  }
  const parts = ['./bin/sdd-ai review start', `--base ${shellArg(req.selection.base)}`]
  if (req.selection.head) parts.push(`--head ${shellArg(req.selection.head)}`)
  for (const c of req.selection.context) parts.push(`--context ${shellArg(c)}`)
  parts.push(`--author ${req.author}`)
  if (req.risk?.forced) parts.push('--risk high')
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
interface Freshness { stale: boolean; ref_moved?: boolean; stale_reason?: 'inputs' | 'artifact' }

function freshness(root: string, req: ReviewRequest, c: Candidate, head: string | undefined): Freshness {
  if (isArtifact(req.selection)) return artifactFreshness(root, req.selection, c)
  const sel = req.selection
  try {
    if (c.head_sha) {
      const again = freeze(root, { base: baseOf(c), head: c.head_sha, context: sel.context })
      const moved = !resolvesTo(root, head, c.head_sha) || !resolvesTo(root, sel.base, c.base_sha)
      return { stale: again.hash !== c.hash, ref_moved: moved }
    }
    return { stale: freeze(root, { base: sel.base, context: sel.context }).hash !== c.hash }
  } catch {
    return { stale: true }
  }
}

/**
 * Vigencia de un artefacto, sin Git: primero los insumos y el contexto, porque un cambio ahí invalida la
 * revisión entera; después el artefacto, que cambia a propósito entre rondas.
 */
function artifactFreshness(root: string, sel: ArtifactSelection, c: Candidate): Freshness {
  if (!inputsUnchanged(root, c)) return { stale: true, stale_reason: 'inputs' }
  try {
    return freezeArtifact(root, sel).candidate.hash === c.hash ? { stale: false } : { stale: true, stale_reason: 'artifact' }
  } catch (e) {
    if (e instanceof SddError) return { stale: true, stale_reason: 'artifact' }
    throw e
  }
}

const inputsChanged = (id: string, req: ReviewRequest) =>
  `cambió un insumo o el contexto desde la revisión y la corrida ya no se puede seguir; revisa de nuevo: ${restartCommand(req)} (${id} queda como historial)`

const tagOf = (n: number) => (n === 1 ? '' : `-r${n}`)

/** El ref que revisó la ronda `n`: el de `review start` en la 1, el de su `round-r<n>.json` después. */
function headOf(dir: string, req: ReviewRequest, n: number): string | undefined {
  if (n === 1) return isArtifact(req.selection) ? undefined : req.selection.head
  const file = join(dir, `round${tagOf(n)}.json`)
  return existsSync(file) ? readJson<RoundPlan>(file).head : undefined
}

/** Relanzar una ronda que no terminó: corre solo los trabajos que faltan, con el mismo ref que revisaba. */
function relaunchNext(id: string, dir: string, req: ReviewRequest, s: Status, round: number, completed: number): string {
  const head = headOf(dir, req, round)
  const parts = [`./bin/sdd-ai review round ${id}`]
  if (head) parts.push(`--head ${shellArg(head)}`)
  if (completed >= ROUND_CAP) parts.push('--extra')
  return `la ronda ${round} terminó en ${s.state}; pregunta al usuario si la relanza: ${parts.join(' ')}`
}

/**
 * El paso siguiente, por prioridad: esperar, relanzar una ronda que no terminó, decidir, preguntar
 * por las disputas, el checkpoint del tope, corregir y lanzar, y por último la vigencia.
 */
function roundNext(id: string, dir: string, req: ReviewRequest, s: Status, round: number, ledger: Ledger, fresh: Freshness): string {
  if (!TERMINAL.has(s.state)) return `./bin/sdd-ai wait ${id}`
  // Con un insumo cambiado, decidir o relanzar sería trabajo perdido: review round lo va a rechazar.
  if (fresh.stale_reason === 'inputs') return inputsChanged(id, req)
  // Una ronda que avanzó el ledger ya terminó aunque la hayan cancelado en la refutación.
  if (s.state !== 'done' && ledger.completed !== round) return relaunchNext(id, dir, req, s, round, ledger.completed)
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
  if (isArtifact(req.selection)) {
    if (fresh.stale) return `el artefacto cambió desde la revisión; revisa de nuevo: ${restartCommand(req)}`
    return `la revisión está vigente; ${ARTIFACT_NOTE}`
  }
  if (fresh.stale) return `el diff cambió desde la revisión; revisa de nuevo: ${restartCommand(req)}`
  return 'la revisión está vigente; el recibo informa y no autoriza commit ni push'
}

interface Receipt { tool_events: string[]; degradations: string[]; reviewer: { model_effective: string | null } }

const reviewersOf = (jobs: Array<{ reviewer: Reviewer }>): Reviewer[] =>
  (jobs.length === 0 ? ['base'] : REVIEWERS.filter((r) => jobs.some((j) => j.reviewer === r)))

/**
 * Los revisores, los lotes y los trabajos de la ronda. Mientras corre salen del argv del lanzamiento
 * activo, porque su registro todavía no existe, junto con el trabajo en curso; terminada, del último
 * registro de `rounds.json`, con el estado de cada trabajo. Una corrida anterior no trae ninguno: base
 * y un solo lote.
 */
function roundShape(dir: string, s: Status, round: number): Record<string, unknown> {
  if (!TERMINAL.has(s.state)) {
    const file = join(dir, `argv${tagOf(round)}-l${s.launch ?? 1}.json`)
    const argv = existsSync(file) ? readJson<ArgvFile>(file) : undefined
    return {
      reviewers: reviewersOf([...(argv?.kept ?? []), ...(argv?.jobs ?? [])]), ...declaredBatches(argv?.batches),
      ...(s.job ? { progress: s.job } : {}),
    }
  }
  const rounds = existsSync(join(dir, 'rounds.json')) ? readJson<{ rounds: RoundRecord[] }>(join(dir, 'rounds.json')).rounds : []
  const last = rounds.at(-1)
  const jobs = last?.jobs ?? []
  return { reviewers: reviewersOf(jobs), ...declaredBatches(last?.batches), ...(jobs.length > 0 ? { jobs: jobs.map(jobSummary) } : {}) }
}

/** El nivel congelado, con sus motivos y si se subió a mano. Un artefacto no se clasifica. */
function riskView(req: ReviewRequest): Record<string, unknown> {
  if (isArtifact(req.selection)) return { level: 'no_aplica' }
  const r = readRisk(req)
  return { level: r.level, reasons: r.reasons, forced: r.forced }
}

/** Lo propio de un artefacto: los hallazgos de otros archivos, lo que no se pudo comprobar y de quién es el gate. */
function artifactView(ledger: Ledger, rounds: RoundRecord[]): Record<string, unknown> {
  return {
    informative: ledger.entries.filter((e) => e.state === 'informativo')
      .map((e) => ({ id: e.id, of: e.of, severity: e.severity, claim: e.claim, location: e.location })),
    unverifiable: rounds.filter((r) => r.state === 'done').at(-1)?.unverifiable ?? [],
    note: ARTIFACT_NOTE,
  }
}

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
    const fresh = freshness(root, req, c, headOf(dir, req, 1))
    const out: Record<string, unknown> = {
      id, state: s.state, round, candidate_hash: c.hash, reviewer, degradations: req.degradations, risk: riskView(req),
      ...roundShape(dir, s, round), ...fresh, ...common,
    }
    if (!TERMINAL.has(s.state)) out.next = `./bin/sdd-ai wait ${id}`
    else if (fresh.stale_reason === 'inputs') out.next = inputsChanged(id, req)
    else out.next = relaunchNext(id, dir, req, s, round, 0)
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
    degradations: receipt.degradations, risk: riskView(req), ...roundShape(dir, s, round), ...fresh,
    axes: axesOf(ledger),
    ledger: ledger.entries.map(withProvenance),
    pending: undecided(ledger).filter((x) => !disputes.includes(x)), disputes,
    refuted: ledger.entries.filter((e) => e.state === 'refutado').map((e) => e.id),
    inconclusive: ledger.entries.flatMap((e) => (e.state !== 'refutado' && e.refutation?.result === 'inconclusive'
      ? [{ id: e.id, reason: e.refutation.reason ?? 'refuter_inconclusive' }] : [])),
    tool_events: rounds.filter((r) => r.state === 'done').at(-1)?.tool_events ?? receipt.tool_events,
    ...(ledger.artifact ? artifactView(ledger, rounds) : {}),
    ...common,
    next: roundNext(id, dir, req, s, round, ledger, fresh),
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

/** Los trabajos de una ronda 1: la base, y con el nivel alto también las lentes, repartidos en lotes si hace falta. */
function planFirstRound(c: Candidate, contextTexts: Map<string, string>, risk: RiskRecord):
  { reviewers: readonly Reviewer[]; batches: string[][]; jobs: PlannedJob[] } {
  const reviewers: readonly Reviewer[] = risk.level === 'high' ? REVIEWERS : ['base']
  const planned = planJobs(c, reviewers, (r, paths) => renderReviewPrompt(c, contextTexts, {
    reviewer: r, ...(paths.length === c.files.length ? {} : { view: sliceCandidate(c, paths) }),
  }))
  return { reviewers, ...planned }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * Un artefacto que no entra en el presupuesto, con el tamaño de cada archivo. Si entra con sus insumos
 * obligatorios, lo que sobra es `--context`; si no, review no puede revisar esa combinación.
 */
/**
 * En la ronda N el contexto no se puede cambiar sin un `review start` nuevo, que empieza en la ronda 1 y sin
 * CAMBIOS; por eso el `next` se elige midiendo el prompt de esa ronda 1 y no el de la ronda que no entró.
 */
function artifactTooLarge(c: Candidate, bytes: Map<string, Buffer>, inRound = false): SddError {
  const sizes = [c.files[0], ...c.context].map((x) => `${x.path}: ${bytes.get(x.path)?.length ?? 0} bytes`).join(', ')
  const firstRoundFits = (x: Candidate) => fits(renderArtifactPrompt(x, renderArtifactMaterial(x, bytes)))
  const required = { ...c, context: c.context.filter((x) => x.role) }
  let next = 'review no puede revisar esta combinación de artefacto e insumos: no entra en el presupuesto ni sin --context'
  if (inRound && firstRoundFits(c)) next = 'la corrección no entra en una ronda: corre un review start nuevo sobre el artefacto corregido'
  else if (firstRoundFits(required)) {
    next = `${inRound ? 'corre un review start nuevo sin archivos de --context' : 'quita archivos de --context'}: el artefacto con sus insumos obligatorios sí entra`
  }
  const message = inRound ? 'la ronda con el artefacto corregido no entra en el presupuesto' : 'el artefacto con sus insumos y su contexto no entra en el presupuesto'
  return new SddError('prompt_too_large', message, { detail: sizes, next })
}

/** La ronda 1 de un artefacto: un solo trabajo, sin lotes ni lentes, medido antes de crear nada. */
function planArtifactRound1(c: Candidate, bytes: Map<string, Buffer>): PlannedJob[] {
  const text = renderArtifactPrompt(c, renderArtifactMaterial(c, bytes))
  if (!fits(text)) throw artifactTooLarge(c, bytes)
  return [{ key: 'base-b1', reviewer: 'base', batch: 1, paths: [c.files[0].path], text }]
}

/**
 * `review start` de un artefacto: lo congela con sus insumos, mide el prompt y lanza al revisor con el
 * perfil de `design-review`. No clasifica riesgo ni resuelve refutador: un artefacto no los usa.
 */
function startArtifact(o: {
  root: string; env: Env; sel: ArtifactSelection; family: Family; resolution: Resolution; author: Family
  degradations: string[]; conductor: Conductor; deadline: number; overrides: ReviewRequest['overrides']
}): Result {
  const { candidate, bytes } = freezeStableWith(o.root, o.sel, freezeArtifact, (r) => r.candidate.hash)
  const jobs = planArtifactRound1(candidate, bytes)
  if (!inPath(o.family, o.env)) {
    throw new SddError('cli_missing', `${o.family} no está en PATH`, { next: `revisa con --families ${opposite(o.family)} y acepta la degradación` })
  }
  const id = newRunId()
  const dir = createRun(o.root, id)
  const planned = writeJobs(dir, '-l1', jobs)
  writeJsonAtomic(join(dir, 'candidate.json'), candidate)
  const request: ReviewRequest & Record<string, unknown> = {
    kind: 'review', selection: o.sel, author: o.author, degradations: o.degradations, conductor: o.conductor, overrides: o.overrides,
  }
  const session = ownerSession(o.env, o.conductor.family)
  if (session) request.session = session
  writeJsonAtomic(join(dir, 'request.json'), request)
  writeJsonAtomic(join(dir, 'resolved.json'), o.resolution)
  writeFileSync(join(dir, 'material.md'), renderArtifactMaterial(candidate, bytes))
  snapshot(o.root, candidate, dir, bytes)
  launchSupervisor(dir, {
    family: o.family, deadline_sec: o.deadline, kind: 'review', candidate: join(dir, 'candidate.json'), round: 1, tag: '', launch_n: 1,
    reviewer_resolution: o.resolution, jobs: planned,
  }, o.env, { round: 1, launch: 1 }, 'argv-l1.json')
  return {
    code: 0,
    out: {
      id, via: 'process', family: o.family, degradations: o.degradations, candidate_hash: candidate.hash,
      artifact: candidate.files[0].path, kind: o.sel.kind,
      inputs: candidate.context.filter((x) => x.role).map((x) => ({ role: x.role, path: x.path })),
      context: candidate.context.filter((x) => !x.role).map((x) => x.path),
      risk: { level: 'no_aplica' }, reviewers: ['base'], next: `./bin/sdd-ai wait ${id}`,
    },
  }
}

/**
 * La ronda siguiente de un artefacto, o el relanzamiento de una que no terminó. El orden importa: primero
 * los insumos, porque si cambiaron la corrida ya no se puede seguir y decidir antes sería trabajo
 * perdido; después las decisiones pendientes; después el artefacto, que cambia a propósito.
 */
async function reviewRoundArtifact(o: {
  root: string; dir: string; id: string; req: ReviewRequest; sel: ArtifactSelection; head?: string; extra: boolean; env: Env
}): Promise<Result> {
  const { root, dir, id, req, sel } = o
  if (o.head !== undefined) {
    throw new SddError('usage', 'una ronda de artefacto no acepta --head: el artefacto se revisa desde el árbol')
  }
  const ledgerFile = join(dir, 'ledger.json')
  const ledger = existsSync(ledgerFile) ? readJson<Ledger>(ledgerFile) : undefined
  const completed = ledger?.completed ?? 0
  if (o.extra && completed < ROUND_CAP) {
    throw new SddError('usage', `--extra solo concede una ronda más allá del tope de ${ROUND_CAP}; esta revisión completó ${completed}`, {
      next: `./bin/sdd-ai review round ${id}`,
    })
  }
  const first = readJson<Candidate>(join(dir, 'candidate.json'))
  const prev = ledger ? readJson<Candidate>(join(dir, `candidate${tagOf(completed)}.json`)) : first
  const changedInputs = () => new SddError('usage', 'cambió un insumo o el contexto desde la ronda anterior', { next: inputsChanged(id, req) })
  if (!inputsUnchanged(root, prev)) throw changedInputs()
  const goals = ledger ? targets(ledger) : []
  if (ledger) {
    const pending = undecided(ledger)
    if (pending.length > 0) {
      throw new SddError('usage', `hay hallazgos sin decidir: ${pending.join(', ')}`, {
        next: `./bin/sdd-ai review decide ${id} accept|reject ${pending.join(' ')} [--reason <motivo>]`,
      })
    }
    if (goals.length === 0) {
      throw new SddError('usage', 'no hay nada que verificar ni responder', { next: `./bin/sdd-ai review status ${id}` })
    }
    if (completed >= ROUND_CAP && !o.extra) {
      throw new SddError('round_cap', `la revisión ya hizo ${ROUND_CAP} rondas y quedan hallazgos vigentes`, {
        next: `pregunta al usuario si quiere una ronda más (./bin/sdd-ai review round ${id} --extra) o dejar la revisión como está`,
      })
    }
  }

  const n = completed + 1
  const tag = tagOf(n)
  const { candidate, bytes } = freezeStableWith(root, sel, freezeArtifact, (r) => r.candidate.hash)
  // Un insumo que cambió entre la validación y el congelado también invalida la corrida.
  const same = (a: Candidate['context'], b: Candidate['context']) =>
    a.length === b.length && a.every((x, i) => x.path === b[i].path && x.role === b[i].role && x.sha256 === b[i].sha256)
  if (!same(candidate.context, prev.context)) throw changedInputs()
  const identical = candidate.hash === prev.hash
  if (ledger && identical && goals.some((t) => t.kind === 'verify')) {
    throw new SddError('usage', 'el artefacto es idéntico al de la ronda anterior y hay aceptados que verificar', {
      next: 'corrige los aceptados antes de lanzar la ronda siguiente',
    })
  }
  const written = snapshot(root, candidate, dir, bytes)
  const resolved = readJson<Resolution>(join(dir, 'resolved.json'))
  const path = candidate.files[0].path
  let plan: RoundPlan | undefined
  let jobsPlanned: PlannedJob[]
  try {
    if (ledger) {
      const before = readFileSync(join(dir, 'blobs', prev.files[0].sha256 ?? '')).toString('utf8')
      const after = bytes.get(path)?.toString('utf8') ?? ''
      const delta = identical ? { added: [], removed: [] } : artifactDelta(before, after)
      plan = { n, prev_hash: prev.hash, identical, targets: goals, changed: delta.added.length > 0 ? { [path]: delta.added } : {}, removed: delta.removed }
      const material = renderArtifactMaterial(candidate, bytes)
      const text = renderArtifactRoundPrompt(candidate, material, plan, ledger.entries, ROUND_CAP, before, after)
      if (!fits(text)) {
        // Sin los pendientes: si así entra, lo que no entra son ellos, y la corrida queda como estaba.
        if (fits(renderArtifactRoundPrompt(candidate, material, { ...plan, targets: [] }, ledger.entries, ROUND_CAP, before, after))) {
          throw new SddError('prompt_too_large', 'los hallazgos pendientes no entran en el presupuesto', {
            detail: `${Buffer.byteLength(text)} bytes con los pendientes`,
            next: 'review no puede verificar esos pendientes en un solo prompt: pregunta al usuario cómo seguir',
          })
        }
        throw artifactTooLarge(candidate, bytes, true)
      }
      jobsPlanned = [{ key: 'base-b1', reviewer: 'base', batch: 1, paths: [path], text, targets: goals }]
    } else {
      jobsPlanned = planArtifactRound1(candidate, bytes)
    }
    if (!inPath(resolved.family, o.env)) {
      throw new SddError('cli_missing', `${resolved.family} no está en PATH`, { next: 'instala o expone el CLI del revisor de la ronda 1' })
    }
  } catch (e) {
    for (const f of written) rmSync(f, { force: true })
    throw e
  }

  // Lo admitido en un lanzamiento anterior de esta ronda se conserva si su encargo es el mismo.
  const rounds = existsSync(join(dir, 'rounds.json')) ? readJson<{ rounds: RoundRecord[] }>(join(dir, 'rounds.json')).rounds : []
  const last = rounds.filter((r) => r.n === n).at(-1)
  const kept: JobRecord[] = []
  const toRun = jobsPlanned.filter((j) => {
    const same = last?.jobs?.find((x) => x.key === j.key && x.admitted !== undefined && x.prompt_sha256 === sha256(j.text))
    if (same) kept.push(same)
    return same === undefined
  })

  const k = nextLaunch(dir, tag)
  writeJsonAtomic(join(dir, `candidate${tag}.json`), candidate)
  writeFileSync(join(dir, `material${tag}.md`), renderArtifactMaterial(candidate, bytes))
  const jobs = writeJobs(dir, `${tag}-l${k}`, toRun)
  if (plan) writeJsonAtomic(join(dir, `round${tag}.json`), plan)
  writeJsonAtomic(join(dir, 'status.json'), { state: 'launching', round: n, launch: k })
  rmSync(join(dir, 'cancel.request'), { force: true })
  launchSupervisor(dir, {
    family: resolved.family, deadline_sec: req.overrides?.deadline_sec ?? 1800, kind: 'review',
    candidate: join(dir, `candidate${tag}.json`), round: n, tag, ...(plan ? { plan: join(dir, `round${tag}.json`) } : {}), launch_n: k,
    reviewer_resolution: resolved, jobs, kept, extra: o.extra,
  }, o.env, { round: n, launch: k }, `argv${tag}-l${k}.json`)
  return {
    code: 0,
    out: {
      id, round: n, launch: k, family: resolved.family, candidate_hash: candidate.hash, identical,
      ...(plan ? { targets: goals, changed: plan.changed[path] ?? [], removed: plan.removed ?? [] } : { reviewers: ['base'] }),
      ...(kept.length > 0 ? { kept: kept.map((j) => j.key) } : {}),
      next: `./bin/sdd-ai wait ${id}`,
    },
  }
}

/**
 * La ronda siguiente, o el relanzamiento de una que no terminó, también la 1: congela el candidato con
 * la base y el contexto de la ronda 1 y lanza lo que falta con el mismo revisor, en sesiones nuevas.
 * Todo lo que puede impedirla se comprueba y se mide antes de escribir un archivo de la ronda.
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
  if (isArtifact(req.selection)) return reviewRoundArtifact({ root, dir, id, req, sel: req.selection, head: values.head, extra: values.extra, env })
  const ledgerFile = join(dir, 'ledger.json')
  // Sin ledger, la ronda 1 no terminó: se relanza.
  const ledger = existsSync(ledgerFile) ? readJson<Ledger>(ledgerFile) : undefined
  const completed = ledger?.completed ?? 0
  if (values.extra && completed < ROUND_CAP) {
    throw new SddError('usage', `--extra solo concede una ronda más allá del tope de ${ROUND_CAP}; esta revisión completó ${completed}`, {
      next: `./bin/sdd-ai review round ${id}`,
    })
  }
  const goals = ledger ? targets(ledger) : []
  if (ledger) {
    const pending = undecided(ledger)
    if (pending.length > 0) {
      throw new SddError('usage', `hay hallazgos sin decidir: ${pending.join(', ')}`, {
        next: `./bin/sdd-ai review decide ${id} accept|reject ${pending.join(' ')} [--reason <motivo>]`,
      })
    }
    if (goals.length === 0) {
      throw new SddError('usage', 'no hay nada que verificar ni responder', { next: `./bin/sdd-ai review status ${id}` })
    }
    if (completed >= ROUND_CAP && !values.extra) {
      throw new SddError('round_cap', `la revisión ya hizo ${ROUND_CAP} rondas y quedan hallazgos vigentes`, {
        next: `pregunta al usuario si quiere una ronda más (./bin/sdd-ai review round ${id} --extra) o dejar la revisión como está`,
      })
    }
  }

  const n = completed + 1
  const tag = tagOf(n)
  const first = readJson<Candidate>(join(dir, 'candidate.json'))
  const prev = ledger ? readJson<Candidate>(join(dir, `candidate${tagOf(completed)}.json`)) : first
  let selection: Selection
  if (ledger) {
    selection = { base: baseOf(first), context: req.selection.context }
    if (values.head) selection.head = values.head
  } else {
    selection = values.head ? { ...diffSelection(req), head: values.head } : diffSelection(req)
  }
  const candidate = freezeStable(root, selection)
  const identical = candidate.hash === prev.hash
  if (ledger && identical && goals.some((t) => t.kind === 'verify')) {
    throw new SddError('usage', 'el candidato es idéntico al de la ronda anterior y hay aceptados que verificar', {
      next: 'corrige los aceptados antes de lanzar la ronda siguiente',
    })
  }
  // Los blobs son lo único que se escribe antes de las últimas comprobaciones: la comparación con la
  // ronda anterior los necesita. Si la ronda no se lanza, se quitan.
  const written = snapshot(root, candidate, dir)
  const resolved = readJson<Resolution>(join(dir, 'resolved.json'))
  let plan: RoundPlan | undefined
  let material: string
  let planned: { reviewers?: readonly Reviewer[]; batches: string[][]; jobs: PlannedJob[] }
  try {
    const changed = identical ? {} : changedRanges(prev, candidate, dir)
    if (!identical) {
      const delta = classifyDelta(prev, candidate, changed)
      if (delta.level === 'high') throw riskHigh(req, delta, selection.head)
    }
    const contextTexts = readContext(root, candidate)
    material = renderMaterial(candidate, contextTexts)
    if (ledger) {
      plan = { n, prev_hash: prev.hash, identical, targets: goals, changed }
      if (values.head) plan.head = values.head
      planned = planRoundJobs(candidate, contextTexts, plan, ledger.entries, ROUND_CAP)
    } else {
      planned = planFirstRound(candidate, contextTexts, readRisk(req))
    }
    if (!inPath(resolved.family, env)) {
      throw new SddError('cli_missing', `${resolved.family} no está en PATH`, { next: 'instala o expone el CLI del revisor de la ronda 1' })
    }
  } catch (e) {
    for (const f of written) rmSync(f, { force: true })
    throw e
  }

  // Lo admitido en un lanzamiento anterior de esta ronda se conserva si su encargo es el mismo: el
  // digest del prompt cubre el candidato, el revisor, el lote, los pendientes y los motivos.
  const rounds = existsSync(join(dir, 'rounds.json')) ? readJson<{ rounds: RoundRecord[] }>(join(dir, 'rounds.json')).rounds : []
  const last = rounds.filter((r) => r.n === n).at(-1)
  const kept: JobRecord[] = []
  const toRun = planned.jobs.filter((j) => {
    const same = last?.jobs?.find((x) => x.key === j.key && x.admitted !== undefined && x.prompt_sha256 === sha256(j.text))
    if (same) kept.push(same)
    return same === undefined
  })

  const k = nextLaunch(dir, tag)
  writeJsonAtomic(join(dir, `candidate${tag}.json`), candidate)
  writeFileSync(join(dir, `material${tag}.md`), material)
  const jobs = writeJobs(dir, `${tag}-l${k}`, toRun)
  if (plan) writeJsonAtomic(join(dir, `round${tag}.json`), plan)
  // La ronda arranca con un estado limpio: nada de la anterior (motivo, reanudación, cancelación) la alcanza.
  writeJsonAtomic(join(dir, 'status.json'), { state: 'launching', round: n, launch: k })
  rmSync(join(dir, 'cancel.request'), { force: true })
  launchSupervisor(dir, {
    family: resolved.family, deadline_sec: req.overrides?.deadline_sec ?? 1800, kind: 'review',
    candidate: join(dir, `candidate${tag}.json`), round: n, tag, ...(plan ? { plan: join(dir, `round${tag}.json`) } : {}), launch_n: k,
    reviewer_resolution: resolved, refuter_resolution: readJson<Resolution>(join(dir, 'resolved-refute.json')), jobs, kept,
    batches: planned.batches, risk: readRisk(req), extra: values.extra,
  }, env, { round: n, launch: k }, `argv${tag}-l${k}.json`)
  return {
    code: 0,
    out: {
      id, round: n, launch: k, family: resolved.family, candidate_hash: candidate.hash, identical,
      ...(plan ? { targets: goals, changed: Object.keys(plan.changed) } : { reviewers: planned.reviewers }),
      ...(planned.batches.length > 1 ? { batches: planned.batches.map((paths, i) => ({ n: i + 1, paths })) } : {}),
      ...(kept.length > 0 ? { kept: kept.map((j) => j.key) } : {}),
      left_out: candidate.left_out, next: `./bin/sdd-ai wait ${id}`,
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
    const s = readStatus(dir)
    const view = reviewView(root, id, dir, s)
    markDelivered(dir, s, env)
    return view
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

/** Arma la respuesta de un estado terminal y recién entonces anota la entrega: si armarla falla, no se anota. */
function report(root: string, id: string, dir: string, s: Status, env: Env): Result {
  const result = reportOf(root, id, dir, s)
  markDelivered(dir, s, env)
  return result
}

function reportOf(root: string, id: string, dir: string, s: Status): Result {
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
    if (TERMINAL.has(s.state)) return report(root, id, dir, s, env)
    const supervisorPid = s.supervisor_pid ?? readSupervisorPid(dir)
    if (supervisorPid !== undefined && !isAlive(supervisorPid)) {
      // El supervisor pudo escribir el estado final justo antes de terminar.
      s = readStatus(dir)
      if (TERMINAL.has(s.state)) return report(root, id, dir, s, env)
      s = setStatus(dir, { state: 'failed', reason: 'supervisor_lost', detail: `el supervisor ${supervisorPid} terminó sin escribir un estado final` })
      return report(root, id, dir, s, env)
    }
    if (Date.now() >= until) {
      const out: Record<string, unknown> = { id, state: s.state }
      // Una revisión en curso dice su nivel, qué ronda, qué revisores y lotes, y qué trabajo va de cuántos.
      const request = join(dir, 'request.json')
      const req = existsSync(request) ? readJson<ReviewRequest>(request) : undefined
      if (req?.kind === 'review') Object.assign(out, { risk: riskView(req), round: s.round ?? 1, ...roundShape(dir, s, s.round ?? 1) })
      return { code: 3, out: { ...out, next: `./bin/sdd-ai wait ${id}` } }
    }
    await sleep(250)
  }
}

function cancel(args: string[], cwd: string): Result {
  const { positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {} })
  const id = positionals[0]
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai cancel <id>' })
  const dir = runDir(repoRoot(cwd), id)
  if (existsSync(join(dir, 'native.json')) && cancelNative(dir)) return { code: 0, out: { id, state: 'cancelled' } }
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
