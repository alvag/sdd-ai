import type { BandActivity, BandPresentation, OpenReason, Unavailable } from '../types'
import type { TerminalElements } from './render'
import { treeFits } from './render'

// El formato de la banda sobre el prompt: una sola línea ajustada a las columnas que da el motor. Este módulo no
// recibe `$`: arma el texto desde lo que eligió el refresco y deja el árbol listo para dibujar.

/** Lo que separa las partes de la línea. */
export const SEPARATOR = ' · '
/** La marca de un texto cortado. */
export const ELLIPSIS = '…'
/**
 * Cuántos caracteres conserva cada dato antes de armar la línea. Un nombre de flujo o de revisor más largo que esto no
 * entraría en ninguna terminal, y así un dato inflado no llega entero al árbol.
 */
export const FIELD_LIMIT = 200
/** Lo mínimo que se conserva de una parte acortada, sin contar la elipsis; con menos, la parte se quita. */
const MIN_SHORTENED = 3

/**
 * Los rangos que la terminal dibuja en dos columnas: los anchos y de ancho completo de Asia oriental y los emoji que
 * se presentan como tales. Es una aproximación por exceso: un carácter que la terminal dibuja en una columna y aquí
 * cuenta dos solo deja la línea más corta, y para lo que quede afuera el texto se trunca en vez de partirse.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x16ff0, 0x16ff1], [0x17000, 0x18cd5], [0x18d00, 0x18d08], [0x1aff0, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f1e6, 0x1f202],
  [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]
/** Marcas combinantes y caracteres de formato (la unión de emoji y los selectores de variante): no ocupan columna. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u
const ZWJ = 0x200d
const EMOJI_PRESENTATION = 0xfe0f
const isRegionalIndicator = (code: number): boolean => code >= 0x1f1e6 && code <= 0x1f1ff

function wide(code: number): boolean {
  let low = 0
  let high = WIDE.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [from, to] = WIDE[middle]!
    if (code < from) high = middle - 1
    else if (code > to) low = middle + 1
    else return true
  }
  return false
}

/** Un carácter tal como lo ve la terminal: su base con las marcas que se le unen, y las columnas que ocupa. */
interface Cluster { text: string; width: number }

/**
 * Agrupa el texto en caracteres visibles: las marcas combinantes, los selectores de variante y lo que sigue a una
 * unión de emoji se suman al anterior, y dos indicadores regionales forman una bandera. Mide en columnas, nunca por
 * la longitud UTF-16 del texto.
 */
function clusters(text: string): Cluster[] {
  const result: Cluster[] = []
  let joining = false
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const last = result.at(-1)
    if (last !== undefined && (joining || ZERO_WIDTH.test(char))) {
      last.text += char
      // Un selector de presentación emoji ensancha un carácter que se dibujaría en una columna.
      if (code === EMOJI_PRESENTATION && last.width === 1) last.width = 2
      joining = code === ZWJ
      continue
    }
    joining = false
    if (last !== undefined && isRegionalIndicator(code) && last.text.length === 2 && isRegionalIndicator(last.text.codePointAt(0) ?? 0)) {
      last.text += char
      continue
    }
    if (ZERO_WIDTH.test(char)) {
      result.push({ text: char, width: 0 })
      joining = code === ZWJ
      continue
    }
    result.push({ text: char, width: wide(code) ? 2 : 1 })
  }
  return result
}

/** Las columnas que ocupa un texto en la terminal. */
export function displayWidth(text: string): number {
  return clusters(text).reduce((total, cluster) => total + cluster.width, 0)
}

/** El texto en `width` columnas como máximo; si no entra, su principio y la elipsis, sin partir un carácter. */
export function cutToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  if (displayWidth(text) <= width) return text
  let kept = ''
  let used = 0
  for (const cluster of clusters(text)) {
    if (used + cluster.width > width - 1) break
    kept += cluster.text
    used += cluster.width
  }
  return `${kept.trimEnd()}${ELLIPSIS}`
}

/**
 * Un dato listo para la línea: sin caracteres de control, saltos ni controles de dirección del texto, con los
 * espacios juntados en uno, las mitades sueltas de un par sustituto cambiadas por U+FFFD y a lo sumo `limit`
 * caracteres.
 */
export function sanitize(text: string, limit = FIELD_LIMIT): string {
  const clean = text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ')
    .trim()
  const chars = Array.from(clean)
  return chars.length <= limit ? clean : `${chars.slice(0, limit - 1).join('').trimEnd()}${ELLIPSIS}`
}

/**
 * Una parte de la línea. `shorten` dice en qué turno se acorta cuando la línea no entra (1 primero); una parte sin
 * turno no se acorta, y solo la alcanza el corte final.
 */
interface Part { text: string; shorten?: 1 | 2 | 3 | 4 }

const join = (parts: readonly Part[]): string => parts.map((part) => part.text).filter(Boolean).join(SEPARATOR)

/**
 * Ajusta las partes a `columns`. Si no entran, acorta en turnos: primero el nombre del flujo, después la asociación de
 * una actividad ajena al flujo, el revisor y el lote, y la ronda. Cada turno corta su parte con elipsis o, si no le
 * quedan `MIN_SHORTENED` caracteres, la quita. Si ni así entra, la línea entera se corta con elipsis.
 */
function fit(parts: readonly Part[], columns: number): string {
  let current = parts.map((part) => ({ ...part }))
  for (const turn of [1, 2, 3, 4] as const) {
    if (displayWidth(join(current)) <= columns) break
    for (const part of current.filter((candidate) => candidate.shorten === turn)) {
      const overflow = displayWidth(join(current)) - columns
      if (overflow <= 0) break
      const room = displayWidth(part.text) - overflow
      part.text = room > MIN_SHORTENED ? cutToWidth(part.text, room) : ''
    }
    current = current.filter((part) => part.text !== '')
  }
  return cutToWidth(join(current), columns)
}

