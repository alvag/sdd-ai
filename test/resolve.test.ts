import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveFamilies } from '../src/config.ts'
import { nativeProfile, resolve } from '../src/resolve.ts'
import type { WorkersFile } from '../src/profiles.ts'
import type { Family, Via } from '../src/types.ts'

type Row = [config: Family[], flag: Family[] | undefined, conductor: Family, family: Family, via: Via]

const MATRIX: Row[] = [
  [['claude'], undefined, 'claude', 'claude', 'native'],
  [['claude'], undefined, 'codex', 'claude', 'process'],
  [['codex'], undefined, 'claude', 'codex', 'process'],
  [['codex'], undefined, 'codex', 'codex', 'native'],
  [['claude', 'codex'], undefined, 'claude', 'codex', 'process'],
  [['claude', 'codex'], undefined, 'codex', 'claude', 'process'],
  [['claude'], ['codex'], 'claude', 'codex', 'process'],
  [['claude'], ['codex'], 'codex', 'codex', 'native'],
  [['codex'], ['claude'], 'claude', 'claude', 'native'],
  [['codex'], ['claude'], 'codex', 'claude', 'process'],
  [['claude', 'codex'], ['claude'], 'claude', 'claude', 'native'],
  [['claude', 'codex'], ['codex'], 'codex', 'codex', 'native'],
]

describe('matriz families × conductor', () => {
  for (const [config, flag, conductor, family, via] of MATRIX) {
    const name = `config [${config}]${flag ? ` + --families ${flag}` : ''}, conductor ${conductor} → ${family}/${via}`
    test(name, () => {
      const r = resolve({
        families: effectiveFamilies(config, flag), conductor: { family: conductor },
        workers: null, role: 'explore', flags: {}, codexRoot: {},
      })
      assert.equal(r.family, family)
      assert.equal(r.via, via)
    })
  }
})

describe('perfil', () => {
  const input = (over: Partial<Parameters<typeof resolve>[0]>) => ({
    families: ['claude'] as Family[], conductor: { family: 'codex' as Family },
    workers: null, role: 'explore' as const, flags: {}, codexRoot: {}, ...over,
  })

  test('Claude sin archivo hereda opus y ningún esfuerzo', () => {
    const r = resolve(input({}))
    assert.equal(r.model, 'opus')
    assert.equal(r.effort, undefined)
    assert.deepEqual(r.origin, { model: 'heredado', effort: 'heredado' })
  })

  test('Codex sin archivo hereda la raíz de su config', () => {
    const r = resolve(input({ families: ['codex'], conductor: { family: 'claude' }, codexRoot: { model: 'gpt-6-sol', effort: 'high' } }))
    assert.equal(r.model, 'gpt-6-sol')
    assert.equal(r.effort, 'high')
    assert.deepEqual(r.origin, { model: 'heredado', effort: 'heredado' })
  })

  test('workers.yml manda sobre heredado y traduce el esfuerzo', () => {
    const workers: WorkersFile = { roles: { explore: { codex: { model: 'gpt-x', effort: 'alto' } } } }
    const r = resolve(input({ families: ['codex'], conductor: { family: 'claude' }, workers }))
    assert.equal(r.model, 'gpt-x')
    assert.equal(r.effort, 'high')
    assert.deepEqual(r.origin, { model: 'workers', effort: 'workers' })
  })

  test('heredado en workers.yml cae a la resolución heredada', () => {
    const workers: WorkersFile = { roles: { explore: { claude: { model: 'sonnet', effort: 'heredado' } } } }
    const r = resolve(input({ workers }))
    assert.equal(r.model, 'sonnet')
    assert.deepEqual(r.origin, { model: 'workers', effort: 'heredado' })
  })

  test('el flag manda sobre workers.yml', () => {
    const workers: WorkersFile = { roles: { explore: { claude: { model: 'sonnet', effort: 'bajo' } } } }
    const r = resolve(input({ workers, flags: { model: 'm', effort: 'max' } }))
    assert.equal(r.model, 'm')
    assert.equal(r.effort, 'max')
    assert.deepEqual(r.origin, { model: 'flag', effort: 'flag' })
  })

  test('nativeProfile aplica las mismas reglas para los agentes generados', () => {
    const workers: WorkersFile = { roles: { explore: { codex: { effort: 'muy_alto' } } } }
    assert.deepEqual(nativeProfile('claude', null, {}), { model: 'opus' })
    assert.deepEqual(nativeProfile('codex', workers, { model: 'gpt-6-sol' }), { model: 'gpt-6-sol', effort: 'xhigh' })
  })
})
