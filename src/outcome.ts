import type { Family, RunState } from './types.ts'

export interface StreamFacts {
  /**
   * El modelo produjo algo. Los eventos de apertura del hilo no cuentan (Codex los emite antes de
   * autenticarse), ni los items de tipo `error`.
   */
  started: boolean
  sessionId?: string
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
  return { started: false, errors: [] }
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
    if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') facts.sessionId = e.session_id
    else if (e.type === 'assistant') facts.started = true
    else if (e.type === 'result') {
      if (typeof e.result === 'string') facts.result = e.result
      if (typeof e.is_error === 'boolean') facts.isError = e.is_error
      if (typeof e.session_id === 'string') facts.sessionId = e.session_id
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
    }
  } else if (e.type === 'error' && typeof e.message === 'string') facts.errors.push(e.message)
  else if (e.type === 'turn.failed' && typeof e.error?.message === 'string') facts.errors.push(e.error.message)
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
    const text = [...facts.errors, end.stderr].filter(Boolean).join('\n').trim()
    return { state: 'launch_failed', reason: launchReason(text), detail: text.slice(-500) }
  }
  if (facts.isError === true) return { state: 'failed', reason: 'is_error' }
  if (end.exitCode === 0 && end.resultText.trim() !== '') return { state: 'done' }
  if (end.exitCode === 0) return { state: 'failed', reason: 'empty_result' }
  return { state: 'failed', reason: `exit_${end.exitCode ?? 'signal'}` }
}
