import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirtyPaths } from '../git.ts'
import { withLock } from '../lock.ts'
import { isRunId, readStatus, writeJsonAtomic } from '../runs.ts'
import { type Family, SddError, TERMINAL } from '../types.ts'
import { harvestTreeHolds, isWriterRun, readControl, readHarvest } from '../writer-store.ts'
import type { DocumentStep, PhaseStep } from './phase.ts'
import { LOCK_FILE, flowDir, lstatOrNull, pathInvalid, readFlow } from './read.ts'
import { type FlowStatus, type Next, headerData } from './status.ts'
import { reviewStartCommand } from '../review/standing.ts'
import { commitNext, isCommitSha } from './commit.ts'
import { type ChainState, classesPath, orientation } from './chain.ts'
import { chainBaseOf, chainView, classificationDetail, redProposals } from './chain-facts.ts'
import type { AttestationRef, VerifyReceipt, VerifyReceiptRef } from './verify-receipt.ts'

// El estado de las fases de un flujo que no se lee de sus artefactos: la última corrida, la ampliación
// y el cierre inline, por fase. Vive en el flujo, junto al registro de aprobaciones, y se escribe bajo
// el mismo lock.

export const PHASES_FILE = 'sdd-ai-phases.json'

export interface PhaseEntry {
  /** La fase devolvió preguntas o faltantes y espera el archivo de contexto del conductor. */
  awaiting?: { run: string; blocking_questions: string[]; missing_context: string[] }
  /** La ampliación lanzada; `consumed` cuando publicó su artefacto o cerró la fase inline. */
  amended?: { run: string; consumed: boolean }
  /** La ampliada volvió a devolver faltantes: la fase la sigue el conductor inline. */
  inline?: { run: string; at: string }
}
export interface PhaseRecord {
  schema_version: 1
  last_run: { id: string; step: PhaseStep } | null
  phases: Partial<Record<DocumentStep, PhaseEntry>>
  /** Los recibos de `sdd verify` y las acreditaciones de filas manuales, en orden: solo su id y su digest. */
  verify?: { receipts: VerifyReceiptRef[]; attestations: AttestationRef[] }
  /** Las cadenas de writers de `implement`; un registro anterior no la trae. */
  implement?: ImplementRecord
  commit?: CommitRecord
  reviews?: string[]
}

/** Una corrida de writer de la cadena. `implement` es el writer inicial; `fix`, una corrección desde un recibo rojo. */
export type RunKind = 'implement' | 'continuation' | 'block' | 'fix'
export type ChainClass = 'implementation' | 'contract' | 'environment' | 'design'
export type TerminalCode = 'takeover' | 'back_to_plan' | 'no_progress' | 'fix_cap' | 'failure_cap' | 'resume_unavailable' | 'legacy'
export interface LaunchInfo { prompt_digest: string; family: Family; model: string | null; effort: string | null }
export interface CommitIntent {
  state: 'intent'; at: string; digest: string; parent: string; tree: string; message: string; paths: string[]
  receipt: { id: string; digest: string }; review: string
}
export interface CommitDone extends Omit<CommitIntent, 'state'> { state: 'done'; sha: string }
export type CommitRecord = CommitIntent | CommitDone

