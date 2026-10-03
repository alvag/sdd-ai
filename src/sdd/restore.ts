import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { gitDirs } from '../git.ts'
import { withLock } from '../lock.ts'
import { SddError } from '../types.ts'
import { ownReservation, inspectReservations, liveVerifyGroup, processAlive, readProcess, releaseOrphanVerifyReservation, reservationError } from '../writer-store.ts'
import type { TestRow } from './verification-contract.ts'
import { receiptDir } from './verify-receipt.ts'

// El revert de confirmación de `sdd verify`: devolver a la base las rutas de implementación de una fila,
// correrla y restaurarlas. Antes de tocar el árbol queda una intención durable con los dos contenidos de
// cada ruta. La entrada común la recupera salvo en start, branch y commit: start --apply y
// branch --apply lo hacen después de validar; commit nunca recupera. Se restaura ruta por ruta,
// sin pisar lo que alguien editó.

/** Una ruta de la intención: los sha256 de su contenido en el candidato y en la base, y sus modos. */
export interface IntentPath { path: string; candidate: string; base: string; mode_candidate: string; mode_base: string }
/** `candidate` y `base` nombran blobs guardados en `blobs/` del directorio del recibo. */
export interface RestoreIntent { receipt: string; checkout: string; owner_pid: number; owner_lstart: string | null; paths: IntentPath[] }

const verifyRoot = (root: string) => join(gitDirs(root).gitDir, 'sdd-ai', 'verify')
const intentFile = (root: string) => join(verifyRoot(root), 'restore-intent.json')
const lockFile = (root: string) => join(verifyRoot(root), 'restore.lock')
const blobFile = (root: string, receipt: string, sha: string) => join(receiptDir(root, receipt), 'blobs', sha)

const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** Como Git, un archivo con un byte nulo en sus primeros 8000 es binario. */
const isBinary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0)
const modeOf = (file: string) => ((lstatSync(file).mode & 0o111) !== 0 ? '100755' : '100644')

const git = (root: string, args: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })

/** El modo y el contenido de `path` en `base`, o `null` si no está ahí. */
function atBase(root: string, base: string, path: string): { mode: string; bytes: Buffer } | null {
  const entry = git(root, ['ls-tree', '-z', base, '--', path]).toString('utf8').split('\0')[0]
  if (!entry) return null
  const [mode, type] = entry.split(' ')
  if (type !== 'blob') return { mode, bytes: Buffer.alloc(0) }
  return { mode, bytes: git(root, ['cat-file', 'blob', `${base}:${path}`]) }
}

/** Si la ruta real de `path` cae dentro del checkout, sin seguir un enlace hacia afuera. */
function inside(root: string, path: string): boolean {
  try {
    const real = realpathSync(join(root, path))
    const top = realpathSync(root)
    return real.startsWith(top + sep)
  } catch {
    return false
  }
}

/**
 * Si la fila se puede confirmar revirtiendo sus rutas de implementación. Todas se validan antes de tocar
 * ninguna: cada una tiene que ser un archivo regular de texto, presente en la base y en el candidato con
 * contenido distinto, sin compartirse con la prueba y dentro del repositorio. El motivo del rechazo es el
 * que conserva el recibo.
 */
export function inspectRevertPaths(root: string, baseCommit: string, row: TestRow): { eligible: true } | { eligible: false; reason: string } {
  const no = (reason: string) => ({ eligible: false as const, reason })
  for (const path of row.implementation_paths) {
    if (row.test_paths.includes(path)) return no(`${path} es también una ruta de la prueba`)
    const base = atBase(root, baseCommit, path)
    const file = join(root, path)
    let st
    try {
      st = lstatSync(file)
    } catch {
      return no(base ? `${path} fue borrada o renombrada en el cambio` : `${path} no existe`)
    }
    if (!base) return no(`${path} es nueva en el cambio`)
    if (st.isSymbolicLink() || base.mode === '120000') return no(`${path} es un enlace`)
    if (!st.isFile() || (base.mode !== '100644' && base.mode !== '100755')) return no(`${path} no es un archivo regular`)
    if (!inside(root, path)) return no(`${path} cae fuera del repositorio`)
    const bytes = readFileSync(file)
    if (isBinary(bytes) || isBinary(base.bytes)) return no(`${path} es binaria`)
    if (bytes.equals(base.bytes)) return no(modeOf(file) !== base.mode ? `${path} solo cambió de modo` : `${path} no cambió respecto de la base`)
  }
  return { eligible: true }
}

