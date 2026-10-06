import type { FsEntry, FsStat, On } from 'claude-code'
import { BOOT } from './projection-names'

// Un checkout en memoria para probar el refresco de la banda a través del motor: los hooks del test contestan
// `$.session.id`, `$.session.root` y `$.fs.stat`, `list` y `read` del mod desde aquí, y anotan cada acceso para
// comprobar que el mod no sale de la identidad del checkout y de `live/`.

/** La raíz que dice `$.session.root()` y la ruta real a la que lleva. */
export const SESSION_ROOT = '/work/checkout'
export const REAL_ROOT = '/private/work/checkout'
export const T0 = 1_759_680_000_000
const PID = 4242

export const paths = (root: string) => ({ store: `${root}/.sdd-ai`, projection: `${root}/.sdd-ai/projection`, live: `${root}/.sdd-ai/projection/live` })
export const LIVE = paths(REAL_ROOT).live

type Json = Record<string, unknown>
export const known = <T>(value: T) => ({ value, reason: null })
export const unknown = (code: string) => ({ value: null, reason: { code, detail: 'Sin dato.' } })
export const run = (id: string, session: string, overrides: Json = {}): Json => ({
  id, availability: 'available', reason: null, kind: known('worker'), state: known('running'), open: known('running'), session: known(session),
  flow: unknown('not_recorded'), live: known(true), progress: unknown('not_applicable'), ...overrides,
})
export const pending = (id: string, session: string, overrides: Json = {}): Json => run(id, session, { state: known('done'), open: known('undelivered'), live: known(false), ...overrides })
const job = (key: string, launch = 1) => ({ round: 2, key, launch, state: 'done', admission: known('admitted') })
export const review = (id: string, session: string, overrides: Json = {}): Json => run(id, session, {
  kind: known('review'),
  progress: known({ phase: 'review', round: 2, launch: 1, planned: ['base:1', 'base:2', 'reliability:1', 'reliability:2', 'reliability:3'],
    retained: [], completed: [job('base:1'), job('base:2'), job('reliability:2')], total: 5,
    active: known({ key: 'reliability:1', reviewer: known('reliability'), batch: known(1) }) }),
  ...overrides,
})
export const writer = (id: string, session: string, overrides: Json = {}): Json => ({
  id, availability: 'available', reason: null, state: known('running'), open: known('running'), session: known(session), flow: unknown('not_recorded'), live: known(true), ...overrides,
})
export const flowEntry = (id: string, step = 'implement'): Json => ({
  id, availability: 'available', reason: null, observed_at: T0, status: known('planned'),
  view: known({ id, depth: 'completa', gates: [], tasks: { total: 3, done: 1, pending: 2, first_pending: 'T2' }, next: { step }, blocked_reasons: [], notes: [], paths: { dir: `.plans/${id}` } }),
})
export const binding = (session: string, flow: string | null, step = 'specify'): Json => ({
  id: session, availability: 'available', reason: null, flow: flow === null ? unknown('unbound') : known({ id: flow, step, gate: null, at: '2026-10-05T00:00:00.000Z' }),
})
export const available = (items: Json[]): Json => ({ availability: 'available', reason: null, items })

export interface Parts { runs?: Json[]; writer?: Json | null; flows?: Json[]; bindings?: Json[]; observedAt?: number; root?: string; schemaVersion?: number; notificationsVersion?: number }

/** El nombre de la observación con ese `m0`, del arranque de las pruebas. */
export const nameOf = (m0: number, suffix = 'a'): string => `obs-${String(m0).padStart(20, '0')}-${BOOT}-${PID}-${suffix.repeat(32)}.json`

/** El texto de una observación válida de `REAL_ROOT` (o de `root`) con esas entidades. */
export function observationText(name: string, parts: Parts = {}): string {
  const m0 = name.slice('obs-'.length, 'obs-'.length + 20)
  const observedAt = parts.observedAt ?? T0
  return JSON.stringify({
    schema_version: parts.schemaVersion ?? 1, checkout: { id: 'f'.repeat(64), root: parts.root ?? REAL_ROOT },
    ...(parts.notificationsVersion === undefined ? {} : { notifications_version: parts.notificationsVersion }),
    observation: { id: name, publisher: { pid: PID, kind: 'cli' }, m0, boot: BOOT, observed_at: observedAt, read_finished_at: observedAt + 5 },
    runs: available(parts.runs ?? []), writer: { availability: 'available', reason: null, item: parts.writer ?? null },
    flows: available(parts.flows ?? []), bindings: available(parts.bindings ?? []), omissions: [],
  })
}

/** Una entrada del checkout en memoria. `realPath: null` es una ruta que no lleva a ningún lado. */
export interface Entry { kind: 'file' | 'dir' | 'other'; text?: string; size?: number; isLink?: boolean; realPath?: string | null; mtimeMs?: number }
/** Un acceso del mod. */
export interface Access { op: 'stat' | 'list' | 'read'; path: string; resolve?: boolean }

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
type Answer<T> = { value: T } | { deny: string }

export class World {
  session: string
  sessionRoot = SESSION_ROOT
  readonly entries = new Map<string, Entry>()
  readonly accesses: Access[] = []
  /** Las raíces que el mod puede consultar como identidad del checkout y las raíces reales de esas identidades. */
  readonly roots = new Set([SESSION_ROOT])
  readonly realRoots = new Set([REAL_ROOT])
  /** Retiene la lectura de una ruta hasta que el test la suelta. */
  hold: ((path: string) => Promise<void> | undefined) | null = null
  /** Retiene la respuesta de `$.session.root()` hasta que el test la suelta. */
  holdRoot: (() => Promise<void> | undefined) | null = null
  /** Observaciones que el listado muestra pero que ya no están cuando el mod las busca (otro publicador las podó). */
  ghosts = new Set<string>()
  /** Lecturas que fallan aunque el archivo siga ahí. */
  unreadable = new Set<string>()
  /** Rutas cuyo `stat` falla por permisos, no por ausencia, aunque existan. */
  readonly failingStats = new Set<string>()
  /** Directorios cuyo listado falla por permisos, no por ausencia, aunque existan. */
  readonly failingLists = new Set<string>()

