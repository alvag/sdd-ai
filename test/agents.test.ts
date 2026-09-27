import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type RoleProfiles, agentsState, parseAgentSource, renderClaudeAgent, renderCodexAgent, sourceHash, syncAgents,
} from '../src/agents.ts'
import { READ_ONLY_ROLES, WEB_ROLES } from '../src/types.ts'
import { makeRepo } from './helpers.ts'

const SOURCE = '---\ndescription: Worker read-only\n---\nLee tu encargo.\n'
const src = parseAgentSource(SOURCE)
const MARK = 'generado por sdd-ai desde agents/worker.md · no editar a mano · sdd-ai-hash:'
const NO_WEB = 'No busques en la web ni consultes otras fuentes externas: trabaja solo con el encargo y el repositorio.'

function profiles(over: Partial<RoleProfiles> = {}): RoleProfiles {
  const base = Object.fromEntries(READ_ONLY_ROLES.map((r) => [r, { claude: { model: 'opus' }, codex: { model: 'gpt-6-sol' } }]))
  return { ...base, ...over } as RoleProfiles
}

function makePkg(): string {
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-pkg-'))
  mkdirSync(join(pkg, 'agents'))
  mkdirSync(join(pkg, 'skills', 'sdd-ai'), { recursive: true })
  writeFileSync(join(pkg, 'agents', 'worker.md'), SOURCE)
  writeFileSync(join(pkg, 'skills', 'sdd-ai', 'SKILL.md'), '---\nname: sdd-ai\ndescription: x\n---\ncuerpo\n')
  return pkg
}

test('el agente de Claude es read-only, sin CLAUDE.md, con el nombre de su rol y marcado como generado', () => {
  assert.equal(
    renderClaudeAgent(src, 'explore', { model: 'opus', effort: 'high' }, 'h1'),
    '---\nname: sdd-ai-explore\ndescription: "Worker read-only Rol: explore."\ntools: Read, Grep, Glob, WebFetch, WebSearch\nmodel: opus\n'
      + 'effort: high\nomitClaudeMd: true\n---\n'
      + `<!-- ${MARK} h1 -->\n\nLee tu encargo.\n`,
  )
  assert.equal(renderClaudeAgent(src, 'explore', { model: 'opus' }, 'h1').includes('effort:'), false)
})

test('el agente de Codex lleva las instrucciones, el nombre de su rol y no declara sandbox_mode ni web_search', () => {
  const out = renderCodexAgent(src, 'code-review', { model: 'gpt-6-sol' }, 'h1')
  assert.equal(
    out,
    `# ${MARK} h1\nname = "sdd-ai-code-review"\n`
      + 'description = "Worker read-only Rol: code-review."\nmodel = "gpt-6-sol"\ndeveloper_instructions = \'\'\'\nLee tu encargo.\n\n'
      + `${NO_WEB}\n\'\'\'\n`,
  )
  assert.equal(out.includes('sandbox_mode'), false)
  assert.equal(out.includes('web_search'), false)
})

test('un cuerpo con triple comilla simple no cabe en el TOML', () => {
  assert.throws(() => renderCodexAgent(parseAgentSource(SOURCE.replace('Lee', "'''Lee")), 'explore', {}, 'h1'))
})

test('una fuente sin description no es válida', () => {
  assert.throws(() => parseAgentSource('---\nname: x\n---\ncuerpo\n'))
})

test('los agentes de Claude de explore e investigate tienen WebFetch y WebSearch, y los demás solo lectura', () => {
  for (const role of READ_ONLY_ROLES) {
    const tools = renderClaudeAgent(src, role, {}, 'h1').split('\n').find((l) => l.startsWith('tools:'))
    const expected = ['explore', 'investigate'].includes(role) ? 'tools: Read, Grep, Glob, WebFetch, WebSearch' : 'tools: Read, Grep, Glob'
    assert.equal(tools, expected, role)
  }
})

test('los agentes de Codex sin web llevan la regla de no buscar en la web, y ninguno declara web_search', () => {
  assert.deepEqual([...WEB_ROLES].sort(), ['explore', 'investigate'])
  for (const role of READ_ONLY_ROLES) {
    const out = renderCodexAgent(src, role, {}, 'h1')
    assert.equal(out.includes(NO_WEB), !WEB_ROLES.has(role), role)
    assert.equal(out.includes('web_search'), false, role)
  }
})

test('el hash cambia si cambia el perfil de cualquier familia', () => {
  const a = sourceHash(src, { claude: { model: 'opus' }, codex: { model: 'x' } })
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, sourceHash(src, { claude: { model: 'opus' }, codex: { model: 'y' } }))
  assert.notEqual(a, sourceHash(src, { claude: { model: 'sonnet' }, codex: { model: 'x' } }))
})