export interface RunEntry {
  launch?: LaunchInfo
  kind: RunKind; run: string
  /** El eslabón del que parte: una corrida, una toma, o `null` en la primera cadena con el árbol limpio. */
  parent: string | null
  /** La corrida interrumpida que esta reanuda. */
  resumes?: string
  /** El commit base de la cadena al registrarla: un relanzamiento sin control parte de esta misma base. */
  base?: string
  at: string
  /** Las tasks congeladas al lanzar: todas las pendientes, las de un bloque o las que siguen. */
  pending?: string[]
  /** El recibo rojo del que parte un `fix`. */
  receipt?: { id: string; digest: string }
}
/** La toma del conductor: el árbol que declaró vive en el almacén, y acá queda su referencia. */
export interface TakeoverEntry { kind: 'takeover'; id: string; parent: string | null; at: string; map: { ref: string; digest: string }; reason?: string }
export type ChainEntry = RunEntry | TakeoverEntry
export interface ChainTerminal { code: TerminalCode; at: string; detail: string }
export interface Chain { id: string; entries: ChainEntry[]; terminal: ChainTerminal | null }
export interface Classification {
  receipt: { id: string; digest: string }
  /** La aprobación del plan vigente al clasificar: la época del conteo de fallos. */
  epoch: string | null
  at: string
  rows: { row: string; class: ChainClass; proposed: ChainClass | null; reason: string }[]
}
/** Lo que no es un eslabón: un lanzamiento que falló antes del spawn o una negativa que conviene dejar registrada. */
export interface ChainEvent { kind: 'launch_failed' | 'refused'; at: string; chain?: string; run?: string; detail: string }
export interface ImplementRecord { schema: 1; chains: Chain[]; classifications: Classification[]; events: ChainEvent[] }

const PHASE_STEPS: readonly string[] = ['specify', 'plan', 'tasks', 'implement']
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function invalid(id: string, why: string): SddError {
  return new SddError('phases_invalid', `.plans/${id}/${PHASES_FILE} no sirve: ${why}`, {
    next: `revisa el archivo; si no hay ninguna corrida de fase en curso, puedes borrarlo y la fase vuelve a empezar`,
  })
}

/** El registro de fases del flujo; uno vacío si todavía no existe. Un registro con otra forma es un error. */
export function readPhaseRecord(root: string, id: string): PhaseRecord {
  const file = join(flowDir(root, id), PHASES_FILE)
  const st = lstatOrNull(file)
  if (st === null) return { schema_version: 1, last_run: null, phases: {} }
  if (st.isSymbolicLink()) throw pathInvalid(`.plans/${id}/${PHASES_FILE}`, 'es un enlace simbólico')
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw invalid(id, (e as Error).message)
  }
  if (!isRecord(data) || data.schema_version !== 1) throw invalid(id, 'schema_version no es 1')
  const last = data.last_run
  if (last !== null && !(isRecord(last) && typeof last.id === 'string' && isRunId(last.id) && PHASE_STEPS.includes(String(last.step)))) {
    throw invalid(id, 'last_run no es null ni una corrida con su paso')
  }
  if (!isRecord(data.phases)) throw invalid(id, 'phases no es un mapa')
  if (data.reviews !== undefined && !(Array.isArray(data.reviews) && data.reviews.every((r) => typeof r === 'string' && isRunId(r)))) {
    throw invalid(id, 'reviews no es una lista de ids completos de corrida')
  }
  for (const [step, entry] of Object.entries(data.phases)) {
    if (!DOCUMENT_STEPS.includes(step)) throw invalid(id, `phases.${step} no es una fase con registro`)
    const problem = entryProblem(entry)
    if (problem !== null) throw invalid(id, `phases.${step} ${problem}`)
  }
  if (data.verify !== undefined) {
    const problem = verifyProblem(data.verify)
    if (problem !== null) throw invalid(id, `verify ${problem}`)
  }
  if (data.implement !== undefined) {
    const problem = implementProblem(data.implement)
    if (problem !== null) throw invalid(id, `implement ${problem}`)
  }
  if (data.commit !== undefined) {
    const problem = commitProblem(data.commit)
    if (problem !== null) throw invalid(id, `commit ${problem}`)
  }
  return data as unknown as PhaseRecord
}

const RUN_KINDS: readonly string[] = ['implement', 'continuation', 'block', 'fix']
const CLASSES: readonly string[] = ['implementation', 'contract', 'environment', 'design']
const TERMINALS: readonly string[] = ['takeover', 'back_to_plan', 'no_progress', 'fix_cap', 'failure_cap', 'resume_unavailable', 'legacy']
const ISO = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const digested = (v: Record<string, unknown>) => typeof v.digest === 'string' && DIGEST.test(v.digest)
/** Un recibo se nombra por `id`; el mapa de una toma, por `ref`. Cada uno con su clave y su digest. */
const receiptRef = (v: unknown) => isRecord(v) && onlyKeys(v, ['id', 'digest']) === undefined && text(v.id) && digested(v)
const mapRef = (v: unknown) => isRecord(v) && onlyKeys(v, ['ref', 'digest']) === undefined && text(v.ref) && digested(v)
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).find((k) => !keys.includes(k))

