import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { prepareIntent, revertPaths, writeRestoreIntent } from '../src/sdd/restore.ts'
import { readProcess, sensitiveInventory } from '../src/writer-store.ts'
import { type WSetup, deadPid, lockOf, prepared, readJsonFile, storeOf } from './cli-run-fixture.ts'
import type { ParallelFixture } from './parallel-worktrees-fixture.ts'

/** Grupo real independiente, como una fila que sobrevive al proceso verify. */
export function legacyGroup() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return { pid: child.pid!, async stop() {
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Ya terminó. */ }
    await ended
  } }
}

export function legacyVerify(s: WSetup, id: string, group: number): string {
  writeFileSync(join(s.repo, 'src/a.ts'), 'export const f = () => 2\n')
  const intent = prepareIntent(s.repo, id, s.base, ['src/a.ts'])
  intent.owner_pid = deadPid()
  intent.owner_lstart = null
  writeRestoreIntent(s.repo, intent)
  revertPaths(s.repo, intent)
  return legacyReservation(s.repo, id, 'verify', intent.owner_pid, group)
}

export const legacyLock = (root: string) => join(gitDirs(root).commonDir, 'sdd-ai', 'writer.lock')

/** Publica el protocolo anterior directamente: nunca llama al reservador nuevo. */
export function legacyReservation(root: string, id: string, kind?: 'verify' | 'branch' | 'commit', owner = process.pid, group?: number): string {
  const file = legacyLock(root)
  const seen = readProcess(owner)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ id, pid: owner, lstart: seen && seen !== 'gone' ? seen.lstart : null,
    gitDir: gitDirs(root).gitDir, ...(kind ? { kind } : {}), ...(group ? { group } : {}) }), { flag: 'wx' })
  return file
}

/** Control y terminal anteriores, sin migrar el inventario físico ni agregar campos nuevos. */
export function legacyRun(s: WSetup, id: string, terminal = true): string {
  const generated = prepared(s)
  unlinkSync(lockOf(s.repo))
  // La corrida generada pasa a ser la legacy, con su estado: en el almacén no queda otra corrida que la de este id.
  const dir = storeOf(s.repo, id)
  renameSync(storeOf(s.repo, generated), dir)
  const c = readJsonFile(join(dir, 'control.json'))
  delete c.reservation
  delete c.git_state
  c.id = id
  c.inventory = sensitiveInventory(s.repo)
  writeFileSync(join(dir, 'control.json'), JSON.stringify(c))
  writeFileSync(join(dir, 'diff.patch'), '')
  if (terminal) writeFileSync(join(dir, 'harvest.json'), JSON.stringify({ state: 'done', base: s.base, tree: '', files: [],
    patchFile: join(dir, 'diff.patch'), flagged: [], runAltered: [], headMoved: false, endMark: true, report: 'ok\nSTATUS: done' }))
  return dir
}

export function releaseMutex(file: string, owner = process.pid): void {
  const seen = readProcess(owner)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.release`, JSON.stringify({ pid: owner, lstart: seen && seen !== 'gone' ? seen.lstart : 'missing' }))
}

/** Un proceso real con el control anterior y un lock fabricado sin invocar el reservador legacy. */
export async function legacyWriter(f: ParallelFixture, s: WSetup, label: string, actions: object[] = []) {
  const writer = await f.writer(s, label, actions)
  const local = lockOf(s.repo)
  if (existsSync(local)) unlinkSync(local)
  const lock = legacyLock(s.repo)
  if (existsSync(lock)) unlinkSync(lock)
  legacyReservation(s.repo, writer.id)
  const file = join(storeOf(s.repo, writer.id), 'control.json')
  const control = readJsonFile(file)
  delete control.reservation
  delete control.git_state
  control.inventory = sensitiveInventory(s.repo)
  writeFileSync(file, JSON.stringify(control))
  return writer
}
