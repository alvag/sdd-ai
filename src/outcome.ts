import type { Family, RejectedField, RunState, Usage } from './types.ts'

export interface StreamFacts {
  /**
   * El modelo produjo algo. Los eventos de apertura del hilo no cuentan (Codex los emite antes de
   * autenticarse), ni los items de tipo `error`, ni los mensajes de error de la API de Claude.
   */
  started: boolean
  sessionId?: string
  /** Modelo que informa el CLI al abrir la sesión (Claude). */
  model?: string
  /** El proveedor rechazó el modelo o el esfuerzo pedido; `diagnostic` es su mensaje textual. */
  rejected?: { field: RejectedField; diagnostic: string }
  /** Tokens que informa el CLI: el `result` de Claude, o el último acumulado del hilo de Codex. */
  usage?: Usage
  /** Herramientas que usó el worker, en orden: `tool_use:<nombre>` en Claude, el tipo de item en Codex. */
  toolEvents: string[]
  result?: string
  isError?: boolean
  errors: string[]
}

export interface Ending {
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  resultText: string
  stderr: string
}

export interface Outcome { state: RunState; reason?: string; detail?: string }

export function emptyFacts(): StreamFacts {
  return { started: false, errors: [], toolEvents: [] }
}

export function scanLine(family: Family, facts: StreamFacts, line: string): void {
  let e: Record<string, any>
  try {
    e = JSON.parse(line)
  } catch {
    return
  }
  if (typeof e !== 'object' || e === null) return
  if (family === 'claude') {
    if (e.type === 'system' && e.subtype === 'init') {
      if (typeof e.session_id === 'string') facts.sessionId = e.session_id
      if (typeof e.model === 'string') facts.model = e.model
    } else if (e.type === 'assistant') {
      // Claude entrega los errores de la API como un mensaje del asistente: no es trabajo del modelo.
      if (e.is_api_error_message === true) {
        const text = assistantText(e)
        facts.errors.push(text)
        if (e.error === 'model_not_found') facts.rejected ??= { field: 'model', diagnostic: text }
      } else {
        facts.started = true
        for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (c?.type === 'tool_use' && typeof c.name === 'string') facts.toolEvents.push(`tool_use:${c.name}`)
        }
      }
    } else if (e.type === 'result') {
      if (typeof e.result === 'string') facts.result = e.result
      if (typeof e.is_error === 'boolean') facts.isError = e.is_error
      if (typeof e.session_id === 'string') facts.sessionId = e.session_id
      if (typeof e.usage === 'object' && e.usage !== null) facts.usage = claudeUsage(e.usage)
    }
    return
  }
  if (e.type === 'thread.started' && typeof e.thread_id === 'string') facts.sessionId = e.thread_id
  else if (e.type === 'item.started' || e.type === 'item.completed') {
    // Codex también reporta fallos de conexión como items de tipo `error`: no son trabajo del modelo.
    if (e.item?.type === 'error') {
      if (e.type === 'item.completed' && typeof e.item.message === 'string') facts.errors.push(e.item.message)
    } else {
      facts.started = true
      const kind = e.item?.type
      if (e.type === 'item.completed' && typeof kind === 'string' && !NON_TOOL_ITEMS.has(kind)) facts.toolEvents.push(kind)
      // El último mensaje del agente es su respuesta: un worker sin archivo de resultado la entrega así.
      if (e.type === 'item.completed' && kind === 'agent_message' && typeof e.item.text === 'string') facts.result = e.item.text
    }
  } else if (e.type === 'turn.completed' && typeof e.usage === 'object' && e.usage !== null) {
    facts.usage = codexUsage(e.usage)
  } else if (e.type === 'error' && typeof e.message === 'string') noteCodexError(facts, e.message)
  else if (e.type === 'turn.failed' && typeof e.error?.message === 'string') noteCodexError(facts, e.error.message)
}

const NON_TOOL_ITEMS = new Set(['agent_message', 'reasoning', 'error'])

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

function claudeUsage(u: Record<string, unknown>): Usage {
  const out: Usage = {}
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const v = num(u[k])
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Codex informa el acumulado del hilo: vale el último, con los nombres de caché traducidos. */
function codexUsage(u: Record<string, unknown>): Usage {
  const out: Usage = {}
  const pairs: Array<[keyof Usage, string]> = [
    ['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
    ['cache_read_input_tokens', 'cached_input_tokens'], ['cache_creation_input_tokens', 'cache_write_input_tokens'],
    ['reasoning_output_tokens', 'reasoning_output_tokens'],
  ]
  for (const [to, from] of pairs) {
    const v = num(u[from])
    if (v !== undefined) out[to] = v
  }
  return out
}

export function usageSince(total: Usage, before: Usage): Usage {
  const out: Usage = {}
  for (const key of Object.keys(total) as Array<keyof Usage>) {
    const value = total[key]
    if (value !== undefined) out[key] = Math.max(0, value - (before[key] ?? 0))
  }
  return out
}

function assistantText(e: Record<string, any>): string {
  const content: unknown[] = Array.isArray(e.message?.content) ? e.message.content : []
  return content
    .filter((c): c is { text: string } => typeof c === 'object' && c !== null && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => c.text)
    .join('\n')
}

function noteCodexError(facts: StreamFacts, message: string): void {
  facts.errors.push(message)
  facts.rejected ??= codexRejection(message)
}

/**
 * Codex anida el error del proveedor como JSON dentro de `message`. Solo se reconocen los rechazos
 * observados en salidas reales; cualquier otro queda como error sin clasificar.
 */
function codexRejection(message: string): StreamFacts['rejected'] {
  let err: { code?: unknown; param?: unknown; message?: unknown } | undefined
  try {
    const parsed: unknown = JSON.parse(message)
    const inner = (parsed as { error?: unknown } | null)?.error
    if (typeof inner === 'object' && inner !== null) err = inner
  } catch {
    return undefined
  }
  if (typeof err?.message !== 'string') return undefined
  if (err.code === 'unsupported_value' && err.param === 'reasoning.effort') return { field: 'effort', diagnostic: err.message }
  if (/\bmodel is not supported\b/.test(err.message)) return { field: 'model', diagnostic: err.message }
  return undefined
}

/** Solo patrones observados en salidas reales de los CLIs; lo demás es `unknown`. */
export function launchReason(text: string): 'auth' | 'invalid_invocation' | 'unknown' {
  if (/\b401\b|Unauthorized/i.test(text)) return 'auth'
  if (/unknown option|unexpected argument/i.test(text)) return 'invalid_invocation'
  return 'unknown'
}

export function classify(_family: Family, facts: StreamFacts, end: Ending): Outcome {
  if (end.cancelled) return { state: 'cancelled' }
  if (end.timedOut) return { state: 'timeout' }
  if (!facts.started) {
    if (facts.rejected) return { state: 'launch_failed', reason: `${facts.rejected.field}_rejected`, detail: facts.rejected.diagnostic }
    const text = [...facts.errors, end.stderr].filter(Boolean).join('\n').trim()
    return { state: 'launch_failed', reason: launchReason(text), detail: text.slice(-500) }
  }
  if (facts.isError === true) return { state: 'failed', reason: 'is_error' }
  if (end.exitCode === 0 && end.resultText.trim() !== '') return { state: 'done' }
  if (end.exitCode === 0) return { state: 'failed', reason: 'empty_result' }
  return { state: 'failed', reason: `exit_${end.exitCode ?? 'signal'}` }
}
