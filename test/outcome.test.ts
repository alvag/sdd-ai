import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Ending, type StreamFacts, classify, emptyFacts, scanLine } from '../src/outcome.ts'
import type { Family } from '../src/types.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

function scan(family: Family, text: string): StreamFacts {
  const facts = emptyFacts()
  for (const line of text.split('\n')) scanLine(family, facts, line)
  return facts
}

const end = (over: Partial<Ending>): Ending => ({
  exitCode: 0, timedOut: false, cancelled: false, resultText: '', stderr: '', ...over,
})

test('claude -p real: arrancó, trae sesión y resultado', () => {
  const f = scan('claude', fixture('claude-stream.jsonl'))
  assert.equal(f.started, true)
  assert.equal(f.sessionId, '473db793-e2bb-4560-88d1-4c62af94b3eb')
  assert.equal(f.result, 'ok')
  assert.equal(f.isError, false)
  assert.equal(classify('claude', f, end({ resultText: 'ok' })).state, 'done')
})

test('codex exec real: arrancó y trae el id del hilo', () => {
  const f = scan('codex', fixture('codex-stream.jsonl'))
  assert.equal(f.started, true)
  assert.equal(f.sessionId, '01a0d50b-9af4-7e53-b865-7e4250ac277a')
  assert.equal(classify('codex', f, end({ resultText: fixture('codex-last.txt') })).state, 'done')
})

test('codex sin auth no arrancó aunque emitió thread.started', () => {
  const text = fixture('codex-sin-auth.jsonl')
  assert.match(text, /"thread\.started"/)
  const f = scan('codex', text)
  assert.equal(f.started, false)
  const c = classify('codex', f, end({ exitCode: 1, stderr: fixture('codex-sin-auth.err') }))
  assert.equal(c.state, 'launch_failed')
  assert.equal(c.reason, 'auth')
  assert.match(c.detail ?? '', /401/)
})

test('un flag desconocido es invalid_invocation en las dos familias', () => {
  const claude = classify('claude', emptyFacts(), end({ exitCode: 1, stderr: fixture('claude-flag-invalido.err') }))
  assert.deepEqual([claude.state, claude.reason], ['launch_failed', 'invalid_invocation'])
  const codex = classify('codex', emptyFacts(), end({ exitCode: 2, stderr: fixture('codex-flag-invalido.err') }))
  assert.deepEqual([codex.state, codex.reason], ['launch_failed', 'invalid_invocation'])
})

test('un fallo sin patrón conocido es unknown con detalle', () => {
  const c = classify('claude', emptyFacts(), end({ exitCode: 1, stderr: 'algo raro' }))
  assert.deepEqual([c.state, c.reason, c.detail], ['launch_failed', 'unknown', 'algo raro'])
})

test('arrancó y salió limpio sin resultado: empty_result', () => {
  const f = scan('claude', '{"type":"assistant","message":{}}')
  assert.deepEqual(classify('claude', f, end({ resultText: '  ' })), { state: 'failed', reason: 'empty_result' })
})

test('arrancó y el resultado vino marcado como error: is_error', () => {
  const f = scan('claude', '{"type":"assistant","message":{}}\n{"type":"result","is_error":true,"result":"x"}')
  assert.deepEqual(classify('claude', f, end({ resultText: 'x' })), { state: 'failed', reason: 'is_error' })
})

test('arrancó y salió con código distinto de 0', () => {
  const f = scan('codex', '{"type":"item.started","item":{}}')
  assert.deepEqual(classify('codex', f, end({ exitCode: 3, resultText: 'x' })), { state: 'failed', reason: 'exit_3' })
})

test('el tope y la cancelación mandan sobre todo lo demás', () => {
  const f = scan('claude', fixture('claude-stream.jsonl'))
  assert.equal(classify('claude', f, end({ timedOut: true, resultText: 'ok' })).state, 'timeout')
  assert.equal(classify('claude', f, end({ cancelled: true, timedOut: true })).state, 'cancelled')
})

