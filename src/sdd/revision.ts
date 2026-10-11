import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { type Proof, askNext, prove } from '../approval/proof.ts'
import type { Question } from '../approval/question.ts'
import type { ProducerResolution, SessionPlan } from '../phase-session.ts'
import { withLock } from '../lock.ts'
import { type ArtifactSelection, freezeArtifact, inputsUnchanged, isArtifact, readMaterial } from '../review/artifact.ts'
import type { Candidate } from '../review/candidate.ts'
import { type Ledger, targets, undecided } from '../review/ledger.ts'
import { REVIEW_LOCK, type ReviewRequest } from '../review/standing.ts'
import { isAlive, isRunId, readStatus, writeJsonAtomic } from '../runs.ts'
import { type Family, type Resolution, SddError, TERMINAL, type Status } from '../types.ts'
import { type DocumentContract, type FrozenInputs, type PlanHeader, renderPhasePrompt, renderPlan, renderSpec, renderTasks } from './phase.ts'
import { criteriaIds } from './markdown.ts'
import { activeRun, readPhaseRecord, withFlowLock, writePhaseRecord } from './phase-state.ts'
import { bytesHash, flowDir, headerHash, readFlow } from './read.ts'
import { type RevisionArtifact, type RevisionEntry, type MaterialReference, type RevisionResult, pendingIntent } from './revision-record.ts'
import { GATES, GATE_ARTIFACTS, type FlowStatus, type Reason, resolve } from './status.ts'
import type { FrozenLaunch, PublishOutcome } from './publish.ts'
import { flowWriterRuns } from '../writer-store.ts'

type Env = Record<string, string | undefined>
export interface ValidatedRevision {
  flow: string; artifact: RevisionArtifact; path: string; step: 'specify' | 'plan' | 'tasks'
  depth: 'normal' | 'completa'; review: string; round: number; ledger: Ledger; ledger_digest: string
  candidate: Candidate; accepted: string[]; sources: Map<string, Buffer>; document: Buffer
  step_at_launch: FlowStatus['next']['step']; handoff_header: string
  decisions?: { ref: MaterialReference; bytes: Buffer }; criteria: string[]
}
export interface RevisionMaterial { inputs: FrozenInputs; files: Record<string, Buffer | string>; refs: MaterialReference[]; prompt: string }
export interface RevisionCandidate { text: string; previous_digest: string; result_digest: string; identical: boolean; blocked_reasons: Reason[] }
export interface FrozenRevision {
  run?: string
  review: string; round: number; artifact: RevisionArtifact; document_digest: string; ledger_digest: string
  candidate: string; step_at_launch: FlowStatus['next']['step']; continuation?: true
}

