import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type RoleProfiles, agentCopies, syncAgents } from '../src/agents.ts'
import { inspectModEngine } from '../src/mod-engine.ts'
import { READ_ONLY_ROLES } from '../src/types.ts'
import { type Exec, doctor, emittedFlags } from '../src/doctor.ts'
import { MOD_PATH, modCopy, modInventory, syncModCopy } from '../src/mod-copies.ts'

test('doctor distingue avisos del API y copias de agentes desactualizadas', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-engine-doctor-'))
  const pkg = join(import.meta.dirname, '..')
  const inventory = modInventory(pkg)
  const profiles = Object.fromEntries(READ_ONLY_ROLES.map((role) => [role, { claude: {}, codex: {} }])) as RoleProfiles
  const exec: Exec = (name, args) => ({ status: 0, stdout: args.includes('--version') ? '2.1.290' : emittedFlags(name as 'claude' | 'codex', args.includes('resume') ? 'resume' : 'exec').join('\n') })
  const check = () => doctor(exec, undefined, { copies: [modCopy(root, inventory)] }, inspectModEngine(root), { copies: agentCopies(root, pkg, profiles) })
  try {
    assert.equal(check().ok, false)
    syncModCopy(root, inventory)
    let report = check()
    assert.equal(report.ok, true, 'tipos y agentes ausentes solo avisan')
    assert.ok(report.warnings?.some((w) => w.code === 'mod_engine_types_missing'))
    assert.equal(report.warnings?.filter((w) => w.code === 'agent_copy_missing').length, READ_ONLY_ROLES.length * 2)
    const engine = inspectModEngine(root)
    for (const path of engine.paths) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'engine declaration') }
    syncAgents(root, pkg, profiles)
    assert.deepEqual(check().warnings, [])
    for (const path of engine.paths) assert.equal(readFileSync(path, 'utf8'), 'engine declaration')
    const copy = agentCopies(root, pkg, profiles)[0]
    writeFileSync(join(root, copy.path), readFileSync(join(root, copy.path), 'utf8') + '\nold rule\n')
    report = check()
    assert.equal(report.ok, true)
    assert.deepEqual(report.warnings, [{ code: 'agent_copy_stale', message: `El agente ${copy.path} está desactualizado.`, next: './bin/sdd-ai agents sync' }])
    syncAgents(root, pkg, profiles)
    assert.deepEqual(check().warnings, [])
    rmSync(engine.paths[0]); mkdirSync(engine.paths[0])
    assert.equal(check().ok, true, 'declaración ilegible solo avisa')
    assert.ok(check().warnings?.some((w) => w.code === 'mod_engine_types_missing'))
    rmSync(join(root, MOD_PATH), { recursive: true })
    assert.equal(check().ok, false, 'copia ausente sigue quitando ok')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor reports current missing and stale mod copies like skill copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-mod-doctor-'))
  const inventory = modInventory(join(import.meta.dirname, '..'))
  const exec: Exec = (name, args) => ({ status: 0, stdout: args.includes('--version') ? '2.1.289' : emittedFlags(name as 'claude' | 'codex', args.includes('resume') ? 'resume' : 'exec').join('\n') })
  const check = () => doctor(exec, { copies: [] }, { copies: [modCopy(root, inventory)] })
  try {
    const missing = check()
    assert.equal(missing.ok, false)
    assert.deepEqual(missing.mod, { copies: [{ path: MOD_PATH, state: 'missing' }], next: './bin/sdd-ai agents sync' })
    syncModCopy(root, inventory)
    assert.equal(check().ok, true)
    writeFileSync(join(root, MOD_PATH, 'hooks/register.tsx'), 'stale')
    assert.equal(check().ok, false)
    syncModCopy(root, inventory)
    writeFileSync(join(root, MOD_PATH, 'hooks/old.ts'), 'old')
    assert.equal(check().ok, false)
    syncModCopy(root, inventory)
    mkdirSync(join(root, MOD_PATH, '.claude-plugin/types'), { recursive: true })
    writeFileSync(join(root, MOD_PATH, '.claude-plugin/types/engine.ts'), 'engine')
    writeFileSync(join(root, MOD_PATH, 'tsconfig.json'), 'engine config')
    assert.equal(check().ok, true)
    assert.equal(doctor(exec, undefined, { skipped: 'no es un repositorio Git' }).ok, true)
    assert.equal(doctor(exec, { copies: [{ path: 'skill', state: 'stale' }] }, { copies: [modCopy(root, inventory)] }).ok, false)
    assert.equal(doctor(() => ({ status: null, stdout: '' }), undefined, { copies: [modCopy(root, inventory)] }).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor reports an unreadable mod source as a failure with its next step', () => {
  const exec: Exec = (name, args) => ({ status: 0, stdout: args.includes('--version') ? '2.1.289' : emittedFlags(name as 'claude' | 'codex', args.includes('resume') ? 'resume' : 'exec').join('\n') })
  const report = doctor(exec, undefined, { unavailable: 'la fuente del mod no se puede leer: ENOENT' })
  assert.equal(report.ok, false)
  assert.ok(report.mod && 'unavailable' in report.mod)
  assert.match(String(report.mod && 'next' in report.mod ? report.mod.next : ''), /mods\/sdd-ai/)
  assert.equal(doctor(exec, undefined, { skipped: 'no es un repositorio Git' }).ok, true)
})
