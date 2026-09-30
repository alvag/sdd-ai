import { type SpawnOptions, execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { type RoleProfiles, agentName, agentsState, skillCopies, syncAgents } from './agents.ts'
import { type Proof, askNext, prove } from './approval/proof.ts'
import { DISPUTE_OPTIONS, type Question, attestQuestion, disputeQuestion, extraOptions, extraQuestion, gateQuestionFor } from './approval/question.ts'
import { type Runner, answersFor, detectRunner, readTail, sessionFile } from './approval/session.ts'
import { detectConductor } from './conductor.ts'
import { effectiveFamilies, loadCrossModel, loadJiraMode, parseFamiliesFlag } from './config.ts'
import { type SkillCheck, doctor } from './doctor.ts'
import { buildIndex, currentBranch, dirtyPaths, entryDiff, gitDirs, headCommit, indexEntries, repoRoot } from './git.ts'
import { type InitAnswers, applyInit, planInit } from './init.ts'
import { withLock, withLockAsync } from './lock.ts'
import { cancelNative } from './native-launch.ts'
import { loadCodexRoot, loadWorkers } from './profiles.ts'
import { roleProfiles, resolve } from './resolve.ts'
import { renderArtifactMaterial, renderArtifactPrompt, renderArtifactRoundPrompt } from './review/artifact-prompt.ts'
import {
  type ArtifactSelection, artifactDelta, freezeArtifact, inputsUnchanged, isArtifact, readMaterial, validateArtifactArgs,
} from './review/artifact.ts'
import {
  type Candidate, type Selection, baseOf, candidateHash, changedRanges, freeze, freezeStable, freezeStableWith, readContext, readContextFile, sha256 as candidateSha256, snapshot,
} from './review/candidate.ts'
import { type PlannedJob, planJobs, planRoundJobs, sliceCandidate } from './review/batch.ts'
import {
  type Ledger, REVIEWERS, type Reviewer, type RoundPlan, axesOf, decide, disputable, lastRejection, targets, undecided, withProvenance,
} from './review/ledger.ts'
import { fits, renderMaterial, renderReviewPrompt } from './review/prompt.ts'
import { type Risk, type RiskRecord, classify, classifyDelta, readRisk } from './review/risk.ts'
import {
  checkRunId, createRun, isAlive, markDelivered, newRunId, ownerSession, readJson, readStatus, runDir, setStatus, writeJsonAtomic,
} from './runs.ts'
import {
  ARTIFACT_NOTE, type ArgvFile, type JobRecord, type PhaseResult, type ReviewJob, type RoundRecord, declaredBatches, jobSummary, settleGroup, supervise,
  writeReceipt,
} from './supervisor.ts'
import {
  type Conductor, DISPATCHABLE_ROLES, type Family, type NativeProfile, type Profile, READ_ONLY_ROLES, RETIRED_ROLES, type RejectedField, type RetryInfo,
  type Resolution, SddError, type Status, TERMINAL, WEB_ROLES, type WorkerTask, isDispatchableRole, isFamily, isPhaseRole, opposite, toNativeEffort,
} from './types.ts'
import { approve } from './sdd/approve.ts'
import { criteriaIds, taskLines } from './sdd/markdown.ts'
import { type DocumentStep, type FrozenInputs, PHASE_INPUTS, type PhaseStep, admitFix, admitImplement, planHeaderFrom, renderPhasePrompt } from './sdd/phase.ts'
import {
  type ChainClass, type ChainEntry, type ChainTerminal, type PhaseRecord, type RunEntry, type RunKind, activeRun, appendClassification, appendEntry, appendEvent,
  closeChain, implementOf, readPhaseRecord, withFlowLock, withPhaseNext, writePhaseRecord,
} from './sdd/phase-state.ts'
import {
  type ChainState, FIX_PROMPT_BUDGET, TAIL_BYTES, checkClassification, classesPath, lastLink, orientation, redRows, renderContinuationPrompt,
  renderFixPrompt, renderResumePrompt,
} from './sdd/chain.ts'
import {
  type ChainView, type CurrentLink, chainBaseOf, chainView, classificationDetail, contractRows, currentLink, fileTail, persistLegacy, redProposals,
} from './sdd/chain-facts.ts'
import { freezeLaunch } from './sdd/publish.ts'
import { FILE_NAMES, type FlowRead, LOCK_FILE, artifactHash, bytesHash, flowDir, headerHash, listFlows, readFlow } from './sdd/read.ts'
import { recoverPendingRestore } from './sdd/restore.ts'
import { type FlowStatus, headerData, resolve as resolveFlow } from './sdd/status.ts'
import { type ManualRow, type VerificationRow, readVerification } from './sdd/verification-contract.ts'
import { type TreeGuard, attestRow, prepareVerify, runBaseline, runFinal, verifyProjectionOf } from './sdd/verify.ts'
import { type VerifyReceipt, type VerifyReceiptRef, readVerifyReceipt, receiptDir } from './sdd/verify-receipt.ts'
import { claudeLaunch, claudeResume, claudeWriterLaunch, withSessionId } from './workers/claude.ts'
import { codexLaunch, codexResume, codexWriterLaunch, withResultFile } from './workers/codex.ts'
import { writerEnvelopeBytes, writerPrompt } from './writer.ts'
import {
  type HarvestRecord, type LaunchFrom, type WriterControl, canWriteStore, captureTreeAtBase, controlUnavailable, freezeHarvest, groupState, harvestTreeHolds, isWriterRun,
  flowWriterRuns, launchTreeDiff, launchTreeHolds, leaderMatches, readControl, readHarvest, readProcess, readReservation, releaseWriter, reserveWriter, runDirIdentity, runInventory,
  registryDigest, sensitiveInventory, storeDir, writeControl, writeTakeoverMap, writerLaunchOf, writerSession,
} from './writer-store.ts'

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
  return roleProfiles(loadWorkers(root), loadCodexRoot(env))
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
  if (values.retry !== undefined) checkRunId(values.retry)
  // Un writer se relanza con lo que guardó su almacén, nunca con su corrida visible, que pudo cambiar.
  const retryWriter = values.retry && isWriterRun(repoRoot(cwd), values.retry) ? readControl(repoRoot(cwd), values.retry) : undefined
  // Un writer de fase se relanza con el verbo de su fase, que congela sus tasks, admite su contrato y lo
  // registra en el flujo. El vínculo está en el control desde que existen los writers de fase.
  if (retryWriter?.phase) {
    throw new SddError('phase_writer', `la corrida ${retryWriter.id} es un writer de la fase implement del flujo ${retryWriter.phase.flow}: no se relanza con run --retry`, {
      next: `./bin/sdd-ai sdd phase ${retryWriter.phase.flow}`,
    })
  }
  if (retryWriter) {
    const r = retryWriter.request
    inheritRetry(values, { role: r.role, conductor: r.conductor, overrides: { families: r.families, model: r.model, effort: r.effort, deadline_sec: r.deadline_sec } })
  } else if (values.retry) {
    const request = join(runDir(repoRoot(cwd), values.retry), 'request.json')
    inheritRetry(values, existsSync(request) ? readJson<RunRequest>(request) : {})
  }
  const roleArg = values.role ?? 'explore'
  const renamed = RETIRED_ROLES.get(roleArg)
  if (renamed) throw new SddError('usage', `el rol \`${roleArg}\` ahora se llama \`${renamed}\``, { next: `usa --role ${renamed}` })
  if (isPhaseRole(roleArg)) {
    throw new SddError('usage', `el rol ${roleArg} lo despacha sdd phase`, { next: './bin/sdd-ai sdd status <id> dice el comando de la fase' })
  }
  if (!isDispatchableRole(roleArg)) throw new SddError('usage', `rol desconocido: ${roleArg}`, { next: `usa uno de: ${DISPATCHABLE_ROLES.join(', ')}` })
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
  // El writer no tiene agente nativo: su borde de escritura lo pone el CLI que lanza el binario.
  if (role === 'implement') resolution.via = 'process'
  const session = ownerSession(env, conductor.family)
  // Una nativa la lanza el conductor desde su sesión: sin ese dato, sus hooks nunca la reconocerían.
  if (resolution.via === 'native' && !session) {
    throw new SddError('session_unknown', 'falta el id de la sesión del conductor', { next: 'corre sdd-ai desde una sesión de Claude Code o de Codex' })
  }

  let prompt: string
  if (retryWriter) {
    prompt = retryWriter.prompt
  } else if (values.retry) {
    prompt = readFileSync(join(runDir(root, values.retry), 'prompt.md'), 'utf8')
  } else if (values['prompt-file']) {
    const file = isAbsolute(values['prompt-file']) ? values['prompt-file'] : resolvePath(cwd, values['prompt-file'])
    if (!existsSync(file)) throw new SddError('usage', `no existe el archivo del encargo: ${file}`)
    prompt = readFileSync(file, 'utf8')
  } else {
    throw new SddError('usage', 'falta el encargo', { next: 'pasa --prompt-file <archivo> o --retry <id>' })
  }

  if (role === 'implement') {
    return await runWriter({
      root, env, conductor, session, resolution, prompt, deadline, retryOf: values.retry,
      request: { role, families: values.families, model: values.model, effort: values.effort, conductor, deadline_sec: deadline },
      source: values.retry ? `--retry ${values.retry}` : `--prompt-file ${shellArg(values['prompt-file'] ?? '')}`,
    })
  }

  const request = {
    role, conductor, session, retry_of: values.retry,
    overrides: { families: values.families, model: values.model, effort: values.effort, deadline_sec: deadline },
  }
  if (resolution.via === 'native') {
    const { id, dir } = prepareRun(root, prompt, request, resolution)
    const promptFile = join(dir, 'prompt.md')
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

  const started = startProcessRun({ root, env, resolution, prompt, request, deadline, conductor, web: WEB_ROLES.has(role) })
  if (!started.launched) {
    const detail = `${resolution.family} no está en PATH`
    return { code: 1, out: { id: started.id, state: 'launch_failed', reason: 'cli_missing', detail, fallback: conductor, next: fallbackNext(started.id, conductor) } }
  }
  return { code: 0, out: { id: started.id, via: 'process', family: resolution.family } }
}

/** Crea la corrida con su encargo, su pedido y su resolución, y los archivos congelados que traiga. */
function prepareRun(root: string, prompt: string, request: Record<string, unknown>, resolution: Resolution,
  files: Record<string, string | Buffer> = {}): { id: string; dir: string } {
  const id = newRunId()
  const dir = createRun(root, id)
  writeFileSync(join(dir, 'prompt.md'), prompt)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  writeJsonAtomic(join(dir, 'request.json'), request)
  writeJsonAtomic(join(dir, 'resolved.json'), resolution)
  return { id, dir }
}

interface ProcessRun {
  root: string; env: Env; resolution: Resolution; prompt: string; request: Record<string, unknown>; deadline: number
  conductor: Conductor; web?: boolean; argvExtra?: Partial<ArgvFile>; files?: Record<string, string | Buffer>
}

/**
 * Una corrida por proceso de un worker de solo lectura: la crea y lanza su supervisor. Sin el CLI de la
 * familia resuelta, queda en `launch_failed` con la caída al conductor, que decide el usuario.
 */
function startProcessRun(o: ProcessRun): { id: string; dir: string; launched: boolean } {
  const { id, dir } = prepareRun(o.root, o.prompt, o.request, o.resolution, o.files)
  if (!inPath(o.resolution.family, o.env)) {
    const detail = `${o.resolution.family} no está en PATH`
    markDelivered(dir, setStatus(dir, { state: 'launch_failed', reason: 'cli_missing', detail, fallback: o.conductor }), o.env)
    return { id, dir, launched: false }
  }
  const task: WorkerTask = { cwd: o.root, promptFile: join(dir, 'prompt.md'), resultFile: join(dir, 'result.md'), sessionId: randomUUID() }
  if (o.resolution.model) task.model = o.resolution.model
  if (o.resolution.effort) task.effort = o.resolution.effort
  if (o.web) task.web = true
  const launch = o.resolution.family === 'claude' ? claudeLaunch(task) : codexLaunch(task)
  launchSupervisor(dir, { family: o.resolution.family, launch, deadline_sec: o.deadline, ...o.argvExtra }, o.env, { fallback: o.conductor })
  return { id, dir, launched: true }
}

export interface WriterLaunch {
  root: string; env: Env; conductor: Conductor; session?: string; resolution: Resolution; prompt: string; deadline: number
  retryOf?: string; request: WriterControl['request']
  /** Cómo nombrar el encargo en un `next`: el archivo o el `--retry`. */
  source: string
  /** Lo que lanza al supervisor; las pruebas lo reemplazan. */
  start?: SupervisorSpawn
  /** Un writer de fase: el contrato de su reporte se valida en la cosecha contra esto. */
  phase?: WriterControl['phase']
  /** El id de la corrida, cuando el llamador lo registró antes de lanzar. */
  id?: string
  /**
   * Una corrida encadenada: `resume` reanuda la sesión de la corrida `origin` con el encargo nuevo;
   * `fresh` abre una sesión nueva con la familia y el perfil de `origin`; `initial` abre una sesión como
   * el writer inicial de hoy. Con padre, el árbol tiene que ser el suyo y `HEAD`, la base de la cadena.
   */
  chained?: { mode: 'resume' | 'fresh' | 'initial'; origin?: string; base: string }
}

/**
 * Si la sesión de la corrida `origin` se puede reanudar: el CLI de su familia en PATH, el id de la sesión
 * conocido y su archivo donde lo guarda el runner. Un bloque (`fresh`) abre una sesión nueva con el argv de
 * `origin`: le alcanza con ese argv y el CLI, sin la sesión. Nunca propone otra familia.
 */
export function checkResumable(root: string, env: Env, origin: string, mode: 'resume' | 'fresh' = 'resume'): { ok: true } | { ok: false; why: string } {
  if (mode === 'fresh') {
    const l = writerLaunchOf(root, origin)
    if (l === null) return { ok: false, why: `no se conoce el argv de la corrida ${origin}` }
    return inPath(l.family, env) ? { ok: true } : { ok: false, why: `${l.family} no está en PATH` }
  }
  const s = writerSession(root, origin)
  if (s === null) return { ok: false, why: `no se conoce la sesión de la corrida ${origin}` }
  if (!inPath(s.family, env)) return { ok: false, why: `${s.family} no está en PATH` }
  try {
    sessionFile(env, { runner: s.family, session: s.session })
  } catch {
    return { ok: false, why: `no se encuentra el archivo de la sesión ${s.session} de ${s.family}` }
  }
  return { ok: true }
}

/** El lanzamiento de una corrida encadenada que reanuda o copia la sesión de `origin`, con el encargo del almacén. */
function chainedLaunch(root: string, mode: 'resume' | 'fresh', origin: string, stdinFile: string, resultFile: string) {
  const unavailable = () => new SddError('resume_unavailable', `no se conoce la sesión de la corrida ${origin}`, { next: 'declara la toma: ./bin/sdd-ai sdd verify <flujo> --takeover' })
  let s: { family: Family; launch: { cmd: string; args: string[]; cwd: string } }
  let args: string[] | null
  if (mode === 'fresh') {
    // Un bloque abre una sesión nueva: le alcanza con el argv de origen.
    const l = writerLaunchOf(root, origin)
    if (l === null) throw unavailable()
    s = l
    args = s.family === 'claude' ? withSessionId(s.launch.args, randomUUID()) : withResultFile(s.launch.args, resultFile)
  } else {
    const r = writerSession(root, origin)
    if (r === null) throw unavailable()
    s = r
    args = r.family === 'claude' ? claudeResume(r.launch.args) : codexResume(r.launch.args, r.session, resultFile)
  }
  if (!args) throw new SddError('resume_unavailable', `el argv de la corrida ${origin} no se puede reanudar`, { next: 'declara la toma: ./bin/sdd-ai sdd verify <flujo> --takeover' })
  return { family: s.family, launch: { ...s.launch, args, cwd: root, stdinFile } }
}

/** Lo que dice el rechazo de un árbol sucio: el usuario decide, sdd-ai no toca nada. */
const DIRTY_NEXT = 'pregunta al usuario si conserva el cambio o lo revierte. Si lo conserva, el writer queda descartado en este checkout hasta que él deje el árbol limpio, por ejemplo commiteando, y mientras tanto sigues inline. sdd-ai no hace stash, commit ni revert'

/**
 * `run --role implement`. Los rechazos van antes de crear nada, en orden: el almacén, la reserva (un
 * writer abierto prevalece sobre el árbol sucio), un commit en `HEAD` y el árbol limpio. Todo lo que
 * decide queda en el almacén antes de lanzar; en la corrida visible, solo lo previo al lanzamiento.
 */
export async function runWriter(w: WriterLaunch): Promise<Result> {
  const { root, env, conductor, resolution } = w
  if (!inPath(resolution.family, env)) {
    const c = conductor
    throw new SddError('cli_missing', `${resolution.family} no está en PATH`, {
      next: w.phase
        ? phaseFallbackNext({ flow: w.phase.flow }, c)
        : `pregunta al usuario si cae a ${c.family}; solo con un sí: ./bin/sdd-ai run --role implement ${w.source} --families ${c.family} --conductor ${c.family}`,
    })
  }
  if (!canWriteStore(root)) {
    const e = controlUnavailable()
    e.next = `${e.next}. Si el usuario no la aprueba, escribe inline`
    throw e
  }
  const id = w.id ?? newRunId()
  const reserved = reserveWriter(root, id)
  if (!reserved.ok) {
    throw new SddError('writer_open', `ya hay un writer abierto en este repositorio: ${reserved.holder}`, {
      next: reserved.verify
        ? 'espera a que termine sdd verify, que tiene archivos revertidos para confirmar filas, y vuelve a lanzar el writer'
        : `espera o recibe esa corrida (./bin/sdd-ai wait ${reserved.holder}) antes de lanzar otro writer`,
    })
  }
  let launched = false
  try {
    const base = headCommit(root)
    if (!base) {
      throw new SddError('no_head', 'HEAD no tiene commit: el writer necesita una base', {
        next: 'pregunta al usuario si commitea primero; mientras tanto, escribe inline',
      })
    }
    if (w.chained && base !== w.chained.base) {
      throw new SddError('head_moved', 'HEAD ya no es la base de la cadena', { next: 'una cadena necesita HEAD en su base: sin eso, la sigue el conductor con la toma' })
    }
    if (w.phase?.launch_from !== undefined) {
      // Una corrida con padre parte del árbol que dejó el padre, no de uno limpio.
      const diff = launchTreeDiff(root, { base, phase: w.phase })
      if (diff === null || diff.length > 0) {
        throw new SddError('tree_not_parent', diff === null ? 'no se puede leer el árbol del eslabón anterior' : `el árbol ya no es el del eslabón anterior: cambió ${diff.join(', ')}`, {
          detail: (diff ?? []).join('\n'),
          next: `devuelve el árbol al del eslabón anterior o declara la toma: ./bin/sdd-ai sdd verify ${w.phase.flow} --takeover`,
        })
      }
    } else {
      const dirty = dirtyPaths(root)
      if (dirty.length > 0) throw new SddError('tree_dirty', `el árbol tiene cambios sin commitear: ${dirty.join(', ')}`, { detail: dirty.join('\n'), next: DIRTY_NEXT })
    }

    const dir = createRun(root, id)
    const store = storeDir(root, id)
    mkdirSync(store, { recursive: true })
    const storePrompt = join(store, 'prompt.md')
    writeFileSync(storePrompt, writerPrompt(w.prompt))
    const task: WorkerTask = { cwd: root, promptFile: storePrompt, resultFile: join(store, 'result.md'), sessionId: randomUUID() }
    if (resolution.model) task.model = resolution.model
    if (resolution.effort) task.effort = resolution.effort
    const mode = w.chained?.mode
    const copied = (mode === 'resume' || mode === 'fresh') && w.chained?.origin
      ? chainedLaunch(root, mode, w.chained.origin, storePrompt, task.resultFile) : null
    const family = copied?.family ?? resolution.family
    const launch = copied?.launch ?? (family === 'claude' ? claudeWriterLaunch(task) : codexWriterLaunch(task))
    const argv: ArgvFile = { family, deadline_sec: w.deadline, kind: 'writer', root, id, launch }

    // La corrida visible: lo que los hooks y el conductor leen. Después de lanzar, sdd-ai no escribe ahí.
    writeFileSync(join(dir, 'prompt.md'), w.prompt)
    writeJsonAtomic(join(dir, 'request.json'), {
      role: 'implement', conductor, session: w.session, retry_of: w.retryOf, base,
      overrides: { families: w.request.families, model: w.request.model, effort: w.request.effort, deadline_sec: w.deadline },
    })
    writeJsonAtomic(join(dir, 'resolved.json'), resolution)
    writeJsonAtomic(join(dir, 'argv.json'), argv)
    writeJsonAtomic(join(dir, 'status.json'), { state: 'launching' })

    const identity = runDirIdentity(root, id)
    if (!identity) throw new Error(`la corrida ${id} desapareció antes de lanzar`)
    // La sesión de una corrida de cadena: la que reanuda, o la propia si abre una nueva.
    const phase = w.phase?.kind ? { ...w.phase, session_origin: mode === 'resume' && w.chained?.origin ? writerSessionOrigin(root, w.chained.origin) : id } : w.phase
    const control: WriterControl = {
      id, base, family, prompt: w.prompt, checkout: { root, ...gitDirs(root) }, request: w.request,
      preLaunch: runInventory(root, id), inventory: sensitiveInventory(root), runDir: identity,
      ...(w.session ? { session: w.session } : {}), ...(phase ? { phase } : {}),
    }
    writeControl(root, control)
    try {
      launchSupervisor(store, argv, env, {}, 'argv.json', w.start)
    } catch (e) {
      // Sin supervisor nadie llevaría la corrida a un terminal: se congela la cosecha, que libera la reserva.
      const detail = 'el sistema no lanzó el proceso supervisor'
      setStatus(dir, { state: 'launch_failed', reason: 'supervisor_not_started', detail })
      await freezeHarvest(root, id, { state: 'launch_failed', reason: 'supervisor_not_started', detail })
      throw e
    }
    launched = true
    return { code: 0, out: { id, via: 'process', family, base, next: `./bin/sdd-ai wait ${id}` } }
  } finally {
    if (!launched) releaseWriter(root, id)
  }
}

/** La corrida que abrió la sesión de `run`: la suya, o la que ella reanudó. */
function writerSessionOrigin(root: string, run: string): string {
  try {
    return readControl(root, run).phase?.session_origin ?? run
  } catch {
    return run
  }
}

/** Lo que `launchSupervisor` necesita del proceso lanzado; `spawn` lo cumple. */
export type SupervisorSpawn = (cmd: string, args: string[], opts: SpawnOptions) => {
  pid?: number; unref(): void; on(event: 'error', listener: (err: Error) => void): unknown
}

/**
 * Deja la corrida en `launching` y lanza al supervisor desprendido, que sobrevive al shell del conductor.
 * Si el sistema no lanza el proceso, nadie llevaría la corrida a un estado final: queda en
 * `launch_failed` y el comando que la lanzó falla.
 */
export function launchSupervisor(dir: string, argv: ArgvFile, env: Env, status: Partial<Status>, argvName = 'argv.json',
  start: SupervisorSpawn = spawn): void {
  writeJsonAtomic(join(dir, argvName), argv)
  setStatus(dir, { ...status, state: 'launching' })
  const supervisor = start(process.execPath, [BIN_PATH, '__supervise', dir, argvName], { detached: true, stdio: 'ignore', env: definedEnv(env) })
  // Un spawn fallido avisa con un evento `error` en el tick siguiente; sin oyente, tumbaría a este proceso.
  supervisor.on('error', () => {})
  if (supervisor.pid === undefined) {
    const id = basename(dir)
    // Sin caída de familia: el problema es del sistema, no del worker.
    const s = setStatus(dir, { state: 'launch_failed', reason: 'supervisor_not_started', detail: 'el sistema no lanzó el proceso supervisor', fallback: undefined })
    markDelivered(dir, s, env)
    throw new SddError('launch_failed', `el supervisor de la corrida ${id} no arrancó`, { next: `./bin/sdd-ai wait ${id}` })
  }
  supervisor.unref()
  // En un archivo propio y no en status.json: el supervisor ya puede estar escribiendo ese estado.
  writeFileSync(join(dir, 'supervisor.pid'), String(supervisor.pid))
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

/** Lo que una selección arrastra entre rondas y reinicios: los archivos nuevos y la cosecha. */
const untrackedOf = (sel: Selection): Pick<Selection, 'untracked' | 'harvest'> =>
  ({ ...(sel.untracked ? { untracked: true } : {}), ...(sel.harvest ? { harvest: sel.harvest } : {}) })

/** Un delta con riesgo alto: la ronda no corre y se propone reiniciar con lentes, con el mismo head. */
function riskHigh(root: string, req: ReviewRequest, delta: Risk, head: string | undefined): SddError {
  const sel = diffSelection(req)
  const selection: Selection = { base: sel.base, context: sel.context, ...untrackedOf(sel) }
  if (head) selection.head = head
  const restart = restartCommand({ ...req, selection, risk: { ...readRisk(req), forced: true } }, root)
  return new SddError('risk_high', 'la corrección introduce riesgo alto', {
    detail: delta.reasons.map((r) => `${r.signal} en ${r.path}: ${r.detail}`).join(', '),
    next: `pregunta al usuario si reinicia la revisión con lentes: ${restart}`,
  })
}

interface Harvested { id: string; base: string; author: Family }

function harvestStale(h: Harvested): SddError {
  return new SddError('harvest_stale', `el árbol ya no es el de la cosecha de ${h.id}`, {
    next: `díselo al usuario: la revisión atada a la cosecha ya no vale para lo que hay. Si siguen, revisa el árbol actual (./bin/sdd-ai review start --base ${h.base} --author ${h.author} --untracked) y declara que la autoría quedó mezclada si tú también editaste`,
  })
}

/**
 * La revisión de una cosecha: la base y el autor salen del almacén y se niegan si el conductor pasó
 * otros; la cosecha tiene que estar congelada y el árbol tiene que seguir siendo el suyo.
 */
function harvestSelection(root: string, id: string, base: string | undefined, author: string | undefined): Harvested {
  if (!isWriterRun(root, id)) throw new SddError('run_not_found', `no existe la corrida de writer ${id} en este checkout`)
  const c = readControl(root, id)
  if (!readHarvest(root, id)) {
    throw new SddError('harvest_pending', `la cosecha de ${id} todavía no está congelada`, { next: `./bin/sdd-ai wait ${id}` })
  }
  if (base !== undefined && headOrRef(root, base) !== c.base) {
    throw new SddError('harvest_mismatch', `--base ${base} no es la base de la cosecha (${c.base})`, { next: `usa --base ${c.base}` })
  }
  if (author !== undefined && author !== c.family) {
    throw new SddError('harvest_mismatch', `--author ${author} no es la familia del writer (${c.family})`, { next: `usa --author ${c.family}` })
  }
  const h: Harvested = { id, base: c.base, author: c.family }
  if (!harvestTreeHolds(root, id)) throw harvestStale(h)
  return h
}

/** El commit al que resuelve una ref, o la ref tal cual si no resuelve. */
function headOrRef(root: string, ref: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ref
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
      risk: { type: 'string' },
      artifact: { type: 'string' },
      kind: { type: 'string' },
      request: { type: 'string' },
      spec: { type: 'string' },
      plan: { type: 'string' },
      harvest: { type: 'string' },
      untracked: { type: 'boolean', default: false },
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
  if ((values.harvest !== undefined || values.untracked) && (artifact || values.head !== undefined)) {
    throw new SddError('usage', '--harvest y --untracked revisan el árbol de trabajo: no se combinan con --artifact ni con --head')
  }
  if (!artifact && !values.base && values.harvest === undefined) {
    throw new SddError('usage', 'falta --base', { next: './bin/sdd-ai review start --base <ref> [--head <ref>] [--context <ruta>] [--untracked] [--risk high]' })
  }
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
  const harvested = values.harvest !== undefined ? harvestSelection(root, values.harvest, values.base, values.author) : undefined
  const author: Family = harvested?.author ?? values.author ?? conductor.family
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

  const selection: Selection = harvested
    ? { base: harvested.base, context: values.context.map(abs), untracked: true, harvest: values.harvest }
    : { base: values.base ?? '', context: values.context.map(abs), ...(values.untracked ? { untracked: true } : {}) }
  if (values.head) selection.head = values.head
  const candidate = freezeStable(root, selection)
  // Lo que se congeló tiene que ser la cosecha: si el árbol cambió en el medio, no se revisa.
  if (harvested && !harvestTreeHolds(root, harvested.id)) throw harvestStale(harvested)
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

/**
 * El `review start` que vuelve a revisar. Una revisión de cosecha conserva `--harvest` solo si el árbol
 * sigue siendo el de la cosecha; si cambió, revisa el árbol actual con los archivos nuevos.
 */
function restartCommand(req: ReviewRequest, root?: string): string {
  if (isArtifact(req.selection)) {
    const sel = req.selection
    const parts = ['./bin/sdd-ai review start', `--artifact ${shellArg(sel.artifact)}`, `--kind ${sel.kind}`]
    for (const i of sel.inputs) parts.push(`--${i.role} ${shellArg(i.path)}`)
    for (const c of sel.context) parts.push(`--context ${shellArg(c)}`)
    parts.push(`--author ${req.author}`)
    return parts.join(' ')
  }
  const sel = req.selection
  const harvest = sel.harvest && root && harvestTreeHolds(root, sel.harvest) ? sel.harvest : undefined
  const parts = ['./bin/sdd-ai review start', ...(harvest ? [`--harvest ${harvest}`] : []), `--base ${shellArg(sel.base)}`]
  if (sel.head) parts.push(`--head ${shellArg(sel.head)}`)
  for (const c of sel.context) parts.push(`--context ${shellArg(c)}`)
  parts.push(`--author ${req.author}`)
  if (sel.untracked && !harvest) parts.push('--untracked')
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
interface Freshness { stale: boolean; ref_moved?: boolean; stale_reason?: 'inputs' | 'artifact'; verify_projection?: Array<{ path: string; receipt: string }> }

function freshness(root: string, dir: string, req: ReviewRequest, c: Candidate, head: string | undefined): Freshness {
  if (isArtifact(req.selection)) return artifactFreshness(root, req.selection, c)
  const sel = req.selection
  let moved: Pick<Freshness, 'ref_moved'> = {}
  try {
    const again = c.head_sha
      ? freeze(root, { base: baseOf(c), head: c.head_sha, context: sel.context })
      : freeze(root, { base: sel.base, context: sel.context, ...untrackedOf(sel) })
    moved = c.head_sha ? { ref_moved: !resolvesTo(root, head, c.head_sha) || !resolvesTo(root, sel.base, c.base_sha) } : {}
    if (again.hash === c.hash) return { stale: false, ...moved }
    const projection = verifyProjections(root, dir, c, again)
    return projection ? { stale: false, ...moved, verify_projection: projection } : { stale: true, ...moved }
  } catch {
    return { stale: true, ...moved }
  }
}

/**
 * Si lo único que cambió del contexto desde que se congeló es la proyección de `sdd verify` en un plan,
 * respaldada por un recibo íntegro, y con los sha congelados el hash vuelve a ser el de la revisión.
 * Devuelve cada contexto reconocido con su recibo, o `null` si algo más cambió.
 */
function verifyProjections(root: string, dir: string, c: Candidate, again: Candidate): Array<{ path: string; receipt: string }> | null {
  if (c.context.length !== again.context.length || c.context.some((x, i) => x.path !== again.context[i].path)) return null
  const found: Array<{ path: string; receipt: string }> = []
  for (const [i, frozen] of c.context.entries()) {
    const now = again.context[i]
    if (frozen.sha256 === now.sha256) continue
    const current = readContextFile(root, frozen.path).bytes
    if (candidateSha256(current) !== now.sha256) return null
    const receipt = verifyProjectionOf(root, frozen.path, readFileSync(join(dir, 'blobs', frozen.sha256), 'utf8'), current.toString('utf8'))
    if (receipt === null) return null
    found.push({ path: frozen.path, receipt })
  }
  if (found.length === 0) return null
  const restored = again.context.map((x, i) => (found.some((f) => f.path === x.path) ? c.context[i] : x))
  return candidateHash({ ...again, context: restored }) === c.hash ? found : null
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

/** El lock que serializa `review decide` y `review round` sobre una revisión. */
const REVIEW_LOCK = 'review.lock'
const reviewBusy = (dir: string) => existsSync(join(dir, REVIEW_LOCK))
const busyNext = (id: string) => `otra operación de la revisión está en curso (decide o round); vuelve a consultar con ./bin/sdd-ai review status ${id}`

/**
 * Si `review round --extra` pasaría sus precondiciones: el tope alcanzado, hallazgos vigentes, ninguno
 * sin decidir y los insumos sin cambiar. La vista y la ronda comparten este criterio.
 */
function extraLaunchable(ledger: Ledger, fresh: Freshness): boolean {
  return ledger.completed >= ROUND_CAP && targets(ledger).length > 0 && undecided(ledger).length === 0 && fresh.stale_reason !== 'inputs'
}

/**
 * Las preguntas que el conductor le hace al usuario: una por cada disputa que se puede decidir y, en el
 * tope con hallazgos vigentes, la de la ronda extra. Solo con la ronda terminada y sin otra operación en
 * curso, que son las condiciones en que la decisión se puede ejecutar.
 */
function questionsOf(id: string, dir: string, s: Status, ledger: Ledger, fresh: Freshness): Question[] {
  if (!TERMINAL.has(s.state) || reviewBusy(dir)) return []
  const out: Question[] = []
  for (const e of ledger.entries) {
    const reason = lastRejection(e)
    if (disputable(e, ledger.completed) && reason !== undefined) out.push(disputeQuestion(id, e, ledger.completed, reason))
  }
  if (extraLaunchable(ledger, fresh)) out.push(extraQuestion(id, ledger.completed + 1))
  return out
}

/** Cómo se hace una pregunta canónica de `questions` en cada runner. */
const HOW_TO_ASK = 'en Claude Code, con AskUserQuestion, pasando tal cual su objeto de questions; en Codex, mostrando solo su texto con'
  + ' las opciones numeradas como único contenido de un mensaje y esperando el próximo mensaje del usuario'

/** Relanzar una ronda que no terminó: corre solo los trabajos que faltan, con el mismo ref que revisaba. */
function relaunchNext(id: string, dir: string, req: ReviewRequest, s: Status, round: number, completed: number, env: Env): string {
  const head = headOf(dir, req, round)
  const parts = [`./bin/sdd-ai review round ${id}`]
  if (head) parts.push(`--head ${shellArg(head)}`)
  if (completed < ROUND_CAP) return `la ronda ${round} terminó en ${s.state}; pregunta al usuario si la relanza: ${parts.join(' ')}`
  parts.push('--extra')
  // Una ronda extra se relanza con la respuesta que la autorizó, si todavía vale.
  const reuse = extraReuse(env, undefined, dir, id, round)
  const proof = reuse.reuse === true
    ? `el relanzamiento reusa la respuesta que el usuario ya dio para la ronda ${round}`
    : reuse.reuse === false
      ? `el relanzamiento pide otra respuesta del usuario (${reuse.reason}): hazle la pregunta de la ronda ${round} de questions, ${HOW_TO_ASK}`
      : `no se puede determinar si el relanzamiento reusa la respuesta del usuario sin elegir la sesión: ${reuse.reason}`
  return `la ronda ${round} terminó en ${s.state}; pregunta al usuario si la relanza: ${parts.join(' ')}. ${proof}`
}

/**
 * El paso siguiente, por prioridad: esperar, relanzar una ronda que no terminó, decidir, preguntar
 * por las disputas, el checkpoint del tope, corregir y lanzar, y por último la vigencia.
 */
function roundNext(root: string, id: string, dir: string, req: ReviewRequest, s: Status, round: number, ledger: Ledger, fresh: Freshness, env: Env): string {
  if (reviewBusy(dir)) return busyNext(id)
  if (!TERMINAL.has(s.state)) return `./bin/sdd-ai wait ${id}`
  // Con un insumo cambiado, decidir o relanzar sería trabajo perdido: review round lo va a rechazar.
  if (fresh.stale_reason === 'inputs') return inputsChanged(id, req)
  // Una ronda que avanzó el ledger ya terminó aunque la hayan cancelado en la refutación.
  if (s.state !== 'done' && ledger.completed !== round) return relaunchNext(id, dir, req, s, round, ledger.completed, env)
  const disputes = ledger.entries.filter((e) => e.state === 'en-disputa').map((e) => e.id)
  const pending = undecided(ledger).filter((x) => !disputes.includes(x))
  if (pending.length > 0) {
    return `decide cada hallazgo (${pending.join(', ')}): ./bin/sdd-ai review decide ${id} accept <F-n>… para corregirlo, o reject <F-n>… --reason "<motivo verificable>"`
  }
  if (disputes.length > 0) {
    return `pregunta al usuario por cada disputa (${disputes.join(', ')}) con su pregunta canónica de questions, ${HOW_TO_ASK}.`
      + ` Con su respuesta, aceptar el hallazgo (./bin/sdd-ai review decide ${id} accept <F-n>) o mantener el rechazo`
      + ` (./bin/sdd-ai review decide ${id} reject <F-n>, con el motivo que mostró la pregunta)`
  }
  const goals = targets(ledger)
  if (goals.length > 0 && ledger.completed >= ROUND_CAP) {
    return `se completaron ${ledger.completed} rondas y quedan hallazgos vigentes: pregunta al usuario si quiere una ronda más`
      + ` (./bin/sdd-ai review round ${id} --extra) o dejar la revisión como está, con la pregunta de la ronda ${ledger.completed + 1}`
      + ` de questions, ${HOW_TO_ASK}`
  }
  const verify = goals.filter((t) => t.kind === 'verify').map((t) => t.id)
  if (verify.length > 0) return `corrige los aceptados (${verify.join(', ')}) y lanza ./bin/sdd-ai review round ${id}`
  if (goals.length > 0) return `lanza ./bin/sdd-ai review round ${id} para que el revisor responda los rechazos`
  if (isArtifact(req.selection)) {
    if (fresh.stale) return `el artefacto cambió desde la revisión; revisa de nuevo: ${restartCommand(req)}`
    return `la revisión está vigente; ${ARTIFACT_NOTE}`
  }
  if (fresh.stale) return `el diff cambió desde la revisión; revisa de nuevo: ${restartCommand(req, root)}`
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
function reviewView(root: string, id: string, dir: string, s: Status, env: Env): Result {
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
    const fresh = freshness(root, dir, req, c, headOf(dir, req, 1))
    const out: Record<string, unknown> = {
      id, state: s.state, round, candidate_hash: c.hash, reviewer, degradations: req.degradations, risk: riskView(req),
      ...roundShape(dir, s, round), ...fresh, ...common, questions: [],
    }
    if (reviewBusy(dir)) out.next = busyNext(id)
    else if (!TERMINAL.has(s.state)) out.next = `./bin/sdd-ai wait ${id}`
    else if (fresh.stale_reason === 'inputs') out.next = inputsChanged(id, req)
    else out.next = relaunchNext(id, dir, req, s, round, 0, env)
    return { code, out }
  }

  const ledger = readJson<Ledger>(ledgerFile)
  const c = readJson<Candidate>(join(dir, `candidate${tagOf(ledger.completed)}.json`))
  const receipt = readJson<Receipt>(join(dir, 'receipt.json'))
  const rounds = existsSync(join(dir, 'rounds.json')) ? readJson<{ rounds: RoundRecord[] }>(join(dir, 'rounds.json')).rounds : []
  const fresh = freshness(root, dir, req, c, headOf(dir, req, ledger.completed))
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
    questions: questionsOf(id, dir, s, ledger, fresh),
    next: roundNext(root, id, dir, req, s, round, ledger, fresh, env),
  }
  return { code, out }
}

/** Las pruebas de las rondas extra, en `extra-approvals.json`: las entradas solo se agregan. */
interface ExtraApprovals { schema_version: 1; rounds: Array<{ round: number; proof: Proof }> }
const EXTRA_APPROVALS = 'extra-approvals.json'
function readExtraApprovals(dir: string): ExtraApprovals {
  const file = join(dir, EXTRA_APPROVALS)
  return existsSync(file) ? readJson<ExtraApprovals>(file) : { schema_version: 1, rounds: [] }
}

/** Las respuestas ya usadas en la revisión: las de sus decisiones, también las reemplazadas, y las de sus rondas extra. */
function consumedRefs(ledger: Ledger | undefined, dir: string): Set<string> {
  const refs = new Set<string>()
  for (const e of ledger?.entries ?? []) {
    for (const d of [...(e.superseded ?? []), ...(e.decision ? [e.decision] : [])]) if (d.proof) refs.add(d.proof.ref)
  }
  for (const r of readExtraApprovals(dir).rounds) refs.add(r.proof.ref)
  return refs
}

/** Si relanzar la ronda extra `round` puede reusar su prueba registrada, o por qué no; con dos sesiones no se puede saber. */
export type ExtraReuse = { reuse: true; proof: Proof } | { reuse: false; reason: string } | { reuse: 'unknown'; reason: string }

/**
 * La prueba vigente de la ronda sirve para relanzarla si es de esta misma sesión y su respuesta sigue
 * siendo la última a esa pregunta: así se descarta un `Dejar` posterior. Si el archivo de la sesión no
 * se puede leer, no se puede descartar, y se pide otra respuesta.
 */
export function extraReuse(env: Env, conductor: Family | undefined, dir: string, id: string, round: number): ExtraReuse {
  const last = readExtraApprovals(dir).rounds.filter((r) => r.round === round).at(-1)
  if (last === undefined) return { reuse: false, reason: `la ronda ${round} no tiene una respuesta registrada` }
  let r: Runner
  try {
    r = detectRunner(env, conductor)
  } catch (e) {
    if (e instanceof SddError && e.code === 'conductor_unknown') {
      return { reuse: 'unknown', reason: 'el entorno tiene la sesión de Claude Code y la de Codex: review round --extra --conductor claude|codex elige de cuál se lee' }
    }
    return { reuse: false, reason: 'el entorno no identifica la sesión de un runner' }
  }
  if (r.runner !== last.proof.runner || r.session !== last.proof.session) return { reuse: false, reason: 'la respuesta se dio en otra sesión' }
  try {
    const answers = answersFor(r, readTail(sessionFile(env, r)), extraQuestion(id, round))
    if (answers.at(-1)?.ref !== last.proof.ref) return { reuse: false, reason: 'una respuesta posterior a la misma pregunta la reemplazó' }
  } catch {
    return { reuse: false, reason: 'no se pudo leer el archivo de la sesión para descartar una respuesta posterior' }
  }
  return { reuse: true, proof: last.proof }
}

/** El tope sin `--extra`: la ronda siguiente la decide el usuario con la pregunta canónica. */
const roundCap = (id: string, completed: number) =>
  new SddError('round_cap', `la revisión ya hizo ${ROUND_CAP} rondas y quedan hallazgos vigentes`, {
    next: `pregunta al usuario si quiere una ronda más (./bin/sdd-ai review round ${id} --extra) o dejar la revisión como está: `
      + askNext(extraQuestion(id, completed + 1)),
  })

/** La respuesta nueva que autoriza la ronda extra `n`, o `undefined` si el relanzamiento reusa la registrada. */
function extraProof(env: Env, conductor: Family | undefined, dir: string, id: string, n: number, ledger: Ledger | undefined): Proof | undefined {
  if (extraReuse(env, conductor, dir, id, n).reuse === true) return undefined
  return prove({ env, conductor, q: extraQuestion(id, n), authorizes: extraOptions(n).launch, consumed: consumedRefs(ledger, dir) })
}

/** Agrega la prueba de la ronda `n`: la vigente es la última con ese número. */
function registerExtra(dir: string, n: number, proof: Proof | undefined): void {
  if (proof === undefined) return
  const current = readExtraApprovals(dir)
  writeJsonAtomic(join(dir, EXTRA_APPROVALS), { schema_version: 1, rounds: [...current.rounds, { round: n, proof }] })
}

const reviewInProgress = (id: string) => () => new SddError('review_in_progress', `otra operación tiene tomada la revisión ${id}`, {
  next: `si no hay otro review decide ni review round corriendo, borra .sdd-ai/runs/${id}/${REVIEW_LOCK} y vuelve a correr el comando`,
})
const decisionConflict = (id: string, what: string) => new SddError('decision_conflict', `otro comando registró ${what} mientras este esperaba`, {
  next: `corre ./bin/sdd-ai review status ${id} para ver el estado nuevo`,
})

/**
 * Registra la decisión del conductor, o la del usuario en una disputa, y devuelve la vista actualizada.
 * Cada disputa exige la respuesta del usuario a su pregunta canónica. Todo se valida con la revisión
 * tomada y sobre lo que se relee ahí; la vista se arma después de soltarla.
 */
function reviewDecide(args: string[], env: Env, cwd: string): Result {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true, options: { reason: { type: 'string' }, conductor: { type: 'string' } },
  })
  const [id, action, ...ids] = positionals
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai review decide <id> accept|reject <F-n>… [--reason <motivo>] [--conductor claude|codex]' })
  checkRunId(id)
  const conductor = conductorFlag(values.conductor)
  const root = repoRoot(cwd)
  const dir = runDir(root, id)
  const file = join(dir, 'ledger.json')
  const check = () => {
    if (!TERMINAL.has(readStatus(dir).state)) {
      throw new SddError('usage', 'la ronda está en curso: se decide cuando termine', { next: `./bin/sdd-ai wait ${id}` })
    }
    if (!existsSync(file)) throw new SddError('usage', 'la revisión no tiene hallazgos admitidos que decidir', { next: `./bin/sdd-ai review status ${id}` })
    if (action !== 'accept' && action !== 'reject') {
      throw new SddError('usage', `acción desconocida: ${action ?? ''}`, { next: 'usa accept o reject' })
    }
    return readJson<Ledger>(file)
  }
  // Lo que se va a decidir, antes de esperar: si otro comando lo cambia mientras tanto, es un conflicto.
  const observed = check()
  const decisionOf = (l: Ledger, x: string) => JSON.stringify(l.entries.find((e) => e.id === x)?.decision ?? null)
  const seen = new Map(ids.map((x) => [x, decisionOf(observed, x)]))

  withLock(join(dir, REVIEW_LOCK), reviewInProgress(id), () => {
    const ledger = check()
    const act = action as 'accept' | 'reject'
    if (ledger.completed !== observed.completed) throw decisionConflict(id, `la ronda ${ledger.completed}`)
    const changed = ids.filter((x) => decisionOf(ledger, x) !== seen.get(x))
    if (changed.length > 0) throw decisionConflict(id, `una decisión de ${changed.join(', ')}`)

    const chosen = [...new Set(ids)].flatMap((x) => ledger.entries.filter((e) => e.id === x))
    const disputes = chosen.filter((e) => disputable(e, ledger.completed))
    const shown = new Map(disputes.map((e) => [e.id, lastRejection(e)]))
    const unknown = disputes.filter((e) => shown.get(e.id) === undefined).map((e) => e.id)
    if (unknown.length > 0) {
      throw new SddError('usage', `la disputa ${unknown.join(', ')} no tiene un motivo de rechazo registrado: su pregunta no se puede armar`, {
        next: `./bin/sdd-ai review status ${id}`,
      })
    }
    let reason = values.reason
    if (act === 'reject' && disputes.length > 0) {
      const reasons = [...new Set(shown.values())] as string[]
      if (reasons.length > 1) {
        throw new SddError('approval_contradicted', 'las disputas del reject muestran motivos de rechazo distintos', {
          detail: `motivos: ${reasons.map((r) => JSON.stringify(r)).join(', ')}`,
          next: `decide cada disputa por separado: ./bin/sdd-ai review decide ${id} reject <F-n>`,
        })
      }
      const mixed = disputes.length < chosen.length
      if (mixed && reason === undefined) {
        throw new SddError('usage', 'un reject que mezcla disputas y otros hallazgos necesita --reason igual al motivo mostrado de sus disputas', {
          next: `decide las disputas (${disputes.map((e) => e.id).join(', ')}) por separado de los demás hallazgos`,
        })
      }
      if (reason !== undefined && reason !== reasons[0]) {
        throw new SddError('approval_contradicted', 'el --reason no es el motivo que mostró la pregunta de la disputa', {
          detail: `la pregunta mostró ${JSON.stringify(reasons[0])}`,
          next: `corre ./bin/sdd-ai review decide ${id} reject ${disputes.map((e) => e.id).join(' ')} sin --reason, o con el motivo mostrado`,
        })
      }
      reason = reasons[0]
    }

    const consumed = consumedRefs(ledger, dir)
    const proofs: Record<string, Proof> = {}
    for (const e of disputes) {
      const q = disputeQuestion(id, e, ledger.completed, shown.get(e.id)!)
      const proof = prove({ env, conductor, q, authorizes: act === 'accept' ? DISPUTE_OPTIONS.accept : DISPUTE_OPTIONS.reject, consumed })
      consumed.add(proof.ref)
      proofs[e.id] = proof
    }
    writeJsonAtomic(file, decide(ledger, act, ids, reason, proofs))
    writeReceipt(dir)
  })
  return reviewView(root, id, dir, readStatus(dir), env)
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
  root: string; dir: string; id: string; req: ReviewRequest; sel: ArtifactSelection; head?: string; extra: boolean; env: Env; conductor?: Family
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
    if (completed >= ROUND_CAP && !o.extra) throw roundCap(id, completed)
  }

  const n = completed + 1
  const tag = tagOf(n)
  const proof = o.extra ? extraProof(o.env, o.conductor, dir, id, n, ledger) : undefined
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
  registerExtra(dir, n, proof)
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
      questions: [], next: `./bin/sdd-ai wait ${id}`,
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
    args, strict: true, allowPositionals: true,
    options: { head: { type: 'string' }, extra: { type: 'boolean', default: false }, conductor: { type: 'string' } },
  })
  const id = positionals[0]
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai review round <id> [--head <ref>] [--extra] [--conductor claude|codex]' })
  checkRunId(id)
  if (env.SDD_AI_WORKER === '1') {
    // La ronda extra la decide el usuario: desde un worker no hay sesión de la que leer su respuesta.
    if (values.extra) detectRunner(env)
    throw new SddError('recursion', 'sdd-ai no se lanza desde un worker', { next: 'responde el encargo sin delegar' })
  }
  const conductor = conductorFlag(values.conductor)
  const root = repoRoot(cwd)
  const dir = runDir(root, id)
  // La ronda que se va a lanzar, antes de esperar: si otro comando la lanza mientras tanto, es un conflicto.
  const observe = () => {
    const ledgerFile = join(dir, 'ledger.json')
    const completed = existsSync(ledgerFile) ? readJson<Ledger>(ledgerFile).completed : 0
    return { terminal: TERMINAL.has(readStatus(dir).state), completed, launch: nextLaunch(dir, tagOf(completed + 1)) }
  }
  const observed = observe()
  if (!observed.terminal) {
    throw new SddError('usage', 'la ronda anterior sigue en curso', { next: `./bin/sdd-ai wait ${id}` })
  }
  return withLockAsync(join(dir, REVIEW_LOCK), reviewInProgress(id), async () => {
    const now = observe()
    if (!now.terminal || now.completed !== observed.completed || now.launch !== observed.launch) {
      throw decisionConflict(id, `la ronda ${observed.completed + 1}`)
    }
    const req = readJson<ReviewRequest>(join(dir, 'request.json'))
    if (isArtifact(req.selection)) {
      return reviewRoundArtifact({ root, dir, id, req, sel: req.selection, head: values.head, extra: values.extra, env, conductor })
    }
    return reviewRoundDiff({ root, dir, id, req, head: values.head, extra: values.extra, env, conductor })
  })
}

