import { copySkillSource, EXPECTED_SKILL_FILES, installedSkillPath, installSkillFixture, installMonolithicSkill, skillBytes, skillLinks, damageSkillFile } from './skill-fixture.ts'
import * as agents from '../src/agents.ts'
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
  copySkillSource(pkg)
  installSkillFixture(root, pkg)
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

const states = (root: string, pkg: string): string[] => skillCopies(root, pkg).filter((c) => c.path.endsWith('/SKILL.md')).map((c) => c.state)

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
    copySkillSource(pkg)
    writeFileSync(join(pkg, 'skills', 'sdd-ai', 'SKILL.md'), crlfSkill)
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
    assert.deepEqual(skillCopies(root, repo).filter((copy) => copy.path.endsWith('/SKILL.md')), FAMILIES.map((family) => skillCopy(root, family, readSkillSource(repo))))
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
    assert.ok(skillCopies(root, pkg).every((copy) => copy.state === 'unchecked' && copy.source_path), 'fuentes ausentes nunca son vigentes')
    const skill = join(root, CLAUDE_COPY)
    rmSync(skill); mkdirSync(skill)
    assert.throws(() => skillCopy(root, 'claude', readSkillSource(repo)), /EISDIR/)
    assert.equal(skillCopies(root, repo)[0].state, 'unchecked')
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


test('agents sync instala y actualiza el conjunto modular en ambas familias', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-modular-sync-'))
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-modular-source-'))
  try {
    copySkillSource(pkg)
    copyModSource(pkg)
    mkdirSync(join(pkg, 'agents'))
    writeFileSync(join(pkg, 'agents/worker.md'), readFileSync(join(repo, 'agents/worker.md')))
    // Cada archivo se leyó antes de generar siquiera el primer agente.
    damageSkillFile(pkg, 'skills/sdd-ai/references/mod.md', 'missing')
    assert.throws(() => syncAgents(root, pkg, profiles()), /references\/mod\.md/)
    assert.deepEqual(agents.skillCopies(root, repo).map((copy) => copy.state), EXPECTED_SKILL_FILES.flatMap(() => ['missing', 'missing']))
    assert.throws(() => readFileSync(agentFile(root, 'claude', 'explore')), /ENOENT/)
    copySkillSource(pkg)
    for (const monolithic of [false, true]) {
      if (monolithic) installMonolithicSkill(root)
      const outside = join(root, '.plans/existing/handoff.md')
      mkdirSync(dirname(outside), { recursive: true })
      writeFileSync(outside, '---\nstatus: implementing\n---\nEstado previo\n')
      for (const family of FAMILIES) {
        const own = join(root, installedSkillPath(family, 'custom.md'))
        mkdirSync(dirname(own), { recursive: true }); writeFileSync(own, 'archivo ajeno')
      }
      const { written } = syncAgents(root, pkg, profiles())
      for (const family of FAMILIES) {
        assert.deepEqual(skillBytes(root, dirname(installedSkillPath(family))), skillBytes(pkg))
        for (const path of EXPECTED_SKILL_FILES) {
          const dest = join(root, installedSkillPath(family, path))
          assert.ok(written.includes(dest), dest)
          if (path !== 'SKILL.md') assert.ok(written.indexOf(dest) < written.indexOf(join(root, installedSkillPath(family))))
          for (const target of skillLinks(path, readFileSync(dest, 'utf8'))) assert.ok(readFileSync(join(root, installedSkillPath(family, target))).length > 0)
        }
        assert.equal(readFileSync(join(root, installedSkillPath(family, 'custom.md')), 'utf8'), 'archivo ajeno')
      }
      assert.equal(readFileSync(outside, 'utf8'), '---\nstatus: implementing\n---\nEstado previo\n')
    }
    // Una escritura parcial no devuelve éxito; la entrada vieja no se reemplaza antes de sus apoyos.
    writeFileSync(join(root, CLAUDE_COPY), 'bootstrap anterior')
    damageSkillFile(root, installedSkillPath('claude', 'references/mod.md'), 'unreadable')
    assert.throws(() => syncAgents(root, pkg, profiles()), /EISDIR/)
    assert.equal(readFileSync(join(root, CLAUDE_COPY), 'utf8'), 'bootstrap anterior')
    rmSync(join(root, installedSkillPath('claude', 'references/mod.md')), { recursive: true })
    syncAgents(root, pkg, profiles())
    assert.ok(skillCopies(root, pkg).every((copy) => copy.state === 'ok'))
    // La interfaz opcional admite el snapshot y copia sus bytes sin releer las fuentes.
    const snapshot = agents.skillInventory(pkg)
    damageSkillFile(pkg, 'skills/sdd-ai/references/mod.md', 'missing')
    syncAgents(root, pkg, profiles(), undefined, snapshot)
    for (const family of FAMILIES) assert.equal(skillBytes(root, dirname(installedSkillPath(family)))['references/mod.md'], snapshot.find((file) => file.path === 'references/mod.md')!.bytes.toString('base64'))
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true }) }
})