/** Qué le falta a una entrada de la cadena para tener su forma; `null` si la tiene. */
function entryOfChainProblem(e: unknown): string | null {
  if (!isRecord(e)) return 'no es un mapa'
  if (e.kind === 'takeover') {
    const extra = onlyKeys(e, ['kind', 'id', 'parent', 'at', 'map', 'reason'])
    if (extra) return `trae la clave desconocida ${extra}`
    if (!text(e.id) || !(e.parent === null || text(e.parent)) || !ISO(e.at) || !mapRef(e.map)) return 'es una toma sin id, padre, fecha o mapa'
    if (e.reason !== undefined && !text(e.reason)) return 'es una toma con una razón vacía'
    return null
  }
  if (!RUN_KINDS.includes(String(e.kind))) return `tiene el tipo desconocido ${JSON.stringify(e.kind)}`
  const extra = onlyKeys(e, ['kind', 'run', 'parent', 'resumes', 'base', 'at', 'pending', 'receipt', 'launch'])
  if (extra) return `trae la clave desconocida ${extra}`
  if (e.launch !== undefined) {
    const l = e.launch
    if (!isRecord(l) || Object.keys(l).length !== LAUNCH_KEYS.length || onlyKeys(l, LAUNCH_KEYS)
      || typeof l.prompt_digest !== 'string' || !DIGEST.test(l.prompt_digest) || !['claude', 'codex'].includes(String(l.family))
      || !(l.model === null || text(l.model)) || !(l.effort === null || text(l.effort))) return 'tiene launch inválido'
  }
  if (e.base !== undefined && !text(e.base)) return 'tiene una base vacía'
  if (!(typeof e.run === 'string' && isRunId(e.run)) || !(e.parent === null || text(e.parent)) || !ISO(e.at)) return 'es una corrida sin id, padre o fecha'
  if (e.resumes !== undefined && !(typeof e.resumes === 'string' && isRunId(e.resumes))) return 'reanuda algo que no es una corrida'
  if (e.pending !== undefined && !texts(e.pending)) return 'tiene pending que no es una lista de tasks'
  // Una corrección nombra el recibo del que sale; las demás corridas no parten de un recibo.
  if (e.kind === 'fix' ? !receiptRef(e.receipt) : e.receipt !== undefined) return e.kind === 'fix' ? 'es una corrección sin recibo con id y digest' : 'trae un recibo y no es una corrección'
  return null
}

/** Las claves de `launch`: exactamente estas, todas presentes. */
const LAUNCH_KEYS: readonly string[] = ['prompt_digest', 'family', 'model', 'effort']

function commitProblem(c: unknown): string | null {
  if (!isRecord(c) || !['intent', 'done'].includes(String(c.state))) return 'no es intent ni done'
  const keys = ['state', 'at', 'digest', 'parent', 'tree', 'message', 'paths', 'receipt', 'review', ...(c.state === 'done' ? ['sha'] : [])]
  if (Object.keys(c).length !== keys.length || onlyKeys(c, keys)) return 'tiene claves incorrectas'
  const sha = isCommitSha
  const date = typeof c.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(c.at) && ISO(c.at)
  if (!date || !digested(c) || !sha(c.parent) || !sha(c.tree) || (c.state === 'done' && !sha(c.sha))) return 'tiene fecha, digest o sha inválido'
  if (!text(c.message) || !Array.isArray(c.paths) || !c.paths.every(text) || c.paths.length === 0 || !receiptRef(c.receipt)
    || typeof c.review !== 'string' || !isRunId(c.review)) return 'tiene mensaje, rutas, recibo o revisión inválidos'
  return null
}

