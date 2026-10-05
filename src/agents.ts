import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { type ModFile, assertModCopyInside, modInventory, syncModCopy } from './mod-copies.ts'
import { type Family, type Profile, READ_ONLY_ROLES, type ReadOnlyRole, SddError, WEB_ROLES } from './types.ts'

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

export function parseAgentSource(crlfText: string): AgentSource {
  // Un checkout de Windows con core.autocrlf trae la fuente con CRLF. Se lleva a LF para que los
  // agentes generados y su hash sean los mismos en cualquier sistema.
  const text = crlfText.replace(/\r\n/g, '\n')
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
  const tools = WEB_ROLES.has(role) ? 'Read, Grep, Glob, WebFetch, WebSearch' : 'Read, Grep, Glob'
  const lines = ['---', `name: ${yamlScalar(agentName(role))}`, `description: ${yamlScalar(describe(src, role))}`, `tools: ${tools}`]
  if (p.model) lines.push(`model: ${yamlScalar(p.model)}`)
  if (p.effort) lines.push(`effort: ${p.effort}`)
  // Acerca el nativo al worker por proceso, que corre con --safe-mode.
  lines.push('omitClaudeMd: true', '---', `<!-- ${MARK} ${hash} -->`, '', '')
  return lines.join('\n') + src.body
}

const NO_WEB_RULE = 'No busques en la web ni consultes otras fuentes externas: trabaja solo con el encargo y el repositorio.'

/**
 * Sin `sandbox_mode` ni `web_search`: Codex los acepta en el archivo del rol pero no los aplica al
 * subagente, que hereda el sandbox y la búsqueda web del conductor. Declararlos daría una garantía que
 * no existe. Por eso, en los roles sin web, la búsqueda se apaga con una regla al final de las
 * instrucciones; en Claude no hace falta, porque la lista `tools:` ya la deja afuera.
 */
export function renderCodexAgent(src: AgentSource, role: ReadOnlyRole, p: Profile, hash: string): string {
  if (src.body.includes("'''")) {
    throw new SddError('agent_source_invalid', "el cuerpo de agents/worker.md no puede contener ''' (no entra en un string literal de TOML)")
  }
  const lines = [`# ${MARK} ${hash}`, `name = ${JSON.stringify(agentName(role))}`, `description = ${JSON.stringify(describe(src, role))}`]
  if (p.model) lines.push(`model = ${JSON.stringify(p.model)}`)
  if (p.effort) lines.push(`model_reasoning_effort = ${JSON.stringify(p.effort)}`)
  const body = WEB_ROLES.has(role) ? src.body : `${src.body}\n${NO_WEB_RULE}\n`
  lines.push(`developer_instructions = '''\n${body}'''`, '')
  return lines.join('\n')
}

function render(family: Family, src: AgentSource, role: ReadOnlyRole, profiles: RoleProfiles): string {
  const hash = sourceHash(src, profiles[role])
  const p = profiles[role][family]
  return family === 'claude' ? renderClaudeAgent(src, role, p, hash) : renderCodexAgent(src, role, p, hash)
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function readSource(pkgDir: string): AgentSource {
  return parseAgentSource(readFileSync(join(pkgDir, 'agents', 'worker.md'), 'utf8'))
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** Los agentes que generó sdd-ai y ya no corresponden a ningún rol; reconoce los suyos por la marca. */
export function leftoverAgents(root: string): string[] {
  const keep = READ_ONLY_ROLES.flatMap((role) => FAMILIES.map((family) => agentPath(root, family, role)))
  const out: string[] = []
  for (const family of FAMILIES) {
    const dir = join(root, AGENT_DIRS[family])
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isFile() && !keep.includes(file) && readFileSync(file, 'utf8').includes(MARK_TAG)) out.push(file)
    }
  }
  return out
}

/** Borra los agentes que sobran: los que `leftoverAgents` reconoce como generados y sin rol. */
function removeLeftovers(root: string): string[] {
  const removed = leftoverAgents(root)
  for (const file of removed) rmSync(file)
  return removed
}

/**
 * Genera un agente por rol de solo lectura para los dos CLIs, borra los que sobran e instala la skill y la copia del mod.
 * `inventory` es el del mod que ya leyó quien llama (init, el mismo de su digest); sin él, se lee de `pkgDir`.
 */
export function syncAgents(root: string, pkgDir: string, profiles: RoleProfiles, inventory: readonly ModFile[] = modInventory(pkgDir)): { written: string[]; removed: string[] } {
  const src = readSource(pkgDir)
  // Antes de escribir nada: la copia del mod no puede salir del checkout.
  assertModCopyInside(root)
  const written: string[] = []
  for (const role of READ_ONLY_ROLES) {
    for (const family of FAMILIES) {
      const file = agentPath(root, family, role)
      write(file, render(family, src, role, profiles))
      written.push(file)
    }
  }
  const removed = removeLeftovers(root)
  for (const rel of SKILL_PATHS) {
    const dest = join(root, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(pkgDir, 'skills', 'sdd-ai', 'SKILL.md'), dest)
    written.push(dest)
  }
  const mod = syncModCopy(root, inventory)
  return { written: [...written, ...mod.written], removed: [...removed, ...mod.removed] }
}

/** Una copia instalada de la skill, con su ruta relativa a la raíz del repo. */
export interface SkillCopy { path: string; state: 'ok' | 'stale' | 'missing' }

/**
 * Cada copia de la skill frente a su fuente, byte a byte salvo el fin de línea (un checkout de Windows
 * con `core.autocrlf` trae CRLF): el conductor lee la copia, así que una fuente editada sin
 * `agents sync` deja al conductor con la versión anterior.
 * Se lee en `latin1` para que cada byte sea un carácter y la comparación siga siendo exacta.
 */
export function skillCopies(root: string, pkgDir: string): SkillCopy[] {
  const source = toLf(readFileSync(join(pkgDir, 'skills', 'sdd-ai', 'SKILL.md'), 'latin1'))
  return SKILL_PATHS.map((path): SkillCopy => {
    const file = join(root, path)
    if (!existsSync(file)) return { path, state: 'missing' }
    return { path, state: toLf(readFileSync(file, 'latin1')) === source ? 'ok' : 'stale' }
  })
}

/**
 * Vigente solo si el archivo es exactamente lo que generaría `agents sync` hoy: la marca de hash
 * orienta a quien lo lee, pero una edición a mano puede conservarla. Se ignora la diferencia entre
 * CRLF y LF, porque un checkout de Windows con `core.autocrlf` trae los agentes con CRLF.
 */
export function agentsState(root: string, pkgDir: string, family: Family, role: ReadOnlyRole, profiles: RoleProfiles): 'ok' | 'stale' | 'missing' {
  const file = agentPath(root, family, role)
  if (!existsSync(file)) return 'missing'
  return toLf(readFileSync(file, 'utf8')) === render(family, readSource(pkgDir), role, profiles) ? 'ok' : 'stale'
}
