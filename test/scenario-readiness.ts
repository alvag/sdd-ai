import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readProcess, type GroupIdentity } from '../src/writer-store.ts'

export const PREPARATION_MS = 30_000
export const CLEANUP_MS = 60_000

export class ScenarioError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ScenarioError' }
}

export interface Observation<T> { value?: T; detail: unknown }

/** Un plazo vencido conserva la última observación; nunca satisface la condición. */
export async function awaitObservation<T>(label: string, probe: () => Observation<T> | Promise<Observation<T>>, limitMs = PREPARATION_MS): Promise<T> {
  const deadline = performance.now() + limitMs
  let last: unknown
  for (;;) {
    const observed = await probe()
    last = observed.detail
    if (observed.value !== undefined && performance.now() <= deadline) return observed.value
    if (performance.now() >= deadline) throw new ScenarioError('observation_timeout', `${label}: plazo agotado; última observación: ${JSON.stringify(last)}`)
    await sleep(Math.min(25, Math.max(1, deadline - performance.now())))
  }
}

/** Solo ESRCH acredita ausencia; un permiso insuficiente no acredita cese. */
export function processState(pid: number): 'alive' | 'gone' | 'unknown' {
  try { process.kill(pid, 0); return 'alive' } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

/** Corre una acción del cleanup con el presupuesto restante; si vence, el cleanup queda incierto. */
async function withinBudget(action: () => unknown | Promise<unknown>, remainingMs: number, detail: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ScenarioError('cleanup_uncertain', `${detail}; se conservan los directorios`)), remainingMs)
    })])
  } finally { clearTimeout(timer) }
}

type Identity = Exclude<ReturnType<typeof readProcess>, 'gone' | undefined>
interface Owned { pid: number; identity: Identity; group: boolean }
interface ProcessHooks {
  read?: typeof readProcess
  probe?: typeof processState
  signal?: (pid: number, signal: NodeJS.Signals) => void
}

/** Registro acotado a PIDs recibidos del escenario, sin búsquedas por nombre. */
export function ownProcesses(hooks: ProcessHooks = {}) {
  const read = hooks.read ?? readProcess
  const probe = hooks.probe ?? processState
  const signal = hooks.signal ?? ((pid, sig) => process.kill(pid, sig))
  const owned: Owned[] = []
  const directories = new Set<string>()
  const terminators: Array<() => unknown | Promise<unknown>> = []
  const completions: Array<() => unknown | Promise<unknown>> = []
  const same = (a: Identity, b: Identity) => a.pgid === b.pgid && a.lstart === b.lstart && a.argvHash === b.argvHash
  // Se comparan solo los campos que la identidad esperada trae: el runtime puede registrar un grupo sin `lstart`.
  const matches = (seen: Identity, expected: GroupIdentity) => seen.pgid === expected.pgid
    && (expected.lstart === null || seen.lstart === expected.lstart) && (!expected.argvHash || seen.argvHash === expected.argvHash)
  const state = (entry: Owned): 'alive' | 'gone' | 'unknown' => {
    const current = probe(entry.pid)
    const seen = current === 'alive' ? read(entry.pid) : undefined
    // Un PID reutilizado no pertenece al escenario y nunca se señala.
    if (seen && seen !== 'gone' && !same(seen, entry.identity)) return 'gone'
    if (entry.group) {
      const group = probe(-entry.identity.pgid)
      if (group === 'gone') return 'gone'
      if (current !== 'alive' || !seen || seen === 'gone') return 'unknown'
      return group
    }
    if (current === 'gone') return 'gone'
    return seen && seen !== 'gone' ? current : 'unknown'
  }
  const registry = {
    add(pid: number, group = false, expected?: GroupIdentity) {
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new ScenarioError('invalid_pid', `PID propio inválido: ${pid}`)
      const status = probe(pid)
      const seen = status === 'alive' ? read(pid) : undefined
      const observed = seen && seen !== 'gone' ? seen : undefined
      // Un PID que no coincide con la identidad esperada fue reutilizado: el original ya no existe y nunca se señala.
      if (observed && expected && !matches(observed, expected)) return
      const identity = observed ?? (expected?.lstart ? { ...expected, lstart: expected.lstart } : undefined)
      if (!identity) {
        // Un grupo ya vacío no deja nada que limpiar, aunque el runtime lo haya registrado sin `lstart`.
        if (status === 'gone' && (!group || probe(-pid) === 'gone')) return
        throw new ScenarioError('identity_unknown', `No se acreditó la identidad del PID ${pid}`)
      }
      if (group && (identity.pgid <= 1 || identity.pgid !== pid)) throw new ScenarioError('invalid_group', `Grupo propio inválido: ${identity.pgid}`)
      // Un PID ya registrado no se vuelve a agregar: si vuelve con otra identidad, fue reutilizado y no se adopta.
      if (!owned.some((p) => p.pid === pid && p.group === group)) owned.push({ pid, group, identity })
    },
    directory(path: string) { directories.add(path) },
    terminate(action: () => unknown | Promise<unknown>) { terminators.push(action) },
    completion(action: () => unknown | Promise<unknown>) { completions.push(action) },
    async ceased(limitMs = CLEANUP_MS) {
      await awaitObservation('cese de los procesos propios', () => {
        const detail = owned.map((p) => ({ pid: p.pid, group: p.group, state: state(p) }))
        return { value: detail.every((p) => p.state === 'gone') ? true : undefined, detail }
      }, limitMs)
    },
    async disposeOwned(limitMs = CLEANUP_MS) {
      const errors: unknown[] = []
      const started = performance.now()
      // Los terminadores también quedan dentro del presupuesto: uno que no termina se informa como cleanup incierto.
      for (const terminate of terminators) {
        try { await withinBudget(terminate, Math.max(0, limitMs - (performance.now() - started)), 'No terminó un terminador de los procesos propios') } catch (e) { errors.push(e) }
      }
      const send = (sig: NodeJS.Signals) => {
        for (const entry of owned) {
          if (state(entry) !== 'alive') continue
          try { signal(entry.group ? -entry.identity.pgid : entry.pid, sig) } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(e)
          }
        }
      }
      send('SIGTERM')
      const grace = Math.min(1000, limitMs / 4)
      while (owned.some((p) => state(p) !== 'gone') && performance.now() - started < grace) await sleep(25)
      send('SIGKILL')
      try { await registry.ceased(Math.max(0, limitMs - (performance.now() - started))) } catch (e) { errors.push(e) }
      if (errors.length) throw new ScenarioError('cleanup_uncertain', `Cleanup sin cese acreditado; se conservan los directorios ${JSON.stringify([...directories])}; ${errors.map(String).join('; ')}`)
      for (const complete of completions) {
        await withinBudget(complete, Math.max(0, limitMs - (performance.now() - started)), 'No terminó la finalización de los procesos propios')
      }
      for (const path of directories) rmSync(path, { recursive: true, force: true })
    },
  }
  return registry
}

