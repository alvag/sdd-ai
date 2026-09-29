import { DISPATCHABLE_ROLES } from './types.ts'

/** Los umbrales de la ruta directa. El bootstrap y el recordatorio los leen de acá, y de ningún otro lado. */
export interface RouteThresholds {
  /** Archivos para entender desde los que la exploración se delega. */
  exploreMinFiles: number
  /** Archivos no triviales para escribir desde los que la escritura se delega. */
  writerMinFiles: number
  /** Líneas, agregadas más quitadas, por debajo de las cuales la escritura no se delega. */
  minDelegateLines: number
  /** Llamadas, lecturas y ediciones sin delegar desde las que se recuerda delegar. */
  backstop: { calls: number; reads: number; edits: number }
}

export const ROUTE: RouteThresholds = {
  exploreMinFiles: 4,
  writerMinFiles: 2,
  minDelegateLines: 20,
  backstop: { calls: 20, reads: 5, edits: 2 },
}

export type Crossed = 'calls' | 'reads' | 'edits'

/** El writer se nombra como delegable solo si `run` acepta `implement`: los textos siguen al binario. */
const WRITER_DISPATCHABLE = (DISPATCHABLE_ROLES as readonly string[]).includes('implement')

const WRITER_COMMAND = '`./bin/sdd-ai run --role implement --prompt-file <encargo>`'

/** Lo que el contrato del writer le prohíbe tocar: un cambio ahí no se delega. */
const WRITER_FORBIDDEN = '`.git`, `.sdd-ai/`, `.claude/`, `.codex/`, `.agents/` o en archivos que Git ignora'

/** Cómo se delega la exploración: el bootstrap y el recordatorio lo dicen con las mismas palabras. */
function delegateExplore(): string {
  return 'se escribe el encargo en un archivo temporal fuera del repositorio y se corre ' +
    '`./bin/sdd-ai run --role explore --prompt-file <encargo>` con esa ruta'
}

function writerLine(t: RouteThresholds, writerDispatchable: boolean): string {
  const files = `Con ${t.writerMinFiles} o más archivos no triviales para escribir`
  return writerDispatchable
    ? `- ${files}, la escritura se delega con ${WRITER_COMMAND}, con el encargo en un temporal como en la exploración. ` +
      'Lanzar el writer sin permiso previo necesita la misma pregunta que escribir inline. ' +
      `Un cambio en ${WRITER_FORBIDDEN} no se delega: va inline o se propone SDD.`
    : `- ${files}, la escritura delegada llega con la fase 4b de sdd-ai: hoy se escribe inline o se le propone SDD al usuario.`
}

/** El modo de Jira como lo necesita el bootstrap. */
export type JiraBootstrap = 'on' | 'off' | 'invalid'

/** Las líneas de solo lectura: valen con y sin la regla de Jira. */
function readOnlyLines(t: RouteThresholds): string[] {
  return [
    `- Cuando entender el cambio requiere ${t.exploreMinFiles} o más archivos, la exploración se delega, sea cual sea el tamaño ` +
      `del cambio que venga después: ${delegateExplore()}. El temporal se borra cuando \`run\` confirma que copió el encargo ` +
      'a la corrida, y se conserva si `run` falla antes.',
    '- Si el encargo no se puede escribir, porque el usuario prohíbe toda escritura o porque el entorno no deja escribir fuera ' +
      'del repositorio, la exploración va inline, y es una excepción admitida.',
  ]
}

const CLOSING_LINES = [
  '- Primero se validan las premisas y se corren checks focalizados; después, los completos.',
  '- Una refutación de solo lectura se pide con `./bin/sdd-ai run --role refute --prompt-file <encargo>`.',
  '- Al cerrar, el conductor declara la ruta que siguió y los supuestos que tomó.',
]

/**
 * Con `jira_approval` en `on` todo cambio va por SDD: la ruta directa queda para el trabajo de solo
 * lectura y no ofrece escribir. Una config inválida rige igual, y lo dice.
 */
function jiraBootstrap(t: RouteThresholds, jira: 'on' | 'invalid', jiraDetail?: string): string {
  const invalid = jira === 'invalid'
    ? [`- La config de Jira no se puede leer${jiraDetail ? ` (${jiraDetail})` : ''}: hasta corregirla rige lo mismo que con \`jira_approval\` en \`on\`.`]
    : []
  return [
    'Ruta directa de sdd-ai en este repositorio, con la aprobación de la spec en Jira:',
    ...invalid,
    '- Con `jira_approval` en `on`, todo cambio del proyecto va por un flujo SDD, aunque sea `corta`, y la spec se publica en Jira ' +
      'con dos partes: un resumen para el PO, en lenguaje no técnico, y la definición técnica.',
    '- Fuera de un flujo SDD el trabajo es de solo lectura. Escribir el encargo de una delegación en un archivo temporal fuera del ' +
      'repositorio, y el estado que `run` deja en `.sdd-ai/`, no cambian el proyecto.',
    ...readOnlyLines(t),
    ...CLOSING_LINES,
  ].join('\n')
}

