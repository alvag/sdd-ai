import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type GitState, type HarvestFile, buildIndex, captureTree, entryDiff, gitDirs, indexEntries, isWorktreeStatePath, readHeadState, readRefState, readReplaceRefs, removeIndex } from './git.ts'
import type { Outcome } from './outcome.ts'
import { isAlive, readJson, writeJsonAtomic } from './runs.ts'
import { type Conductor, type Family, type RunState, SddError, TERMINAL } from './types.ts'
import { LOCK_FILE, artifactHash, headerHash, readFlow } from './sdd/read.ts'
import { hasEndMark } from './writer.ts'

/**
 * El almacén de control de un writer vive en el directorio de Git, que ningún writer puede escribir: el
 * sandbox de Codex lo protege y Claude en modo restringido lo trata como ruta sensible sin quién
 * apruebe. La reserva del checkout protege su árbol y HEAD; la común de refs serializa aplicaciones
 * de branch y commit. El almacén de cada corrida sigue siendo del checkout que la lanzó.
 */
export function storeRoot(root: string): string {
  return join(gitDirs(root).commonDir, 'sdd-ai')
}

/** El almacén de una corrida, resolviendo el directorio de Git de ahora: sirve para encontrar su control. */
export function storeDir(root: string, id: string): string {
  return join(gitDirs(root).gitDir, 'sdd-ai', 'runs', id)
}

/**
 * El almacén de una corrida con el directorio de Git que congeló su control al lanzar: después de leer el control,
 * nada vuelve a resolver un `.git` que el writer pudo cambiar. Un control del formato anterior no lo trae, y se
 * resuelve como antes.
 */
export function controlStore(root: string, control: Pick<WriterControl, 'id' | 'checkout'>): string {
  return control.checkout ? join(control.checkout.gitDir, 'sdd-ai', 'runs', control.id) : storeDir(root, control.id)
}

/** Lo que responde un comando que necesita escribir el almacén y no puede. */
export function controlUnavailable(): SddError {
  return new SddError('control_unavailable', 'sdd-ai no puede escribir el almacén de control del writer en el directorio de Git', {
    next: 'vuelve a correr el mismo comando pidiendo salir del sandbox (escalada): el almacén vive en el directorio de Git, que el sandbox deja en solo lectura',
  })
}

/**
 * Si el binario puede escribir la raíz de la reserva y el directorio de los almacenes. Dentro del
 * sandbox de un conductor Codex no puede: `run` falla cerrado y pide escalar.
 */
