import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirtyPaths } from '../git.ts'
import { withLock } from '../lock.ts'
import { isRunId, readStatus, writeJsonAtomic } from '../runs.ts'
import { SddError, TERMINAL } from '../types.ts'
import { harvestTreeHolds, isWriterRun, readHarvest } from '../writer-store.ts'
import type { DocumentStep, PhaseStep } from './phase.ts'
import { LOCK_FILE, flowDir, lstatOrNull, pathInvalid } from './read.ts'
import type { FlowStatus, Next } from './status.ts'

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
}

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
  for (const [step, entry] of Object.entries(data.phases)) {
    if (!DOCUMENT_STEPS.includes(step)) throw invalid(id, `phases.${step} no es una fase con registro`)
    const problem = entryProblem(entry)
    if (problem !== null) throw invalid(id, `phases.${step} ${problem}`)
  }
  return data as unknown as PhaseRecord
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
    next: `si no hay otro sdd approve ni sdd phase corriendo, borra .plans/${id}/${LOCK_FILE} y vuelve a correr el comando`,
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
 * El `next` de un flujo con el comando de su fase, o con el motivo por el que no hay. Un registro que no
 * se puede leer no tumba a quien lista: queda dicho en `detail`.
 */
export function withPhaseNext<T extends Pick<FlowStatus, 'depth' | 'next'>>(root: string, id: string, status: T): Next {
  if ((status.depth !== 'normal' && status.depth !== 'completa') || !PHASE_STEPS.includes(status.next.step)) return status.next
  try {
    const phase = phaseNext(root, id, status, readPhaseRecord(root, id))
    return phase ? { ...status.next, ...phase } : status.next
  } catch (e) {
    return { ...status.next, detail: `no se pudo leer el registro de fases: ${(e as Error).message}` }
  }
}
