import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { JiraMode } from './config.ts'
import { type Crossed, type JiraBootstrap, ROUTE, type RouteThresholds, renderReminder } from './route.ts'
import { readJson, writeJsonAtomic } from './runs.ts'
import { shellPipelines } from './shell.ts'

/**
 * El recordatorio de sesión larga y el rastro de la ruta. Este módulo lo importa también el lanzador
 * de hooks en su propio proceso, así que depende solo de `node:fs`, `node:path` y módulos igual de
 * livianos.
 */

/** La misma regla que el hook: el `session_id` termina en una ruta. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/
/** Cuánto espera un hook el lock antes de callar, cada cuánto reintenta y cuándo un lock quedó huérfano. */
const LOCK_WAIT_MS = 200
const LOCK_RETRY_MS = 5
const LOCK_STALE_MS = 10_000

/** Una herramienta tal como llega a `PostToolUse`: el contador lee lo que necesita y deja pasar el resto. */
export interface ToolPayload { tool_name?: unknown; tool_input?: unknown; agent_id?: unknown; [campo: string]: unknown }

export interface StateIo { writeState: (file: string, value: unknown) => void }

/** El flujo SDD que conduce la sesión, y el paso y el gate que `Stop` ya recordó. */
export interface FlowBinding { id: string; step: string; gate: string | null; at: string }

interface RouteState {
  calls: number; reads: number; edits: number
  /** Corridas que el rastro ya vio: las que aparezcan después son nuevas. */
  seen: string[]
  /** Corridas a medio escribir cuando empezó el rastro: al completarse son existentes, no nuevas. */
  snapshot_pending: string[]
  bootstrap_at?: string
  flow?: FlowBinding
}

type RunKind = 'worker' | 'native' | 'review'
interface RunFact { session?: string; kind: RunKind; role?: string }

interface Files { dir: string; state: string; trail: string; lock: string }

const COUNTERS: Crossed[] = ['calls', 'reads', 'edits']
/**
 * Comandos de shell que leen sin cambiar nada: una tubería que empieza con uno de ellos es una lectura.
 * En `git diff | head`, `head` solo filtra la salida de otro comando.
 */
const READ_COMMANDS = ['cat', 'sed -n', 'rg', 'grep', 'ls', 'find', 'head', 'tail', 'nl', 'wc']
const CLAUDE_READS = new Set(['Read', 'Grep', 'Glob'])
const CLAUDE_EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])

const now = () => new Date().toISOString()

/** Sin `.sdd-ai/` el repositorio no usa sdd-ai, y con un id inválido no hay ruta segura: no se toca nada. */
function filesFor(root: string, session: string): Files | undefined {
  if (!SESSION_ID.test(session) || !existsSync(join(root, '.sdd-ai'))) return undefined
  const dir = join(root, '.sdd-ai', 'hooks', 'route')
  return { dir, state: join(dir, `${session}.json`), trail: join(dir, `${session}.jsonl`), lock: join(dir, `${session}.lock`) }
}

/**
 * Corre `fn` con el lock de la sesión, o devuelve `undefined` si no lo consigue a tiempo. Los hooks de
 * herramientas corren en paralelo: sin el lock, dos que cruzan el umbral a la vez recordarían dos veces.
 */
function withLock<T>(lock: string, fn: () => T): T | undefined {
  const deadline = Date.now() + LOCK_WAIT_MS
  let fd: number | undefined
  while (fd === undefined) {
    try {
      fd = openSync(lock, 'wx')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        // Un hook que murió con el lock tomado no lo libera nunca.
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock)
          continue
        }
      } catch {
        // El lock desapareció o no se puede leer: se reintenta, pero dentro del mismo plazo.
      }
      if (Date.now() >= deadline) return undefined
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    closeSync(fd)
    try {
      unlinkSync(lock)
    } catch {
      // Ya no estaba: otro hook lo dio por huérfano.
    }
  }
}

function runIds(root: string): string[] {
  const runs = join(root, '.sdd-ai', 'runs')
  return existsSync(runs) ? readdirSync(runs).sort() : []
}