/** La ronda de una revisión de diff, con la revisión ya tomada. */
async function reviewRoundDiff(o: {
  root: string; dir: string; id: string; req: ReviewRequest; head?: string; extra: boolean; env: Env; conductor?: Family
}): Promise<Result> {
  const { root, dir, id, req, env } = o
  const values = { head: o.head, extra: o.extra }
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
    if (completed >= ROUND_CAP && !values.extra) throw roundCap(id, completed)
  }

  const n = completed + 1
  const tag = tagOf(n)
  const proof = values.extra ? extraProof(env, o.conductor, dir, id, n, ledger) : undefined
  const first = readJson<Candidate>(join(dir, 'candidate.json'))
  const prev = ledger ? readJson<Candidate>(join(dir, `candidate${tagOf(completed)}.json`)) : first
  let selection: Selection
  if (ledger) {
    selection = { base: baseOf(first), context: req.selection.context, ...untrackedOf(diffSelection(req)) }
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
  let delta: Risk | undefined
  try {
    const changed = identical ? {} : changedRanges(prev, candidate, dir)
    if (!identical) {
      delta = classifyDelta(prev, candidate, changed, dir)
      if (delta.level === 'high' && readRisk(req).level !== 'high') throw riskHigh(root, req, delta, selection.head)
    }
    const contextTexts = readContext(root, candidate)
    material = renderMaterial(candidate, contextTexts)
    if (ledger) {
      plan = { n, prev_hash: prev.hash, identical, targets: goals, changed }
      if (values.head) plan.head = values.head
      planned = planRoundJobs(candidate, contextTexts, plan, ledger.entries, ROUND_CAP, delta?.level === 'high' ? REVIEWERS : ['base'])
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
  registerExtra(dir, n, proof)
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
      ...(plan && delta?.level === 'high' ? { reviewers: planned.reviewers, delta_risk: delta } : {}),
      ...(planned.batches.length > 1 ? { batches: planned.batches.map((paths, i) => ({ n: i + 1, paths })) } : {}),
      ...(kept.length > 0 ? { kept: kept.map((j) => j.key) } : {}),
      left_out: candidate.left_out, questions: [], next: `./bin/sdd-ai wait ${id}`,
    },
  }
}

