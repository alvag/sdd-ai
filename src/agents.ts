import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { type Family, type Profile, SddError } from './types.ts'

export interface AgentSource { name: string; description: string; body: string; raw: string }

const MARK = 'generado por sdd-ai desde agents/worker.md · no editar a mano · sdd-ai-hash:'

const AGENT_PATHS: Record<Family, string> = {
  claude: join('.claude', 'agents', 'sdd-worker.md'),
  codex: join('.codex', 'agents', 'sdd-worker.toml'),
}
// Claude Code descubre skills en .claude/skills; Codex, en .agents/skills del repo.
const SKILL_PATHS = [join('.claude', 'skills', 'sdd-ai', 'SKILL.md'), join('.agents', 'skills', 'sdd-ai', 'SKILL.md')]

export function parseAgentSource(text: string): AgentSource {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!m) throw new SddError('agent_source_invalid', 'agents/worker.md no tiene frontmatter')
  const meta = parse(m[1]) as { name?: unknown; description?: unknown }
  if (typeof meta?.name !== 'string' || typeof meta.description !== 'string') {
    throw new SddError('agent_source_invalid', 'agents/worker.md necesita name y description')
  }
  return { name: meta.name, description: meta.description, body: m[2], raw: text }
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

export function renderClaudeAgent(src: AgentSource, p: Profile, hash: string): string {
  const lines = ['---', `name: ${yamlScalar(src.name)}`, `description: ${yamlScalar(src.description)}`, 'tools: Read, Grep, Glob']
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
export function renderCodexAgent(src: AgentSource, p: Profile, hash: string): string {
  if (src.body.includes("'''")) {
    throw new SddError('agent_source_invalid', "el cuerpo de agents/worker.md no puede contener ''' (no entra en un string literal de TOML)")
  }
  const lines = [`# ${MARK} ${hash}`, `name = ${JSON.stringify(src.name)}`, `description = ${JSON.stringify(src.description)}`]
  if (p.model) lines.push(`model = ${JSON.stringify(p.model)}`)
  if (p.effort) lines.push(`model_reasoning_effort = ${JSON.stringify(p.effort)}`)
  lines.push(`developer_instructions = '''\n${src.body}'''`, '')
  return lines.join('\n')
}

function readSource(pkgDir: string): AgentSource {
  return parseAgentSource(readFileSync(join(pkgDir, 'agents', 'worker.md'), 'utf8'))
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** Genera el agente para los dos CLIs e instala la skill. Devuelve las rutas escritas. */
export function syncAgents(root: string, pkgDir: string, profiles: Record<Family, Profile>): string[] {
  const src = readSource(pkgDir)
  const hash = sourceHash(src, profiles)
  const written: string[] = []
  const claude = join(root, AGENT_PATHS.claude)
  write(claude, renderClaudeAgent(src, profiles.claude, hash))
  written.push(claude)
  const codex = join(root, AGENT_PATHS.codex)
  write(codex, renderCodexAgent(src, profiles.codex, hash))
  written.push(codex)
  for (const rel of SKILL_PATHS) {
    const dest = join(root, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(pkgDir, 'skills', 'sdd-ai', 'SKILL.md'), dest)
    written.push(dest)
  }
  return written
}

/**
 * Vigente solo si el archivo es exactamente lo que generaría `agents sync` hoy: la marca de hash
 * orienta a quien lo lee, pero una edición a mano puede conservarla.
 */
export function agentsState(root: string, pkgDir: string, family: Family, profiles: Record<Family, Profile>): 'ok' | 'stale' | 'missing' {
  const file = join(root, AGENT_PATHS[family])
  if (!existsSync(file)) return 'missing'
  const src = readSource(pkgDir)
  const hash = sourceHash(src, profiles)
  const expected = family === 'claude' ? renderClaudeAgent(src, profiles.claude, hash) : renderCodexAgent(src, profiles.codex, hash)
  return readFileSync(file, 'utf8') === expected ? 'ok' : 'stale'
}