const UNAVAILABLE: Record<Unavailable, string> = {
  missing: 'sin proyección',
  link: 'la proyección pasa por un enlace',
  not_directory: 'el directorio de la proyección no es un directorio',
  directory: 'la observación es un directorio',
  not_regular: 'la observación no es un archivo regular',
  too_large: 'la observación pasa de 4 MiB',
  flooded: 'demasiadas entradas en live/',
  unreadable: 'no se pudo leer la observación',
  corrupt: 'observación corrupta',
  incompatible_version: 'versión incompatible',
  foreign_checkout: 'la observación es de otro checkout',
  inventory_unavailable: 'la observación no permite saber la actividad',
}

const OPEN: Record<OpenReason, string> = {
  running: 'en curso',
  undelivered: 'sin entregar',
  native_pending: 'despacho pendiente',
  native_unconfirmed: 'despacho sin confirmar',
  review_pending: 'hallazgos por decidir',
}

/** Hace cuánto se observó, en segundos hasta dos minutos, después en minutos y desde dos horas en horas. */
export function ageText(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 120) return `observada hace ${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 120) return `observada hace ${minutes} min`
  return `observada hace ${Math.floor(minutes / 60)} h`
}

/** Las marcas que acompañan a una lectura y que no se acortan: la última lectura conservada y la antigüedad. */
function marks(band: { lastRead: boolean; ageMs: number | null }): Part[] {
  return [...(band.lastRead ? [{ text: 'última lectura' }] : []), ...(band.ageMs === null ? [] : [{ text: ageText(band.ageMs) }])]
}

/** Las partes de una actividad: su clase y estado, su asociación si es ajena al flujo y el avance de una revisión. */
function activityParts(activity: BandActivity): Part[] {
  const progress = activity.progress
  const role = activity.role === 'writer' ? 'writer' : activity.role === 'review' ? (progress?.phase === 'refutation' ? 'refutación' : 'revisión')
    : activity.role === 'native' ? 'nativa' : activity.role === 'worker' ? 'worker' : 'corrida'
  const parts: Part[] = [{ text: role }]
  // El cese incierto es parte de la marca de writer: puede seguir escribiendo, aunque su apertura diga otra cosa.
  if (activity.uncertain) parts.push({ text: 'cese incierto' })
  else if (activity.open !== null && !(activity.open === 'running' && progress !== null)) parts.push({ text: OPEN[activity.open] })
  const association = activity.association
  if (association.kind === 'flow') parts.push({ text: `de ${sanitize(association.id)}`, shorten: 2 })
  // Sin asociación, se dice por qué: ningún registro la tiene, los registros se contradicen o no se pudieron leer.
  if (association.kind === 'none') {
    const why = association.reason === 'not_recorded' ? 'sin flujo registrado' : association.reason === 'association_conflict' ? 'flujo en conflicto' : 'flujo no disponible'
    parts.push({ text: why, shorten: 2 })
  }
  if (progress !== null) {
    parts.push({ text: `ronda ${progress.round}${progress.launch > 1 ? ` (lanzamiento ${progress.launch})` : ''}`, shorten: 4 })
    const who = [progress.reviewer === null ? '' : sanitize(progress.reviewer), progress.batch === null ? '' : `lote ${progress.batch}`].filter(Boolean).join(' ')
    if (who) parts.push({ text: who, shorten: 3 })
    parts.push({ text: `${progress.done}/${progress.total}` })
  }
  return parts
}

/** Las partes de la banda, en el orden en que se leen. */
function bandParts(band: BandPresentation): Part[] {
  if (band.kind === 'unavailable') return [{ text: `sdd-ai: no disponible${SEPARATOR}${UNAVAILABLE[band.reason]}` }]
  if (band.kind === 'empty') return [{ text: 'sdd-ai: sin flujo ligado ni actividad en esta sesión' }, ...marks(band)]
  const parts: Part[] = []
  if (band.flow === null) parts.push({ text: 'sin flujo ligado', shorten: 1 })
  else {
    parts.push({ text: sanitize(band.flow.id), shorten: 1 })
    // Sin la vista observada del flujo, el paso es el que registró la liga, y se dice.
    const gate = band.flow.gate === null ? '' : ` (${sanitize(band.flow.gate)})`
    parts.push({ text: `paso ${sanitize(band.flow.step)}${gate}${band.flow.source === 'binding' ? ' según la liga' : ''}` })
  }
  if (band.activity !== null) parts.push(...activityParts(band.activity))
  if (band.incomplete) parts.push({ text: 'datos parciales' })
  return [...parts, ...marks(band)]
}

/** La línea de la banda en `columns` columnas como máximo; vacía si no hay columnas. */
export function bandLine(band: BandPresentation, columns: number): string {
  return columns < 1 ? '' : fit(bandParts(band), Math.floor(columns))
}

/**
 * El árbol de la banda: un solo Text que no se parte en líneas. Si la medida de columnas no coincide con la de la
 * terminal, el motor trunca el final en vez de pasar a otra línea. `null` si no hay columnas o si el motor rechazaría
 * el árbol; quien dibuja deja entonces el sitio como está.
 */
export function bandTree(ui: TerminalElements, band: BandPresentation, columns: number): JSX.Element | null {
  const line = bandLine(band, columns)
  if (line === '') return null
  const tree = ui.Text({ wrap: 'truncate-end', children: line })
  return treeFits(tree) ? tree : null
}