export function canWriteStore(root: string, checkout?: WriterControl['checkout']): boolean {
  const { gitDir, commonDir } = checkout ?? gitDirs(root)
  for (const dir of [join(commonDir, 'sdd-ai'), join(gitDir, 'sdd-ai', 'runs')]) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.probe.${process.pid}.${randomBytes(4).toString('hex')}`)
      writeFileSync(probe, '')
      unlinkSync(probe)
    } catch {
      return false
    }
  }
  return true
}

/**
 * Quién tiene la reserva: la corrida, el proceso que la tomó y el directorio de Git de su checkout. `kind`
 * es `verify` cuando la tomó `sdd verify` para revertir y restaurar filas; su `id` es el del recibo, y
 * `group`, el grupo de procesos de la fila que está corriendo.
 */
export interface Reservation { id: string; pid: number; lstart: string | null; gitDir: string; kind?: 'verify' | 'commit' | 'branch'; group?: number }

export type ReservationKind = 'writer' | 'verify' | 'branch' | 'commit'
export type ReservationDomain = 'checkout' | 'refs' | 'legacy'
export interface ReservationHandle {
  version: 1 | 2; domain: ReservationDomain; path: string; token?: string
  id: string; kind: ReservationKind; pid: number; lstart: string | null
  checkout: { root: string; gitDir: string; commonDir: string }
  group?: number
}
export interface ReservationConflict {
  domain: ReservationDomain; path: string; holder?: ReservationHandle; unreadable?: boolean
}
export interface AbandonedRelease { path: string; pid?: number; lstart?: string | null }
export type Acquisition = { ok: true; handles: ReservationHandle[] }
  | { ok: false; conflict: ReservationConflict } | { ok: false; abandoned: AbandonedRelease }
export type ReleaseResult = { state: 'released' | 'absent' | 'different' }
  | { state: 'retained'; code: 'release_busy' | 'release_abandoned' | 'release_failed'; path: string; detail: string; next: string }

/** Lee solo archivos regulares, sin seguir enlaces ni bloquearse en archivos especiales. */
function lockJson(file: string): unknown {
  if (!lstatSync(file).isFile()) throw new Error('la reserva no es un archivo regular')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('la reserva no es un archivo regular')
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

/**
 * Si la ruta está, o si no se puede acreditar que no está: cualquier error distinto de ENOENT (por ejemplo EACCES)
 * cuenta como presente, para que una reserva o un mutex que no se pueden leer se conserven.
 */
function pathPresent(file: string): boolean {
  try { lstatSync(file); return true } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}

function lockPath(checkout: ReservationHandle['checkout'], domain: ReservationDomain): string {
  return join(domain === 'checkout' ? checkout.gitDir : checkout.commonDir, 'sdd-ai', `${domain === 'legacy' ? 'writer' : domain}.lock`)
}

export function legacyHandle(checkout: ReservationHandle['checkout'], id: string, kind: ReservationKind = 'writer'): ReservationHandle {
  return { version: 1, domain: 'legacy', path: lockPath(checkout, 'legacy'), id, kind, pid: 0, lstart: null, checkout }
}

function readHandle(path: string, domain: ReservationDomain, checkout: ReservationHandle['checkout']): ReservationHandle | undefined {
  try {
    const v = lockJson(path) as ReservationHandle & Reservation
    if (!v || typeof v.id !== 'string' || !Number.isInteger(v.pid) || v.pid <= 1
      || (v.lstart !== null && typeof v.lstart !== 'string')) return undefined
    if (domain === 'legacy') {
      if (typeof v.gitDir !== 'string' || ![undefined, 'verify', 'branch', 'commit'].includes(v.kind)) return undefined
      let root = checkout.root
      if (v.gitDir !== checkout.gitDir) {
        // El protocolo anterior solo congelaba gitDir: su backlink identifica el checkout enlazado. Sin backlink (un
        // worktree podado) la raíz no se puede saber: el principal es el padre del directorio común, y para un
        // enlazado queda su directorio Git. Esa raíz solo nombra al titular en los diagnósticos; las rutas que se
        // arman con ella (el lock de un flujo) se comprueban antes de mostrarse.
        try { root = dirname(readFileSync(join(v.gitDir, 'gitdir'), 'utf8').trim()) }
        catch { root = v.gitDir === checkout.commonDir ? dirname(checkout.commonDir) : v.gitDir }
      }
      return { ...legacyHandle({ ...checkout, root, gitDir: v.gitDir }, v.id, v.kind ?? 'writer'), pid: v.pid, lstart: v.lstart,
        ...(v.group !== undefined ? { group: v.group } : {}) }
    }
    if (v.version !== 2 || v.domain !== domain || v.path !== path || typeof v.token !== 'string'
      || !['writer', 'verify', 'branch', 'commit'].includes(v.kind) || !v.checkout
      || typeof v.checkout.root !== 'string' || typeof v.checkout.gitDir !== 'string' || typeof v.checkout.commonDir !== 'string'
      || lockPath(v.checkout, domain) !== path) return undefined
    return v
  } catch { return undefined }
}

function sameReservation(a: ReservationHandle, b: ReservationHandle): boolean {
  return a.path === b.path && a.version === b.version && a.domain === b.domain && a.id === b.id && a.kind === b.kind
    && a.checkout.gitDir === b.checkout.gitDir && (a.version === 1 || (a.token === b.token
      && a.checkout.root === b.checkout.root && a.checkout.commonDir === b.checkout.commonDir && a.pid === b.pid && a.lstart === b.lstart))
}

export function inspectReservations(root: string, domains: readonly ('checkout' | 'refs')[], ownHandles: readonly ReservationHandle[] = []): ReservationConflict | null {
  const checkout = { root, ...gitDirs(root) }
  for (const domain of ['legacy' as const, ...domains]) {
    const path = lockPath(checkout, domain)
    if (!pathPresent(path)) continue
    const holder = readHandle(path, domain, checkout)
    if (holder && ownHandles.some((own) => sameReservation(holder, own))) continue
    return { domain, path, ...(holder ? { holder } : { unreadable: true }) }
  }
  return null
}

/**
 * La reserva de este checkout: la de su `checkout.lock` o, si no hay, el `writer.lock` legacy que tomó este mismo
 * checkout. Se lee por separado de los conflictos, sin atribuir locks ilegibles.
 */
export function ownReservation(root: string, kind?: ReservationKind, id?: string): ReservationHandle | undefined {
  const checkout = { root, ...gitDirs(root) }
  for (const domain of ['checkout', 'legacy'] as const) {
    const handle = readHandle(lockPath(checkout, domain), domain, checkout)
    if (handle && handle.checkout.gitDir === checkout.gitDir && (!kind || handle.kind === kind) && (!id || handle.id === id)) return handle
  }
  return undefined
}

function releaseOwner(path: string): { pid: number; lstart: string | null } | undefined {
  try {
    const owner = lockJson(path) as { pid: number; lstart: string | null }
    return owner && Number.isInteger(owner.pid) && owner.pid > 1 && (owner.lstart === null || typeof owner.lstart === 'string') ? owner : undefined
  } catch { return undefined }
}

function abandonedRelease(path: string): AbandonedRelease | null {
  if (!pathPresent(path)) return null
  const owner = releaseOwner(path)
  if (!owner) return pathPresent(path) ? { path } : null
  // Abandonado es solo un titular que ya no corre. Sin hora o sin ps no se acredita el cese, y el mutex se trata
  // como el de un liberador vivo: se espera, y al vencer la espera la reserva queda retenida, no abandonada.
  return processAlive(owner.pid, owner.lstart) ? null : { path, ...owner }
}

/** El error de una reserva tomada: su código dice si se espera a un writer o verify, a branch o commit, o a un mutex. */
export type ReservationError = SddError & { code: 'writer_open' | 'refs_busy' | 'release_abandoned' }

export function reservationError(conflict: ReservationConflict | AbandonedRelease): ReservationError {
  const fail = (code: ReservationError['code'], message: string, opts: { detail?: string; next?: string }) =>
    Object.assign(new SddError(code, message, opts), { code })
  if (!('domain' in conflict)) return fail('release_abandoned', `el mutex de liberación requiere resolución manual: ${conflict.path}`, {
    detail: `pid: ${conflict.pid ?? 'desconocido'}; no se pudo acreditar un liberador vivo`,
    next: `comprueba que su proceso ya no corre y borra manualmente ${conflict.path}; después repite el comando`,
  })
  const h = conflict.holder
  if (!h) return fail(conflict.domain === 'refs' ? 'refs_busy' : 'writer_open', `reserva ilegible conservada en ${conflict.path}`, {
    next: `inspecciona ${conflict.path} y acredita el cese de su operación antes de liberarla manualmente`,
  })
  const refs = h.kind === 'branch' || h.kind === 'commit'
  const paths = refs && h.version === 2 ? ['checkout', 'refs'].flatMap((domain) => {
    const path = lockPath(h.checkout, domain as 'checkout' | 'refs')
    const other = readHandle(path, domain as 'checkout' | 'refs', h.checkout)
    return other && sameReservation(other, { ...h, path, domain: domain as 'checkout' | 'refs' }) ? [path] : []
  }) : [h.path]
  const alive = processAlive(h.pid, h.lstart)
  const observed = h.lstart === null ? undefined : readProcess(h.pid)
  const uncertain = alive && (h.lstart === null || observed === undefined)
  // Branch y commit reservan con el id `branch-<flujo>` y `commit-<flujo>` (src/sdd/branch.ts y src/sdd/commit.ts):
  // de ahí sale el flujo cuyo lock también puede haber quedado. Un id que no siga esa forma no nombra ningún lock.
  const flow = h.id.startsWith(`${h.kind}-`) ? h.id.slice(h.kind.length + 1) : ''
  const ancillary = [
    ...(refs && FLOW_ID.test(flow) ? [join(h.checkout.root, '.plans', flow, LOCK_FILE)] : []),
    join(h.checkout.gitDir, 'sdd-ai', 'verify', 'restore.lock'),
  ].filter((path) => pathPresent(path))
  return fail(refs && h.version === 2 ? 'refs_busy' : 'writer_open',
    `reserva tomada por ${h.kind} ${h.id}; pid ${h.pid}; checkout ${h.checkout.root}; Git ${h.checkout.gitDir}`, {
      detail: [...paths, ...(uncertain ? ['no se pudo acreditar la identidad o el cese del proceso titular'] : [])].join('\n'),
      next: holderNext(h, refs, alive && !uncertain, paths, ancillary),
    })
}

/** Un id de flujo válido: el mismo segmento que admite `.plans/<id>/`. */
const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Qué hacer ante una reserva tomada, según quién la tiene y si su titular sigue vivo. */
function holderNext(h: ReservationHandle, refs: boolean, alive: boolean, paths: string[], ancillary: string[]): string {
  if (refs && alive) return `reintenta cuando termine ${h.kind} ${h.id} en ${h.checkout.root}`
  if (refs) {
    const locks = ancillary.length ? ` (${ancillary.join(', ')})` : ''
    return `comprueba el cese del proceso, hooks e hijos de ${h.kind} ${h.id}; borra manualmente ${paths.join(' y ')}. `
      + `Revisa por separado los locks de flujo/restauración${locks}, después de acreditar el cese de sus titulares; `
      + 'limpiar no deshace Git ni completa el flujo. Después repite la aplicación'
  }
  if (h.kind === 'verify') return 'espera a que termine verify o ejecuta su recuperación habitual tras el cese de la fila'
  return `recibe o cancela la corrida desde su checkout: ./bin/sdd-ai wait ${h.id}`
}

/** Publicación completa y exclusiva: ningún lector ve un JSON a medio escribir. */
function publishLock(path: string, value: unknown): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx' })
  try {
    linkSync(tmp, path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    return false
  } finally {
    // El temporal se borra siempre, también si link falló. Si borrarlo falla, la publicación que ya ocurrió no se
    // deshace: queda un resto inofensivo y el resultado es el de link.
    try { unlinkSync(tmp) } catch { /* El lock ya está publicado o ya se rechazó. */ }
  }
}

/** Cuánto espera un liberador a que otro suelte el mutex de liberación, y cada cuánto vuelve a probar. */
const RELEASE_WAIT_MS = 5000
const RELEASE_RETRY_MS = 50

export function releaseReservation(handle: ReservationHandle): ReleaseResult {
  const mutex = `${handle.path}.release`
  let acquired = false
  const retained = (code: 'release_busy' | 'release_abandoned' | 'release_failed', detail: string): ReleaseResult => ({
    state: 'retained', code, path: mutex, detail,
    // Sin el mutex tomado, la falla es de escritura (por ejemplo, un sandbox): no hay un mutex que borrar.
    next: code === 'release_failed' && !acquired
      ? `conserva ${handle.path}; la liberación queda para un proceso que pueda escribir ${dirname(handle.path)}: repite wait o cancel con ese permiso`
      : `conserva ${handle.path}; comprueba el cese del liberador antes de borrar manualmente ${mutex}, y repite la liberación habitual`,
  })
  const seen = readProcess(process.pid)
  const owner = { pid: process.pid, lstart: seen && seen !== 'gone' ? seen.lstart : null, token: randomBytes(16).toString('hex') }
  try {
    const until = Date.now() + RELEASE_WAIT_MS
    for (;;) {
      if (!pathPresent(handle.path)) return { state: 'absent' }
      if (publishLock(mutex, owner)) { acquired = true; break }
      if (abandonedRelease(mutex)) return retained('release_abandoned', `mutex abandonado o ilegible: ${mutex}`)
      if (Date.now() >= until) return retained('release_busy', `otro liberador sigue teniendo ${mutex}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RELEASE_RETRY_MS)
    }
    // La relectura y el unlink están bajo el mismo mutex: dos liberadores no pueden borrar una
    // reserva posterior a la que compararon. Esta garantía requiere inspección de la sección crítica.
    const current = readHandle(handle.path, handle.domain, handle.checkout)
    if (!current) return pathPresent(handle.path) ? retained('release_failed', 'reserva ilegible conservada') : { state: 'absent' }
    if (!sameReservation(current, handle)) return { state: 'different' }
    try { unlinkSync(handle.path) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    return { state: 'released' }
  } catch (e) { return retained('release_failed', String(e)) } finally {
    if (acquired) {
      try {
        const current = lockJson(mutex) as typeof owner
        if (current.token === owner.token && current.pid === owner.pid && current.lstart === owner.lstart) unlinkSync(mutex)
      } catch { /* Un mutex desaparecido ya está liberado; uno alterado se conserva. */ }
    }
  }
}

