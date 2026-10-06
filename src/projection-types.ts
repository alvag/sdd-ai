/** Contrato informativo independiente de los archivos internos y de los lectores del dominio. */
export const PROJECTION_SCHEMA_VERSION = 1
/** La versión de la extensión de avisos. Una ausente o distinta deja la proyección sin avisos, nunca inválida. */
export const NOTIFICATIONS_VERSION = 1
export const PROJECTION_MAX_BYTES = 4 * 1024 * 1024
export const PROJECTION_MAX_ENTRIES = 256
export const OBSERVATION_NAME = /^obs-(\d{20})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)-([0-9a-f]{32})\.json$/
export const TEMPORARY_NAME = /^tmp-(\d{20})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)-([0-9a-f]{32})$/
/** La reserva vacía de un publicador que está leyendo las fuentes: no es una observación. */
export const CLAIM_NAME = /^claim-(\d{20})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)-([0-9a-f]{32})$/

export interface ProjectionReason { code: string; detail: string }
/** `null` nunca significa que se conoce un valor: su causa es obligatoria. */
export type Observed<T> = { value: T; reason: null } | { value: null; reason: ProjectionReason }
export interface ProjectionCollection<T> {
  availability: 'available' | 'partial' | 'unavailable'; reason: ProjectionReason | null; items: T[]
}
export interface ProjectionEntity {
  id: string; availability: 'available' | 'unavailable'; reason: ProjectionReason | null
}
export type ProjectionRunState = 'launching' | 'running' | 'done' | 'failed' | 'launch_failed'
  | 'timeout' | 'cancelled' | 'delegated' | 'unavailable' | 'cessation_uncertain'
export type ProjectionOpenState = 'running' | 'undelivered' | 'native_pending' | 'native_unconfirmed' | 'review_pending'
export interface ProjectionJob {
  round: number; key: string; launch: number; state: ProjectionRunState
  admission: Observed<'admitted' | 'inadmissible'>
}
export interface ProjectionProgress {
  phase: 'review' | 'refutation'; round: number; launch: number
  planned: string[]; retained: ProjectionJob[]; completed: ProjectionJob[]; total: number
  active: Observed<{ key: string; reviewer: Observed<string>; batch: Observed<number> }>
}
export interface ProjectionRun extends ProjectionEntity {
  kind: Observed<'worker' | 'native' | 'review'>; state: Observed<ProjectionRunState>
  open: Observed<ProjectionOpenState>; session: Observed<string>; flow: Observed<string>
  live: Observed<boolean>; progress: Observed<ProjectionProgress>
  session_family?: Observed<'claude' | 'codex'>
  delivery?: Observed<{ round: number | null; launch: number | null }>
}
export interface ProjectionWriter extends ProjectionEntity {
  state: Observed<ProjectionRunState>; open: Observed<ProjectionOpenState>
  session: Observed<string>; flow: Observed<string>; live: Observed<boolean>
}
export interface ProjectionQuestion { header: string; question: string; options: { label: string; description: string }[] }
export interface ProjectionFlowView {
  id: string; depth: 'corta' | 'normal' | 'completa' | null
  gates: { gate: string; artifacts: string[]; state: 'pending' | 'approved' | 'approved_unfingerprinted' | 'stale' }[]
  tasks: { total: number; done: number; pending: number; first_pending: string | null }
  next: { step: string; gate?: string; artifacts?: string[]; task?: string; command?: string; detail?: string; question?: ProjectionQuestion }
  blocked_reasons: ProjectionReason[]; notes: ProjectionReason[]; paths: Record<string, string>
}
export interface ProjectionFlow extends ProjectionEntity {
  observed_at: number; status: Observed<string>; view: Observed<ProjectionFlowView>
}
export interface ProjectionBinding extends ProjectionEntity {
  flow: Observed<{ id: string; step: string; gate: string | null; at: string }>
}
export interface ProjectionObservation {
  id: string; publisher: { pid: number; kind: 'cli' | 'hook' | 'supervisor' | 'unknown' }
  m0: string; boot: string; observed_at: number; read_finished_at: number
}
export interface Projection {
  schema_version: 1; notifications_version?: number; checkout: { id: string; root: string }; observation: ProjectionObservation
  runs: ProjectionCollection<ProjectionRun>
  writer: { availability: 'available' | 'unavailable'; reason: ProjectionReason | null; item: ProjectionWriter | null }
  flows: ProjectionCollection<ProjectionFlow>; bindings: ProjectionCollection<ProjectionBinding>
  omissions: { collection: 'runs' | 'writer' | 'flows' | 'bindings'; count: number; reason: ProjectionReason }[]
}

