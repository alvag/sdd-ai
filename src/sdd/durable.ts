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
