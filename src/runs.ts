import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Conductor, type Family, SddError, type Status, TERMINAL } from './types.ts'

/**
 * `<raíz>/.sdd-ai/runs`. Vive en el árbol de trabajo y no en `.git/` porque el sandbox de Codex deja
 * `.git` en solo lectura. El `.gitignore` con `*` hace que `.sdd-ai/` se ignore solo, sin tocar el
 * `.gitignore` del repo.
 */
export function runsRoot(root: string): string {
  const home = join(root, '.sdd-ai')
  const runs = join(home, 'runs')
  mkdirSync(runs, { recursive: true })
  ensureIgnore(home)
  return runs
}

/** No pisa un archivo existente, tampoco si otro proceso acaba de crearlo. */
export function ensureIgnore(home: string): void {
  try {
    writeFileSync(join(home, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

export function newRunId(now: Date = new Date(), rand: () => string = () => randomBytes(2).toString('hex')): string {
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `${day}-${pad(now.getHours())}${pad(now.getMinutes())}-${rand()}`
}

export function createRun(root: string, id: string): string {
  const dir = join(runsRoot(root), id)
  mkdirSync(dir)
  return dir
}

/**
 * La sesión del CLI que conduce: la misma que reciben sus hooks como `session_id`. Se lee de la familia
 * del conductor porque una sesión de Codex abierta desde Claude Code hereda las dos variables.
 */
export function ownerSession(env: Record<string, string | undefined>, family: Family): string | undefined {
  const id = family === 'claude' ? env.CLAUDE_CODE_SESSION_ID : env.CODEX_SESSION_ID
  return id || undefined
}

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/

/** Un id de corrida es un solo segmento de ruta, la misma forma que los ids de flujo y de sesión. */
export const isRunId = (id: string) => RUN_ID.test(id) && id !== '.' && id !== '..'

/** El id tal cual si es válido. Va antes de armar cualquier ruta con él, en `.sdd-ai/` o en `.git/`. */
export function checkRunId(id: string): string {
  if (!isRunId(id)) {
    throw new SddError('usage', `el id de corrida no es válido: ${id}`, {
      detail: 'un id lleva solo letras, dígitos, ., _ y -, hasta 128 caracteres, y no es . ni ..',
    })
  }
  return id
}

export function runDir(root: string, id: string): string {
  const dir = join(root, '.sdd-ai', 'runs', checkRunId(id))
  if (!existsSync(dir)) {
    throw new SddError('run_not_found', `no existe la corrida ${id}`, { next: 'revisa el id que devolvió sdd-ai run' })
  }
  return dir
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, file)
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

export function readStatus(dir: string): Status {
  return readJson<Status>(join(dir, 'status.json'))
}

/** Quien quiera enterarse de cada `status.json` escrito; lo registra el binario al arrancar. */
let statusWritten: ((dir: string) => void) | null = null

/** Registra quién se entera de cada `status.json` escrito y devuelve al anterior, para restaurarlo. */
export function onStatusWritten(fn: ((dir: string) => void) | null): ((dir: string) => void) | null {
  const previous = statusWritten
  statusWritten = fn
  return previous
}

export function setStatus(dir: string, patch: Partial<Status>): Status {
  const file = join(dir, 'status.json')
  const current = existsSync(file) ? readJson<Status>(file) : ({} as Status)
  const next = { ...current, ...patch }
  writeJsonAtomic(file, next)
  try {
    statusWritten?.(dir)
  } catch {
    // El estado ya quedó escrito: quien se entera no cambia el resultado de quien lo escribió.
  }
  return next
}

interface Delivery { round: number | null; launch: number | null }

const deliveryOf = (s: Status): Delivery => ({ round: s.round ?? null, launch: s.launch ?? null })

/**
 * Anota que el conductor dueño ya recibió este estado terminal. Solo lo anota la sesión que creó la
 * corrida, reconocida con la familia guardada: una consulta desde otra sesión no le quita el
 * recordatorio a la dueña. Se guarda la ronda y el lanzamiento para que uno nuevo vuelva a quedar
 * pendiente.
 */
export function markDelivered(dir: string, s: Status, env: Record<string, string | undefined>): void {
  try {
    if (!TERMINAL.has(s.state)) return
    const request = readJson<{ session?: string; conductor?: Conductor }>(join(dir, 'request.json'))
    if (!request.session || !request.conductor) return
    if (ownerSession(env, request.conductor.family) !== request.session) return
    writeJsonAtomic(join(dir, 'delivered.json'), deliveryOf(s))
  } catch {
    // Anotar la entrega nunca impide devolverla: en el peor caso, el recordatorio se repite.
  }
}

export function isDelivered(dir: string, s: Status): boolean {
  const file = join(dir, 'delivered.json')
  if (!existsSync(file)) return false
  try {
    const delivered = readJson<Delivery>(file)
    const current = deliveryOf(s)
    return delivered.round === current.round && delivered.launch === current.launch
  } catch {
    return false
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: el proceso existe pero pertenece a otro usuario.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
