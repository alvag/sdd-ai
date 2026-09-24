import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { type Outcome, classify, emptyFacts, scanLine } from './outcome.ts'
import { readJson, setStatus } from './runs.ts'
import type { Family, LaunchSpec, Status } from './types.ts'

export interface ArgvFile { family: Family; launch: LaunchSpec; deadline_sec: number; grace_ms?: number }

const SESSION_VARS = new Set([
  'CLAUDECODE', 'CLAUDE_EFFORT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI',
])

/**
 * Entorno del worker: el del supervisor sin las señales de sesión del conductor, para que el worker
 * no se crea anidado ni herede su identidad, y con la marca que impide que lance otro sdd-ai.
 */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (SESSION_VARS.has(k) || k.startsWith('CLAUDE_CODE_') || k.startsWith('CODEX_SANDBOX')) continue
    out[k] = v
  }
  out.SDD_AI_WORKER = '1'
  return out
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // El grupo ya no existe.
  }
}

/** Lanza al worker de una corrida preparada, aplica el tope y escribe el estado final. */
export async function supervise(dir: string): Promise<Status> {
  const argv = readJson<ArgvFile>(join(dir, 'argv.json'))
  const { family, launch } = argv
  const grace = argv.grace_ms ?? 10_000
  const cancelFile = join(dir, 'cancel.request')
  // Un cancel que llegó antes de que hubiera worker: no se lanza nada.
  if (existsSync(cancelFile)) return setStatus(dir, { state: 'cancelled', ended_at: new Date().toISOString() })
  const facts = emptyFacts()
  const stdinFd = openSync(launch.stdinFile, 'r')
  const stdoutFd = openSync(join(dir, 'stdout.log'), 'a')
  const stderrFd = openSync(join(dir, 'stderr.log'), 'a')

  const child = spawn(launch.cmd, launch.args, {
    cwd: launch.cwd,
    detached: true,
    env: cleanEnv(process.env),
    stdio: [stdinFd, 'pipe', stderrFd],
  })

  let timedOut = false
  let deadline: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let cancelWatch: NodeJS.Timeout | undefined

  const ended = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once('error', (err) => resolve({ code: null, spawnError: err }))
    child.once('close', (code) => resolve({ code }))
  })

  if (child.pid !== undefined) {
    const pid = child.pid
    setStatus(dir, { state: 'running', worker_pid: pid, supervisor_pid: process.pid, started_at: new Date().toISOString() })
    createInterface({ input: child.stdout! }).on('line', (line) => {
      writeSync(stdoutFd, `${line}\n`)
      scanLine(family, facts, line)
    })
    deadline = setTimeout(() => {
      timedOut = true
      killGroup(pid, 'SIGTERM')
      graceTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), grace)
    }, argv.deadline_sec * 1000)
    // `cancel` puede llegar antes de que exista el PID; el pedido en disco es la señal.
    cancelWatch = setInterval(() => {
      if (existsSync(cancelFile)) {
        clearInterval(cancelWatch)
        killGroup(pid, 'SIGTERM')
        graceTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), grace)
      }
    }, 250)
  }

  const { code, spawnError } = await ended
  clearTimeout(deadline)
  clearTimeout(graceTimer)
  clearInterval(cancelWatch)
  // Un nieto que sobrevivió al worker no debe quedar vivo.
  if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
  for (const fd of [stdinFd, stdoutFd, stderrFd]) closeSync(fd)

  let outcome: Outcome
  if (spawnError) {
    const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
    outcome = { state: 'launch_failed', reason: missing ? 'cli_missing' : 'unknown', detail: spawnError.message }
  } else {
    const resultFile = join(dir, 'result.md')
    let resultText = ''
    if (family === 'claude') {
      resultText = facts.result ?? ''
      writeFileSync(resultFile, resultText)
    } else if (existsSync(resultFile)) {
      resultText = readFileSync(resultFile, 'utf8')
    }
    outcome = classify(family, facts, {
      exitCode: code,
      timedOut,
      cancelled: existsSync(cancelFile),
      resultText,
      stderr: readFileSync(join(dir, 'stderr.log'), 'utf8'),
    })
  }

  const patch: Partial<Status> = { ...outcome, ended_at: new Date().toISOString() }
  if (facts.sessionId) patch.session_id = facts.sessionId
  return setStatus(dir, patch)
}