/** Escribe o borra el commit del flujo; quien llama tiene el lock del flujo. */
export function writeCommitRecord(root: string, id: string, c: CommitRecord | undefined): void {
  const record = readPhaseRecord(root, id)
  if (c === undefined) delete record.commit
  else record.commit = c
  writePhaseRecord(root, id, record)
}

/** Qué le falta a la clave `implement` para tener la forma del registro; `null` si la tiene. */
function implementProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'no es un mapa'
  const extra = onlyKeys(v, ['schema', 'chains', 'classifications', 'events'])
  if (extra) return `trae la clave desconocida ${extra}`
  if (v.schema !== 1) return 'schema no es 1'
  if (!Array.isArray(v.chains) || !Array.isArray(v.classifications) || !Array.isArray(v.events)) return 'no trae las listas chains, classifications y events'
  const chainIds = new Set<string>()
  for (const [i, c] of v.chains.entries()) {
    if (!isRecord(c) || !text(c.id) || !Array.isArray(c.entries)) return `chains[${i}] no es una cadena con id y entradas`
    if (chainIds.has(c.id as string)) return `chains[${i}] repite el id ${c.id}`
    chainIds.add(c.id as string)
    for (const [k, e] of c.entries.entries()) {
      const problem = entryOfChainProblem(e)
      if (problem !== null) return `chains[${i}].entries[${k}] ${problem}`
    }
    const term = c.terminal
    if (term !== null && !(isRecord(term) && TERMINALS.includes(String(term.code)) && ISO(term.at) && typeof term.detail === 'string')) {
      return `chains[${i}].terminal no es null ni un terminal con código, fecha y detalle`
    }
  }
  for (const [i, c] of v.classifications.entries()) {
    if (!isRecord(c) || !receiptRef(c.receipt) || !(c.epoch === null || text(c.epoch)) || !ISO(c.at) || !Array.isArray(c.rows)) {
      return `classifications[${i}] no es una clasificación con recibo, época, fecha y filas`
    }
    const bad = c.rows.find((r) => !(isRecord(r) && text(r.row) && CLASSES.includes(String(r.class))
      && (r.proposed === null || CLASSES.includes(String(r.proposed))) && text(r.reason)))
    if (bad !== undefined) return `classifications[${i}] tiene una fila sin id, clase o razón`
  }
  for (const [i, e] of v.events.entries()) {
    if (!isRecord(e) || !['launch_failed', 'refused'].includes(String(e.kind)) || !ISO(e.at) || typeof e.detail !== 'string') {
      return `events[${i}] no es un evento con tipo, fecha y detalle`
    }
    const extra = onlyKeys(e, ['kind', 'at', 'chain', 'run', 'detail'])
    if (extra) return `events[${i}] trae la clave desconocida ${extra}`
    if (e.chain !== undefined && !text(e.chain)) return `events[${i}] nombra una cadena que no es texto`
    if (e.run !== undefined && !(typeof e.run === 'string' && isRunId(e.run))) return `events[${i}] nombra algo que no es una corrida`
  }
  return null
}

const emptyImplement = (): ImplementRecord => ({ schema: 1, chains: [], classifications: [], events: [] })

/** El registro de cadenas del flujo; vacío si el registro es anterior. */
export const implementOf = (r: PhaseRecord): ImplementRecord => r.implement ?? emptyImplement()

/** La última toma del flujo, en cualquiera de sus cadenas; `null` si nunca hubo una. */
export function latestTakeover(imp: ImplementRecord): TakeoverEntry | null {
  for (const c of [...imp.chains].reverse()) {
    for (const e of [...c.entries].reverse()) if (e.kind === 'takeover') return e
  }
  return null
}

/**
 * Si un recibo es posterior a la última toma del flujo: corrió sobre ella o empezó después. Un recibo anterior
 * no acredita el árbol aunque la huella vuelva a coincidir, también si después de la toma se abrió otra cadena.
 */
export function receiptAfterTakeover(r: Pick<VerifyReceipt, 'started_at' | 'writer'>, imp: ImplementRecord): boolean {
  const t = latestTakeover(imp)
  return t === null || r.writer?.takeover === t.id || Date.parse(r.started_at) > Date.parse(t.at)
}