async function review(args: string[], env: Env, cwd: string): Promise<Result> {
  const [sub, ...rest] = args
  if (sub === 'start') return reviewStart(rest, env, cwd)
  if (sub === 'decide') return reviewDecide(rest, env, cwd)
  if (sub === 'round') return reviewRound(rest, env, cwd)
  if (sub === 'status') {
    const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} })
    const id = positionals[0]
    if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai review status <id>' })
    checkRunId(id)
    const root = repoRoot(cwd)
    const dir = runDir(root, id)
    const s = readStatus(dir)
    const view = reviewView(root, id, dir, s, env)
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
  const result = reportOf(root, id, dir, s, env)
  markDelivered(dir, s, env)
  return result
}

/**
 * Lo que `wait` devuelve de una corrida de fase terminada: el estado, el artefacto, los supuestos para el
 * gate y, si no se escribió, las preguntas, lo que falta o la causa. Ni el documento ni el contrato
 * viajan: quedan en la corrida. El `next` es el de `sdd status` sobre el disco de ahora.
 */
function phaseView(root: string, id: string, dir: string, s: Status, req: PhaseRequest): Result {
  const out: Record<string, unknown> = { id, state: s.state }
  if (s.reason) out.reason = s.reason
  if (s.detail) out.detail = s.detail
  const file = join(dir, 'phase.json')
  if (existsSync(file)) {
    const p = readJson<PhaseResult>(file)
    out.outcome = p.outcome
    if (p.artifact) out.artifact = p.artifact
    out.assumptions = p.assumptions
    if (p.outcome !== 'published') Object.assign(out, { blocking_questions: p.blocking_questions, missing_context: p.missing_context })
    if (p.cause) out.cause = p.cause
  }
  const warnings = profileWarnings(s)
  if (warnings.length > 0) out.warnings = warnings
  if (s.state === 'launch_failed' && s.fallback) {
    out.fallback = s.fallback
    out.next = phaseFallbackNext(req, s.fallback)
  } else {
    out.next = flowNext(root, req.flow)
  }
  return { code: s.state === 'done' ? 0 : 1, out }
}

