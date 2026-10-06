import type { FsEntry, FsStat } from 'claude-code'
import type { NotificationObservation } from './notification'
import type {
  BandActivity, BandFlow, BandMemory, BandPresentation, BandSelection, FlowDetail, Identity, Observed, OpenReason, ProjectionFlow, ProjectionProgress,
  ProjectionRun, ProjectionWriter, Reason, RunKind, RunState, SessionSelection, SessionViews, Unavailable,
} from '../types'
import type { ProjectionCollection as Collection, ProjectionEntity as Entity } from '../types'

export type {
  BandActivity, BandFlow, BandMemory, BandPresentation, BandProgress, BandSelection, FlowDetail, Identity, Observed, OpenReason, ProjectionFlow,
  ProjectionProgress, ProjectionRun, ProjectionWriter, Reason, RunKind, RunState, SessionSelection, Unavailable,
} from '../types'

// Lectura y selección puras de la proyección que publica el binario en `.sdd-ai/projection/live/`. Este módulo no
// recibe `$`: trabaja con listados, `stat` y textos ya leídos, y devuelve lo que la banda presenta. El mod no importa
// nada del binario, así que copia del contrato (`src/projection-types.ts`) lo que necesita. Los tipos de lo que la banda
// presenta están en el contrato de su estado (`types/index.d.ts`).

/** La versión del contrato que el mod entiende. */
export const SCHEMA_VERSION = 1
/** El tope de `$.fs.read`: una observación más grande no se lee. */
export const MAX_OBSERVATION_BYTES = 4 * 1024 * 1024
/** Con más entradas que estas en `live/`, la proyección no está disponible hasta la siguiente publicación. */
export const MAX_LIVE_ENTRIES = 256
/** Después de un listado de más de `MAX_LIVE_ENTRIES` entradas, cuánto se espera antes de volver a listar. */
export const FLOODED_PAUSE_MS = 3_000
/** Cuántas veces se lista `live/` cuando las elegidas desaparecen, antes de conservar la última lectura. */
export const LIST_ATTEMPTS = 3
/** Si una corrida viva pasa más que esto sin publicaciones, la banda dice hace cuánto se observó. */
export const STALE_AFTER_MS = 60_000
/**
 * Copia exacta de `OBSERVATION_NAME` del contrato: `obs-<m0>-<arranque>-<pid>-<aleatorio>.json`, con `m0` en 20
 * dígitos. Los temporales (`tmp-…`), las reservas de un publicador que está leyendo (`claim-…`) y las demás entradas
 * de `live/` no son observaciones, aunque cuentan para el límite de entradas.
 */
export const OBSERVATION_NAME = /^obs-(\d{20})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)-([0-9a-f]{32})\.json$/
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// El subconjunto del contrato que lee el mod está en `types/index.d.ts`, junto a `SessionSelection`, porque el estado
// del panel lo guarda y el contrato de tipos del mod tiene que ser autocontenido. Los campos que no usa no se validan
// ni se conservan.
export interface ProjectionBinding extends Entity { flow: Observed<{ id: string; step: string; gate: string | null; at: string }> }
export interface ProjectionDocument {
  schema_version: 1; notifications_version?: number; checkout: { id: string; root: string }
  observation: { id: string; m0: string; boot: string; pid: number; observed_at: number; read_finished_at: number }
  runs: Collection<ProjectionRun>
  writer: { availability: 'available' | 'unavailable'; reason: Reason | null; item: ProjectionWriter | null }
  flows: Collection<ProjectionFlow>; bindings: Collection<ProjectionBinding>
}

/** Un nombre de observación interpretado. `rest` es lo que sigue a `m0`: desempata dos observaciones con el mismo. */
export interface ObservationName { name: string; m0: string; boot: string; pid: number; rest: string }

