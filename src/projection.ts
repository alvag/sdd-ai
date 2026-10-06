import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { available, CLAIM_NAME, known, NOTIFICATIONS_VERSION, OBSERVATION_NAME, PROJECTION_MAX_BYTES, PROJECTION_MAX_ENTRIES, TEMPORARY_NAME, unknown, validateProjection, validProgress } from './projection-types.ts'
import type {
  Observed, Projection, ProjectionBinding, ProjectionCollection, ProjectionEntity, ProjectionFlow, ProjectionJob, ProjectionObservation, ProjectionProgress,
  ProjectionRun, ProjectionRunState, ProjectionWriter,
} from './projection-types.ts'
import { readBinding } from './backstop.ts'
import { withGitMemo } from './git.ts'
import { localRunInventory, runOpenness } from './open-runs.ts'
import { observedProgress } from './review/progress.ts'
import { associationFor, collectRunAssociations, ownerAssociationSource } from './run-association.ts'
import { listFlows, readFlow } from './sdd/read.ts'
import { headerData } from './sdd/status.ts'
import { detailedFlowView } from './sdd/view.ts'
import { type LaunchJob, type LaunchProgress, type Status, TERMINAL } from './types.ts'

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RETAIN_NS = 5_000_000_000n
const TEMPORARY_NS = 60_000_000_000n
/** Hasta cuándo cuenta una reserva: después de esto, ningún publicador cede ante ella y la poda la borra. */
const CLAIM_NS = 60_000_000_000n
/** Cuánto espera un publicador a que se decida una reserva que todavía busca, antes de leer por su cuenta. */
const PENDING_WAIT_MS = 200
/** Cuánto espera en total, en la cola, un pedido detrás de un publicador que empezó a leer antes del cambio pedido. */
const QUEUE_WAIT_NS = 5_000_000_000n
/** Cada cuánto mira, mientras espera en la cola, si la reserva de ese publicador sigue viva. */
const QUEUE_POLL_MS = 50
/** Cuántas veces vuelve a empezar después de esperar en la cola, antes de leer por su cuenta. */
const QUEUE_ROUNDS = 3
let cachedBoot: string | null | undefined

/** Se resuelve fuera de toda sección que cambia el directorio de trabajo, una sola vez por proceso. */
export function systemBootId(): string | null {
  if (cachedBoot !== undefined) return cachedBoot
  cachedBoot = readBootId(process.platform)
  return cachedBoot
}

/**
 * Las dependencias se pueden sustituir en las pruebas sin lanzar sysctl dentro de la sección relativa. `sysctl`
 * va por su ruta: el PATH de un hook o de un supervisor puede no incluir `/usr/sbin`.
 */
export function readBootId(platform: string, read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
  sysctl: () => string = () => execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000,
  })): string | null {
  try {
    const raw = platform === 'linux' ? read('/proc/sys/kernel/random/boot_id') : platform === 'darwin' ? sysctl() : ''
    const boot = raw.trim().toLowerCase()
    return BOOT_ID.test(boot) ? boot : null
  } catch { return null }
}

export type ProjectionStage = 'entered' | 'before_quarantine' | 'quarantined' | 'reserved' | 'pending_wait' | 'pending_expired' | 'claimed' | 'observed' | 'temporary' | 'linked' | 'verified' | 'pruned'
export interface ProjectionPublicationOptions {
  publisher?: ProjectionObservation['publisher']['kind']
  boot?: () => string | null; monotonic?: () => bigint; now?: () => number
  /**
   * El reloj monotónico del pedido que atiende la publicación. Con él, el publicador cede ante una reserva viva que ya
   * cubre el pedido y, si lee, deja la suya mientras publica. Sin él, como en una llamada directa, no reserva ni cede.
   */
  requested?: bigint
  /**
   * Con `requested`, en el primer intento: si una reserva decidida y viva empezó a leer antes del pedido (su `m0` no es
   * posterior a él), no lee y devuelve `queued` con esa reserva, después de borrar la suya. Quien llama espera a que
   * termine y vuelve a pedir, como `publishNow`. Sin él, lee igual.
   */
  queue?: boolean
  /** Barreras sincrónicas para las pruebas; el recolector siempre corre fuera de la sección relativa. */
  stage?: (stage: ProjectionStage, context: { root: string; attempt: number; id: string | null }) => void
}
export interface ProjectionTimings { entry_ms: number; read_ms: number; serialize_ms: number; write_ms: number; prune_ms: number; total_ms: number }
/**
 * El resultado de una publicación. `superseded`: la observación se escribió, pero otras más nuevas la dejaron fuera de
 * las conservadas y su propia poda la borró. `skipped`: cedió sin leer ante la reserva `id`, de un publicador que
 * empezó a leer después del pedido. `queued`, solo con `queue`: no leyó porque la reserva `id`, de un publicador que
 * empezó a leer antes del pedido, sigue viva, y no dejó ninguna reserva propia.
 */
export type ProjectionPublication = { kind: 'published'; id: string; path: string; timings: ProjectionTimings }
  | { kind: 'skipped'; id: string }
  | { kind: 'queued'; id: string }
  | { kind: 'not_published'; cause: 'boot_unavailable' | 'invalidated' | 'publication_failed' | 'superseded' }
export type ProjectionBuilder = (root: string, observation: ProjectionObservation) => Projection

class Invalidated extends Error {}
const invalidated = (): never => { throw new Invalidated('la ubicación de la observación cambió durante la publicación') }
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino
const random = (): string => randomBytes(16).toString('hex')
const clock = (): bigint => process.hrtime.bigint()
const elapsed = (start: bigint): number => Number(clock() - start) / 1_000_000
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'
const existing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'EEXIST'
function lstat(name: string): Stats | null {
  try { return lstatSync(name) } catch (e) { if (missing(e)) return null; throw e }
}

/** Lista acotada: no se recorre recursivamente ni se sigue ningún enlace. */
function entries(): string[] {
  const dir = opendirSync('.')
  const names: string[] = []
  try {
    while (names.length <= PROJECTION_MAX_ENTRIES) {
      const entry = dir.readSync()
      if (entry === null) break
      names.push(entry.name)
    }
  } finally { dir.closeSync() }
  return names
}

/** `.gitignore` con `*` en el almacén, sin pisar uno existente ni seguir un enlace. */
function ignoreStore(): void {
  try { writeFileSync('.gitignore', '*\n', { flag: 'wx' }) } catch (e) { if (!existing(e)) throw e }
}

