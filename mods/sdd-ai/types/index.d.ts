export type CommandDecision = { kind: 'recognized'; command: string } | { kind: 'native' }
export interface Attribution { command: string }
export interface LedgerRow { id: string; severity: string; reviewer?: string; state: string; claim: string }
export interface Summary {
  state?: string
  code?: string
  message?: string
  detail?: string
  next?: string[]
  ledger?: LedgerRow[]
  extra: string[]
  exitCode?: number
}
export type OriginalOutput = { kind: 'text'; text: string } | { kind: 'streams'; stdout: string; stderr: string }
export type OutputDecision = { kind: 'native' } | { kind: 'interrupted' } | { kind: 'summary'; summary: Summary; original: OriginalOutput }

// Lo que la banda guarda en `$.state`. Copia del contrato de la proyección solo lo que presenta.
export type RunKind = 'worker' | 'native' | 'review'
export type RunState = 'launching' | 'running' | 'done' | 'failed' | 'launch_failed' | 'timeout' | 'cancelled' | 'delegated' | 'unavailable' | 'cessation_uncertain'
export type OpenReason = 'running' | 'undelivered' | 'native_pending' | 'native_unconfirmed' | 'review_pending'

/**
 * Por qué no hay datos que mostrar. Ninguno equivale al estado vacío, y ninguno cae a una observación anterior.
 * - `missing`: falta la proyección, o no se pudo leer ninguna observación (desaparecían o la lectura se trabó) y no había
 *   una lectura válida anterior.
 * - `link`: un enlace en la cadena, o la elegida no está donde dice su ruta real.
 * - `not_directory`: `.sdd-ai/`, `projection/` o `live/` no son directorios.
 * - `directory` y `not_regular`: la elegida es un directorio, o un FIFO u otra entrada que no es un archivo regular.
 * - `too_large`: la elegida pasa los 4 MiB de `$.fs.read`.
 * - `flooded`: `live/` tiene más de 256 entradas.
 * - `unreadable`: la consulta o la lectura de la proyección falló por otra causa que su desaparición.
 * - `corrupt`, `incompatible_version` y `foreign_checkout`: su contenido no es una observación de este checkout que el
 *   mod entienda.
 * - `inventory_unavailable`: la observación es válida, pero declara no disponible lo que haría falta para afirmar que
 *   la sesión no tiene actividad.
 */
export type Unavailable = 'missing' | 'link' | 'not_directory' | 'directory' | 'not_regular' | 'too_large' | 'flooded'
  | 'unreadable' | 'corrupt' | 'incompatible_version' | 'foreign_checkout' | 'inventory_unavailable'

/** El flujo ligado a la sesión y su paso: el de la vista observada del flujo o, si no está disponible, el de la liga. */
export interface BandFlow { id: string; step: string; gate: string | null; source: 'flow' | 'binding' }
/** El avance de una revisión por ronda: los terminados incluyen los conservados de lanzamientos anteriores. */
export interface BandProgress { phase: 'review' | 'refutation'; round: number; launch: number; done: number; total: number; reviewer: string | null; batch: number | null }
/**
 * La actividad elegida de la sesión. `association` es la registrada: la del flujo ligado, la de otro flujo o ninguna,
 * con su causa. `uncertain` marca un writer en `cessation_uncertain`, que puede seguir escribiendo.
 */
export interface BandActivity {
  id: string; role: 'writer' | RunKind | null; state: RunState | null; open: OpenReason | null; uncertain: boolean
  association: { kind: 'bound' } | { kind: 'flow'; id: string } | { kind: 'none'; reason: string }
  progress: BandProgress | null
}
/**
 * Lo que se eligió de una lectura válida, sin depender de la hora. `live` dice si la observación tiene alguna corrida
 * viva, de cualquier sesión; `incomplete`, si faltaba la liga de la sesión o parte del inventario de corridas.
 */
export type BandSelection =
  | { kind: 'unavailable'; reason: 'inventory_unavailable' }
  | { kind: 'empty'; observation: string; observedAt: number; live: boolean }
  | { kind: 'band'; observation: string; observedAt: number; live: boolean; flow: BandFlow | null; activity: BandActivity | null; incomplete: boolean }

/** La identidad de una lectura: la sesión de `$.session.id()` y la ruta real del checkout. */
export interface Identity { session: string; root: string }
/** La última lectura válida, con la identidad que la leyó. */
export interface BandMemory { identity: Identity; selection: BandSelection }
/**
 * Lo que dibuja la banda. `lastRead` marca la última lectura válida que se conserva cuando se agotaron los intentos o
 * cuando una lectura se trabó: nunca es una lectura actual. `ageMs` es hace cuánto se observó, solo con una corrida viva y pasados 60 segundos.
 */
export type BandPresentation =
  | { kind: 'unavailable'; reason: Unavailable }
  | { kind: 'empty'; lastRead: boolean; ageMs: number | null }
  | { kind: 'band'; flow: BandFlow | null; activity: BandActivity | null; incomplete: boolean; lastRead: boolean; ageMs: number | null }

/**
 * El estado de la banda en la sesión. Lo escribe solo el refresco y lo lee el dibujo, que así se redibuja con cada
 * cambio. `identity` es la que leyó; `presentation` es `null` mientras se lee por primera vez para una identidad nueva,
 * y `memory` guarda la última lectura válida para cuando se agotan los intentos o se traba una lectura. Sobrevive a una
 * recarga del mod.
 */
export interface BandState { identity: Identity; presentation: BandPresentation | null; memory: BandMemory | null }

declare module 'claude-code' {
  interface PluginState {
    'sdd-ai-mod': { attribution: StateFamily<Attribution>; band: BandState }
  }
}
