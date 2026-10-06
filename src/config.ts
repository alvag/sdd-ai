import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parse } from 'yaml'
import { type Family, SddError, isFamily } from './types.ts'

export interface CrossModel { families: Family[]; selection?: string }

export interface BranchConfig { format: string; prefix: string | null }
export const DEFAULT_BRANCH_FORMAT = '{type}/{ticket}-{slug}'

/** `.sdd-ai/config.yml` como mapa; sin archivo, vacío. Un YAML ilegible o que no es un mapa lanza `config_invalid`. */
export function readConfigMap(root: string): Record<string, unknown> {
  try {
    const doc: unknown = parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    if (doc === null || doc === undefined) return {}
    if (!isRecord(doc)) throw new Error('el archivo tiene que ser un mapa')
    return doc
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new SddError('config_invalid', `${CONFIG_PATH}: ${(e as Error).message}`)
  }
}

function branchText(doc: Record<string, unknown>, key: string, allowEmpty: boolean): string | null {
  const value = doc[key]
  if (value === undefined) return null
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new SddError('config_invalid', `${CONFIG_PATH}: ${key} tiene que ser texto${allowEmpty ? '' : ' no vacío'}, no ${JSON.stringify(value)}`)
  }
  return value.trim() || null
}

export function loadBranchConfig(root: string): BranchConfig {
  const doc = readConfigMap(root)
  const format = branchText(doc, 'branch_format', false) ?? DEFAULT_BRANCH_FORMAT
  if ([...format.matchAll(/\{([^{}]*)\}/g)].some((m) => !['type', 'ticket', 'slug'].includes(m[1])) || /[{}]/.test(format.replace(/\{(type|ticket|slug)\}/g, ''))) {
    throw new SddError('config_invalid', `${CONFIG_PATH}: branch_format tiene placeholders desconocidos: ${JSON.stringify(format)}`)
  }
  return { format, prefix: branchText(doc, 'branch_prefix', true) }
}

export function loadDefaultBranch(root: string): string | null {
  return branchText(readConfigMap(root), 'default_branch', false)
}

// Ruta del repo con `/`, como sale en los mensajes; para el sistema de archivos se resuelve con join(root, CONFIG_PATH).
const CONFIG_PATH = '.sdd-ai/config.yml'

function suggestBlock(present: Family[]): string {
  const families = present.length > 0 ? present : (['claude', 'codex'] as Family[])
  return [
    `crea ${CONFIG_PATH} con este bloque (ajusta families a las familias que quieras usar como workers):`,
    '',
    'cross_model:',
    '  schema_version: 1',
    `  families: [${families.join(', ')}]`,
    '  selection: full',
  ].join('\n')
}

function missing(detail: string, present: Family[]): SddError {
  return new SddError('config_missing', `falta el bloque cross_model en ${CONFIG_PATH}`, {
    detail,
    next: suggestBlock(present),
  })
}

/** Valida una lista de familias con el dominio de sdd-flow: no vacía, sin duplicados, sin case. */
function validateFamilies(value: unknown, code: string, where: string): Family[] {
  if (!Array.isArray(value)) {
    throw new SddError(code, `${where}: families tiene que ser una lista, no ${JSON.stringify(value)}`)
  }
  if (value.length === 0) throw new SddError(code, `${where}: families no puede estar vacía`)
  const out: Family[] = []
  for (const raw of value) {
    const f = typeof raw === 'string' ? raw.toLowerCase() : raw
    if (!isFamily(f)) throw new SddError(code, `${where}: familia desconocida ${JSON.stringify(raw)}; solo claude | codex`)
    if (out.includes(f)) throw new SddError(code, `${where}: familia duplicada ${JSON.stringify(raw)}`)
    out.push(f)
  }
  return out
}

export function parseCrossModel(doc: unknown, present: Family[] = []): CrossModel {
  const block = (doc as { cross_model?: unknown } | null)?.cross_model
  if (block === undefined || block === null) throw missing('el archivo no tiene cross_model', present)
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new SddError('config_invalid', `${CONFIG_PATH}: cross_model tiene que ser un mapa`)
  }
  const b = block as Record<string, unknown>
  if (b.schema_version !== 1) {
    throw missing(`schema_version desconocida: ${JSON.stringify(b.schema_version)}; el bloque se ignora entero`, present)
  }
  const families = validateFamilies(b.families, 'config_invalid', CONFIG_PATH)
  const result: CrossModel = { families }
  if (typeof b.selection === 'string') result.selection = b.selection
  return result
}

