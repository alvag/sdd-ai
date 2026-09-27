import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launchState } from './native-launch.ts'
import { type Ledger, undecided } from './review/ledger.ts'
import { gitDirs } from './git.ts'
import { isDelivered, readJson, readStatus } from './runs.ts'
import { type NativeProfile, type RunState, type Status, TERMINAL } from './types.ts'

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

/**
 * Donde viven los almacenes de writer de este checkout; nada si no hay repo. Con `.git` como directorio
 * no hace falta lanzar Git; en un worktree, sí.
 */
function writersDir(root: string): string | undefined {
  try {
    const dotGit = join(root, '.git')
    const gitDir = statSync(dotGit).isDirectory() ? dotGit : gitDirs(root).gitDir
    return join(gitDir, 'sdd-ai', 'runs')
  } catch {
    return undefined
  }
}

/**
 * Sin corridas ni almacenes de writer no hay nada abierto. Una corrida ilegible o sin sesión dueña se
 * salta sin afectar a las demás. La de un writer se lee de su almacén: su corrida visible la pudo
 * cambiar o borrar el propio writer. El directorio de Git se resuelve una vez: los hooks llaman acá
 * en cada evento.
 */
export function openRuns(root: string): OpenRun[] {
  const runs = join(root, '.sdd-ai', 'runs')
  const writers = writersDir(root)
  const stores = writers && existsSync(writers) ? readdirSync(writers) : []
  const ids = new Set([...(existsSync(runs) ? readdirSync(runs) : []), ...stores])
  const open: OpenRun[] = []
  for (const id of [...ids].sort()) {
    try {
      const store = writers ? join(writers, id) : undefined
      const run = store && existsSync(join(store, 'control.json')) ? classifyWriter(store, join(runs, id), id) : classify(join(runs, id), id)
      if (run) open.push(run)
    } catch {
      // Una corrida a medio escribir o corrupta no es asunto del hook.
    }
  }
  return open
}

/**
 * Un writer sigue abierto mientras no haya cosecha congelada, y después hasta que `wait` la entregue.
 * La entrega se lee del almacén, o de la corrida visible cuando `wait` no pudo escribir el almacén. La
 * visible no vale si ya estaba al congelar la cosecha: la dejó el writer, y la cosecha la anotó como
 * corrida alterada.
 */
function classifyWriter(store: string, run: string, id: string): OpenRun | undefined {
  const session = readJson<{ session?: unknown }>(join(store, 'control.json')).session
  if (typeof session !== 'string' || session === '') return undefined
  const worker: OpenRun = { id, session, kind: 'worker', open: 'running', next: `./bin/sdd-ai wait ${id}` }
  const harvestFile = join(store, 'harvest.json')
  if (!existsSync(harvestFile)) return worker
  const harvest = readJson<{ state: RunState; runAltered?: Array<{ path: string }> }>(harvestFile)
  const status = { state: harvest.state } as Status
  const planted = (harvest.runAltered ?? []).some((f) => f.path === './delivered.json' || f.path === '.')
  if (!isDelivered(store, status) && (planted || !isDelivered(run, status))) return { ...worker, open: 'undelivered' }
  return undefined
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