// Las cuatro escrituras del registro de cadenas. Cada una lee y escribe el registro entero, y va dentro de
// `withFlowLock`: el llamador toma el lock y decide, en el mismo tramo, qué escribir.

/** Agrega una entrada a la cadena `chain`, o abre una cadena nueva con esa entrada si `chain` es `null`. Devuelve el id de la cadena. */
export function appendEntry(root: string, id: string, chain: string | null, entry: ChainEntry): string {
  const r = readPhaseRecord(root, id)
  const imp = implementOf(r)
  let target = chain
  let chains: Chain[]
  if (target === null) {
    target = `c${imp.chains.length + 1}`
    chains = [...imp.chains, { id: target, entries: [entry], terminal: null }]
  } else {
    if (!imp.chains.some((c) => c.id === target)) throw new Error(`la cadena ${target} no existe en el registro`)
    chains = imp.chains.map((c) => (c.id === target ? { ...c, entries: [...c.entries, entry] } : c))
  }
  const last_run = 'run' in entry ? { id: entry.run, step: 'implement' as const } : r.last_run
  writePhaseRecord(root, id, { ...r, last_run, implement: { ...imp, chains } })
  return target
}

/** Registra una clasificación. Una ya registrada para el mismo recibo no se reemplaza: devuelve la existente. */
export function appendClassification(root: string, id: string, c: Classification): Classification {
  const r = readPhaseRecord(root, id)
  const imp = implementOf(r)
  const existing = imp.classifications.find((x) => x.receipt.id === c.receipt.id)
  if (existing) return existing
  writePhaseRecord(root, id, { ...r, implement: { ...imp, classifications: [...imp.classifications, c] } })
  return c
}

export function appendEvent(root: string, id: string, e: ChainEvent): void {
  const r = readPhaseRecord(root, id)
  const imp = implementOf(r)
  writePhaseRecord(root, id, { ...r, implement: { ...imp, events: [...imp.events, e] } })
}

/** Cierra la cadena con su terminal. Un terminal ya escrito no se reemplaza: devuelve el que quedó. */
export function closeChain(root: string, id: string, chain: string, terminal: ChainTerminal): ChainTerminal {
  const r = readPhaseRecord(root, id)
  const imp = implementOf(r)
  const c = imp.chains.find((x) => x.id === chain)
  if (!c) throw new Error(`la cadena ${chain} no existe en el registro`)
  if (c.terminal !== null) return c.terminal
  writePhaseRecord(root, id, { ...r, implement: { ...imp, chains: imp.chains.map((x) => (x.id === chain ? { ...x, terminal } : x)) } })
  return terminal
}

const DIGEST = /^sha256:[0-9a-f]{64}$/

/** Qué le falta a la entrada de verify para tener la forma del registro; `null` si la tiene. */
function verifyProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'no es un mapa'
  for (const key of Object.keys(v)) if (!['receipts', 'attestations'].includes(key)) return `trae la clave desconocida ${key}`
  if (!Array.isArray(v.receipts) || !Array.isArray(v.attestations)) return 'no trae las listas receipts y attestations'
  const ref = (r: unknown) => isRecord(r) && typeof r.id === 'string' && isRunId(r.id) && typeof r.digest === 'string' && DIGEST.test(r.digest)
  if (!v.receipts.every((r) => ref(r) && isRecord(r) && (r.mode === 'final' || r.mode === 'baseline'))) return 'tiene un recibo sin id, digest o modo'
  if (!v.attestations.every((a) => ref(a) && isRecord(a) && text(a.row) && text(a.proof_ref))) return 'tiene una acreditación sin id, digest, fila o prueba'
  return null
}

const withVerify = (r: PhaseRecord) => r.verify ?? { receipts: [], attestations: [] }

/** Agrega la referencia de un recibo ya publicado al registro del flujo, bajo su lock. */
export function appendReceiptRef(root: string, id: string, ref: VerifyReceiptRef): void {
  withFlowLock(root, id, () => {
    const r = readPhaseRecord(root, id)
    const v = withVerify(r)
    writePhaseRecord(root, id, { ...r, verify: { ...v, receipts: [...v.receipts, ref] } })
  })
}