export function observationName(name: string): ObservationName | null {
  const match = OBSERVATION_NAME.exec(name)
  if (!match) return null
  const [, m0 = '', boot = '', pid = ''] = match
  return { name, m0, boot, pid: Number(pid), rest: name.slice(`obs-${m0}-`.length) }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Las observaciones de un listado, de la más nueva a la más vieja: por `m0` y, a igual `m0`, por el resto del nombre.
 * Las demás entradas se descartan. El orden no depende del orden del listado.
 */
export function newestFirst(names: readonly string[]): string[] {
  return names.flatMap((name) => observationName(name) ?? [])
    .sort((a, b) => compare(b.m0, a.m0) || compare(b.rest, a.rest))
    .map((entry) => entry.name)
}

/**
 * Lo que dice el listado de `live/`: inundado, o sus observaciones de la más nueva a la más vieja. Sin observaciones
 * (por ejemplo, un `live/` recién apartado y todavía vacío) se vuelve a listar, como cuando desaparecen las elegidas.
 */
export type Listing = { kind: 'flooded' } | { kind: 'candidates'; names: string[] }

export function listingOf(entries: readonly Pick<FsEntry, 'name'>[]): Listing {
  if (entries.length > MAX_LIVE_ENTRIES) return { kind: 'flooded' }
  return { kind: 'candidates', names: newestFirst(entries.map((entry) => entry.name)) }
}

/** Las rutas que lee el mod, bajo la ruta real del checkout (la que da `$.fs.stat(raíz, { resolve: true })`). */
export function projectionPaths(realRoot: string) {
  const root = realRoot.length > 1 ? realRoot.replace(/\/+$/, '') : realRoot
  const store = `${root === '/' ? '' : root}/.sdd-ai`
  const live = `${store}/projection/live`
  return { root, store, projection: `${store}/projection`, live, observation: (name: string) => `${live}/${name}` }
}

/**
 * Lo que respondió un `$.fs.stat`: lo que encontró, que la ruta no existe (`absent`) o que la consulta falló por otro
 * motivo (`failed`: permisos, un error del motor o el rechazo de otro mod). Solo la ausencia es una desaparición.
 */
export type Lookup<S = FsStat> = { kind: 'found'; stat: S } | { kind: 'absent' } | { kind: 'failed' }

/**
 * El prefijo con que el motor informa un rechazo de `$.fs`, en sus dos formatos: `<plugin>: $.fs.<verbo>: ` y, desde
 * Claude Code 2.1.289, `<plugin>: $.fs.<verbo>(<ruta>) failed: `. En el segundo la ruta va sin comillas y el motivo
 * puede repetirla, así que ningún patrón sabe dónde termina: quien conoce la ruta pedida corta justo después de
 * `(<ruta>) failed: ` (ver `isAbsence`). Sin la ruta, este patrón toma el primer `) failed: ` como respaldo.
 */
const REJECTION_PREFIX = /^[^']*?: \$\.fs\.\w+(?:: |\(.*?\) failed: )/

/**
 * El motivo de un rechazo de `$.fs` sin código: lo que sigue al prefijo del motor o, sin prefijo, el texto entero. El
 * de una ausencia empieza con el `errno` (`ENOENT: no such file or directory, …`), antes de la ruta.
 */
function reasonOf(text: string, path?: string): string {
  // Con la ruta pedida, el corte es exacto: lo que sigue a su primer `(<ruta>) failed: `, aunque la ruta o el motivo
  // contengan el marcador.
  const marker = path === undefined ? -1 : text.indexOf(`(${path}) failed: `)
  if (marker !== -1 && path !== undefined) return text.slice(marker + path.length + '() failed: '.length)
  const prefix = REJECTION_PREFIX.exec(text)
  return prefix === null ? text : text.slice(prefix[0].length)
}

/**
 * Si un rechazo de `$.fs` dice que la ruta no existe. Un error con `code` lo decide por el código: solo `ENOENT` es
 * una ausencia. Sin código, solo un motivo que empieza con `ENOENT`: uno dentro de la ruta no cuenta. Cualquier otro
 * rechazo no es una ausencia.
 */
export function isAbsence(error: unknown, path?: string): boolean {
  if (typeof error === 'string') return /^ENOENT\b/.test(reasonOf(error, path))
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code !== undefined) return code === 'ENOENT'
  return typeof message === 'string' && /^ENOENT\b/.test(reasonOf(message, path))
}

/**
 * `.sdd-ai/`, `projection/` y `live/` deben ser directorios y no enlaces. Un publicador aparta `live/` y lo vuelve a
 * crear: su ausencia (`missing`) se reintenta como una elegida que desapareció. Una consulta que falló por otro motivo
 * deja la proyección no disponible (`unreadable`).
 */
export function directoryProblem(lookup: Lookup<Pick<FsStat, 'kind' | 'isLink'>>): 'missing' | 'unreadable' | 'link' | 'not_directory' | null {
  if (lookup.kind === 'absent') return 'missing'
  if (lookup.kind === 'failed') return 'unreadable'
  if (lookup.stat.isLink) return 'link'
  return lookup.stat.kind === 'dir' ? null : 'not_directory'
}

/**
 * Lo que decide el `stat` con `resolve` de la elegida antes de leerla. Solo `vanished` (no existe) deja probar la
 * siguiente de la lista: una elegida que existe y no sirve, o cuya consulta falló por otro motivo, deja la proyección
 * no disponible, sin caer a otra.
 */
export type StatJudgement = { kind: 'vanished' } | { kind: 'unavailable'; reason: Unavailable } | { kind: 'readable' }

export function judgeStat(lookup: Lookup, name: string, realRoot: string): StatJudgement {
  if (lookup.kind === 'absent') return { kind: 'vanished' }
  if (lookup.kind === 'failed') return { kind: 'unavailable', reason: 'unreadable' }
  const { stat } = lookup
  if (stat.isLink) return { kind: 'unavailable', reason: 'link' }
  if (stat.kind === 'dir') return { kind: 'unavailable', reason: 'directory' }
  if (stat.kind !== 'file') return { kind: 'unavailable', reason: 'not_regular' }
  // Un enlace en cualquier punto de la cadena cambia la ruta real; sin ella, no hay cómo comprobarla.
  if (stat.realPath !== projectionPaths(realRoot).observation(name)) return { kind: 'unavailable', reason: 'link' }
  if (stat.size > MAX_OBSERVATION_BYTES) return { kind: 'unavailable', reason: 'too_large' }
  return { kind: 'readable' }
}

type Json = { [key: string]: unknown }
type Parse<T> = (value: unknown, path: string) => T
class Corrupt extends Error {}
const corrupt = (path: string): never => { throw new Corrupt(path) }
const object: Parse<Json> = (v, p) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Json : corrupt(p))
const text: Parse<string> = (v, p) => (typeof v === 'string' && v.trim() !== '' ? v : corrupt(p))
const integer: Parse<number> = (v, p) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : corrupt(p))
const flag: Parse<boolean> = (v, p) => (typeof v === 'boolean' ? v : corrupt(p))
const array: Parse<unknown[]> = (v, p) => (Array.isArray(v) ? v : corrupt(p))
const nullableText: Parse<string | null> = (v, p) => (v === null ? null : text(v, p))
const oneOf = <T extends string>(values: readonly T[]): Parse<T> => (v, p) =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? v as T : corrupt(p)
const reason: Parse<Reason> = (v, p) => {
  const o = object(v, p)
  return { code: text(o.code, `${p}.code`), detail: text(o.detail, `${p}.detail`) }
}
/** Un valor desconocido lleva su causa, y uno conocido no la admite. */
const observed = <T>(parse: Parse<T>): Parse<Observed<T>> => (v, p) => {
  const o = object(v, p)
  if (o.value === null) return { value: null, reason: reason(o.reason, `${p}.reason`) }
  if (o.reason !== null) corrupt(`${p}.reason`)
  return { value: parse(o.value, `${p}.value`), reason: null }
}
/** La disponibilidad coincide con su causa: solo lo disponible no la lleva. */
const availability = <A extends string>(values: readonly A[], o: Json, p: string): { availability: A; reason: Reason | null } => {
  const value = oneOf(values)(o.availability, `${p}.availability`)
  const why = o.reason === null ? null : reason(o.reason, `${p}.reason`)
  if ((value === 'available') !== (why === null)) corrupt(`${p}.reason`)
  return { availability: value, reason: why }
}
const entity = (o: Json, p: string): Entity => ({ id: text(o.id, `${p}.id`), ...availability(['available', 'unavailable'] as const, o, p) })
const collection = <T extends Entity>(item: Parse<T>): Parse<Collection<T>> => (v, p) => {
  const o = object(v, p)
  const head = availability(['available', 'partial', 'unavailable'] as const, o, p)
  const items = array(o.items, `${p}.items`).map((x, i) => item(x, `${p}.items[${i}]`))
  // Una colección no disponible no es un inventario, y una disponible no esconde entidades ilegibles.
  if (head.availability === 'unavailable' && items.length) corrupt(`${p}.items`)
  if (head.availability === 'available' && items.some((x) => x.availability !== 'available')) corrupt(p)
  if (new Set(items.map((x) => x.id)).size !== items.length) corrupt(`${p}.items`)
  return { ...head, items }
}