function reportOf(root: string, id: string, dir: string, s: Status, env: Env): Result {
  const request = existsSync(join(dir, 'request.json')) ? readJson<{ kind?: string }>(join(dir, 'request.json')) : {}
  if (request.kind === 'review' && TERMINAL.has(s.state)) return reviewView(root, id, dir, s, env)
  if (request.kind === 'phase' && TERMINAL.has(s.state)) return phaseView(root, id, dir, s, request as PhaseRequest)
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
  checkRunId(id)
  const root = repoRoot(cwd)
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

  if (isWriterRun(root, id)) return waitWriter(root, id, max, env)
  const dir = runDir(root, id)
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

async function cancel(args: string[], cwd: string): Promise<Result> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { 'writer-gone': { type: 'boolean', default: false } } })
  const id = positionals[0]
  if (!id) throw new SddError('usage', 'falta el id', { next: './bin/sdd-ai cancel <id>' })
  checkRunId(id)
  const root = repoRoot(cwd)
  if (isWriterRun(root, id)) return cancelWriter(root, id, values['writer-gone'])
  const orphan = orphanEntry(root, id)
  if (orphan) {
    // El lanzamiento tiene el lock del flujo: al tomarlo, la corrida pudo haber llegado a su control. Una
    // entrada que ya se marcó como fallida no se vuelve a marcar.
    const marked = withFlowLock(root, orphan.flow, () => {
      if (isWriterRun(root, id)) return false
      const events = implementOf(readPhaseRecord(root, orphan.flow)).events
      if (!events.some((e) => e.kind === 'launch_failed' && e.run === id)) {
        appendEvent(root, orphan.flow, { kind: 'launch_failed', at: new Date().toISOString(), chain: orphan.chain, run: id, detail: 'la corrida quedó registrada sin control: nunca se lanzó' })
      }
      return true
    })
    if (!marked) return cancelWriter(root, id, values['writer-gone'])
    if (readReservation(root)?.id === id) releaseWriter(root, id)
    return { code: 0, out: { id, state: 'launch_failed', flow: orphan.flow, next: flowNextOrStatus(root, orphan.flow) } }
  }
  if (readReservation(root)?.id === id) return releaseOrphan(root, id)
  if (values['writer-gone']) throw new SddError('usage', '--writer-gone solo se usa con la corrida de un writer')
  const dir = runDir(root, id)
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

/** La entrada de una cadena registrada sin control: el proceso cayó entre el registro y el control. */
function orphanEntry(root: string, run: string): { flow: string; chain: string } | null {
  for (const flow of listFlows(root)) {
    let chains
    try {
      chains = implementOf(readPhaseRecord(root, flow.id)).chains
    } catch {
      continue
    }
    const chain = chains.find((c) => c.entries.some((e) => e.kind !== 'takeover' && e.run === run))
    if (chain) return { flow: flow.id, chain: chain.id }
  }
  return null
}

function flowNextOrStatus(root: string, flow: string): unknown {
  try {
    return flowNext(root, flow)
  } catch {
    return `./bin/sdd-ai sdd status ${flow}`
  }
}

/**
 * Un writer de cadena que nunca llegó a lanzarse queda como evento `launch_failed` en su cadena: no es un
 * eslabón ni gasta una ronda. Sin el lock del flujo disponible, lo deriva igual la cadena por su cosecha.
 */
function chainLaunchFailed(root: string, c: WriterControl, detail: string): void {
  if (!c.phase?.kind || !c.phase.chain) return
  const phase = c.phase
  try {
    withFlowLock(root, phase.flow, () => appendEvent(root, phase.flow, { kind: 'launch_failed', at: new Date().toISOString(), chain: phase.chain!, run: c.id, detail }))
  } catch {
    // La cosecha en launch_failed ya la excluye de la cadena.
  }
}

/** Si el árbol sigue siendo el de lanzamiento del writer: el del padre en una corrida encadenada, la base si no. */
const launchHolds = (root: string, c: WriterControl) => (c.phase?.launch_from ? launchTreeHolds(root, c) : captureTreeAtBase(root, c.id))

/** Lo que la cosecha de un writer de fase dice de su contrato. */
interface PhaseContract { admitted: boolean; cause?: string; missing_context: string[] }

/**
 * El contrato del reporte de un writer de fase, contra lo que congeló al lanzar. Sin corrección. Un `fix`
 * responde por sus filas; las demás corridas de la cadena, por sus tasks con `completion`; un writer
 * anterior a las cadenas, con el contrato de entonces.
 */
function phaseContract(h: HarvestRecord, phase: NonNullable<WriterControl['phase']>): PhaseContract {
  const report = h.report ?? ''
  const a = phase.kind === 'fix'
    ? admitFix(report, (phase.fix?.rows ?? []).map((r) => r.id))
    : admitImplement(report, phase.pending, { explicit: phase.kind !== undefined })
  if (a.kind === 'admitted') return { admitted: true, missing_context: a.review.missing_context }
  return { admitted: false, cause: a.kind === 'inadmissible' ? a.error : a.reason, missing_context: [] }
}

/**
 * Lo que la cosecha de un writer de cadena agrega: las tasks que siguen, el delta frente a su padre, los
 * tramos que el encargo de un `fix` recortó y la señal de síntoma forzado, que cruza solo el delta del `fix`
 * con las pruebas de todas las filas de test rojas de su recibo de entrada. Una consulta: no escribe nada.
 */
function chainReport(root: string, c: WriterControl, h: HarvestRecord): { extra: Record<string, unknown>; failed: string[]; view: ChainView | null } {
  const phase = c.phase!
  // Un delta que no se pudo medir va como null: la lista de la cosecha es el cambio acumulado de toda la cadena.
  const extra: Record<string, unknown> = { delta: h.delta_unmeasured ? null : (h.delta ?? h.files.map((f) => f.path)) }
  const failed: string[] = []
  let view: ChainView | null = null
  try {
    view = chainView(root, phase.flow, readFlow(root, phase.flow))
  } catch (e) {
    // Sin la cadena no hay qué seguir: la cosecha lo dice, en vez de caer en el next de un writer suelto.
    failed.push(`no se pudo leer la cadena del writer: ${(e as Error).message}`)
  }
  if (phase.kind !== 'fix' && view) {
    extra.left = view.state.left
    if (view.state.left.length > 0) {
      extra.partial = true
      failed.push(`cosecha parcial: quedan ${view.state.left.join(', ')}`)
    }
  }
  if (h.delta_unmeasured) failed.push('no se pudo medir el delta frente a su padre: la corrida no acredita tasks')
  else if ((h.delta ?? []).length === 0) failed.push('sin cambios frente a su padre')
  if (phase.kind === 'fix' && phase.fix) {
    if (phase.fix.trimmed.length > 0) extra.trimmed = phase.fix.trimmed
    const signal = h.delta_unmeasured ? { unknown: 'no se pudo medir el delta frente a su padre' } : forcedSymptom(root, phase.flow, phase.fix.receipt, h.delta ?? [])
    // Una señal que no se pudo evaluar no se presenta como una corrección que no tocó pruebas rojas.
    extra.forced_symptom = 'unknown' in signal ? null : signal.pairs
    if ('unknown' in signal) failed.push(`no se pudo evaluar la señal de síntoma forzado: ${signal.unknown}`)
  }
  return { extra, failed, view }
}

/**
 * Los pares fila y ruta en que el delta de un `fix` toca la prueba de una fila de test roja del recibo de entrada,
 * o por qué no se pudieron evaluar: sin el recibo o sin el contrato no hay con qué cruzar el delta.
 */
function forcedSymptom(root: string, flow: string, ref: { id: string; digest: string }, delta: string[]): { pairs: { row: string; path: string }[] } | { unknown: string } {
  let receipt: VerifyReceipt
  let rows: VerificationRow[]
  try {
    receipt = readVerifyReceipt(root, { ...ref, mode: 'final' })
    rows = contractRows(root, flow)
  } catch (e) {
    return { unknown: (e as Error).message }
  }
  const red = new Set(redRows(receipt))
  const pairs: { row: string; path: string }[] = []
  for (const row of rows) {
    if (row.kind !== 'test' || !red.has(row.id)) continue
    for (const path of row.test_paths) if (delta.includes(path)) pairs.push({ row: row.id, path })
  }
  return { pairs }
}