/** Conserva una revisión por cita; no concede validez ni aprobaciones. */
export function appendReviewRef(root: string, flow: string, run: string, validate: () => void): void {
  if (!isRunId(run)) throw invalid(flow, 'la referencia de revisión no es un id completo')
  withFlowLock(root, flow, () => {
    validate()
    const r = readPhaseRecord(root, flow)
    const reviews = r.reviews ?? []
    if (!reviews.includes(run)) writePhaseRecord(root, flow, { ...r, reviews: [...reviews, run] })
  })
}

/** Agrega la referencia de una acreditación ya publicada. Va dentro de `withFlowLock`, junto al control de respuestas consumidas. */
export function appendAttestationRef(root: string, id: string, ref: AttestationRef): void {
  const r = readPhaseRecord(root, id)
  const v = withVerify(r)
  writePhaseRecord(root, id, { ...r, verify: { ...v, attestations: [...v.attestations, ref] } })
}

/** El último recibo final del flujo; los de `--baseline` no cuentan para `verified`. */
export function latestFinalReceipt(r: PhaseRecord): VerifyReceiptRef | null {
  return [...(r.verify?.receipts ?? [])].reverse().find((ref) => ref.mode === 'final') ?? null
}

const DOCUMENT_STEPS: readonly string[] = ['specify', 'plan', 'tasks']
const texts = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
const text = (v: unknown) => typeof v === 'string' && v !== ''

/** Qué le falta a la entrada de una fase para tener la forma del registro; `null` si la tiene. */
function entryProblem(entry: unknown): string | null {
  if (!isRecord(entry)) return 'no es un mapa'
  for (const key of Object.keys(entry)) if (!['awaiting', 'amended', 'inline'].includes(key)) return `trae la clave desconocida ${key}`
  const { awaiting, amended, inline } = entry
  if (awaiting !== undefined && !(isRecord(awaiting) && text(awaiting.run) && texts(awaiting.blocking_questions) && texts(awaiting.missing_context))) {
    return 'tiene un awaiting sin run, blocking_questions o missing_context'
  }
  if (amended !== undefined && !(isRecord(amended) && text(amended.run) && typeof amended.consumed === 'boolean')) return 'tiene un amended sin run o consumed'
  if (inline !== undefined && !(isRecord(inline) && text(inline.run) && text(inline.at))) return 'tiene un inline sin run o at'
  return null
}

/**
 * Corre `fn` con el lock del flujo, el mismo de `sdd approve`: publicar una fase, registrarla y aprobar un
 * gate no se pisan. Un lock tomado por otro proceso vivo se espera; uno huérfano no se roba.
 */
export function withFlowLock<T>(root: string, id: string, fn: () => T): T {
  const lock = join(flowDir(root, id), LOCK_FILE)
  if (lstatOrNull(lock)?.isSymbolicLink()) throw pathInvalid(`.plans/${id}/${LOCK_FILE}`, 'es un enlace simbólico')
  const busy = () => new SddError('flow_busy', `otro comando de sdd-ai tiene tomado el flujo ${id}`, {
    next: `si no hay otro sdd approve, sdd phase ni sdd branch corriendo, borra .plans/${id}/${LOCK_FILE} y vuelve a correr el comando`,
  })
  return withLock(lock, busy, fn)
}

/** Escribe el registro de un golpe. Va dentro de `withFlowLock`. */
export function writePhaseRecord(root: string, id: string, r: PhaseRecord): void {
  writeJsonAtomic(join(flowDir(root, id), PHASES_FILE), r)
}

/**
 * Si una corrida sigue sin terminal: una de proceso por su `status.json`, un writer por su cosecha. Una
 * corrida que ya no está en disco no está activa.
 */
function runActive(root: string, run: string): boolean {
  if (isWriterRun(root, run)) return readHarvest(root, run) === undefined
  const dir = join(root, '.sdd-ai', 'runs', run)
  if (!existsSync(join(dir, 'status.json'))) return false
  try {
    return !TERMINAL.has(readStatus(dir).state)
  } catch {
    return true
  }
}

