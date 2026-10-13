import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SddError } from '../types.ts'

export type ArchiveFaultPoint = 'before_source_read' | 'before_destination_read' | 'after_copy_entry'
  | 'before_staging_verify' | 'after_staging_cleanup_entry' | 'after_publication_link'
  | 'after_documents_publication' | 'after_vault_staging' | 'after_vault_commit' | 'before_claim'
  | 'after_claim' | 'before_retirement_entry' | 'after_retirement_entry'
export interface ArchiveFaultContext { operation_id: string; phase: string; path?: string }
export type ArchiveFaultInjector = (point: ArchiveFaultPoint, context: ArchiveFaultContext) => void
export class ArchiveInjectedCrash extends Error {
  constructor(point: ArchiveFaultPoint) { super(`interrupción de archive: ${point}`); this.name = 'ArchiveInjectedCrash' }
}
export const isArchiveInjectedCrash = (error: unknown): error is ArchiveInjectedCrash => error instanceof ArchiveInjectedCrash

export interface ArchiveFile { path: string; size: number; sha256: string }
export interface ArchiveInventory { directories: string[]; files: ArchiveFile[] }
export const archiveHash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export const archiveOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** Las diferencias comprobadas se distinguen de una lectura que no permite concluir nada. */
export class ArchiveDifference extends SddError {
  constructor(path: string, reason: string) {
    super('archive_difference', `material de archivo distinto: ${path}`, { detail: reason })
  }
}

export function archiveContained(base: string, path: string, allowRoot = false): string {
  const rel = relative(resolve(base), resolve(path))
  if ((!allowRoot && rel === '') || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SddError('archive_path_invalid', 'las rutas del archivo no están contenidas')
  }
  return rel
}

export function archiveSeparated(paths: string[]): void {
  for (let i = 0; i < paths.length; i++) for (const other of paths.slice(i + 1)) {
    for (const [a, b] of [[paths[i], other], [other, paths[i]]]) {
      const rel = relative(resolve(a), resolve(b))
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
        throw new SddError('archive_path_invalid', 'origen, destino y áreas de operación se superponen')
      }
    }
  }
}

/** Solo una ausencia constatada antes de abrir permite fallback; una desaparición al leer es error. */
export function archiveStat(base: string, path: string): Stats | null {
  const rel = archiveContained(base, path, true)
  const components = rel ? rel.split(sep) : []
  let current = resolve(base)
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = join(current, components[i])
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new SddError('archive_read_failed', `no se pudo inspeccionar ${relative(base, path) || '.'}`, {
        detail: (error as NodeJS.ErrnoException).code ?? 'lectura fallida',
      })
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (i < components.length - 1 || !stat.isFile()))) {
      throw new SddError('archive_path_invalid', `ruta no regular: ${relative(base, current) || '.'}`)
    }
    if (i === components.length - 1) return stat
  }
  throw new Error('ruta sin inspeccionar')
}

export function readArchiveFile(base: string, path: string): Buffer | null {
  const before = archiveStat(base, path)
  if (before === null) return null
  if (!before.isFile()) throw new SddError('archive_path_invalid', `no es un archivo regular: ${relative(base, path)}`)
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('entrada reemplazada')
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    const entry = archiveStat(base, path)
    if (!entry || entry.dev !== opened.dev || entry.ino !== opened.ino || after.size !== bytes.length
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('lectura inestable')
    return bytes
  } catch (error) {
    throw new SddError('archive_read_failed', `no se pudo leer ${relative(base, path)}`, {
      detail: (error as NodeJS.ErrnoException).code ?? 'lectura inestable',
    })
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function inventoryArchiveTree(base: string): ArchiveInventory {
  const result: ArchiveInventory = { directories: [], files: [] }
  const top = archiveStat(base, base)
  if (!top?.isDirectory()) throw new SddError('archive_read_failed', 'el origen no es un directorio disponible')
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir, { encoding: 'buffer' }).map((bytes) => {
        const name = bytes.toString('utf8')
        if (!Buffer.from(name).equals(bytes)) throw new SddError('archive_path_invalid', 'nombre no representable en UTF-8')
        return name
      }).sort(archiveOrder)
    } catch (error) {
      if (error instanceof SddError) throw error
      throw new SddError('archive_read_failed', `no se pudo listar ${relative(base, dir) || '.'}`, {
        detail: (error as NodeJS.ErrnoException).code ?? 'lectura fallida',
      })
    }
    for (const name of names) {
      const path = join(dir, name), rel = relative(base, path)
      // Los nombres deben sobrevivir a JSON, UTF-8 y a las consultas NUL de Git sin cambiar.
      if (Buffer.from(name).toString() !== name || /[\r\n\0]/.test(name)) throw new SddError('archive_path_invalid', 'nombre no representable en el inventario')
      const st = archiveStat(base, path)
      if (st === null) throw new SddError('archive_read_failed', `desapareció ${rel} durante el inventario`)
      if (st.isDirectory()) { result.directories.push(rel); walk(path) }
      else {
        const bytes = readArchiveFile(base, path)
        if (bytes === null) throw new SddError('archive_read_failed', `desapareció ${rel} durante el inventario`)
        result.files.push({ path: rel, size: bytes.length, sha256: archiveHash(bytes) })
      }
    }
  }
  walk(base)
  result.directories.sort(archiveOrder)
  result.files.sort((a, b) => archiveOrder(a.path, b.path))
  return result
}

export function verifyArchiveTree(base: string, expected: ArchiveInventory): void {
  if (archiveStat(base, base) === null) throw new ArchiveDifference('.', 'falta el árbol registrado')
  const actual = inventoryArchiveTree(base)
  // El inventario ligado tiene sus claves canonizadas; se compara por campos, no por orden de claves.
  const key = (inventory: ArchiveInventory) => JSON.stringify([inventory.directories,
    inventory.files.map((file) => [file.path, file.size, file.sha256])])
  if (key(actual) !== key(expected)) throw new ArchiveDifference('.', 'el conjunto de rutas, tamaños o SHA-256 no coincide')
}
