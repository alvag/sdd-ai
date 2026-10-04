import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Exec, doctor, emittedFlags } from '../src/doctor.ts'
import { MOD_PATH, modCopy, modInventory, syncModCopy } from '../src/mod-copies.ts'

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