function createDirectory(name: string): void {
  try { mkdirSync(name, { mode: 0o700 }) } catch (e) { if (!existing(e)) throw e }
}

/** `name` es un único segmento fijo; unlink nunca borra recursivamente ni sigue un enlace. */
function directory(name: 'projection' | 'live', repair: boolean): Stats {
  let st = lstat(name)
  if (repair && (st === null || !st.isDirectory() || st.isSymbolicLink())) {
    if (st !== null) unlinkSync(name)
    createDirectory(name)
    st = lstat(name)
  }
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) return invalidated()
  process.chdir(name)
  if (!same(st, statSync('.'))) return invalidated()
  return st
}

/**
 * Todas las mutaciones usan nombres sin barras dentro del directorio verificado. No corre JS ajeno
 * durante esta sección sincrónica. El recolector y los procesos hijos corren con el cwd restaurado.
 */
function inside<T>(root: string, repair: boolean, fn: (projection: Stats, live: Stats) => T): T {
  const previous = process.cwd()
  try {
    const home = join(root, '.sdd-ai')
    if (repair && lstat(home) === null) {
      // Para un checkout sin almacén, crear el primer directorio también usa el cwd físico comprobado.
      const rootStat = lstat(root)
      if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return invalidated()
      process.chdir(root)
      if (!same(rootStat, statSync('.')) || process.cwd() !== root) return invalidated()
      createDirectory('.sdd-ai')
    }
    const expected = lstat(home)
    if (expected === null || !expected.isDirectory() || expected.isSymbolicLink()) return invalidated()
    process.chdir(home)
    if (!same(expected, statSync('.')) || process.cwd() !== home) return invalidated()
    // Como `ensureIgnore`, pero relativo al directorio verificado: las observaciones nunca aparecen en Git.
    if (repair) ignoreStore()
    const projection = directory('projection', repair)
    const live = directory('live', repair)
    if (process.cwd() !== join(home, 'projection', 'live')) return invalidated()
    return fn(projection, live)
  } finally {
    try { process.chdir(previous) } catch { process.chdir(root) }
  }
}

