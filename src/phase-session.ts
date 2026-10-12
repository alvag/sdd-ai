import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionFile } from './approval/session.ts'
import { inPath } from './cli-path.ts'
import { emptyFacts, scanLine } from './outcome.ts'
import { isRunId } from './runs.ts'
import { type DocumentContract, admitPlan, admitSpecify, admitTasks, renderPlan, renderSpec, renderTasks } from './sdd/phase.ts'
import { criteriaIds, readHeader } from './sdd/markdown.ts'
import { bytesHash } from './sdd/read.ts'
import { type DocumentOrigin, type EffectiveLaunch, launchValid, repositoryLaunch, readRegularBytes, readRevisionFile } from './sdd/revision-record.ts'
import { type Family, type LaunchSpec, type RunState, type WorkerTask, SddError } from './types.ts'
import { claudeLaunch, claudeResume } from './workers/claude.ts'
import { codexLaunch, codexResume, withResultFile } from './workers/codex.ts'
import type { Admission } from './review/admit.ts'
import type { Outcome, StreamFacts } from './outcome.ts'
import type { RevisionResult } from './sdd/revision-record.ts'

type Env = Record<string, string | undefined>
export interface ProducerResolution {
  origin: DocumentOrigin; launch: EffectiveLaunch; family: Family; session_id?: string
  recoverable: boolean; cause?: string; detail?: string
}
export interface SessionPlan { family: Family; launch: LaunchSpec; mode: 'same' | 'new'; session_id?: string }

