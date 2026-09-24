import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveFamilies, loadCrossModel, parseCrossModel, parseFamiliesFlag } from '../src/config.ts'
import { SddError } from '../src/types.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'config-ai-workflows.yml')
const isCode = (code: string, text?: string) => (e: unknown) =>
  e instanceof SddError && e.code === code && (text === undefined || `${e.message} ${e.detail ?? ''} ${e.next ?? ''}`.includes(text))
const tmp = () => mkdtempSync(join(tmpdir(), 'sdd-ai-config-'))
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('lee families canonizadas a minúsculas y conserva selection', () => {
  const cm = parseCrossModel({ cross_model: { schema_version: 1, families: ['codex', 'Claude'], selection: 'full' } })
  assert.deepEqual(cm, { families: ['codex', 'claude'], selection: 'full' })
})

test('families con forma inválida es config_invalid y nombra el valor', () => {
  const block = (families: unknown) => ({ cross_model: { schema_version: 1, families, selection: 'full' } })
  assert.throws(() => parseCrossModel(block('claude')), isCode('config_invalid', 'claude'))
  assert.throws(() => parseCrossModel(block([])), isCode('config_invalid'))
  assert.throws(() => parseCrossModel(block(['claude', 'claude'])), isCode('config_invalid', 'claude'))
  assert.throws(() => parseCrossModel(block(['gemini'])), isCode('config_invalid', 'gemini'))
})

test('un schema_version desconocido ignora el bloque entero', () => {
  assert.throws(
    () => parseCrossModel({ cross_model: { schema_version: 2, families: ['claude'], selection: 'full' } }),
    isCode('config_missing', 'schema_version'),
  )
})

test('sin cross_model propone el bloque en .sdd-ai/config.yml', () => {
  assert.throws(() => parseCrossModel({ otro: 1 }), (e: unknown) => {
    if (!(e instanceof SddError) || e.code !== 'config_missing') return false
    const next = e.next ?? ''
    return ['.sdd-ai/config.yml', 'schema_version: 1', 'families:', 'selection:'].every((s) => next.includes(s))
  })
})

test('config ausente no crea .sdd-ai/config.yml', () => {
  const root = tmp()
  assert.throws(() => loadCrossModel(root), isCode('config_missing'))
  assert.equal(existsSync(join(root, '.sdd-ai')), false)
  assert.equal(existsSync(join(root, '.specify')), false)
})

test('sdd-ai no lee .specify/', () => {
  const root = tmp()
  mkdirSync(join(root, '.specify'))
  copyFileSync(FIXTURE, join(root, '.specify', 'config.yml'))
  assert.throws(() => loadCrossModel(root), isCode('config_missing'))
})

test('lee la config real de ai-workflows sin modificarla', () => {
  const root = tmp()
  mkdirSync(join(root, '.sdd-ai'))
  const file = join(root, '.sdd-ai', 'config.yml')
  copyFileSync(FIXTURE, file)
  const before = sha(file)
  assert.deepEqual(loadCrossModel(root), { families: ['codex', 'claude'], selection: 'full' })
  assert.equal(sha(file), before)
})

test('YAML ilegible es config_invalid', () => {
  const root = tmp()
  mkdirSync(join(root, '.sdd-ai'))
  writeFileSync(join(root, '.sdd-ai', 'config.yml'), 'cross_model: [')
  assert.throws(() => loadCrossModel(root), isCode('config_invalid'))
})

test('parseFamiliesFlag valida como families', () => {
  assert.deepEqual(parseFamiliesFlag('claude'), ['claude'])
  assert.deepEqual(parseFamiliesFlag('claude,codex'), ['claude', 'codex'])
  assert.throws(() => parseFamiliesFlag('x'), isCode('usage'))
})

test('effectiveFamilies: el flag reemplaza la lista del config', () => {
  assert.deepEqual(effectiveFamilies(['claude'], ['codex']), ['codex'])
  assert.deepEqual(effectiveFamilies(['claude', 'codex']), ['claude', 'codex'])
})
