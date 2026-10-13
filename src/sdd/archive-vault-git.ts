import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { realpathSync, readdirSync } from 'node:fs'
import { SddError } from '../types.ts'
import { archiveHash, archiveStat, readArchiveFile, type ArchiveFaultInjector } from './archive-tree.ts'
import { createArchiveDirectory } from './durable.ts'

export interface VaultGitFile { path: string; sha256: string; size: number }
export interface VaultStagedEntry { path: string; previous: string | null; written: string | null }
export interface VaultCommitProgress {
  staged_entries?: VaultStagedEntry[]
  staging_intent?: boolean
  commit_intent?: { parent: string | null; tree: string; message: string }
  commit_sha?: string
}

// Mismo tope que las consultas Git de recall; el buffer cubre el listado del índice de un vault grande.
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 256 * 1024 * 1024

function query(root: string, args: string[], input?: string): { status: number; bytes: Buffer } {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1' }
  // Un runner puede heredar un índice o repositorio alternativo; el vault usa siempre el propio.
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key]
  const result = spawnSync('git', args, { cwd: root, env, input, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS })
  if (result.error || result.status === null) throw new SddError('archive_git_failed', 'Git no respondió al inspeccionar el vault')
  return { status: result.status, bytes: result.stdout }
}
function git(root: string, args: string[], input?: string): Buffer {
  const result = query(root, args, input)
  if (result.status !== 0) throw new SddError('archive_git_failed', `falló git ${args.includes('commit') ? 'commit' : args[0]} en el vault`, { detail: `exit_code ${result.status}` })
  return result.bytes
}
const text = (root: string, args: string[]) => git(root, args).toString().trim()
const split = (bytes: Buffer) => bytes.toString().split('\0').filter(Boolean)

