import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Un fallo de la escritura durable de `sdd verify`: lleva la operación, la ruta y el `code` del error original. */
export class DurableWriteError extends Error {
  op: string
  path: string
  code: string | undefined

  constructor(op: string, path: string, cause: unknown) {
    const original = cause as { message?: string; code?: string }
    super(`no se pudo ${op} ${path}: ${original?.message ?? String(cause)}`, { cause })
    this.name = 'DurableWriteError'
    this.op = op
    this.path = path
    this.code = original?.code
  }
}

/**
 * Corre `fn` y envuelve su error, si no es ya un `DurableWriteError`, con la operación y la ruta. No sincroniza
 * nada: solo marca el error como de la escritura durable. La usan `verify-receipt.ts` y `restore.ts`, y `sdd verify`
 * traduce el error a `durable_write_failed`.
 */
export function withDurableWriteError<T>(op: string, path: string, fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof DurableWriteError) throw error
    throw new DurableWriteError(op, path, error)
  }
}


/** Sincroniza las entradas; un fallo impide dar por durable el efecto anterior. */
export function syncArchiveDirectory(path: string): void {
  withDurableWriteError('sincronizar el directorio', path, () => {
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  })
}

/** Crea una entrada exclusiva: nunca adopta un directorio existente. */
export function createArchiveDirectory(path: string): void {
  withDurableWriteError('crear el directorio exclusivo', path, () => mkdirSync(path))
  syncArchiveDirectory(path)
  syncArchiveDirectory(dirname(path))
}

/** Publica bytes nuevos sin sobrescribir y sincroniza tanto cuerpo como entrada. */
export function writeArchiveExclusive(path: string, bytes: Buffer | string): void {
  withDurableWriteError('escribir el archivo exclusivo', path, () => {
    const fd = openSync(path, 'wx', 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  })
  syncArchiveDirectory(dirname(path))
}

/** Reemplaza únicamente un registro mutable propio; el manifiesto usa escritura exclusiva. */
export function writeArchiveProgress(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  writeArchiveExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`)
  withDurableWriteError('publicar el progreso', path, () => renameSync(temporary, path))
  syncArchiveDirectory(dirname(path))
}