test('la vigencia modular distingue cada archivo y tolera solo CRLF y LF', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-ai-modular-copies-'))
  const pkg = mkdtempSync(join(tmpdir(), 'sdd-ai-modular-source-'))
  const targets = ['SKILL.md', 'procedures/implement.md']
  try {
    copySkillSource(pkg)
    installSkillFixture(root, pkg)
    assert.equal(skillCopies(root, pkg).length, EXPECTED_SKILL_FILES.length * 2)
    assert.ok(skillCopies(root, pkg).every((copy) => copy.state === 'ok'))
    for (const family of FAMILIES) for (const target of targets) {
      const path = installedSkillPath(family, target)
      const source = `skills/sdd-ai/${target}`
      const bytes = readFileSync(join(pkg, source))
      const inspect = () => skillCopies(root, pkg).find((copy) => copy.path === path)!
      for (const damage of ['missing', 'stale', 'unreadable'] as const) {
        damageSkillFile(root, path, damage)
        const copy = inspect()
        assert.equal(copy.path, path)
        assert.equal(copy.state, damage === 'unreadable' ? 'unchecked' : damage)
        if (damage === 'unreadable') { assert.match(copy.cause!, /EISDIR/); assert.equal(copy.source_path, undefined) }
        assert.ok(skillCopies(root, pkg).filter((copy) => copy.path !== path).every((copy) => copy.state === 'ok'))
        rmSync(join(root, path), { recursive: true, force: true })
        installSkillFixture(root, pkg)
      }
      for (const damage of ['missing', 'unreadable'] as const) {
        damageSkillFile(pkg, source, damage)
        const affected = skillCopies(root, pkg).filter((copy) => copy.source_path === source)
        assert.equal(affected.length, 2)
        for (const copy of affected) { assert.equal(copy.state, 'unchecked'); assert.match(copy.cause!, damage === 'missing' ? /ENOENT/ : /EISDIR/) }
        assert.ok(skillCopies(root, pkg).filter((copy) => !affected.some((bad) => bad.path === copy.path)).every((copy) => copy.state === 'ok'))
        rmSync(join(pkg, source), { recursive: true, force: true }); writeFileSync(join(pkg, source), bytes)
      }
      const lf = bytes.toString('latin1').replace(/\r\n/g, '\n')
      const crlf = lf.replace(/\n/g, '\r\n')
      writeFileSync(join(root, path), crlf, 'latin1'); assert.equal(inspect().state, 'ok')
      writeFileSync(join(pkg, source), crlf, 'latin1')
      writeFileSync(join(root, path), lf, 'latin1'); assert.equal(inspect().state, 'ok')
      for (const changed of [lf+' ', lf+'\r', lf.replace('a', 'b'), Buffer.concat([Buffer.from(lf, 'latin1'), Buffer.from([0xff])])]) {
        writeFileSync(join(root, path), changed, 'latin1'); assert.equal(inspect().state, 'stale')
      }
      writeFileSync(join(pkg, source), Buffer.concat([bytes, Buffer.from([0xfe])]))
      writeFileSync(join(root, path), Buffer.concat([bytes, Buffer.from([0xff])]))
      assert.equal(inspect().state, 'stale', 'no normaliza bytes no UTF-8')
      writeFileSync(join(pkg, source), bytes); installSkillFixture(root, pkg)
      const selected = skillCopies(root, pkg, [family])
      assert.equal(selected.length, EXPECTED_SKILL_FILES.length)
      assert.ok(selected.every((copy) => copy.path.startsWith(dirname(installedSkillPath(family))+'/')))
    }
    damageSkillFile(pkg, 'skills/sdd-ai/SKILL.md', 'missing')
    damageSkillFile(root, installedSkillPath('claude', 'procedures/verify.md'), 'unreadable')
    const copies = skillCopies(root, pkg)
    assert.equal(copies.find((copy) => copy.path === installedSkillPath('claude', 'procedures/verify.md'))!.state, 'unchecked')
    assert.ok(copies.some((copy) => copy.state === 'ok'), 'otros archivos se siguen comprobando')
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true }) }
})