const state = oneOf<RunState>(['launching', 'running', 'done', 'failed', 'launch_failed', 'timeout', 'cancelled', 'delegated', 'unavailable', 'cessation_uncertain'])
const open = oneOf<OpenReason>(['running', 'undelivered', 'native_pending', 'native_unconfirmed', 'review_pending'])
const jobs: Parse<number> = (v, p) => array(v, p).map((job, i) => text(object(job, `${p}[${i}]`).key, `${p}[${i}].key`)).length
const progress: Parse<ProjectionProgress> = (v, p) => {
  const o = object(v, p)
  const result: ProjectionProgress = {
    phase: oneOf(['review', 'refutation'] as const)(o.phase, `${p}.phase`), round: integer(o.round, `${p}.round`), launch: integer(o.launch, `${p}.launch`),
    retained: jobs(o.retained, `${p}.retained`), completed: jobs(o.completed, `${p}.completed`), total: integer(o.total, `${p}.total`),
    active: observed((a, q) => {
      const job = object(a, q)
      return { key: text(job.key, `${q}.key`), reviewer: observed(text)(job.reviewer, `${q}.reviewer`), batch: observed(integer)(job.batch, `${q}.batch`) }
    })(o.active, `${p}.active`),
  }
  array(o.planned, `${p}.planned`).forEach((key, i) => text(key, `${p}.planned[${i}]`))
  if (result.retained + result.completed > result.total) corrupt(`${p}.total`)
  return result
}
const run: Parse<ProjectionRun> = (v, p) => {
  const o = object(v, p)
  return { ...entity(o, p), kind: observed(oneOf<RunKind>(['worker', 'native', 'review']))(o.kind, `${p}.kind`), state: observed(state)(o.state, `${p}.state`),
    open: observed(open)(o.open, `${p}.open`), session: observed(text)(o.session, `${p}.session`), flow: observed(text)(o.flow, `${p}.flow`),
    live: observed(flag)(o.live, `${p}.live`), progress: observed(progress)(o.progress, `${p}.progress`),
    ...(o.session_family === undefined ? {} : { session_family: observed(oneOf<'claude' | 'codex'>(['claude', 'codex']))(o.session_family, `${p}.session_family`) }),
    ...(o.delivery === undefined ? {} : { delivery: observed((v, q) => {
      const d = object(v, q)
      return { round: d.round === null ? null : integer(d.round, `${q}.round`), launch: d.launch === null ? null : integer(d.launch, `${q}.launch`) }
    })(o.delivery, `${p}.delivery`) }) }
}
const writerItem: Parse<ProjectionWriter> = (v, p) => {
  const o = object(v, p)
  return { ...entity(o, p), state: observed(state)(o.state, `${p}.state`), open: observed(open)(o.open, `${p}.open`),
    session: observed(text)(o.session, `${p}.session`), flow: observed(text)(o.flow, `${p}.flow`), live: observed(flag)(o.live, `${p}.live`) }
}
const flow: Parse<ProjectionFlow> = (v, p) => {
  const o = object(v, p)
  const head = entity(o, p)
  const view = observed((w, q) => {
    const detail = object(w, q)
    const next = object(detail.next, `${q}.next`)
    const tasks = object(detail.tasks, `${q}.tasks`)
    const counts = { total: integer(tasks.total, `${q}.tasks.total`), done: integer(tasks.done, `${q}.tasks.done`),
      pending: integer(tasks.pending, `${q}.tasks.pending`), first_pending: nullableText(tasks.first_pending, `${q}.tasks.first_pending`) }
    if (counts.total !== counts.done + counts.pending || (counts.pending === 0) !== (counts.first_pending === null)) corrupt(`${q}.tasks`)
    const gates = array(detail.gates, `${q}.gates`).map((v, i) => {
      const path = `${q}.gates[${i}]`, gate = object(v, path)
      return { gate: text(gate.gate, `${path}.gate`),
        artifacts: array(gate.artifacts, `${path}.artifacts`).map((a, j) => text(a, `${path}.artifacts[${j}]`)),
        state: oneOf(['pending', 'approved', 'approved_unfingerprinted', 'stale'] as const)(gate.state, `${path}.state`) }
    })
    return { id: text(detail.id, `${q}.id`), next: { step: text(next.step, `${q}.next.step`), gate: next.gate === undefined ? null : text(next.gate, `${q}.next.gate`) },
      gates, tasks: counts, blocked_reasons: array(detail.blocked_reasons, `${q}.blocked_reasons`).map((v, i) => reason(v, `${q}.blocked_reasons[${i}]`)) }
  })(o.view, `${p}.view`)
  if (view.value !== null && view.value.id !== head.id) corrupt(`${p}.view.id`)
  return { ...head, observed_at: integer(o.observed_at, `${p}.observed_at`), status: observed(text)(o.status, `${p}.status`), view }
}
const binding: Parse<ProjectionBinding> = (v, p) => {
  const o = object(v, p)
  return { ...entity(o, p), flow: observed((b, q) => {
    const bound = object(b, q)
    return { id: text(bound.id, `${q}.id`), step: text(bound.step, `${q}.step`), gate: nullableText(bound.gate, `${q}.gate`), at: text(bound.at, `${q}.at`) }
  })(o.flow, `${p}.flow`) }
}

