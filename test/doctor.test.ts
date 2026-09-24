import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkFlags, doctor, emittedFlags } from '../src/doctor.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const CLAUDE_HELP = fixture('claude-help.txt')
const CODEX_HELP = fixture('codex-exec-help.txt')

test('los flags salen de los adapters, sin valores ni el guion de stdin', () => {
  const claude = emittedFlags('claude')
  for (const f of ['--tools', '--permission-prompts', '--effort', '--safe-mode']) assert.ok(claude.includes(f), f)
  assert.equal(claude.some((f) => f.includes('=') || f === '-'), false)
  const codex = emittedFlags('codex')
  for (const f of ['-s', '-C', '--output-last-message', '-c', '-m', '--ignore-user-config']) assert.ok(codex.includes(f), f)
  assert.equal(codex.includes('-'), false)
})

test('con la ayuda real de las versiones instaladas, todos los flags están', () => {
  for (const r of checkFlags(CLAUDE_HELP, emittedFlags('claude'))) assert.equal(r.present, true, r.flag)
  for (const r of checkFlags(CODEX_HELP, emittedFlags('codex'))) assert.equal(r.present, true, r.flag)
})

test('un flag que desaparece de la ayuda se reporta ausente', () => {
  const help = CLAUDE_HELP.split('\n').filter((l) => !l.includes('--permission-prompts')).join('\n')
  const r = checkFlags(help, emittedFlags('claude')).find((x) => x.flag === '--permission-prompts')
  assert.equal(r?.present, false)
})

test('un CLI que no está en PATH hace fallar el diagnóstico', () => {
  const report = doctor((cmd, args) => {
    if (cmd === 'claude') return { status: null, stdout: '' }
    return { status: 0, stdout: args.includes('--version') ? 'codex-cli 0.156.1\n' : CODEX_HELP }
  })
  assert.equal(report.ok, false)
  const claude = report.clis.find((c) => c.family === 'claude')
  assert.equal(claude?.inPath, false)
  assert.equal(report.clis.find((c) => c.family === 'codex')?.version, '0.156.1')
})