/** El error de una adquisición rechazada, por una reserva tomada o por un mutex abandonado. */
export function acquisitionError(a: Exclude<Acquisition, { ok: true }>): ReservationError {
  return reservationError('conflict' in a ? a.conflict : a.abandoned)
}

/** Libera los handles de una aplicación en el orden inverso al que se tomaron, sin alterar el arreglo. */
export function releaseAll(handles: readonly ReservationHandle[]): void {
  for (const handle of [...handles].reverse()) releaseAndReport(handle)
}

/** Los finally conservan la entrega y hacen visible una liberación retenida. */
export function releaseAndReport(handle: ReservationHandle): ReleaseResult {
  const result = releaseReservation(handle)
  if (result.state === 'retained') process.stderr.write(`${result.code}: ${result.detail}; ${result.next}\n`)
  return result
}

export function acquireReservation(root: string, id: string, kind: ReservationKind): Acquisition {
  const checkout = { root: realpathSync(root), ...gitDirs(root) }
  const domains: ('checkout' | 'refs')[] = kind === 'branch' || kind === 'commit' ? ['checkout', 'refs'] : ['checkout']
  const handles: ReservationHandle[] = []
  const seen = readProcess(process.pid)
  const token = randomBytes(24).toString('hex')
  let success = false
  try {
    const legacy = inspectReservations(root, [])
    if (legacy) return { ok: false, conflict: legacy }
    for (const domain of domains) {
      const path = lockPath(checkout, domain)
      const abandoned = abandonedRelease(`${path}.release`)
      if (abandoned) return { ok: false, abandoned }
      mkdirSync(dirname(path), { recursive: true })
      // lstat no sigue el enlace: un enlace en lugar del directorio tampoco es un directorio.
      if (!lstatSync(dirname(path)).isDirectory()) throw controlUnavailable()
      const h: ReservationHandle = { version: 2, domain, token, path, id, kind, pid: process.pid,
        lstart: seen && seen !== 'gone' ? seen.lstart : null, checkout }
      // Si el titular libera entre el link fallido y la lectura, no hay a quién nombrar: se vuelve a probar.
      let taken = false
      for (let attempt = 0; attempt < 3 && !taken; attempt++) {
        if (publishLock(path, h)) { taken = true; break }
        const holder = readHandle(path, domain, checkout)
        if (holder || pathPresent(path)) return { ok: false, conflict: { domain, path, ...(holder ? { holder } : { unreadable: true }) } }
      }
      if (!taken) return { ok: false, conflict: { domain, path, unreadable: true } }
      handles.push(h)
    }
    const legacyAfter = inspectReservations(root, [], handles)
    if (legacyAfter) return { ok: false, conflict: legacyAfter }
    success = true
    return { ok: true, handles }
  } finally { if (!success) releaseAll(handles) }
}

export function controlReservation(control: WriterControl): ReservationHandle {
  return control.reservation ?? legacyHandle(control.checkout, control.id)
}

const lockOf = (root: string) => join(storeRoot(root), 'writer.lock')

export function readReservation(root: string): Reservation | undefined {
  try {
    return lockJson(lockOf(root)) as Reservation
  } catch {
    return undefined
  }
}

/**
 * Si el proceso sigue vivo: con su hora de arranque, es el mismo si `ps` lo encuentra con esa hora. Si `ps`
 * no responde, o no hay hora, solo se comprueba el pid: un pid reciclado cuenta como vivo, y lo que depende
 * de esta respuesta se retiene en vez de liberarse.
 */
export function processAlive(pid: number, lstart: string | null): boolean {
  if (lstart !== null) {
    const seen = readProcess(pid)
    if (seen !== undefined) return seen !== 'gone' && seen.lstart === lstart
  }
  return isAlive(pid)
}

/**
 * Anota en la reserva de la verificación `id` el grupo de la fila que acaba de lanzar, o lo quita con
 * `null` cuando la fila terminó. La reserva de otra corrida no se toca.
 */
export function recordVerifyGroup(root: string, id: string, pgid: number | null, handle?: ReservationHandle): void {
  const own = handle ?? ownReservation(root, 'verify', id)
  if (!own) return
  const current = readHandle(own.path, own.domain, own.checkout)
  if (!current || !sameReservation(current, own) || current.kind !== 'verify') return
  const r = lockJson(own.path) as ReservationHandle | Reservation
  const { group: _previous, ...rest } = r
  writeJsonAtomic(own.path, pgid === null ? rest : { ...rest, group: pgid })
}

/**
 * El grupo de la fila que la verificación `id` dejó corriendo, si sigue vivo. Un `sdd verify` que muere
 * con SIGKILL no alcanza a terminar el grupo de su fila, que corre aparte y puede seguir escribiendo en el
 * árbol: mientras viva, ni la reserva ni la restauración se liberan.
 */
