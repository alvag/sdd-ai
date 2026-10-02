import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectConductor } from '../src/conductor.ts'
import { SddError } from '../src/types.ts'

const isCode = (code: string) => (e: unknown) => e instanceof SddError && e.code === code

test('Claude Code por CLAUDECODE, con su esfuerzo', () => {
  assert.deepEqual(detectConductor({ CLAUDECODE: '1', CLAUDE_EFFORT: 'xhigh' }, {}), { family: 'claude', effort: 'xhigh' })
})

test('Codex por CODEX_THREAD_ID, sin esfuerzo', () => {
  assert.deepEqual(detectConductor({ CODEX_THREAD_ID: 't1' }, {}), { family: 'codex' })
})

test('las dos señales a la vez son ambiguas', () => {
  assert.throws(() => detectConductor({ CLAUDECODE: '1', CODEX_THREAD_ID: 't1' }, {}), isCode('conductor_unknown'))
})

test('sin señales pide --conductor', () => {
  assert.throws(
    () => detectConductor({}, {}),
    (e: unknown) => e instanceof SddError && e.code === 'conductor_unknown' && (e.next ?? '').includes('--conductor'),
  )
})

test('el flag gana sobre el entorno y lleva el modelo', () => {
  assert.deepEqual(
    detectConductor({ CODEX_THREAD_ID: 't1' }, { conductor: 'claude', conductorModel: 'opus' }),
    { family: 'claude', model: 'opus' },
  )
})

test('un CLAUDE_EFFORT inválido se ignora', () => {
  assert.deepEqual(detectConductor({ CLAUDECODE: '1', CLAUDE_EFFORT: 'turbo' }, {}), { family: 'claude' })
})

test('el esfuerzo declarado por flag vale para las dos familias y gana sobre el entorno', () => {
  assert.deepEqual(detectConductor({ CODEX_THREAD_ID: 't1' }, { conductorEffort: 'alto' }), { family: 'codex', effort: 'high' })
  assert.deepEqual(detectConductor({ CLAUDECODE: '1', CLAUDE_EFFORT: 'low' }, { conductorEffort: 'max' }), { family: 'claude', effort: 'max' })
})

test('una familia desconocida en el flag es un error de uso', () => {
  assert.throws(() => detectConductor({}, { conductor: 'gemini' }), isCode('usage'))
})