export function inspectVaultGit(root: string, files: VaultGitFile[]): void {
  const top = realpathSync(text(root, ['rev-parse', '--show-toplevel']))
  if (top !== realpathSync(root) || text(root, ['rev-parse', '--is-bare-repository']) !== 'false') {
    throw new SddError('archive_vault_repo_invalid', 'el vault debe ser la raíz de su propio repo Git')
  }
  const expected = new Set(files.map((file) => file.path))
  const staged = split(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z']))
  if (staged.some((path) => !expected.has(path))) throw new SddError('archive_vault_staged_foreign', 'el vault tiene cambios staged ajenos al flujo')
  // check-ignore rechaza la magia literal; con --stdin las rutas ya no son pathspecs.
  const ignored = query(root, ['--no-literal-pathspecs', 'check-ignore', '--no-index', '-z', '--stdin'], `${files.map((f) => f.path).join('\0')}\0`)
  if (ignored.status !== 0 && ignored.status !== 1) throw new SddError('archive_git_failed', 'no se pudieron consultar las rutas ignoradas')
  if (ignored.status === 0 && ignored.bytes.length) throw new SddError('archive_vault_ignored', 'Git ignoraría rutas del archivo', { detail: split(ignored.bytes).join(', ') })
}

function head(root: string): string | null {
  const result = query(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (result.status === 0) return result.bytes.toString().trim()
  if (result.status !== 1) throw new SddError('archive_git_failed', 'no se pudo determinar HEAD')
  // Sin commit, HEAD solo es válido como rama no nacida: symbolic-ref falla en cualquier otro caso.
  text(root, ['symbolic-ref', 'HEAD'])
  return null
}

function index(root: string): Map<string, string> {
  return new Map(split(git(root, ['ls-files', '--stage', '-z'])).map((entry) => {
    const at = entry.indexOf('\t'), metadata = entry.slice(0, at)
    if (!/^\d+ [0-9a-f]+ 0$/.test(metadata)) throw new SddError('archive_git_failed', 'el índice no tiene entradas normales')
    return [entry.slice(at + 1), metadata] as [string, string]
  }))
}

function verifyBlobs(root: string, files: VaultGitFile[], entries: Map<string, string>): void {
  for (const file of files) {
    const metadata = entries.get(file.path)
    if (!metadata || !/^100(?:644|755) /.test(metadata)) throw new SddError('archive_commit_invalid', 'falta un archivo regular del flujo en Git', { detail: file.path })
    const bytes = git(root, ['cat-file', 'blob', metadata.split(' ')[1]])
    if (bytes.length !== file.size || archiveHash(bytes) !== file.sha256) throw new SddError('archive_commit_invalid', 'Git transformó bytes del flujo', { detail: file.path })
  }
}

function verifyCommit(root: string, sha: string, intent: NonNullable<VaultCommitProgress['commit_intent']>, files: VaultGitFile[]): void {
  const parents = text(root, ['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1)
  if (JSON.stringify(parents) !== JSON.stringify(intent.parent ? [intent.parent] : [])
    || text(root, ['rev-parse', `${sha}^{tree}`]) !== intent.tree
    || text(root, ['log', '-1', '--format=%B', sha]) !== intent.message) throw new SddError('archive_commit_invalid', 'el commit no corresponde a su intención')
  const paths = split(git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha])).sort()
  if (JSON.stringify(paths) !== JSON.stringify(files.map((file) => file.path).sort())) throw new SddError('archive_commit_invalid', 'el commit contiene un conjunto distinto de rutas')
  const entries = new Map(split(git(root, ['ls-tree', '-r', '-z', sha])).map((entry) => {
    const at = entry.indexOf('\t'), [mode, , blob] = entry.slice(0, at).split(' ')
    return [entry.slice(at + 1), `${mode} ${blob} 0`] as [string, string]
  }))
  verifyBlobs(root, files, entries)
}

/** El commit de la intención entre su padre y HEAD, por padre y árbol; null si no existe. */
function ownCommit(root: string, intent: NonNullable<VaultCommitProgress['commit_intent']>): string | null {
  const lines = text(root, ['rev-list', '--parents', ...(intent.parent ? [`${intent.parent}..HEAD`] : ['HEAD'])]).split('\n').filter(Boolean)
  for (const line of lines) {
    const [sha, ...parents] = line.split(' ')
    if (JSON.stringify(parents) === JSON.stringify(intent.parent ? [intent.parent] : [])
      && text(root, ['rev-parse', `${sha}^{tree}`]) === intent.tree) return sha
  }
  return null
}

/** Las intenciones se guardan antes de Git; un corte posterior se reconoce, nunca se duplica. */
export function commitArchiveVault(root: string, files: VaultGitFile[], operationId: string, store: string,
  progress: VaultCommitProgress, save: () => void, fault?: ArchiveFaultInjector): string {
  inspectVaultGit(root, files)
  if (progress.commit_sha) {
    if (!progress.commit_intent) throw new SddError('archive_manifest_invalid', 'commit sin intención')
    verifyCommit(root, progress.commit_sha, progress.commit_intent, files)
    return progress.commit_sha
  }
  if (progress.commit_intent) {
    const current = head(root)
    if (current !== progress.commit_intent.parent) {
      if (!current) throw new SddError('archive_commit_uncertain', 'HEAD no acredita el commit pendiente')
      // El vault es compartido: el commit propio puede haber quedado debajo de commits posteriores.
      const own = ownCommit(root, progress.commit_intent)
      if (own) { verifyCommit(root, own, progress.commit_intent, files); progress.commit_sha = own; save(); return own }
      // HEAD avanzó sin el commit propio: el commit no llegó a crearse y la intención se recalcula.
      delete progress.commit_intent; save()
    }
  }
  if (!progress.staging_intent) {
    const before = index(root)
    progress.staged_entries = files.map((file) => ({ path: file.path, previous: before.get(file.path) ?? null, written: null }))
    if (progress.staged_entries.some((entry) => entry.previous !== null)) throw new SddError('archive_vault_collision', 'hay rutas del flujo previamente rastreadas')
    progress.staging_intent = true; save()
  }
  git(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], `${files.map((file) => file.path).join('\0')}\0`)
  fault?.('after_vault_staging', { operation_id: operationId, phase: 'commit' })
  const staged = index(root)
  for (const entry of progress.staged_entries ?? []) entry.written = staged.get(entry.path) ?? null
  save()
  verifyBlobs(root, files, staged)
  const changed = split(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z'])).sort()
  if (JSON.stringify(changed) !== JSON.stringify(files.map((file) => file.path).sort())) throw new SddError('archive_commit_invalid', 'el índice no contiene exactamente el flujo nuevo')
  const tree = text(root, ['write-tree'])
  if (!progress.commit_intent) {
    progress.commit_intent = { parent: head(root), tree, message: `chore: archive ${operationId}` }; save()
  } else if (tree !== progress.commit_intent.tree) throw new SddError('archive_commit_invalid', 'el árbol staged cambió desde la intención')
  const hooks = join(store, 'empty-hooks')
  if (archiveStat(store, hooks) === null) createArchiveDirectory(hooks)
  if (!archiveStat(store, hooks)?.isDirectory() || readdirSync(hooks).length) throw new SddError('archive_manifest_invalid', 'el directorio de hooks no está vacío')
  // El commit sale del árbol verificado de la intención, no del índice ni del árbol de trabajo vivos, y la
  // rama solo avanza si sigue en el padre registrado: nada stageado después ni un HEAD movido entran en él.
  const { parent, tree: intended, message } = progress.commit_intent
  const created = text(root, ['-c', `core.hooksPath=${hooks}`, 'commit-tree', intended, ...(parent ? ['-p', parent] : []), '-m', message])
  git(root, ['-c', `core.hooksPath=${hooks}`, 'update-ref', '-m', `archive ${operationId}`, 'HEAD', created, parent ?? '0'.repeat(created.length)])
  fault?.('after_vault_commit', { operation_id: operationId, phase: 'commit' })
  verifyCommit(root, created, progress.commit_intent, files)
  progress.commit_sha = created; save(); return created
}

/** Solo informa el índice actual; stopped no lo repara ni lo limpia. */
export function archiveStagedReport(root: string, progress: VaultCommitProgress): unknown {
  try {
    const entries = index(root)
    return (progress.staged_entries ?? []).map((entry) => ({ ...entry, current: entries.get(entry.path) ?? null }))
  } catch { return { limitation: 'no se pudo inspeccionar el índice del vault' } }
}