function regularBytes(file: string): Buffer {
  if (!lstatSync(file).isFile()) throw new Error('la ruta no es un archivo regular')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('la ruta no es un archivo regular')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function evidence<T>(file: string, code: string): T {
  try { return JSON.parse(regularBytes(file).toString('utf8')) as T } catch (e) {
    throw new SddError(code, 'no se pudo leer la evidencia de la revisión', { detail: (e as Error).message })
  }
}
const fail = (code: string, message: string): never => { throw new SddError(code, message) }

/** Siempre revisión primero y flujo después. Nunca se mantienen estos locks durante el trabajo del worker. */
export function withRevisionLocks<T>(root: string, flow: string, review: string, fn: () => T): T {
  if (!isRunId(review)) return fail('review_missing', 'el id de revisión no es válido')
  const dir = join(root, '.sdd-ai', 'runs', review)
  try {
    if (!lstatSync(dir).isDirectory()) return fail('review_unreadable', 'la revisión no es un directorio regular')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fail('review_missing', 'la revisión no existe')
    throw e
  }
  return withLock(join(dir, REVIEW_LOCK), () => new SddError('review_active', 'la revisión sigue activa'), () => withFlowLock(root, flow, fn))
}

/** next.step implement todavía permite corregir: solo la evidencia de trabajo iniciado lo impide. */
export function assertBeforeImplementation(root: string, flow: string): void {
  const record = readPhaseRecord(root, flow, true)
  if (record.implement?.chains.some((c) => c.entries.some((e) => 'run' in e))
    || record.last_run?.step === 'implement' || (record.verify?.receipts.length ?? 0) > 0) {
    return fail('implementation_started', 'implement ya empezó o el flujo tiene un recibo de verify')
  }
  const read = readFlow(root, flow)
  if ((read.facts.tasksFile?.done ?? 0) > 0 || (read.facts.tasksSection?.done ?? 0) > 0) return fail('implementation_started', 'hay tasks marcadas')
  for (const control of flowWriterRuns(root, flow, true)) {
    if (control.phase?.flow === flow) return fail('implementation_started', 'existe un writer de implementación del flujo')
  }
  const runs = join(root, '.sdd-ai', 'runs')
  let names: string[]
  try { names = readdirSync(runs) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    return fail('activity_unknown', 'no se puede descartar un writer de implement lanzado')
  }
  for (const run of names.filter(isRunId)) {
    let req: { kind?: string; flow?: string; step?: string; role?: string }
    try { req = evidence(join(runs, run, 'request.json'), 'activity_unknown') } catch {
      return fail('activity_unknown', 'una corrida no permite descartar implementación iniciada')
    }
    if (req.flow === flow && (req.step === 'implement' || req.role === 'implement')) return fail('implementation_started', 'existe evidencia de un writer de implement lanzado')
  }
}

/** El llamador tiene ambos locks. No cambia decisiones ni historia del ledger. */
export function validateRevision(root: string, flow: string, artifact: RevisionArtifact, review: string,
  producer: ProducerResolution, decisionsPath?: string, ownRun?: string): ValidatedRevision {
  if (!['spec', 'plan', 'tasks'].includes(artifact)) return fail('usage', '--revise solo admite spec, plan o tasks')
  const read = readFlow(root, flow)
  const status = resolve(read.facts)
  if (status.depth !== 'normal' && status.depth !== 'completa') return fail('revision_depth', 'las correcciones solo se admiten en normal o completa')
  const record = readPhaseRecord(root, flow, true)
  const active = activeRun(root, record, true)
  if (active && active !== ownRun) {
    const revision = record.revisions?.active?.run === active || pendingIntent(record)?.run === active
    throw new SddError(revision ? 'revision_running' : 'phase_running', revision ? `la corrección de ${record.revisions?.active?.artifact ?? artifact} sigue activa` : `la fase ${active} sigue activa`, { next: `./bin/sdd-ai wait ${active}` })
  }
  if (!isRunId(review)) return fail('review_missing', 'el id de revisión no es válido')
  const dir = join(root, '.sdd-ai', 'runs', review)
  const req = evidence<ReviewRequest>(join(dir, 'request.json'), 'review_unreadable')
  if (!req || typeof req !== 'object' || req.kind !== 'review' || !req.selection || typeof req.selection !== 'object') return fail('review_unreadable', 'la solicitud de revisión es ilegible')
  // La revisión pedida tiene su propia causa de ilegibilidad; no se la confunde
  // con una corrida cuya solicitud impide descartar un writer de implement.
  assertBeforeImplementation(root, flow)
  if (!isArtifact(req.selection)) return fail('review_diff', 'la devolución requiere una revisión de artefacto')
  const sel: ArtifactSelection = req.selection
  if (!Array.isArray(sel.inputs) || !Array.isArray(sel.context) || sel.inputs.some((i) => !i || typeof i.role !== 'string' || typeof i.path !== 'string')
    || sel.context.some((p) => typeof p !== 'string')) return fail('review_unreadable', 'la selección de la revisión no es legible')
  const path = `.plans/${flow}/${artifact}.md`
  // `review start` guarda la selección con rutas absolutas; se comparan relativas a la raíz, como en el candidato.
  const rel = (p: string) => isAbsolute(p) ? relative(root, p) : p
  if (req.flow !== undefined && req.flow !== flow) return fail('review_flow_mismatch', 'la revisión pertenece a otro flujo')
  if (rel(sel.artifact) !== path) return fail('review_artifact_mismatch', 'la revisión pertenece a otro documento')
  if (sel.kind !== artifact) return fail('review_kind_mismatch', 'el tipo de revisión no corresponde a la fase')
  for (const role of artifact === 'tasks' ? ['spec', 'plan'] : artifact === 'plan' ? ['spec'] : ['request']) {
    const input = sel.inputs?.filter((i) => i.role === role)
    if (input?.length !== 1 || role !== 'request' && rel(input[0].path) !== `.plans/${flow}/${role}.md`) return fail('review_flow_mismatch', 'los insumos no acreditan pertenencia inequívoca al flujo')
  }
  const terminal = evidence<Status>(join(dir, 'status.json'), 'review_unreadable')
  if (!terminal || !['launching', 'running', 'done', 'failed', 'launch_failed', 'timeout', 'cancelled', 'delegated', 'unavailable', 'cessation_uncertain'].includes(terminal.state)) return fail('review_unreadable', 'el estado de la revisión es ilegible')
  if (!TERMINAL.has(terminal.state)) return fail('review_active', 'la revisión todavía no terminó')
  const ledger = evidence<Ledger>(join(dir, 'ledger.json'), 'review_unreadable')
  const states = ['abierto', 'aceptado', 'rechazado', 'en-disputa', 'resuelto', 'cerrado', 'refutado', 'fuera-de-alcance', 'informativo']
  if (!ledger || !Number.isSafeInteger(ledger.completed) || ledger.completed < 1 || !Number.isSafeInteger(ledger.next_id) || ledger.next_id < 1 || !Array.isArray(ledger.entries)
    || new Set(ledger.entries.map((e) => e?.id)).size !== ledger.entries.length
    || ledger.entries.some((e) => !e || !/^F-\d+$/.test(e.id) || !states.includes(e.state) || !Number.isSafeInteger(e.round) || e.round < 1 || e.round > ledger.completed
      || typeof e.claim !== 'string' || !e.claim.trim() || typeof e.location !== 'string' || !['scope', 'spec', 'quality'].includes(e.axis)
      || !['BLOCKER', 'CRITICAL', 'WARNING', 'SUGGESTION'].includes(e.severity) || !Array.isArray(e.responses)
      || e.decision !== undefined && (!['accept', 'reject'].includes(e.decision.action) || !states.includes(e.decision.from)
        || !Number.isSafeInteger(e.decision.after_round) || e.decision.after_round < 1 || e.decision.after_round > ledger.completed)
      || e.superseded !== undefined && (!Array.isArray(e.superseded) || e.superseded.some((d) => !d || !['accept', 'reject'].includes(d.action) || !states.includes(d.from)))
      || e.responses.some((r) => !r || !Number.isSafeInteger(r.round) || !['resolved', 'unresolved', 'withdrawn', 'maintained'].includes(r.answer))
      || (e.state === 'rechazado' && (e.decision?.action !== 'reject' || !e.decision.reason?.trim())))) return fail('review_unreadable', 'el ledger es ilegible')
  if (!ledger.artifact) return fail('review_diff', 'el ledger no es de una revisión de artefacto')
  if (terminal.state !== 'done' || (terminal.round ?? 1) !== ledger.completed) return fail('review_incomplete', 'la última ronda no acredita una entrega completada')
  const pending = undecided(ledger)
  if (pending.length) return fail('decisions_pending', `hay hallazgos sin decidir: ${pending.join(', ')}`)
  const accepted = targets(ledger).filter((t) => t.kind === 'verify').map((t) => t.id)
  if (!accepted.length) return fail('accepted_missing', 'no hay hallazgos aceptados para devolver')
  const resolved = evidence<Resolution>(join(dir, 'resolved.json'), 'review_unreadable')
  if (resolved.family !== 'claude' && resolved.family !== 'codex') return fail('review_unreadable', 'la familia del revisor no es legible')
  if (resolved.family === producer.family) return fail('same_family_reviewer', 'el revisor debe ser de otra familia que el productor')
  const candidate = evidence<Candidate>(join(dir, `candidate${ledger.completed === 1 ? '' : `-r${ledger.completed}`}.json`), 'review_unreadable')
  if (!candidate || !Array.isArray(candidate.context) || !Array.isArray(candidate.files) || candidate.files.length !== 1
    || candidate.files[0]?.path !== path || candidate.subject?.kind !== artifact
    || !/^[a-f0-9]{64}$/.test(candidate.files[0]?.sha256 ?? '') || !/^sha256:[a-f0-9]{64}$/.test(candidate.hash)
    || candidate.context.some((c) => !c || typeof c.path !== 'string' || !/^[a-f0-9]{64}$/.test(c.sha256))) return fail('review_unreadable', 'el candidato no es legible')
  if (!inputsUnchanged(root, candidate)) return fail('review_sources_changed', 'cambiaron los insumos o contextos de la revisión; hace falta una revisión nueva')
  const frozen = freezeArtifact(root, sel)
  if (frozen.candidate.hash !== candidate.hash) return fail('review_candidate_changed', 'el documento vigente no es el candidato revisado')
  if (candidate.files[0].sha256 !== frozen.candidate.files[0].sha256) return fail('review_unreadable', 'el candidato registrado contradice su huella documental')
  const decisions = decisionsPath === undefined ? undefined : readMaterial(root, decisionsPath, 'el aporte del conductor', true)
  const step = artifact === 'spec' ? 'specify' : artifact
  return { flow, artifact, path, step, depth: status.depth, review, round: ledger.completed, ledger,
    ledger_digest: bytesHash(regularBytes(join(dir, 'ledger.json'))), candidate, accepted,
    sources: frozen.bytes, document: frozen.bytes.get(path)!, step_at_launch: status.next.step,
    handoff_header: headerHash(read.facts.handoffHeader), criteria: artifact === 'spec' ? [] : criteriaIds(frozen.bytes.get(`.plans/${flow}/spec.md`)?.toString('utf8') ?? ''),
    ...(decisions ? { decisions: { ref: { path: decisions.path, digest: bytesHash(decisions.bytes), role: 'conductor' }, bytes: decisions.bytes } } : {}),
  }
}

/** La pregunta liga cada uso a todo el material autorizado, incluido el aporte del conductor. */
export function newSessionQuestion(v: ValidatedRevision, family: Family, entries: RevisionEntry[]): Question {
  const use = 1 + entries.filter((e) => e.artifact === v.path && e.review === v.review && e.round === v.round && e.authorization !== undefined).length
  const binding = bytesHash(JSON.stringify({ flow: v.flow, artifact: v.path, document: bytesHash(v.document), review: v.review,
    round: v.round, ledger: v.ledger_digest, candidate: v.candidate.hash,
    sources: [...v.sources].map(([path, bytes]) => [path, bytesHash(bytes)]).sort(([a], [b]) => a.localeCompare(b)),
    conductor: v.decisions?.ref.digest ?? null, family, use })).slice('sha256:'.length, 'sha256:'.length + 16)
  return { header: 'Sesión nueva', question: `¿Autorizas una sesión nueva de ${family} para corregir ${v.path} con la revisión ${v.review}, ronda ${v.round}, uso ${use}? (código ${binding})`,
    options: [{ label: 'Autorizar sesión nueva', description: 'Conserva familia y material del productor comprobado' },
      { label: 'No autorizar', description: 'No se lanza la corrección' }] }
}

export function authorizeNewSession(v: ValidatedRevision, producer: ProducerResolution, flag: boolean, entries: RevisionEntry[], env: Env, conductor?: Family): Proof | undefined {
  if (producer.cause === 'cli_missing') return fail('cli_missing', producer.detail ?? 'proveedor ausente')
  if (producer.recoverable) {
    if (flag) return fail('session_recoverable', 'la sesión del productor todavía se puede reanudar')
    return undefined
  }
  if (!flag) return fail('session_unrecoverable', producer.detail ?? 'la sesión no se puede reanudar')
  const q = newSessionQuestion(v, producer.family, entries)
  try { return prove({ env, conductor, q, authorizes: q.options[0].label, consumed: new Set(entries.flatMap((e) => e.authorization ? [e.authorization.ref] : [])) }) } catch (e) {
    if (e instanceof SddError && !e.next) throw new SddError(e.code, e.message, { next: askNext(q) })
    throw e
  }
}

export function freezeRevisionMaterial(root: string, v: ValidatedRevision, producer: ProducerResolution, session: SessionPlan,
  history: RevisionEntry[] = [], context?: { path: string; bytes: Buffer }): RevisionMaterial {
  const inputs: FrozenInputs = {}
  const files: RevisionMaterial['files'] = {}; const refs: MaterialReference[] = []
  const sections: string[] = []
  const block = (name: string, text: string) => `<<<${name}\n${text}\n${name}>>>`
  const save = (name: string, bytes: Buffer, ref: MaterialReference) => {
    files[name] = bytes; refs.push({ ...ref, copy: name }); sections.push(block(ref.role ?? ref.path, bytes.toString('utf8')))
  }
  save('document.md', v.document, { path: v.path, digest: bytesHash(v.document), role: 'Documento vigente completo' })
  for (const x of v.candidate.context) {
    const bytes = v.sources.get(x.path)!
    save(`source-${refs.length}.md`, bytes, { path: x.path, digest: bytesHash(bytes), role: x.role ?? 'Contexto de revisión vigente' })
    if (x.role === 'request' || x.role === 'spec' || x.role === 'plan') inputs[x.role] = bytes.toString('utf8')
  }
  for (const ref of [...producer.origin.sources, ...producer.origin.amendments]) {
    try {
      const bytes = regularBytes(join(root, ref.copy ?? ref.path))
      if (bytesHash(bytes) !== ref.digest) throw new Error('la copia no conserva su huella')
      save(`historical-${refs.length}.md`, bytes, { ...ref, role: `Material histórico (${ref.role ?? ref.path}); no sustituye insumos vigentes` })
    } catch {
      if (session.mode === 'new') return fail('material_missing', `no está la copia histórica necesaria de ${ref.path}`)
      sections.push(`Copia histórica ausente: ${ref.path}. Ya estuvo en el contexto del productor; no se resume ni se inventa.`)
    }
  }
  const ledgerBytes = Buffer.from(JSON.stringify(v.ledger, null, 2))
  files['ledger.json'] = ledgerBytes
  sections.push('## Decisiones e historial contextual completo', block('LEDGER contextual', ledgerBytes.toString('utf8')))
  const orders = v.ledger.entries.filter((e) => v.accepted.includes(e.id))
  sections.push(`## Únicas órdenes de corrección — revisión ${v.review}, ronda ${v.round}`, block('ACEPTADOS', JSON.stringify(orders, null, 2)))
  if (v.decisions) {
    save('decisions.md', v.decisions.bytes, { ...v.decisions.ref, role: 'Aporte del conductor; sin autoridad sobre pedido ni insumos aprobados' })
  }
  if (context) save('context.md', context.bytes, { path: context.path, digest: bytesHash(context.bytes), role: 'Respuestas de Max y contexto aportado por el conductor' })
  for (const previous of history) {
    for (const ref of previous.materials.filter((r) => r.role === 'Respuestas de Max y contexto aportado por el conductor')) {
      if (!ref.copy) return fail('material_missing', 'falta una copia del contexto de una corrección anterior')
      const bytes = regularBytes(join(root, ref.copy))
      if (bytesHash(bytes) !== ref.digest) return fail('material_missing', 'cambió una copia del contexto anterior')
      save(`historical-context-${refs.length}.md`, bytes, { ...ref, role: 'Material histórico de continuación; respuestas y contexto ya aportados' })
    }
  }
  if (history.length) sections.push(block('HISTORIAL de correcciones', JSON.stringify(history, null, 2)))
  const prompt = renderPhasePrompt(v.step, { id: v.flow, depth: v.depth, step: v.step }, inputs, undefined, { material: sections.join('\n\n') })
  return { inputs, files, refs, prompt }
}

/** El frontmatter original se conserva literalmente, incluidos terminadores y espacios. */
function splitHeader(text: string): { header: string; body: string } {
  const match = /^(?:---[ \t]*(?:\r\n|\n|\r))[\s\S]*?^(?:---[ \t]*(?:\r\n|\n|\r|$))/m.exec(text)
  if (!match || match.index !== 0) return { header: '', body: text }
  return { header: match[0], body: text.slice(match[0].length) }
}
const OWN_BLOCKS: Record<RevisionArtifact, readonly string[]> = {
  spec: [], plan: ['header_invalid', 'depth_invalid', 'status_invalid', 'layout_mismatch', 'revert_path_not_in_base'],
  tasks: ['tasks_empty', 'task_actor_invalid'],
}

export function prepareRevisionCandidate(root: string, v: ValidatedRevision, contract: DocumentContract): RevisionCandidate {
  if (contract.phase !== v.step) return fail('candidate_blocked', 'el contrato no pertenece a la fase corregida')
  let rendered: string
  if (contract.phase === 'specify') rendered = renderSpec(contract)
  else if (contract.phase === 'tasks') rendered = renderTasks(contract)
  else {
    const header: PlanHeader = { id: v.flow, branch: 'preserved', base_commit: 'preserved', change_type: 'feat', profundidad: v.depth, risk: 'high', status: 'planned', created_at: '1970-01-01T00:00:00Z' }
    rendered = splitHeader(renderPlan(contract, header, v.criteria)).body
  }
  const before = v.document.toString('utf8')
  const originalParts = splitHeader(before)
  const prefix = originalParts.header ? /^\s*/.exec(originalParts.body)?.[0] ?? '' : ''
  const text = originalParts.header + prefix + rendered.replace(/^\s+/, '')
  const original = resolve(readFlow(root, v.flow).facts)
  const after = resolve(readFlow(root, v.flow, undefined, { artifact: v.artifact, text }).facts)
  const old = new Set(original.blocked_reasons.map((r) => r.code))
  const added = after.blocked_reasons.filter((r) => !old.has(r.code) && OWN_BLOCKS[v.artifact].includes(r.code))
  if (added.length) return fail('candidate_blocked', added.map((r) => `${r.code}: ${r.detail}`).join('; '))
  return { text, previous_digest: bytesHash(v.document), result_digest: bytesHash(text), identical: text === before, blocked_reasons: after.blocked_reasons }
}

/** El llamador tiene el lock del flujo. No reemplaza un resultado fijado por la recuperación. */
export function finishRevision(root: string, flow: string, run: string, result: RevisionResult,
  session?: { session_id?: string; launch?: RevisionEntry['launch'] }): RevisionResult {
  const record = readPhaseRecord(root, flow, true)
  const revisions = record.revisions
  const entry = revisions?.entries.find((e) => e.run === run)
  if (!revisions || !entry) return fail('revisions_invalid', 'la corrección no tiene entrada en el registro')
  const settled = entry.result && entry.state !== 'active' ? entry.result : result
  const awaiting = result.state === 'resume_rejected' && entry.continuation === true
  const update: RevisionEntry = { ...entry, ...session, state: awaiting ? 'awaiting_context' : settled.state, result: settled,
    ...(result.state === 'resume_rejected' ? { session_recoverable: false } : {}) }
  writePhaseRecord(root, flow, { ...record, revisions: { ...revisions,
    entries: revisions.entries.map((e) => e.run === run ? update : e),
    ...(revisions.active?.run === run ? { active: undefined } : {}),
  } })
  return settled
}

function affectedGates(depth: 'normal' | 'completa', artifact: RevisionArtifact): string[] {
  const gates = GATES[depth]
  const first = gates.findIndex((g) => GATE_ARTIFACTS[g].includes(artifact))
  return [...gates.slice(first)]
}

/** Recuperación única; no vuelve a hacer rename. El llamador tiene el lock del flujo. */
export function recoverRevisionPublication(root: string, flow: string): void {
  const record = readPhaseRecord(root, flow, true)
  const intent = pendingIntent(record)
  if (!intent || !record.revisions) return
  const dir = join(root, '.sdd-ai', 'runs', intent.run)
  let terminal: { outcome?: string; registry_pending?: boolean } | undefined
  try { terminal = evidence(join(dir, 'phase.json'), 'revision_pending') } catch { /* Sin terminal decide el destino. */ }
  const current = bytesHash(regularBytes(join(root, intent.artifact)))
  const renamed = terminal?.outcome === 'published'
  const published = renamed || current === intent.result_digest
  const barrier = renamed || current !== intent.previous_digest
  const result: RevisionResult = published ? { state: 'published', digest: intent.result_digest }
    : current === intent.previous_digest ? { state: 'not_published', cause: 'publish_interrupted' }
      : { state: 'conflict', cause: 'target_changed_during_publish', digest: current }
  const revisions = record.revisions
  let metadata: { session_id?: string; launch?: RevisionEntry['launch'] } = {}
  try { metadata = evidence(join(dir, 'revision-result.json'), 'revision_pending') } catch { /* Las corridas fabricadas o anteriores pueden no traerla. */ }
  writePhaseRecord(root, flow, { ...record, revisions: { ...revisions,
    intent: { ...intent, resolved: true },
    barriers: barrier && !revisions.barriers.some((b) => b.run === intent.run) ? [...revisions.barriers,
      { run: intent.run, artifact: intent.artifact, gates: intent.gates, digest: intent.result_digest }] : revisions.barriers,
    entries: revisions.entries.map((e) => e.run === intent.run ? { ...e, ...metadata, state: result.state, result } : e),
  } })
  const status = readStatus(dir)
  // Un terminal previo conserva su resultado: las vistas declaran la divergencia con la entrada.
  if (!TERMINAL.has(status.state)) {
    writeJsonAtomic(join(dir, 'phase.json'), { ...(terminal ?? {}), outcome: result.state, ...result, registry_pending: undefined })
    writeJsonAtomic(join(dir, 'status.json'), { ...status, state: result.state === 'published' ? 'done' : 'failed', reason: result.cause, ended_at: new Date().toISOString() })
  }
}

/** Cierra terminales sin intención, o libera la reserva cuyo resultado ya fijó la recuperación. */
export function recoverRevisionResult(root: string, flow: string): void {
  recoverRevisionPublication(root, flow)
  const record = readPhaseRecord(root, flow, true)
  const run = record.revisions?.active?.run
  if (!run) return
  const dir = join(root, '.sdd-ai', 'runs', run)
  const status = readStatus(dir)
  const entry = record.revisions!.entries.find((e) => e.run === run)!
  // La finalización del registro puede preceder a un fallo al escribir el terminal de la corrida.
  if (!TERMINAL.has(status.state) && entry.result && entry.state !== 'active') {
    writeJsonAtomic(join(dir, 'phase.json'), { ...entry.result, outcome: entry.result.state, artifact: entry.artifact })
    writeJsonAtomic(join(dir, 'status.json'), { ...status,
      state: entry.result.state === 'published' || entry.result.state === 'no_changes' || entry.state === 'awaiting_context' ? 'done' : 'failed',
      reason: entry.result.cause, ended_at: new Date().toISOString() })
  }
  if (!TERMINAL.has(readStatus(dir).state)) return
  let result = entry.result
  if (!result) {
    let phase: RevisionResult & { outcome?: RevisionResult['state'] }
    try { phase = evidence(join(dir, 'phase.json'), 'revision_pending') } catch {
      phase = { state: status.state === 'cancelled' ? 'cancelled' : 'failed', cause: status.reason }
    }
    result = { ...phase, state: phase.outcome ?? phase.state, registry_pending: undefined }
  }
  let metadata: { session_id?: string; launch?: RevisionEntry['launch'] } = {}
  try { metadata = evidence(join(dir, 'revision-result.json'), 'revision_pending') } catch { /* Cancel previo al primer intento. */ }
  finishRevision(root, flow, run, result, metadata)
}

/** Reemplazo íntegro y condicionado. Sin un discriminante, publishPhase conserva la creación. */
export function publishRevision(root: string, launch: FrozenLaunch, contract: DocumentContract, now: Date,
  then?: (outcome: PublishOutcome) => void): PublishOutcome {
  const frozen = launch.revision!
  const decide = (): PublishOutcome => {
    const record = readPhaseRecord(root, launch.flow, true)
    const run = record.revisions?.active?.run
    const entry = record.revisions?.entries.find((e) => e.run === run)
    if (!run || !entry || run !== frozen.run || entry.review !== frozen.review) return { kind: 'conflict', cause: 'reservation_changed', detail: 'la reserva ya no pertenece a esta corrección' }
    let v: ValidatedRevision
    try {
      const origin = record.documents?.[launch.step]
      if (!origin) return { kind: 'conflict', cause: 'origin_missing', detail: 'desapareció el productor registrado' }
      v = validateRevision(root, launch.flow, frozen.artifact, frozen.review,
        { origin, launch: entry.launch, family: entry.family, recoverable: true }, undefined, run)
      if (bytesHash(v.document) !== frozen.document_digest || v.ledger_digest !== frozen.ledger_digest || v.round !== frozen.round
        || v.candidate.hash !== frozen.candidate || v.step_at_launch !== frozen.step_at_launch || v.handoff_header !== launch.handoff_header
        || v.depth !== launch.depth) throw new Error('cambiaron documento, revisión, ledger, header, profundidad o paso')
      for (const ref of entry.materials) {
        // Las copias históricas se congelan; sus originales pueden divergir de los insumos vigentes.
        if (ref.role?.startsWith('Material histórico')) continue
        if (bytesHash(regularBytes(join(root, ref.path))) !== ref.digest) throw new Error(`cambió ${ref.path}`)
      }
      if (entry.conductor && bytesHash(regularBytes(join(root, entry.conductor.path))) !== entry.conductor.digest) throw new Error('cambió el aporte del conductor')
    } catch (e) { return { kind: 'conflict', cause: 'material_changed', detail: (e as Error).message } }
    let candidate: RevisionCandidate
    try { candidate = prepareRevisionCandidate(root, v, contract) } catch (e) {
      return { kind: 'not_published', cause: 'candidate_blocked', detail: (e as Error).message }
    }
    if (candidate.identical) return { kind: 'no_changes', artifact: v.path, blocked_reasons: candidate.blocked_reasons }
    const dir = flowDir(root, launch.flow)
    const target = join(root, v.path)
    const tmp = join(dir, `.${frozen.artifact}.md.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      try { writeFileSync(tmp, candidate.text, { flag: 'wx' }) } catch (e) {
        return { kind: 'not_published', cause: 'write_failed', detail: (e as Error).message }
      }
      const intent = { run, artifact: v.path, previous_digest: candidate.previous_digest, result_digest: candidate.result_digest, gates: affectedGates(v.depth, v.artifact) }
      try { writePhaseRecord(root, launch.flow, { ...record, revisions: { ...record.revisions!, intent } }) } catch (e) {
        return { kind: 'not_published', cause: 'intent_unwritable', detail: (e as Error).message, registry_pending: true }
      }
      try {
        if (bytesHash(regularBytes(target)) !== candidate.previous_digest) {
          recoverRevisionPublication(root, launch.flow)
          return { kind: 'conflict', cause: 'target_changed_during_publish', detail: 'cambió el destino después de registrar la intención; se conservó ese contenido' }
        }
        renameSync(tmp, target)
      } catch (e) {
        const current = readPhaseRecord(root, launch.flow, true)
        try { writePhaseRecord(root, launch.flow, { ...current, revisions: { ...current.revisions!, intent: { ...intent, resolved: true } } }) } catch { /* La intención pendiente se recupera según sus bytes. */ }
        return { kind: 'not_published', cause: 'publish_interrupted', detail: (e as Error).message }
      }
      try {
        const current = readPhaseRecord(root, launch.flow, true)
        const metadata = evidence<{ session_id?: string; launch?: RevisionEntry['launch'] }>(join(root, '.sdd-ai', 'runs', run, 'revision-result.json'), 'revision_pending')
        const result: RevisionResult = { state: 'published', digest: candidate.result_digest, blocked_reasons: candidate.blocked_reasons }
        writePhaseRecord(root, launch.flow, { ...current, revisions: { ...current.revisions!, intent: { ...intent, resolved: true },
          barriers: [...current.revisions!.barriers, { run, artifact: v.path, gates: intent.gates, digest: candidate.result_digest }],
          entries: current.revisions!.entries.map((e) => e.run === run ? { ...e, ...metadata, state: 'published', result } : e),
        } })
        return { kind: 'published', artifact: v.path, digest: candidate.result_digest, blocked_reasons: candidate.blocked_reasons }
      } catch (e) { return { kind: 'published', artifact: v.path, digest: candidate.result_digest, registry_pending: true, detail: (e as Error).message } }
    } finally { rmSync(tmp, { force: true }) }
  }
  return withRevisionLocks(root, launch.flow, frozen.review, () => {
    const outcome = decide()
    then?.(outcome)
    return outcome
  })
}

/** Vista sin efectos; el resultado del registro prevalece sobre un terminal anterior de la corrida. */
export function revisionView(root: string, entry: RevisionEntry): Record<string, unknown> {
  const dir = join(root, '.sdd-ai', 'runs', entry.run)
  let terminal: { outcome?: string; registry_pending?: true } | undefined
  let orphan = false
  try {
    const status = readStatus(dir)
    try { terminal = evidence(join(dir, 'phase.json'), 'revision_pending') } catch { /* Todavía no hay entrega. */ }
    orphan = !TERMINAL.has(status.state) && status.supervisor_pid !== undefined && !isAlive(status.supervisor_pid)
  } catch { /* La reserva ilegible sigue pendiente. */ }
  const out: Record<string, unknown> = { ...entry }
  if (entry.result) out.state = entry.state
  else if (terminal?.outcome) out.state = terminal.outcome
  else if (orphan) out.state = 'orphan'
  if (terminal?.registry_pending && entry.state === 'active') {
    out.registry_pending = true
    out.detail = terminal.outcome === 'published' ? 'publicación pendiente de finalizar' : 'cierre pendiente del registro'
  }
  if (entry.result && terminal?.outcome && entry.result.state !== terminal.outcome) {
    out.terminal_superseded = { terminal: terminal.outcome, registered: entry.result.state }
  }
  if (entry.state === 'awaiting_context') out.next = `./bin/sdd-ai sdd phase ${entry.artifact.split('/')[1]} --revise ${entry.phase === 'specify' ? 'spec' : entry.phase} --context <archivo>`
  else if (orphan && !entry.result) out.next = `./bin/sdd-ai cancel ${entry.run}`
  else if (entry.state === 'active') out.next = `./bin/sdd-ai wait ${entry.run}`
  return out
}

export interface CorrectionProvenance { author: 'producer' | 'conductor' | 'mixed'; family?: Family; runs: string[] }

/** Clasifica publicaciones por sus huellas completas y las versiones intermedias de la secuencia. */
export function roundRevisionProvenance(root: string, flow: string, review: string, round: number,
  before: string, after: string, reviewer: Family): CorrectionProvenance {
  const entries = readPhaseRecord(root, flow, true).revisions?.entries.filter((e) => e.review === review && e.round === round && e.result?.state === 'published' && e.result.digest) ?? []
  if (!entries.length) return { author: 'conductor', runs: [] }
  if (entries.some((e) => e.family === reviewer)) return fail('same_family_reviewer', 'la ronda debe mantener un revisor de otra familia que el productor')
  let expected = bytesHash(before)
  let intervened = false
  for (const e of entries) {
    const input = e.materials.find((m) => m.path === e.artifact && m.role === 'Documento vigente completo')
    if (input?.digest !== expected) intervened = true
    expected = e.result!.digest!
  }
  const runs = entries.map((e) => e.run)
  return !intervened && expected === bytesHash(after) && new Set(entries.map((e) => e.family)).size === 1
    ? { author: 'producer', family: entries.at(-1)!.family, runs } : { author: 'mixed', runs }
}
