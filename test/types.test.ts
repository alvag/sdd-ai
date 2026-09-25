import { test } from 'node:test'
import assert from 'node:assert/strict'
import { READ_ONLY_ROLES, RETIRED_ROLES, ROLES, SddError, opposite, toNativeEffort } from '../src/types.ts'

test('los roles de solo lectura son todos menos implement', () => {
  assert.equal(READ_ONLY_ROLES.length, 7)
  assert.equal((READ_ONLY_ROLES as readonly string[]).includes('implement'), false)
  assert.deepEqual([...READ_ONLY_ROLES, 'implement'].sort(), [...ROLES].sort())
})

test('pr es un rol retirado que ahora se llama code-review', () => {
  assert.equal(RETIRED_ROLES.get('pr'), 'code-review')
  assert.equal((ROLES as readonly string[]).includes('pr'), false)
})

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