/** La corrida de fase del flujo que todavía no terminó, o `null`. */
export function activeRun(root: string, r: PhaseRecord): string | null {
  return r.last_run !== null && runActive(root, r.last_run.id) ? r.last_run.id : null
}

/** Lo que `phaseNext` mira fuera del registro; las pruebas lo reemplazan. */
export interface PhaseProbe {
  active(run: string): boolean
  dirty(): string[]
  /** Si el árbol sigue siendo el que dejó la cosecha de ese writer. */
  writerHolds(run: string): boolean
}

const diskProbe = (root: string): PhaseProbe => ({
  active: (run) => runActive(root, run),
  dirty: () => dirtyPaths(root),
  writerHolds: (run) => harvestTreeHolds(root, run),
})

/**
 * El comando de la fase según su estado, o por qué no hay comando. `null` fuera de `normal` y
 * `completa` o de un paso de fase: ahí manda el `next` de `sdd status` tal cual.
 */
export function phaseNext(root: string, id: string, status: Pick<FlowStatus, 'depth' | 'next'>, r: PhaseRecord,
  probe: PhaseProbe = diskProbe(root)): { command?: string; detail?: string } | null {
  const step = status.next.step
  if ((status.depth !== 'normal' && status.depth !== 'completa') || !PHASE_STEPS.includes(step)) return null
  const launch = `./bin/sdd-ai sdd phase ${id}`
  if (r.last_run !== null && probe.active(r.last_run.id)) return { command: `./bin/sdd-ai wait ${r.last_run.id}` }
  if (step === 'implement') {
    const dirty = probe.dirty()
    if (dirty.length === 0) return { command: launch }
    const writer = r.last_run?.step === 'implement' ? r.last_run.id : null
    if (writer !== null && probe.writerHolds(writer)) {
      return { detail: `el árbol tiene los cambios del writer ${writer}: revisa el diff (./bin/sdd-ai wait ${writer}) y decide con el usuario antes de relanzar la fase` }
    }
    return { detail: `el árbol tiene cambios sin commitear (${dirty.join(', ')}): hay que resolverlos antes de lanzar el writer de la fase` }
  }
  const entry = r.phases[step as DocumentStep]
  if (entry?.inline) return { detail: `la fase ${step} la sigue el conductor inline: la ampliación volvió a devolver preguntas o faltantes` }
  if (entry?.awaiting) return { command: `${launch} --context <archivo>` }
  return { command: step === 'specify' ? `${launch} --request <archivo>` : launch }
}

/**
 * El `next` de un flujo con el comando de su fase o de `sdd verify`, o con el motivo por el que no hay. Un registro que no
 * se puede leer no tumba a quien lista: queda dicho en `detail`.
 */
export function withPhaseNext<T extends Pick<FlowStatus, 'depth' | 'next'>>(root: string, id: string, status: T): Next {
  if (status.next.step === 'branch') return { ...status.next, command: `./bin/sdd-ai sdd branch ${id}` }
  const chained = chainNext(root, id, status)
  if (status.next.step === 'review_and_commit') {
    // Un next de la cadena sin comando es un diagnóstico (control ilegible, cadena sin corridas): se muestra tal cual.
    if (chained !== null && chained.command === undefined) return chained
    let next = chained ?? status.next
    if (chained === null) {
      try {
        const base = headerData(readFlow(root, id).facts.planHeader)?.base_commit
        // Solo un sha entra al comando: el header es texto editable y el comando se ejecuta tal cual.
        if (isCommitSha(base)) next = { ...next, command: reviewStartCommand(id, base) }
      } catch {
        return next
      }
    }
    return commitNext(root, id, next)
  }
  if (chained !== null) return chained
  if (status.next.step === 'verify') return { ...status.next, command: `./bin/sdd-ai sdd verify ${id}` }
  if ((status.depth !== 'normal' && status.depth !== 'completa') || !PHASE_STEPS.includes(status.next.step)) return status.next
  try {
    const phase = phaseNext(root, id, status, readPhaseRecord(root, id))
    return phase ? { ...status.next, ...phase } : status.next
  } catch (e) {
    return { ...status.next, detail: `no se pudo leer el registro de fases: ${(e as Error).message}` }
  }
}

