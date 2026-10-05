import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAIM_NAME, OBSERVATION_NAME, TEMPORARY_NAME } from '../src/projection-types.ts'
import { claimExamples, foreignExamples, observationExamples, temporaryExamples } from '../mods/sdd-ai/tests/fixtures/projection-names.ts'

// El mod no importa el contrato: copia la expresión de las observaciones. Esta prueba comprueba que la copia es la
// misma y que el contrato clasifica igual los ejemplos que interpreta la prueba del mod.
test('mod projection reader copies the observation name contract and its shared examples', () => {
  const source = readFileSync(join(import.meta.dirname, '../mods/sdd-ai/hooks/projection.ts'), 'utf8')
  assert.ok(source.includes(`export const OBSERVATION_NAME = ${String(OBSERVATION_NAME)}\n`), 'la copia del mod no es la expresión del contrato')
  for (const example of observationExamples) {
    const match = OBSERVATION_NAME.exec(example.name)
    assert.ok(match, example.name)
    assert.deepEqual([match[1], match[2], Number(match[3])], [example.m0, example.boot, example.pid])
    assert.equal(TEMPORARY_NAME.test(example.name), false, example.name)
    assert.equal(CLAIM_NAME.test(example.name), false, example.name)
  }
  for (const name of temporaryExamples) {
    assert.equal(TEMPORARY_NAME.test(name), true, name)
    assert.equal(OBSERVATION_NAME.test(name), false, name)
    assert.equal(CLAIM_NAME.test(name), false, name)
  }
  for (const name of claimExamples) {
    assert.equal(CLAIM_NAME.test(name), true, name)
    assert.equal(OBSERVATION_NAME.test(name), false, name)
    assert.equal(TEMPORARY_NAME.test(name), false, name)
  }
  for (const name of foreignExamples) {
    assert.equal(OBSERVATION_NAME.test(name), false, JSON.stringify(name))
    assert.equal(TEMPORARY_NAME.test(name), false, JSON.stringify(name))
    assert.equal(CLAIM_NAME.test(name), false, JSON.stringify(name))
  }
})
