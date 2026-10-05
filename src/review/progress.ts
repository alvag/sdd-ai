import type { JobRecord, ReviewJob, RoundRecord } from '../supervisor.ts'
import { type LaunchJob, type LaunchProgress, type Status, TERMINAL } from '../types.ts'

/** Los motivos con que termina un trabajo que respondió sin que su respuesta se admitiera. */
const INADMISSIBLE = new Set(['inadmissible_twice', 'correction_failed', 'correction_over_budget'])

/**
 * La admisión conocida de un trabajo terminado: admitido si dejó su respuesta admitida, inadmisible si su
 * respuesta no se admitió, y desconocida si no llegó a responder (falló, se agotó o se canceló).
 */
export function admissionOf(admitted: boolean, reason?: string): LaunchJob['admission'] {
  if (admitted) return 'admitted'
  return reason !== undefined && INADMISSIBLE.has(reason) ? 'inadmissible' : null
}

/** Un trabajo de revisión terminado, con el lanzamiento en que terminó. */
export function finishedJob(round: number, record: JobRecord): LaunchJob {
  return { round, key: record.key, launch: record.launch, state: record.state, admission: admissionOf(record.admitted !== undefined, record.reason) }
}

/**
 * El avance al empezar un lanzamiento de revisión: lo previsto queda pendiente y lo conservado de un
 * lanzamiento anterior cuenta como terminado en el suyo. El total es la unión de los dos, no los intentos.
 */
export function reviewProgress(round: number, launch: number, jobs: readonly ReviewJob[], kept: readonly JobRecord[]): LaunchProgress {
  return { phase: 'review', round, launch, planned: jobs.map((j) => j.key), retained: kept.map((r) => finishedJob(round, r)), completed: [], active: null }
}

/** El avance de la refutación de una ronda: un conjunto previsto propio, sin sumarse al de la revisión. */
export function refutationProgress(round: number, launch: number, keys: readonly string[]): LaunchProgress {
  return { phase: 'refutation', round, launch, planned: [...keys], retained: [], completed: [], active: null }
}

/** El trabajo que empieza a correr. */
export function activate(p: LaunchProgress, active: NonNullable<LaunchProgress['active']>): LaunchProgress {
  return { ...p, active }
}

/**
 * Un resultado del lanzamiento: el trabajo cuenta como terminado en este lanzamiento, haya quedado admitido o
 * no. Terminado no significa admitido: su admisión va aparte.
 */
export function complete(p: LaunchProgress, job: LaunchJob): LaunchProgress {
  return { ...p, completed: [...p.completed.filter((j) => j.key !== job.key), job], active: null }
}

const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const list = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)

/**
 * El avance de una revisión según lo que dejó en disco, sin entregar nada. Mientras corre, el resumen que
 * mantiene su supervisor para el lanzamiento activo. Terminada, el registro de ese lanzamiento en
 * `rounds.json` y el plan de su argv. `read` devuelve el JSON de un archivo de la corrida, o `null` si no
 * existe. Un formato anterior sin esos datos da `null`: los terminados nunca se deducen del índice del trabajo
 * activo.
 */
export function observedProgress(status: Partial<Status>, read: (name: string) => Record<string, unknown> | null): LaunchProgress | null {
  const { round, launch } = status
  if (!integer(round) || !integer(launch) || typeof status.state !== 'string') return null
  if (!TERMINAL.has(status.state)) {
    const p = status.progress
    return p !== undefined && p.round === round && p.launch === launch ? p : null
  }
  const argv = read(`argv${round === 1 ? '' : `-r${round}`}-l${launch}.json`)
  const records = list(read('rounds.json')?.rounds) as RoundRecord[] | null
  const record = records?.findLast((r) => r?.n === round && r?.launch === launch)
  const jobs = list(argv?.jobs) as ReviewJob[] | null
  const done = list(record?.jobs) as JobRecord[] | null
  // El primer lanzamiento de una ronda no conserva nada: su argv no trae `kept`. Uno presente que no es una lista no
  // permite saber qué se conservó.
  const kept = (argv?.kept === undefined ? [] : list(argv.kept)) as JobRecord[] | null
  if (jobs === null || done === null || kept === null) return null
  const planned = jobs.map((j) => j.key)
  return {
    phase: 'review', round, launch, planned, retained: kept.map((r) => finishedJob(round, r)),
    completed: done.filter((r) => r.launch === launch && planned.includes(r.key)).map((r) => finishedJob(round, r)), active: null,
  }
}