/**
 * El `next` de un flujo con una cadena de writers, en `implement`, `verify` o `review_and_commit`: lo decide
 * el estado de la cadena. `null` sin cadena o fuera de esos pasos. Si el estado no se puede leer, lo dice en
 * vez de proponer el comando del paso.
 */
function chainNext(root: string, id: string, status: Pick<FlowStatus, 'depth' | 'next'>): Next | null {
  const step = status.next.step
  if ((status.depth !== 'normal' && status.depth !== 'completa') || !['implement', 'verify', 'review_and_commit'].includes(step)) return null
  let view: ReturnType<typeof chainView>
  try {
    view = chainView(root, id, readFlow(root, id))
  } catch (e) {
    return { step: status.next.step, detail: `no se pudo leer la cadena del writer: ${(e as Error).message}` }
  }
  const s = view.state
  if (s.chain === null) return null
  const n = s.next
  const phase = `./bin/sdd-ai sdd phase ${id}`
  const detail = orientation(id, n)
  if (step === 'review_and_commit') {
    const link = s.last
    if (link === null) return null
    // Sin la base o la familia del writer no hay comando de revisión que proponer: se dice qué falta.
    let base: string | null
    let family: string | undefined
    try {
      base = chainBaseOf(root, view.input.imp, s.chain)
      family = link.kind === 'takeover' ? undefined : readControl(root, link.run).family
    } catch (e) {
      return { step: status.next.step, detail: `no se pudo leer el control de la cadena para armar la revisión: ${(e as Error).message}` }
    }
    if (base === null) return { step: status.next.step, detail: 'la cadena no tiene ninguna corrida lanzada: no hay base para la revisión' }
    if (link.kind === 'takeover') return { ...status.next, command: reviewStartCommand(id, base), detail: 'el candidato es de autoría mezclada: el writer de la cadena y la toma del conductor' }
    if (family === undefined) return { step: status.next.step, detail: `el control de ${link.run} no dice la familia del writer: no hay comando de revisión que proponer` }
    return { ...status.next, command: reviewStartCommand(id, base, { run: link.run, author: family }) }
  }
  switch (n.kind) {
    case 'verify':
    case 'repeat_verify':
      return step === 'verify' ? { ...status.next, command: `./bin/sdd-ai sdd verify ${id}`, ...(n.kind === 'repeat_verify' ? { detail } : {}) }
        : { ...status.next, detail: `el último eslabón está completo: marca en tasks.md las tasks acreditadas (${s.covered.join(', ') || 'ninguna'}) y corre ./bin/sdd-ai sdd verify ${id}` }
    case 'wait': return { ...status.next, command: `./bin/sdd-ai wait ${n.run}` }
    case 'orphan': return { ...status.next, command: `./bin/sdd-ai cancel ${n.run}`, detail }
    case 'classify': {
      // El comando trae el archivo de clases, y el detalle, las propuestas y la plantilla para escribirlo.
      const proposals = view.receipt ? `\n${classificationDetail(view.receipt, redProposals(root, id, view.receipt))}` : ''
      return { ...status.next, command: `${phase} --classes ${classesPath(id, n.receipt)}`, detail: `${detail}${proposals}` }
    }
    case 'start':
    case 'continue':
    case 'resume':
    case 'fix':
      return { ...status.next, command: phase, detail }
    case 'blocks_or_takeover': return { ...status.next, command: `${phase} --blocks`, detail }
    case 'attest': return { ...status.next, command: `./bin/sdd-ai sdd verify ${id} --attest ${n.rows[0]}`, detail }
    case 'takeover':
    case 'conductor': return { ...status.next, command: `./bin/sdd-ai sdd verify ${id} --takeover`, detail }
    default: return { ...status.next, detail }
  }
}
