import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { type Family, type Profile, RETIRED_ROLES, type Role, ROLES, SddError, isFamily, isNativeEffort } from './types.ts'

export type PortableEffort = 'bajo' | 'medio' | 'alto' | 'muy_alto' | 'maximo'
export interface FamilyProfile { model?: string; effort?: PortableEffort | 'heredado' }
export interface WorkersFile { roles: Partial<Record<Role, Partial<Record<Family, FamilyProfile>>>> }

/** Perfiles que escribe init; la resolución normal nunca los usa como relleno. */
export const DEFAULT_PROFILES: Readonly<Record<Role, Record<Family, { model: string; effort: PortableEffort }>>> = {
  explore: { claude: { model: 'sonnet', effort: 'alto' }, codex: { model: 'gpt-6-luna', effort: 'alto' } },
  'counter-plan': { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  investigate: { claude: { model: 'opus', effort: 'muy_alto' }, codex: { model: 'gpt-6.1-sol', effort: 'muy_alto' } },
  debate: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  'design-review': { claude: { model: 'opus', effort: 'muy_alto' }, codex: { model: 'gpt-6.1-sol', effort: 'muy_alto' } },
  implement: { claude: { model: 'sonnet', effort: 'medio' }, codex: { model: 'gpt-6.1-sol', effort: 'medio' } },
  refute: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  'code-review': { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  specify: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  plan: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  tasks: { claude: { model: 'sonnet', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
}

const PORTABLE: readonly string[] = ['bajo', 'medio', 'alto', 'muy_alto', 'maximo']
const WORKERS_PATH = join('.sdd-ai', 'workers.yml')

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function invalid(path: string, what: string, next: string): SddError {
  return new SddError('workers_invalid', `${path}: ${what}`, { next })
}

function onlyKeys(map: Record<string, unknown>, allowed: readonly string[], path: string, where: string) {
  for (const k of Object.keys(map)) {
    if (!allowed.includes(k)) {
      throw invalid(path, `clave no admitida ${JSON.stringify(k)} en ${where}`, `las claves admitidas ahí son: ${allowed.join(', ')}`)
    }
  }
}

/** Valida workers.yml con el esquema de sdd-flow: listas cerradas en cada nivel y sin claves duplicadas. */
export function parseWorkers(text: string, path: string): WorkersFile {
  let doc: unknown
  try {
    doc = parse(text, { uniqueKeys: true })
  } catch (e) {
    throw invalid(path, 'YAML ilegible o con claves duplicadas', (e as Error).message)
  }
  if (!isMap(doc)) throw invalid(path, 'el archivo tiene que ser un mapa', 'empieza con schema_version: 1 y roles:')
  onlyKeys(doc, ['schema_version', 'roles'], path, 'la raíz')
  if (doc.schema_version !== 1) {
    throw invalid(path, `schema_version ${JSON.stringify(doc.schema_version)} no admitida`, 'usa schema_version: 1')
  }

  const roles: WorkersFile['roles'] = {}
  if (doc.roles === undefined) return { roles }
  if (!isMap(doc.roles)) throw invalid(path, 'roles tiene que ser un mapa', 'roles: { explore: { claude: { model, effort } } }')
  for (const key of Object.keys(doc.roles)) {
    const renamed = RETIRED_ROLES.get(key)
    if (renamed) throw invalid(path, `el rol \`${key}\` ahora se llama \`${renamed}\``, `renombra la clave ${key}: a ${renamed}:`)
  }
  onlyKeys(doc.roles, ROLES, path, 'roles')

  for (const [role, families] of Object.entries(doc.roles)) {
    if (!isMap(families)) throw invalid(path, `roles.${role} tiene que ser un mapa`, 'bajo cada rol van claude y/o codex')
    const byFamily: Partial<Record<Family, FamilyProfile>> = {}
    for (const [family, profile] of Object.entries(families)) {
      if (!isFamily(family)) {
        throw invalid(path, `familia desconocida ${JSON.stringify(family)} en roles.${role}`, 'las familias admitidas son: claude, codex')
      }
      if (!isMap(profile)) throw invalid(path, `roles.${role}.${family} tiene que ser un mapa`, 'con model y/o effort')
      onlyKeys(profile, ['model', 'effort'], path, `roles.${role}.${family}`)
      const out: FamilyProfile = {}
      if ('model' in profile) {
        const m = profile.model
        if (typeof m !== 'string' || m.trim() === '') {
          throw invalid(path, `model inválido ${JSON.stringify(m)} en roles.${role}.${family}`, 'usa un nombre de modelo no vacío o heredado')
        }
        out.model = m
      }
      if ('effort' in profile) {
        const ef = profile.effort
        if (typeof ef !== 'string' || (ef !== 'heredado' && !PORTABLE.includes(ef))) {
          throw invalid(path, `effort inválido ${JSON.stringify(ef)} en roles.${role}.${family}`, `usa ${PORTABLE.join(' | ')} o heredado`)
        }
        out.effort = ef as FamilyProfile['effort']
      }
      byFamily[family] = out
    }
    roles[role as Role] = byFamily
  }
  return { roles }
}

/** Lee `.sdd-ai/workers.yml` del repo; `null` si no existe. */
export function loadWorkers(root: string): WorkersFile | null {
  const path = join(root, WORKERS_PATH)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  return parseWorkers(text, path)
}

/**
 * Modelo y esfuerzo de la raíz de un config.toml de Codex: solo las asignaciones anteriores a la
 * primera tabla, con comillas dobles y una única ocurrencia. Una clave dentro de una tabla aplica a
 * otro contexto, así que ante cualquier duda es preferible el default del CLI.
 */
export function readCodexRoot(text: string): Profile {
  const lines = text.split('\n')
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l))
  const root = firstTable === -1 ? lines : lines.slice(0, firstTable)
  const read = (key: string) => {
    const re = new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`)
    const hits = root.map((l) => re.exec(l)).filter((m) => m !== null)
    return hits.length === 1 ? hits[0][1] : undefined
  }
  const out: Profile = {}
  const model = read('model')
  if (model) out.model = model
  const effort = read('model_reasoning_effort')
  if (isNativeEffort(effort)) out.effort = effort
  return out
}

export function loadCodexRoot(env: Record<string, string | undefined>): Profile {
  const home = env.CODEX_HOME || join(homedir(), '.codex')
  try {
    return readCodexRoot(readFileSync(join(home, 'config.toml'), 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}

export interface CodexCatalog { slugs: Set<string>; clientVersion: string | null; descriptions: Map<string, string> }

/** Catálogo local de Codex, incluidos los modelos ocultos, con descripciones y versión del cliente; su ausencia no es un error. */
export function loadCodexCatalog(env: Record<string, string | undefined>): CodexCatalog | null {
  const home = env.CODEX_HOME || join(homedir(), '.codex')
  try {
    const value: unknown = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'))
    if (typeof value !== 'object' || value === null || !Array.isArray((value as { models?: unknown }).models)) return null
    const data = value as { models: unknown[]; client_version?: unknown }
    const slugs = new Set<string>()
    const descriptions = new Map<string, string>()
    for (const m of data.models) {
      if (typeof m !== 'object' || m === null) continue
      const model = m as { slug?: unknown; description?: unknown }
      if (typeof model.slug !== 'string') continue
      slugs.add(model.slug)
      if (typeof model.description === 'string') descriptions.set(model.slug, model.description)
    }
    return { slugs, clientVersion: typeof data.client_version === 'string' ? data.client_version : null, descriptions }
  } catch {
    return null
  }
}
