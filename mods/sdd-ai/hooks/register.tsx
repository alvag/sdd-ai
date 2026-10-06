import type { EngineInterface, MatchedHook, Register, Timer } from 'claude-code'
import type { BandState, Identity, NotificationAvailability, NotificationCoordinatorState, PersistedCache, PersistedEntry, SessionViews, Summary } from '../types'
import { bandTree } from './band'
import { recognizeCommand } from './command'
import { parseOutput } from './output'
import { panelTree, runsTree } from './panel'
import { eligiblePersisted, lexicalPersistedPath, persistedContentFits, physicalPersistedPath, projectsRoot } from './persisted-output'
import { directoryProblem, FLOODED_PAUSE_MS, isAbsence, judgeStat, LIST_ATTEMPTS, listingOf, notificationObservation, parseObservation, projectionPaths, refreshBand, refreshViews, sameIdentity } from './projection'
import type { Lookup, ProjectionDocument, ProjectionRun, ReadOutcome } from './projection'
import { eligibleResult, evaluateSignal, mayAttempt, mayRecover, OBSERVATION_INTERVAL_MS, resultKey, safeSegment, sameRecipient, selectRecipient, transitionNotification, validNotificationRecord } from './notification'
import type { NotificationAssociation, NotificationRecord, NotificationSignal, RecipientIdentity, RecipientSelection, RoutingInput, SignalObservation } from './notification'
import { RESULT_INDENT, UNMEASURED_COLUMNS, groupTree, originalTree, summaryTree, textCost, treeFits } from './render'

