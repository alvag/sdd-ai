// Lo común de los tests de `run`, `wait` y `cancel` por el binario, que están partidos por tema en `cli-run-*.test.ts`.

import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRun, writeJsonAtomic } from '../src/runs.ts'
import { gitDirs } from '../src/git.ts'
import { codexWriterLaunch } from '../src/workers/codex.ts'
import { type WriterControl, readProcess, runDirIdentity, runInventory, sensitiveInventory, writeControl } from '../src/writer-store.ts'
import { makeFakeBin, makeRepo } from './helpers.ts'

export const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

export interface Setup { repo: string; env: Record<string, string>; prompt: string; bin: string }

export function setup(opts: { families?: string; bins?: Array<'claude' | 'codex'>; mode?: string; workers?: string } = {}): Setup {
  const repo = makeRepo()
  if (opts.families !== undefined) {
    mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
    writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: ${opts.families}\n  selection: full\n`)
  }
  if (opts.workers !== undefined) writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), opts.workers)
  // PATH controlado: node para el shebang y solo los CLIs falsos pedidos, nunca los reales.
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const b of opts.bins ?? []) makeFakeBin(bin, b)
  const prompt = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(prompt, 'Encargo de prueba.\n')
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? '',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 's-claude',
    CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')),
    FAKE_MODE: opts.mode ?? 'ok-codex',
  }
  return { repo, env, prompt, bin }
}

export function cli(s: Setup, args: string[], extraEnv: Record<string, string> = {}) {
  const started = Date.now()
  const r = spawnSync(BIN, args, { cwd: s.repo, env: { ...s.env, ...extraEnv }, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), ms: Date.now() - started, stderr: r.stderr }
}

export const pick = (w: { code: number | null; out: { state?: string; result?: string } }) => ({ code: w.code, state: w.out.state, result: w.out.result })

export const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

export const nativeOf = (repo: string, id: string) => JSON.parse(readFileSync(join(repo, '.sdd-ai', 'runs', id, 'native.json'), 'utf8'))

export const AS_CODEX = { CLAUDECODE: '', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's-codex' }

export const runsIn = (repo: string) => {
  const runs = join(repo, '.sdd-ai', 'runs')
  return existsSync(runs) ? readdirSync(runs) : []
}

export const requestOf = (repo: string, id: string) => JSON.parse(readFileSync(join(repo, '.sdd-ai', 'runs', id, 'request.json'), 'utf8'))

export const deliveredIn = (repo: string, id: string) => existsSync(join(repo, '.sdd-ai', 'runs', id, 'delivered.json'))

// --- El writer: run --role implement, wait y cancel ---

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export const storeOf = (repo: string, id: string) => join(gitDirs(repo).gitDir, 'sdd-ai', 'runs', id)

export const lockOf = (repo: string) => join(gitDirs(repo).gitDir, 'sdd-ai', 'checkout.lock')

export const readJsonFile = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

export interface WSetup extends Setup { base: string }

/** Un repo con un commit, `.sdd-ai/` ignorado como lo deja `run` y el writer falso con su guion. */
export function writerSetup(opts: { families?: string; bins?: Array<'claude' | 'codex'>; script?: object; empty?: boolean } = {}): WSetup {
  const s = setup({ families: opts.families ?? '[codex]', bins: opts.bins ?? ['codex'], mode: 'writer' })
  writeFileSync(join(s.repo, '.sdd-ai', '.gitignore'), '*\n')
  git(s.repo, 'config', 'user.name', 'Test')
  git(s.repo, 'config', 'user.email', 'test@example.com')
  s.env.FAKE_WRITER = JSON.stringify(opts.script ?? {})
  if (opts.empty) return { ...s, base: '' }
  writeFileSync(join(s.repo, 'a.txt'), 'uno\ndos\n')
  writeFileSync(join(s.repo, 'borrar.txt'), 'b\n')
  writeFileSync(join(s.repo, 'mover.txt'), Array.from({ length: 30 }, (_, i) => `línea ${i}\n`).join(''))
  writeFileSync(join(s.repo, 'script.sh'), '#!/bin/sh\n')
  git(s.repo, 'add', '-A')
  git(s.repo, 'commit', '-qm', 'base')
  return { ...s, base: git(s.repo, 'rev-parse', 'HEAD') }
}

/** Espera a que el writer esté corriendo: su grupo ya quedó registrado en el almacén. */
export async function whenRunning(repo: string, id: string): Promise<{ pid: number; pgid: number; lstart: string | null; argvHash: string }> {
  const until = Date.now() + 15_000
  for (;;) {
    const file = join(storeOf(repo, id), 'control.json')
    const group = existsSync(file) ? readJsonFile(file).group : undefined
    if (group) return group
    if (Date.now() > until) throw new Error(`el writer ${id} no arrancó`)
    await sleep(50)
  }
}

export const implement = (s: Setup, extra: string[] = [], env: Record<string, string> = {}) =>
  cli(s, ['run', '--role', 'implement', '--prompt-file', s.prompt, ...extra], env)

export const EDITS = [
  { append: 'a.txt', content: 'tres\n' }, { delete: 'borrar.txt' }, { rename: ['mover.txt', 'movido.txt'] },
  { write: 'nuevo.txt', content: 'nuevo\n' }, { binary: 'imagen.bin' }, { chmod: ['script.sh', '755'] }, { symlink: ['a.txt', 'enlace'] },
]

/** Un writer vivo con el supervisor muerto: el líder termina y queda un proceso de su grupo. */
export async function orphanedWriter(): Promise<{ s: WSetup; id: string; group: { pid: number; pgid: number; lstart: string | null; argvHash: string }; child: number }> {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'sdd-ai-pid-')), 'pid')
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }], child: true, hang: true } })
  const id = implement(s, [], { FAKE_PID_FILE: pidFile }).out.id
  const group = await whenRunning(s.repo, id)
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') await sleep(50)
  const child = Number(readFileSync(pidFile, 'utf8').split(',')[1])
  process.kill(Number(readFileSync(join(storeOf(s.repo, id), 'supervisor.pid'), 'utf8')), 'SIGKILL')
  process.kill(group.pid, 'SIGKILL')
  await sleep(200)
  return { s, id, group, child }
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Un PID que ya terminó. */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

/**
 * Una corrida de writer preparada a mano, sin supervisor: la reserva, la corrida visible, el control y
 * un estado con un supervisor que ya no existe.
 */
export function prepared(s: WSetup, opts: { spawning?: boolean; group?: object; session?: string } = {}): string {
  const id = `prep-${Math.random().toString(16).slice(2, 8)}`
  const checkout = { root: s.repo, ...gitDirs(s.repo) }
  const seen = readProcess(process.pid)
  const reservation = { version: 2 as const, domain: 'checkout' as const, path: lockOf(s.repo), token: randomUUID(), id, kind: 'writer' as const,
    pid: process.pid, lstart: seen && seen !== 'gone' ? seen.lstart : null, checkout }
  mkdirSync(join(reservation.path, '..'), { recursive: true })
  writeFileSync(reservation.path, JSON.stringify(reservation), { flag: 'wx' })
  const dir = createRun(s.repo, id)
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ role: 'implement', session: opts.session ?? 's-claude' }))
  writeFileSync(join(dir, 'prompt.md'), 'x')
  const task = { cwd: s.repo, promptFile: join(storeOf(s.repo, id), 'prompt.md'), resultFile: join(storeOf(s.repo, id), 'result.md'), sessionId: 'S' }
  writeControl(s.repo, {
    id, base: s.base, family: 'codex', prompt: 'x', session: opts.session ?? 's-claude', checkout, reservation,
    request: { role: 'implement', conductor: { family: 'claude' }, deadline_sec: 60 },
    preLaunch: runInventory(s.repo, id), inventory: sensitiveInventory(s.repo), runDir: runDirIdentity(s.repo, id) ?? { dev: 0, ino: 0 },
    ...(opts.spawning ? { spawning: new Date().toISOString() } : {}), ...(opts.group ? { group: opts.group } : {}),
  } as WriterControl)
  writeFileSync(join(storeOf(s.repo, id), 'prompt.md'), 'x')
  writeJsonAtomic(join(storeOf(s.repo, id), 'argv.json'), { family: 'codex', deadline_sec: 60, kind: 'writer', root: s.repo, id, launch: codexWriterLaunch(task) })
  writeJsonAtomic(join(storeOf(s.repo, id), 'status.json'), { state: 'running', supervisor_pid: deadPid() })
  return id
}

/** Corre `freezeHarvest` en un proceso aparte y devuelve el registro que obtuvo. */
export function freezeInProcess(repo: string, id: string, pauseMs = 0): Promise<string> {
  const script = `import { freezeHarvest } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'writer-store.ts'))};`
    + `import { setTimeout as sleep } from 'node:timers/promises';`
    + `const r = await freezeHarvest(process.argv[1], process.argv[2], { state: 'done' }, 'ok\\nSTATUS: done', { beforeRescue: () => sleep(${pauseMs}) });`
    + 'process.stdout.write(JSON.stringify(r))'
  return new Promise((res, rej) => {
    execFile(process.execPath, ['--input-type=module', '-e', script, repo, id], (err, out) => (err ? rej(err) : res(out)))
  })
}

export const claimsOf = (repo: string, id: string) => readdirSync(storeOf(repo, id)).filter((f) => /^harvest\.claim\.\d+$/.test(f)).sort()

/** Un flujo en `implement`, ignorado por Git como en un repo real: el árbol queda limpio. */
export function implementFlow(repo: string, tasks = '# Tasks\n\n- [x] **T1 — hecha**  · cubre: AC-1\n- [ ] **T2 — exportar**  · cubre: AC-1\n- [ ] **T3 — encabezado**  · cubre: AC-1\n'): string {
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n')
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'handoff.md'), '---\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: 2026-09-29T08:59:18-05:00\n---\n')
  writeFileSync(join(dir, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** exporta. (pedido)\n')
  writeFileSync(join(dir, 'plan.md'), '---\nid: f\nprofundidad: completa\nstatus: tasks-ready\n---\n\n# Plan\n\n## Enfoque\n\nUno.\n')
  writeFileSync(join(dir, 'tasks.md'), tasks)
  return dir
}

export const implementReport = (o: Record<string, unknown> = {}) => `Hice el cambio.\n\n${JSON.stringify({
  phase: 'implement', missing_context: [],
  tasks: [
    { id: 'T2', completion: 'done', change_kind: 'behavior_change', changed: 'exporta', deviation: null, check: 'V1' },
    { id: 'T3', completion: 'done', change_kind: 'refactor', changed: 'encabezado', deviation: null, check: 'V1' },
  ],
  ...o,
})}\n\nSTATUS: done\n`
