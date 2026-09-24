import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SddError, type Status } from './types.ts'

/**
 * `<raíz>/.sdd-ai/runs`. Vive en el árbol de trabajo y no en `.git/` porque el sandbox de Codex deja
 * `.git` en solo lectura. El `.gitignore` con `*` hace que `.sdd-ai/` se ignore solo, sin tocar el
 * `.gitignore` del repo.
 */
export function runsRoot(root: string): string {
  const home = join(root, '.sdd-ai')
  const runs = join(home, 'runs')
  mkdirSync(runs, { recursive: true })
  const ignore = join(home, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return runs
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

export function runDir(root: string, id: string): string {
  const dir = join(root, '.sdd-ai', 'runs', id)
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

export function setStatus(dir: string, patch: Partial<Status>): Status {
  const file = join(dir, 'status.json')
  const current = existsSync(file) ? readJson<Status>(file) : ({} as Status)
  const next = { ...current, ...patch }
  writeJsonAtomic(file, next)
  return next
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
