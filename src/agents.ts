import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { type Family, type Profile, READ_ONLY_ROLES, type ReadOnlyRole, SddError } from './types.ts'

export interface AgentSource { description: string; body: string; raw: string }
export type RoleProfiles = Record<ReadOnlyRole, Record<Family, Profile>>

const MARK_TAG = 'generado por sdd-ai desde agents/worker.md'
const MARK = `${MARK_TAG} · no editar a mano · sdd-ai-hash:`

const FAMILIES: readonly Family[] = ['claude', 'codex']
const AGENT_DIRS: Record<Family, string> = { claude: join('.claude', 'agents'), codex: join('.codex', 'agents') }
const AGENT_EXT: Record<Family, string> = { claude: '.md', codex: '.toml' }
// Claude Code descubre skills en .claude/skills; Codex, en .agents/skills del repo.
const SKILL_PATHS = [join('.claude', 'skills', 'sdd-ai', 'SKILL.md'), join('.agents', 'skills', 'sdd-ai', 'SKILL.md')]

export function agentName(role: ReadOnlyRole): string {
  return `sdd-ai-${role}`
}

function agentPath(root: string, family: Family, role: ReadOnlyRole): string {
  return join(root, AGENT_DIRS[family], `${agentName(role)}${AGENT_EXT[family]}`)
}

export function parseAgentSource(text: string): AgentSource {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!m) throw new SddError('agent_source_invalid', 'agents/worker.md no tiene frontmatter')
  const meta = parse(m[1]) as { description?: unknown }
  if (typeof meta?.description !== 'string') {
    throw new SddError('agent_source_invalid', 'agents/worker.md necesita description')
  }
  return { description: meta.description, body: m[2], raw: text }
}

export function sourceHash(src: AgentSource, profiles: Record<Family, Profile>): string {
  const payload = JSON.stringify({
    raw: src.raw,
    claude: { model: profiles.claude.model, effort: profiles.claude.effort },
    codex: { model: profiles.codex.model, effort: profiles.codex.effort },
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

function yamlScalar(v: string): string {
  return /^[\p{L}\p{N} .,()_-]+$/u.test(v) ? v : JSON.stringify(v)
}

function describe(src: AgentSource, role: ReadOnlyRole): string {
  return `${src.description} Rol: ${role}.`
}

export function renderClaudeAgent(src: AgentSource, role: ReadOnlyRole, p: Profile, hash: string): string {
  const lines = ['---', `name: ${yamlScalar(agentName(role))}`, `description: ${yamlScalar(describe(src, role))}`, 'tools: Read, Grep, Glob']
  if (p.model) lines.push(`model: ${yamlScalar(p.model)}`)
  if (p.effort) lines.push(`effort: ${p.effort}`)
  // Acerca el nativo al worker por proceso, que corre con --safe-mode.
  lines.push('omitClaudeMd: true', '---', `<!-- ${MARK} ${hash} -->`, '', '')
  return lines.join('\n') + src.body
}

/**
 * Sin `sandbox_mode`: Codex lo acepta en el archivo del rol pero no lo aplica al subagente, que
 * hereda el sandbox del conductor. Declararlo daría una garantía que no existe.
 */
export function renderCodexAgent(src: AgentSource, role: ReadOnlyRole, p: Profile, hash: string): string {
  if (src.body.includes("'''")) {
    throw new SddError('agent_source_invalid', "el cuerpo de agents/worker.md no puede contener ''' (no entra en un string literal de TOML)")
  }
  const lines = [`# ${MARK} ${hash}`, `name = ${JSON.stringify(agentName(role))}`, `description = ${JSON.stringify(describe(src, role))}`]
  if (p.model) lines.push(`model = ${JSON.stringify(p.model)}`)
  if (p.effort) lines.push(`model_reasoning_effort = ${JSON.stringify(p.effort)}`)
  lines.push(`developer_instructions = '''\n${src.body}'''`, '')
  return lines.join('\n')
}

function render(family: Family, src: AgentSource, role: ReadOnlyRole, profiles: RoleProfiles): string {
  const hash = sourceHash(src, profiles[role])
  const p = profiles[role][family]
  return family === 'claude' ? renderClaudeAgent(src, role, p, hash) : renderCodexAgent(src, role, p, hash)
}

function readSource(pkgDir: string): AgentSource {
  return parseAgentSource(readFileSync(join(pkgDir, 'agents', 'worker.md'), 'utf8'))
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** Borra los agentes que generó sdd-ai y ya no corresponden a ningún rol; reconoce los suyos por la marca. */
function removeLeftovers(root: string, keep: readonly string[]): string[] {
  const removed: string[] = []
  for (const family of FAMILIES) {
    const dir = join(root, AGENT_DIRS[family])
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (!entry.isFile() || keep.includes(file)) continue
      if (readFileSync(file, 'utf8').includes(MARK_TAG)) {
        rmSync(file)
        removed.push(file)
      }
    }
  }
  return removed
}

/** Genera un agente por rol de solo lectura para los dos CLIs, borra los que sobran e instala la skill. */
export function syncAgents(root: string, pkgDir: string, profiles: RoleProfiles): { written: string[]; removed: string[] } {
  const src = readSource(pkgDir)
  const written: string[] = []
  for (const role of READ_ONLY_ROLES) {
    for (const family of FAMILIES) {
      const file = agentPath(root, family, role)
      write(file, render(family, src, role, profiles))
      written.push(file)
    }
  }
  const removed = removeLeftovers(root, written)
  for (const rel of SKILL_PATHS) {
    const dest = join(root, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(pkgDir, 'skills', 'sdd-ai', 'SKILL.md'), dest)
    written.push(dest)
  }
  return { written, removed }
}

/**
 * Vigente solo si el archivo es exactamente lo que generaría `agents sync` hoy: la marca de hash
 * orienta a quien lo lee, pero una edición a mano puede conservarla.
 */
export function agentsState(root: string, pkgDir: string, family: Family, role: ReadOnlyRole, profiles: RoleProfiles): 'ok' | 'stale' | 'missing' {
  const file = agentPath(root, family, role)
  if (!existsSync(file)) return 'missing'
  return readFileSync(file, 'utf8') === render(family, readSource(pkgDir), role, profiles) ? 'ok' : 'stale'
}