  constructor(session: string) {
    this.session = session
    this.checkout(SESSION_ROOT, REAL_ROOT)
  }

  /** Un checkout preparado: su raíz de sesión lleva a su ruta real, que tiene `.sdd-ai/projection/live/`. */
  checkout(sessionRoot: string, realRoot: string, prepared = true): void {
    this.roots.add(sessionRoot)
    this.realRoots.add(realRoot)
    this.entries.set(sessionRoot, { kind: 'dir', isLink: sessionRoot !== realRoot, realPath: realRoot })
    this.entries.set(realRoot, { kind: 'dir' })
    if (!prepared) return
    const { store, projection, live } = paths(realRoot)
    for (const dir of [store, projection, live]) this.entries.set(dir, { kind: 'dir' })
  }

  /** Publica una observación en `live/` y devuelve su nombre. */
  publish(m0: number, parts: Parts = {}, suffix = 'a', live = LIVE): string {
    const name = nameOf(m0, suffix)
    this.entries.set(`${live}/${name}`, { kind: 'file', text: observationText(name, parts) })
    return name
  }

  /** Vacía `live/` sin quitarlo. */
  clearLive(live = LIVE): void {
    for (const path of [...this.entries.keys()]) if (parentOf(path) === live) this.entries.delete(path)
  }

  private stat(path: string, resolve: boolean): Answer<FsStat> {
    this.accesses.push({ op: 'stat', path, resolve })
    if (this.failingStats.has(path)) return { deny: `EACCES: permission denied, stat '${path}'` }
    const entry = this.ghosts.has(baseOf(path)) ? undefined : this.entries.get(path)
    if (entry === undefined) return { deny: `ENOENT: no such file or directory, stat '${path}'` }
    const size = entry.size ?? (entry.kind === 'file' ? (entry.text ?? '').length : 0)
    const real = entry.realPath === undefined ? path : entry.realPath
    return { value: { kind: entry.kind, size, mtimeMs: entry.mtimeMs ?? T0, isLink: entry.isLink ?? false, ...(resolve && real !== null ? { realPath: real } : {}) } }
  }

  private list(path: string): Answer<FsEntry[]> {
    this.accesses.push({ op: 'list', path })
    if (this.failingLists.has(path)) return { deny: `EACCES: permission denied, scandir '${path}'` }
    const entry = this.entries.get(path)
    if (entry === undefined) return { deny: `ENOENT: no such file or directory, scandir '${path}'` }
    if (entry.kind !== 'dir') return { deny: `ENOTDIR: ${path}` }
    const listed = [...this.entries.entries()].filter(([child]) => parentOf(child) === path).map(([child, value]): FsEntry => {
      const kind = value.isLink ? 'other' : value.kind
      return { name: baseOf(child), kind, size: kind === 'file' ? (value.size ?? (value.text ?? '').length) : 0, mtimeMs: kind === 'file' ? value.mtimeMs ?? T0 : 0, isLink: value.isLink ?? false }
    })
    return { value: listed }
  }

  private async read(path: string): Promise<Answer<string>> {
    this.accesses.push({ op: 'read', path })
    await this.hold?.(path)
    const entry = this.ghosts.has(baseOf(path)) ? undefined : this.entries.get(path)
    if (entry === undefined) return { deny: `ENOENT: no such file or directory, open '${path}'` }
    if (entry.kind !== 'file' || this.unreadable.has(path)) return { deny: `EACCES: ${path}` }
    return { value: entry.text ?? '' }
  }

  /** Contesta desde aquí la sesión, su raíz y los accesos al sistema de archivos del mod. */
  install(on: On): void {
    on('session.id', () => ({ value: this.session }))
    on('session.root', async () => {
      await this.holdRoot?.()
      return { value: this.sessionRoot }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('fs.stat', (_$, e) => this.stat(e.path, e.resolve))
    on('fs.list', (_$, e) => this.list(e.path))
    on('fs.read', (_$, e) => this.read(e.path))
  }

  /**
   * Los accesos que salen de lo permitido: el `stat` con `resolve` de una raíz de sesión, el `stat` de `.sdd-ai/`,
   * `projection/` y `live/` y de las entradas de `live/`, y el listado de `live/` y la lectura de sus entradas, bajo una
   * ruta real de esas raíces. Cualquier otro acceso es una violación.
   */
  violations(accesses: readonly Access[] = this.accesses): string[] {
    const allowed = (access: Access): boolean => {
      if (access.op === 'stat' && access.resolve === true && this.roots.has(access.path)) return true
      return [...this.realRoots].some((root) => {
        const { store, projection, live } = paths(root)
        const entryOfLive = parentOf(access.path) === live && /^[^/]+$/.test(baseOf(access.path)) && !['.', '..'].includes(baseOf(access.path))
        if (access.op === 'stat') return ([store, projection, live].includes(access.path) && access.resolve === false) || entryOfLive
        if (access.op === 'list') return access.path === live
        return entryOfLive
      })
    }
    return accesses.filter((access) => !allowed(access)).map((access) => `${access.op}${access.resolve ? ' (resolve)' : ''} ${access.path}`)
  }
}