/** Lo que falta para proponer la revisión de una cosecha: cada condición que falló, con palabras. */
function harvestFailures(h: HarvestRecord, contract?: PhaseContract): string[] {
  const failed: string[] = []
  if (contract && !contract.admitted) failed.push(`el contrato de la fase no se admitió: ${contract.cause ?? ''}`)
  if (contract && contract.missing_context.length > 0) failed.push(`al writer le faltó contexto: ${contract.missing_context.join('; ')}`)
  if (h.phase_inputs === 'changed') failed.push('cambiaron los insumos de la fase (spec, plan, tasks o el header del handoff) desde que se lanzó')
  if (h.state !== 'done') failed.push(`el writer terminó en ${h.state}${h.reason ? `/${h.reason}` : ''}`)
  if (!h.endMark) failed.push('el reporte no cierra con la marca de fin')
  if (h.files.length === 0) failed.push('el cambio está vacío')
  if (h.flagged.length > 0) failed.push(`hay rutas señaladas: ${h.flagged.map((f) => f.path).join(', ')}`)
  if (h.runAltered.length > 0) failed.push(`el writer alteró su corrida: ${h.runAltered.map((f) => f.path).join(', ')}`)
  if (h.headMoved) failed.push('HEAD ya no es la base')
  return failed
}

function harvestNext(id: string, h: HarvestRecord, c: WriterControl, failed: string[]): string {
  const family = c.family
  if (failed.length === 0) {
    return `mira el diff completo (${h.patchFile}) y lanza la revisión antes de correr nada que cambie el árbol: ./bin/sdd-ai review start --harvest ${id} --base ${h.base} --author ${family}`
  }
  if (h.files.length === 0 && h.flagged.length === 0 && h.runAltered.length === 0 && !h.headMoved) {
    const why = h.state === 'done' ? 'el writer terminó sin cambios' : failed[0]
    // Un writer de fase se relanza con el verbo de la fase, que vuelve a congelar las tasks pendientes,
    // con la misma familia: `run --retry` rechaza los roles de fase.
    const relaunch = c.phase
      ? `./bin/sdd-ai sdd phase ${c.phase.flow} --families ${family} --conductor ${c.request.conductor.family}`
      : `./bin/sdd-ai run --retry ${id}`
    return `no hay nada que conservar ni revertir (${why}); pregunta al usuario si relanza: ${relaunch}`
  }
  return `no se propone revisión: ${failed.join('; ')}. Pregunta al usuario si conserva el cambio o lo revierte; sdd-ai no revierte nada`
}

/**
 * Anota la entrega, solo si la consulta viene de la sesión dueña que guardó el control. Va al almacén;
 * si el almacén no se puede escribir, como dentro del sandbox de un conductor Codex, va a la corrida
 * visible. Eso se hace solo con la cosecha ya congelada, cuando el writer dejó de escribir, y solo si
 * su ruta real es la de siempre.
 */
function markWriterDelivered(root: string, id: string, state: Status['state'], env: Env): void {
  try {
    const c = readControl(root, id)
    if (!TERMINAL.has(state) || !c.session || ownerSession(env, c.request.conductor.family) !== c.session) return
    const mark = { round: null, launch: null }
    try {
      writeJsonAtomic(join(storeDir(root, id), 'delivered.json'), mark)
    } catch {
      // Ningún tramo de la ruta puede ser un enlace que dejó el writer: `.sdd-ai`, `runs` ni la corrida.
      const run = join(root, '.sdd-ai', 'runs', id)
      if (realpathSync(run) === join(realpathSync(root), '.sdd-ai', 'runs', id)) writeJsonAtomic(join(run, 'delivered.json'), mark)
    }
  } catch {
    // Anotar la entrega nunca impide devolverla.
  }
}


function writerReport(root: string, id: string, h: HarvestRecord, env: Env): Result {
  const c = readControl(root, id)
  const s = readStatus(storeDir(root, id))
  const out: Record<string, unknown> = { id, state: h.state }
  if (h.reason) out.reason = h.reason
  if (h.detail) out.detail = h.detail
  Object.assign(out, {
    base: h.base, files: h.files, diff: h.patchFile, flagged: h.flagged, run_altered: h.runAltered, head_moved: h.headMoved,
    report: h.report ?? null, end_mark: h.endMark,
  })
  const contract = c.phase ? phaseContract(h, c.phase) : undefined
  const chain = c.phase?.kind ? chainReport(root, c, h) : null
  const failed = [...harvestFailures(h, contract), ...(chain?.failed ?? [])]
  if (failed.length > 0) out.failed = failed
  if (chain) Object.assign(out, chain.extra)
  if (s.session_id) out.session_id = s.session_id
  const warnings = profileWarnings(s)
  if (chain?.extra.trimmed) warnings.push(`el encargo del fix recortó los tramos de salida de ${(chain.extra.trimmed as string[]).join(', ')} para entrar en el tope`)
  if (warnings.length > 0) out.warnings = warnings
  // Un writer de cadena sigue lo que dice su cadena, salvo que su cosecha tenga alertas de integridad.
  const integrity = h.flagged.length === 0 && h.runAltered.length === 0 && !h.headMoved
  out.next = chain && integrity
    ? (chain.view ? orientation(c.phase!.flow, chain.view.state.next) : `revisa el registro de fases del flujo: ./bin/sdd-ai sdd status ${c.phase!.flow}`)
    : harvestNext(id, h, c, failed)
  if (c.phase && contract) {
    out.contract = contract
    try {
      out.flow_next = flowNext(root, c.phase.flow)
    } catch (e) {
      if (!(e instanceof SddError)) throw e
      out.flow_next = { step: 'resolve_blockers', detail: e.message }
    }
  }
  markWriterDelivered(root, id, h.state, env)
  return { code: h.state === 'done' ? 0 : 1, out }
}

const writerGoneNext = (id: string) =>
  `detente y pregúntale al usuario si el writer ya no corre, sin tocar el árbol; solo con su confirmación: ./bin/sdd-ai cancel ${id} --writer-gone (congela la cosecha y libera la reserva sin enviar ninguna señal)`

function uncertain(root: string, id: string, reason: string, detail: string): Result {
  setStatus(storeDir(root, id), { state: 'cessation_uncertain', reason, detail })
  return { code: 1, out: { id, state: 'cessation_uncertain', reason, detail, next: writerGoneNext(id) } }
}

/**
 * La corrida de un writer cuyo supervisor desapareció sin terminal. Si el writer nunca se lanzó, se
 * congela lo que hay; si se lanzó, solo se cosecha con el grupo confirmado vacío. Sin identidad
 * registrada, o con el grupo vivo, el cese queda incierto y la reserva sigue tomada.
 */
async function recoverWriter(root: string, id: string, env: Env): Promise<Result> {
  if (!canWriteStore(root)) throw controlUnavailable()
  const c = readControl(root, id)
  if (!c.spawning) {
    const outcome = launchHolds(root, c)
      ? { state: 'failed' as const, reason: 'supervisor_lost', detail: 'el supervisor terminó antes de lanzar al writer' }
      : { state: 'launch_failed' as const, reason: 'tree_changed', detail: 'el árbol cambió y el writer nunca se lanzó' }
    const record = await freezeHarvest(root, id, outcome)
    chainLaunchFailed(root, c, outcome.detail)
    return writerReport(root, id, record, env)
  }
  if (!c.group) return uncertain(root, id, 'no_identity', 'el supervisor terminó mientras lanzaba al writer, antes de registrar su grupo')
  const state = groupState(c.group)
  if (state !== 'gone') {
    return uncertain(root, id, state === 'alive' ? 'group_alive' : 'group_unknown',
      `el supervisor terminó y el grupo ${c.group.pgid} del writer ${state === 'alive' ? 'sigue vivo' : 'no se puede consultar'}`)
  }
  const record = await freezeHarvest(root, id, { state: 'failed', reason: 'supervisor_lost', detail: 'el supervisor terminó sin escribir un estado final' })
  return writerReport(root, id, record, env)
}

/** `wait` de un writer: solo el terminal del almacén lo hace volver, nunca un estado de la corrida visible. */
async function waitWriter(root: string, id: string, max: number, env: Env): Promise<Result> {
  const store = storeDir(root, id)
  const until = Date.now() + max * 1000
  for (;;) {
    const h = readHarvest(root, id)
    if (h) {
      // Una caída entre publicar el registro y liberar deja la reserva tomada: la libera quien lo lee,
      // si puede escribir el almacén.
      try {
        releaseWriter(root, id)
      } catch {
        // Dentro del sandbox no se puede: la liberará el próximo que lea con permiso.
      }
      return writerReport(root, id, h, env)
    }
    const s = readStatus(store)
    if (s.state === 'cessation_uncertain') {
      return { code: 1, out: { id, state: s.state, reason: s.reason, detail: s.detail, next: writerGoneNext(id) } }
    }
    const pid = s.supervisor_pid ?? readSupervisorPid(store)
    if (pid !== undefined && !isAlive(pid)) {
      // El supervisor pudo publicar la cosecha justo antes de terminar.
      const late = readHarvest(root, id)
      return late ? writerReport(root, id, late, env) : recoverWriter(root, id, env)
    }
    if (Date.now() >= until) return { code: 3, out: { id, state: s.state, next: `./bin/sdd-ai wait ${id}` } }
    await sleep(250)
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, 0)
    process.kill(-pgid, signal)
  } catch {
    // El grupo ya no existe.
  }
}

/**
 * `cancel` de un writer. Con el supervisor vivo, pide la cancelación en el almacén y, si acredita al
 * líder del grupo, lo señala; el supervisor congela. Con el supervisor muerto, detiene el grupo solo
 * si lo acredita, confirma el cese y congela. `--writer-gone` congela y libera sin señalar, después de
 * que el usuario confirmó que el writer ya no corre.
 */
async function cancelWriter(root: string, id: string, writerGone: boolean): Promise<Result> {
  const store = storeDir(root, id)
  const done = readHarvest(root, id)
  if (done) {
    try {
      releaseWriter(root, id)
    } catch {
      // Dentro del sandbox no se puede: la liberará el próximo que lea con permiso.
    }
    return { code: 0, out: { id, state: done.state } }
  }
  if (!canWriteStore(root)) throw controlUnavailable()
  const freeze = async (reason?: string, detail?: string) => {
    const r = await freezeHarvest(root, id, { state: 'cancelled', ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) })
    return { code: 0, out: { id, state: r.state, next: `./bin/sdd-ai wait ${id}` } }
  }
  if (writerGone) return freeze('writer_gone', 'el usuario confirmó que el writer ya no corre')
  writeFileSync(join(store, 'cancel.request'), new Date().toISOString())
  const c = readControl(root, id)
  const supervisorPid = readStatus(store).supervisor_pid ?? readSupervisorPid(store)
  const supervised = supervisorPid !== undefined && isAlive(supervisorPid)
  const requested = { code: 0, out: { id, state: 'cancel_requested', next: `./bin/sdd-ai wait ${id}` } }
  if (!c.spawning) {
    // El supervisor ve el pedido antes de lanzar; si murió, el writer nunca se lanzó.
    if (supervised) return requested
    if (launchHolds(root, c)) {
      const r = await freeze('not_launched', 'el writer nunca se lanzó')
      chainLaunchFailed(root, c, 'el writer nunca se lanzó')
      return r
    }
    const r = await freezeHarvest(root, id, { state: 'launch_failed', reason: 'tree_changed', detail: 'el árbol cambió y el writer nunca se lanzó' })
    chainLaunchFailed(root, c, 'el árbol cambió y el writer nunca se lanzó')
    return { code: 0, out: { id, state: r.state, reason: r.reason, next: `./bin/sdd-ai wait ${id}` } }
  }
  if (!c.group) {
    if (supervised) return requested
    return uncertain(root, id, 'no_identity', 'el writer se lanzó sin que quedara registrado su grupo')
  }
  if (groupState(c.group) === 'gone') return supervised ? requested : freeze()
  const matches = leaderMatches(c.group)
  if (matches !== true) {
    return uncertain(root, id, matches === false ? 'identity_mismatch' : 'identity_unverifiable',
      `el grupo ${c.group.pgid} sigue vivo y su líder ${matches === false ? 'ya no es el writer registrado' : 'no se puede acreditar'}: no se envió ninguna señal`)
  }
  signalGroup(c.group.pgid, 'SIGTERM')
  if (supervised) return requested
  if (await settleGroup(c.group, 10_000) !== 'gone') {
    return uncertain(root, id, 'group_alive', `el grupo ${c.group.pgid} sigue vivo después de SIGKILL`)
  }
  return freeze()
}

/**
 * Una reserva sin control: `run` la tomó y no llegó a escribir el almacén. Se libera solo desde el
 * checkout que la tomó, y solo si el proceso que la tomó ya no existe o no es el mismo; si sigue vivo,
 * está lanzando y no se toca. Desde otro worktree, la corrida no existe.
 */
function releaseOrphan(root: string, id: string): Result {
  const r = readReservation(root)
  if (!r || r.id !== id) return { code: 0, out: { id, state: 'released' } }
  if (r.gitDir !== gitDirs(root).gitDir) {
    throw new SddError('run_not_found', `no existe la corrida ${id} en este checkout`, { next: 'corre el comando desde el checkout que la lanzó' })
  }
  const seen = readProcess(r.pid)
  const alive = seen === undefined ? isAlive(r.pid) : seen !== 'gone' && (r.lstart === null || seen.lstart === r.lstart)
  if (alive) return { code: 1, out: { id, state: 'launching', next: `run todavía está lanzando ${id}; vuelve a consultar con ./bin/sdd-ai wait ${id}` } }
  releaseWriter(root, id)
  return { code: 0, out: { id, state: 'released' } }
}

function agents(args: string[], env: Env, cwd: string): Result {
  if (args[0] !== 'sync') throw new SddError('usage', `subcomando desconocido: agents ${args[0] ?? ''}`, { next: './bin/sdd-ai agents sync' })
  parseArgs({ args: args.slice(1), strict: true, allowPositionals: false, options: {} })
  const root = repoRoot(cwd)
  const { written, removed } = syncAgents(root, PKG_DIR, nativeProfiles(root, env))
  return { code: 0, out: { written, removed, next: 'reabre la sesión para que el CLI cargue los agentes y la skill' } }
}

/**
 * `init` prepara el checkout: sin `--apply`, un ensayo que no escribe; con `--apply`, el plan de ese
 * ensayo, atado a su digest.
 */
function init(args: string[], env: Env, cwd: string): Result {
  const { values } = parseArgs({
    args, strict: true, allowPositionals: false,
    options: { apply: { type: 'boolean' }, digest: { type: 'string' }, families: { type: 'string' }, jira: { type: 'string' }, from: { type: 'string' } },
  })
  const answers: InitAnswers = {}
  if (values.families !== undefined) answers.families = parseFamiliesFlag(values.families)
  if (values.jira !== undefined) {
    if (values.jira !== 'on' && values.jira !== 'off') throw new SddError('usage', `--jira tiene que ser on u off, no ${JSON.stringify(values.jira)}`)
    answers.jira = values.jira
  }
  if (values.from !== undefined) answers.from = resolvePath(cwd, values.from)
  const root = repoRoot(cwd)
  // Un worktree sin node_modules se prepara con el binario de otro checkout: los comandos lo nombran.
  const bin = realpathSync(PKG_DIR) === realpathSync(root) ? './bin/sdd-ai' : `node ${shellArg(BIN_PATH)}`
  const flags: string[] = []
  if (answers.families !== undefined) flags.push('--families', answers.families.join(','))
  if (answers.jira !== undefined) flags.push('--jira', answers.jira)
  if (answers.from !== undefined) flags.push('--from', shellArg(answers.from))
  const command = (digest?: string) => [bin, 'init', ...(digest === undefined ? [] : ['--apply', '--digest', digest]), ...flags].join(' ')
  if (!values.apply) return { code: 0, out: planInit(root, answers, env, { command }) }
  if (values.digest === undefined) {
    throw new SddError('usage', 'init --apply necesita --digest con el digest del ensayo', { next: command() })
  }
  return { code: 0, out: applyInit(root, answers, values.digest, env, { command }) }
}

