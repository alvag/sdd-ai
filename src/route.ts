import { READ_ONLY_ROLES } from './types.ts'

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

/** El writer se nombra como delegable recién cuando `run` acepte `implement`. */
const WRITER_DISPATCHABLE = (READ_ONLY_ROLES as readonly string[]).includes('implement')

/** Cómo se delega la exploración: el bootstrap y el recordatorio lo dicen con las mismas palabras. */
function delegateExplore(): string {
  return 'se escribe el encargo en un archivo temporal fuera del repositorio y se corre ' +
    '`./bin/sdd-ai run --role explore --prompt-file <encargo>` con esa ruta'
}

function writerLine(t: RouteThresholds, writerDispatchable: boolean): string {
  const files = `Con ${t.writerMinFiles} o más archivos no triviales para escribir`
  return writerDispatchable
    ? `- ${files}, la escritura se delega con \`./bin/sdd-ai run --role implement --prompt-file <encargo>\`.`
    : `- ${files}, la escritura delegada llega con la fase 4b de sdd-ai: hoy se escribe inline o se le propone SDD al usuario.`
}

/**
 * La guía de la ruta directa que recibe el conductor al abrir, limpiar, compactar o retomar la sesión.
 * Está escrita como hechos del repositorio: un texto con forma de orden de sistema puede leerse como
 * una inyección.
 */
export function renderBootstrap(t: RouteThresholds = ROUTE, writerDispatchable = WRITER_DISPATCHABLE): string {
  return [
    'Ruta directa de sdd-ai en este repositorio, para el trabajo que no va por SDD:',
    '- Por defecto el trabajo es de solo lectura. Antes de cambiar el proyecto sin permiso previo, se le hace una sola pregunta al usuario. ' +
      'Escribir el encargo de una delegación en un archivo temporal fuera del repositorio, y el estado que `run` deja en `.sdd-ai/`, ' +
      'no cambian el proyecto y no necesitan esa pregunta.',
    '- Hay tres rutas: inline, delegada y SDD opcional.',
    '- Ni el tamaño ni el riesgo eligen SDD: lo proponen con la pregunta de profundidad (¿se puede decir ahora, sin explorar, ' +
      'qué archivos se van a tocar y cómo se sabrá que funcionó?), y SDD entra solo con un sí del usuario.',
    `- Cuando entender el cambio requiere ${t.exploreMinFiles} o más archivos, la exploración se delega, sea cual sea el tamaño ` +
      `del cambio que venga después: ${delegateExplore()}. El temporal se borra cuando \`run\` confirma que copió el encargo ` +
      'a la corrida, y se conserva si `run` falla antes.',
    '- Si el encargo no se puede escribir, porque el usuario prohíbe toda escritura o porque el entorno no deja escribir fuera ' +
      'del repositorio, la exploración va inline, y es una excepción admitida.',
    writerLine(t, writerDispatchable),
    `- La escritura de un cambio de menos de ${t.minDelegateLines} líneas (agregadas más quitadas) no se delega; la exploración ` +
      `sí, por la regla de los ${t.exploreMinFiles} archivos. Un cambio mecánico, como renombrar o formatear, no cuenta para ` +
      'elegir la ruta; el recordatorio de sesión larga cuenta igual todas las ediciones.',
    '- Primero se validan las premisas y se corren checks focalizados; después, los completos.',
    '- Una refutación de solo lectura se pide con `./bin/sdd-ai run --role refute --prompt-file <encargo>`.',
    '- Al cerrar, el conductor declara la ruta que siguió y los supuestos que tomó.',
  ].join('\n')
}

const CROSSED_LABEL: Record<Crossed, (n: number) => string> = {
  calls: (n) => `${n} llamadas a herramientas`,
  reads: (n) => `${n} lecturas`,
  edits: (n) => `${n} ediciones`,
}

/**
 * El recordatorio de sesión larga: nombra cada umbral cruzado, con su conteo, y qué hacer con cada
 * uno. Se entiende sin el bootstrap, que puede haber quedado lejos en la conversación.
 */
export function renderReminder(crossed: Crossed[], counts: Record<Crossed, number>, t: RouteThresholds = ROUTE): string {
  const explore = `revisar cuántos archivos quedan por entender y, si son ${t.exploreMinFiles} o más, delegar la exploración: ${delegateExplore()}`
  const todo: Record<Crossed, string> = {
    calls: explore,
    reads: explore,
    edits: 'la escritura delegada llega con la fase 4b de sdd-ai; si el cambio creció, se le propone SDD al usuario',
  }
  return [
    'Recordatorio de sdd-ai: esta sesión trabaja inline sin delegar desde su último `run` o `review`, y cruzó estos umbrales:',
    ...crossed.map((c) => `- ${CROSSED_LABEL[c](counts[c])} (umbral: ${t.backstop[c]}): ${todo[c]}.`),
    'El conteo es aproximado y el recordatorio no bloquea nada; los contadores vuelven a cero.',
  ].join('\n')
}
