import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { loadBranchConfig, loadCrossModel, loadDefaultBranch, loadJiraMode, loadVaultPath } from './config.ts'
import { gitDirs, mainWorktree } from './git.ts'
import { parseWorkers } from './profiles.ts'
import { SddError } from './types.ts'

export const CONFIG_FILES = ['.gitignore', 'workers.yml', 'config.yml'] as const
type ConfigFile = typeof CONFIG_FILES[number]
export interface WorktreeConfigDeps {
  gitDirs(root: string): { gitDir: string; commonDir: string }
  mainWorktree(root: string): string | undefined
  lstat(path: string): Stats
  readFile(path: string): string
  mkdir(path: string): void
  copyFile(source: string, destination: string, flags: number): void
}
const DEFAULT_DEPS: WorktreeConfigDeps = {
  gitDirs, mainWorktree, lstat: lstatSync, readFile: (path) => readFileSync(path, 'utf8'),
  mkdir: mkdirSync, copyFile: copyFileSync,
}
export interface WorktreeConfigResult {
  state: 'copied' | 'unchanged' | 'blocked' | 'partial'
  root: string
  source: string | null
  copied: ConfigFile[]
  preserved: ConfigFile[]
  pending: ConfigFile[]
  errors: Array<{ code: string; path: string; message: string; entry_exists?: boolean | null }>
}
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code

/** Copia literal y exclusiva; no prepara agentes ni lee o adopta estado de corridas. */
export function reuseWorktreeConfig(root: string, overrides: Partial<WorktreeConfigDeps> = {}): WorktreeConfigResult {
  const io = { ...DEFAULT_DEPS, ...overrides }
  const result: WorktreeConfigResult = { state: 'blocked', root, source: null, copied: [], preserved: [], pending: [], errors: [] }
  const local = join(root, '.sdd-ai')
  const fail = (code: string, path: string, e: unknown, entry_exists?: boolean | null) => {
    const detail = e instanceof SddError ? [e.message, e.detail].filter(Boolean).join(': ') : e instanceof Error ? e.message : String(e)
    result.errors.push({ code, path, message: `${path}: ${detail}`,
      ...(entry_exists === undefined ? {} : { entry_exists }) })
  }
  const entry = (path: string): Stats | undefined => {
    try { return io.lstat(path) } catch (e) { if (errno(e) === 'ENOENT') return undefined; throw e }
  }
  const directory = (path: string, optional = false) => {
    const stat = entry(path)
    if (!stat && optional) return false
    if (!stat) throw new Error('no existe el directorio requerido')
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('se requiere un directorio real, sin enlaces')
    return true
  }
  const regular = (path: string, required = false) => {
    const stat = entry(path)
    if (!stat && !required) return false
    if (!stat) throw new Error('no existe el archivo requerido')
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('se requiere un archivo regular, sin enlaces')
    return true
  }
  const validate = (base: string, name: ConfigFile) => {
    const path = join(base, '.sdd-ai', name)
    const text = io.readFile(path)
    if (name === 'workers.yml') parseWorkers(text, path)
    if (name === 'config.yml') {
      // Los loaders solo aceptan o rechazan: no se serializa ni normaliza el texto leído.
      loadCrossModel(base)
      loadBranchConfig(base)
      loadDefaultBranch(base)
      const jira = loadJiraMode(base)
      if (jira.mode === 'invalid') throw new Error(jira.detail)
      const vault = loadVaultPath(base)
      if (vault.kind === 'invalid') throw new Error(vault.detail)
    }
  }
  const pending = () => {
    result.pending = []
    // No atravesar un directorio sustituido por un enlace al calcular el reporte.
    try {
      const exists = directory(local, true)
      for (const name of CONFIG_FILES) if (!exists || !entry(join(local, name))) result.pending.push(name)
    } catch (e) {
      // Un destino ya rechazado no suma un segundo error por la misma causa.
      if (!result.errors.some((error) => error.path === local)) fail('destination_unreadable', local, e)
      result.state = result.copied.length ? 'partial' : 'blocked'
    }
  }
  let path = root
  let phase = 'git_identification_failed'
  try {
    const dirs = io.gitDirs(root)
    if (dirs.gitDir === dirs.commonDir) throw new Error('la reutilización requiere un worktree enlazado')
    phase = 'destination_invalid'
    path = local
    const localExists = directory(local, true)
    const present = new Set<ConfigFile>()
    for (const name of CONFIG_FILES) {
      path = join(local, name)
      if (localExists && regular(path)) { present.add(name); result.preserved.push(name) }
    }
    if (present.has('config.yml')) {
      path = join(local, 'config.yml')
      validate(root, 'config.yml')
      if (present.has('workers.yml')) { path = join(local, 'workers.yml'); validate(root, 'workers.yml') }
      result.state = 'unchanged'
      pending()
      return result
    }
    if (present.has('workers.yml')) { path = join(local, 'workers.yml'); validate(root, 'workers.yml') }
    phase = 'source_unavailable'
    path = root
    const source = io.mainWorktree(root)
    if (!source || source === root) throw new Error('Git no identificó un checkout principal utilizable')
    result.source = source
    path = source
    directory(source)
    path = join(source, '.sdd-ai')
    directory(path)
    for (const name of CONFIG_FILES) {
      path = join(source, '.sdd-ai', name)
      phase = 'source_invalid'
      regular(path, true)
      validate(source, name)
    }
    phase = 'copy_failed'
    path = local
    if (!localExists) {
      try { io.mkdir(local) } catch (e) { if (errno(e) !== 'EEXIST') throw e }
    }
    for (const name of CONFIG_FILES) {
      if (present.has(name)) continue
      path = join(source, '.sdd-ai')
      directory(path)
      path = local
      directory(path)
      path = join(local, name)
      try {
        io.copyFile(join(source, '.sdd-ai', name), path, constants.COPYFILE_EXCL)
        result.copied.push(name)
      } catch (e) {
        // La copia solo crea archivos regulares: un directorio o un enlace en el destino apareció durante la
        // copia aunque el sistema no responda EEXIST (Windows informa EPERM ante un directorio).
        const appeared = entry(path)
        if (errno(e) !== 'EEXIST' && !(appeared?.isDirectory() || appeared?.isSymbolicLink())) throw e
        // Un destino aparecido durante la copia se conserva y se juzga como entrada local.
        if (appeared) result.preserved.push(name)
        regular(path, true)
        validate(root, name)
      }
    }
    result.state = 'copied'
  } catch (e) {
    let exists: boolean | null | undefined
    if (phase === 'copy_failed') {
      try { directory(local); exists = !!entry(path) } catch { exists = null }
    }
    fail(phase, path, e, exists)
    result.state = result.copied.length ? 'partial' : 'blocked'
  }
  pending()
  return result
}