export type OwnedProcesses = ReturnType<typeof ownProcesses>

/** Mantiene el fallo original primero, incluso si la disposición también falla. */
export async function withOwned<T>(owned: OwnedProcesses, body: () => Promise<T>, limitMs = CLEANUP_MS): Promise<T> {
  let original: unknown; let failed = false
  try { return await body() } catch (e) { failed = true; original = e; throw e } finally {
    try { await owned.disposeOwned(limitMs) } catch (cleanup) {
      if (failed) throw new AggregateError([original, cleanup], 'Fallaron el escenario y su cleanup')
      throw cleanup
    }
  }
}

export function requireTerminal(state: string, expected: string): void {
  if (state === 'cessation_uncertain') throw new ScenarioError('cessation_uncertain', 'El cese del writer no está acreditado')
  if (state !== expected) throw new ScenarioError('terminal_mismatch', `Estado esperado ${expected}, observado ${state}`)
}

export interface PublicationEvent { event: string; pid: number; started?: string; deadline?: string; monotonic?: string; deadline_reached?: boolean; queue?: boolean; rounds?: number }
export function requirePublicationBudget(events: PublicationEvent[], finished = false): void {
  if (events.some((e) => e.event === 'pending_expired' || (e.event === 'queue_wait_finished' && e.deadline_reached === true)
    || (e.event === 'attempt' && e.queue === false && (e.rounds ?? 0) < 3))) {
    throw new ScenarioError('publication_budget_expired', 'El pedido agotó su presupuesto de espera')
  }
  if (finished && events.at(-1)?.event !== 'finished') throw new ScenarioError('publication_unfinished', 'Falta el evento finished del pedido')
}

export async function readyPids(dir: string, worker: () => number | undefined, owned: OwnedProcesses) {
  return awaitObservation('worker e hijo preparados', () => {
    const file = join(dir, 'pids')
    const pids = existsSync(file) ? readFileSync(file, 'utf8').split(',').map(Number) : []
    const valid = pids.length === 2 && pids.every((p) => Number.isInteger(p) && p > 1) && pids[0] !== pids[1] && pids[0] === worker()
    if (valid) for (const pid of pids) owned.add(pid)
    const states = valid ? pids.map(processState) : []
    return { value: valid && states.every((s) => s === 'alive') ? pids : undefined, detail: { worker: worker(), pids, states } }
  })
}
