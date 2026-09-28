import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAlive } from './runs.ts'
import type { SddError } from './types.ts'
import { readProcess } from './writer-store.ts'

// Un lock de archivo que serializa comandos sobre el mismo objeto. Nace completo y nunca se roba: quien
// lo encuentra espera mientras su titular siga vivo, y ante un titular muerto rechaza enseguida.

interface Holder { pid: number; lstart: string | null }

const POLL_MS = 100
/** Sin `ps` no hay hora de arranque que descarte un pid reciclado: la espera tiene tope. */
const DEGRADED_WAIT_MS = 60_000

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * El titular de un lock, `released` si ya no está u `orphan` si no lo escribió este código: un enlace,
 * algo que no es un archivo regular o un contenido que no es `{pid, lstart}`. Un lock de antes, con
 * solo el pid, también es huérfano: el pid pudo reciclarse. Se abre sin seguir enlaces ni bloquearse.
 */
function holderOf(file: string): Holder | 'released' | 'orphan' {
  try {
    if (!lstatSync(file).isFile()) return 'orphan'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'released'
    throw e
  }
  let text: string
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'released'
    return 'orphan'
  }
  try {
    if (!fstatSync(fd).isFile()) return 'orphan'
    text = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return 'orphan'
  }
  if (typeof v !== 'object' || v === null) return 'orphan'
  const { pid, lstart } = v as Record<string, unknown>
  if (!Number.isInteger(pid) || (pid as number) <= 1 || (lstart !== null && typeof lstart !== 'string')) return 'orphan'
  return { pid: pid as number, lstart: lstart as string | null }
}

/**
 * Si el titular sigue vivo. Con su hora de arranque, es el mismo proceso si `ps` lo encuentra con esa
 * hora; sin ella, o sin `ps` para compararla, alcanza con que el pid exista, hasta el tope.
 */
function holderAlive(h: Holder, since: number): boolean {
  if (h.lstart !== null) {
    const seen = readProcess(h.pid)
    if (seen !== undefined) return seen !== 'gone' && seen.lstart === h.lstart
  }
  return isAlive(h.pid) && Date.now() - since < DEGRADED_WAIT_MS
}

function acquire(file: string, busy: () => SddError): void {
  const seen = readProcess(process.pid)
  const mine: Holder = { pid: process.pid, lstart: seen && seen !== 'gone' ? seen.lstart : null }
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(mine)}\n`)
  try {
    const since = Date.now()
    for (;;) {
      try {
        linkSync(tmp, file)
        return
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const holder = holderOf(file)
      if (holder === 'released') continue
      if (holder === 'orphan' || !holderAlive(holder, since)) throw busy()
      sleep(POLL_MS)
    }
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Corre `fn` con el lock tomado y lo suelta al terminar, también si falla. */
export function withLock<T>(file: string, busy: () => SddError, fn: () => T): T {
  acquire(file, busy)
  try {
    return fn()
  } finally {
    rmSync(file, { force: true })
  }
}

/** Como `withLock`, pero suelta el lock después de que termina la promesa de `fn`. */
export async function withLockAsync<T>(file: string, busy: () => SddError, fn: () => Promise<T>): Promise<T> {
  acquire(file, busy)
  try {
    return await fn()
  } finally {
    rmSync(file, { force: true })
  }
}