const PHASE_STEPS: readonly string[] = ['specify', 'plan', 'tasks', 'implement']

/**
 * El `next` de `sdd status <id>`: en un gate, la pregunta que el conductor le hace al usuario antes de
 * `sdd approve`; en una fase, el comando que la lanza o por qué no hay comando.
 */
function nextOf(root: string, status: FlowStatus, facts: FlowRead['facts']): Record<string, unknown> {
  if (status.next.step === 'gate' && status.next.gate !== undefined && status.depth !== null) {
    return { ...status.next, question: gateQuestionFor(status.id, status.depth, status.next.gate, facts.fingerprints) }
  }
  return { ...withPhaseNext(root, status.id, status) }
}

/** El `next` que daría `sdd status <id>` ahora. */
function flowNext(root: string, flow: string): Record<string, unknown> {
  const { facts } = readFlow(root, flow)
  return nextOf(root, resolveFlow(facts), facts)
}

/** Lo que `sdd phase` deja en `request.json`: el reintento de una caída se arma con esto. */
interface PhaseRequest {
  kind: 'phase'; flow: string; step: PhaseStep; amended: boolean; role: string; conductor: Conductor; session?: string
  request_file?: string; context_file?: string
  overrides: { families?: string; deadline_sec: number }
}

/** El reintento de una corrida de fase: el mismo verbo con la familia del conductor, nunca `run --retry`. */
function phaseFallbackNext(r: Pick<PhaseRequest, 'flow' | 'request_file' | 'context_file'>, c: Conductor): string {
  const flags = [
    ...(r.request_file !== undefined ? [`--request ${shellArg(r.request_file)}`] : []),
    ...(r.context_file !== undefined ? [`--context ${shellArg(r.context_file)}`] : []),
    `--families ${c.family}`, `--conductor ${c.family}`,
  ]
  return `pregunta al usuario si cae a ${c.family}; solo con un sí: ./bin/sdd-ai sdd phase ${r.flow} ${flags.join(' ')}`
}

interface ImplementPhase {
  root: string; env: Env; id: string; read: FlowRead; depth: 'normal' | 'completa'; conductor: Conductor; families?: string; deadline: number
  /** El paso de `sdd status`: `implement` lanza la cadena; `verify` resuelve el último recibo rojo. */
  step: 'implement' | 'verify'
  blocks?: boolean
  /** El archivo de clases del conductor, con ruta absoluta. */
  classes?: string
}

/** Una corrida de la cadena lista para registrar y lanzar. */
interface ChainLaunch {
  kind: RunKind; chain: string | null; parent: string | null; launchFrom?: LaunchFrom; resumes?: string
  pending: string[]; prompt: string; mode: 'resume' | 'fresh' | 'initial'; origin?: string; base: string
  fix?: NonNullable<WriterControl['phase']>['fix']
}

const refusal = (code: string, message: string, next: string, detail?: string) => new SddError(code, message, { next, ...(detail ? { detail } : {}) })
const takeoverNext = (id: string) => `sigue a mano y declara la toma antes de verificar: ./bin/sdd-ai sdd verify ${id} --takeover`
/** Un terminal derivado lleva una fecha de relleno: se escribe con la de ahora. */
const stamped = (t: ChainTerminal): ChainTerminal => ({ ...t, at: new Date().toISOString() })

/**
 * `implement` por fase, como cadena de writers. Bajo el lock del flujo: lee la cadena, persiste un
 * terminal que su estado ya implica, decide qué corrida sigue (el writer inicial, una continuación, un
 * bloque, una reanudación o un `fix`) y la registra antes de lanzarla. Las tasks las marca el conductor.
 */
async function phaseImplement(p: ImplementPhase): Promise<Result> {
  const { root, id } = p
  const busy = () => new SddError('flow_busy', `otro comando de sdd-ai tiene tomado el flujo ${id}`, {
    next: `si no hay otro sdd approve ni sdd phase corriendo, borra .plans/${id}/${LOCK_FILE} y vuelve a correr el comando`,
  })
  return withLockAsync(join(flowDir(root, id), LOCK_FILE), busy, () => chainLaunch(p))
}

async function chainLaunch(p: ImplementPhase): Promise<Result> {
  const { root, id, read } = p
  let view = chainView(root, id, read)
  // Un writer anterior a las cadenas queda en el registro como una cadena cerrada: su cosecha no es padre.
  if (view.legacy && view.state.chain?.terminal) {
    const [entry] = view.state.chain.entries
    const chain = appendEntry(root, id, null, entry)
    closeChain(root, id, chain, stamped(view.state.chain.terminal))
    view = chainView(root, id, read)
  }
  if (view.state.derived && view.state.chain) {
    closeChain(root, id, view.state.chain.id, stamped(view.state.derived))
    view = chainView(root, id, read)
  }
  if (p.step === 'verify') return resolveReceipt(p, view)
  if (p.classes !== undefined) throw phaseUsage('--classes resuelve un recibo rojo: va en el paso verify')
  const s = view.state
  const next = s.next
  const last = s.last && s.last.kind !== 'takeover' ? s.last : null
  if (p.families !== undefined && next.kind !== 'start') throw phaseUsage('--families solo elige la familia del writer inicial de una cadena nueva')
  switch (next.kind) {
    case 'start':
      if (p.blocks) throw phaseUsage('--blocks reparte las pendientes de una cadena parcial')
      return launchLink(p, s, initialLink(p, s, view.input.failed))
    case 'resume':
      if (p.blocks) throw refusal('blocks_not_apt', `la corrida ${next.run} se cortó antes de cerrar: no es padre de un bloque`, `reanúdala: ./bin/sdd-ai sdd phase ${id}; o ${takeoverNext(id)}`)
      return launchLink(p, s, resumeLink(p, s, next.run))
    case 'continue':
      return launchLink(p, s, p.blocks ? blockLink(p, s, last!, next.left) : continuationLink(p, s, last!, next.left))
    case 'blocks_or_takeover':
      if (!p.blocks) throw refusal('no_progress', next.why, `reparte las pendientes en bloques: ./bin/sdd-ai sdd phase ${id} --blocks; o ${takeoverNext(id)}`)
      return launchLink(p, s, blockLink(p, s, last!, next.left))
    case 'wait':
      throw new SddError('phase_running', `el flujo ${id} tiene una corrida de fase activa: ${next.run}`, { next: `./bin/sdd-ai wait ${next.run}` })
    case 'orphan':
      throw refusal('launch_incomplete', `la corrida ${next.run} quedó registrada sin control`, `./bin/sdd-ai cancel ${next.run}`)
    case 'takeover':
    case 'conductor':
      throw refusal('chain_closed', next.why, takeoverNext(id))
    default:
      throw refusal('chain_complete', 'el último eslabón de la cadena está completo: no hay otra corrida que lanzar',
        `marca en tasks.md las tasks acreditadas (${s.covered.join(', ') || 'ninguna'}) y corre ./bin/sdd-ai sdd verify ${id}`)
  }
}

/** Los bytes congelados de spec, plan y tasks y sus huellas: cada corrida congela los suyos al lanzarse. */
function frozenInputs(root: string, read: FlowRead) {
  const bytes = { spec: flowBytes(root, read, 'spec'), plan: flowBytes(root, read, 'plan'), tasks: flowBytes(root, read, 'tasks') }
  return {
    text: { spec: bytes.spec.toString('utf8'), plan: bytes.plan.toString('utf8'), tasks: bytes.tasks.toString('utf8') },
    hashes: { spec: bytesHash(bytes.spec), plan: bytesHash(bytes.plan), tasks: bytesHash(bytes.tasks) },
  }
}

/** De dónde parte una corrida cuyo padre es `link`: su cosecha o su toma. */
function launchFromLink(link: ChainEntry): LaunchFrom {
  return link.kind === 'takeover' ? { takeover: link.map } : { run: link.run }
}

/**
 * La base de la cadena: la de su primera corrida lanzada, o la de la cadena anterior más cercana que tenga una;
 * `HEAD` si el flujo todavía no lanzó ninguna. Un control que existe y no se lee hace fallar la consulta: la base
 * no se reemplaza en silencio por la de ahora.
 */
function chainBase(root: string, id: string, s: ChainState): string {
  const base = s.chain ? chainBaseOf(root, implementOf(readPhaseRecord(root, id)), s.chain) : null
  return base ?? headCommit(root) ?? ''
}

/**
 * El writer inicial de una cadena nueva: todas las tasks abiertas, con sesión nueva y el árbol del último
 * eslabón. Si la cadena de ahora no tiene eslabones (todos sus lanzamientos fallaron), se relanza su inicial
 * dentro de ella, con el mismo padre y la misma base.
 */
function initialLink(p: ImplementPhase, s: ChainState, failed: ReadonlySet<string>): ChainLaunch {
  const { root, id, read, depth } = p
  const open = taskLines(frozenInputs(root, read).text.tasks).filter((l) => !l.done)
  const outside = open.filter((l) => l.task === null)
  if (outside.length > 0) {
    throw new SddError('phase_inline', 'hay tasks pendientes fuera de la gramática de la plantilla (- [ ] **T<n> — <título>**): la fase implement va inline', {
      detail: outside.map((l) => l.text).join('\n'), next: 'sigue la fase implement inline, en tu sesión',
    })
  }
  const pending = open.flatMap((l) => (l.task ? [l.task.id] : []))
  const inputs = frozenInputs(root, read).text
  const prompt = renderPhasePrompt('implement', { id, depth, step: 'implement', pending }, inputs)
  if (s.chain && lastLink(s.chain, failed) === null) {
    const first = s.chain.entries[0] as RunEntry
    const from = first.parent === null ? undefined : launchFromId(root, id, first.parent)
    return {
      kind: 'implement', chain: s.chain.id, parent: first.parent, ...(from ? { launchFrom: from } : {}), pending, mode: 'initial',
      base: chainBase(root, id, s), prompt,
    }
  }
  const prev = s.chain ? lastLink(s.chain, failed) : null
  return {
    kind: 'implement', chain: null, parent: prev === null ? null : prev.kind === 'takeover' ? prev.id : prev.run,
    ...(prev ? { launchFrom: launchFromLink(prev) } : {}), pending, mode: 'initial', base: prev ? chainBase(root, id, s) : headCommit(root) ?? '', prompt,
  }
}

/** De dónde parte un eslabón nombrado por su id, buscándolo en todas las cadenas del flujo. */
function launchFromId(root: string, flow: string, link: string): LaunchFrom | undefined {
  for (const c of implementOf(readPhaseRecord(root, flow)).chains) {
    const e = c.entries.find((x) => (x.kind === 'takeover' ? x.id : x.run) === link)
    if (e) return launchFromLink(e)
  }
  return undefined
}

function continuationLink(p: ImplementPhase, s: ChainState, last: RunEntry, left: string[]): ChainLaunch {
  return {
    kind: 'continuation', chain: s.chain!.id, parent: last.run, launchFrom: { run: last.run }, pending: left, mode: 'resume',
    origin: writerSessionOrigin(p.root, last.run), base: chainBase(p.root, p.id, s), prompt: renderContinuationPrompt(p.id, left),
  }
}

const BLOCK_SIZE = 3

/** Un bloque: las primeras pendientes en el orden congelado, con una sesión nueva de la misma familia y el encargo completo. */
function blockLink(p: ImplementPhase, s: ChainState, last: RunEntry, left: string[]): ChainLaunch {
  const pending = left.slice(0, BLOCK_SIZE)
  return {
    kind: 'block', chain: s.chain!.id, parent: last.run, launchFrom: { run: last.run }, pending, mode: 'fresh',
    origin: writerSessionOrigin(p.root, last.run), base: chainBase(p.root, p.id, s),
    prompt: renderPhasePrompt('implement', { id: p.id, depth: p.depth, step: 'implement', pending }, frozenInputs(p.root, p.read).text),
  }
}

/** La reanudación de una corrida que se cortó: el mismo tipo, las mismas tasks o filas y el mismo contrato. */
function resumeLink(p: ImplementPhase, s: ChainState, run: string): ChainLaunch {
  const c = readControl(p.root, run)
  const kind = c.phase?.kind ?? 'implement'
  const ids = kind === 'fix' ? (c.phase?.fix?.rows ?? []).map((r) => r.id) : c.phase?.pending ?? []
  return {
    kind, chain: s.chain!.id, parent: run, launchFrom: { run }, resumes: run, pending: c.phase?.pending ?? [], mode: 'resume',
    origin: writerSessionOrigin(p.root, run), base: chainBase(p.root, p.id, s), ...(c.phase?.fix ? { fix: c.phase.fix } : {}),
    prompt: renderResumePrompt(p.id, run, kind === 'fix' ? 'fix' : 'implement', ids),
  }
}

/**
 * Registra la corrida en la cadena y la lanza, bajo el lock del flujo. Antes de registrar nada comprueba la
 * sesión que reanuda, `HEAD` y el árbol del padre; el registro queda antes del control, y su digest entra en
 * los insumos que la cosecha compara. Un lanzamiento que falla deja el evento `launch_failed`.
 */
async function launchLink(p: ImplementPhase, s: ChainState, l: ChainLaunch): Promise<Result> {
  const { root, env, id, read, conductor } = p
  if (l.mode !== 'initial' && l.origin) {
    const ok = checkResumable(root, env, l.origin, l.mode)
    if (!ok.ok) {
      const at = new Date().toISOString()
      // Sin la sesión, una corrida cortada o un fix solo se cierran con la toma; una continuación todavía puede ir en bloques.
      if (l.mode === 'resume' && (l.resumes !== undefined || l.kind === 'fix')) {
        closeChain(root, id, l.chain!, { code: 'resume_unavailable', at, detail: ok.why })
        throw refusal('resume_unavailable', `no se puede reanudar la sesión del writer: ${ok.why}`, takeoverNext(id))
      }
      if (l.mode === 'resume') {
        appendEvent(root, id, { kind: 'refused', at, chain: l.chain!, detail: `continuación sin sesión: ${ok.why}` })
        throw refusal('resume_unavailable', `no se puede reanudar la sesión del writer: ${ok.why}`, `reparte las pendientes en bloques: ./bin/sdd-ai sdd phase ${id} --blocks; o ${takeoverNext(id)}`)
      }
      throw refusal('resume_unavailable', `no se puede abrir un bloque con la familia del writer: ${ok.why}`, takeoverNext(id))
    }
  }
  if (headCommit(root) !== l.base) throw refusal('head_moved', 'HEAD ya no es la base de la cadena', takeoverNext(id))
  if (l.launchFrom) {
    const diff = launchTreeDiff(root, { base: l.base, phase: { flow: id, launch_from: l.launchFrom } })
    if (diff === null || diff.length > 0) {
      throw refusal('tree_not_parent', diff === null ? 'no se puede leer el árbol del eslabón anterior' : `el árbol ya no es el del eslabón anterior: cambió ${diff.join(', ')}`,
        `devuelve el árbol al del eslabón anterior o ${takeoverNext(id)}`, (diff ?? []).join('\n'))
    }
  }
  // La familia y el perfil se resuelven antes de registrar: si fallan, no queda una entrada sin control.
  let resolution: Resolution
  if (l.mode === 'initial') {
    const families = effectiveFamilies(loadCrossModel(root, FAMILIES.filter((f) => inPath(f, env))).families, p.families ? parseFamiliesFlag(p.families) : undefined)
    resolution = resolve({ conductor, families, workers: loadWorkers(root), role: 'implement', flags: {}, codexRoot: loadCodexRoot(env) })
    resolution.via = 'process'
  } else {
    const launched = writerLaunchOf(root, l.origin!)
    resolution = { family: launched?.family ?? readControl(root, l.origin!).family, via: 'process', origin: { model: 'heredado', effort: 'heredado' } }
  }
  const frozen = frozenInputs(root, read)
  const run = newRunId()
  const at = new Date().toISOString()
  const chain = appendEntry(root, id, l.chain, {
    kind: l.kind, run, parent: l.parent, base: l.base, at, pending: l.pending, ...(l.resumes ? { resumes: l.resumes } : {}),
    ...(l.fix ? { receipt: l.fix.receipt } : {}),
  })
  const phase: NonNullable<WriterControl['phase']> = {
    flow: id, pending: l.pending, inputs: frozen.hashes, handoff_header: headerHash(read.facts.handoffHeader),
    kind: l.kind, chain, parent: l.parent, ...(l.launchFrom ? { launch_from: l.launchFrom } : {}), ...(l.resumes ? { resumes: l.resumes } : {}),
    ...(l.fix ? { fix: l.fix } : {}), registry: registryDigest(root, id),
  }
  let result: Result
  try {
    result = await runWriter({
      root, env, conductor, session: ownerSession(env, conductor.family), resolution, prompt: l.prompt, deadline: p.deadline, phase, id: run,
      chained: { mode: l.mode, ...(l.origin ? { origin: l.origin } : {}), base: l.base },
      request: { role: 'implement', families: p.families, conductor, deadline_sec: p.deadline }, source: `sdd phase ${id}`,
    })
  } catch (e) {
    appendEvent(root, id, { kind: 'launch_failed', at: new Date().toISOString(), chain, run, detail: (e as Error).message })
    throw e
  }
  const out = result.out as Record<string, unknown>
  return { code: result.code, out: { ...out, flow: id, step: 'implement', kind: l.kind, chain, pending: l.pending } }
}

