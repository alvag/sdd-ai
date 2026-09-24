import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { type Outcome, type StreamFacts, classify, emptyFacts, scanLine } from './outcome.ts'
import { readJson, setStatus, writeJsonAtomic } from './runs.ts'
import type { Family, LaunchSpec, RejectedField, RetryInfo, Status } from './types.ts'
import { claudeRetry } from './workers/claude.ts'
import { codexRetry } from './workers/codex.ts'

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

interface RunContext { dir: string; family: Family; grace: number; until: number; cancelFile: string }
interface Attempt { outcome: Outcome; facts: StreamFacts }

/**
 * Un lanzamiento del worker. Cada intento escribe sus propios logs (`suffix`) para que la salida de
 * uno no se mezcle con la clasificación del otro; el tope es el de toda la corrida.
 */
async function attempt(ctx: RunContext, launch: LaunchSpec, suffix: string): Promise<Attempt> {
  const { dir, family, grace, cancelFile } = ctx
  const facts = emptyFacts()
  const stdinFd = openSync(launch.stdinFile, 'r')
  const stdoutFd = openSync(join(dir, `stdout${suffix}.log`), 'a')
  const stderrFile = join(dir, `stderr${suffix}.log`)
  const stderrFd = openSync(stderrFile, 'a')

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
    const running: Partial<Status> = { state: 'running', worker_pid: pid, supervisor_pid: process.pid }
    if (suffix === '') running.started_at = new Date().toISOString()
    setStatus(dir, running)
    createInterface({ input: child.stdout! }).on('line', (line) => {
      writeSync(stdoutFd, `${line}\n`)
      scanLine(family, facts, line)
    })
    deadline = setTimeout(() => {
      timedOut = true
      killGroup(pid, 'SIGTERM')
      graceTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), grace)
    }, Math.max(0, ctx.until - Date.now()))
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

  if (spawnError) {
    const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
    return { facts, outcome: { state: 'launch_failed', reason: missing ? 'cli_missing' : 'unknown', detail: spawnError.message } }
  }
  const resultFile = join(dir, 'result.md')
  let resultText = ''
  if (family === 'claude') {
    resultText = facts.result ?? ''
    writeFileSync(resultFile, resultText)
  } else if (existsSync(resultFile)) {
    resultText = readFileSync(resultFile, 'utf8')
  }
  const outcome = classify(family, facts, {
    exitCode: code,
    timedOut,
    cancelled: existsSync(cancelFile),
    resultText,
    stderr: readFileSync(stderrFile, 'utf8'),
  })
  return { facts, outcome }
}

function retryArgs(family: Family, args: string[], field: RejectedField): { args: string[]; requested: string } | null {
  return family === 'claude' ? claudeRetry(args, field, randomUUID()) : codexRetry(args, field)
}

/** Lo que usó el reintento en lugar del valor rechazado: el modelo si el CLI lo informa, si no el default. */
function effectiveValue(family: Family, field: RejectedField, facts: StreamFacts): string {
  return family === 'claude' && field === 'model' && facts.model ? facts.model : 'default del CLI'
}

/**
 * Lanza al worker de una corrida preparada, aplica el tope y escribe el estado final. Si el CLI
 * rechaza el modelo o el esfuerzo pedido, relanza una sola vez sin ese campo y lo deja registrado.
 */
export async function supervise(dir: string): Promise<Status> {
  const argv = readJson<ArgvFile>(join(dir, 'argv.json'))
  const cancelFile = join(dir, 'cancel.request')
  // Un cancel que llegó antes de que hubiera worker: no se lanza nada.
  if (existsSync(cancelFile)) return setStatus(dir, { state: 'cancelled', ended_at: new Date().toISOString() })
  const ctx: RunContext = {
    dir, family: argv.family, grace: argv.grace_ms ?? 10_000, until: Date.now() + argv.deadline_sec * 1000, cancelFile,
  }

  let { outcome, facts } = await attempt(ctx, argv.launch, '')
  let retry: RetryInfo | undefined
  const rejected = outcome.state === 'launch_failed' ? facts.rejected : undefined
  const next = rejected ? retryArgs(argv.family, argv.launch.args, rejected.field) : null
  if (rejected && next) {
    if (existsSync(cancelFile)) {
      outcome = { state: 'cancelled' }
    } else {
      const launch: LaunchSpec = { ...argv.launch, args: next.args }
      writeJsonAtomic(join(dir, 'argv-2.json'), { ...argv, launch })
      const second = await attempt(ctx, launch, '-2')
      outcome = second.outcome
      facts = second.facts
      retry = {
        field: rejected.field, requested: next.requested,
        effective: effectiveValue(argv.family, rejected.field, facts), diagnostic: rejected.diagnostic,
      }
    }
  }

  const patch: Partial<Status> = { ...outcome, ended_at: new Date().toISOString() }
  if (facts.sessionId) patch.session_id = facts.sessionId
  if (retry) patch.retry = retry
  return setStatus(dir, patch)
}