export function liveVerifyGroup(root: string, id: string, handle?: ReservationHandle): number | null {
  const own = handle ?? ownReservation(root, 'verify', id)
  if (!own) return null
  const uncertain = (what: string) => new SddError('verify_in_progress', `no se puede acreditar el cese de ${what} registrado en ${own.path}`, {
    next: `inspecciona ${own.path} y acredita el cese de su fila antes de recuperar la verificación`,
  })
  // Una sola lectura: el handle trae el grupo, también el de una reserva legacy.
  const current = readHandle(own.path, own.domain, own.checkout)
  if (!current) {
    if (pathPresent(own.path)) throw uncertain('la fila')
    return null
  }
  if (!sameReservation(current, own) || current.kind !== 'verify') throw uncertain('la fila')
  if (current.group === undefined) return null
  // `kill(-1)` alcanza a todos los procesos del usuario y `kill(-0)` al grupo propio: nunca se consultan.
  if (!Number.isInteger(current.group) || current.group <= 1) throw uncertain('el grupo')
  try {
    process.kill(-current.group, 0)
    return current.group
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? null : current.group
  }
}

/**
 * Libera la reserva si la tomó una verificación cuyo proceso ya murió y cuya última fila ya no corre, y dice
 * si la liberó. Una reserva de writer nunca se toca acá: la resuelven `wait` y `cancel` de su corrida.
 */
export function releaseOrphanVerifyReservation(root: string): boolean {
  const checkout = { root, ...gitDirs(root) }
  // La propia puede ser la legacy: cada reserva se revisa una sola vez.
  const own = ownReservation(root, 'verify')
  const legacy = readHandle(lockPath(checkout, 'legacy'), 'legacy', checkout)
  let released = false
  for (const h of [own, legacy?.path === own?.path ? undefined : legacy]) {
    if (!h || h.kind !== 'verify' || processAlive(h.pid, h.lstart) || liveVerifyGroup(root, h.id, h) !== null) continue
    const result = releaseAndReport(h)
    if (result.state === 'released') released = true
  }
  return released
}

export interface InventoryEntry { type: 'file' | 'dir' | 'link'; mode: number; hash?: string; target?: string }
/**
 * Una diferencia de la cosecha. Las físicas traen `before` y `after`; las de significado de HEAD o de una rama
 * vigilada traen `kind`, `ref`, `ref_before` y `ref_after` en texto, y `error` cuando la lectura falló.
 */
export interface Flagged { path: string; before?: InventoryEntry; after?: InventoryEntry; kind?: 'head' | 'ref'; ref?: string; ref_before?: string; ref_after?: string; error?: string }
/** El grupo de procesos del writer, para acreditar que un grupo vivo sigue siendo el suyo. */
export interface GroupIdentity { pid: number; pgid: number; lstart: string | null; argvHash: string }

export interface WriterControl {
  id: string; base: string; family: Family
  /** El encargo del conductor, tal como llegó a `run`. */
  prompt: string
  /** La sesión dueña, si la hay. */
  session?: string
  /** Rutas reales al lanzar: `wait`, `cancel`, `--retry` y la captura usan estas. */
  checkout: { root: string; gitDir: string; commonDir: string }
  request: { role: 'implement'; families?: string; model?: string; effort?: string; conductor: Conductor; deadline_sec: number }
  /** La corrida visible tal como quedó antes de lanzar: después, sdd-ai no escribe ahí. */
  preLaunch: Record<string, InventoryEntry>
  /** Cuándo empezó el supervisor a lanzar al writer. */
  spawning?: string
  inventory: Record<string, InventoryEntry>
  reservation?: ReservationHandle
  git_state?: GitState
  runDir: { dev: number; ino: number }
  group?: GroupIdentity
  /** Un writer de fase: el flujo, las tasks pendientes y las huellas de sus insumos al lanzar. */
  phase?: PhaseControl
}

/** De dónde parte el árbol de una corrida encadenada: la cosecha de otra corrida o una toma. Sin él, de la base. */
export type LaunchFrom = { run: string } | { takeover: { ref: string; digest: string } }

/**
 * El vínculo de un writer con su fase. Un control sin `kind` es de un writer lanzado antes de las cadenas:
 * se admite con el contrato anterior y no sirve de padre.
 */
export interface PhaseControl {
  flow: string; pending: string[]; inputs: Record<string, string>; handoff_header: string
  kind?: 'implement' | 'continuation' | 'block' | 'fix'
  chain?: string
  /** El eslabón del que parte (una corrida o una toma), o `null` en la primera cadena con el árbol limpio. */
  parent?: string | null
  /** Cómo se obtiene el árbol del que parte; sin él, el de la base. */
  launch_from?: LaunchFrom
  /** La corrida interrumpida que esta reanuda. */
  resumes?: string
  /** La corrida que abrió la sesión que esta usa: la propia si abre una sesión nueva. */
  session_origin?: string
  /** El digest del registro de fases al lanzar, después de registrar esta corrida. */
  registry?: string
  /** En un `fix`: el recibo de entrada, las filas enviadas y los tramos recortados del encargo. */
  fix?: { receipt: { id: string; digest: string }; rows: { id: string; test_paths?: string[] }[]; trimmed: string[] }
}

const controlFile = (root: string, id: string) => join(storeDir(root, id), 'control.json')

export function writeControl(root: string, c: WriterControl): void {
  const store = controlStore(root, c)
  mkdirSync(store, { recursive: true })
  writeJsonAtomic(join(store, 'control.json'), c)
}

export function readControl(root: string, id: string): WriterControl {
  const file = controlFile(root, id)
  if (!existsSync(file)) {
    throw new SddError('run_not_found', `no existe la corrida ${id} en este checkout`, { next: 'revisa el id y corre el comando desde el checkout que la lanzó' })
  }
  // Una vez leído el control protegido, quien siga con esta corrida usa `controlStore` y no vuelve a resolver .git.
  return readJson<WriterControl>(file)
}

/** Si existe el control de un writer con ese id en este checkout. */
export function isWriterRun(root: string, id: string): boolean {
  try {
    return existsSync(controlFile(root, id))
  } catch {
    return false
  }
}

export function recordGroup(root: string, id: string, g: GroupIdentity): void {
  writeControl(root, { ...readControl(root, id), group: g })
}

const hashOf = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** Una entrada del inventario, sin seguir enlaces. */
export function entryOf(abs: string): InventoryEntry | undefined {
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return undefined
  }
  const mode = st.mode & 0o7777
  if (st.isSymbolicLink()) return { type: 'link', mode, target: readlinkSync(abs) }
  if (st.isDirectory()) return { type: 'dir', mode }
  return { type: 'file', mode, hash: hashOf(readFileSync(abs)) }
}

/**
 * Recorre `dir` sin seguir enlaces y deja cada entrada bajo `prefix`. `skip` excluye el contenido de
 * nombres de primer nivel, pero no que se hayan vuelto un enlace: un directorio excluido reemplazado por
 * un enlace sale en el inventario.
 */
export function walkInto(out: Record<string, InventoryEntry>, dir: string, prefix: string, skip: ReadonlySet<string> = new Set()): void {
  const top = entryOf(dir)
  if (!top) return
  out[prefix] = top
  if (top.type !== 'dir') return
  const visit = (abs: string, key: string, first: boolean) => {
    for (const name of readdirSync(abs)) {
      if (first && skip.has(name)) {
        const e = entryOf(join(abs, name))
        if (e?.type === 'link') out[`${key}/${name}`] = e
        continue
      }
      const e = entryOf(join(abs, name))
      if (!e) continue
      out[`${key}/${name}`] = e
      if (e.type === 'dir') visit(join(abs, name), `${key}/${name}`, false)
    }
  }
  visit(dir, prefix, true)
}