/** Lo que el rastro registra de una corrida, o `undefined` mientras `run` o `review` la sigan escribiendo. */
function readRun(root: string, id: string): RunFact | undefined {
  try {
    const dir = join(root, '.sdd-ai', 'runs', id)
    const request = readJson<{ session?: unknown; kind?: unknown; role?: unknown }>(join(dir, 'request.json'))
    const resolved = readJson<{ via?: unknown }>(join(dir, 'resolved.json'))
    const kind: RunKind = request.kind === 'review' ? 'review' : resolved.via === 'native' ? 'native' : 'worker'
    const fact: RunFact = { kind }
    if (typeof request.session === 'string') fact.session = request.session
    if (typeof request.role === 'string') fact.role = request.role
    return fact
  } catch {
    return undefined
  }
}

const runLine = (event: 'existing' | 'run', id: string, fact: RunFact) =>
  ({ at: now(), event, run: id, kind: fact.kind, ...(fact.role ? { role: fact.role } : {}) })

function appendTrail(file: string, lines: object[]): void {
  if (lines.length > 0) appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
}

/**
 * El estado de la sesión, creado con su primer hecho: la instantánea de las corridas que ya existían
 * y la línea `start`. Las que estaban a medio escribir se registran como existentes al completarse.
 * Se llama con el lock tomado.
 */
function ensureState(root: string, session: string, files: Files, via: string, io: StateIo): RouteState {
  if (existsSync(files.state)) {
    const state = readJson<RouteState>(files.state)
    const lines: object[] = []
    const pending: string[] = []
    for (const id of state.snapshot_pending) {
      const fact = readRun(root, id)
      if (!fact) {
        pending.push(id)
        continue
      }
      state.seen.push(id)
      if (fact.session === session) lines.push(runLine('existing', id, fact))
    }
    if (pending.length !== state.snapshot_pending.length) {
      state.snapshot_pending = pending
      io.writeState(files.state, state)
      appendTrail(files.trail, lines)
    }
    return state
  }
  const state: RouteState = { calls: 0, reads: 0, edits: 0, seen: [], snapshot_pending: [] }
  const lines: object[] = [{ at: now(), event: 'start', via }]
  for (const id of runIds(root)) {
    const fact = readRun(root, id)
    if (!fact) {
      state.snapshot_pending.push(id)
      continue
    }
    state.seen.push(id)
    if (fact.session === session) lines.push(runLine('existing', id, fact))
  }
  io.writeState(files.state, state)
  appendTrail(files.trail, lines)
  return state
}

/** Empieza el rastro de la sesión si todavía no existe. `via` dice qué evento lo empezó. */
export function startTrail(root: string, session: string, via: string): void {
  try {
    const files = filesFor(root, session)
    if (!files) return
    mkdirSync(files.dir, { recursive: true })
    withLock(files.lock, () => ensureState(root, session, files, via, { writeState: writeJsonAtomic }))
  } catch {
    // El rastro nunca frena a un hook.
  }
}

/** Marca que la sesión recibió el bootstrap y dice si ya lo tenía marcado. Ante un error, `false`. */
export function markBootstrap(root: string, session: string): boolean {
  try {
    const files = filesFor(root, session)
    if (!files) return false
    mkdirSync(files.dir, { recursive: true })
    return withLock(files.lock, () => {
      const state = ensureState(root, session, files, 'bootstrap', { writeState: writeJsonAtomic })
      if (state.bootstrap_at) return true
      writeJsonAtomic(files.state, { ...state, bootstrap_at: now() })
      return false
    }) ?? false
  } catch {
    return false
  }
}

function isShellRead(command: string): boolean {
  return shellPipelines(command).some(([first]) => {
    const s = first.trim()
    return READ_COMMANDS.some((c) => s === c || s.startsWith(`${c} `))
  })
}

const isBinding = (v: unknown): v is FlowBinding => {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return typeof b.id === 'string' && typeof b.step === 'string' && (b.gate === null || typeof b.gate === 'string') && typeof b.at === 'string'
}

/**
 * La liga de la sesión. Lee sin lock, porque el estado se publica con un rename. `null` sin estado o
 * sin liga, y `'unreadable'` si el estado existe y no se puede leer.
 */
export function readBinding(root: string, session: string): FlowBinding | null | 'unreadable' {
  const files = filesFor(root, session)
  if (!files) return null
  let state: unknown
  try {
    state = readJson<unknown>(files.state)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  }
  if (typeof state !== 'object' || state === null) return 'unreadable'
  const flow = (state as RouteState).flow
  if (flow === undefined) return null
  return isBinding(flow) ? flow : 'unreadable'
}

