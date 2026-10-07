import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type RoleProfiles, agentCopy, agentCopies, agentsState, readSource, readSkillSource, skillCopy, parseAgentSource, renderClaudeAgent, renderCodexAgent, skillCopies, sourceHash, syncAgents,
} from '../src/agents.ts'
import { READ_ONLY_ROLES, type Family } from '../src/types.ts'
import { copyModSource } from './mod-fixture.ts'

const repo = join(import.meta.dirname, '..')

const FAMILIES: readonly Family[] = ['claude', 'codex']

function profiles(): RoleProfiles {
  return Object.fromEntries(READ_ONLY_ROLES.map((r) => [r, { claude: { model: 'opus' }, codex: { model: 'gpt-6-sol' } }])) as RoleProfiles
}

function agentFile(root: string, family: Family, role: (typeof READ_ONLY_ROLES)[number]): string {
  const dir = family === 'claude' ? join('.claude', 'agents') : join('.codex', 'agents')
  return join(root, dir, `sdd-ai-${role}${family === 'claude' ? '.md' : '.toml'}`)
}

const toCrlf = (text: string): string => text.replace(/\n/g, '\r\n')

test('un agente generado con CRLF está vigente en las dos familias', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-agents-'))
  try {
    syncAgents(root, repo, profiles())
    for (const role of READ_ONLY_ROLES) {
      for (const family of FAMILIES) {
        const file = agentFile(root, family, role)
        writeFileSync(file, toCrlf(readFileSync(file, 'utf8')))
        assert.ok(readFileSync(file, 'utf8').includes('\r\n'), `${family} ${role}`)
        assert.equal(agentsState(root, repo, family, role, profiles()), 'ok', `${family} ${role}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('un agente con CRLF y una diferencia real sigue stale, y missing y ok no cambian', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-agents-'))
  const role = READ_ONLY_ROLES[0]
  try {
    for (const family of FAMILIES) assert.equal(agentsState(root, repo, family, role, profiles()), 'missing', family)
    syncAgents(root, repo, profiles())
    for (const family of FAMILIES) assert.equal(agentsState(root, repo, family, role, profiles()), 'ok', family)
    const variants: Record<string, (crlf: string) => string> = {
      'un carácter distinto': (crlf) => crlf.replace('sdd-ai-', 'sdd-ax-'),
      'un \\r suelto': (crlf) => crlf.replace('sdd-ai-', '\rsdd-ai-'),
      'un espacio al final de línea': (crlf) => crlf.replace('\r\n', ' \r\n'),
    }
    for (const family of FAMILIES) {
      const file = agentFile(root, family, role)
      const crlf = toCrlf(readFileSync(file, 'utf8'))
      for (const [name, change] of Object.entries(variants)) {
        const changed = change(crlf)
        assert.notEqual(changed, crlf, `${family} ${name}`)
        writeFileSync(file, changed)
        assert.equal(agentsState(root, repo, family, role, profiles()), 'stale', `${family} ${name}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const SKILL = '---\nname: sdd-ai\ndescription: Guía del conductor\n---\nUsa sdd-ai-explore para explorar.\nSegunda línea con acentos: áéíóú ñ.\nTercera línea.\nCuarta línea.\n'
const CLAUDE_COPY = join('.claude', 'skills', 'sdd-ai', 'SKILL.md')
const AGENTS_COPY = join('.agents', 'skills', 'sdd-ai', 'SKILL.md')

function skillFixture(): { pkg: string; root: string; setSource: (text: string | Buffer) => void; setCopy: (rel: string, text: string | Buffer) => void; dispose: () => void } {
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-pkg-'))
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-repo-'))
  mkdirSync(join(pkg, 'skills', 'sdd-ai'), { recursive: true })
  const setSource = (text: string | Buffer): void => writeFileSync(join(pkg, 'skills', 'sdd-ai', 'SKILL.md'), text)
  const setCopy = (rel: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return {
    pkg, root, setSource, setCopy,
    dispose: () => { rmSync(pkg, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) },
  }
}

const states = (root: string, pkg: string): string[] => skillCopies(root, pkg).map((c) => c.state)

test('una copia de la skill que solo difiere en el fin de línea está vigente, en los dos sentidos', () => {
  const f = skillFixture()
  try {
    f.setSource(SKILL)
    for (const rel of [CLAUDE_COPY, AGENTS_COPY]) f.setCopy(rel, toCrlf(SKILL))
    assert.deepEqual(states(f.root, f.pkg), ['ok', 'ok'])
    f.setSource(toCrlf(SKILL))
    for (const rel of [CLAUDE_COPY, AGENTS_COPY]) f.setCopy(rel, SKILL)
    assert.deepEqual(states(f.root, f.pkg), ['ok', 'ok'])
    f.setSource(SKILL)
    const lines = SKILL.split('\n')
    const half = Math.floor(lines.length / 2)
    const mixed = lines.map((line, i) => (i < half ? `${line}\r\n` : i < lines.length - 1 ? `${line}\n` : line)).join('')
    assert.ok(mixed.includes('\r\n') && mixed.replace(/\r\n/g, '').includes('\n'))
    for (const rel of [CLAUDE_COPY, AGENTS_COPY]) f.setCopy(rel, mixed)
    assert.deepEqual(states(f.root, f.pkg), ['ok', 'ok'])
  } finally {
    f.dispose()
  }
})

test('una copia de la skill con una diferencia real sigue stale, y una ausente, missing', () => {
  const f = skillFixture()
  try {
    f.setSource(SKILL)
    f.setCopy(AGENTS_COPY, SKILL)
    const crlf = toCrlf(SKILL)
    const variants: Record<string, (text: string) => string> = {
      'un carácter distinto': (text) => text.replace('sdd-ai-', 'sdd-ax-'),
      'un \\r suelto': (text) => text.replace('sdd-ai-', '\rsdd-ai-'),
      'un espacio al final de línea': (text) => text.replace('\r\n', ' \r\n'),
    }
    for (const [name, change] of Object.entries(variants)) {
      const changed = change(crlf)
      assert.notEqual(changed, crlf, name)
      f.setCopy(CLAUDE_COPY, changed)
      assert.deepEqual(states(f.root, f.pkg), ['stale', 'ok'], name)
    }
    // Un byte inválido en UTF-8 distinto en cada lado: una lectura en utf8 los daría por iguales.
    f.setSource(Buffer.concat([Buffer.from(SKILL), Buffer.from([0xfe])]))
    const withByte = Buffer.concat([Buffer.from(crlf), Buffer.from([0xff])])
    assert.notDeepEqual(withByte, Buffer.concat([Buffer.from(crlf), Buffer.from([0xfe])]))
    f.setCopy(CLAUDE_COPY, withByte)
    assert.equal(skillCopies(f.root, f.pkg)[0].state, 'stale', 'byte no UTF-8')
    f.setSource(SKILL)
    rmSync(join(f.root, CLAUDE_COPY))
    assert.deepEqual(states(f.root, f.pkg), ['missing', 'ok'])
  } finally {
    f.dispose()
  }
})

test('agents sync sigue escribiendo agentes con LF y copias de la skill iguales a su fuente', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-agents-'))
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-pkg-'))
  const root2 = mkdtempSync(join(tmpdir(), 'sdd-ai-agents-'))
  try {
    syncAgents(root, repo, profiles())
    const worker = readFileSync(join(repo, 'agents', 'worker.md'), 'utf8')
    const src = parseAgentSource(worker)
    for (const role of READ_ONLY_ROLES) {
      const hash = sourceHash(src, profiles()[role])
      const claude = readFileSync(agentFile(root, 'claude', role), 'utf8')
      const codex = readFileSync(agentFile(root, 'codex', role), 'utf8')
      assert.equal(claude, renderClaudeAgent(src, role, profiles()[role].claude, hash), `claude ${role}`)
      assert.equal(codex, renderCodexAgent(src, role, profiles()[role].codex, hash), `codex ${role}`)
      assert.equal(claude.includes('\r') || codex.includes('\r'), false, role)
    }
    const skill = readFileSync(join(repo, 'skills', 'sdd-ai', 'SKILL.md'))
    for (const rel of [CLAUDE_COPY, AGENTS_COPY]) assert.ok(readFileSync(join(root, rel)).equals(skill), rel)

    mkdirSync(join(pkg, 'agents'))
    mkdirSync(join(pkg, 'skills', 'sdd-ai'), { recursive: true })
    writeFileSync(join(pkg, 'agents', 'worker.md'), worker)
    const crlfSkill = Buffer.from(skill.toString('utf8').replace(/\r?\n/g, '\r\n'))
    writeFileSync(join(pkg, 'skills', 'sdd-ai', 'SKILL.md'), crlfSkill)
    copyModSource(pkg)
    syncAgents(root2, pkg, profiles())
    for (const rel of [CLAUDE_COPY, AGENTS_COPY]) assert.ok(readFileSync(join(root2, rel)).equals(crlfSkill), rel)
  } finally {
    for (const dir of [root, pkg, root2]) rmSync(dir, { recursive: true, force: true })
  }
})

test('los helpers individuales conservan estados, orden y errores de las inspecciones agregadas', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-agent-helpers-'))
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-agent-source-'))
  try {
    for (const family of FAMILIES) assert.equal(agentsState(root, pkg, family, 'explore', profiles()), 'missing')
    syncAgents(root, repo, profiles())
    const source = readSource(repo)
    const expected = agentCopies(root, repo, profiles())
    assert.deepEqual(expected, READ_ONLY_ROLES.flatMap((role) => FAMILIES.map((family) => agentCopy(root, family, role, profiles(), source))))
    assert.deepEqual(skillCopies(root, repo), FAMILIES.map((family) => skillCopy(root, family, readSkillSource(repo))))
    const file = agentFile(root, 'claude', 'explore')
    writeFileSync(file, readFileSync(file, 'utf8') + '\neditado')
    assert.equal(agentCopy(root, 'claude', 'explore', profiles(), source).state, 'stale')
    rmSync(file)
    assert.equal(agentCopy(root, 'claude', 'explore', profiles(), () => { throw new Error('fuente no debe leerse') }).state, 'missing')
    mkdirSync(file)
    let read = false
    assert.throws(() => agentCopy(root, 'claude', 'explore', profiles(), () => { read = true; return source }), /EISDIR/)
    assert.equal(read, false, 'la copia se lee antes de obtener la fuente')
    assert.throws(() => agentsState(root, pkg, 'claude', 'explore', profiles()), /EISDIR/)
    assert.throws(() => skillCopies(root, pkg), /ENOENT/, 'la fuente de skill se lee antes de comprobar las copias')
    const skill = join(root, CLAUDE_COPY)
    rmSync(skill); mkdirSync(skill)
    assert.throws(() => skillCopy(root, 'claude', readSkillSource(repo)), /EISDIR/)
    assert.throws(() => skillCopies(root, repo), /EISDIR/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(pkg, { recursive: true, force: true })
  }
})

test('los agentes generados piden reportar hallazgos solo cuando el encargo lo pida y prohíben escribir el registro', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-findings-agents-'))
  try {
    syncAgents(root, repo, profiles())
    for (const role of READ_ONLY_ROLES) for (const family of FAMILIES) {
      const generated = readFileSync(agentFile(root, family, role), 'utf8')
      assert.ok(generated.includes('Reporta hallazgos solo cuando el encargo lo pida'), `${family} ${role}`)
      assert.ok(generated.includes('Nunca escribas hallazgos.md ni respaldos del flujo'), `${family} ${role}`)
      assert.ok(generated.includes('respeta los esquemas cerrados sin añadir claves ni prosa'), `${family} ${role}`)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