/**
 * La guía de la ruta directa que recibe el conductor al abrir, limpiar, compactar o retomar la sesión.
 * Está escrita como hechos del repositorio: un texto con forma de orden de sistema puede leerse como
 * una inyección.
 */
export function renderBootstrap(t: RouteThresholds = ROUTE, writerDispatchable = WRITER_DISPATCHABLE, jira: JiraBootstrap = 'off',
  jiraDetail?: string): string {
  if (jira !== 'off') return jiraBootstrap(t, jira, jiraDetail)
  return [
    'Ruta directa de sdd-ai en este repositorio, para el trabajo que no va por SDD:',
    '- Por defecto el trabajo es de solo lectura. Antes de cambiar el proyecto sin permiso previo, se le hace una sola pregunta al usuario. ' +
      'Escribir el encargo de una delegación en un archivo temporal fuera del repositorio, y el estado que `run` deja en `.sdd-ai/`, ' +
      'no cambian el proyecto y no necesitan esa pregunta.',
    '- Hay tres rutas: inline, delegada y SDD opcional.',
    '- Ni el tamaño ni el riesgo eligen SDD: lo proponen con la pregunta de profundidad (¿se puede decir ahora, sin explorar, ' +
      'qué archivos se van a tocar y cómo se sabrá que funcionó?), y SDD entra solo con un sí del usuario.',
    ...readOnlyLines(t),
    writerLine(t, writerDispatchable),
    `- La escritura de un cambio de menos de ${t.minDelegateLines} líneas (agregadas más quitadas) no se delega` +
      `${writerDispatchable ? ` aunque toque ${t.writerMinFiles} o más archivos` : ''}; la exploración ` +
      `sí, por la regla de los ${t.exploreMinFiles} archivos. Un cambio mecánico, como renombrar o formatear, no cuenta para ` +
      'elegir la ruta; el recordatorio de sesión larga cuenta igual todas las ediciones.',
    ...CLOSING_LINES,
  ].join('\n')
}

const CROSSED_LABEL: Record<Crossed, (n: number) => string> = {
  calls: (n) => `${n} llamadas a herramientas`,
  reads: (n) => `${n} lecturas`,
  edits: (n) => `${n} ediciones`,
}

/** Qué hacer con las ediciones: con Jira, lo mismo que dice su bootstrap; sin Jira, cuándo delegar la escritura. */
function editsAdvice(t: RouteThresholds, writerDispatchable: boolean, jira: JiraBootstrap, jiraDetail?: string): string {
  if (jira === 'on') return 'con `jira_approval` en `on`, todo cambio del proyecto va por un flujo SDD, aunque sea `corta`: se le propone al usuario'
  if (jira === 'invalid') {
    return `la config de Jira no se puede leer${jiraDetail ? ` (${jiraDetail})` : ''} y rige lo mismo que con \`jira_approval\` en \`on\`: ` +
      'todo cambio del proyecto va por un flujo SDD, aunque sea `corta`, y se le propone al usuario'
  }
  return writerDispatchable
    ? `si lo que queda por escribir toca ${t.writerMinFiles} o más archivos no triviales y ${t.minDelegateLines} líneas o más, ` +
      `delegar la escritura con permiso del usuario: ${WRITER_COMMAND}; si el cambio creció, se le propone SDD`
    : 'la escritura delegada llega con la fase 4b de sdd-ai; si el cambio creció, se le propone SDD al usuario'
}

/**
 * El recordatorio de sesión larga: nombra cada umbral cruzado, con su conteo, y qué hacer con cada
 * uno. Se entiende sin el bootstrap, que puede haber quedado lejos en la conversación.
 */
export function renderReminder(crossed: Crossed[], counts: Record<Crossed, number>, t: RouteThresholds = ROUTE,
  writerDispatchable = WRITER_DISPATCHABLE, jira: JiraBootstrap = 'off', jiraDetail?: string): string {
  const explore = `revisar cuántos archivos quedan por entender y, si son ${t.exploreMinFiles} o más, delegar la exploración: ${delegateExplore()}`
  const edits = editsAdvice(t, writerDispatchable, jira, jiraDetail)
  const todo: Record<Crossed, string> = { calls: explore, reads: explore, edits }
  return [
    'Recordatorio de sdd-ai: esta sesión trabaja inline sin delegar desde su último `run` o `review`, y cruzó estos umbrales:',
    ...crossed.map((c) => `- ${CROSSED_LABEL[c](counts[c])} (umbral: ${t.backstop[c]}): ${todo[c]}.`),
    'El conteo es aproximado y el recordatorio no bloquea nada; los contadores vuelven a cero.',
  ].join('\n')
}
