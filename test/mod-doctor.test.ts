import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { emittedFlags } from '../src/doctor.ts'
import { inspectModEngine } from '../src/mod-engine.ts'
import { chainSetup, runBin } from './helpers.ts'

test('el comando doctor avisa declaraciones ausentes y agentes antiguos sin perder ok y lo pierde sin copia', () => {
  const s = chainSetup({ bins: ['claude', 'codex'] })
  for (const family of ['claude', 'codex'] as const) {
    const executable = join(s.env.PATH.split(':')[0], family)
    rmSync(executable)
    const flags = [...emittedFlags(family), ...emittedFlags(family, 'resume')].join('\n')
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version') ? '2.1.290' : ${JSON.stringify(flags)})\n`, { mode: 0o755 })
  }
  assert.equal(runBin(s, ['agents', 'sync']).code, 0)
  let r = runBin(s, ['doctor'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.ok, true)
  assert.ok(r.out.warnings.some((w: { code: string }) => w.code === 'mod_engine_types_missing'))
  const engine = inspectModEngine(s.repo)
  for (const path of engine.paths) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'engine declaration') }
  const old = join(s.repo, '.claude/agents/sdd-ai-explore.md')
  writeFileSync(old, readFileSync(old, 'utf8') + '\nold instructions\n')
  r = runBin(s, ['doctor'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.ok(r.out.warnings.some((w: { code: string }) => w.code === 'agent_copy_stale'))
  assert.equal(runBin(s, ['agents', 'sync']).code, 0)
  assert.deepEqual(runBin(s, ['doctor']).out.warnings, [])
  for (const path of engine.paths) assert.equal(readFileSync(path, 'utf8'), 'engine declaration')
  rmSync(engine.copy, { recursive: true })
  r = runBin(s, ['doctor'])
  assert.equal(r.code, 1, JSON.stringify(r.out))
  assert.equal(r.out.ok, false)
})
