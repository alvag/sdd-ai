import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveFamilies, loadCrossModel, loadJiraMode, parseCrossModel, parseFamiliesFlag } from '../src/config.ts'
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

test('loadJiraMode: on y off; sin archivo, sin bloque o sin mode es off; booleano, otro valor, bloque que no es mapa o YAML ilegible es invalid', () => {
  const withConfig = (text: string) => {
    const root = tmp()
    mkdirSync(join(root, '.sdd-ai'))
    writeFileSync(join(root, '.sdd-ai', 'config.yml'), text)
    return root
  }
  const cross = 'cross_model:\n  schema_version: 1\n  families: [claude]\n  selection: full\n'
  assert.deepEqual(loadJiraMode(withConfig(`${cross}jira_approval:\n  mode: "on"\n`)), { mode: 'on' })
  assert.deepEqual(loadJiraMode(withConfig('jira_approval:\n  mode: "off"\n')), { mode: 'off' })
  assert.deepEqual(loadJiraMode(tmp()), { mode: 'off' })
  assert.deepEqual(loadJiraMode(withConfig(cross)), { mode: 'off' })
  assert.deepEqual(loadJiraMode(withConfig('jira_approval: null\n')), { mode: 'off' })
  assert.deepEqual(loadJiraMode(withConfig('jira_approval: {}\n')), { mode: 'off' })
  const invalid = (text: string, what: string) => {
    const mode = loadJiraMode(withConfig(text))
    assert.equal(mode.mode, 'invalid', text)
    assert.ok(mode.mode === 'invalid' && mode.detail.startsWith('.sdd-ai/config.yml') && mode.detail.includes(what), `${text} → ${JSON.stringify(mode)}`)
  }
  invalid('jira_approval:\n  mode: true\n', 'jira_approval.mode tiene que ser "on" u "off"')
  invalid('jira_approval:\n  mode: "maybe"\n', 'jira_approval.mode tiene que ser "on" u "off"')
  invalid('jira_approval: "on"\n', 'jira_approval tiene que ser un mapa')
  invalid('jira_approval: [\n', 'YAML ilegible')
  const dir = tmp()
  mkdirSync(join(dir, '.sdd-ai', 'config.yml'), { recursive: true })
  const unreadable = loadJiraMode(dir)
  assert.ok(unreadable.mode === 'invalid' && unreadable.detail.includes('no se puede leer'), JSON.stringify(unreadable))
})