/** Lee la config del repo. Solo lee: nunca crea ni modifica el archivo. */
export function loadCrossModel(root: string, present: Family[] = []): CrossModel {
  let text: string
  try {
    text = readFileSync(join(root, CONFIG_PATH), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw missing(`no existe ${CONFIG_PATH}`, present)
    throw e
  }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new SddError('config_invalid', `${CONFIG_PATH}: YAML ilegible`, { detail: (e as Error).message })
  }
  return parseCrossModel(doc, present)
}

/** El modo de la aprobación externa de la spec; `invalid` dice qué está mal y dónde. */
export type JiraMode = { mode: 'on' | 'off' } | { mode: 'invalid'; detail: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Sin bloque o sin `mode` es `off`: la forma de sdd-flow, donde el default es `off`. */
export function parseJiraMode(doc: unknown): JiraMode {
  if (doc === null || doc === undefined) return { mode: 'off' }
  if (!isRecord(doc)) return { mode: 'invalid', detail: `${CONFIG_PATH}: el archivo tiene que ser un mapa` }
  const block = doc.jira_approval
  if (block === undefined || block === null) return { mode: 'off' }
  if (!isRecord(block)) return { mode: 'invalid', detail: `${CONFIG_PATH}: jira_approval tiene que ser un mapa, no ${JSON.stringify(block)}` }
  const mode = block.mode
  if (mode === undefined || mode === null) return { mode: 'off' }
  if (mode === 'on' || mode === 'off') return { mode }
  return { mode: 'invalid', detail: `${CONFIG_PATH}: jira_approval.mode tiene que ser "on" u "off", no ${JSON.stringify(mode)}` }
}

/**
 * El modo de Jira de la config del repo. Sin archivo es `off`; un archivo que existe y no se puede leer
 * o parsear es `invalid`, para que nadie decida con una config rota. Solo lee.
 */
export function loadJiraMode(root: string): JiraMode {
  let text: string
  try {
    text = readFileSync(join(root, CONFIG_PATH), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'off' }
    return { mode: 'invalid', detail: `${CONFIG_PATH} no se puede leer: ${(e as Error).message}` }
  }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    return { mode: 'invalid', detail: `${CONFIG_PATH}: YAML ilegible (${(e as Error).message.split('\n')[0]})` }
  }
  return parseJiraMode(doc)
}

export type VaultPath = { kind: 'none' } | { kind: 'path'; path: string } | { kind: 'invalid'; detail: string }

/** Solo lee la ruta declarada: no descubre ni configura un vault. */
export function loadVaultPath(root: string): VaultPath {
  try {
    const doc: unknown = parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    if (doc === null || doc === undefined) return { kind: 'none' }
    if (!isRecord(doc)) return { kind: 'invalid', detail: `${CONFIG_PATH}: el archivo tiene que ser un mapa` }
    const block = doc['knowledge-vault']
    if (block === undefined || block === null) return { kind: 'none' }
    if (!isRecord(block)) return { kind: 'invalid', detail: `${CONFIG_PATH}: knowledge-vault tiene que ser un mapa` }
    const value = block.path_vault
    if (value === undefined) return { kind: 'none' }
    if (typeof value !== 'string' || !value.trim()) {
      return { kind: 'invalid', detail: `${CONFIG_PATH}: knowledge-vault.path_vault tiene que ser una cadena no vacía` }
    }
    return { kind: 'path', path: resolve(root, value.startsWith('~/') ? join(homedir(), value.slice(2)) : value) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }
    return { kind: 'invalid', detail: `${CONFIG_PATH} no se puede leer: ${(e as Error).message.split('\n')[0]}` }
  }
}

export function parseFamiliesFlag(v: string): Family[] {
  return validateFamilies(v.split(',').map((s) => s.trim()), 'usage', '--families')
}

/** El override de la corrida reemplaza entera la lista del config. */
export function effectiveFamilies(config: Family[], flag?: Family[]): Family[] {
  return flag ?? config
}