export const known = <T>(value: T): Observed<T> => ({ value, reason: null })
export const unknown = <T>(code: string, detail: string): Observed<T> => ({ value: null, reason: { code, detail } })
export const available = <T>(items: T[]): ProjectionCollection<T> => ({ availability: 'available', reason: null, items })

type Check = (value: unknown, path: string) => void
class InvalidProjection extends Error {}
const fail = (path: string, detail: string): never => { throw new InvalidProjection(`${path}: ${detail}`) }
const map = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(path, 'debe ser un objeto')
  return value as Record<string, unknown>
}
const text: Check = (v, p) => { if (typeof v !== 'string' || v.trim() === '') fail(p, 'debe ser texto no vacío') }
const integer: Check = (v, p) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(p, 'debe ser un entero seguro no negativo') }
const boolean: Check = (v, p) => { if (typeof v !== 'boolean') fail(p, 'debe ser booleano') }
const oneOf = (values: readonly unknown[]): Check => (v, p) => { if (!values.includes(v)) fail(p, `valor no admitido: ${String(v)}`) }
const nullable = (check: Check): Check => (v, p) => { if (v !== null) check(v, p) }
const list = (check: Check): Check => (v, p) => {
  if (!Array.isArray(v)) return fail(p, 'debe ser una lista')
  v.forEach((x, i) => check(x, `${p}[${i}]`))
}
const object = (fields: Record<string, Check>, optional: readonly string[] = []): Check => (v, p) => {
  const o = map(v, p)
  for (const key of Object.keys(o)) if (!Object.hasOwn(fields, key)) fail(`${p}.${key}`, 'campo no admitido')
  for (const [key, check] of Object.entries(fields)) {
    if (!Object.hasOwn(o, key)) { if (!optional.includes(key)) fail(`${p}.${key}`, 'falta el campo obligatorio') }
    else check(o[key], `${p}.${key}`)
  }
}
const reason = object({ code: text, detail: text })
const observed = (check: Check): Check => (v, p) => {
  object({ value: nullable(check), reason: nullable(reason) })(v, p)
  const o = map(v, p)
  if ((o.value === null) !== (o.reason !== null)) fail(p, 'un valor desconocido requiere una causa y uno conocido no la admite')
}
const entityFields = { id: text, availability: oneOf(['available', 'unavailable']), reason: nullable(reason) }
const availability: Check = (v, p) => {
  const o = map(v, p)
  if ((o.availability === 'available') !== (o.reason === null)) fail(`${p}.reason`, 'la disponibilidad y su causa no coinciden')
}
const entity = (fields: Record<string, Check>, optional: readonly string[] = []): Check => (v, p) => {
  object({ ...entityFields, ...fields }, optional)(v, p)
  availability(v, p)
}
const state = oneOf(['launching', 'running', 'done', 'failed', 'launch_failed', 'timeout', 'cancelled', 'delegated', 'unavailable', 'cessation_uncertain'])
const open = oneOf(['running', 'undelivered', 'native_pending', 'native_unconfirmed', 'review_pending'])
const job = object({ round: integer, key: text, launch: integer, state, admission: observed(oneOf(['admitted', 'inadmissible'])) })
const progress: Check = (v, p) => {
  object({ phase: oneOf(['review', 'refutation']), round: integer, launch: integer, planned: list(text), retained: list(job), completed: list(job), total: integer,
    active: observed(object({ key: text, reviewer: observed(text), batch: observed(integer) })) })(v, p)
  const o = map(v, p)
  const planned = o.planned as string[]
  const retained = o.retained as ProjectionJob[]
  const completed = o.completed as ProjectionJob[]
  if (new Set(planned).size !== planned.length) fail(`${p}.planned`, 'trabajo lógico repetido')
  const all = new Set([...planned, ...retained.map((j) => j.key)])
  if (o.total !== all.size) fail(`${p}.total`, 'debe contar la unión de trabajos conservados y previstos')
  const seen = new Set<string>()
  for (const j of [...retained, ...completed]) {
    if (j.round !== o.round || !all.has(j.key) || seen.has(j.key)) fail(p, 'identidad de trabajo repetida o ajena a la ronda')
    if (j.launch > Number(o.launch)) fail(p, 'un resultado no puede pertenecer a un lanzamiento futuro')
    seen.add(j.key)
  }
  for (const j of retained) if (planned.includes(j.key)) fail(p, 'un trabajo conservado no puede estar previsto para reintento')
  for (const j of completed) if (j.launch !== o.launch || !planned.includes(j.key)) fail(p, 'un resultado nuevo debe pertenecer al lanzamiento y su plan')
  const active = map(o.active, `${p}.active`).value
  if (active !== null && (!planned.includes(map(active, p).key as string) || seen.has(map(active, p).key as string))) fail(`${p}.active`, 'el trabajo activo debe estar pendiente en el plan')
}
const run = entity({ kind: observed(oneOf(['worker', 'native', 'review'])), state: observed(state), open: observed(open), session: observed(text), flow: observed(text), live: observed(boolean), progress: observed(progress),
  session_family: observed(oneOf(['claude', 'codex'])), delivery: observed(object({ round: nullable(integer), launch: nullable(integer) })) }, ['session_family', 'delivery'])
