import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentsState, parseAgentSource, renderClaudeAgent, renderCodexAgent, sourceHash, syncAgents,
} from '../src/agents.ts'

const SOURCE = '---\nname: sdd-worker\ndescription: Worker read-only\n---\nLee tu encargo.\n'
const src = parseAgentSource(SOURCE)

test('el agente de Claude es read-only, sin CLAUDE.md y marcado como generado', () => {
  assert.equal(
    renderClaudeAgent(src, { model: 'opus', effort: 'high' }, 'h1'),
    '---\nname: sdd-worker\ndescription: Worker read-only\ntools: Read, Grep, Glob\nmodel: opus\neffort: high\n'
      + 'omitClaudeMd: true\n---\n<!-- generado por sdd-ai desde agents/worker.md · no editar a mano · sdd-ai-hash: h1 -->\n\n'
      + 'Lee tu encargo.\n',
  )
  assert.equal(renderClaudeAgent(src, { model: 'opus' }, 'h1').includes('effort:'), false)
})

test('el agente de Codex lleva las instrucciones y no declara sandbox_mode', () => {
  const out = renderCodexAgent(src, { model: 'gpt-6-sol' }, 'h1')
  assert.equal(
    out,
    '# generado por sdd-ai desde agents/worker.md · no editar a mano · sdd-ai-hash: h1\nname = "sdd-worker"\n'
      + 'description = "Worker read-only"\nmodel = "gpt-6-sol"\ndeveloper_instructions = \'\'\'\nLee tu encargo.\n\'\'\'\n',
  )
  assert.equal(out.includes('sandbox_mode'), false)
})

test('un cuerpo con triple comilla simple no cabe en el TOML', () => {
  assert.throws(() => renderCodexAgent(parseAgentSource(SOURCE.replace('Lee', "'''Lee")), {}, 'h1'))
})

test('el hash cambia si cambia el perfil de cualquier familia', () => {
  const a = sourceHash(src, { claude: { model: 'opus' }, codex: { model: 'x' } })
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, sourceHash(src, { claude: { model: 'opus' }, codex: { model: 'y' } }))
  assert.notEqual(a, sourceHash(src, { claude: { model: 'sonnet' }, codex: { model: 'x' } }))
})

test('sync escribe agentes y skills, y el estado pasa de missing a ok y a stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-root-'))
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-pkg-'))
  mkdirSync(join(pkg, 'agents'))
  mkdirSync(join(pkg, 'skills', 'sdd-ai'), { recursive: true })
  writeFileSync(join(pkg, 'agents', 'worker.md'), SOURCE)
  writeFileSync(join(pkg, 'skills', 'sdd-ai', 'SKILL.md'), '---\nname: sdd-ai\ndescription: x\n---\ncuerpo\n')
  const profiles = { claude: { model: 'opus' }, codex: { model: 'gpt-6-sol' } }

  assert.equal(agentsState(root, pkg, 'claude', profiles), 'missing')
  const written = syncAgents(root, pkg, profiles)
  const expected = [
    '.claude/agents/sdd-worker.md', '.codex/agents/sdd-worker.toml',
    '.claude/skills/sdd-ai/SKILL.md', '.agents/skills/sdd-ai/SKILL.md',
  ].map((p) => join(root, p))
  assert.deepEqual(written.sort(), expected.sort())
  for (const p of expected) assert.equal(existsSync(p), true)
  assert.equal(agentsState(root, pkg, 'claude', profiles), 'ok')
  assert.equal(agentsState(root, pkg, 'codex', profiles), 'ok')
  assert.equal(agentsState(root, pkg, 'codex', { ...profiles, codex: { model: 'otro' } }), 'stale')

  // Una edición a mano que conserva la marca también deja el agente desactualizado.
  const claude = join(root, '.claude/agents/sdd-worker.md')
  writeFileSync(claude, readFileSync(claude, 'utf8').replace('Lee tu encargo.', 'Haz otra cosa.'))
  assert.equal(agentsState(root, pkg, 'claude', profiles), 'stale')
})