/**
 * `sdd phase` en el paso `verify`: reanuda un `fix` cortado o resuelve el último recibo final rojo. Sin una
 * clasificación registrada, pide la del conductor con las propuestas; con ella, deriva y lanza el `fix` si
 * corresponde. Una clasificación se registra una sola vez por recibo.
 */
async function resolveReceipt(p: ImplementPhase, view: ChainView): Promise<Result> {
  const { root, id, read } = p
  if (p.blocks || p.families !== undefined) throw phaseUsage('--blocks y --families no van en el paso verify')
  const s = view.state
  const last = s.last && s.last.kind !== 'takeover' ? s.last : null
  if (s.chain === null) throw refusal('not_a_phase', `el flujo ${id} no tiene una cadena de writers: el paso es verify`, `./bin/sdd-ai sdd verify ${id}`)
  if (s.next.kind === 'resume' && last?.kind === 'fix') return launchLink(p, s, resumeLink(p, s, s.next.run))
  const receipt = view.receipt
  const ref = view.receiptRef
  if (!receipt || !ref || !view.input.receipt?.current || receipt.green || redRows(receipt).length === 0) {
    throw refusal('receipt_not_red', 'no hay un recibo final rojo vigente con filas rojas para este candidato', orientation(id, s.next))
  }
  const contract = contractRows(root, id)
  const registered = implementOf(readPhaseRecord(root, id)).classifications.find((c) => c.receipt.id === ref.id)
  const proposed = redProposals(root, id, receipt)
  if (p.classes !== undefined) {
    let file: unknown
    try {
      file = JSON.parse(readFileSync(p.classes, 'utf8'))
    } catch (e) {
      throw refusal('classification_invalid', `no se puede leer el archivo de clases: ${(e as Error).message}`, `revisa ${p.classes}`)
    }
    const rows = checkClassification(receipt, file)
    if (registered) {
      const key = (r: { row: string; class: string; reason: string }) => `${r.row}|${r.class}|${r.reason}`
      if (rows.map(key).sort().join('\n') !== registered.rows.map(key).sort().join('\n')) {
        throw refusal('classification_exists', `el recibo ${ref.id} ya tiene una clasificación registrada distinta`, `corre ./bin/sdd-ai sdd phase ${id} sin --classes para usar la registrada, o verifica de nuevo para tener otro recibo`)
      }
    } else {
      appendClassification(root, id, {
        receipt: { id: ref.id, digest: ref.digest }, epoch: s.epoch, at: new Date().toISOString(),
        rows: rows.map((r) => ({ ...r, proposed: proposed.get(r.row) ?? null })),
      })
    }
  } else if (!registered) {
    const file = classesPath(id, ref.id)
    throw new SddError('classification_required', `el recibo ${ref.id} tiene filas rojas sin clasificar`, {
      detail: classificationDetail(receipt, proposed),
      next: `confirma o cambia cada clase con su razón en ${file} (fuera de .plans/${id}/, un archivo del repositorio cambia el árbol) y corre ./bin/sdd-ai sdd phase ${id} --classes ${file}`,
    })
  }
  const fresh = chainView(root, id, read)
  if (fresh.state.derived && fresh.state.chain) closeChain(root, id, fresh.state.chain.id, stamped(fresh.state.derived))
  const next = fresh.state.next
  if (next.kind === 'back_to_plan') {
    closeChain(root, id, fresh.state.chain!.id, { code: 'back_to_plan', at: new Date().toISOString(), detail: `hueco de diseño en ${next.rows.join(', ')}` })
    throw refusal('back_to_plan', `las filas ${next.rows.join(', ')} son un hueco de diseño: la cadena vuelve al plan o a la spec`, `corrige el plan o la spec y reaprueba el gate; con la aprobación nueva, una cadena nueva toma las tasks que falten`)
  }
  if (next.kind !== 'fix') throw refusal('no_fix', `el recibo ${ref.id} no lleva a un fix`, orientation(id, next))
  return launchLink(p, fresh.state, fixLink(p, fresh.state, receipt, ref, next.rows, contract))
}

/** El `fix` de las filas de implementación del recibo: una sola corrida con todas, que reanuda la sesión. */
function fixLink(p: ImplementPhase, s: ChainState, receipt: VerifyReceipt, ref: VerifyReceiptRef, rows: string[], contract: VerificationRow[]): ChainLaunch {
  const { root, id } = p
  const last = s.last as RunEntry
  const registered = implementOf(readPhaseRecord(root, id)).classifications.find((c) => c.receipt.id === ref.id)
  const dir = receiptDir(root, receipt.id)
  const tail = (name: string | undefined) => (name && existsSync(join(dir, name)) ? fileTail(join(dir, name), TAIL_BYTES * 4) : '')
  const input = {
    flow: id, receipt: ref.id, paths: { spec: `.plans/${id}/spec.md`, plan: `.plans/${id}/plan.md`, tasks: `.plans/${id}/tasks.md` },
    rows: rows.map((row) => {
      const r = receipt.rows.find((x) => x.row === row)!
      const e = r.execution
      const c = registered?.rows.find((x) => x.row === row)
      return {
        id: row, argv: e?.argv ?? [], exit_code: e?.exit_code ?? null, ...(e?.reason ? { no_exit: e.reason } : {}), excerpt: e?.excerpt ?? '',
        class: c?.class ?? 'implementation', reason: c?.reason ?? '', stdout: tail(e?.stdout_file), stderr: tail(e?.stderr_file),
        ...(r.confirmation ? { confirmation: `${r.confirmation.state}${r.confirmation.reason ? `: ${r.confirmation.reason}` : ''}` } : {}),
      }
    }),
  }
  const rendered = renderFixPrompt(input, FIX_PROMPT_BUDGET - writerEnvelopeBytes())
  if ('over_budget' in rendered) {
    throw refusal('fix_over_budget', `el encargo del fix no entra en ${FIX_PROMPT_BUDGET} bytes ni sin los tramos de salida`, takeoverNext(id))
  }
  const testPaths = (row: string) => {
    const c = contract.find((x) => x.id === row)
    return c && c.kind === 'test' ? { test_paths: c.test_paths } : {}
  }
  return {
    kind: 'fix', chain: s.chain!.id, parent: last.run, launchFrom: { run: last.run }, pending: [], mode: 'resume',
    origin: writerSessionOrigin(root, last.run), base: chainBase(root, id, s), prompt: rendered.prompt,
    fix: { receipt: { id: ref.id, digest: ref.digest }, rows: rows.map((id) => ({ id, ...testPaths(id) })), trimmed: rendered.trimmed },
  }
}


const phaseUsage = (message: string) => new SddError('usage', message, { next: './bin/sdd-ai sdd status <id> dice el comando de la fase' })

/** Los bytes de un artefacto del flujo, que tienen que ser los mismos que acaba de leer `readFlow`. */
function flowBytes(root: string, read: FlowRead, name: 'spec' | 'plan' | 'tasks'): Buffer {
  const bytes = readFileSync(join(flowDir(root, read.facts.id), FILE_NAMES[name]))
  if (bytesHash(bytes) !== artifactHash(read, name)) {
    throw new SddError('artifacts_unstable', `${FILE_NAMES[name]} cambió mientras se lanzaba la fase`, { next: 'vuelve a correr el comando cuando nadie esté escribiendo en el flujo' })
  }
  return bytes
}

/**
 * `sdd phase <id>`: lanza por proceso la fase que dice `sdd status`, con el encargo que escribe el
 * binario. Todas las negativas van antes de crear nada y en este orden: un worker, `corta`, un paso que
 * no es fase, el registro de la fase y los flags, el material, el header del plan, los criterios de la
 * spec y la gramática de las tasks. La comprobación del registro, la corrida y el alta de la corrida en
 * el registro van juntas bajo el lock del flujo: dos invocaciones a la vez no pueden lanzar las dos.
 */
async function sddPhase(args: string[], env: Env, cwd: string): Promise<Result> {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      request: { type: 'string' }, context: { type: 'string' }, families: { type: 'string' }, conductor: { type: 'string' }, deadline: { type: 'string' },
      classes: { type: 'string' }, blocks: { type: 'boolean' },
    },
  })
  if (positionals.length !== 1) {
    throw new SddError('usage', 'sdd phase recibe un solo id', { next: './bin/sdd-ai sdd phase <id> [--request <archivo>] [--context <archivo>] [--classes <archivo>] [--blocks]' })
  }
  if (env.SDD_AI_WORKER === '1') throw new SddError('recursion', 'sdd-ai no se lanza desde un worker', { next: 'responde el encargo sin delegar' })
  const id = positionals[0]
  const deadlineArg = values.deadline ?? '600'
  const deadline = Number(deadlineArg)
  if (!Number.isFinite(deadline) || deadline <= 0) throw new SddError('usage', `--deadline inválido: ${deadlineArg}`)

  const root = repoRoot(cwd)
  const read = readFlow(root, id, loadJiraMode(root))
  const status = resolveFlow(read.facts)
  if (status.depth === 'corta') {
    throw new SddError('phase_inline', 'en profundidad corta las fases van inline', { next: 'sigue la fase inline, en tu sesión' })
  }
  const step = status.next.step
  // En verify, sdd phase resuelve el último recibo rojo de una cadena de writers: la clasificación y el fix.
  // Sin writers de fase en el flujo no hay cadena, y verify no es una fase.
  const chainStep = step === 'verify' && status.depth !== null
    && (implementOf(readPhaseRecord(root, id)).chains.length > 0 || flowWriterRuns(root, id).length > 0)
  if (status.depth === null || (!PHASE_STEPS.includes(step) && !chainStep)) {
    throw new SddError('not_a_phase', `el paso actual del flujo ${id} es ${step}: sdd phase solo lanza specify, plan, tasks o implement`, {
      next: `./bin/sdd-ai sdd status ${id}`,
    })
  }
  const depth = status.depth
  const record = readPhaseRecord(root, id)
  const running = activeRun(root, record)
  if (running) throw new SddError('phase_running', `el flujo ${id} tiene una corrida de fase activa: ${running}`, { next: `./bin/sdd-ai wait ${running}` })
  const conductor = detectConductor(env, { conductor: values.conductor })
  if (step === 'implement' || chainStep) {
    if (values.request !== undefined || values.context !== undefined) throw phaseUsage('--request y --context no se usan en implement')
    const classes = values.classes === undefined ? undefined : isAbsolute(values.classes) ? values.classes : resolvePath(cwd, values.classes)
    return phaseImplement({
      root, env, id, read, depth, conductor, families: values.families, deadline, step: chainStep ? 'verify' : 'implement',
      ...(values.blocks ? { blocks: true } : {}), ...(classes !== undefined ? { classes } : {}),
    })
  }
  if (values.classes !== undefined || values.blocks) throw phaseUsage('--classes y --blocks van en implement o en verify')

  const doc = step as DocumentStep
  const entry = record.phases[doc]
  if (entry?.inline) {
    throw new SddError('phase_inline', `la fase ${doc} del flujo ${id} la sigue el conductor inline: la ampliación volvió a devolver preguntas o faltantes`, {
      next: 'sigue la fase inline, en tu sesión',
    })
  }
  const awaiting = entry?.awaiting
  if (awaiting && values.context === undefined) {
    throw new SddError('context_required', `la fase ${doc} del flujo ${id} espera ampliación`, {
      detail: [...awaiting.blocking_questions.map((q) => `pregunta: ${q}`), ...awaiting.missing_context.map((m) => `falta: ${m}`)].join('\n'),
      next: `el usuario contesta las preguntas bloqueantes y el contexto faltante sale del repositorio; con eso en un archivo: ./bin/sdd-ai sdd phase ${id} --context <archivo>. Si no, sigue la fase inline`,
    })
  }
  if (!awaiting && values.context !== undefined) throw phaseUsage(`--context solo se usa cuando la fase espera ampliación, y la fase ${doc} no la espera`)
  if (values.request !== undefined && (doc !== 'specify' || awaiting)) throw phaseUsage('--request solo se usa en la primera corrida de specify')
  if (doc === 'specify' && !awaiting && values.request === undefined) {
    throw new SddError('request_required', 'falta el pedido de la fase specify', { next: `./bin/sdd-ai sdd phase ${id} --request <archivo>` })
  }

  const request = values.request !== undefined ? readMaterial(root, values.request, 'el pedido', true) : undefined
  const context = values.context !== undefined ? readMaterial(root, values.context, 'el contexto', true) : undefined
  // En una ampliación de specify, el pedido es la copia que guardó la primera corrida.
  let requestFile: { path: string; bytes: Buffer } | undefined = request && { path: join(root, request.path), bytes: request.bytes }
  if (doc === 'specify' && awaiting) {
    const copy = join(root, '.sdd-ai', 'runs', awaiting.run, 'request.md')
    if (!existsSync(copy)) {
      throw new SddError('request_lost', `no está la copia del pedido que guardó la corrida ${awaiting.run}`, { next: 'sigue la fase specify inline' })
    }
    requestFile = { path: copy, bytes: readFileSync(copy) }
  }

  let plan_header: Parameters<typeof freezeLaunch>[1]['plan_header']
  if (doc === 'plan') {
    const h = planHeaderFrom(id, headerData(read.facts.handoffHeader), currentBranch(root), headCommit(root) ?? null, new Date())
    if ('missing' in h) {
      throw new SddError('plan_header_incomplete', `faltan datos para el header de plan.md: ${h.missing.join(', ')}`, {
        next: 'completa change_type, profundidad y risk en el header de handoff.md, y lanza la fase desde una rama con un commit',
      })
    }
    const { created_at: _created, ...frozen } = h.header
    plan_header = frozen
  }

  const inputs: FrozenInputs = {}
  for (const name of PHASE_INPUTS[doc]) {
    if (name === 'request') inputs.request = requestFile?.bytes.toString('utf8')
    else if (name === 'spec' || name === 'plan' || name === 'tasks') inputs[name] = flowBytes(root, read, name).toString('utf8')
  }
  const criteria = doc === 'tasks' || doc === 'plan' ? criteriaIds(inputs.spec ?? '') : undefined
  if (criteria && criteria.length === 0) {
    throw new SddError('phase_inline', `la spec no tiene criterios reconocibles (ítems - **AC-<n>:** en ## Criterios de aceptación): la fase ${doc} va inline`, {
      next: `sigue la fase ${doc} inline, en tu sesión`,
    })
  }
  if (context) inputs.context = context.bytes.toString('utf8')

  const families = effectiveFamilies(loadCrossModel(root, FAMILIES.filter((f) => inPath(f, env))).families, values.families ? parseFamiliesFlag(values.families) : undefined)
  const resolution = resolve({ conductor, families, workers: loadWorkers(root), role: doc, flags: {}, codexRoot: loadCodexRoot(env) })
  // Las fases van siempre por proceso: la vía nativa no le devuelve al binario la respuesta del hijo.
  resolution.via = 'process'
  const launch = freezeLaunch(read, { step: doc, depth, amended: awaiting !== undefined, request: requestFile, context: context && { path: join(root, context.path), bytes: context.bytes }, plan_header, criteria })
  const phaseRequest: PhaseRequest = {
    kind: 'phase', flow: id, step: doc, amended: awaiting !== undefined, role: doc, conductor, session: ownerSession(env, conductor.family),
    ...(values.request !== undefined ? { request_file: values.request } : {}), ...(values.context !== undefined ? { context_file: values.context } : {}),
    overrides: { families: values.families, deadline_sec: deadline },
  }
  const files: Record<string, string | Buffer> = { 'inputs.json': `${JSON.stringify(launch, null, 2)}\n` }
  if (requestFile) files['request.md'] = requestFile.bytes
  if (context) files['context.md'] = context.bytes
  const prompt = renderPhasePrompt(doc, { id, depth, step: doc }, inputs)

  const started = withFlowLock(root, id, () => {
    // Con el lock tomado, el flujo tiene que ser el que se leyó: si no, la fase ya no es la vigente.
    if (JSON.stringify(readFlow(root, id, loadJiraMode(root)).digests) !== JSON.stringify(read.digests)) {
      throw new SddError('artifacts_unstable', `el flujo ${id} cambió mientras se lanzaba la fase`, { next: `./bin/sdd-ai sdd status ${id}` })
    }
    const rec = readPhaseRecord(root, id)
    const busy = activeRun(root, rec)
    if (busy) throw new SddError('phase_running', `el flujo ${id} tiene una corrida de fase activa: ${busy}`, { next: `./bin/sdd-ai wait ${busy}` })
    if (JSON.stringify(rec.phases[doc] ?? null) !== JSON.stringify(entry ?? null)) {
      throw new SddError('flow_busy', `el registro de la fase ${doc} cambió mientras se lanzaba`, { next: `./bin/sdd-ai sdd status ${id}` })
    }
    const s = startProcessRun({
      root, env, resolution, prompt, request: { ...phaseRequest }, deadline, conductor, files,
      argvExtra: { kind: 'phase', phase: { ...launch, root, ...(criteria ? { criteria } : {}) } },
    })
    const phases: PhaseRecord['phases'] = awaiting ? { ...rec.phases, [doc]: { ...entry, amended: { run: s.id, consumed: false } } } : rec.phases
    writePhaseRecord(root, id, { ...rec, last_run: { id: s.id, step: doc }, phases })
    return s
  })
  if (!started.launched) {
    return {
      code: 1,
      out: { id: started.id, state: 'launch_failed', reason: 'cli_missing', detail: `${resolution.family} no está en PATH`, fallback: conductor, next: phaseFallbackNext(phaseRequest, conductor) },
    }
  }
  return { code: 0, out: { id: started.id, via: resolution.via, family: resolution.family, flow: id, step: doc, amended: awaiting !== undefined, next: `./bin/sdd-ai wait ${started.id}` } }
}