const writer = entity({ state: observed(state), open: observed(open), session: observed(text), flow: observed(text), live: observed(boolean) })
const question = object({ header: text, question: text, options: list(object({ label: text, description: text })) })
const paths: Check = (v, p) => { for (const [key, value] of Object.entries(map(v, p))) text(value, `${p}.${key}`) }
const view: Check = (v, p) => {
  object({ id: text, depth: oneOf(['corta', 'normal', 'completa', null]),
    gates: list(object({ gate: oneOf(['single', 'spec', 'plan-tasks', 'plan', 'tasks']), artifacts: list(text), state: oneOf(['pending', 'approved', 'approved_unfingerprinted', 'stale']) })),
    tasks: object({ total: integer, done: integer, pending: integer, first_pending: nullable(text) }),
    next: object({ step: oneOf(['no_artifacts', 'depth', 'specify', 'branch', 'plan', 'tasks', 'gate', 'external_gate', 'implement', 'verify', 'review_and_commit', 'push', 'open_pr', 'archive', 'resolve_blockers']),
      gate: text, artifacts: list(text), task: text, command: text, detail: text, question }, ['gate', 'artifacts', 'task', 'command', 'detail', 'question']),
    blocked_reasons: list(reason), notes: list(reason), paths })(v, p)
  const tasks = map(map(v, p).tasks, `${p}.tasks`)
  if (Number(tasks.total) !== Number(tasks.done) + Number(tasks.pending)) fail(`${p}.tasks`, 'los conteos no suman el total')
}
const flow: Check = (v, p) => {
  entity({ observed_at: integer, status: observed(text), view: observed(view) })(v, p)
  const o = map(v, p)
  const detail = map(o.view, p).value
  if (detail !== null && map(detail, p).id !== o.id) fail(`${p}.view.id`, 'no coincide con el flujo')
}
const binding = entity({ flow: observed(object({ id: text, step: text, gate: nullable(text), at: text })) })
const collection = (check: Check): Check => (v, p) => {
  object({ availability: oneOf(['available', 'partial', 'unavailable']), reason: nullable(reason), items: list(check) })(v, p)
  availability(v, p)
  const o = map(v, p)
  const items = o.items as ProjectionEntity[]
  if (o.availability === 'unavailable' && items.length !== 0) fail(`${p}.items`, 'una colección no disponible no puede presentarse como inventario')
  if (new Set(items.map((i) => i.id)).size !== items.length) fail(`${p}.items`, 'identidad repetida')
  if (o.availability === 'available' && items.some((i) => i.availability !== 'available')) fail(p, 'una entidad no disponible requiere colección parcial')
}
const decimal: Check = (v, p) => { if (typeof v !== 'string' || !/^\d{20}$/.test(v)) fail(p, 'debe tener 20 dígitos decimales') }
const boot: Check = (v, p) => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) fail(p, 'debe ser el UUID de arranque en minúsculas') }
const checkDocument = object({ schema_version: oneOf([PROJECTION_SCHEMA_VERSION]), notifications_version: integer, checkout: object({ id: text, root: text }),
  observation: object({ id: text, publisher: object({ pid: integer, kind: oneOf(['cli', 'hook', 'supervisor', 'unknown']) }), m0: decimal, boot, observed_at: integer, read_finished_at: integer }),
  runs: collection(run), writer: (v, p) => {
    object({ availability: oneOf(['available', 'unavailable']), reason: nullable(reason), item: nullable(writer) })(v, p)
    availability(v, p)
    const o = map(v, p)
    if (o.availability === 'unavailable' && o.item !== null) fail(`${p}.item`, 'un writer no disponible no puede presentarse como conocido')
  }, flows: collection(flow), bindings: collection(binding),
  omissions: list(object({ collection: oneOf(['runs', 'writer', 'flows', 'bindings']), count: integer, reason })) }, ['notifications_version'])