const bytes = readRegularBytes
const ioFailure = (e: unknown) => ['EACCES', 'EIO', 'EMFILE', 'ENFILE', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')
const unreadable = (e: unknown): never => { throw new SddError('origin_unreadable', 'no se puede leer la evidencia del productor', { detail: (e as Error).message }) }
const json = <T>(file: string): T => JSON.parse(bytes(file).toString('utf8')) as T
export const relativePath = (root: string, file: string) => relative(root, file).split(sep).join('/')
const familyValid = (v: unknown): v is Family => v === 'claude' || v === 'codex'

export const documentArtifactPath = (flow: string, step: DocumentOrigin['phase']) => `.plans/${flow}/${step === 'specify' ? 'spec' : step}.md`
export function admitDocumentContract(step: DocumentOrigin['phase'], text: string, criteria: string[], taskActors = false): Admission<DocumentContract> {
  return step === 'specify' ? admitSpecify(text) : step === 'plan' ? admitPlan(text, criteria) : admitTasks(text, criteria, { taskActors })
}
const RUN_STATE_OF: Record<RevisionResult['state'], RunState> = {
  active: 'running', published: 'done', no_changes: 'done', awaiting_context: 'done', conflict: 'failed', not_admitted: 'failed',
  not_published: 'failed', resume_rejected: 'failed', launch_failed: 'launch_failed', failed: 'failed', timeout: 'timeout', cancelled: 'cancelled', superseded: 'done',
}
export const revisionRunState = (state: RevisionResult['state']): RunState => RUN_STATE_OF[state]
const revisionFailureState = (state: RunState): RevisionResult['state'] => state === 'cancelled' || state === 'timeout' || state === 'launch_failed' ? state : 'failed'

function sessionFrom(family: Family, launch: EffectiveLaunch, stream?: string): string | undefined {
  if (family === 'claude') {
    if (stream !== undefined) {
      const facts = emptyFacts()
      for (const line of stream.split('\n')) scanLine(family, facts, line)
      if (facts.sessionId) return facts.sessionId
    }
    const i = launch.args.findIndex((a) => a === '--session-id' || a === '--resume')
    return i >= 0 ? launch.args[i + 1] : undefined
  }
  if (launch.args[1] === 'resume' && launch.args.at(-1) === '-') return launch.args.at(-2)
  if (stream !== undefined) {
    const facts = emptyFacts()
    for (const line of stream.split('\n')) scanLine(family, facts, line)
    return facts.sessionId
  }
  return undefined
}

/** Normaliza un resume a su apertura efectiva para poder volver a construirlo sin perder aislamiento. */
export function documentOpeningLaunch(family: Family, launch: EffectiveLaunch, session?: string): EffectiveLaunch {
  // Solo el perfil comprobable sobrevive al registro; el adaptador vuelve a imponer aislamiento.
  const option = (flag: string) => { const i = launch.args.indexOf(flag); return i >= 0 ? launch.args[i + 1] : undefined }
  const model = option(family === 'claude' ? '--model' : '-m')
  const effort = family === 'claude' ? option('--effort') : launch.args.find((a) => a.startsWith('model_reasoning_effort='))?.split('=')[1]
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new SddError('origin_mismatch', 'el esfuerzo del productor no es válido')
  const task: WorkerTask = { cwd: launch.cwd, promptFile: launch.stdinFile, resultFile: option('--output-last-message') ?? 'result.md',
    sessionId: session ?? sessionFrom(family, launch) ?? '', ...(model ? { model } : {}),
    ...(effort ? { effort: effort as import('./types.ts').Effort } : {}),
    ...(launch.args.includes('web_search="live"') || launch.args.some((a) => a.includes('WebFetch')) ? { web: true } : {}) }
  return family === 'claude' ? claudeLaunch(task) : codexLaunch(task)
}

/** Busca orígenes heredados por la evidencia publicadora; nunca por last_run ni el autor de review. */
function legacyOrigins(root: string, flow: string, step: DocumentOrigin['phase']): DocumentOrigin[] {
  const runs = join(root, '.sdd-ai', 'runs')
  let names: string[]
  try { names = readdirSync(runs) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new SddError('origin_unreadable', 'no se puede leer la evidencia del productor', { detail: (e as Error).message })
  }
  const artifact = documentArtifactPath(flow, step)
  let current: string
  try { current = bytes(join(root, artifact)).toString('utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new SddError('origin_missing', 'falta el documento del productor')
    return unreadable(e)
  }
  const origins: DocumentOrigin[] = []
  for (const run of names.filter(isRunId)) {
    const dir = join(runs, run)
    try {
      const req = json<{ kind: string; flow: string; step: string }>(join(dir, 'request.json'))
      if (req.kind !== 'phase' || req.flow !== flow || req.step !== step) continue
      const result = json<{ outcome: string; artifact: string }>(join(dir, 'phase.json'))
      if (result.outcome !== 'published' || result.artifact !== artifact) continue
      const argv = json<{ family: Family; launch: EffectiveLaunch; phase: {
        flow: string; step: string; inputs: Record<string, string>; task_actors?: true
        plan_header?: Parameters<typeof renderPlan>[1]; criteria?: string[]; revision?: unknown; request_path?: string
      } }>(join(dir, 'argv.json'))
      if (!familyValid(argv.family) || !argv.launch || argv.launch.cmd !== argv.family
        || argv.phase?.flow !== flow || argv.phase.step !== step || argv.phase.revision !== undefined) continue
      const criteria = argv.phase.criteria ?? (step === 'specify' ? [] : criteriaIds(bytes(join(root, '.plans', flow, 'spec.md')).toString('utf8')))
      const stored = json<Record<string, unknown>>(join(dir, 'contract.json'))
      // Son anotaciones del binario, no campos que el worker tuvo que devolver.
      const { findings_missing: _missing, findings_rejected: _rejected, ...workerContract } = stored
      const contractText = JSON.stringify(workerContract)
      const admitted = admitDocumentContract(step, contractText, criteria, argv.phase.task_actors === true)
      if (admitted.kind !== 'admitted') continue
      const c = admitted.review as DocumentContract
      if (c.phase === 'plan' && !argv.phase.plan_header) continue
      // La fecha solo completa el header: la compatibilidad compara cuerpos o dos renders idénticos.
      const renderContract = (value: DocumentContract) => value.phase === 'specify' ? renderSpec(value) : value.phase === 'tasks' ? renderTasks(value)
        : renderPlan(value, { ...argv.phase.plan_header!, created_at: '1970-01-01T00:00:00Z' }, criteria)
      const rendered = renderContract(c)
      const body = (s: string) => { const h = readHeader(s); return h.ok ? h.body : s }
      if (body(rendered).trim() !== body(current).trim()) continue
      const sources: DocumentOrigin['sources'] = []
      const amendments: DocumentOrigin['amendments'] = []
      let compatible = true
      for (const [role, digest] of Object.entries(argv.phase.inputs)) {
        const copy = relativePath(root, join(dir, `${role}.md`))
        let copied: Buffer; let preservedCopy: string | undefined = copy
        try { copied = bytes(join(root, copy)) } catch (e) {
          if (ioFailure(e)) unreadable(e)
          // La copia del pedido es necesaria para comprobar el contrato heredado.
          if (role === 'context') { amendments.push({ path: copy, digest, role }); continue }
          const source = role === 'spec' || role === 'plan' ? join(root, '.plans', flow, `${role}.md`) : argv.phase.request_path
          if (!source) { compatible = false; break }
          try { copied = bytes(source); preservedCopy = undefined } catch (e) { if (ioFailure(e)) unreadable(e); compatible = false; break }
        }
        if (bytesHash(copied) !== digest) { compatible = false; break }
        const ref = { path: role === 'spec' || role === 'plan' ? `.plans/${flow}/${role}.md` : preservedCopy ? copy : relativePath(root, argv.phase.request_path!),
          ...(preservedCopy ? { copy: preservedCopy } : {}), digest, role }
        if (role === 'context') amendments.push(ref)
        else sources.push(ref)
      }
      if (!compatible) continue
      let effective = repositoryLaunch(root, argv.launch)
      let session: string | undefined
      try {
        const p = json<{ launch: EffectiveLaunch; session_id?: string }>(join(dir, 'producer.json'))
        if (!p || !launchValid(p.launch) || p.launch.cmd !== argv.family) unreadable(new Error('producer.json no acredita el lanzamiento'))
        effective = repositoryLaunch(root, p.launch); session = p.session_id
      } catch (e) {
        if (e instanceof SddError) throw e
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable(e)
        try {
          let metrics: { attempts: { admission?: string; suffix: string; outcome: string; raw: { stdout: string; result: string | null } }[] } | undefined
          try { metrics = json(join(dir, 'metrics.json')) } catch (e) { if (ioFailure(e)) unreadable(e); /* Familia comprobada sin sesión atribuible. */ }
          const admittedAttempt = metrics?.attempts?.filter((a) => a.admission === 'ok').at(-1)
          if (admittedAttempt && admittedAttempt.raw.result) {
            const raw = bytes(join(dir, admittedAttempt.raw.result)).toString('utf8')
            const check = admitDocumentContract(step, raw, criteria, argv.phase.task_actors === true)
            if (check.kind !== 'admitted' || renderContract(check.review) !== rendered) continue
            // El stream puede identificar Codex. Claude solo se atribuye si el argv acredita ese intento.
            if (admittedAttempt.suffix) {
              try { effective = json<{ launch: EffectiveLaunch }>(join(dir, `argv${admittedAttempt.suffix}.json`)).launch } catch (e) {
                if (ioFailure(e)) unreadable(e)
                // Recupera el perfil anterior al intento de admisión si se conservó su argv.
                const index = metrics!.attempts.indexOf(admittedAttempt)
                const previous = metrics!.attempts.slice(0, index).reverse().find((a) => a.suffix && a.suffix !== '-fix')
                if (previous) effective = json<{ launch: EffectiveLaunch }>(join(dir, `argv${previous.suffix}.json`)).launch
              }
            }
            session = sessionFrom(argv.family, effective, bytes(join(dir, admittedAttempt.raw.stdout)).toString('utf8'))
          } else if (metrics?.attempts?.length === 1 && metrics.attempts[0].outcome === 'done') {
            session = sessionFrom(argv.family, effective, bytes(join(dir, metrics.attempts[0].raw.stdout)).toString('utf8'))
          }
      // Evidencia de sesión ausente conserva la familia demostrada por el contrato publicado.
      } catch (e) { if (e instanceof SddError) throw e; if (ioFailure(e)) unreadable(e); session = undefined }
      }
      origins.push({ phase: step, artifact, run, family: argv.family, launch: documentOpeningLaunch(argv.family, effective, session),
        ...(session ? { session_id: session } : {}), sources, amendments,
        ...(argv.phase.task_actors ? { task_actors: true } : {}) })
    } catch (e) {
      if (e instanceof SddError && e.code !== 'origin_mismatch') throw e
      if (ioFailure(e)) unreadable(e)
      // Una corrida sin evidencia suficiente no demuestra procedencia.
    }
  }
  return origins
}

export function resolveDocumentProducer(root: string, flow: string, step: DocumentOrigin['phase'], env: Env): ProducerResolution {
  const record = readRevisionFile(join(root, '.plans', flow, 'sdd-ai-phases.json'))
  const registered = record.documents?.[step]
  const candidates = registered ? [registered] : legacyOrigins(root, flow, step)
  if (candidates.length === 0) throw new SddError('origin_missing', 'no hay evidencia suficiente del productor documental')
  if (candidates.length !== 1) throw new SddError('origin_ambiguous', 'hay varios productores documentales incompatibles')
  const origin = candidates[0]
  if (origin.artifact !== documentArtifactPath(flow, step)) throw new SddError('origin_mismatch', 'el productor registrado pertenece a otro artefacto')
  if (registered) {
    try {
      const dir = join(root, '.sdd-ai', 'runs', origin.run)
      const req = json<{ kind: string; flow: string; step: string }>(join(dir, 'request.json'))
      const publication = json<{ outcome: string; artifact: string }>(join(dir, 'phase.json'))
      const resolved = json<{ family: Family }>(join(dir, 'resolved.json'))
      if (req.kind !== 'phase' || req.flow !== flow || req.step !== step || publication.outcome !== 'published'
        || publication.artifact !== origin.artifact || resolved.family !== origin.family || origin.launch.cmd !== origin.family
        || origin.launch.cwd !== root) throw new Error('la corrida no acredita el origen registrado')
      try {
        const proof = json<{ launch: EffectiveLaunch; session_id?: string }>(join(dir, 'producer.json'))
        const opening = documentOpeningLaunch(origin.family, repositoryLaunch(root, proof.launch), proof.session_id)
        if (JSON.stringify(opening) !== JSON.stringify(origin.launch) || proof.session_id !== origin.session_id) throw new Error('producer.json no acredita el lanzamiento registrado')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        const inherited = legacyOrigins(root, flow, step).filter((o) => o.run === origin.run)
        if (inherited.length !== 1 || JSON.stringify(inherited[0].launch) !== JSON.stringify(origin.launch)) throw new Error('la evidencia heredada no acredita el lanzamiento registrado')
      }
    } catch (e) { throw new SddError('origin_mismatch', 'la evidencia del productor registrado es incompatible o ilegible', { detail: (e as Error).message }) }
  }
  const chain = record.revisions?.entries.filter((e) => e.artifact === origin.artifact && e.origin_run === origin.run) ?? []
  const last = chain.findLast((e) => e.session_id !== undefined)
  const session = last?.session_id ?? origin.session_id
  // Los args persistidos en la cadena nunca conceden permisos al nuevo worker.
  const launch = documentOpeningLaunch(origin.family, last?.launch ?? origin.launch, session)
  if (last && (last.family !== origin.family || last.launch.cwd !== root)) throw new SddError('origin_mismatch', 'la cadena cambió la familia o el directorio del productor')
  const resolution: ProducerResolution = { origin, family: origin.family, launch, ...(session ? { session_id: session } : {}), recoverable: false }
  if (!inPath(origin.family, env)) return { ...resolution, cause: 'cli_missing', detail: `${origin.family} no está en PATH` }
  if (!session || chain.some((e) => e.session_id === session && e.session_recoverable === false)) {
    return { ...resolution, cause: 'session_unrecoverable', detail: session ? 'el proveedor rechazó la reanudación de esta sesión' : 'no se pudo identificar la sesión efectiva' }
  }
  try { sessionFile(env, { runner: origin.family, session }) } catch (e) {
    return { ...resolution, cause: 'session_unrecoverable', detail: (e as Error).message }
  }
  return { ...resolution, recoverable: true }
}

/** El argv reanudado conserva el aislamiento y perfil del lanzamiento comprobado. */
export function prepareDocumentResume(producer: ProducerResolution, promptFile: string, resultFile: string): SessionPlan {
  if (producer.cause === 'cli_missing') throw new SddError('cli_missing', producer.detail ?? 'proveedor ausente')
  if (!producer.recoverable) throw new SddError('session_unrecoverable', producer.detail ?? 'la sesión no es recuperable')
  const session = producer.session_id!
  const opening = documentOpeningLaunch(producer.family, producer.launch, session).args
  const args = producer.family === 'claude' ? claudeResume(opening)
    : codexResume(documentOpeningLaunch('codex', { ...producer.launch, args: opening }).args, session, resultFile)
  if (!args) throw new SddError('session_unrecoverable', 'el lanzamiento efectivo no permite construir un resume')
  return { family: producer.family, mode: 'same', session_id: session, launch: { ...producer.launch, args, stdinFile: promptFile } }
}

/** Se llama solo después de comprobar la prueba humana, nunca como recuperación automática. */
export function prepareNewDocumentSession(producer: ProducerResolution, promptFile: string, resultFile: string): SessionPlan {
  if (producer.recoverable) throw new SddError('session_recoverable', 'la sesión del productor todavía se puede reanudar')
  if (producer.cause === 'cli_missing') throw new SddError('cli_missing', producer.detail ?? 'proveedor ausente')
  const opening = documentOpeningLaunch(producer.family, producer.launch, producer.session_id)
  let args: string[]
  let session: string | undefined
  if (producer.family === 'claude') {
    args = [...opening.args]
    const i = args.findIndex((a) => a === '--session-id' || a === '--resume')
    if (i < 0) throw new SddError('session_unrecoverable', 'falta el lanzamiento de apertura efectivo')
    session = randomUUID(); args[i] = '--session-id'; args[i + 1] = session
  } else {
    if (opening.args[0] !== 'exec' || opening.args[1] === 'resume') throw new SddError('session_unrecoverable', 'falta el lanzamiento de apertura efectivo')
    args = withResultFile(opening.args, resultFile)
  }
  return { family: producer.family, mode: 'new', ...(session ? { session_id: session } : {}), launch: { ...opening, args, stdinFile: promptFile } }
}

export interface RevisionAttempt {
  outcome: Outcome; facts: StreamFacts; text: string; stderr: string; launch: LaunchSpec
}
export interface RevisionAttemptOptions {
  session: SessionPlan; deadline: number; recovery_seconds: number
  cancelled(): boolean
  execute(launch: LaunchSpec, suffix: string, until: number): Promise<RevisionAttempt>
  record(attempt: RevisionAttempt, suffix: string): void
  continuation(launch: LaunchSpec, session: string, suffix: string, prompt: string): LaunchSpec
  admit(text: string): Admission<DocumentContract>
  correctionPrompt(error: string): string
  closingPrompt: string
  publish?(attempt: RevisionAttemptResult): RevisionResult
}
export interface RevisionAttemptResult {
  result: RevisionResult; last?: RevisionAttempt; contract?: DocumentContract; session_id?: string; launch?: LaunchSpec
}

/** No reintenta perfiles ni abre sesiones al recuperar una respuesta inadmisible. */
export async function runRevisionAttempts(o: RevisionAttemptOptions): Promise<RevisionAttemptResult> {
  if (o.cancelled()) return { result: { state: 'cancelled' } }
  let launch = o.session.launch
  let last = await o.execute(launch, '', o.deadline)
  o.record(last, '')
  let session = o.session.session_id ?? last.facts.sessionId
  const initial = last
  const rejected = (a: RevisionAttempt) => o.session.mode === 'same' && a.outcome.state !== 'done'
    && a === initial && !a.facts.started && session !== undefined
    && `${a.stderr}\n${a.outcome.detail ?? ''}`.includes(session)
    && /(?:session|thread|conversation|sesi[oó]n)/i.test(`${a.stderr}\n${a.outcome.detail ?? ''}`)
    && /(?:not found|does not exist|is invalid|is unknown|no conversation found|no se encontr[oó])/i.test(`${a.stderr}\n${a.outcome.detail ?? ''}`)
  const failure = (): RevisionAttemptResult => ({ last, launch, ...(session ? { session_id: session } : {}), result: {
    state: rejected(last) ? 'resume_rejected' : revisionFailureState(last.outcome.state),
    ...(last.outcome.reason ? { cause: last.outcome.reason } : {}), ...(last.outcome.detail ? { detail: last.outcome.detail } : {}),
  } })
  if (last.outcome.state === 'timeout' && session && !o.cancelled()) {
    launch = o.continuation(launch, session, '-resume', o.closingPrompt)
    last = await o.execute(launch, '-resume', Date.now() + o.recovery_seconds * 1000)
    o.record(last, '-resume')
  }
  if (last.outcome.state !== 'done') return failure()
  if (last.facts.sessionId && session && last.facts.sessionId !== session) return { ...failure(), result: { state: 'failed', cause: 'session_changed', detail: 'el proveedor informó una sesión distinta de la fijada' } }
  if (o.cancelled()) return { ...failure(), result: { state: 'cancelled' } }
  let admitted = o.admit(last.text)
  if (admitted.kind !== 'admitted') {
    if (!session) return { ...failure(), result: { state: 'not_admitted', cause: 'session_unknown' } }
    const error = admitted.kind === 'unavailable' ? admitted.reason : admitted.error
    launch = o.continuation(launch, session, '-fix', o.correctionPrompt(error))
    last = await o.execute(launch, '-fix', Date.now() + o.recovery_seconds * 1000)
    o.record(last, '-fix')
    if (last.outcome.state !== 'done') return failure()
    if (last.facts.sessionId && last.facts.sessionId !== session) return { ...failure(), result: { state: 'failed', cause: 'session_changed', detail: 'la recuperación informó una sesión distinta de la fijada' } }
    admitted = o.admit(last.text)
  }
  if (o.cancelled()) return { ...failure(), result: { state: 'cancelled' } }
  if (admitted.kind !== 'admitted') return { last, launch, ...(session ? { session_id: session } : {}), result: {
    state: 'not_admitted', cause: admitted.kind === 'unavailable' ? admitted.reason : admitted.error,
  } }
  const contract = admitted.review
  const answer: RevisionAttemptResult = { last, launch, contract, ...(session ? { session_id: session } : {}), result: {
    state: contract.blocking_questions.length || contract.missing_context.length ? 'awaiting_context' : 'active',
    assumptions: contract.assumptions, blocking_questions: contract.blocking_questions, missing_context: contract.missing_context,
  } }
  if (answer.result.state === 'active' && o.publish) answer.result = o.publish(answer)
  return answer
}