/**
 * El estado de los flujos SDD de `.plans/`. `status` solo lee y sale con 0 aunque el flujo esté
 * bloqueado; `approve` registra la aprobación de un gate y responde el estado nuevo; `phase` lanza la
 * fase del flujo en un worker.
 */
async function sdd(args: string[], env: Env, cwd: string): Promise<Result> {
  const [sub, ...rest] = args
  if (sub === 'phase') return sddPhase(rest, env, cwd)
  if (sub === 'status') {
    const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { json: { type: 'boolean', default: false } } })
    if (positionals.length > 1) throw new SddError('usage', 'sdd status recibe un solo id', { next: './bin/sdd-ai sdd status [<id>]' })
    const root = repoRoot(cwd)
    if (positionals.length === 0) return { code: 0, out: { flows: listFlows(root).map((e) => ({ ...e, next: withPhaseNext(root, e.id, e) })) } }
    const { facts } = readFlow(root, positionals[0])
    const status = resolveFlow(facts)
    return { code: 0, out: { ...status, next: nextOf(root, status, facts) } }
  }
  if (sub === 'approve') {
    const { values, positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { conductor: { type: 'string' } } })
    if (positionals.length !== 2) throw new SddError('usage', 'sdd approve recibe el id y el gate', { next: './bin/sdd-ai sdd approve <id> <gate> [--conductor claude|codex]' })
    const root = repoRoot(cwd)
    const status = approve(root, positionals[0], positionals[1], new Date(), readFlow, prove, env, conductorFlag(values.conductor))
    return { code: 0, out: { ...status, next: withPhaseNext(root, status.id, status) } }
  }
  if (sub === 'verify') return sddVerify(rest, env, cwd)
  throw new SddError('usage', `subcomando desconocido: sdd ${sub ?? ''}`, { next: './bin/sdd-ai sdd status [<id>] | ./bin/sdd-ai sdd approve <id> <gate> | ./bin/sdd-ai sdd phase <id> | ./bin/sdd-ai sdd verify <id>' })
}

const VERIFY_USAGE = './bin/sdd-ai sdd verify <id> [--baseline | --attest V<n> | --takeover [--reason <texto>]] [--conductor claude|codex]'

/** Lo que devuelve una corrida de verify: el recibo resumido, por fila, sin las salidas completas. */
function receiptSummary(receipt: VerifyReceipt, ref: VerifyReceiptRef | null): Record<string, unknown> {
  return {
    receipt: receipt.id, digest: ref?.digest ?? null, flow: receipt.flow, mode: receipt.mode, green: receipt.green,
    candidate: receipt.after, ...(receipt.before.tree !== receipt.after.tree ? { candidate_before: receipt.before } : {}),
    rows: receipt.rows.map((r) => ({
      row: r.row, outcome: r.outcome, ...(r.execution ? { excerpt: r.execution.excerpt } : {}),
      ...(r.confirmation && r.confirmation.state !== 'not_required' ? { confirmation: r.confirmation.state, ...(r.confirmation.reason ? { reason: r.confirmation.reason } : {}) } : {}),
      ...(r.attestation ? { attestation: r.attestation } : {}), ...(r.invalid_attestations ? { invalid_attestations: r.invalid_attestations } : {}),
      ...(r.baseline ? { baseline: r.baseline } : {}),
    })),
    ...(receipt.writer ? { writer: receipt.writer } : {}), ...(receipt.dirtied_paths ? { dirtied_paths: receipt.dirtied_paths } : {}),
  }
}

/**
 * `sdd verify <id>`: la corrida final del contrato del plan, `--baseline` para medir la base antes del
 * primer writer, o `--attest V<n>` para acreditar una fila manual con la respuesta del usuario. SIGINT y
 * SIGTERM interrumpen la corrida: la fila en curso termina su grupo y el árbol se restaura antes de salir.
 */
async function sddVerify(args: string[], env: Env, cwd: string): Promise<Result> {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      baseline: { type: 'boolean', default: false }, attest: { type: 'string' }, conductor: { type: 'string' },
      takeover: { type: 'boolean', default: false }, reason: { type: 'string' },
    },
  })
  if (positionals.length !== 1) throw new SddError('usage', 'sdd verify recibe un solo id', { next: VERIFY_USAGE })
  if (values.baseline && values.attest !== undefined) throw new SddError('usage', '--baseline y --attest no van juntos', { next: VERIFY_USAGE })
  if (values.takeover && (values.baseline || values.attest !== undefined)) throw new SddError('usage', '--takeover va en la corrida final', { next: VERIFY_USAGE })
  if (values.reason !== undefined && !values.takeover) throw new SddError('usage', '--reason acompaña a --takeover', { next: VERIFY_USAGE })
  const root = repoRoot(cwd)
  const [id] = positionals
  if (values.attest !== undefined) {
    const ref = attestRow(root, id, values.attest, env, conductorFlag(values.conductor))
    return { code: 0, out: { flow: id, row: ref.row, attestation: ref.id, next: flowNext(root, id) } }
  }
  const guard = values.baseline ? undefined : treeGuard(root, id, values.takeover ? { reason: values.reason } : undefined)
  const start = prepareVerify(root, id, values.baseline ? 'baseline' : 'final', guard ? { guard } : {})
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    if (values.baseline) {
      const { receipt, ref } = await runBaseline(start, controller.signal)
      return {
        code: 0,
        out: {
          ...receiptSummary(receipt, ref),
          next: receipt.dirtied_paths ? `la medición escribió en el árbol: limpia ${receipt.dirtied_paths.join(', ')} antes de lanzar el writer` : flowNext(root, id),
        },
      }
    }
    const { receipt, ref, projection } = await runFinal(start, controller.signal)
    if (ref) persistReceiptTerminal(root, id)
    const pending = start.contract.rows.filter((r): r is ManualRow => r.kind === 'manual' && receipt.rows.find((x) => x.row === r.id)?.outcome !== 'passed')
    const questions = pending.map((r) => ({ row: r.id, question: attestQuestion(id, r.id, r.observation, receipt.after, receipt.plan_fingerprint) }))
    return { code: 0, out: { ...receiptSummary(receipt, ref), projection, ...(questions.length > 0 ? { questions } : {}), next: flowNext(root, id) } }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

/**
 * La guarda del árbol de `sdd verify` en un flujo con writers de fase. Sin toma, el árbol tiene que ser el del
 * último eslabón de la cadena (cosecha o toma), sin contar el flujo: si no, se niega y nombra las rutas. Con
 * `--takeover`, registra la toma del árbol de ahora con autoría mezclada y cierra la cadena del writer; un
 * terminal que la cadena ya implicaba se escribe antes y no se reemplaza. Un flujo sin writer de fase no tiene guarda.
 */
function treeGuard(root: string, flow: string, takeover?: { reason?: string }): TreeGuard | undefined {
  let registered = false
  return (when, base) => {
    const cur = currentLink(root, flow)
    if (cur === null) {
      if (takeover) throw new SddError('usage', `el flujo ${flow} no tiene un writer de fase: no hay cadena que tomar`, { next: `./bin/sdd-ai sdd verify ${flow}` })
      return
    }
    const now = indexEntries(root, base, { kind: 'current' })
    if (takeover && when === 'locked') {
      if (now === null) throw new SddError('tree_unreadable', 'no se puede leer el árbol de ahora para declarar la toma')
      registerTakeover(root, flow, cur, now, takeover.reason)
      registered = true
      return
    }
    if (registered) {
      const again = currentLink(root, flow)
      const diff = again?.map && now ? entryDiff(again.map, now, flow) : null
      if (diff === null || diff.length > 0) throw treeNotHarvest(flow, diff)
      return
    }
    const diff = cur.map && now ? entryDiff(cur.map, now, flow) : null
    if (diff === null || diff.length > 0) throw treeNotHarvest(flow, diff)
  }
}

const treeNotHarvest = (flow: string, diff: string[] | null) => new SddError('tree_not_harvest',
  diff === null ? 'no se puede comparar el árbol con el del último eslabón de la cadena' : `el árbol no es el del último eslabón de la cadena: cambió ${diff.join(', ')}`, {
    detail: (diff ?? []).join('\n'),
    next: `si esas ediciones son tuyas, declara la toma: ./bin/sdd-ai sdd verify ${flow} --takeover [--reason <texto>]; si no, devuelve el árbol al de la cosecha. La revisión no se propone hasta verificar`,
  })

/** Registra la toma bajo el lock del flujo (lo toma `prepareVerify`): su mapa en el almacén y la entrada en la cadena. */
function registerTakeover(root: string, flow: string, cur: CurrentLink, now: Map<string, string>, reason?: string): void {
  const chain = persistLegacy(root, flow, cur)
  const view = chainView(root, flow, readFlow(root, flow))
  if (view.state.derived && view.state.chain?.id === chain) closeChain(root, flow, chain, { ...view.state.derived, at: new Date().toISOString() })
  const id = `t-${newRunId()}`
  const own = `.plans/${flow}/`
  const map = writeTakeoverMap(root, id, new Map([...now].filter(([path]) => !path.startsWith(own))))
  const parent = cur.link.kind === 'takeover' ? cur.link.id : cur.link.run
  appendEntry(root, flow, chain, { kind: 'takeover', id, parent, at: new Date().toISOString(), map, ...(reason ? { reason } : {}) })
  closeChain(root, flow, chain, { code: 'takeover', at: new Date().toISOString(), detail: reason ?? 'toma del conductor' })
}

/** Después de publicar un recibo, el terminal que la cadena ya implica (fix_cap tras el rojo de la segunda corrección) queda escrito. */
function persistReceiptTerminal(root: string, flow: string): void {
  try {
    withFlowLock(root, flow, () => {
      const view = chainView(root, flow, readFlow(root, flow))
      if (view.state.derived?.code === 'fix_cap' && view.state.chain && view.state.chain.terminal === null) {
        closeChain(root, flow, view.state.chain.id, { ...view.state.derived, at: new Date().toISOString() })
      }
    })
  } catch {
    // El terminal lo vuelve a derivar el próximo verbo que escriba: no impide devolver el recibo.
  }
}

/** El `--conductor` de un comando protegido: elige de qué sesión se lee la respuesta del usuario. */
function conductorFlag(v: string | undefined): Family | undefined {
  if (v === undefined) return undefined
  if (!isFamily(v)) throw new SddError('usage', `conductor desconocido: ${v}`, { next: 'usa --conductor claude|codex' })
  return v
}

/** Las copias de la skill del repo donde corre `doctor`; fuera de un repo no hay copias que revisar. */
function skillCheck(cwd: string): SkillCheck {
  let root: string
  try {
    root = repoRoot(cwd)
  } catch (e) {
    if (e instanceof SddError && e.code === 'not_a_repo') return { skipped: 'no es un repositorio Git' }
    throw e
  }
  return { copies: skillCopies(root, PKG_DIR) }
}

/** Los comandos que solo consultan: con una verificación en curso, informan en vez de detenerse. */
const READS = (cmd: string | undefined, rest: string[]) =>
  cmd === 'wait' || cmd === 'doctor' || (cmd === 'init' && !rest.includes('--apply')) || (cmd === 'review' && rest[0] === 'status') || (cmd === 'sdd' && rest[0] === 'status')

/**
 * Antes de cualquier verbo, resuelve una restauración de `sdd verify` que quedó interrumpida en este
 * checkout. El supervisor interno no la corre: es parte de una corrida en curso, no un verbo.
 */
function recoverBeforeVerb(cmd: string | undefined, rest: string[], cwd: string): void {
  if (!['run', 'review', 'wait', 'cancel', 'agents', 'sdd', 'doctor', 'init'].includes(cmd ?? '')) return
  let root: string
  try {
    root = repoRoot(cwd)
  } catch {
    return
  }
  recoverPendingRestore(root, READS(cmd, rest) ? 'non_blocking' : 'blocking')
}

export async function main(argv: string[], env: Env, cwd: string): Promise<Result> {
  const [cmd, ...rest] = argv
  try {
    recoverBeforeVerb(cmd, rest, cwd)
    switch (cmd) {
      case 'run': return await run(rest, env, cwd)
      case 'review': return await review(rest, env, cwd)
      case 'wait': return await wait(rest, env, cwd)
      case 'cancel': return await cancel(rest, cwd)
      case 'agents': return agents(rest, env, cwd)
      case 'init': return init(rest, env, cwd)
      case 'sdd': return await sdd(rest, env, cwd)
      case 'doctor': {
        const report = doctor(undefined, skillCheck(cwd))
        return { code: report.ok ? 0 : 1, out: report }
      }
      case '__supervise': return { code: 0, out: await supervise(rest[0], rest[1]) }
      default:
        throw new SddError('usage', `comando desconocido: ${cmd ?? ''}`, { next: 'usa init | run | review | wait | cancel | agents sync | sdd status | sdd approve | doctor' })
    }
  } catch (e) {
    if (e instanceof SddError) {
      return { code: e.code === 'run_not_found' || e.code === 'flow_not_found' ? 1 : 2, out: { state: 'error', code: e.code, message: e.message, detail: e.detail, next: e.next } }
    }
    if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      return { code: 2, out: { state: 'error', code: 'usage', message: (e as Error).message } }
    }
    throw e
  }
}
