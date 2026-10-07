import { join } from 'node:path'
import { type AgentSource, type RoleProfiles, agentCopy, agentRelPath, readSource, readSkillSource, renderAgent, skillCopy, skillRelPath } from './agents.ts'
import { MOD_ADOPTION_MESSAGE, MOD_PATH, modCopy, modInventory } from './mod-copies.ts'
import { MOD_SYNC_COMMAND } from './mod-engine.ts'
import { WORKERS_PATH, codexHome, loadCodexRoot, loadWorkers } from './profiles.ts'
import { nativeProfiles } from './resolve.ts'
import { type Family, READ_ONLY_ROLES } from './types.ts'

export const SESSION_SYNC_HEADER = 'Copias de sdd-ai en este worktree: requieren atención.'
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
// Comillas del shell: las rutas del paquete y del worktree pueden contener espacios o apóstrofes.
const quote = (path: string): string => "'" + path.replace(/'/g, "'\\''") + "'"

/**
 * La configuración de perfiles que falla al leerse sola, o `null` si ninguna falla por separado: el aviso
 * nombra un archivo solo cuando lo comprobó, y si no, usa el rótulo neutral.
 */
function failingProfileConfig(root: string, env: Record<string, string | undefined>): string | null {
  try { loadWorkers(root) } catch { return join(root, WORKERS_PATH) }
  try { loadCodexRoot(env) } catch { return join(codexHome(env), 'config.toml') }
  return null
}

interface Incident { path: string; state: 'missing' | 'stale' | 'unchecked'; cause?: string }

/** Solo lectura, con la raíz ya resuelta por quien llama. */
// inspectMod es una costura de prueba para inyectar un fallo de lectura de la copia (V9).
export function renderSessionSync(
  root: string, pkgDir: string, cli: Family, env: Record<string, string | undefined>,
  inspectMod: typeof modCopy = modCopy,
): string {
  const copies: Incident[] = []
  const problems: string[] = []
  const actions = new Set<string>()
  const sourceFailure = (path: string, error: unknown) => {
    problems.push(`- ${path}: no se pudo leer (${errorText(error)})`)
    actions.add(`Restaurar la fuente: git -C ${quote(pkgDir)} checkout -- ${path}`)
  }
  const inspectCopy = (path: string, inspect: () => { state: 'ok' | 'missing' | 'stale' }) => {
    try {
      const result = inspect()
      if (result.state !== 'ok') copies.push({ path, state: result.state })
    } catch (error) {
      copies.push({ path, state: 'unchecked', cause: errorText(error) })
      actions.add(`Revisar o quitar la copia ${path} en ${root}, porque agents sync podría no poder reemplazarla.`)
    }
  }

  try {
    const inventory = modInventory(pkgDir)
    if (cli === 'claude') inspectCopy(MOD_PATH, () => inspectMod(root, inventory))
  } catch (error) {
    sourceFailure('mods/sdd-ai', error)
    if (cli === 'claude') copies.push({ path: MOD_PATH, state: 'unchecked', cause: 'depende de mods/sdd-ai' })
  }

  let profiles: RoleProfiles | undefined
  try { profiles = nativeProfiles(root, env) } catch (error) {
    // El error de lectura no siempre nombra el archivo: se nombra solo la configuración que falla sola.
    const config = failingProfileConfig(root, env)
    problems.push(`- perfiles de los workers: inválidos${config ? ` en ${config}` : ''} (${errorText(error)})`)
    actions.add(`Corregir la configuración ${config ?? 'de los perfiles'} según el error: ${errorText(error)}`)
  }
  let source: AgentSource | undefined
  let sessionSourceValid = false
  try {
    source = readSource(pkgDir)
    if (profiles) {
      // Validar ambas familias: la recuperación con agents sync genera las dos.
      const failures: unknown[] = []
      for (const family of ['claude', 'codex'] as const) {
        try {
          for (const role of READ_ONLY_ROLES) renderAgent(family, source, role, profiles)
          if (family === cli) sessionSourceValid = true
        } catch (error) { failures.push(error) }
      }
      if (failures.length) sourceFailure('agents/worker.md', failures[0])
    }
  } catch (error) { sourceFailure('agents/worker.md', error) }
  for (const role of READ_ONLY_ROLES) {
    const path = agentRelPath(cli, role)
    if (!profiles || !source || !sessionSourceValid) {
      copies.push({ path, state: 'unchecked', cause: !profiles ? 'depende de los perfiles' : 'depende de agents/worker.md' })
    } else {
      const validSource = source
      const validProfiles = profiles
      inspectCopy(path, () => agentCopy(root, cli, role, validProfiles, validSource))
    }
  }

  const skillPath = skillRelPath(cli)
  try {
    const skillSource = readSkillSource(pkgDir)
    inspectCopy(skillPath, () => skillCopy(root, cli, skillSource))
  } catch (error) {
    sourceFailure('skills/sdd-ai/SKILL.md', error)
    copies.push({ path: skillPath, state: 'unchecked', cause: 'depende de skills/sdd-ai/SKILL.md' })
  }

  if (!copies.length && !problems.length) return ''
  const lines = [SESSION_SYNC_HEADER,
    ...copies.map((copy) => `- ${copy.path}: ${copy.state === 'missing' ? 'ausente' : copy.state === 'stale' ? 'desactualizada' : `no se pudo comprobar (${copy.cause})`}`),
    ...problems,
    'Conductor: comunica este aviso y todas las acciones al usuario y espera su decisión antes de sincronizar, restaurar fuentes, quitar copias o corregir configuración; no las apliques por tu cuenta.',
  ]
  if (actions.size) lines.push('Acciones previas:', ...[...actions].map((action) => `- ${action}`))
  if (copies.length) {
    // "Después de las acciones previas" solo si las hay: sin ellas, la frase confunde (repro de AC-11).
    const sync = `ejecutar en el worktree afectado: cd ${quote(root)} && ${MOD_SYNC_COMMAND}`
    lines.push(actions.size ? `Después de las acciones previas, ${sync}` : `Para recuperar las copias, ${sync}`)
    if (cli === 'codex') lines.push('Para adoptar las copias en Codex, abrir una sesión nueva.')
    else {
      if (copies.some((copy) => copy.path === MOD_PATH)) lines.push(MOD_ADOPTION_MESSAGE)
      if (copies.some((copy) => copy.path !== MOD_PATH)) {
        lines.push('Para adoptar los agentes o la skill en Claude Code, abrir una sesión nueva; no está comprobado que /reload-plugins los cargue.')
      }
    }
  }
  return lines.join('\n')
}