function documentOf(doc: Json, name: string): ProjectionDocument {
  const checkout = object(doc.checkout, 'checkout')
  const root = text(checkout.root, 'checkout.root')
  if (!root.startsWith('/')) corrupt('checkout.root')
  const observation = object(doc.observation, 'observation')
  const m0 = text(observation.m0, 'observation.m0')
  const boot = text(observation.boot, 'observation.boot')
  if (!/^\d{20}$/.test(m0)) corrupt('observation.m0')
  if (!BOOT_ID.test(boot)) corrupt('observation.boot')
  const pid = integer(object(observation.publisher, 'observation.publisher').pid, 'observation.publisher.pid')
  // La observación se identifica con el nombre del archivo que la guarda: copiada a otro nombre, no pasa.
  const own = observationName(name)
  if (observation.id !== name || own === null || own.m0 !== m0 || own.boot !== boot || own.pid !== pid) corrupt('observation.id')
  const writer = object(doc.writer, 'writer')
  const writerHead = availability(['available', 'unavailable'] as const, writer, 'writer')
  const item = writer.item === null ? null : writerItem(writer.item, 'writer.item')
  if (writerHead.availability === 'unavailable' && item !== null) corrupt('writer.item')
  array(doc.omissions, 'omissions')
  return {
    // Una extensión de avisos ausente o incompatible (también una versión que no es un entero) no invalida la
    // presentación: solo deja el documento sin avisos.
    schema_version: SCHEMA_VERSION, ...(doc.notifications_version === 1 ? { notifications_version: 1 } : {}),
    checkout: { id: text(checkout.id, 'checkout.id'), root },
    observation: { id: name, m0, boot, pid, observed_at: integer(observation.observed_at, 'observation.observed_at'),
      read_finished_at: integer(observation.read_finished_at, 'observation.read_finished_at') },
    runs: collection<ProjectionRun>((v, p) => {
      if (doc.notifications_version === 1) return run(v, p)
      const { session_family: _family, delivery: _delivery, ...presentation } = object(v, p)
      return run(presentation, p)
    })(doc.runs, 'runs'), writer: { ...writerHead, item },
    flows: collection(flow)(doc.flows, 'flows'), bindings: collection(binding)(doc.bindings, 'bindings'),
  }
}

