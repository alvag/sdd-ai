import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { answerGate, makeRepo } from './helpers.ts'
import { type Approval, type Depth } from '../src/sdd/status.ts'

export const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
export const SPEC = '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** resultado observable. (pedido)\n'
export const TASKS = '# Tasks\n\n- [ ] **T1 — implementar** · cubre: AC-1\n'
export const planText = (depth: Depth, status = 'planned') => `---\nid: f\nprofundidad: ${depth}\nstatus: ${status}\n---\n\n# Plan\n\n## Enfoque\n\nCambio acotado.\n${depth === 'corta' ? `\n## Spec\n\n- **AC-1:** resultado observable. (pedido)\n\n## Tasks\n\n- [ ] **T1 — implementar** · cubre: AC-1\n` : ''}`
export interface Fixture { root: string; dir: string; env: Record<string, string>; sessionDir: string; cleanup: () => void }

export function fixture(depth: Depth = 'normal', specOnly = false): Fixture {
  const root = makeRepo('sdd-approve-')
  const sessionDir = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-approve-session-')))
  const dir = join(root, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'handoff.md'), `---\nprofundidad: ${depth}\nspec_approved_at: null\n---\n\n# Handoff\n`)
  if (depth !== 'corta') writeFileSync(join(dir, 'spec.md'), SPEC)
  if (!specOnly) {
    writeFileSync(join(dir, 'plan.md'), planText(depth))
    if (depth !== 'corta') writeFileSync(join(dir, 'tasks.md'), TASKS)
  }
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: sessionDir, SDD_AI_PROJECTION: 'off', SDD_AI_TELEMETRY: 'off' }
  return { root, dir, env, sessionDir, cleanup: () => {
    rmSync(root, { recursive: true, force: true }); rmSync(sessionDir, { recursive: true, force: true })
  } }
}
export const answer = (f: Fixture, gate: string, label = 'Aprobar') => answerGate(f.root, f.env, 'f', gate, label)
/** La transcripción de la sesión del fixture, donde `answerGate` deja las respuestas: el proyecto `-repo` es el que nombra ese helper. */
export const transcriptPath = (f: Fixture) => join(f.sessionDir, 'projects', '-repo', `${f.env.CLAUDE_CODE_SESSION_ID}.jsonl`)
export function cli(f: Fixture, ...args: string[]): { code: number | null; out: any } {
  const r = spawnSync(process.execPath, [BIN, 'sdd', ...args], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10000 })
  assert.equal(r.error, undefined, r.error?.message ?? '')
  assert.ok(r.stdout, r.stderr)
  return { code: r.status, out: JSON.parse(r.stdout) }
}
export function logged(f: Fixture): Approval[] {
  const file = join(f.dir, 'sdd-ai-approvals.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).approvals : []
}
export function snapshot(f: Fixture) {
  return Object.fromEntries(['spec.md', 'plan.md', 'tasks.md', 'handoff.md', 'sdd-ai-approvals.json'].map((name) => {
    const file = join(f.dir, name)
    return [name, existsSync(file) ? { text: readFileSync(file, 'utf8'), mtime: lstatSync(file).mtimeMs } : null]
  }))
}
export function accept(f: Fixture, gate: string) {
  answer(f, gate)
  const r = cli(f, 'approve', 'f', gate)
  assert.equal(r.code, 0, JSON.stringify(r.out))
  return r.out
}
export function behind(f: Fixture) {
  const file = join(f.dir, 'handoff.md')
  if (existsSync(file)) writeFileSync(file, readFileSync(file, 'utf8').replace(/^spec_approved_at:.*$/m, 'spec_approved_at: null'))
  const plan = join(f.dir, 'plan.md')
  if (existsSync(plan)) writeFileSync(plan, readFileSync(plan, 'utf8').replace(/^status:.*$/m, 'status: planned'))
}

/** Proceso Node detenido hasta que el test libera su barrera; nunca lanza motores. */
export async function barrierProcess(directory: string): Promise<{ child: ChildProcess; release: () => Promise<void> }> {
  const ready = join(directory, `ready-${randomUUID()}`)
  const release = `${ready}.release`
  // `detached` lo hace líder de su grupo: los tests registran ese grupo como el de una corrida simulada.
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import fs from "node:fs"; fs.writeFileSync(process.argv[1], "ready"); const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); process.exit(0) } }, 10)', ready, release], { stdio: 'ignore', detached: true })
  const deadline = Date.now() + 5000
  try {
    while (!existsSync(ready)) {
      assert.equal(child.exitCode, null, 'el proceso de barrera terminó antes de estar listo')
      assert.ok(Date.now() < deadline, 'la barrera no llegó a ready')
      await sleep(10)
    }
  } catch (e) {
    // Sin esto, el hijo sigue sondeando para siempre y el archivo de tests no termina.
    child.kill('SIGKILL')
    rmSync(ready, { force: true })
    throw e
  }
  return { child, release: async () => {
    writeFileSync(release, '')
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()) })
    rmSync(ready, { force: true }); rmSync(release, { force: true })
  } }
}