/** Lo que sdd-ai y Git escriben por su cuenta mientras el writer corre; el almacén, además. */
const SDD_SKIP = new Set(['runs', 'hooks', 'tmp', 'projection'])
const GIT_SKIP = new Set(['index', 'objects', 'logs', 'sdd-ai', 'worktrees'])

/**
 * Las rutas sensibles del checkout: `.claude/`, `.codex/`, `.agents/`, `.sdd-ai/` y, en un worktree, el
 * archivo `.git`, con claves relativas a la raíz; el directorio de Git del checkout y el común, con
 * claves absolutas. Lo ignorado entra igual. Después de lanzar se pasan los directorios registrados:
 * volver a resolverlos leería el archivo `.git` que el writer pudo cambiar.
 */
export function sensitiveInventory(root: string, dirs: { gitDir: string; commonDir: string } = gitDirs(root)): Record<string, InventoryEntry> {
  const out: Record<string, InventoryEntry> = {}
  for (const d of ['.claude', '.codex', '.agents']) walkInto(out, join(root, d), d)
  walkInto(out, join(root, '.sdd-ai'), '.sdd-ai', SDD_SKIP)
  const dotGit = entryOf(join(root, '.git'))
  if (dotGit?.type === 'file') out['.git'] = dotGit
  const { gitDir, commonDir } = dirs
  walkInto(out, commonDir, commonDir, GIT_SKIP)
  if (gitDir !== commonDir) walkInto(out, gitDir, gitDir, GIT_SKIP)
  return out
}

/** Inventario nuevo: las refs se comparan por significado y el estado ajeno tiene exclusiones cerradas. */
export function sensitiveInventoryV2(root: string, dirs: { gitDir: string; commonDir: string } = gitDirs(root)): Record<string, InventoryEntry> {
  const out: Record<string, InventoryEntry> = {}
  for (const d of ['.claude', '.codex', '.agents']) walkInto(out, join(root, d), d)
  walkInto(out, join(root, '.sdd-ai'), '.sdd-ai', SDD_SKIP)
  const dotGit = entryOf(join(root, '.git'))
  if (dotGit?.type === 'file') out['.git'] = dotGit
  // Otro checkout puede borrar un directorio de refs mientras se recorre: uno que ya no está no tiene entradas.
  const list = (dir: string): string[] => {
    try { return readdirSync(dir) } catch (e) {
      if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return []
      throw e
    }
  }
  const refLinks = (dir: string) => {
    for (const name of list(dir)) {
      const path = join(dir, name)
      const entry = entryOf(path)
      if (entry?.type === 'link') out[path] = entry
      else if (entry?.type === 'dir') refLinks(path)
    }
  }
  const visit = (dir: string, base: string, foreign: boolean) => {
    const top = entryOf(dir)
    if (!top) return
    out[dir] = top
    if (top.type !== 'dir') return
    for (const name of list(dir)) {
      const path = join(dir, name)
      const rel = path.slice(base.length + 1)
      const entry = entryOf(path)
      if (!entry) continue
      const skip = GIT_SKIP.has(rel) || rel === 'refs' || rel.startsWith('refs/') || rel === 'packed-refs'
        || rel === 'HEAD' || rel === 'gc.log' || rel === 'gc.pid' || rel === 'rr-cache' || rel.endsWith('.lock')
        || (foreign && isWorktreeStatePath(rel))
      // Un enlace en una ruta excluida sigue siendo una diferencia estructural sensible.
      if (skip && entry.type !== 'link') {
        if (rel === 'refs' && entry.type === 'dir') refLinks(path)
        continue
      }
      out[path] = entry
      if (entry.type === 'dir') visit(path, base, foreign)
    }
  }
  visit(dirs.commonDir, dirs.commonDir, dirs.gitDir !== dirs.commonDir)
  if (dirs.gitDir !== dirs.commonDir) visit(dirs.gitDir, dirs.gitDir, false)
  return out
}

const headText = (h: GitState['head']) => `${h.target ?? 'detached'} ${h.commit}`
const refText = (r: GitState['refs'][string]) => r.exists ? `${r.symbolic ? `${r.symbolic} ` : ''}${r.object && r.object !== r.commit ? `${r.object} ` : ''}${r.commit}` : 'absent'

/**
 * Las diferencias de significado de HEAD y de cada rama vigilada, leídas por separado: una lectura que falla se
 * publica en su propio recurso, con el error, y nunca pasa por una cosecha íntegra.
 */
function semanticDifferences(checkout: WriterControl['checkout'], before: GitState): Flagged[] {
  const out: Flagged[] = []
  const unreadable = (path: string, kind: 'head' | 'ref', refBefore: string, e: unknown): Flagged =>
    ({ path, kind, ref: path, ref_before: refBefore, ref_after: 'unreadable', error: (e as Error).message })
  try {
    const head = readHeadState(checkout)
    if (JSON.stringify(before.head) !== JSON.stringify(head)) out.push({ path: 'HEAD', kind: 'head', ref: 'HEAD', ref_before: headText(before.head), ref_after: headText(head) })
  } catch (e) {
    out.push(unreadable('HEAD', 'head', headText(before.head), e))
  }
  for (const [ref, state] of Object.entries(before.refs)) {
    let now: GitState['refs'][string]
    try {
      now = readRefState(checkout, ref)
    } catch (e) {
      out.push(unreadable(ref, 'ref', refText(state), e))
      continue
    }
    if (JSON.stringify(state) !== JSON.stringify(now)) out.push({ path: ref, kind: 'ref', ref, ref_before: refText(state), ref_after: refText(now) })
  }
  if (before.replace) {
    try {
      const now = readReplaceRefs(checkout)
      for (const ref of [...new Set([...Object.keys(before.replace), ...Object.keys(now)])].sort()) {
        if (before.replace[ref] !== now[ref]) out.push({ path: ref, kind: 'ref', ref, ref_before: before.replace[ref] ?? 'absent', ref_after: now[ref] ?? 'absent' })
      }
    } catch (e) {
      const known = Object.keys(before.replace)
      out.push(unreadable('refs/replace/', 'ref', known.length ? `${known.length} reemplazos: ${known.join(', ')}` : 'sin reemplazos', e))
    }
  }
  return out
}

export function diffInventory(before: Record<string, InventoryEntry>, after: Record<string, InventoryEntry>): Flagged[] {
  const out: Flagged[] = []
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[path]
    const a = after[path]
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    const f: Flagged = { path }
    if (b) f.before = b
    if (a) f.after = a
    out.push(f)
  }
  return out
}

/**
 * Lo que `ps` dice de un proceso: su grupo, su hora de inicio y el hash de su línea de comando. `gone`
 * si no existe; nada si no hay `ps`. `LC_ALL=C` fija el formato de la hora.
 */