test('las líneas que no son JSON se ignoran', () => {
  const f = scan('codex', 'no json\n{"type":"thread.started","thread_id":"t"}')
  assert.equal(f.sessionId, 't')
  assert.equal(f.started, false)
})

test('claude con un modelo rechazado: no arrancó y es model_rejected', () => {
  const facts = scan('claude', fixture('claude-modelo-rechazado.jsonl'))
  assert.equal(facts.started, false)
  const o = classify('claude', facts, end({ exitCode: 1, stderr: fixture('claude-modelo-rechazado.err') }))
  assert.deepEqual([o.state, o.reason], ['launch_failed', 'model_rejected'])
  assert.match(o.detail ?? '', /issue with the selected model \(no-existe-xyz\)/)
})

test('codex con un modelo rechazado: model_rejected con el diagnóstico textual', () => {
  const facts = scan('codex', fixture('codex-modelo-rechazado.jsonl'))
  assert.equal(facts.started, false)
  const o = classify('codex', facts, end({ exitCode: 1 }))
  assert.deepEqual([o.state, o.reason], ['launch_failed', 'model_rejected'])
  assert.equal(o.detail, "The 'no-existe-xyz' model is not supported when using Codex with a ChatGPT account.")
})

test('codex con un esfuerzo rechazado: effort_rejected con los valores admitidos', () => {
  const facts = scan('codex', fixture('codex-esfuerzo-rechazado.jsonl'))
  assert.equal(facts.started, false)
  const o = classify('codex', facts, end({ exitCode: 1 }))
  assert.deepEqual([o.state, o.reason], ['launch_failed', 'effort_rejected'])
  assert.match(o.detail ?? '', /'max' is not supported with the 'gpt-5\.5' model\. Supported values are/)
})

test('un error de la API de Claude no cuenta como arranque', () => {
  const line = JSON.stringify({ type: 'assistant', is_api_error_message: true, error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key' }] } })
  const facts = scan('claude', line)
  assert.equal(facts.started, false)
  assert.equal(facts.rejected, undefined)
  assert.deepEqual(facts.errors, ['Invalid API key'])
})

test('el init de Claude trae el modelo', () => {
  assert.equal(scan('claude', fixture('claude-stream.jsonl')).model, 'claude-haiku-4-5-20251001')
})

test('Claude: el result trae el uso de tokens', () => {
  assert.deepEqual(scan('claude', fixture('claude-stream.jsonl')).usage, {
    input_tokens: 9, output_tokens: 46, cache_read_input_tokens: 4563, cache_creation_input_tokens: 1820,
  })
})

test('Codex: el uso de tokens es la suma de los turnos', () => {
  const turn = fixture('codex-stream.jsonl').split('\n').find((l) => l.includes('"turn.completed"')) ?? ''
  assert.deepEqual(scan('codex', `${turn}\n${turn}`).usage, {
    input_tokens: 82242, output_tokens: 218, cache_read_input_tokens: 63232, cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
  })
})

test('las herramientas que usó el worker quedan registradas', () => {
  const toolUse = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } })
  assert.deepEqual(scan('claude', toolUse).toolEvents, ['tool_use:Read'])
  const items = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'hola' } },
    { type: 'item.completed', item: { type: 'reasoning', text: '…' } },
    { type: 'item.started', item: { type: 'web_search' } },
    { type: 'item.completed', item: { type: 'web_search', query: 'x' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } },
  ].map((e) => JSON.stringify(e)).join('\n')
  assert.deepEqual(scan('codex', items).toolEvents, ['web_search', 'command_execution'])
})

test('un revisor aislado de Claude no usa herramientas', () => {
  const facts = scan('claude', fixture('claude-aislado.jsonl'))
  assert.deepEqual(facts.toolEvents, [])
  assert.equal(facts.usage?.input_tokens, 555)
})