/** Guarda la liga de la sesión, o la borra con `null`, sin tocar los contadores. Devuelve si la guardó. */
export function setBinding(root: string, session: string, b: FlowBinding | null): boolean {
  try {
    const files = filesFor(root, session)
    if (!files) return false
    mkdirSync(files.dir, { recursive: true })
    return withLock(files.lock, () => {
      const state = ensureState(root, session, files, 'binding', { writeState: writeJsonAtomic })
      if (b === null) delete state.flow
      else state.flow = b
      writeJsonAtomic(files.state, state)
      return true
    }) ?? false
  } catch {
    return false
  }
}

function classify(p: ToolPayload, cli: 'claude' | 'codex'): 'read' | 'edit' | undefined {
  const name = p.tool_name
  if (name === 'Bash') {
    const command = typeof p.tool_input === 'object' && p.tool_input !== null ? (p.tool_input as { command?: unknown }).command : undefined
    return typeof command === 'string' && isShellRead(command) ? 'read' : undefined
  }
  if (typeof name !== 'string') return undefined
  if (cli === 'claude') return CLAUDE_READS.has(name) ? 'read' : CLAUDE_EDITS.has(name) ? 'edit' : undefined
  return name === 'apply_patch' ? 'edit' : undefined
}

/**
 * El modo de Jira, pedido solo si el recordatorio habla de ediciones: leer la config carga `yaml`, y
 * este contador corre con cada herramienta. Si no se puede leer, rige lo mismo que con `on`.
 */
function jiraFor(crossed: Crossed[], jira?: () => JiraMode): [JiraBootstrap, string?] {
  if (!jira || !crossed.includes('edits')) return ['off']
  try {
    const m = jira()
    return m.mode === 'invalid' ? ['invalid', m.detail] : [m.mode]
  } catch {
    return ['invalid', 'no se pudo cargar la config']
  }
}

/**
 * Cuenta una herramienta del conductor y devuelve el recordatorio si cruzó algún umbral, o `''`. Una
 * corrida nueva de la sesión reinicia los contadores, y la llamada que la creó no cuenta. Las
 * herramientas de un subagente no cuentan. Sin lock, o ante cualquier error, calla.
 */
export function countTool(
  p: ToolPayload, root: string, session: string, cli: 'claude' | 'codex', t: RouteThresholds = ROUTE,
  io: StateIo = { writeState: writeJsonAtomic }, jira?: () => JiraMode,
): string {
  try {
    const files = filesFor(root, session)
    if (!files) return ''
    if (typeof p.agent_id === 'string' && p.agent_id !== '') return ''
    mkdirSync(files.dir, { recursive: true })
    return withLock(files.lock, () => {
      const state = ensureState(root, session, files, 'PostToolUse', io)
      const seen = new Set([...state.seen, ...state.snapshot_pending])
      const lines: object[] = []
      let reset = false
      for (const id of runIds(root)) {
        if (seen.has(id)) continue
        const fact = readRun(root, id)
        if (!fact) continue
        state.seen.push(id)
        if (fact.session !== session) continue
        lines.push(runLine('run', id, fact))
        reset = true
      }
      if (reset) {
        for (const c of COUNTERS) state[c] = 0
      } else {
        state.calls++
        const kind = classify(p, cli)
        if (kind === 'read') state.reads++
        if (kind === 'edit') state.edits++
      }
      const crossed = COUNTERS.filter((c) => state[c] >= t.backstop[c])
      if (crossed.length === 0) {
        io.writeState(files.state, state)
        appendTrail(files.trail, lines)
        return ''
      }
      const counts = { calls: state.calls, reads: state.reads, edits: state.edits }
      for (const c of COUNTERS) state[c] = 0
      // El estado va primero: si no se guarda, el rastro no afirma un recordatorio que no salió.
      io.writeState(files.state, state)
      if (state.flow) {
        // La sesión conduce un flujo SDD: el recordatorio de la ruta directa no le aplica.
        appendTrail(files.trail, [...lines, { at: now(), event: 'reminder_suppressed', crossed, counts, flow: state.flow.id }])
        return ''
      }
      appendTrail(files.trail, [...lines, { at: now(), event: 'reminder', crossed, counts }])
      return renderReminder(crossed, counts, t, undefined, ...jiraFor(crossed, jira))
    }) ?? ''
  } catch {
    return ''
  }
}