export function readProcess(pid: number): { pgid: number; lstart: string; argvHash: string } | 'gone' | undefined {
  let out: string
  try {
    out = execFileSync('ps', ['-ww', '-o', 'pgid=,lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    })
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'gone'
  }
  // `lstart` ocupa siempre cinco campos: día, mes, día del mes, hora y año.
  const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s(.*)$/.exec(out.split('\n')[0] ?? '')
  if (!m) return 'gone'
  return { pgid: Number(m[1]), lstart: m[2], argvHash: hashOf(m[3].trim()) }
}

const validGroup = (g: GroupIdentity) => Number.isInteger(g.pgid) && g.pgid > 1 && Number.isInteger(g.pid) && g.pid > 1

/** `gone` cuando el grupo ya no tiene procesos; `unknown` si existe pero no se puede consultar. */
export function groupState(g: GroupIdentity): 'gone' | 'alive' | 'unknown' {
  // `kill(-1)` alcanza a todos los procesos del usuario y `kill(-0)` al grupo propio: nunca se consultan.
  if (!validGroup(g)) return 'unknown'
  try {
    process.kill(-g.pgid, 0)
    return 'alive'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

/**
 * Si el líder del grupo sigue siendo el writer: los cuatro datos tienen que coincidir. Sin `ps`, o sin
 * la hora de inicio registrada, no afirma nada.
 */
export function leaderMatches(g: GroupIdentity): boolean | undefined {
  if (g.lstart === null || !validGroup(g)) return undefined
  const seen = readProcess(g.pid)
  if (seen === undefined) return undefined
  if (seen === 'gone') return false
  return seen.pgid === g.pgid && seen.lstart === g.lstart && seen.argvHash === g.argvHash
}

/**
 * La cosecha congelada de un writer, que es también el terminal de su corrida. `patchFile` es la ruta
 * absoluta del `diff.patch` en el almacén.
 */
export interface HarvestRecord {
  state: RunState; reason?: string; detail?: string
  base: string; tree: string; files: HarvestFile[]; patchFile: string
  flagged: Flagged[]; runAltered: Flagged[]; headMoved: boolean
  report?: string; endMark: boolean
  /** En un writer de fase, si la spec, el plan, las tasks o el header del handoff siguen como al lanzar. */
  phase_inputs?: 'unchanged' | 'changed'
  /** En un writer de cadena: el mapa del árbol cosechado sin el directorio del flujo, y las rutas que cambió frente a su padre. */
  entries?: Record<string, string>
  delta?: string[]
  /** El delta no se pudo medir (sin el árbol cosechado o sin el del padre): va vacío y no acredita tasks. */
  delta_unmeasured?: true
}

/** La corrida visible, `.sdd-ai/runs/<id>/`, con claves relativas a ella. */
export function runInventory(root: string, id: string): Record<string, InventoryEntry> {
  const out: Record<string, InventoryEntry> = {}
  walkInto(out, join(root, '.sdd-ai', 'runs', id), '.')
  return out
}

/** El directorio de la corrida visible: si el writer lo reemplazó, su inodo cambió. */
export function runDirIdentity(root: string, id: string): { dev: number; ino: number } | undefined {
  try {
    const st = lstatSync(join(root, '.sdd-ai', 'runs', id))
    return { dev: st.dev, ino: st.ino }
  } catch {
    return undefined
  }
}

const harvestFile = (dir: string) => join(dir, 'harvest.json')

export function readHarvest(root: string, id: string): HarvestRecord | undefined {
  const file = harvestFile(storeDir(root, id))
  return existsSync(file) ? readJson<HarvestRecord>(file) : undefined
}

/** Un impedimento de lectura conserva la ruta que no pudo comprobarse. */
export function activityUnknown(path: string, cause: unknown): SddError {
  return new SddError('activity_unknown', 'no se puede descartar actividad del flujo', {
    detail: `${path}: ${cause instanceof SddError && cause.detail ? cause.detail : cause instanceof Error ? cause.message : String(cause)}`,
    next: `restablece la lectura de ${path}, o recibe o cancela la corrida, y repite sdd approve`,
  })
}

/** Solo ENOENT acredita ausencia; no abre enlaces ni archivos especiales. */
export function activityPath(path: string, directory = false, list = true): boolean {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !(directory ? st.isDirectory() : st.isFile())) throw new Error('ruta especial o enlace')
    if (directory && list) readdirSync(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw activityUnknown(path, e)
  }
}

/** Lee JSON regular sin seguir enlaces ni bloquearse si el archivo cambió por una ruta especial. */
export function readActivityJson<T>(path: string): T {
  let fd: number | undefined
  try {
    if (!activityPath(path)) throw new Error('el archivo desapareció durante la comprobación')
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) throw new Error('ruta especial')
    return JSON.parse(readFileSync(fd, 'utf8')) as T
  } catch (e) {
    if (e instanceof SddError && e.code === 'activity_unknown') throw e
    throw activityUnknown(path, e)
  } finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * El control de la entrada `runDir` del almacén, leído en modo estricto. `null` si la entrada no es un
 * writer (no es un directorio o no tiene control.json). Un control ilegible, o una fase sin flujo, lanza
 * `activity_unknown`: no se puede decidir a qué flujo pertenece.
 */
function strictControl(runDir: string): WriterControl | null {
  let st
  try {
    st = lstatSync(runDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw activityUnknown(runDir, e)
  }
  // Un archivo suelto no es un writer; un enlace o una ruta especial no deja afirmar que no lo sea.
  if (st.isFile()) return null
  activityPath(runDir, true)
  const file = join(runDir, 'control.json')
  if (!activityPath(file)) return null
  const c = readActivityJson<WriterControl>(file)
  if (!c || typeof c !== 'object') throw activityUnknown(file, 'el control no es un objeto')
  if (c.id !== basename(runDir)) throw activityUnknown(file, 'el id del control no es el de su entrada')
  if (c.phase !== undefined && (!c.phase || typeof c.phase.flow !== 'string')) throw activityUnknown(file, 'pertenencia indeterminable')
  return c
}

/**
 * Si el writer `c`, leído de la entrada `runDir`, sigue abierto en modo estricto: sin cosecha, con una
 * cosecha no comprobable o con su grupo vivo. La cosecha se busca en la entrada recorrida, no en una ruta
 * que se derive del contenido del control.
 */
function strictWriterOpen(runDir: string, c: WriterControl): boolean {
  const file = join(runDir, 'harvest.json')
  if (!activityPath(file)) return true
  const h = readActivityJson<HarvestRecord>(file)
  if (!h || typeof h !== 'object' || !TERMINAL.has(h.state) || typeof h.tree !== 'string' || !Array.isArray(h.files)) {
    throw activityUnknown(file, 'cosecha no comprobable')
  }
  return c.group !== undefined && groupState(c.group) !== 'gone'
}

/**
 * Si el writer `id` sigue abierto, en modo estricto. `null` si no hay un writer con ese id en el almacén:
 * quien pregunta decide si eso es ausencia.
 */
export function writerRunOpenStrict(root: string, id: string): boolean | null {
  const store = storeDir(root, id)
  activityPath(dirname(dirname(store)), true)
  const c = strictControl(store)
  return c === null ? null : strictWriterOpen(store, c)
}

/**
 * Los writers de este checkout que lanzó la fase implement de `flow`, del más viejo al más nuevo. Un
 * writer relanzado con `run --retry` no guarda `phase` y no se atribuye al flujo.
 */
export function flowWriterRuns(root: string, flow: string, strict = false): WriterControl[] {
  const dir = join(gitDirs(root).gitDir, 'sdd-ai', 'runs')
  if (strict && !activityPath(dirname(dir), true)) return []
  if (strict ? !activityPath(dir, true) : !existsSync(dir)) return []
  const out: WriterControl[] = []
  let ids: string[]
  try { ids = readdirSync(dir) } catch (e) { if (strict) throw activityUnknown(dir, e); throw e }
  for (const id of ids) {
    if (strict) {
      // Como en el camino normal, un writer es una entrada con control.json, y el flujo sale de su fase:
      // lo legible y ajeno se omite. Solo un control que no se puede leer deja la pertenencia sin decidir.
      const c = strictControl(join(dir, id))
      if (c !== null && c.phase?.flow === flow) out.push(c)
      continue
    }
    if (!isWriterRun(root, id)) continue
    const c = readControl(root, id)
    if (c.phase?.flow === flow) out.push(c)
  }
  // El id ordena por minuto; dentro del mismo minuto manda la hora en que el supervisor empezó a lanzar.
  const key = (c: WriterControl) => `${c.id.slice(0, 13)}|${c.spawning ?? ''}|${c.id}`
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

/** La cosecha del writer más reciente del flujo, o `null` si el flujo no tuvo writer o el último no cosechó. */
export function latestFlowHarvest(root: string, flow: string): { run: string; harvest: HarvestRecord } | null {
  const last = flowWriterRuns(root, flow).at(-1)
  const harvest = last && readHarvest(root, last.id)
  return last && harvest ? { run: last.id, harvest } : null
}

/** Si alguno de los writers del flujo sigue abierto: sin cosecha congelada o con su grupo de procesos vivo. */
export function flowWriterOpen(root: string, flow: string, strict = false): string | null {
  for (const c of flowWriterRuns(root, flow, strict)) {
    if (strict) {
      if (strictWriterOpen(storeDir(root, c.id), c)) return c.id
      continue
    }
    if (!readHarvest(root, c.id)) return c.id
    if (c.group && groupState(c.group) !== 'gone') return c.id
  }
  return null
}

/** El proceso dueño de una reclamación: vive si `ps` lo ve con la misma hora de inicio. */
function ownerAlive(owner: { pid: number; lstart: string | null }): boolean {
  const seen = readProcess(owner.pid)
  if (seen === undefined) {
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  return seen !== 'gone' && (owner.lstart === null || seen.lstart === owner.lstart)
}

const CLAIM = /^harvest\.claim\.(\d+)$/

/** Crea la reclamación `n` con `link`: gana uno solo, y nunca se mueve ni se borra una existente. */
function claim(dir: string, n: number): boolean {
  const seen = readProcess(process.pid)
  const tmp = join(dir, `harvest.claim.tmp.${process.pid}.${randomBytes(4).toString('hex')}`)
  writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, lstart: seen && seen !== 'gone' ? seen.lstart : null })}\n`)
  try {
    linkSync(tmp, join(dir, `harvest.claim.${n}`))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    return false
  } finally {
    unlinkSync(tmp)
  }
}

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function headOf(gitDir: string, commonDir: string): string | undefined {
  try {
    return execFileSync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_COMMON_DIR: commonDir },
    }).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Si el árbol del checkout sigue siendo el de la base, visto como lo ve la cosecha: sin filtros y con
 * los archivos nuevos. No usa `git status`, que puede correr un filtro `clean` sobre el árbol.
 */
export function captureTreeAtBase(root: string, id: string): boolean {
  const { checkout, base } = readControl(root, id)
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-index-'))
  try {
    const tree = buildIndex(checkout, base, join(scratch, 'index'))
    // La misma pareja de directorios congelados que usó buildIndex: los dos leen el mismo almacén de objetos.
    const baseTree = execFileSync('git', ['--git-dir', checkout.gitDir, 'rev-parse', `${base}^{tree}`], {
      encoding: 'utf8', env: { ...process.env, GIT_DIR: checkout.gitDir, ...(checkout.commonDir ? { GIT_COMMON_DIR: checkout.commonDir } : {}) },
    }).trim()
    return tree === baseTree
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Si el árbol de trabajo sigue siendo el que congeló la cosecha de ese writer. */
export function harvestTreeHolds(root: string, id: string): boolean {
  try {
    const h = readHarvest(root, id)
    if (!h) return false
    const { checkout, base } = readControl(root, id)
    const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-index-'))
    try {
      return buildIndex(checkout, base, join(scratch, 'index')) === h.tree
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } catch {
    return false
  }
}

const withoutFlow = (m: Map<string, string>, flow: string) => new Map([...m].filter(([p]) => !p.startsWith(`.plans/${flow}/`)))

/** El mapa del árbol que dejó la cosecha de `run`: el guardado, o reconstruido desde su patch si es anterior. */
export function runEntries(root: string, run: string): Map<string, string> | null {
  const h = readHarvest(root, run)
  if (!h) return null
  if (h.entries) return new Map(Object.entries(h.entries))
  const flow = readControl(root, run).phase?.flow
  const m = indexEntries(root, h.base, { kind: 'patch', patchFile: h.patchFile })
  return m && flow ? withoutFlow(m, flow) : m
}

const takeoverFile = (root: string, id: string) => join(gitDirs(root).gitDir, 'sdd-ai', 'takeovers', `${id}.json`)
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** Guarda en el almacén el mapa del árbol que declaró una toma, y devuelve su referencia con digest. */
export function writeTakeoverMap(root: string, id: string, entries: ReadonlyMap<string, string>): { ref: string; digest: string } {
  const text = `${JSON.stringify(Object.fromEntries(entries))}\n`
  const file = takeoverFile(root, id)
  mkdirSync(join(file, '..'), { recursive: true })
  writeAtomic(file, text)
  return { ref: `takeovers/${id}.json`, digest: sha(text) }
}

/** El mapa de una toma, o `null` si falta o su digest no coincide. */
export function readTakeoverMap(root: string, map: { ref: string; digest: string }): Map<string, string> | null {
  const file = join(gitDirs(root).gitDir, 'sdd-ai', map.ref)
  if (!/^takeovers\/[^/]+\.json$/.test(map.ref) || !existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  return sha(text) === map.digest ? new Map(Object.entries(JSON.parse(text) as Record<string, string>)) : null
}

/** El mapa del árbol del que parte una corrida: el de su padre, o el de la base. */
export function launchEntries(root: string, c: Pick<WriterControl, 'base'> & { phase?: Pick<PhaseControl, 'flow' | 'launch_from'> }): Map<string, string> | null {
  const from = c.phase?.launch_from
  if (from === undefined) {
    const m = indexEntries(root, c.base, { kind: 'base' })
    return m && c.phase ? withoutFlow(m, c.phase.flow) : m
  }
  return 'run' in from ? runEntries(root, from.run) : readTakeoverMap(root, from.takeover)
}

/** Las rutas del árbol actual que difieren del árbol del que parte la corrida; `null` si ese árbol no se puede leer. */
export function launchTreeDiff(root: string, c: Pick<WriterControl, 'base'> & { phase?: Pick<PhaseControl, 'flow' | 'launch_from'> }): string[] | null {
  const expected = launchEntries(root, c)
  if (expected === null) return null
  const now = indexEntries(root, c.base, { kind: 'current' })
  return now === null ? null : entryDiff(expected, now, c.phase?.flow ?? '')
}

/**
 * Si el árbol sigue siendo el de lanzamiento: el del padre en una corrida encadenada, o la base si no
 * tiene padre (lo mismo que `captureTreeAtBase`).
 */
export function launchTreeHolds(root: string, c: WriterControl): boolean {
  if (c.phase?.launch_from === undefined) return captureTreeAtBase(root, c.id)
  return launchTreeDiff(root, c)?.length === 0
}

/**
 * La sesión que abrió una corrida y el argv con que la abrió: el del reintento por perfil si lo hubo. En
 * Claude la sesión está en el argv; en Codex, en el estado que dejó el supervisor. `null` si falta algo.
 */
export function writerSession(root: string, id: string): { family: Family; session: string; launch: { cmd: string; args: string[]; cwd: string } } | null {
  const argv = writerLaunchOf(root, id)
  if (argv === null) return null
  try {
    const i = argv.launch.args.indexOf('--session-id')
    const session = argv.family === 'claude'
      ? (i >= 0 ? argv.launch.args[i + 1] : undefined)
      : readJson<{ session_id?: string }>(join(storeDir(root, id), 'status.json')).session_id
    return session ? { ...argv, session } : null
  } catch {
    return null
  }
}

/** La familia y el argv con que se lanzó una corrida (el del reintento por perfil si lo hubo), sin su sesión. `null` si falta. */
export function writerLaunchOf(root: string, id: string): { family: Family; launch: { cmd: string; args: string[]; cwd: string } } | null {
  try {
    const store = storeDir(root, id)
    const file = existsSync(join(store, 'argv-2.json')) ? 'argv-2.json' : 'argv.json'
    const argv = readJson<{ family: Family; launch?: { cmd: string; args: string[]; cwd: string } }>(join(store, file))
    return argv.launch ? { family: argv.family, launch: argv.launch } : null
  } catch {
    return null
  }
}

/** El digest del registro de fases del flujo, o `absent` si todavía no existe. */
export function registryDigest(root: string, flow: string): string {
  const file = join(root, '.plans', flow, 'sdd-ai-phases.json')
  return existsSync(file) ? sha(readFileSync(file, 'utf8')) : 'absent'
}

/**
 * El control desde el que se mide el delta: una reanudación se mide con la corrida que reanuda, y así
 * hacia atrás hasta la primera que no es una reanudación. Un ciclo en `resumes` es un registro roto: lanza.
 */
function measuredFrom(root: string, c: WriterControl): WriterControl {
  let cur = c
  const seen = new Set<string>([c.id])
  while (cur.phase?.resumes !== undefined) {
    if (seen.has(cur.phase.resumes)) throw new Error(`la corrida ${cur.phase.resumes} se reanuda a sí misma en la cadena`)
    seen.add(cur.phase.resumes)
    cur = readControl(root, cur.phase.resumes)
  }
  return cur
}

/**
 * El mapa del árbol cosechado de un writer de cadena, leído del patch que se acaba de publicar para que
 * los dos digan lo mismo, y su delta contra el árbol del que parte (el de la corrida original, si reanuda).
 * Sin alguno de los dos árboles, el delta queda sin medir: vacío y marcado, para que no acredite tasks.
 */
function chainFacts(root: string, control: WriterControl, patchFile: string): Pick<HarvestRecord, 'entries' | 'delta' | 'delta_unmeasured'> {
  const flow = control.phase?.flow ?? ''
  const now = indexEntries(root, control.base, { kind: 'patch', patchFile })
  const entries = now === null ? null : withoutFlow(now, flow)
  let from: Map<string, string> | null
  try {
    from = launchEntries(root, measuredFrom(root, control))
  } catch {
    from = null
  }
  const measured = entries !== null && from !== null
  return { ...(entries ? { entries: Object.fromEntries(entries) } : {}), delta: measured ? entryDiff(from!, entries!, flow) : [], ...(measured ? {} : { delta_unmeasured: true as const }) }
}

/** Cuánto espera a que otro publique la cosecha que reclamó antes de darse por vencido. */
const CLAIM_WAIT_MS = 120_000

/**
 * Congela la cosecha del writer: el árbol real contra la base, el patch, lo señalado y la corrida
 * alterada. Publica el patch, después el registro, que es el terminal, y recién entonces libera la
 * reserva. Es idempotente: una reclamación numerada decide quién congela; el que pierde espera el
 * registro y lo devuelve. Una reclamación cuyo dueño murió sin publicar se rescata con la siguiente.
 */
export async function freezeHarvest(root: string, id: string, outcome: Outcome, report?: string,
  hooks: { beforeRescue?: () => Promise<void> } = {}): Promise<HarvestRecord> {
  const control = readControl(root, id)
  const dir = controlStore(root, control)
  const { checkout } = control
  const release = () => releaseAndReport(controlReservation(control))
  const until = Date.now() + CLAIM_WAIT_MS
  for (;;) {
    if (existsSync(harvestFile(dir))) {
      release()
      return readJson<HarvestRecord>(harvestFile(dir))
    }
    const claims = readdirSync(dir).map((f) => CLAIM.exec(f)?.[1]).filter((n) => n !== undefined).map(Number)
    const top = Math.max(0, ...claims)
    let mine = false
    if (top === 0) {
      mine = claim(dir, 1)
    } else if (!ownerAlive(readJson<{ pid: number; lstart: string | null }>(join(dir, `harvest.claim.${top}`)))) {
      await hooks.beforeRescue?.()
      mine = claim(dir, top + 1)
    }
    if (mine) break
    if (Date.now() > until) {
      throw new SddError('harvest_busy', `otro proceso está congelando la cosecha de ${id} y no terminó`, { next: `./bin/sdd-ai wait ${id}` })
    }
    await sleep(100)
  }

  const indexFile = join(dir, 'harvest.index')
  removeIndex(indexFile)
  const cap = captureTree(checkout, control.base, indexFile)
  removeIndex(indexFile)
  const flagged = diffInventory(control.inventory, control.git_state ? sensitiveInventoryV2(checkout.root, checkout) : sensitiveInventory(checkout.root, checkout))
  if (control.git_state) {
    flagged.push(...semanticDifferences(checkout, control.git_state))
  }
  const run = runInventory(checkout.root, id)
  const runAltered = diffInventory(control.preLaunch, run)
  // Un directorio reemplazado por otro igual solo se nota en su inodo.
  const now = runDirIdentity(checkout.root, id)
  if (now && (now.dev !== control.runDir.dev || now.ino !== control.runDir.ino) && !runAltered.some((f) => f.path === '.')) {
    runAltered.unshift({ path: '.', before: control.preLaunch['.'], after: run['.'] })
  }
  const patchFile = join(dir, 'diff.patch')
  writeAtomic(patchFile, cap.patch)
  const record: HarvestRecord = {
    state: outcome.state, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}),
    base: control.base, tree: cap.tree, files: cap.files, patchFile, flagged, runAltered,
    headMoved: headOf(checkout.gitDir, checkout.commonDir) !== control.base, ...(report !== undefined ? { report } : {}), endMark: hasEndMark(report ?? ''),
    ...(control.phase ? { phase_inputs: phaseInputs(checkout.root, control.phase) } : {}),
    ...(control.phase?.kind ? chainFacts(checkout.root, control, patchFile) : {}),
  }
  writeAtomic(harvestFile(dir), `${JSON.stringify(record, null, 2)}\n`)
  release()
  return record
}

/** Si los insumos de un writer de fase son los que congeló al lanzar; un flujo que ya no se lee cambió. */
function phaseInputs(root: string, phase: PhaseControl): 'unchanged' | 'changed' {
  try {
    const read = readFlow(root, phase.flow)
    const now: Record<string, string> = { spec: artifactHash(read, 'spec'), plan: artifactHash(read, 'plan'), tasks: artifactHash(read, 'tasks') }
    const same = Object.entries(phase.inputs).every(([k, v]) => now[k] === v) && headerHash(read.facts.handoffHeader) === phase.handoff_header
      && (phase.registry === undefined || registryDigest(root, phase.flow) === phase.registry)
    return same ? 'unchanged' : 'changed'
  } catch {
    return 'changed'
  }
}