export type ParsedObservation = { kind: 'valid'; document: ProjectionDocument } | { kind: 'unavailable'; reason: 'corrupt' | 'incompatible_version' | 'foreign_checkout' }

/** Solo se llama con el documento de una lectura valid actual, nunca con la memoria visual retenida. */
export function notificationObservation(document: ProjectionDocument): NotificationObservation {
  return { checkout: document.checkout, valid: true, current: true, compatible: document.notifications_version === 1,
    complete: document.runs.availability === 'available' && document.writer.availability === 'available'
      && document.flows.availability === 'available' && document.bindings.availability === 'available' }
}

/**
 * Interpreta el texto de la observación `name`, leída bajo la ruta real `realRoot`. Valida la versión antes que la
 * forma, así una versión que el mod no entiende se ve como incompatible y no como corrupta; después, la forma de lo
 * que usa la banda y que la observación sea de este checkout.
 */
export function parseObservation(source: string, name: string, realRoot: string): ParsedObservation {
  let doc: unknown
  try {
    doc = JSON.parse(source)
  } catch {
    return { kind: 'unavailable', reason: 'corrupt' }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { kind: 'unavailable', reason: 'corrupt' }
  const version = (doc as Json).schema_version
  if (version !== SCHEMA_VERSION) {
    return { kind: 'unavailable', reason: typeof version === 'number' && Number.isSafeInteger(version) ? 'incompatible_version' : 'corrupt' }
  }
  let document: ProjectionDocument
  try {
    document = documentOf(doc as Json, name)
  } catch (e) {
    if (e instanceof Corrupt) return { kind: 'unavailable', reason: 'corrupt' }
    throw e
  }
  return document.checkout.root === projectionPaths(realRoot).root ? { kind: 'valid', document } : { kind: 'unavailable', reason: 'foreign_checkout' }
}

/** Una corrida viva para la antigüedad: su motivo de apertura es `running`, o es un writer en `cessation_uncertain`. */
const liveRun = (run: ProjectionRun | ProjectionWriter): boolean => run.live.value === true || run.open.value === 'running'
const liveWriter = (writer: ProjectionWriter): boolean => liveRun(writer) || writer.state.value === 'cessation_uncertain'

interface Candidate { run: ProjectionRun | ProjectionWriter; writer: boolean; kind: RunKind | null; progress: ProjectionProgress | null }

/** Dentro de un grupo: el writer en vuelo, la revisión en ejecución, otro worker en ejecución y los pendientes. */
function rank(candidate: Candidate): number {
  if (candidate.writer) return 0
  if (candidate.run.open.value !== 'running') return 3
  return candidate.kind === 'review' ? 1 : 2
}
const byRank = (a: Candidate, b: Candidate): number => rank(a) - rank(b) || compare(a.run.id, b.run.id)

/**
 * Elige lo que muestra la banda para `session`: el flujo ligado y su paso, y una sola actividad propia. Primero van
 * las asociadas al flujo ligado; sin ellas, cualquiera propia con su asociación real. No se atribuye a la sesión una
 * corrida sin sesión registrada ni una de otra sesión. Sin liga ni actividad, el estado vacío solo vale si la
 * observación permite afirmarlo.
 */
function sessionCandidates(document: ProjectionDocument, session: string) {
  const { runs, writer, flows, bindings } = document
  const own = bindings.items.find((item) => item.id === session)
  // Una liga ilegible, o un almacén de ligas no disponible, no permite afirmar que la sesión no tiene flujo.
  const bindingKnown = own === undefined ? bindings.availability === 'available'
    : own.availability === 'available' && (own.flow.value !== null || own.flow.reason.code === 'unbound')
  const bound = own?.availability === 'available' ? own.flow.value : null
  let flowView: BandFlow | null = null
  if (bound) {
    const observed = flows.items.find((item) => item.id === bound.id && item.availability === 'available')?.view.value
    flowView = observed ? { id: bound.id, step: observed.next.step, gate: observed.next.gate, source: 'flow' }
      : { id: bound.id, step: bound.step, gate: bound.gate, source: 'binding' }
  }

  // El writer sale de su control protegido: su corrida visible puede faltar o estar alterada.
  const protectedWriter = writer.item?.availability === 'available' ? writer.item : null
  const candidates: Candidate[] = runs.items
    .filter((item) => item.availability === 'available' && item.id !== protectedWriter?.id && item.session.value === session)
    .map((item) => ({ run: item, writer: false, kind: item.kind.value, progress: item.progress.value }))
  if (protectedWriter && protectedWriter.session.value === session) {
    candidates.push({ run: protectedWriter, writer: true, kind: runs.items.find((item) => item.id === protectedWriter.id)?.kind.value ?? null, progress: null })
  }
  return { own, bindingKnown, bound, flowView, candidates, protectedWriter }
}


/** Inventario propio completo antes de cualquier recorte de dibujo. */
export function selectSession(document: ProjectionDocument, session: string): SessionSelection {
  const { own, bindingKnown, bound, flowView, candidates, protectedWriter } = sessionCandidates(document, session)
  const unknownKind: Observed<RunKind> = { value: null, reason: { code: 'not_recorded', detail: 'La clase no está registrada.' } }
  return {
    binding: { availability: document.bindings.availability, reason: own?.reason ?? own?.flow.reason ?? document.bindings.reason, known: bindingKnown, flow: flowView },
    flow: bound ? document.flows.items.find((item) => item.id === bound.id) ?? null : null,
    runs: { availability: document.runs.availability, reason: document.runs.reason,
      items: candidates.sort(byRank).map((candidate) => ({ run: candidate.run, writer: candidate.writer,
        kind: document.runs.items.find((run) => run.id === candidate.run.id)?.kind ?? unknownKind })) },
    omitted: document.runs.items.filter((run) => run.id !== protectedWriter?.id && run.session.value === null).length
      + (protectedWriter?.session.value === null ? 1 : 0),
    writerAvailability: document.writer.availability,
  }
}

export function selectBand(document: ProjectionDocument, session: string): BandSelection {
  const { runs, writer } = document
  const { bindingKnown, bound, flowView, candidates, protectedWriter } = sessionCandidates(document, session)
  const ofFlow = bound ? candidates.filter((candidate) => candidate.run.flow.value === bound.id) : []
  const chosen = (ofFlow.length ? ofFlow : candidates).sort(byRank)[0] ?? null

  const live = runs.items.some((item) => item.availability === 'available' && liveRun(item)) || (protectedWriter !== null && liveWriter(protectedWriter))
  const incomplete = !bindingKnown || runs.availability !== 'available' || writer.availability !== 'available'
  const { id: observation, observed_at: observedAt } = document.observation
  if (flowView === null && chosen === null) {
    return incomplete ? { kind: 'unavailable', reason: 'inventory_unavailable' } : { kind: 'empty', observation, observedAt, live }
  }
  return { kind: 'band', observation, observedAt, live, flow: flowView, activity: chosen && activityOf(chosen, bound?.id ?? null), incomplete }
}

function activityOf(candidate: Candidate, boundFlow: string | null): BandActivity {
  const { run, writer, kind, progress } = candidate
  const flowId = run.flow.value
  const association: BandActivity['association'] = flowId === null ? { kind: 'none', reason: run.flow.reason.code }
    : flowId === boundFlow ? { kind: 'bound' } : { kind: 'flow', id: flowId }
  const active = progress?.active.value ?? null
  return {
    id: run.id, role: writer ? 'writer' : kind, state: run.state.value, open: run.open.value,
    uncertain: writer && run.state.value === 'cessation_uncertain', association,
    progress: progress === null ? null : { phase: progress.phase, round: progress.round, launch: progress.launch, done: progress.retained + progress.completed,
      total: progress.total, reviewer: active?.reviewer.value ?? null, batch: active?.batch.value ?? null },
  }
}

/**
 * Cómo terminó un refresco: una observación válida, una no disponible, los intentos agotados porque las elegidas
 * desaparecían (o `live/` faltaba o estaba vacío) en cada listado, o una lectura trabada que sigue sin terminar.
 */
export type ReadOutcome = { kind: 'valid'; document: ProjectionDocument } | { kind: 'unavailable'; reason: Unavailable } | { kind: 'exhausted' } | { kind: 'stalled' }

export function refreshViews(outcome: ReadOutcome, identity: Identity, current: SessionViews | undefined, now: number): SessionViews {
  if (outcome.kind === 'valid') return { identity, observedAt: outcome.document.observation.observed_at, readAt: now,
    retained: false, selection: selectSession(outcome.document, identity.session) }
  if (outcome.kind === 'exhausted' || outcome.kind === 'stalled') {
    if (current?.selection && sameIdentity(current.identity, identity)) return { ...current, readAt: now, retained: true }
  }
  const invalid = outcome.kind === 'unavailable' && ['corrupt', 'incompatible_version', 'foreign_checkout', 'link', 'directory', 'not_regular', 'not_directory', 'too_large'].includes(outcome.reason)
  return { identity, observedAt: null, readAt: now, retained: false, selection: null,
    unavailable: current && !sameIdentity(current.identity, identity) ? 'identity_changed' : invalid ? 'invalid' : 'projection_unavailable' }
}

function present(selection: BandSelection, lastRead: boolean, now: number): BandPresentation {
  if (selection.kind === 'unavailable') return { kind: 'unavailable', reason: selection.reason }
  const elapsed = now - selection.observedAt
  // La antigüedad no deduce avance ni cierre: solo dice hace cuánto se observó.
  const ageMs = selection.live && elapsed > STALE_AFTER_MS ? elapsed : null
  if (selection.kind === 'empty') return { kind: 'empty', lastRead, ageMs }
  return { kind: 'band', flow: selection.flow, activity: selection.activity, incomplete: selection.incomplete, lastRead, ageMs }
}

/** Si dos lecturas son de la misma sesión y del mismo checkout. */
export const sameIdentity = (a: Identity, b: Identity): boolean => a.session === b.session && a.root === b.root

/**
 * Un refresco: devuelve lo que se dibuja y la memoria que queda. Una lectura válida es la actual. Una proyección no
 * disponible retira los datos anteriores. Con los intentos agotados, o con una lectura trabada, se conserva la última
 * lectura válida de la misma identidad, marcada como tal; sin ella, la información queda no disponible. `now` es
 * `$.clock.now()`.
 */
export function refreshBand(outcome: ReadOutcome, identity: Identity, memory: BandMemory | null, now: number): { band: BandPresentation; memory: BandMemory | null } {
  if (outcome.kind === 'valid') {
    const selection = selectBand(outcome.document, identity.session)
    return { band: present(selection, false, now), memory: { identity, selection } }
  }
  if (outcome.kind === 'unavailable') return { band: { kind: 'unavailable', reason: outcome.reason }, memory: null }
  const last = memory !== null && sameIdentity(memory.identity, identity) ? memory : null
  return { band: last ? present(last.selection, true, now) : { kind: 'unavailable', reason: 'missing' }, memory: last }
}