/** Sincroniza las entradas de un directorio: sin esto, un corte puede perder un archivo recién creado o renombrado. */
function syncDir(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Crea `dir` si falta y sincroniza su entrada y la de cada directorio que lo contiene hasta el de Git: la
 * primera verificación crea `sdd-ai/verify/`, y un corte no puede perderlo con la intención adentro.
 */
function durableDir(root: string, dir: string): void {
  mkdirSync(dir, { recursive: true })
  const top = gitDirs(root).gitDir
  for (let d = dir; ; d = dirname(d)) {
    syncDir(d)
    if (d === top || dirname(d) === d) break
  }
}

/**
 * Escribe `bytes` entero en un temporal del mismo directorio, lo sincroniza, lo renombra sobre `file` y
 * sincroniza el directorio. `writeFileSync` sobre el descriptor repite la escritura hasta el último byte.
 */
function writeSynced(file: string, bytes: Buffer | string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  syncDir(dirname(file))
}

/**
 * Guarda los dos contenidos de cada ruta en el directorio del recibo y arma la intención de revertirlas.
 * No toca el árbol: eso lo hace `revertPaths`, después de `writeRestoreIntent`.
 */
export function prepareIntent(root: string, receipt: string, baseCommit: string, paths: readonly string[]): RestoreIntent {
  durableDir(root, join(receiptDir(root, receipt), 'blobs'))
  const entries = paths.map((path): IntentPath => {
    const candidate = readFileSync(join(root, path))
    const base = atBase(root, baseCommit, path)
    if (!base) throw new SddError('restore_invalid', `${path} no está en la base`)
    writeSynced(blobFile(root, receipt, hex(candidate)), candidate)
    writeSynced(blobFile(root, receipt, hex(base.bytes)), base.bytes)
    return { path, candidate: hex(candidate), base: hex(base.bytes), mode_candidate: modeOf(join(root, path)), mode_base: base.mode }
  })
  const seen = readProcess(process.pid)
  return { receipt, checkout: realpathSync(root), owner_pid: process.pid, owner_lstart: seen && seen !== 'gone' ? seen.lstart : null, paths: entries }
}

/** Publica la intención de forma atómica y sincronizada, antes de tocar el árbol. */
export function writeRestoreIntent(root: string, intent: RestoreIntent): void {
  durableDir(root, verifyRoot(root))
  writeSynced(intentFile(root), `${JSON.stringify(intent, null, 2)}\n`)
}

export function closeRestoreIntent(root: string): void {
  rmSync(intentFile(root), { force: true })
}

/** Si hay una intención de restauración abierta en este checkout. La guarda de commit la consulta. */
export function restoreIntentOpen(root: string): boolean {
  return existsSync(intentFile(root))
}

const setMode = (file: string, mode: string) => chmodSync(file, mode === '100755' ? 0o755 : 0o644)

/** Si la ruta sigue siendo el candidato guardado: el mismo contenido y el mismo modo. */
const stillCandidate = (root: string, p: IntentPath) => classify(root, p) === 'candidate' && modeOf(join(root, p.path)) === p.mode_candidate

/**
 * Pone en cada ruta su contenido y su modo de la base, y devuelve las rutas que ya no eran el candidato
 * guardado, por contenido o por modo. Primero valida todas: si alguna cambió después de guardarla, porque
 * alguien la editó, no toca ninguna. Después vuelve a mirar cada una justo antes de escribirla, porque las
 * escrituras sincronizadas de las anteriores llevan su tiempo: si cambió en el medio, restaura las que ya
 * revirtió y la devuelve. Entre esa última mirada y el renombrado queda una ventana que el sistema de
 * archivos no permite cerrar.
 */
export function revertPaths(root: string, intent: RestoreIntent): string[] {
  const changed = intent.paths.filter((p) => !stillCandidate(root, p)).map((p) => p.path)
  if (changed.length > 0) return changed
  const reverted: IntentPath[] = []
  for (const p of intent.paths) {
    if (!stillCandidate(root, p)) {
      restorePaths(root, { ...intent, paths: reverted })
      return [p.path]
    }
    writeSynced(join(root, p.path), readFileSync(blobFile(root, intent.receipt, p.base)))
    setMode(join(root, p.path), p.mode_base)
    reverted.push(p)
  }
  return []
}

/**
 * Pone en cada ruta su contenido y su modo del candidato. Primero valida todas: si alguna tiene un tercer
 * contenido, porque la editó la prueba o una persona mientras estaba revertida, no toca ninguna, da
 * `restore_conflict` y la intención queda abierta. Así nunca pisa una edición ajena.
 */
export function restorePaths(root: string, intent: RestoreIntent): void {
  const bad = intent.paths.filter((p) => classify(root, p) === 'conflict').map((p) => p.path)
  if (bad.length > 0) throw restoreConflict(root, intent, bad)
  for (const p of intent.paths) {
    const file = join(root, p.path)
    if (hex(readFileSync(file)) !== p.candidate) writeSynced(file, readFileSync(blobFile(root, intent.receipt, p.candidate)))
    setMode(file, p.mode_candidate)
  }
}

function restoreConflict(root: string, intent: RestoreIntent, bad: readonly string[]): SddError {
  return new SddError('restore_conflict', `hay rutas revertidas por verify que ya no tienen ni su contenido ni el de la base: ${bad.join(', ')}`, {
    detail: `la intención sigue en ${intentFile(root)}, con los blobs en ${join(receiptDir(root, intent.receipt), 'blobs')}`,
    next: 'decide con el usuario qué contenido conservar en esas rutas; después borra la intención y vuelve a correr el comando',
  })
}

/** El contenido actual de cada ruta, validado: archivo regular, no enlace, dentro del repo y con uno de sus dos contenidos. */
function classify(root: string, p: IntentPath): 'candidate' | 'base' | 'conflict' {
  const file = join(root, p.path)
  try {
    if (!lstatSync(file).isFile() || !inside(root, p.path)) return 'conflict'
  } catch {
    return 'conflict'
  }
  const h = hex(readFileSync(file))
  return h === p.candidate ? 'candidate' : h === p.base ? 'base' : 'conflict'
}

/**
 * Resuelve la intención pendiente de este checkout, antes de cualquier otra acción del verbo. Corre bajo
 * un lock propio que nunca se roba: con un titular muerto da `recovery_busy`, y hay que borrar el lock a
 * mano. Si el dueño de la intención sigue vivo, o murió pero la fila que lanzó sigue corriendo en su grupo,
 * `non_blocking` lo informa y `blocking` se detiene. Si no, primero valida todas las rutas: con una que no es archivo regular, sale del repo o tiene un
 * tercer contenido, no toca ninguna y da `restore_conflict`. Si todas están bien, restaura las que siguen
 * en la base y cierra la intención. Al final libera la reserva de una verificación que murió, haya o no
 * intención.
 */
export function recoverPendingRestore(root: string, mode: 'blocking' | 'non_blocking'): { state: 'none' | 'restored' | 'in_progress' } {
  let state: 'none' | 'restored' | 'in_progress' = 'none'
  if (existsSync(intentFile(root))) {
    const busy = () => new SddError('recovery_busy', 'otro comando de sdd-ai está resolviendo una restauración de verify', {
      next: `si no hay otro comando de sdd-ai corriendo, borra ${lockFile(root)} y vuelve a correr el comando`,
    })
    state = withLock(lockFile(root), busy, () => {
      if (!existsSync(intentFile(root))) return 'none'
      const intent = JSON.parse(readFileSync(intentFile(root), 'utf8')) as RestoreIntent
      if (intent.checkout !== realpathSync(root)) return 'none'
      const reservation = ownReservation(root, 'verify', intent.receipt)
      const conflict = inspectReservations(root, ['checkout'], reservation ? [reservation] : [])
      if (conflict) {
        if (mode === 'non_blocking') return 'in_progress'
        // El titular puede ser cualquier operación del checkout: el error es el de esa reserva, con su código.
        const held = reservationError(conflict)
        throw new SddError(held.code, `${held.message}; la restauración de verify ${intent.receipt} espera a que termine`, { detail: held.detail, next: held.next })
      }
      const group = liveVerifyGroup(root, intent.receipt, reservation)
      if (processAlive(intent.owner_pid, intent.owner_lstart) || group !== null) {
        if (mode === 'non_blocking') return 'in_progress'
        throw new SddError('verify_in_progress', `sdd verify está confirmando filas con archivos revertidos (recibo ${intent.receipt})`, {
          detail: group === null ? undefined : `sdd verify terminó, pero su fila sigue corriendo en el grupo de procesos ${group}`,
          next: group === null ? 'espera a que termine y vuelve a correr el comando'
            : `espera a que termine o termínala con kill -- -${group}, y vuelve a correr el comando`,
        })
      }
      restorePaths(root, intent)
      closeRestoreIntent(root)
      return 'restored'
    })
  }
  releaseOrphanVerifyReservation(root)
  return { state }
}
