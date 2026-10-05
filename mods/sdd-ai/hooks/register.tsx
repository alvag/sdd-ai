import type { EngineInterface, MatchedHook, Register, Timer } from 'claude-code'
import type { BandState, Identity } from '../types'
import { bandTree } from './band'
import { recognizeCommand } from './command'
import { parseOutput } from './output'
import { directoryProblem, FLOODED_PAUSE_MS, isAbsence, judgeStat, LIST_ATTEMPTS, listingOf, parseObservation, projectionPaths, refreshBand, sameIdentity } from './projection'
import type { Lookup, ReadOutcome } from './projection'
import { RESULT_INDENT, UNMEASURED_COLUMNS, groupTree, originalTree, summaryTree, treeFits } from './render'

/** El estado de la banda: lo escribe solo el refresco y lo lee el dibujo, que así se redibuja con cada cambio. */
const BAND = { plugin: 'sdd-ai-mod', key: 'band' } as const
/** Cada cuánto se relee la proyección: deja margen dentro de los cinco segundos que tiene un cambio para verse. */
const REFRESH_MS = 1_000
/**
 * Una lectura que lleva más que esto se da por trabada: la banda deja de mostrar como actual lo que leyó antes, y la
 * respuesta tardía de la trabada se descarta. La lectura siguiente arranca recién cuando la trabada termina: las
 * lecturas nunca se superponen ni se acumulan. Mientras sigue trabada, cada período vuelve a consultar la identidad:
 * si cambió, la banda retira enseguida los datos de la anterior.
 */
const READ_STALL_MS = 10_000

const observeCall: MatchedHook<'tool.call', { tool: 'Bash' }> = async ($, e, next) => {
  // La atribución se guarda antes de continuar, así está cuando se dibuja el resultado. Un fallo del reconocimiento o del
  // estado se descarta: un error de la atribución de presentación nunca impide la herramienta. La espera no se acota: la
  // herramienta espera lo que tarde el motor en guardar el estado de la sesión, y el reloj del mod solo sostiene el
  // refresco de la banda sobre el prompt.
  try {
    if (recognizeCommand(e.command).kind === 'recognized') {
      await $.state.set({ plugin: 'sdd-ai-mod', key: 'attribution', id: e.tool_use_id }, { command: e.command })
    }
  } catch {
    // Sin atribución, el resultado suelto queda nativo.
  }
  return next(e)
}

const renderOutput: MatchedHook<'ui.render', { component: ['ToolGroup', 'ToolResult'] }> = async ($, e, next) => {
  if (e.surface !== 'terminal') return next(e)
  if (e.component === 'ToolGroup') {
    if (e.props.isExpanded) return next(e)
    const tree = groupTree($.ui.resolve(e), e.props.calls, e.viewport?.columns)
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
    const output = parseOutput(e.props.output, e.props.isErrored)
    if (output.kind !== 'summary') return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const tree = <Box flexDirection="column">
      {summaryTree(ui, { summary: output.summary, command, isErrored: e.props.isErrored, columns: e.viewport?.columns, available: (e.viewport?.columns ?? UNMEASURED_COLUMNS) - RESULT_INDENT })}
      {originalTree(ui, output.original)}
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
}
let refresh: Refresh | null = null
/** Un arranque diferido ya programado desde el dibujo. */
let startScheduled = false

/** Arranca el refresco si este entorno todavía no lo tiene: nunca hay dos. La primera lectura no espera un período. */
function startRefresh($: EngineInterface): void {
  if (refresh !== null) return
  const own: Refresh = { timer: null, generation: 0, reading: null, pausedUntil: 0, identifying: false, presenting: false }
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
 * Una lectura completa: la identidad, la proyección y el estado que se dibuja. Al cambiar la sesión o el checkout, los
 * datos anteriores se retiran antes de leer; una respuesta de una generación vieja no se escribe.
 */
async function refreshOnce($: EngineInterface, own: Refresh, generation: number): Promise<void> {
  const { identity, rootLookup, realRoot } = await identify($)
  // Si esta lectura se traba, la banda sabe de qué identidad era.
  if (own.reading?.generation === generation) own.reading.identity = identity
  const current = (await $.state.get(BAND)).value
  if (current !== undefined && current.presentation !== null && !sameIdentity(current.identity, identity)) {
    if (!stillCurrent(own, generation)) return
    await $.state.set(BAND, { identity, presentation: null, memory: null })
  }
  const outcome: ReadOutcome = realRoot !== null ? await readProjection($, realRoot)
    : { kind: 'unavailable', reason: rootLookup.kind === 'failed' ? 'unreadable' : 'missing' }
  if (!stillCurrent(own, generation)) return
  const now = await $.clock.now()
  // Después de un listado de más de 256 entradas, no se vuelve a listar enseguida: el siguiente publicador lo aparta.
  if (outcome.kind === 'unavailable' && outcome.reason === 'flooded') own.pausedUntil = now + FLOODED_PAUSE_MS
  const { band, memory } = refreshBand(outcome, identity, current?.memory ?? null, now)
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
    return isAbsence(error) ? { kind: 'absent' } : { kind: 'failed' }
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
      if (isAbsence(error)) continue
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
        if (isAbsence(error) || (await lookup($, path)).kind === 'absent') continue
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

export const register: Register = (on) => {
  on('session.start', ($, e, next) => {
    // Una sesión nueva, una recarga o la adopción del mod arrancan el refresco; el dibujo lo arranca si esto no pasó.
    if (e.surface === 'terminal') startRefresh($)
    return next(e)
  })
  on('tool.call', { tool: 'Bash' }, observeCall)
  on('ui.render', { component: ['ToolGroup', 'ToolResult'] }, renderOutput)
  on('ui.render', { component: 'AbovePrompt' }, renderBand)
}
