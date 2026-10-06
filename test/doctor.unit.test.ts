import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { skillCopies } from '../src/agents.ts'
import { checkFlags, doctor, emittedFlags } from '../src/doctor.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const CLAUDE_HELP = fixture('claude-help.txt')
const CODEX_HELP = fixture('codex-exec-help.txt')
const CODEX_RESUME_HELP = fixture('codex-exec-resume-help.txt')

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
  for (const r of checkFlags(CODEX_RESUME_HELP, emittedFlags('codex', 'resume'))) assert.equal(r.present, true, `resume ${r.flag}`)
})

test('los flags incluyen los del revisor y los de la reanudación', () => {
  for (const f of ['--system-prompt', '--resume', '--safe-mode']) assert.ok(emittedFlags('claude').includes(f), f)
  for (const f of ['--disable', '--skip-git-repo-check']) assert.ok(emittedFlags('codex').includes(f), f)
  const resume = emittedFlags('codex', 'resume')
  for (const f of ['-c', '--output-last-message', '--ignore-user-config', '--json']) assert.ok(resume.includes(f), f)
  assert.equal(resume.includes('-C') || resume.includes('-s'), false)
})

test('los flags incluyen los de los roles con web', () => {
  assert.ok(emittedFlags('claude').includes('--allowedTools'))
})

test('un flag de reanudación que desaparece de su ayuda se reporta', () => {
  const resumeHelp = CODEX_RESUME_HELP.split('\n').filter((l) => !l.includes('--output-last-message')).join('\n')
  const report = doctor((cmd, args) => {
    if (args.includes('--version')) return { status: 0, stdout: cmd === 'claude' ? '2.1.282 (Claude Code)' : 'codex-cli 0.156.1' }
    if (cmd === 'claude') return { status: 0, stdout: CLAUDE_HELP }
    return { status: 0, stdout: args.includes('resume') ? resumeHelp : CODEX_HELP }
  })
  assert.equal(report.ok, false)
  const codex = report.clis.find((c) => c.family === 'codex')
  assert.equal(codex?.flags.find((f) => f.flag === 'resume --output-last-message')?.present, false)
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

test('doctor comprueba los flags del writer en exec y resume', () => {
  const claude = emittedFlags('claude')
  for (const f of ['--restricted', '--strict-mcp-config', '--permission-mode', '--allowedTools']) assert.ok(claude.includes(f), f)
  assert.ok(emittedFlags('codex').includes('--ignore-rules'))
  assert.ok(emittedFlags('codex', 'resume').includes('--ignore-rules'))
  const resumeHelp = CODEX_RESUME_HELP.split('\n').filter((l) => !l.includes('--ignore-rules')).join('\n')
  const claudeHelp = CLAUDE_HELP.split('\n').filter((l) => !l.includes('--restricted')).join('\n')
  const report = doctor((cmd, args) => {
    if (args.includes('--version')) return { status: 0, stdout: cmd === 'claude' ? '2.1.283 (Claude Code)' : 'codex-cli 0.157.1' }
    if (cmd === 'claude') return { status: 0, stdout: claudeHelp }
    return { status: 0, stdout: args.includes('resume') ? resumeHelp : CODEX_HELP }
  })
  assert.equal(report.ok, false)
  assert.equal(report.clis.find((c) => c.family === 'claude')?.flags.find((f) => f.flag === '--restricted')?.present, false)
  const codex = report.clis.find((c) => c.family === 'codex')?.flags ?? []
  assert.equal(codex.find((f) => f.flag === 'resume --ignore-rules')?.present, false)
  assert.equal(codex.find((f) => f.flag === '--ignore-rules')?.present, true)
})

/** Los dos CLIs presentes y con todos los flags, para que el resultado dependa solo de la skill. */
const passing = (cmd: string, args: string[]) => {
  if (args.includes('--version')) return { status: 0, stdout: cmd === 'claude' ? '2.1.284 (Claude Code)' : 'codex-cli 0.158.0' }
  if (cmd === 'claude') return { status: 0, stdout: CLAUDE_HELP }
  return { status: 0, stdout: args.includes('resume') ? CODEX_RESUME_HELP : CODEX_HELP }
}

test('doctor informa la copia de la skill vieja o ausente con su ruta y agents sync', () => {
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-pkg-'))
  mkdirSync(join(pkg, 'skills', 'sdd-ai'), { recursive: true })
  writeFileSync(join(pkg, 'skills', 'sdd-ai', 'SKILL.md'), 'skill v2\n')
  const repo = mkdtempSync(join(tmpdir(), 'sdd-ai-repo-'))
  const claudeCopy = '.claude/skills/sdd-ai/SKILL.md'
  const agentsCopy = '.agents/skills/sdd-ai/SKILL.md'
  for (const rel of [claudeCopy, agentsCopy]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), 'skill v2\n')
  }
  const fine = doctor(passing, { copies: skillCopies(repo, pkg) })
  assert.equal(fine.ok, true)
  assert.deepEqual(fine.skill, { copies: [{ path: claudeCopy, state: 'ok' }, { path: agentsCopy, state: 'ok' }] })
  writeFileSync(join(repo, agentsCopy), 'skill v1\n')
  const stale = doctor(passing, { copies: skillCopies(repo, pkg) })
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.skill, {
    copies: [{ path: claudeCopy, state: 'ok' }, { path: agentsCopy, state: 'stale' }], next: './bin/sdd-ai agents sync',
  })
  rmSync(join(repo, claudeCopy))
  assert.deepEqual(skillCopies(repo, pkg).map((c) => c.state), ['missing', 'stale'])
  const skipped = doctor(passing, { skipped: 'no es un repositorio Git' })
  assert.deepEqual([skipped.ok, skipped.skill], [true, { skipped: 'no es un repositorio Git' }])
})
