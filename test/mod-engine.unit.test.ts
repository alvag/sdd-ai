import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { MOD_ENGINE_FILES, MOD_SYNC_COMMAND, MOD_TYPES_COMMAND, inspectModEngine, modEngineContext } from '../src/mod-engine.ts'
import { phaseTouchesMods, renderPhasePrompt } from '../src/sdd/phase.ts'

test('mod engine diagnoses copy and declarations with the same paths and commands as scripts/mods.mjs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-engine-'))
  try {
    const script = readFileSync(new URL('../scripts/mods.mjs', import.meta.url), 'utf8')
    assert.ok(script.includes(MOD_SYNC_COMMAND))
    assert.ok(script.includes(MOD_TYPES_COMMAND))
    assert.ok(script.includes("resolve('.claude/skills/sdd-ai-mod')"))
    assert.ok(script.includes("join(copy, '.claude-plugin/types')"))
    for (const file of MOD_ENGINE_FILES) assert.ok(script.includes(`'${file.split('/')[0]}'`))
    let engine = inspectModEngine(root)
    assert.equal(engine.state, 'copy_missing')
    assert.throws(() => modEngineContext(engine, 'claude'), { code: 'mod_copy_missing', next: MOD_SYNC_COMMAND })
    assert.equal(modEngineContext(engine, 'codex').warnings[0].code, 'mod_copy_missing')
    mkdirSync(engine.copy, { recursive: true })
    engine = inspectModEngine(root)
    assert.equal(engine.state, 'types_missing')
    assert.throws(() => modEngineContext(engine, 'claude'), { code: 'mod_engine_types_missing', next: MOD_TYPES_COMMAND })
    for (const path of engine.paths) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'real fixture declaration') }
    engine = inspectModEngine(root)
    assert.equal(engine.state, 'available')
    assert.deepEqual(engine.missing, [])
    for (const path of engine.paths) {
      assert.equal(isAbsolute(path), true)
      assert.equal(readFileSync(path, 'utf8'), 'real fixture declaration')
      assert.ok(modEngineContext(engine, 'claude').context.includes(path))
    }
    rmSync(engine.paths[0]); mkdirSync(engine.paths[0])
    assert.deepEqual(inspectModEngine(root).missing, [engine.paths[0]], 'un directorio no es una declaración legible')
    assert.equal(inspectModEngine(join(root, 'other-checkout')).state, 'copy_missing')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('phaseTouchesMods uses only the frozen inputs of each relevant phase', () => {
  for (const prefix of ['', '\n', ' ', '`', '"', "'", '(', './', ' ./']) {
    for (const path of ['mods/sdd-ai/hooks/register.tsx', '.claude/skills/sdd-ai-mod/types/']) {
      assert.equal(phaseTouchesMods('plan', { spec: prefix + path }), true)
    }
  }
  for (const spec of ['scripts/mods.mjs', 'test:mods', 'src/mods/a.ts', 'xmods/a.ts']) assert.equal(phaseTouchesMods('plan', { spec }), false)
  assert.equal(phaseTouchesMods('specify', { request: 'mods/a.ts' }), false)
  assert.equal(phaseTouchesMods('verify', { spec: 'mods/a.ts' }), false)
  assert.equal(phaseTouchesMods('plan', { request: 'mods/a.ts', plan: 'mods/a.ts' }), false)
  assert.equal(phaseTouchesMods('plan', { context: 'mods/a.ts' }), true)
  assert.equal(phaseTouchesMods('tasks', { context: 'mods/a.ts' }), false)
  assert.equal(phaseTouchesMods('tasks', { plan: 'mods/a.ts' }), true)
  assert.equal(phaseTouchesMods('implement', { tasks: 'mods/a.ts' }), true)
  const spec = 'spec bytes\n', context = 'user bytes\n'
  const prompt = renderPhasePrompt('plan', { id: 'f', depth: 'normal', step: 'plan' }, { spec, context }, 'API CONTEXT')
  assert.ok(prompt.includes(`<<<INSUMO spec\n${spec}\nINSUMO spec>>>`))
  assert.ok(prompt.includes(`<<<CONTEXTO ampliación\n${context}\nCONTEXTO ampliación>>>`))
  assert.ok(prompt.includes('API CONTEXT'))
})
