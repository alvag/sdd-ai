// Inyector de fallos de `node:fs` para las pruebas de la escritura durable de `sdd verify`. Reemplaza `openSync`,
// `fsyncSync`, `closeSync` y `renameSync` en el objeto de `node:fs` y llama a `syncBuiltinESMExports()`, porque
// `src/` los importa con nombre. En proceso se usa con `withFsFault`; en el binario se carga con `--import` y el
// fallo viaja como JSON en `SDD_TEST_FS_FAULT`.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

/**
 * `open-dir` falla la apertura de un directorio, `sync-dir` su `fsync`, `sync-file` el `fsync` de un archivo y
 * `rename` el renombrado. Sin `suffix` el fallo vale para cualquier directorio (o archivo, o destino); con `suffix`,
 * solo para las rutas que terminan en él.
 * `platform` redefine `process.platform` mientras dura la inyección.
 */
export interface FsFault { op: 'open-dir' | 'sync-dir' | 'sync-file' | 'rename'; code: string; suffix?: string; platform?: NodeJS.Platform }

const mutable = fs as unknown as Record<string, (...args: any[]) => any>

const slashes = (path: unknown) => String(path).replaceAll('\\', '/')

function install(spec: FsFault): () => void {
  const original = { openSync: mutable.openSync, fsyncSync: mutable.fsyncSync, closeSync: mutable.closeSync, renameSync: mutable.renameSync }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const failing = new Map<number, string>()
  const matches = (path: unknown) => spec.suffix === undefined || slashes(path).endsWith(spec.suffix)
  const fail = (path: unknown) => Object.assign(new Error(`${spec.code}: fallo inyectado en ${spec.op} '${String(path)}'`), { code: spec.code })
  const isDir = (path: unknown) => {
    try {
      return typeof path === 'string' && fs.statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  mutable.openSync = (path: unknown, ...rest: unknown[]) => {
    if ((spec.op === 'open-dir' || spec.op === 'sync-dir') && matches(path) && isDir(path)) {
      if (spec.op === 'open-dir') throw fail(path)
      // Un descriptor de un archivo cualquiera hace de directorio: así el fallo no depende de lo que el sistema real permita abrir.
      const fd = original.openSync(process.execPath, 'r')
      failing.set(fd, String(path))
      return fd
    }
    const fd = original.openSync(path, ...rest)
    if (spec.op === 'sync-file' && matches(path) && !isDir(path)) failing.set(fd, String(path))
    return fd
  }
  mutable.fsyncSync = (fd: number) => {
    const path = failing.get(fd)
    if (path !== undefined) throw fail(path)
    return original.fsyncSync(fd)
  }
  mutable.closeSync = (fd: number) => {
    failing.delete(fd)
    return original.closeSync(fd)
  }
  mutable.renameSync = (from: unknown, to: unknown) => {
    if (spec.op === 'rename' && matches(to)) throw fail(to)
    return original.renameSync(from, to)
  }
  if (spec.platform !== undefined) Object.defineProperty(process, 'platform', { value: spec.platform, configurable: true })
  syncBuiltinESMExports()

  return () => {
    Object.assign(mutable, original)
    if (spec.platform !== undefined && platform !== undefined) Object.defineProperty(process, 'platform', platform)
    syncBuiltinESMExports()
  }
}

/** Corre `fn` con el fallo instalado; siempre restaura `node:fs` y la plataforma, también si `fn` es asíncrona. */
export function withFsFault<T>(spec: FsFault, fn: () => T): T {
  const restore = install(spec)
  let result: T
  try {
    result = fn()
  } catch (error) {
    restore()
    throw error
  }
  if (result instanceof Promise) return result.finally(restore) as T
  restore()
  return result
}

// Cargado con `--import`: el fallo vale para todo el proceso, y la variable no pasa a los procesos que lance.
if (process.env.SDD_TEST_FS_FAULT) {
  const spec = JSON.parse(process.env.SDD_TEST_FS_FAULT) as FsFault
  delete process.env.SDD_TEST_FS_FAULT
  install(spec)
}