function remove(name: string): void {
  try { unlinkSync(name) } catch (e) {
    // Una entrada apartada o que se convirtió en directorio no justifica un borrado recursivo.
    if (!missing(e) && !['EISDIR', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
  }
}

function prepare(root: string, stage: (s: ProjectionStage) => void): Stats {
  return inside(root, true, (projection, live) => {
    const names = entries()
    if (names.length > PROJECTION_MAX_ENTRIES) {
      // Volver por la cadena: `..` podría llegar a un padre que el writer movió fuera del checkout.
      process.chdir(join(root, '.sdd-ai'))
      const home = lstat(join(root, '.sdd-ai'))
      if (home === null || home.isSymbolicLink() || !same(home, statSync('.')) || process.cwd() !== join(root, '.sdd-ai')) return invalidated()
      const parent = directory('projection', false)
      const current = lstat('live')
      if (!same(parent, projection) || current === null || current.isSymbolicLink() || !same(current, live)) return invalidated()
      stage('before_quarantine')
      renameSync('live', `stale-${random()}`)
      stage('quarantined')
      createDirectory('live')
      const fresh = directory('live', false)
      if (process.cwd() !== join(root, '.sdd-ai', 'projection', 'live')) return invalidated()
      stage('entered')
      return fresh
    }
    for (const name of names) {
      const st = lstat(name)
      if (OBSERVATION_NAME.test(name) && st?.isDirectory() && !st.isSymbolicLink()) {
        renameSync(name, `junk-${random()}`)
      }
    }
    stage('entered')
    return live
  })
}

/** Si el proceso existe: `EPERM` dice que existe aunque sea de otro usuario. El `pid` 0 nombraría al grupo propio. */
function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * La reserva `name` si está viva: un archivo regular que no es un enlace, de este arranque, con un `m0` de no más de
 * 60 s que no está adelante del reloj (`now`) y de un proceso que existe. `decided` dice si su publicador ya decidió
 * leer: una reserva nace sin permisos y queda con `0600` cuando lo decide. Si no está viva, `null`.
 */
function liveClaim(name: string, boot: string, now: bigint): { m0: bigint; decided: boolean } | null {
  const match = CLAIM_NAME.exec(name)
  if (match === null || match[2] !== boot) return null
  const m0 = BigInt(match[1])
  if (m0 > now || now - m0 > CLAIM_NS) return null
  const st = lstat(name)
  return st !== null && st.isFile() && !st.isSymbolicLink() && processExists(Number(match[3])) ? { m0, decided: (st.mode & 0o777) !== 0 } : null
}

/** Leer el reloj después del listado hace imposible que una observación legítima listada lo adelante. */
function prune(boot: string, monotonic: () => bigint): void {
  const names = entries()
  if (names.length > PROJECTION_MAX_ENTRIES) return invalidated()
  const now = monotonic()
  const observations = names.filter((name) => {
    const match = OBSERVATION_NAME.exec(name)
    const st = lstat(name)
    return match !== null && match[2] === boot && BigInt(match[1]) <= now && st !== null && st.isFile() && !st.isSymbolicLink()
  }).sort().reverse()
  const keep = new Set(observations.slice(0, 2))
  for (const name of observations) {
    const match = OBSERVATION_NAME.exec(name)!
    if (now - BigInt(match[1]) <= RETAIN_NS) keep.add(name)
  }
  for (const name of names) {
    const st = lstat(name)
    if (st === null || (st.isDirectory() && !st.isSymbolicLink())) continue
    const temp = TEMPORARY_NAME.exec(name)
    if (temp && st.isFile() && !st.isSymbolicLink() && temp[2] === boot && BigInt(temp[1]) <= now && now - BigInt(temp[1]) <= TEMPORARY_NS) continue
    // Una reserva de otro arranque, adelantada, vencida, de un proceso que ya no existe o que no es un archivo regular
    // se borra; un enlace se borra a sí mismo, sin seguirlo.
    if (liveClaim(name, boot, now) !== null) continue
    if (!keep.has(name)) remove(name)
  }
}

/** La reserva propia mientras se lee: su nombre, el archivo que se creó y el `live/` donde está. */
interface Claim { name: string; created: Stats; live: Stats }

/**
 * La reserva decidida más vieja con un `m0` posterior al pedido (`requested`) y anterior al propio (`own`): su
 * publicador empezó a leer después del cambio pedido, así que su observación lo cubre. Una reserva sin decidir puede
 * terminar cediendo ante otra que empezó a leer antes del cambio, así que no cubre nada todavía: se espera hasta
 * `PENDING_WAIT_MS` a que se decida o desaparezca, y después se lee. Un `live/` inundado no se interpreta: se lee, y la
 * siguiente publicación lo aparta.
 */
function coveringClaim(boot: string, own: bigint, requested: bigint, monotonic: () => bigint,
  stage: (s: ProjectionStage) => void): string | null {
  const names = entries()
  if (names.length > PROJECTION_MAX_ENTRIES) return null
  let candidates = names.filter((name) => {
    const match = CLAIM_NAME.exec(name)
    return match !== null && BigInt(match[1]) > requested && BigInt(match[1]) < own
  }).sort()
  const started = clock()
  let waiting = false
  for (;;) {
    const now = monotonic()
    const pending: string[] = []
    for (const name of candidates) {
      const found = liveClaim(name, boot, now)
      if (found?.decided) return name
      if (found !== null) pending.push(name)
    }
    if (pending.length === 0) return null
    if (elapsed(started) >= PENDING_WAIT_MS) { stage('pending_expired'); return null }
    if (!waiting) { stage('pending_wait'); waiting = true }
    candidates = pending
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
  }
}

/**
 * La reserva decidida y viva más nueva con un `m0` que no es posterior al pedido (`requested`): su publicador empezó a
 * leer antes del cambio pedido, así que su observación no lo cubre, y todavía está leyendo. Un `live/` inundado no se
 * interpreta: se lee, y la siguiente publicación lo aparta.
 */
function runningClaim(boot: string, requested: bigint, monotonic: () => bigint): string | null {
  const names = entries()
  if (names.length > PROJECTION_MAX_ENTRIES) return null
  const now = monotonic()
  return names.filter((name) => {
    const match = CLAIM_NAME.exec(name)
    return match !== null && BigInt(match[1]) <= requested && liveClaim(name, boot, now)?.decided === true
  }).sort().at(-1) ?? null
}

/**
 * Qué hace un publicador ante las reservas de otros: `read` lee siempre, `yield` cede ante una reserva que cubre el
 * pedido, y `queue` además queda en la cola detrás de una que empezó a leer antes del pedido.
 */
type ClaimPolicy = 'read' | 'yield' | 'queue'

/**
 * Antes de leer las fuentes, en el `live/` verificado: deja una reserva vacía con el `m0` propio, con creación
 * exclusiva y sin seguir enlaces, y sin permisos mientras busca. Salvo con `read`, si una reserva decidida ya cubre el
 * pedido, cede: borra la suya y no lee. Con `queue`, si no cede pero una reserva decidida y viva empezó a leer antes
 * del pedido, también borra la suya y no lee: quien llama espera a que esa termine. Si no, la marca como decidida
 * (`0600`) y lee.
 *
 * La reserva se crea antes de buscar: de varios que arrancan juntos, el que tomó su `m0` primero suele tener la suya
 * puesta cuando los demás buscan, y los demás ceden. Nadie cede ante una reserva sin decidir: su publicador podría
 * ceder a su vez ante uno que empezó a leer antes del cambio, y ese cambio no lo leería nadie. Si el que cubre muere o
 * queda detenido después de que otros cedieron, esos cambios los refleja la siguiente publicación, como los de
 * cualquier proceso que muere mientras publica; su reserva deja de contar cuando el proceso ya no existe o a los 60 s.
 */
function claim(root: string, live: Stats, boot: string, m0: string, requested: bigint, policy: ClaimPolicy, monotonic: () => bigint,
  stage: (s: ProjectionStage) => void): { kind: 'yield'; id: string } | { kind: 'queue'; id: string } | { kind: 'claimed'; claim: Claim } {
  return inside(root, false, (_projection, current) => {
    if (!same(current, live)) return invalidated()
    const name = `claim-${m0}-${boot}-${process.pid}-${random()}`
    const fd = openSync(name, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o000)
    let kept = false
    try {
      stage('reserved')
      const covering = policy === 'read' ? null : coveringClaim(boot, BigInt(m0), requested, monotonic, stage)
      if (covering !== null) return { kind: 'yield' as const, id: covering }
      // No lee en paralelo con un publicador que empezó antes del pedido y no lo cubre: quien llama espera a que
      // termine, y así leen a lo sumo el que corre y el siguiente.
      const running = policy === 'queue' ? runningClaim(boot, requested, monotonic) : null
      if (running !== null) return { kind: 'queue' as const, id: running }
      try {
        fchmodSync(fd, 0o600)
      } catch {
        // Sin la marca, ninguno cede ante esta reserva y leen por su cuenta: es más trabajo, no un cambio perdido.
      }
      kept = true
      return { kind: 'claimed' as const, claim: { name, created: fstatSync(fd), live } }
    } finally {
      try {
        // Una reserva que no va a leer, o cuya búsqueda falló, no queda: se borra solo si sigue siendo la que se creó.
        if (!kept) {
          const st = lstat(name)
          if (st !== null && st.isFile() && !st.isSymbolicLink() && same(st, fstatSync(fd))) remove(name)
        }
      } finally { closeSync(fd) }
    }
  })
}

/**
 * Borra la reserva propia si sigue en el mismo `live/` y es el archivo que se creó. Una que no se pudo borrar (un
 * `live/` apartado o reemplazado) no cuenta para nadie: quedó fuera de `live/`, o la poda la borra cuando este proceso
 * termina o a los 60 s.
 */
function release(root: string, own: Claim): void {
  try {
    inside(root, false, (_projection, current) => {
      if (!same(current, own.live)) return
      const st = lstat(own.name)
      if (st !== null && st.isFile() && !st.isSymbolicLink() && same(st, own.created)) remove(own.name)
    })
  } catch {
    // Sin el directorio verificado no se borra nada.
  }
}

function freshClock(monotonic: () => bigint): bigint {
  const before = monotonic()
  for (let i = 0; i < 10000; i++) {
    const after = monotonic()
    if (after > before && after >= 0n && after < 10n ** 20n) return after
  }
  return invalidated()
}

/**
 * Publica una observación completa sin reemplazar archivos existentes ni consultar su contenido.
 * La proyección no entrega resultados, libera reservas ni toma decisiones. Dos intentos acotan la
 * recuperación de carreras; cualquier fallo queda fuera del resultado funcional del llamador.
 */
export function publishProjection(root: string, build: ProjectionBuilder, options: ProjectionPublicationOptions = {}): ProjectionPublication {
  const started = clock()
  try {
    if (!root.startsWith('/') || resolve(root) !== root) return { kind: 'not_published', cause: 'publication_failed' }
    const boot = (options.boot ?? systemBootId)()
    if (boot === null || !BOOT_ID.test(boot)) return { kind: 'not_published', cause: 'boot_unavailable' }
    const monotonic = options.monotonic ?? clock
    const now = options.now ?? Date.now
    for (let attempt = 1; attempt <= 2; attempt++) {
      let id: string | null = null
      const stage = (name: ProjectionStage) => options.stage?.(name, { root, attempt, id })
      const timings: ProjectionTimings = { entry_ms: 0, read_ms: 0, serialize_ms: 0, write_ms: 0, prune_ms: 0, total_ms: 0 }
      let own: Claim | null = null
      try {
        let t = clock()
        const live = prepare(root, stage)
        const m0 = freshClock(monotonic).toString().padStart(20, '0')
        id = `obs-${m0}-${boot}-${process.pid}-${random()}.json`
        if (options.requested !== undefined) {
          // Solo cede o queda en la cola el primer intento: en el segundo, otros pudieron haber cedido ya ante la
          // reserva del primero.
          const policy: ClaimPolicy = attempt > 1 ? 'read' : options.queue === true ? 'queue' : 'yield'
          const claimed = claim(root, live, boot, m0, options.requested, policy, monotonic, stage)
          if (claimed.kind === 'yield') return { kind: 'skipped', id: claimed.id }
          if (claimed.kind === 'queue') return { kind: 'queued', id: claimed.id }
          own = claimed.claim
          stage('claimed')
        }
        timings.entry_ms = elapsed(t)
        const observation: ProjectionObservation = { id, publisher: { pid: process.pid, kind: options.publisher ?? 'unknown' },
          m0, boot, observed_at: now(), read_finished_at: now() }
        t = clock()
        const document = build(root, observation)
        document.observation = { ...observation, read_finished_at: now() }
        if (document.checkout.root !== root) throw new Error('el checkout del recolector no coincide con la raíz física')
        timings.read_ms = elapsed(t)
        stage('observed')
        t = clock()
        const validation = validateProjection(document)
        if (!validation.ok) throw new Error(validation.reason)
        const bytes = JSON.stringify(boundProjection(document)) + '\n'
        timings.serialize_ms = elapsed(t)
        t = clock()
        const finalName = id
        const created = inside(root, false, (_projection, current): Stats => {
          if (!same(current, live)) return invalidated()
          const temporary = `tmp-${monotonic().toString().padStart(20, '0')}-${boot}-${process.pid}-${random()}`
          const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
          // El temporal se borra pase lo que pase desde que existe, también si la escritura falla a medias.
          try {
            let written: Stats
            try { writeFileSync(fd, bytes); written = fstatSync(fd) } finally { closeSync(fd) }
            stage('temporary')
            const source = lstat(temporary)
            if (source === null || !source.isFile() || source.isSymbolicLink() || !same(source, written)) return invalidated()
            try { linkSync(temporary, finalName) } catch (e) {
              if (missing(e) || existing(e)) return invalidated()
              throw e
            }
            const published = lstat(finalName)
            if (published === null || !published.isFile() || published.isSymbolicLink() || !same(published, written)) return invalidated()
            stage('linked')
            return written
          } finally { remove(temporary) }
        })
        timings.write_ms = elapsed(t)
        t = clock()
        const kept = inside(root, false, (_projection, current) => {
          if (!same(current, live)) return invalidated()
          stage('verified')
          prune(boot, monotonic)
          stage('pruned')
          // Si otras observaciones más nuevas la dejaron fuera de las que se conservan, la poda se llevó esta misma.
          const own = lstat(finalName)
          return own !== null && own.isFile() && !own.isSymbolicLink() && same(own, created)
        })
        // Una reparación concurrente durante la poda obliga a observar de nuevo en el directorio nuevo.
        inside(root, false, (_projection, current) => { if (!same(current, live)) return invalidated() })
        if (!kept) return { kind: 'not_published', cause: 'superseded' }
        timings.prune_ms = elapsed(t)
        timings.total_ms = elapsed(started)
        return { kind: 'published', id, path: join(root, '.sdd-ai', 'projection', 'live', id), timings }
      } catch (e) {
        if (!(e instanceof Invalidated) && !missing(e) && !existing(e)) return { kind: 'not_published', cause: 'publication_failed' }
        if (attempt === 2) return { kind: 'not_published', cause: 'invalidated' }
      } finally {
        // La reserva se borra al terminar el intento, publique o no.
        if (own !== null) release(root, own)
      }
    }
    return { kind: 'not_published', cause: 'invalidated' }
  } catch { return { kind: 'not_published', cause: 'publication_failed' } }
}

const STATES: readonly ProjectionRunState[] = ['launching', 'running', 'done', 'failed', 'launch_failed', 'timeout', 'cancelled', 'delegated', 'unavailable', 'cessation_uncertain']
const mapValue = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const recordedText = (value: unknown, absent = 'not_recorded'): Observed<string> => typeof value === 'string' && value.trim() !== ''
  ? known(value) : unknown(absent, 'No hay un valor registrado.')
function stateValue(value: unknown): Observed<ProjectionRunState> {
  return typeof value === 'string' && STATES.includes(value as ProjectionRunState) ? known(value as ProjectionRunState)
    : unknown('state_unavailable', 'El estado de ejecución no se pudo observar.')
}

/**
 * El texto de un archivo sin quedar bloqueado: lo abre sin seguir un enlace en su último segmento (`O_NOFOLLOW`) y sin
 * esperar a un escritor (`O_NONBLOCK`), comprueba en el descriptor abierto que es un archivo regular de hasta `limit`
 * bytes y lee de ese mismo descriptor. Un enlace, un FIFO o un directorio en su lugar lo dejan ilegible; los
 * directorios de la ruta sí se recorren aunque sean enlaces. Un archivo ausente lanza `ENOENT`.
 */
function regularText(file: string, limit = Number.POSITIVE_INFINITY): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > limit) throw new Error('No es un archivo regular legible.')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

/** Una fuente como objeto JSON, leída con `regularText`; nunca devuelve contenidos al contrato. */
function sourceObject(file: string, optional = false): Record<string, unknown> | null {
  let text: string
  try { text = regularText(file) } catch (e) {
    if (optional && missing(e)) return null
    throw e
  }
  const raw: unknown = JSON.parse(text)
  if (!mapValue(raw)) throw new Error('La fuente no contiene un objeto JSON.')
  return raw
}

const noProgress = (): Observed<ProjectionProgress> => unknown('progress_unavailable', 'El formato observado no aporta conteos de trabajos terminados.')

/** El avance de una revisión en el contrato: el total es la unión de lo previsto y lo conservado, y la admisión va aparte. */
function projectedProgress(p: LaunchProgress): ProjectionProgress {
  const job = (j: LaunchJob): ProjectionJob => ({ round: j.round, key: j.key, launch: j.launch, state: j.state,
    admission: j.admission === null ? unknown('not_admitted', 'El trabajo terminó sin una respuesta admitida ni rechazada.') : known(j.admission) })
  const none = <T>(): Observed<T> => unknown('not_applicable', 'La refutación no tiene revisor ni lote.')
  return {
    phase: p.phase, round: p.round, launch: p.launch, planned: [...p.planned], retained: p.retained.map(job), completed: p.completed.map(job),
    total: new Set([...p.planned, ...p.retained.map((j) => j.key)]).size,
    active: p.active === null ? unknown('no_active_job', 'No hay un trabajo en curso.') : known({ key: p.active.key,
      reviewer: p.active.reviewer === null ? none<string>() : known(p.active.reviewer), batch: p.active.batch === null ? none<number>() : known(p.active.batch) }),
  }
}

/** Un avance de un formato anterior, ilegible o incoherente queda desconocido sin afectar al resto de la corrida. */
function reviewProgressOf(dir: string, status: Record<string, unknown> | null): Observed<ProjectionProgress> {
  if (status === null) return noProgress()
  try {
    const p = observedProgress(status as Partial<Status>, (name) => sourceObject(join(dir, name), true))
    if (p === null) return noProgress()
    const projected = projectedProgress(p)
    return validProgress(projected) ? known(projected) : noProgress()
  } catch { return noProgress() }
}

function finishCollection<T extends ProjectionEntity>(collection: ProjectionCollection<T>): void {
  if (collection.availability !== 'unavailable' && collection.items.some((item) => item.availability === 'unavailable')) {
    collection.availability = 'partial'
    collection.reason = { code: 'unreadable_entity', detail: 'Una o más entidades no se pudieron observar.' }
  }
}

/**
 * Lectura completa del checkout, sin entregar, cosechar, aprobar ni modificar ligas. Los directorios de Git y el remoto
 * se resuelven una sola vez por observación: la vista de cada flujo los pide por cada corrida de su cadena.
 */
export function collectProjection(root: string, observation: ProjectionObservation): Projection {
  return withGitMemo(() => collectObservation(root, observation))
}

/**
 * La identidad de entrega que publica la proyección. Tiene que coincidir con la que escribe `delivered.json`
 * (`deliveryOf` en runs.ts: la ronda y el lanzamiento del status, o null):
 * - un writer protegido no tiene rondas: siempre null y null;
 * - una revisión necesita los dos contadores; sin ellos, la identidad es desconocida;
 * - las demás corridas aceptan contadores ausentes (null) o válidos.
 */
function deliveryIdentityOf(protectedWriter: boolean, kind: string, round: unknown, launch: unknown): Observed<{ round: number | null; launch: number | null }> {
  const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const optional = (value: unknown): value is number | null | undefined => value === undefined || value === null || counter(value)
  if (protectedWriter) return known({ round: null, launch: null })
  if (kind === 'review') {
    return counter(round) && counter(launch) ? known({ round, launch }) : unknown('delivery_unavailable', 'No se pudo observar la identidad del lanzamiento.')
  }
  return optional(round) && optional(launch) ? known({ round: round ?? null, launch: launch ?? null })
    : unknown('delivery_unavailable', 'No se pudo observar la identidad de entrega.')
}

function collectObservation(root: string, observation: ProjectionObservation): Projection {
  const document: Projection = { schema_version: 1, notifications_version: NOTIFICATIONS_VERSION, checkout: { id: createHash('sha256').update(root).digest('hex'), root }, observation: { ...observation },
    runs: available([]), writer: { availability: 'available', reason: null, item: null }, flows: available([]), bindings: available([]), omissions: [] }
  let flowEntries: ReturnType<typeof listFlows> | null = null
  const catalog = (): ReturnType<typeof listFlows> => (flowEntries ??= listFlows(root))
  const associations = collectRunAssociations(root, catalog)
  try {
    for (const entry of catalog()) {
      try {
        const read = readFlow(root, entry.id)
        document.flows.items.push({ id: entry.id, availability: 'available', reason: null, observed_at: observation.observed_at,
          status: recordedText(headerData(read.facts.planHeader)?.status), view: known(detailedFlowView(root, entry.id, read)) })
      } catch {
        document.flows.items.push({ id: entry.id, availability: 'unavailable', reason: { code: 'flow_unreadable', detail: 'No se pudo observar el flujo.' },
          observed_at: observation.observed_at, status: unknown('flow_unreadable', 'Estado desconocido.'), view: unknown('flow_unreadable', 'Vista no disponible.') })
      }
    }
    finishCollection(document.flows)
  } catch {
    document.flows = { availability: 'unavailable', reason: { code: 'catalog_unreadable', detail: 'No se pudo observar el catálogo local.' }, items: [] }
  }

  const inventory = localRunInventory(root)
  if (inventory.unavailable.length) {
    document.runs.availability = 'partial'
    document.runs.reason = { code: 'inventory_unreadable', detail: 'No se pudo observar uno de los almacenes de corridas.' }
  }
  const sessions = new Set<string>()
  const writers: ProjectionWriter[] = []
  let writerUnavailable = inventory.unavailable.includes('writers')
  for (const id of inventory.ids) {
    const visible = join(root, '.sdd-ai', 'runs', id)
    const store = inventory.writers ? join(inventory.writers, id) : null
    let protectedWriter = false
    let controlObserved = false
    try {
      protectedWriter = store !== null && lstat(join(store, 'control.json')) !== null
      controlObserved = true
      const directory = protectedWriter ? store! : visible
      const owner = sourceObject(join(directory, protectedWriter ? 'control.json' : 'request.json'))!
      if (protectedWriter && (owner.id !== id || !mapValue(owner.checkout) || owner.checkout.root !== root)) throw new Error('Control ajeno al checkout o a la corrida.')
      const session = recordedText(owner.session)
      if (session.value !== null) sessions.add(session.value)
      const status = sourceObject(join(directory, 'status.json'), protectedWriter)
      const harvest = protectedWriter ? sourceObject(join(directory, 'harvest.json'), true) : null
      // Se comprueban las fuentes auxiliares antes de delegar al clasificador de apertura existente.
      for (const file of ['delivered.json', ...(protectedWriter ? [] : ['native.json', 'launch.json', 'launched.json', 'ledger.json'])]) {
        sourceObject(join(directory, file), true)
      }
      if (protectedWriter && harvest !== null) {
        const delivery = lstat(join(visible, 'delivered.json'))
        if (delivery !== null) sourceObject(join(visible, 'delivered.json'))
      }
      const openness = runOpenness(root, id, inventory.writers ?? null)
      if (openness === null) continue
      const state = stateValue(harvest?.state ?? status?.state)
      if (!protectedWriter && state.value === null) throw new Error('La corrida no tiene un estado reconocido.')
      const ownerFlow = protectedWriter ? (mapValue(owner.phase) ? owner.phase.flow : undefined) : owner.flow
      const association = associationFor(associations, id, ownerAssociationSource(ownerFlow))
      const flow: Observed<string> = association.kind === 'known' ? known(association.flow)
        : unknown(association.kind === 'conflict' ? 'association_conflict' : association.kind === 'unknown' ? 'association_unavailable' : 'not_recorded', 'No hay una asociación inequívoca disponible con un flujo.')
      const live = openness.open === 'running' || (protectedWriter && state.value === 'cessation_uncertain')
      const progress = openness.kind === 'review' ? reviewProgressOf(visible, status) : unknown<ProjectionProgress>('not_applicable', 'La corrida no es una revisión.')
      const request = protectedWriter ? owner.request : owner
      const conductor = mapValue(request) && mapValue(request.conductor) ? request.conductor : null
      const session_family: Observed<'claude' | 'codex'> = conductor?.family === 'claude' || conductor?.family === 'codex'
        ? known(conductor.family) : unknown('owner_family_unavailable', 'No se pudo observar la familia dueña.')
      const delivery = deliveryIdentityOf(protectedWriter, openness.kind, status?.round, status?.launch)
      const run: ProjectionRun = { id, availability: 'available', reason: null, kind: known(openness.kind), state, open: known(openness.open), session, flow,
        live: known(live), progress, session_family, delivery }
      document.runs.items.push(run)
      if (protectedWriter && (state.value === null || !TERMINAL.has(state.value))) {
        writers.push({ id, availability: 'available', reason: null, state, open: run.open, session, flow, live: run.live })
      }
    } catch {
      if (protectedWriter || (!controlObserved && store !== null)) writerUnavailable = true
      document.runs.items.push({ id, availability: 'unavailable', reason: { code: 'run_unreadable', detail: 'No se pudo observar la corrida.' },
        kind: unknown('run_unreadable', 'Clase desconocida.'), state: unknown('run_unreadable', 'Estado desconocido.'), open: unknown('run_unreadable', 'Apertura desconocida.'),
        session: unknown('run_unreadable', 'Sesión desconocida.'), flow: unknown('run_unreadable', 'Asociación desconocida.'),
        live: unknown('run_unreadable', 'Actividad desconocida.'), progress: unknown('run_unreadable', 'Progreso desconocido.'),
        session_family: unknown('run_unreadable', 'Familia desconocida.'), delivery: unknown('run_unreadable', 'Entrega desconocida.') })
    }
  }
  finishCollection(document.runs)
  if (inventory.unavailable.length === 2 && document.runs.items.length === 0) document.runs.availability = 'unavailable'
  if (writerUnavailable || writers.length > 1) document.writer = { availability: 'unavailable',
    reason: { code: writerUnavailable ? 'writer_unreadable' : 'writer_conflict', detail: 'No se pudo identificar un único writer en vuelo desde su almacén protegido.' }, item: null }
  else document.writer.item = writers[0] ?? null

  try {
    const route = join(root, '.sdd-ai', 'hooks', 'route')
    const st = lstat(route)
    if (st !== null) {
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('El almacén de ligas no es un directorio regular.')
      for (const name of readdirSync(route)) if (/^[A-Za-z0-9._-]+\.json$/.test(name)) sessions.add(name.slice(0, -5))
    }
    for (const session of [...sessions].sort()) {
      let binding: ReturnType<typeof readBinding>
      try {
        sourceObject(join(route, `${session}.json`), true)
        binding = readBinding(root, session)
      } catch { binding = 'unreadable' }
      const item: ProjectionBinding = binding === 'unreadable'
        ? { id: session, availability: 'unavailable', reason: { code: 'binding_unreadable', detail: 'La liga no se pudo observar.' }, flow: unknown('binding_unreadable', 'Liga no disponible.') }
        : { id: session, availability: 'available', reason: null, flow: binding === null ? unknown('unbound', 'La sesión no tiene liga.') : known(binding) }
      document.bindings.items.push(item)
    }
    finishCollection(document.bindings)
  } catch {
    document.bindings = { availability: 'unavailable', reason: { code: 'bindings_unreadable', detail: 'No se pudo observar el almacén de ligas.' }, items: [] }
  }
  document.observation.read_finished_at = Date.now()
  return document
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * Omisiones estables: primero los done opcionales, después los demás flujos sin liga ni actividad, cada grupo por id,
 * y se omite lo mínimo para entrar en el límite. Cada flujo se mide una sola vez: el tamaño de cada omisión se calcula
 * restando del total, y una serialización final lo comprueba.
 */
export function boundProjection(document: Projection): Projection {
  const output: Projection = { ...document, flows: { ...document.flows, items: [...document.flows.items] }, omissions: document.omissions.map((entry) => ({ ...entry })) }
  const fits = () => bytesOf(output) + 1 < PROJECTION_MAX_BYTES
  if (fits()) return output
  const mandatory = new Set<string>()
  for (const binding of output.bindings.items) if (binding.flow.value !== null) mandatory.add(binding.flow.value.id)
  for (const run of output.runs.items) if (run.flow.value !== null) mandatory.add(run.flow.value)
  if (output.writer.item?.flow.value) mandatory.add(output.writer.item.flow.value)
  // Una liga o asociación ilegible no permite certificar que un flujo sea opcional.
  if (output.bindings.availability !== 'available' || output.runs.availability !== 'available'
    || output.writer.availability !== 'available' || output.runs.items.some((run) =>
    ['association_conflict', 'association_unavailable'].includes(run.flow.reason?.code ?? ''))) {
    for (const flow of output.flows.items) mandatory.add(flow.id)
  }
  const note = (code: string) => {
    const existing = output.omissions.find((entry) => entry.collection === 'flows' && entry.reason.code === code)
    if (existing) existing.count++
    else output.omissions.push({ collection: 'flows', count: 1, reason: { code, detail: 'Flujos opcionales omitidos por el límite de lectura.' } })
  }
  const all = output.flows.items
  const removable = [true, false].flatMap((done) => all.filter((flow) => !mandatory.has(flow.id) && (flow.status.value === 'done') === done)
    .map((flow) => ({ id: flow.id, done })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  // El serializado es la composición de sus partes: lo que no son los flujos ni las omisiones no cambia al omitir.
  const header = () => ({ ...output.flows, items: [] })
  const unchanged = bytesOf({ ...output, flows: header(), omissions: [] }) + 1 - bytesOf(header()) - bytesOf([])
  const sizes = new Map(all.map((flow) => [flow.id, bytesOf(flow)]))
  let items = all.reduce((sum, flow) => sum + sizes.get(flow.id)!, 0)
  let count = all.length
  const omitted = new Set<string>()
  const materialize = () => { output.flows.items = all.filter((flow) => !omitted.has(flow.id)) }
  for (const { id, done } of removable) {
    omitted.add(id)
    items -= sizes.get(id)!
    count--
    note(done ? 'size_done_flows' : 'size_unassociated_flows')
    output.flows.availability = 'partial'
    output.flows.reason = { code: 'size_omission', detail: 'El catálogo observado tiene omisiones por tamaño.' }
    // Los elementos de una lista van separados por una coma.
    const estimate = unchanged + bytesOf(header()) + items + Math.max(count - 1, 0) + bytesOf(output.omissions)
    if (estimate < PROJECTION_MAX_BYTES) {
      materialize()
      if (fits()) return output
    }
  }
  materialize()
  // No se presenta una parte del inventario obligatorio como si fuera un inventario completo.
  const reason = { code: 'size_unavailable', detail: 'El inventario obligatorio supera el límite de lectura.' }
  return { schema_version: 1, checkout: document.checkout, observation: document.observation,
    runs: { availability: 'unavailable', reason, items: [] }, writer: { availability: 'unavailable', reason, item: null },
    flows: { availability: 'unavailable', reason, items: [] }, bindings: { availability: 'unavailable', reason, items: [] },
    omissions: [...output.omissions, ...(['runs', 'writer', 'flows', 'bindings'] as const).map((collection) => ({ collection,
      count: collection === 'writer' ? Number(document.writer.item !== null) : collection === 'flows' ? output.flows.items.length : document[collection].items.length, reason }))] }
}

/** El binario que publica en segundo plano. */
const BIN = join(resolve(import.meta.dirname, '..'), 'bin', 'sdd-ai')

/** Quién pidió una publicación: va en la observación, no decide nada. */
export type PublisherKind = ProjectionObservation['publisher']['kind']

/**
 * Pide una publicación a un proceso aparte (`sdd-ai __publish`), desligado de este: el verbo, el hook o el
 * supervisor que la pide no espera la lectura ni la escritura, y su salida, su código y sus decisiones no
 * dependen de ella. Lanzarlo cuesta menos de un milisegundo. Si el proceso no arranca o muere, la publicación
 * se pierde y la corrige la siguiente.
 */
export function requestPublication(root: string, origin: string, publisher: PublisherKind): void {
  // `SDD_AI_PROJECTION=off` apaga la publicación. La usa `npm test`, para que la suite no lance un proceso por
  // cada invocación del binario; las pruebas de la proyección la quitan en los procesos que lanzan. Con
  // cualquier otro valor, o sin la variable, se publica.
  if (process.env.SDD_AI_PROJECTION === 'off') return
  try {
    // El reloj monotónico del pedido, en decimal: el publicador lo compara con el `m0` de las observaciones.
    const requested = clock().toString()
    const child = spawn(process.execPath, [BIN, '__publish', root, origin, publisher, String(Date.now()), requested], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Sin proceso no hay publicación; la siguiente la repara.
  }
}

/**
 * La observación más nueva de `live/`, la que eligen los consumidores, si ya cubre un pedido hecho con el reloj
 * monotónico `requested`: es válida, de este checkout y de este arranque, y su `m0` es posterior al pedido sin estar
 * adelante del reloj. Su publicador leyó las fuentes después del cambio que pidió la publicación. Ante cualquier duda
 * (un `live/` inundado, una más nueva ilegible, de otro arranque o adelantada) devuelve `null`, y se publica.
 */
function coveringObservation(root: string, boot: string, requested: bigint): string | null {
  try {
    return inside(root, false, () => {
      const names = entries()
      if (names.length > PROJECTION_MAX_ENTRIES) return null
      const newest = names.filter((name) => OBSERVATION_NAME.test(name)).sort().at(-1)
      if (newest === undefined) return null
      const [, m0, observedBoot] = OBSERVATION_NAME.exec(newest)!
      if (observedBoot !== boot || BigInt(m0) <= requested || BigInt(m0) > clock()) return null
      const validation = validateProjection(JSON.parse(regularText(newest, PROJECTION_MAX_BYTES)))
      return validation.ok && validation.document.observation.id === newest && validation.document.checkout.root === root ? newest : null
    })
  } catch { return null }
}

/**
 * Espera, sin una reserva propia en `live/`, a que la reserva `name` deje de estar viva: que desaparezca, que su proceso
 * ya no exista o que venza. Mira cada `QUEUE_POLL_MS` y no pasa de `deadline`. Si no puede entrar al directorio
 * verificado, deja de esperar: el intento siguiente lo repara o lee.
 */
function awaitClaim(root: string, boot: string, name: string, deadline: bigint): void {
  for (;;) {
    let alive: boolean
    try { alive = inside(root, false, () => liveClaim(name, boot, clock()) !== null) } catch { return }
    const left = deadline - clock()
    if (!alive || left <= 0n) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(QUEUE_POLL_MS, Math.ceil(Number(left) / 1_000_000)))
  }
}

/**
 * Publica ahora, en este proceso: es lo que corre `sdd-ai __publish`. Con el reloj monotónico del pedido
 * (`requested`), antes de leer las fuentes mira `live/`: si una observación ya cubre el pedido, termina sin leer nada;
 * si no, cede ante la reserva viva de un publicador que empezó a leer después del pedido, y si tampoco la hay, lee y
 * publica con su propia reserva. Así, de varios pedidos que llegan juntos, lee uno solo en el caso común.
 *
 * Si en cambio un publicador que empezó a leer antes del pedido sigue leyendo, queda en la cola: sin reserva propia,
 * espera a que esa reserva deje de estar viva y vuelve a empezar, mirando otra vez si una observación ya cubre el pedido
 * y, si no, con una reserva y un `m0` nuevos. De los que despiertan juntos, lee el primero que se decide y los demás le
 * ceden, así que por checkout leen a lo sumo el que corre y el siguiente. La cola espera en total hasta
 * `QUEUE_WAIT_NS` y vuelve a empezar hasta `QUEUE_ROUNDS` veces; después lee igual, aunque el anterior siga detenido,
 * salvo que una observación o una reserva ya cubran el pedido. Corre en el proceso aparte: no le suma tiempo al verbo.
 *
 * Con `SDD_AI_PROJECTION_MEASURE` agrega a ese archivo una línea JSON con lo que tardó y con la latencia desde el cambio
 * que la pidió; un pedido cubierto o que cedió queda como `skipped`, con la observación o la reserva que lo cubre, y uno
 * que esperó en la cola anota ante qué reservas (`queued`) y cuánto (`queued_ms`).
 */
export function publishNow(root: string, origin: string, publisher: PublisherKind, triggerAt: number, requested: bigint | null = null): void {
  try {
    // La traza vive aparte: `measure` sigue apareciendo solo cuando terminó el pedido.
    const file = process.env.SDD_AI_PROJECTION_MEASURE
    const traceFile = file ? resolve(`${file}.trace.jsonl`) : null
    const trace = (event: string, detail: object = {}) => {
      if (!traceFile) return
      try {
        appendFileSync(traceFile, `${JSON.stringify({ event, pid: process.pid, at: Date.now(),
          monotonic: clock().toString(), requested: requested?.toString() ?? null, ...detail })}\n`)
      } catch { /* Una medición fallida no cambia la publicación. */ }
    }
    const started = clock()
    const boot = requested === null ? null : systemBootId()
    const deadline = started + QUEUE_WAIT_NS
    trace('started', { deadline: deadline.toString() })
    const queued: string[] = []
    let waited = 0n
    let result: ProjectionPublication
    for (;;) {
      const covering = requested === null || boot === null ? null : coveringObservation(root, boot, requested)
      if (covering !== null) {
        result = { kind: 'skipped', id: covering }
        break
      }
      const queue = boot !== null && queued.length < QUEUE_ROUNDS && clock() < deadline
      trace('attempt', { queue, rounds: queued.length, deadline: deadline.toString() })
      result = publishProjection(root, collectProjection, { publisher, ...(requested === null ? {} : { requested, queue }),
        ...(file ? { stage: (stage: ProjectionStage, context: { attempt: number; id: string | null }) => trace(stage, context) } : {}) })
      trace('returned', { result: result.kind, ...('id' in result ? { id: result.id } : {}) })
      if (result.kind !== 'queued' || boot === null) break
      queued.push(result.id)
      trace('queued', { id: result.id })
      const before = clock()
      awaitClaim(root, boot, result.id, deadline)
      trace('queue_wait_finished', { id: result.id, deadline_reached: clock() >= deadline })
      waited += clock() - before
    }
    trace('finished', { result: result.kind, ...('id' in result ? { id: result.id } : {}) })
    if (file) {
      const at = Date.now()
      const detail = result.kind === 'published' ? { id: result.id, timings: result.timings }
        : result.kind === 'not_published' ? { cause: result.cause } : { id: result.id }
      const queue = queued.length === 0 ? {} : { queued, queued_ms: Number(waited) / 1_000_000 }
      appendFileSync(file, `${JSON.stringify({ where: origin, pid: process.pid, trigger_at: triggerAt, at, latency_ms: at - triggerAt, ms: elapsed(started),
        result: result.kind, ...detail, ...queue })}\n`)
    }
  } catch {
    // La medición no altera al llamador.
  }
}

/** El reloj monotónico de un pedido tal como llega en el argv de `__publish`, o `null` si falta o no es un entero. */
export function requestedClock(value: string | undefined): bigint | null {
  return value !== undefined && /^\d{1,20}$/.test(value) ? BigInt(value) : null
}

const PUBLISHERS: readonly PublisherKind[] = ['cli', 'hook', 'supervisor', 'unknown']

/** El publicador que nombra el argv de `__publish`; uno que no se reconoce queda como desconocido. */
export function publisherKind(value: string | undefined): PublisherKind {
  return PUBLISHERS.find((kind) => kind === value) ?? 'unknown'
}

/** Cada cuánto renueva la proyección un supervisor vivo, aunque nada cambie. */
export const HEARTBEAT_MS = 20_000

/**
 * Llama a `publish` cada `ms` hasta que se llame a la función que devuelve. El temporizador no retiene al
 * proceso: un supervisor termina cuando termina su corrida.
 */
export function heartbeat(publish: () => void, ms = HEARTBEAT_MS): () => void {
  const timer = setInterval(publish, ms)
  timer.unref()
  return () => clearInterval(timer)
}

/** La raíz de una corrida visible (`<raíz>/.sdd-ai/runs/<id>`), o `null` si `dir` no tiene esa forma. */
export function runRoot(dir: string): string | null {
  const runs = dirname(dir)
  const home = dirname(runs)
  return basename(runs) === 'runs' && basename(home) === '.sdd-ai' ? dirname(home) : null
}
