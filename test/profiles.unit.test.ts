import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCodexRoot, loadWorkers, parseWorkers, readCodexRoot } from '../src/profiles.ts'
import { SddError } from '../src/types.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'workers-ai-workflows.yml')
const PATH = '/repo/.sdd-ai/workers.yml'

const base = (familyBlock = '      model: opus\n      effort: alto\n') =>
  `schema_version: 1\nroles:\n  explore:\n    claude:\n${familyBlock}`

function rejects(text: string) {
  assert.throws(() => parseWorkers(text, PATH), (e: unknown) =>
    e instanceof SddError && e.code === 'workers_invalid' && e.message.includes(PATH))
}

test('pr: da el error de migración', () => {
  assert.throws(() => parseWorkers(readFileSync(FIXTURE, 'utf8'), FIXTURE), (e: unknown) =>
    e instanceof SddError && e.code === 'workers_invalid' && /`pr`/.test(e.message)
    && /code-review/.test(`${e.message} ${e.next}`))
})

test('el fixture de ai-workflows con pr renombrado valida', () => {
  const text = readFileSync(FIXTURE, 'utf8').replace(/^ {2}pr:$/m, '  code-review:')
  const w = parseWorkers(text, FIXTURE)
  assert.deepEqual(w.roles.explore?.codex, { model: 'gpt-6-sol', effort: 'alto' })
  assert.deepEqual(w.roles['code-review']?.claude, { model: 'opus', effort: 'alto' })
})

test('esfuerzo fuera del enum', () => rejects(base('      model: opus\n      effort: turbo\n')))
test('rol desconocido', () => rejects('schema_version: 1\nroles:\n  explorar:\n    claude:\n      model: opus\n'))
test('un rol con nombre de Object.prototype es una clave no admitida', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => parseWorkers(`schema_version: 1\nroles:\n  ${key}:\n    claude:\n      model: opus\n`, PATH), (e: unknown) =>
      e instanceof SddError && e.code === 'workers_invalid' && e.message.includes(`clave no admitida "${key}" en roles`), key)
  }
})
test('familia desconocida', () => rejects('schema_version: 1\nroles:\n  explore:\n    gemini:\n      model: g\n'))
test('clave no admitida bajo una familia', () => rejects(base('      model: opus\n      timeout: 5\n')))
test('clave no admitida en la raíz', () => rejects(`${base()}profiles:\n  x: 1\n`))
test('schema_version desconocida', () => rejects(base().replace('schema_version: 1', 'schema_version: 2')))
test('sin schema_version', () => rejects(base().replace('schema_version: 1\n', '')))
test('YAML ilegible', () => rejects('roles: ['))
test('modelo nulo', () => rejects(base('      model: null\n')))
test('modelo numérico', () => rejects(base('      model: 5\n')))
test('modelo booleano', () => rejects(base('      model: true\n')))
test('modelo vacío', () => rejects(base("      model: ''\n")))
test('clave duplicada', () =>
  rejects('schema_version: 1\nroles:\n  explore:\n    claude:\n      model: a\n  explore:\n    codex:\n      model: b\n'))

test('un rol con solo model es válido', () => {
  assert.deepEqual(parseWorkers(base('      model: opus\n'), PATH).roles.explore?.claude, { model: 'opus' })
})

test('heredado es válido en model y effort', () => {
  const w = parseWorkers(base('      model: heredado\n      effort: heredado\n'), PATH)
  assert.deepEqual(w.roles.explore?.claude, { model: 'heredado', effort: 'heredado' })
})

test('loadWorkers lee .sdd-ai/workers.yml y devuelve null si falta', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-workers-'))
  assert.equal(loadWorkers(root), null)
  mkdirSync(join(root, '.sdd-ai'))
  writeFileSync(join(root, '.sdd-ai', 'workers.yml'), base())
  assert.deepEqual(loadWorkers(root)?.roles.explore?.claude, { model: 'opus', effort: 'alto' })
})

test('readCodexRoot toma solo las asignaciones raíz', () => {
  const text = 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "o3"\n'
  assert.deepEqual(readCodexRoot(text), { model: 'gpt-6-sol', effort: 'high' })
})

test('readCodexRoot con una tabla en la primera línea no tiene raíz', () => {
  assert.deepEqual(readCodexRoot('[x]\nmodel = "a"\n'), {})
})

test('readCodexRoot descarta asignaciones ambiguas o mal formadas', () => {
  assert.deepEqual(readCodexRoot('model = "a"\nmodel = "b"\n'), {})
  assert.deepEqual(readCodexRoot("model = 'a'\n"), {})
  assert.deepEqual(readCodexRoot('model_reasoning_effort = "turbo"\n'), {})
})

test('loadCodexRoot lee $CODEX_HOME/config.toml y tolera su ausencia', () => {
  const home = mkdtempSync(join(tmpdir(), 'sdd-ai-codex-'))
  assert.deepEqual(loadCodexRoot({ CODEX_HOME: home }), {})
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-6-sol"\n')
  assert.deepEqual(loadCodexRoot({ CODEX_HOME: home }), { model: 'gpt-6-sol' })
})
