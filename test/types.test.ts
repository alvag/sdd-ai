import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SddError, opposite, toNativeEffort } from '../src/types.ts'

test('toNativeEffort traduce el vocabulario portable', () => {
  assert.equal(toNativeEffort('bajo'), 'low')
  assert.equal(toNativeEffort('medio'), 'medium')
  assert.equal(toNativeEffort('alto'), 'high')
  assert.equal(toNativeEffort('muy_alto'), 'xhigh')
  assert.equal(toNativeEffort('maximo'), 'max')
})

test('toNativeEffort deja pasar el vocabulario nativo', () => {
  for (const v of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(toNativeEffort(v), v)
})

test('toNativeEffort rechaza un valor desconocido con code usage', () => {
  assert.throws(() => toNativeEffort('turbo'), (e: unknown) => e instanceof SddError && e.code === 'usage')
})

test('opposite devuelve la otra familia', () => {
  assert.equal(opposite('claude'), 'codex')
  assert.equal(opposite('codex'), 'claude')
})

test('SddError expone code, message y next', () => {
  const e = new SddError('x', 'm', { next: 'n' })
  assert.equal(e.code, 'x')
  assert.equal(e.message, 'm')
  assert.equal(e.next, 'n')
  assert.equal(e.detail, undefined)
})
