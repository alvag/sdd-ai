import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchState } from './native-launch.ts'
import { type Ledger, undecided } from './review/ledger.ts'
import { isDelivered, readJson, readStatus } from './runs.ts'
import { type NativeProfile, TERMINAL } from './types.ts'

/**
 * Por qué una corrida sigue abierta para su conductor: un worker o una revisión que todavía corren o
 * que terminaron sin que nadie leyera el resultado, una nativa que no se lanzó o cuyo despacho quedó
 * sin confirmar, y una revisión entregada con hallazgos por decidir.
 */
export type OpenState = 'running' | 'undelivered' | 'native_pending' | 'native_unconfirmed' | 'review_pending'

export interface OpenRun {
  id: string; session: string; kind: 'worker' | 'native' | 'review'; open: OpenState
  round?: number; launch?: number; attempt?: number; undecided?: number; disputed?: number
  next: string
}

interface RunRequest { session?: unknown; kind?: string }

/** Sin `.sdd-ai/runs` no hay nada abierto. Una corrida ilegible o sin sesión dueña se salta sin afectar a las demás. */
export function openRuns(root: string): OpenRun[] {
  const runs = join(root, '.sdd-ai', 'runs')
  if (!existsSync(runs)) return []
  const open: OpenRun[] = []
  for (const id of readdirSync(runs).sort()) {
    try {
      const run = classify(join(runs, id), id)
      if (run) open.push(run)
    } catch {
      // Una corrida a medio escribir o corrupta no es asunto del hook.
    }
  }
  return open
}

function classify(dir: string, id: string): OpenRun | undefined {
  const request = readJson<RunRequest>(join(dir, 'request.json'))
  if (typeof request.session !== 'string' || request.session === '') return undefined
  const session = request.session
  const s = readStatus(dir)

  // Una nativa queda `delegated`, que es terminal: su apertura la dice el lanzamiento, no el estado.
  if (existsSync(join(dir, 'native.json'))) {
    const native = readJson<NativeProfile>(join(dir, 'native.json'))
    const launch = launchState(dir, s)
    if (launch.kind === 'pending') {
      const next = `despachar ${native.agent} citando ${join(dir, 'prompt.md')}, o ./bin/sdd-ai cancel ${id}`
      return { id, session, kind: 'native', open: 'native_pending', attempt: launch.attempt, next }
    }
    if (launch.kind === 'reserved') {
      const next = `preguntarle al usuario si reintenta (./bin/sdd-ai cancel ${id} y después ./bin/sdd-ai run --retry ${id}) o la descarta (./bin/sdd-ai cancel ${id})`
      return { id, session, kind: 'native', open: 'native_unconfirmed', attempt: launch.attempt, next }
    }
    return undefined
  }

  if (request.kind === 'review') {
    const review: OpenRun = { id, session, kind: 'review', open: 'running', next: `./bin/sdd-ai review status ${id}` }
    if (s.round !== undefined) review.round = s.round
    if (s.launch !== undefined) review.launch = s.launch
    if (!TERMINAL.has(s.state)) return review
    if (!isDelivered(dir, s)) return { ...review, open: 'undelivered' }
    const ledgerFile = join(dir, 'ledger.json')
    if (!existsSync(ledgerFile)) return undefined
    const ledger = readJson<Ledger>(ledgerFile)
    const pending = undecided(ledger)
    if (pending.length === 0) return undefined
    const disputed = ledger.entries.filter((e) => e.state === 'en-disputa').length
    return { ...review, open: 'review_pending', undecided: pending.length, disputed }
  }

  const worker: OpenRun = { id, session, kind: 'worker', open: 'running', next: `./bin/sdd-ai wait ${id}` }
  if (!TERMINAL.has(s.state)) return worker
  if (!isDelivered(dir, s)) return { ...worker, open: 'undelivered' }
  return undefined
}

/** Qué recordó ya `Stop`: cambia si cambia el estado abierto, la ronda, el lanzamiento o el intento. */
export function runKey(r: OpenRun): string {
  return `${r.id}|${r.open}|${r.round ?? ''}|${r.launch ?? ''}|${r.attempt ?? ''}`
}

const KIND: Record<OpenRun['kind'], string> = { worker: 'worker', native: 'nativa', review: 'revisión' }

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Una línea de hechos: qué corrida, en qué está y el comando que sigue. */
export function describe(r: OpenRun): string {
  const tags = [KIND[r.kind]]
  if (r.round !== undefined) tags.push(`ronda ${r.round}`)
  if (r.attempt) tags.push(count(r.attempt, 'lanzamiento fallido', 'lanzamientos fallidos'))
  const state: Record<OpenState, string> = {
    running: 'sigue corriendo',
    undelivered: 'terminó sin entregar',
    native_pending: 'no se lanzó',
    native_unconfirmed: 'tiene un despacho reservado sin confirmar',
    review_pending: `tiene ${count(r.undecided ?? 0, 'hallazgo sin decidir', 'hallazgos sin decidir')}, ${r.disputed ?? 0} en disputa (las disputas las decide el usuario)`,
  }
  return `${r.id} (${tags.join(', ')}) ${state[r.open]}; sigue: ${r.next}`
}