/** Un avance de revisión según el contrato: el recolector degrada solo esa corrida si no lo cumple. */
export function validProgress(value: unknown): value is ProjectionProgress {
  try {
    progress(value, 'progress')
    return true
  } catch (e) {
    if (e instanceof InvalidProjection) return false
    throw e
  }
}

/** Rechaza campos ajenos al contrato, incluidos contenidos de entrada y salida de los workers. */
export function validateProjection(doc: unknown): { ok: true; document: Projection } | { ok: false; reason: string } {
  try {
    const source = map(doc, 'projection')
    // Una extensión ausente o incompatible (también una versión que no es un entero) no invalida los hechos del
    // contrato de presentación: se quita la extensión entera y se valida y devuelve lo que queda, así ningún campo de
    // la extensión sale sin validar.
    let checked: unknown = doc
    if (source.notifications_version !== NOTIFICATIONS_VERSION) {
      const { notifications_version: _version, ...rest } = source
      checked = rest
      if (typeof rest.runs === 'object' && rest.runs !== null && !Array.isArray(rest.runs)) {
        const runs = rest.runs as Record<string, unknown>
        if (Array.isArray(runs.items)) checked = { ...rest, runs: { ...runs, items: runs.items.map(item => {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
          const { session_family: _family, delivery: _delivery, ...presentation } = item as Record<string, unknown>
          return presentation
        }) } }
      }
    }
    checkDocument(checked, 'projection')
    const document = checked as Projection
    if (!document.checkout.root.startsWith('/')) fail('projection.checkout.root', 'debe ser una ruta absoluta física')
    const match = OBSERVATION_NAME.exec(document.observation.id)
    if (!match || match[1] !== document.observation.m0 || match[2] !== document.observation.boot || Number(match[3]) !== document.observation.publisher.pid) {
      fail('projection.observation.id', 'no coincide con el reloj, el arranque o el publicador')
    }
    // El reloj de pared puede retroceder durante la lectura; no se usa para ordenar observaciones.
    return { ok: true, document }
  } catch (e) {
    if (e instanceof InvalidProjection) return { ok: false, reason: e.message }
    throw e
  }
}