/** El estado de la banda: lo escribe solo el refresco y lo lee el dibujo, que así se redibuja con cada cambio. */
const BAND = { plugin: 'sdd-ai-mod', key: 'band' } as const
const VIEWS = { plugin: 'sdd-ai-mod', key: 'views' } as const
const PANEL_ID = 'sdd-panel'
const RUNS_ID = 'sdd-runs'
const PERSISTED = { plugin: 'sdd-ai-mod', key: 'persisted' } as const
const load = `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
const observedCalls = new Map<string, Identity>()
const persistedAttempts = new Set<string>()
let persistedCache: PersistedCache = { load, entries: {} }
let persistedWrites: Promise<void> = Promise.resolve()
let persistedStarted = false
function savePersisted($: EngineInterface, id?: string, entry?: PersistedEntry): Promise<void> {
  if (id !== undefined && entry !== undefined) persistedCache = { load, entries: { ...persistedCache.entries, [id]: entry } }
  const snapshot = persistedCache
  const saved = persistedWrites.catch(() => {}).then(async () => {
    if (id === undefined) {
      await $.state.set(PERSISTED, snapshot)
      return
    }
    // Compare-and-set: si otra carga escribió entre la lectura y la escritura, la versión ya no coincide y esta
    // escritura no restaura una caché ajena.
    const current = await $.state.get(PERSISTED)
    if (current.value?.load !== load) throw new Error('La caché pertenece a otra carga')
    const written = await $.state.set(PERSISTED, snapshot, { ifVersion: current.version })
    if (!written.isSet) throw new Error('Otra carga escribió la caché')
  })
  persistedWrites = saved
  return saved
}
function startPersisted($: EngineInterface): void {
  if (persistedStarted) return
  persistedStarted = true
  // Si la inicialización falla, la siguiente llamada la reintenta; los intentos ya consumidos no se repiten.
  void savePersisted($).catch(() => { persistedStarted = false })
}
async function readPersisted($: EngineInterface, id: string, response: unknown): Promise<void> {
  const eligible = eligiblePersisted(response, observedCalls.has(id))
  if (!eligible || persistedAttempts.has(id)) return
  persistedAttempts.add(id)
  let identity: Identity | undefined
  try {
    const original = observedCalls.get(id)!
    if (original.session !== await $.session.id() || original.root !== await $.session.root()) throw new Error('La llamada pertenece a otra identidad')
    identity = (await identify($)).identity
    await savePersisted($, id, { identity, path: eligible.path, status: 'pending' })
    if (!lexicalPersistedPath(eligible.path)) throw new Error('Forma de ruta no permitida')
    const config = await $.env.get('CLAUDE_CONFIG_DIR')
    const root = projectsRoot(config, config ? undefined : await $.env.get('HOME'))
    if (!root) throw new Error('Directorio de proyectos no disponible')
    const rootStat = await $.fs.stat(root, { resolve: true })
    if (rootStat.kind !== 'dir' || !rootStat.realPath?.startsWith('/') || rootStat.realPath.split('/').includes('..')) throw new Error('Raíz real de proyectos no disponible')
    const fileStat = await $.fs.stat(eligible.path, { resolve: true })
    if (!physicalPersistedPath(rootStat, fileStat)) throw new Error('Ruta real o tamaño no permitido')
    const content = await $.fs.read(eligible.path)
    if (!persistedContentFits(content)) throw new Error('Contenido mayor de 1 MiB')
    const output = parseOutput(eligible.output, eligible.isErrored, content)
    if (output.kind !== 'summary' || !sameIdentity(identity, (await identify($)).identity)) throw new Error('Resumen no disponible para esta identidad')
    await savePersisted($, id, { identity, path: eligible.path, status: 'summary', summary: output.summary, isErrored: eligible.isErrored })
  } catch {
    if (identity) await savePersisted($, id, { identity, path: eligible.path, status: 'unavailable' }).catch(() => {})
  }
}
let commands: Promise<void> | null = null
function registerCommands($: EngineInterface): void {
  if (commands !== null) return
  commands = (async () => {
    await $.command.register({ name: PANEL_ID, description: 'Muestra el flujo y los pendientes de esta sesión.', immediate: true })
    await $.command.register({ name: RUNS_ID, description: 'Muestra las corridas abiertas de esta sesión.', immediate: true })
  })().catch(() => { commands = null })
}
/** Cada cuánto se relee la proyección: deja margen dentro de los cinco segundos que tiene un cambio para verse. */
const REFRESH_MS = OBSERVATION_INTERVAL_MS
/**
 * Una lectura que lleva más que esto se da por trabada: la banda deja de mostrar como actual lo que leyó antes, y la
 * respuesta tardía de la trabada se descarta. La lectura siguiente arranca recién cuando la trabada termina: las
 * lecturas nunca se superponen ni se acumulan. Mientras sigue trabada, cada período vuelve a consultar la identidad:
 * si cambió, la banda retira enseguida los datos de la anterior.
 */
const READ_STALL_MS = 10_000
const NOTIFICATION = { plugin: 'sdd-ai-mod', key: 'notification' } as const
let availability: NotificationAvailability = { known: false, working: false, question: false, draft: false }
let availabilityVersion = 0
let questions = 0
/** Si la banda vio una encuesta en su último dibujo: una pregunta cuenta igual venga de AskUserQuestion o de la banda. */
let surveyShown = false
function captureAvailability(next: NotificationAvailability): void {
  if (JSON.stringify(next) !== JSON.stringify(availability)) availabilityVersion++
  availability = next
}
interface Submission { record: NotificationRecord; lastAt: number; settled: boolean; response?: unknown; failed?: boolean }
interface Notifier { state: NotificationCoordinatorState; submissions: Map<string, Submission>; degraded: boolean }
let notifier: Notifier | null = null

const observeCall: MatchedHook<'tool.call', { tool: 'Bash' }> = async ($, e, next) => {
  startPersisted($)
  // La atribución se guarda antes de continuar, así está cuando se dibuja el resultado. Un fallo del reconocimiento o del
  // estado se descarta: un error de la atribución de presentación nunca impide la herramienta. La espera no se acota: la
  // herramienta espera lo que tarde el motor en guardar el estado de la sesión, y el reloj del mod solo sostiene el
  // refresco de la banda sobre el prompt.
  try {
    if (recognizeCommand(e.command).kind === 'recognized') {
      await $.state.set({ plugin: 'sdd-ai-mod', key: 'attribution', id: e.tool_use_id }, { command: e.command })
      observedCalls.set(e.tool_use_id, { session: await $.session.id(), root: await $.session.root() })
    }
  } catch {
    // Sin atribución, el resultado suelto queda nativo.
  }
  const response = await next(e)
  if (eligiblePersisted(response, observedCalls.has(e.tool_use_id))) {
    try { $.clock.after(0, () => { void readPersisted($, e.tool_use_id, response).catch(() => {}) }) } catch { /* Conserva la presentación nativa. */ }
  }
  return response
}

async function currentSummaries($: EngineInterface, calls: readonly { tool_use_id?: string; output?: unknown }[]): Promise<Record<string, Summary>> {
  const cache = (await $.state.get(PERSISTED)).value
  if (cache?.load !== load) return {}
  const session = await $.session.id(), root = await $.session.root()
  const views = (await $.state.get(VIEWS)).value
  const paths = new Map(calls.map(call => [call.tool_use_id, eligiblePersisted({ result: call.output }, true)?.path]))
  return Object.fromEntries(Object.entries(cache.entries).flatMap(([id, entry]) => {
    const original = observedCalls.get(id)
    return entry.status === 'summary' && paths.get(id) === entry.path && original?.session === session && original.root === root
      && (!views || sameIdentity(entry.identity, views.identity)) ? [[id, entry.summary]] : []
  }))
}

const renderOutput: MatchedHook<'ui.render', { component: ['ToolGroup', 'ToolResult'] }> = async ($, e, next) => {
  if (e.surface !== 'terminal') return next(e)
  if (e.component === 'ToolGroup') {
    if (e.props.isExpanded) return next(e)
    let cached: Record<string, Summary> = {}
    try { cached = await currentSummaries($, e.props.calls) } catch { /* Sin caché válida sigue la presentación anterior. */ }
    const tree = groupTree($.ui.resolve(e), e.props.calls, 90_000, e.viewport?.columns, cached)
    return tree && treeFits(tree) ? tree : next(e)
  }
  if (e.component === 'ToolResult' && e.props.tool === 'Bash') {
    let command: string | undefined
    try {
      command = (await $.state.get({ plugin: 'sdd-ai-mod', key: 'attribution', id: e.props.tool_use_id })).value?.command
    } catch {
      return next(e)
    }
    if (command === undefined) return next(e)
    let saved: Summary | undefined
    try { saved = (await currentSummaries($, [e.props]))[e.props.tool_use_id] } catch { /* No recuperar una caché ajena. */ }
    if (saved) {
      const ui = $.ui.resolve(e)
      const { Box } = ui
      const summary = summaryTree(ui, { summary: saved, command, isErrored: e.props.isErrored,
        columns: e.viewport?.columns, available: (e.viewport?.columns ?? UNMEASURED_COLUMNS) - RESULT_INDENT }, SAVED_SUMMARY_BUDGET)
      if (!treeFits(summary)) return next(e)
      const ref = await next(e)
      // El API vigente devuelve un árbol; el core puede dejar en él su nodo engine.
      // Conservarlo entero también respeta un renderer inferior. Admitir la referencia del API anterior.
      const original = typeof ref === 'number' ? { type: 'engine' as const, ref } : ref
      return <Box flexDirection="column">{summary}{original}</Box>
    }
    const output = parseOutput(e.props.output, e.props.isErrored)
    if (output.kind !== 'summary') return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const input = { summary: output.summary, command, isErrored: e.props.isErrored, columns: e.viewport?.columns,
      available: (e.viewport?.columns ?? UNMEASURED_COLUMNS) - RESULT_INDENT }
    let original = originalTree(ui, output.original)
    // Un original que no deja sitio para el resumen mínimo queda en el renderer nativo de debajo.
    // El resumen conserva su propio presupuesto sin duplicar ese texto en el árbol del mod.
    let budget = 90_000 - textCost(original)
    if (textCost(original) + textCost(summaryTree(ui, input, 0)) > 90_000) {
      const ref = await next(e)
      original = typeof ref === 'number' ? { type: 'engine' as const, ref } : ref
      // El motor cuenta el original que dibuja el nodo engine, aunque textCost no lo vea: la misma reserva que una
      // salida guardada.
      budget = SAVED_SUMMARY_BUDGET
    }
    const tree = <Box flexDirection="column">
      {summaryTree(ui, input, budget)}
      {original}
    </Box>
    // Un resultado que el motor no dibujaría (demasiado texto o caracteres de control) queda nativo, con su
    // salida original completa.
    return treeFits(tree) ? tree : next(e)
  }
  return next(e)
}

/**
 * La lectura en curso: su generación, cuándo empezó, la identidad que leyó (cuando ya la sabe), si ya se dio por
 * trabada y, mientras lo está, la identidad que dio la última consulta (`latest`).
 */
interface Reading { generation: number; startedAt: number; identity: Identity | null; stalled: boolean; latest: Identity | null }
/**
 * El refresco de la banda en este entorno del mod. Una recarga descarta el entorno con sus temporizadores, y el
 * arranque siguiente crea otro; el estado de la banda, que guarda el motor, sobrevive. `generation` identifica lo que
 * puede escribir el estado, `reading` es la lectura en curso y `pausedUntil` la espera después de un `live/` inundado.
 * `identifying` y `presenting` dicen si sigue pendiente la consulta de identidad o la presentación de una lectura
 * trabada: nunca hay dos de cada una.
 */
interface Refresh {
  timer: Timer | null; generation: number; reading: Reading | null; pausedUntil: number; identifying: boolean; presenting: boolean
  /** Un ciclo del aviso en curso: nunca hay dos, y uno trabado no detiene la banda. */
  notifying: boolean
}
let refresh: Refresh | null = null
/** Un arranque diferido ya programado desde el dibujo. */
let startScheduled = false

/** Arranca el refresco si este entorno todavía no lo tiene: nunca hay dos. La primera lectura no espera un período. */
function startRefresh($: EngineInterface): void {
  startPersisted($)
  registerCommands($)
  if (refresh !== null) return
  const own: Refresh = { timer: null, generation: 0, reading: null, pausedUntil: 0, identifying: false, presenting: false, notifying: false }
  refresh = own
  try {
    own.timer = $.clock.every(REFRESH_MS, () => void tick($, own))
    $.clock.after(0, () => void tick($, own))
  } catch {
    // Sin temporizadores no hay refresco; el próximo dibujo vuelve a intentar arrancarlo.
    own.timer?.cancel()
    refresh = null
  }
}

/**
 * El arranque diferido, para una sesión que adopta el mod ya abierta o lo recarga sin `session.start`: el dibujo solo
 * programa el temporizador, y el refresco escribe el estado desde él, nunca mientras se dibuja.
 */
function scheduleStart($: EngineInterface): void {
  if (refresh !== null || startScheduled) return
  startScheduled = true
  try {
    $.clock.after(0, () => {
      startScheduled = false
      startRefresh($)
    })
  } catch {
    startScheduled = false
  }
}

const stillCurrent = (own: Refresh, generation: number): boolean => refresh === own && own.generation === generation

/**
 * Un período: lee si no hay otra lectura en curso ni una pausa por inundación. Con una lectura en curso no arranca
 * otra: si pasó `READ_STALL_MS`, solo vuelve a consultar la identidad y actualiza lo que la banda dice de la trabada.
 */
async function tick($: EngineInterface, own: Refresh): Promise<void> {
  if (refresh !== own) return
  let now: number
  try {
    now = await $.clock.now()
  } catch {
    return
  }
  const reading = own.reading
  if (reading !== null) {
    if (now - reading.startedAt >= READ_STALL_MS) await whileStalled($, own, reading)
    return
  }
  if (now < own.pausedUntil) return
  const generation = ++own.generation
  own.reading = { generation, startedAt: now, identity: null, stalled: false, latest: null }
  try {
    await refreshOnce($, own, generation)
  } catch {
    // Un fallo del motor (la sesión o el estado) deja la banda como estaba; el período siguiente vuelve a leer.
  } finally {
    if (own.reading?.generation === generation) own.reading = null
  }
}

/**
 * Un período con una lectura trabada. La primera vez cambia la generación, así la respuesta tardía de la trabada no se
 * escribe. Después vuelve a consultar la identidad y presenta la banda con ella. Una consulta o una presentación que
 * sigue pendiente de un período anterior no se repite: una llamada del motor que no resuelve no acumula otras, y una
 * consulta trabada no impide presentar con la última identidad que se supo.
 */
async function whileStalled($: EngineInterface, own: Refresh, reading: Reading): Promise<void> {
  if (!reading.stalled) {
    reading.stalled = true
    own.generation++
  }
  if (!own.identifying) {
    own.identifying = true
    try {
      reading.latest = (await identify($)).identity
    } catch {
      // Sin la identidad de este período, la banda sigue con la última que se supo.
    } finally {
      own.identifying = false
    }
  }
  if (own.presenting) return
  own.presenting = true
  try {
    await presentStalled($, own, reading)
  } catch {
    // Un fallo del motor deja la banda como estaba; el período siguiente lo vuelve a intentar.
  } finally {
    own.presenting = false
  }
}

/**
 * La banda mientras una lectura sigue trabada. Como con los intentos agotados, conserva la última lectura válida de la
 * identidad actual, marcada como tal, o queda no disponible; en cada período, la antigüedad sigue al reloj. Si la
 * identidad cambió, los datos y la memoria de la anterior se retiran ahora: la banda queda no disponible hasta que la
 * trabada termine y la lectura siguiente sea de la identidad nueva.
 */
async function presentStalled($: EngineInterface, own: Refresh, reading: Reading): Promise<void> {
  const generation = own.generation
  const current = (await $.state.get(BAND)).value
  const identity = reading.latest ?? reading.identity ?? current?.identity
  if (identity === undefined) return
  // Una presentación que llega después de que la trabada terminó, o de que arrancó otra lectura, no se escribe. Tampoco
  // una cuya identidad dejó de ser la vigente mientras esperaba: si otro período ya consultó otra, escribiría los datos
  // de la anterior. Se comprueba después de cada espera.
  const valid = (): boolean => own.reading === reading && stillCurrent(own, generation)
    && sameIdentity(reading.latest ?? reading.identity ?? identity, identity)
  if (!valid()) return
  // La hora de esta presentación, no la del período que la lanzó: la consulta de identidad o el estado pudieron tardar.
  const now = await $.clock.now()
  const { band, memory } = refreshBand({ kind: 'stalled' }, identity, current?.memory ?? null, now)
  const views = (await $.state.get(VIEWS)).value
  if (!valid()) return
  await setViews($, refreshViews({ kind: 'stalled' }, identity, views, now))
  const next: BandState = { identity, presentation: band, memory }
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return
  if (!valid()) return
  await $.state.set(BAND, next)
}

/**
 * La identidad actual: la sesión y la ruta real de su checkout (o la raíz de la sesión, si no lleva a un directorio),
 * con lo que respondió la consulta de esa ruta.
 */
async function identify($: EngineInterface): Promise<{ identity: Identity; rootLookup: Lookup; realRoot: string | null }> {
  const session = await $.session.id()
  const sessionRoot = await $.session.root()
  // La ruta real del checkout: la única consulta fuera de `.sdd-ai/`.
  const rootLookup = await lookup($, sessionRoot, true)
  const rootStat = rootLookup.kind === 'found' ? rootLookup.stat : null
  const realRoot = rootStat?.kind === 'dir' && rootStat.realPath !== undefined ? rootStat.realPath : null
  return { identity: { session, root: realRoot ?? sessionRoot }, rootLookup, realRoot }
}

/**
 * Escribe el detalle de las vistas. Un fallo de esa escritura no frena la banda, que se publica aparte: el panel queda
 * con su lectura anterior y el ciclo siguiente lo reintenta.
 */
async function setViews($: EngineInterface, views: SessionViews): Promise<void> {
  try { await $.state.set(VIEWS, views) } catch { /* La banda sigue; el próximo ciclo vuelve a escribir. */ }
}

/**
 * Una lectura completa: la identidad, la proyección y el estado que se dibuja. Al cambiar la sesión o el checkout, los
 * datos anteriores se retiran antes de leer; una respuesta de una generación vieja no se escribe.
 */
async function refreshOnce($: EngineInterface, own: Refresh, generation: number): Promise<void> {
  const { identity, rootLookup, realRoot } = await identify($)
  // Si esta lectura se traba, la banda sabe de qué identidad era.
  if (own.reading?.generation === generation) own.reading.identity = identity
  const current = (await $.state.get(BAND)).value
  const views = (await $.state.get(VIEWS)).value
  if (views !== undefined && !sameIdentity(views.identity, identity)) {
    const readAt = await $.clock.now()
    if (!stillCurrent(own, generation)) return
    await setViews($, { identity, observedAt: null, readAt, retained: false, selection: null, unavailable: 'identity_changed' })
  }
  if (current !== undefined && current.presentation !== null && !sameIdentity(current.identity, identity)) {
    if (!stillCurrent(own, generation)) return
    await $.state.set(BAND, { identity, presentation: null, memory: null })
  }
  const outcome: ReadOutcome = realRoot !== null ? await readProjection($, realRoot)
    : { kind: 'unavailable', reason: rootLookup.kind === 'failed' ? 'unreadable' : 'missing' }
  if (!stillCurrent(own, generation)) return
  const checked = (await identify($)).identity
  if (!stillCurrent(own, generation)) return
  if (!sameIdentity(checked, identity)) {
    const readAt = await $.clock.now()
    if (!stillCurrent(own, generation)) return
    await $.state.set(BAND, { identity: checked, presentation: null, memory: null })
    await setViews($, { identity: checked, observedAt: null, readAt, retained: false, selection: null, unavailable: 'identity_changed' })
    return
  }
  const now = await $.clock.now()
  // Después de un listado de más de 256 entradas, no se vuelve a listar enseguida: el siguiente publicador lo aparta.
  if (outcome.kind === 'unavailable' && outcome.reason === 'flooded') own.pausedUntil = now + FLOODED_PAUSE_MS
  // El aviso usa únicamente esta lectura actual, antes de omitir una escritura visual idéntica. Corre aparte: la banda
  // no espera al aviso, y un aviso trabado no lanza otro.
  if (outcome.kind === 'valid' && outcome.document.notifications_version === 1 && !own.notifying) {
    own.notifying = true
    void notifyOnce($, own, identity, outcome.document, now).catch(() => { /* El ciclo siguiente lo vuelve a intentar. */ })
      .finally(() => { own.notifying = false })
  }
  const { band, memory } = refreshBand(outcome, identity, current?.memory ?? null, now)
  if (!stillCurrent(own, generation)) return
  await setViews($, refreshViews(outcome, identity, views, now))
  const next: BandState = { identity, presentation: band, memory }
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return
  if (!stillCurrent(own, generation)) return
  await $.state.set(BAND, next)
}

/**
 * El `stat` de una ruta: lo que encontró, su ausencia (el motor la rechaza con `ENOENT`) o cualquier otro fallo de la
 * consulta, que no es una desaparición.
 */
async function lookup($: EngineInterface, path: string, resolve = false): Promise<Lookup> {
  try {
    return { kind: 'found', stat: await $.fs.stat(path, { resolve }) }
  } catch (error) {
    return isAbsence(error, path) ? { kind: 'absent' } : { kind: 'failed' }
  }
}

/**
 * Lee la observación más nueva de `live/` bajo la ruta real del checkout. `.sdd-ai/` y `projection/` tienen que ser
 * directorios. Un `live/` ausente o sin observaciones, y una elegida que desaparece, se reintentan: primero con las
 * siguientes del mismo listado y después volviendo a listar, hasta `LIST_ATTEMPTS` listados. Solo una ausencia es
 * una desaparición: una consulta, un listado o una lectura que fallan por otro motivo, y una elegida que existe y no
 * sirve, dejan la proyección no disponible, sin caer a una anterior. Lista y lee solo dentro de `live/`.
 */
async function readProjection($: EngineInterface, realRoot: string): Promise<ReadOutcome> {
  const paths = projectionPaths(realRoot)
  for (const directory of [paths.store, paths.projection]) {
    const problem = directoryProblem(await lookup($, directory))
    if (problem !== null) return { kind: 'unavailable', reason: problem }
  }
  for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt++) {
    const problem = directoryProblem(await lookup($, paths.live))
    if (problem === 'missing') continue
    if (problem !== null) return { kind: 'unavailable', reason: problem }
    let entries
    try {
      entries = await $.fs.list(paths.live)
    } catch (error) {
      // Un `live/` que otro publicador apartó entre el `stat` y el listado se vuelve a listar.
      if (isAbsence(error, paths.live)) continue
      return { kind: 'unavailable', reason: 'unreadable' }
    }
    const listing = listingOf(entries)
    if (listing.kind === 'flooded') return { kind: 'unavailable', reason: 'flooded' }
    for (const name of listing.names) {
      const path = paths.observation(name)
      const judged = judgeStat(await lookup($, path, true), name, realRoot)
      if (judged.kind === 'vanished') continue
      if (judged.kind === 'unavailable') return { kind: 'unavailable', reason: judged.reason }
      let source: string
      try {
        source = await $.fs.read(path)
      } catch (error) {
        // Si ya no está, la poda se la llevó entre el `stat` y la lectura: se prueba la siguiente.
        if (isAbsence(error, path) || (await lookup($, path)).kind === 'absent') continue
        return { kind: 'unavailable', reason: 'unreadable' }
      }
      const parsed = parseObservation(source, name, realRoot)
      return parsed.kind === 'valid' ? { kind: 'valid', document: parsed.document } : { kind: 'unavailable', reason: parsed.reason }
    }
  }
  return { kind: 'exhausted' }
}

const renderBand: MatchedHook<'ui.render', { component: 'AbovePrompt' }> = async ($, e, next) => {
  // La banda es solo de la terminal: en las demás superficies el sitio queda como está.
  if (e.surface !== 'terminal') return next(e)
  surveyShown = e.props.hasSurvey
  captureAvailability({ ...availability, known: true, working: e.props.isWorking, question: questions > 0 || surveyShown })
  scheduleStart($)
  // Cede ante una encuesta y sin filas. El plegado es del motor: la banda no trae controles propios que lo cambien.
  if (e.props.hasSurvey || e.props.maxRows < 1 || e.props.bodyColumns < 1) return next(e)
  let state: BandState | undefined
  try {
    state = (await $.state.get(BAND)).value
  } catch {
    return next(e)
  }
  if (state === undefined || state.presentation === null) return next(e)
  return bandTree($.ui.resolve(e), state.presentation, e.props.bodyColumns) ?? next(e)
}

/**
 * El presupuesto del resumen de una salida guardada aparte: el motor cuenta contra el límite de 100 000 caracteres
 * el original nativo que dibuja el nodo `engine` de debajo (plan, punto 8), así que se le reservan 30 000.
 */
const SAVED_SUMMARY_BUDGET = 60_000

export const register: Register = (on) => {
  on('command.run', { command: [PANEL_ID, RUNS_ID] }, async ($, e) => {
    startRefresh($)
    const id = e.command
    const pane = (await $.ui.panes()).find(pane => pane.id === id)
    if (pane?.isShown) {
      await $.ui.close({ id })
      return {}
    }
    // Abrir un id que ya está abierto solo lo retitula: un pane abierto detrás de otro se cierra y se vuelve a abrir
    // para que quede al frente, sin pedir el teclado.
    if (pane) await $.ui.close({ id })
    await $.ui.open({ id, title: id === PANEL_ID ? 'sdd-ai · panel' : 'sdd-ai · corridas', closeOnEscape: true })
    return {}
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || (e.requestId !== PANEL_ID && e.requestId !== RUNS_ID)) return next(e)
    scheduleStart($)
    const views = (await $.state.get(VIEWS)).value
    const now = await $.clock.now()
    const { Box, Button } = $.ui.resolve(e)
    const draw = e.requestId === PANEL_ID ? panelTree : runsTree
    return <Box flexDirection="column">
      {draw(views, 90_000 - 'Cerrar'.length, e.props.bodyColumns, now)}
      <Button role="dismiss" onPress={async () => { await $.ui.close({ id: e.requestId! }) }}>Cerrar</Button>
    </Box>
  })
  on('session.start', ($, e, next) => {
    // Una sesión nueva, una recarga o la adopción del mod arrancan el refresco; el dibujo lo arranca si esto no pasó.
    if (e.surface === 'terminal') startRefresh($)
    return next(e)
  })
  on('tool.call', { tool: 'Bash' }, observeCall)
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e, next) => {
    questions++
    captureAvailability({ ...availability, question: true })
    try { return await next(e) } finally {
      questions--
      captureAvailability({ ...availability, question: questions > 0 || surveyShown })
    }
  })
  on('turn.start', (_$, e, next) => {
    captureAvailability({ ...availability, known: true, working: true })
    return next(e)
  })
  on('turn.complete', (_$, e, next) => {
    // La terminación de un subagente no acredita que el turno del conductor esté ocioso.
    if (e.agentId === undefined) captureAvailability({ ...availability, known: true, working: false })
    return next(e)
  })
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.surface === 'terminal') {
      captureAvailability({ ...availability, known: true, working: e.props.isWorking, draft: e.props.isDraft })
      scheduleStart($)
    }
    return next(e)
  })
  on('ui.render', { component: ['ToolGroup', 'ToolResult'] }, renderOutput)
  on('ui.render', { component: 'AbovePrompt' }, renderBand)
}

async function notifierCurrent($: EngineInterface, n: Notifier, identity: Identity): Promise<boolean> {
  if (notifier !== n || !sameIdentity(n.state.identity, identity)) return false
  const state = (await $.state.get(NOTIFICATION)).value
  return state?.schema_version === 1 && state.instance === n.state.instance
    && state.generation === n.state.generation && sameIdentity(state.identity, identity)
}

async function adoptNotifier($: EngineInterface, identity: Identity, now: number): Promise<Notifier> {
  if (notifier !== null && sameIdentity(notifier.state.identity, identity)) return notifier
  const previous = (await $.state.get(NOTIFICATION)).value
  const generation = (previous?.schema_version === 1 && Number.isSafeInteger(previous.generation)
    && previous.generation >= 0 ? previous.generation : 0) + 1
  const state: NotificationCoordinatorState = { schema_version: 1, identity, generation, instance: `${now}-${generation}` }
  await $.state.set(NOTIFICATION, state)
  notifier = { state, submissions: new Map(), degraded: false }
  return notifier
}

const NOTIFICATIONS_DIR = (root: string): string => `${root}/.sdd-ai/hooks/notifications`

/** No sigue enlaces ni acepta rutas físicas distintas. La ausencia solo se permite para crear la señal propia. */
async function signalPath($: EngineInterface, root: string, recipient: RecipientIdentity, create = false): Promise<string | null> {
  if (!safeSegment(recipient.session)) throw new Error('Identidad de señal inválida.')
  let absent = false
  for (const path of [`${root}/.sdd-ai`, `${root}/.sdd-ai/hooks`, NOTIFICATIONS_DIR(root)]) {
    const found = await lookup($, path, true)
    if (found.kind === 'absent') { absent = true; continue }
    if (found.kind !== 'found' || absent || found.stat.kind !== 'dir' || found.stat.isLink || found.stat.realPath !== path) throw new Error('Directorio de señal inseguro.')
  }
  const path = `${NOTIFICATIONS_DIR(root)}/${recipient.family}-${recipient.session}.json`
  if (absent) return create ? path : null
  const found = await lookup($, path, true)
  if (found.kind === 'absent') return create ? path : null
  if (found.kind !== 'found' || found.stat.kind !== 'file' || found.stat.isLink || found.stat.realPath !== path || found.stat.size > 65536) throw new Error('Archivo de señal inseguro.')
  return path
}

/** La hora se toma al leer cada señal: otra sesión la renueva cada segundo y una hora vieja la vería en el futuro. */
async function signalOf($: EngineInterface, document: ProjectionDocument, recipient: RecipientIdentity): Promise<SignalObservation> {
  try {
    const path = await signalPath($, document.checkout.root, recipient)
    if (path === null) return { kind: 'inactive', reason: 'missing' }
    const st = await lookup($, path, true)
    if (st.kind !== 'found') return { kind: 'unknown', reason: 'stat_failed' }
    const content: unknown = JSON.parse(await $.fs.read(path))
    if (await signalPath($, document.checkout.root, recipient) !== path) return { kind: 'unknown', reason: 'path_changed' }
    return evaluateSignal({ checkout: document.checkout, recipient, content, mtimeMs: st.stat.mtimeMs, now: await $.clock.now(), path: 'safe' })
  } catch { return { kind: 'unknown', reason: 'signal_unreadable' } }
}

function associationOf(run: ProjectionRun): NotificationAssociation {
  if (run.flow.value !== null) return { kind: 'known', flow: run.flow.value }
  if (run.flow.reason.code === 'not_recorded') return { kind: 'absent' }
  return { kind: 'unknown', reason: run.flow.reason.code }
}

/** La dueña de una corrida, con la misma regla para la selección y para la operatividad: sin familia no hay dueña. */
function ownerOf(run: ProjectionRun): RecipientIdentity | null {
  return run.session.value !== null && run.session_family?.value ? { family: run.session_family.value, session: run.session.value } : null
}

/** Las candidatas del checkout y sus señales, leídas una sola vez por ciclo para todas las corridas. */
interface Inventory { candidates: RoutingInput['candidates']; complete: boolean; signals: Map<string, SignalObservation> }
async function inventoryOf($: EngineInterface, document: ProjectionDocument, self: RecipientIdentity): Promise<Inventory> {
  let complete = document.bindings.availability === 'available'
  const population = new Set(document.bindings.items.map(b => b.id))
  try {
    // Antes de listar, comprueba los directorios mediante la ruta propia.
    await signalPath($, document.checkout.root, self, true)
    const directory = NOTIFICATIONS_DIR(document.checkout.root)
    const found = await lookup($, directory, true)
    if (found.kind === 'found') {
      for (const entry of await $.fs.list(directory)) {
        // Solo cuentan las señales: un archivo ajeno (un `.DS_Store`, un temporal) no deja el inventario incompleto.
        const [, family, session] = /^(claude|codex)-(.+)\.json$/.exec(entry.name) ?? []
        if (session === undefined) continue
        if (!safeSegment(session) || entry.kind !== 'file' || entry.isLink) { complete = false; continue }
        if (family === 'claude') population.add(session)
      }
    } else if (found.kind !== 'absent') complete = false
  } catch { complete = false }
  const signals = new Map<string, SignalObservation>()
  const candidates: RoutingInput['candidates'] = []
  for (const session of [...population].sort()) {
    const binding = document.bindings.items.find(b => b.id === session)
    const known = binding ? binding.availability === 'available' && (binding.flow.value !== null || binding.flow.reason?.code === 'unbound')
      : document.bindings.availability === 'available'
    const signal = await signalOf($, document, { family: 'claude', session })
    signals.set(`claude-${session}`, signal)
    candidates.push({ recipient: { family: 'claude', session }, signal, flow: binding?.flow.value?.id ?? null, known })
  }
  return { candidates, complete, signals }
}

async function routingOf($: EngineInterface, document: ProjectionDocument, run: ProjectionRun, self: RecipientIdentity, instance: string, inventory: Inventory): Promise<RoutingInput> {
  const owner = ownerOf(run)
  const ownerSignal = owner === null ? { kind: 'unknown' as const, reason: 'owner_unknown' }
    : inventory.signals.get(`${owner.family}-${owner.session}`) ?? await signalOf($, document, owner)
  return { owner, ownerSignal, association: associationOf(run), candidates: inventory.candidates, complete: inventory.complete,
    self: { recipient: self, instance, eligible: eligibleResult(notificationObservation(document), run) !== null } }
}

async function storedRecord($: EngineInterface, key: string, identity: NonNullable<ReturnType<typeof eligibleResult>>, recipient: RecipientIdentity): Promise<NotificationRecord | null> {
  const raw = await $.store.get(key)
  if (raw === undefined) return null
  if (!validNotificationRecord(raw, identity, recipient)) throw new Error('Registro de aviso ilegible.')
  return raw
}

async function writeSignal($: EngineInterface, n: Notifier, identity: Identity, document: ProjectionDocument, operational: boolean, now: number): Promise<void> {
  const recipient: RecipientIdentity = { family: 'claude', session: identity.session }
  const path = await signalPath($, identity.root, recipient, true)
  if (!path || !await notifierCurrent($, n, identity)) return
  const current = await identify($)
  if (!sameIdentity(current.identity, identity) || !await notifierCurrent($, n, identity)
    || await signalPath($, identity.root, recipient, true) !== path) return
  const signal: NotificationSignal = { schema_version: 1, checkout: document.checkout, ...recipient,
    instance: n.state.instance, operational, updated_at: now }
  await $.fs.write(path, JSON.stringify(signal) + '\n')
}

/** Procesa el cierre del intento en el ciclo; una promesa trabada no bloquea renovaciones ni acumula solicitudes. */
async function advanceSubmissions($: EngineInterface, n: Notifier, now: number): Promise<void> {
  for (const [key, submission] of n.submissions) {
    if (!await notifierCurrent($, n, n.state.identity)) return
    // Un intervalo sin observar (proyección no disponible, ciclo largo) cuenta como ocioso solo hasta dos períodos: no
    // se sabe si Claude trabajaba entonces, pero anularlo del todo dejaría el plazo sin vencer si los ciclos se alargan.
    const ms = Math.min(now - submission.lastAt, 2 * OBSERVATION_INTERVAL_MS)
    const event = submission.settled ? submission.failed ? { kind: 'failure' as const } : { kind: 'response' as const, response: submission.response }
      : { kind: 'elapsed' as const, ms, working: !availability.known || availability.working, question: availability.question }
    const next = transitionNotification(submission.record, event, now)
    submission.lastAt = now
    if (!await notifierCurrent($, n, n.state.identity)) return
    if (JSON.stringify(next) !== JSON.stringify(submission.record)) await $.store.set(key, next)
    submission.record = next
    if (submission.settled) n.submissions.delete(key)
  }
}

/**
 * La última comprobación antes de enviar. Primero el prompt y la disponibilidad; después, sobre una lectura nueva de la
 * proyección, que la corrida siga elegible con la misma identidad, que la selección no haya cambiado y que el registro
 * siga `prepared` por esta instancia. Al final, sin esperas, que la disponibilidad no cambió desde que se decidió: un
 * borrador escrito mientras tanto cambia su versión. Después de esto solo se persiste `submitting` y se llama.
 */
async function readyToSubmit($: EngineInterface, n: Notifier, identity: Identity, run: ProjectionRun, key: string,
  selection: RecipientSelection & { kind: 'selected' }, recipient: RecipientIdentity, before: number, valid: () => Promise<boolean>): Promise<'ready' | 'later' | 'stop'> {
  const idle = (): boolean => availability.known && !availability.working && !availability.question && before === availabilityVersion
  const draft = await $.prompt.read()
  if (draft.text !== '' || !idle()) return 'later'
  if (!sameIdentity((await identify($)).identity, identity) || !await valid()) return 'stop'
  const latest = await readProjection($, identity.root)
  if (latest.kind !== 'valid' || latest.document.notifications_version !== 1) return 'later'
  const latestRun = latest.document.runs.items.find(r => r.id === run.id)
  const latestResult = latestRun ? eligibleResult(notificationObservation(latest.document), latestRun) : null
  if (!latestRun || !latestResult || resultKey(latestResult, recipient) !== key
    || latestRun.flow.value !== run.flow.value || latestRun.session.value !== run.session.value
    || latestRun.session_family?.value !== run.session_family?.value) return 'later'
  const inventory = await inventoryOf($, latest.document, recipient)
  const latestSelection = selectRecipient(await routingOf($, latest.document, latestRun, recipient, n.state.instance, inventory))
  if (latestSelection.kind !== 'selected' || !sameRecipient(latestSelection.recipient, recipient)
    || latestSelection.source !== selection.source || latestSelection.instance !== selection.instance) return 'later'
  const stored = await storedRecord($, key, latestResult, recipient)
  if (stored?.status !== 'prepared' || stored.instance !== n.state.instance) return 'later'
  if (!await signalPath($, identity.root, recipient, true) || !sameIdentity((await identify($)).identity, identity) || !await valid()) return 'stop'
  return idle() ? 'ready' : 'later'
}

/**
 * Un ciclo del aviso. Corre aparte del refresco de la banda: si una operación se traba, la banda sigue y la señal
 * deja de renovarse y vence sola. `valid` no depende de la generación del refresco, que cambia cada segundo, sino de
 * que este entorno y este coordinador sigan vigentes.
 */
async function notifyOnce($: EngineInterface, own: Refresh, identity: Identity, document: ProjectionDocument, now: number): Promise<void> {
  if (!safeSegment(identity.session) || document.checkout.root !== identity.root) return
  const n = await adoptNotifier($, identity, now)
  const valid = async (): Promise<boolean> => refresh === own && await notifierCurrent($, n, identity)
  if (!await valid()) return
  let operational = notificationObservation(document).complete
  const recipient: RecipientIdentity = { family: 'claude', session: identity.session }
  try {
    // Una ruta propia insegura invalida el mecanismo antes de persistir o solicitar avisos.
    if (!await signalPath($, identity.root, recipient, true) || !await valid()) return
    await advanceSubmissions($, n, now)
    let inventory: Inventory | null = null
    for (const run of [...document.runs.items].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!await valid()) return
      const result = eligibleResult(notificationObservation(document), run)
      const mine = run.session.value === identity.session
      const owner = ownerOf(run)
      const owned = owner !== null && sameRecipient(owner, recipient)
      // Una corrida de esta sesión sin familia conocida no se puede avisar: no se acredita operatividad por ella.
      if (run.open.value === 'undelivered' && mine && (owner === null || (owned && result === null))) operational = false
      // Solo se enruta lo que puede llegar a avisarse: un resultado terminal sin recibir.
      if (result === null) continue
      inventory ??= await inventoryOf($, document, recipient)
      const selection = selectRecipient(await routingOf($, document, run, recipient, n.state.instance, inventory))
      const selected = selection.kind === 'selected' && sameRecipient(selection.recipient, recipient)
      if (!owned && !selected) continue
      const key = resultKey(result, recipient)
      let record = await storedRecord($, key, result, recipient)
      if (record?.status === 'submitting' && !n.submissions.has(key)) {
        record = transitionNotification(record, { kind: 'reload' }, now)
        if (!await valid()) return
        await $.store.set(key, record)
      }
      if (record !== null && !mayRecover(record)) operational = false
      if (!selected || selection.kind !== 'selected') continue
      if (!mayAttempt(record, now) || !availability.known || availability.working || availability.question || availability.draft) continue
      const before = availabilityVersion
      record = transitionNotification(record, { kind: 'prepare', identity: result, recipient, instance: n.state.instance }, now)
      if (!await valid()) return
      await $.store.set(key, record)
      const ready = await readyToSubmit($, n, identity, run, key, selection, recipient, before, valid)
      if (ready === 'stop') return
      // Un `prepared` que no llegó a enviarse sigue elegible en el ciclo siguiente.
      if (ready === 'later') continue
      // Desde aquí se persiste `submitting` y se llama. Una recarga entre las dos deja `submitting` sin llamada y se
      // trata como indeterminado, como pide el plan.
      record = transitionNotification(record, { kind: 'submit' }, await $.clock.now())
      await $.store.set(key, record)
      // Solo la vigencia del coordinador: un cambio de disponibilidad ya no frena el envío, que el motor encola hasta
      // que la sesión quede ociosa (sonda V1).
      if (!await valid()) return
      const submission: Submission = { record, lastAt: await $.clock.now(), settled: false }
      n.submissions.set(key, submission)
      const command = run.kind.value === 'review' ? `./bin/sdd-ai review status ${run.id}` : `./bin/sdd-ai wait ${run.id}`
      const launch = run.kind.value === 'review' ? ` (ronda ${result.round}, lanzamiento ${result.launch})` : ''
      // Solo { text }: el origen sigue siendo plugin. La respuesta nunca escribe delivered.json.
      void $.prompt.submit({ text: `sdd-ai: la corrida ${run.id}${launch} terminó sin recibir. Recibe el resultado con ${command}. El aviso no aprueba gates ni decide hallazgos.` }).then(
        response => { submission.response = response; submission.settled = true },
        () => { submission.failed = true; submission.settled = true },
      )
    }
    if (!await valid()) return
    await writeSignal($, n, identity, document, operational, await $.clock.now())
    n.degraded = false
  } catch {
    // Una sola señal degradada por racha de fallos; después no se renueva y vence a los cinco segundos.
    if (n.degraded) return
    n.degraded = true
    try { if (await valid()) await writeSignal($, n, identity, document, false, await $.clock.now()) } catch { /* Se deja vencer. */ }
  }
}