test('sync genera un agente por rol de solo lectura y familia', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-root-'))
  const p = profiles({ refute: { claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-6-sol' } } })
  const { written, removed } = syncAgents(root, makePkg(), p)
  const expected = [
    ...READ_ONLY_ROLES.flatMap((r) => [`.claude/agents/sdd-ai-${r}.md`, `.codex/agents/sdd-ai-${r}.toml`]),
    '.claude/skills/sdd-ai/SKILL.md', '.agents/skills/sdd-ai/SKILL.md',
  ].map((f) => join(root, f))
  assert.equal(expected.length, 16)
  assert.deepEqual([...written].sort(), [...expected].sort())
  for (const f of expected) assert.equal(existsSync(f), true)
  assert.deepEqual(removed, [])
  assert.equal(existsSync(join(root, '.claude/agents/sdd-ai-implement.md')), false)
  assert.equal(existsSync(join(root, '.codex/agents/sdd-ai-implement.toml')), false)
  // Cada agente lleva el perfil de su rol.
  assert.match(readFileSync(join(root, '.claude/agents/sdd-ai-refute.md'), 'utf8'), /\nmodel: sonnet\neffort: high\n/)
  assert.match(readFileSync(join(root, '.claude/agents/sdd-ai-explore.md'), 'utf8'), /\nmodel: opus\nomitClaudeMd/)
})

test('agents sync no genera sdd-ai-implement', () => {
  const repo = makeRepo()
  const r = spawnSync(join(import.meta.dirname, '..', 'bin', 'sdd-ai'), ['agents', 'sync'], {
    cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')) },
  })
  assert.equal(r.status, 0, r.stderr)
  const claude = readdirSync(join(repo, '.claude', 'agents'))
  const codex = readdirSync(join(repo, '.codex', 'agents'))
  assert.deepEqual(claude.sort(), READ_ONLY_ROLES.map((role) => `sdd-ai-${role}.md`).sort())
  assert.deepEqual(codex.sort(), READ_ONLY_ROLES.map((role) => `sdd-ai-${role}.toml`).sort())
})

test('sync borra lo generado que sobra y no toca un archivo sin marca', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-root-'))
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true })
  const oldClaude = join(root, '.claude/agents/sdd-worker.md')
  const oldCodex = join(root, '.codex/agents/sdd-worker.toml')
  const mine = join(root, '.claude/agents/mio.md')
  writeFileSync(oldClaude, `---\nname: sdd-worker\n---\n<!-- ${MARK} abc -->\n\ncuerpo\n`)
  writeFileSync(oldCodex, `# ${MARK} abc\nname = "sdd-worker"\n`)
  writeFileSync(mine, '---\nname: mio\n---\nun agente propio\n')

  const { removed } = syncAgents(root, makePkg(), profiles())
  assert.deepEqual([...removed].sort(), [oldClaude, oldCodex].sort())
  assert.equal(existsSync(oldClaude), false)
  assert.equal(existsSync(oldCodex), false)
  assert.equal(readFileSync(mine, 'utf8'), '---\nname: mio\n---\nun agente propio\n')
})

test('el estado del agente de un rol pasa de missing a ok y a stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-root-'))
  const pkg = makePkg()
  const p = profiles()
  assert.equal(agentsState(root, pkg, 'claude', 'code-review', p), 'missing')
  syncAgents(root, pkg, p)
  assert.equal(agentsState(root, pkg, 'claude', 'code-review', p), 'ok')
  assert.equal(agentsState(root, pkg, 'codex', 'code-review', p), 'ok')
  const otro = profiles({ 'code-review': { claude: { model: 'opus' }, codex: { model: 'otro' } } })
  assert.equal(agentsState(root, pkg, 'codex', 'code-review', otro), 'stale')
  assert.equal(agentsState(root, pkg, 'codex', 'explore', otro), 'ok')

  // Una edición a mano que conserva la marca también deja el agente desactualizado.
  const claude = join(root, '.claude/agents/sdd-ai-code-review.md')
  writeFileSync(claude, readFileSync(claude, 'utf8').replace('Lee tu encargo.', 'Haz otra cosa.'))
  assert.equal(agentsState(root, pkg, 'claude', 'code-review', p), 'stale')
})

test('las copias de la skill son iguales a la fuente después de agents sync', () => {
  const pkg = join(import.meta.dirname, '..')
  const source = readFileSync(join(pkg, 'skills', 'sdd-ai', 'SKILL.md'))
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-repo-'))
  syncAgents(root, pkg, profiles())
  // Las de un repo recién sincronizado y las de este repo, que se sincroniza con cada cambio de la skill.
  for (const base of [root, pkg]) {
    for (const copy of [join('.claude', 'skills', 'sdd-ai', 'SKILL.md'), join('.agents', 'skills', 'sdd-ai', 'SKILL.md')]) {
      assert.ok(readFileSync(join(base, copy)).equals(source), `${base}/${copy}`)
    }
  }
})
