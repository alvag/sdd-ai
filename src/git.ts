import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { SddError } from './types.ts'

/** Raíz del árbol de trabajo actual; en un worktree, la de ese worktree. */
export function repoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    throw new SddError('not_a_repo', `${cwd} no está dentro de un repositorio Git`, {
      detail: (e as { stderr?: string }).stderr?.trim(),
      next: 'corre sdd-ai desde un repositorio Git',
    })
  }
}

const MAX_BUFFER = 256 * 1024 * 1024

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER,
  })
}

/** Si el repositorio tiene al menos un remoto configurado. */
export function hasRemote(root: string): boolean {
  return git(root, ['remote']).trim() !== ''
}

/** El commit de `HEAD`, o nada si todavía no hay ninguno. */
export function headCommit(root: string): string | undefined {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim() || undefined
  } catch {
    return undefined
  }
}

/** La rama de `HEAD`, o `null` con `HEAD` separado. */
export function currentBranch(root: string): string | null {
  try {
    return git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null
  } catch {
    return null
  }
}

/**
 * Las rutas con cambios sin commitear: modificadas, borradas, nuevas y renombradas. Lo ignorado no cuenta.
 * Sin los locks opcionales, `git status` no reescribe el índice: consultarlo no escribe nada en `.git`.
 */
export function dirtyPaths(root: string): string[] {
  const parts = git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry === '') continue
    out.push(entry.slice(3))
    // Un renombre o una copia traen después la ruta de origen.
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return out
}

/** El directorio de Git del checkout y el común, con rutas reales: en un worktree son distintos. */
export function gitDirs(root: string): { gitDir: string; commonDir: string } {
  const [gitDir, commonDir] = git(root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trim().split('\n')
  return { gitDir: realpathSync(gitDir), commonDir: realpathSync(commonDir) }
}

export interface HarvestFile {
  path: string; from?: string
  status: 'A' | 'M' | 'D' | 'R' | 'T'
  /** `null` en un binario. */
  added: number | null; removed: number | null
  binary: boolean; modeBefore?: string; modeAfter?: string
}
export interface TreeCapture { tree: string; patch: Buffer; files: HarvestFile[] }

export interface Checkout { root: string; gitDir: string }

/** Los objetos nuevos de una captura: junto al índice propio, nunca en el repositorio. */
const scratchObjects = (indexFile: string) => `${indexFile}.objects`

/** Borra el índice propio de una captura y sus objetos. */
export function removeIndex(indexFile: string): void {
  rmSync(indexFile, { force: true })
  rmSync(scratchObjects(indexFile), { recursive: true, force: true })
}

/** El directorio de objetos del repositorio y los alternativos que declara. */
function objectDirs(gitDir: string): string[] {
  const objects = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  let alternates: string[] = []
  try {
    alternates = readFileSync(join(objects, 'info', 'alternates'), 'utf8').split('\n').map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')).map((l) => (isAbsolute(l) ? l : join(objects, l)))
  } catch {
    // Sin alternativos.
  }
  return [objects, ...alternates]
}

/**
 * El entorno de Git para un índice propio: el índice y los objetos que escribe van a un directorio
 * propio, con los del repositorio como alternativos. Así la captura no escribe nada en `.git`, que el
 * sandbox de un conductor Codex deja en solo lectura.
 */
export function indexEnv(c: Checkout, indexFile: string): Record<string, string> {
  return {
    GIT_INDEX_FILE: indexFile, GIT_OBJECT_DIRECTORY: scratchObjects(indexFile),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirs(c.gitDir).join(delimiter),
  }
}

/**
 * Git sobre un checkout con su directorio de Git explícito y un índice propio: no vuelve a leer el
 * archivo `.git` del checkout ni toca el índice del usuario.
 */
function indexedGit(c: Checkout, indexFile: string) {
  const env = { ...process.env, ...indexEnv(c, indexFile) }
  const opts = (input?: string) => ({
    cwd: c.root, env, maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}),
  })
  const argv = (args: string[]) => ['--git-dir', c.gitDir, '--work-tree', c.root, '-c', 'core.quotePath=false', ...args]
  return {
    bytes: (args: string[], input?: string): Buffer => execFileSync('git', argv(args), opts(input)),
    text: (args: string[], input?: string): string => execFileSync('git', argv(args), opts(input)).toString('utf8'),
  }
}

const EMPTY = '0'.repeat(40)
const splitZ = (s: string) => s.split('\0').filter((p) => p !== '')

/**
 * Arma en `indexFile` el índice del árbol real contra `base`, archivos nuevos incluidos, y devuelve su
 * árbol. Los blobs salen de `hash-object --no-filters`: ni esto ni nada de la captura corre un filtro
 * `clean` que un `.gitattributes` del árbol haya activado. `ls-files -m` o `git add` sí lo correrían.
 */
export function buildIndex(c: Checkout, base: string, indexFile: string): string {
  mkdirSync(scratchObjects(indexFile), { recursive: true })
  const g = indexedGit(c, indexFile)
  g.text(['read-tree', base])
  const fileMode = g.text(['config', '--bool', '--default', 'true', 'core.filemode']).trim() !== 'false'
  const baseEntries = new Map<string, { mode: string; sha: string }>()
  for (const line of splitZ(g.text(['ls-files', '-z', '-s']))) {
    const [meta, path] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)]
    const [mode, sha] = meta.split(' ')
    baseEntries.set(path, { mode, sha })
  }
  const untracked = splitZ(g.text(['ls-files', '-z', '-o', '--exclude-standard']))

  const updates: string[] = []
  const files: Array<{ path: string; mode: string }> = []
  const links: Array<{ path: string; target: string }> = []
  for (const path of [...baseEntries.keys(), ...untracked]) {
    const before = baseEntries.get(path)
    // Un submódulo queda como estaba en la base.
    if (before?.mode === '160000') continue
    let st
    try {
      st = lstatSync(join(c.root, path))
    } catch {
      st = undefined
    }
    if (!st || st.isDirectory()) {
      if (before) updates.push(`0 ${EMPTY}\t${path}`)
    } else if (st.isSymbolicLink()) {
      links.push({ path, target: readlinkSync(join(c.root, path)) })
    } else if (st.isFile()) {
      const exec = (st.mode & 0o100) !== 0
      const mode = !fileMode && before && before.mode !== '120000' ? before.mode : exec ? '100755' : '100644'
      files.push({ path, mode })
    }
  }
  const batch = files.filter((f) => !f.path.includes('\n'))
  const hashes = batch.length > 0
    ? g.text(['hash-object', '-w', '--no-filters', '--stdin-paths'], `${batch.map((f) => f.path).join('\n')}\n`).trim().split('\n')
    : []
  const hashed = new Map(batch.map((f, i) => [f.path, hashes[i]]))
  for (const f of files) {
    const sha = hashed.get(f.path) ?? g.text(['hash-object', '-w', '--no-filters', '--', f.path]).trim()
    if (baseEntries.get(f.path)?.sha !== sha || baseEntries.get(f.path)?.mode !== f.mode) updates.push(`${f.mode} ${sha}\t${f.path}`)
  }
  for (const l of links) {
    const sha = g.text(['hash-object', '-w', '--no-filters', '--stdin'], l.target).trim()
    if (baseEntries.get(l.path)?.sha !== sha || baseEntries.get(l.path)?.mode !== '120000') updates.push(`120000 ${sha}\t${l.path}`)
  }
  if (updates.length > 0) g.text(['update-index', '-z', '--index-info'], `${updates.join('\0')}\0`)
  return g.text(['write-tree']).trim()
}

/** Base y árbol de un candidato, los dos sin el directorio de su flujo: iguales si nada cambió afuera. */
export interface CandidateFingerprint { base_commit: string; base_tree: string; tree: string }

/** Saca `path` del índice propio y escribe su árbol. */
function treeWithout(c: Checkout, indexFile: string, path: string): string {
  const g = indexedGit(c, indexFile)
  g.text(['rm', '--cached', '-r', '-f', '-q', '--ignore-unmatch', '--', path])
  return g.text(['write-tree']).trim()
}

/** Un índice propio en un directorio temporal, que se borra al terminar. */
function withScratchIndex<T>(fn: (indexFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-index-'))
  try {
    const indexFile = join(dir, 'index')
    mkdirSync(scratchObjects(indexFile), { recursive: true })
    return fn(indexFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * La huella del candidato de un flujo: el árbol de trabajo y el de `baseCommit`, los dos sin
 * `.plans/<flow>/`, así lo que el propio verbo escribe en el flujo no la mueve. Entran los archivos
 * rastreados y los nuevos que Git no ignora, como en la cosecha: una fila que escribe solo en rutas
 * ignoradas, como la salida de un build, no cuenta como mutación. No toca el índice del usuario.
 */
export function candidateFingerprint(root: string, flow: string, baseCommit: string): CandidateFingerprint {
  const c: Checkout = { root, gitDir: gitDirs(root).gitDir }
  const flowPath = `.plans/${flow}`
  const tree = withScratchIndex((indexFile) => {
    buildIndex(c, baseCommit, indexFile)
    return treeWithout(c, indexFile, flowPath)
  })
  const base_tree = withScratchIndex((indexFile) => {
    indexedGit(c, indexFile).text(['read-tree', baseCommit])
    return treeWithout(c, indexFile, flowPath)
  })
  return { base_commit: baseCommit, base_tree, tree }
}

/**
 * El árbol de una cosecha sin `.plans/<flow>/`, reconstruido aplicando su patch sobre la base en un índice
 * propio: la cosecha no conserva el objeto de su árbol. `null` si el patch ya no está o no aplica.
 */
export function harvestTreeWithout(root: string, flow: string, base: string, patchFile: string): string | null {
  const c: Checkout = { root, gitDir: gitDirs(root).gitDir }
  let size: number
  try {
    size = statSync(patchFile).size
  } catch {
    return null
  }
  return withScratchIndex((indexFile) => {
    const g = indexedGit(c, indexFile)
    g.text(['read-tree', base])
    if (size > 0) {
      try {
        g.text(['apply', '--cached', '--binary', patchFile])
      } catch {
        return null
      }
    }
    return treeWithout(c, indexFile, `.plans/${flow}`)
  })
}

/** Diff del índice armado contra la base, sin diff externo ni textconv, con las rutas de siempre. */
const CAPTURE_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M']

/**
 * La cosecha de un árbol: su hash, el patch binario que lo reproduce sobre la base y cada archivo con
 * su estado, sus líneas y sus modos.
 */
export function captureTree(checkout: Checkout, base: string, indexFile: string): TreeCapture {
  const tree = buildIndex(checkout, base, indexFile)
  const g = indexedGit(checkout, indexFile)
  const patch = g.bytes(['diff', '--cached', '--binary', ...CAPTURE_DIFF, base])
  const raw = splitZ(g.text(['diff', '--cached', '--raw', '-z', ...CAPTURE_DIFF, base]))
  const numstat = g.text(['diff', '--cached', '--numstat', '-z', ...CAPTURE_DIFF, base]).split('\0')

  const counts = new Map<string, { added: number | null; removed: number | null }>()
  for (let i = 0; i < numstat.length && numstat[i] !== '';) {
    const [added, removed, path] = numstat[i].split('\t')
    const value = added === '-' ? { added: null, removed: null } : { added: Number(added), removed: Number(removed) }
    // En un renombre, la ruta nueva viene dos campos después.
    if (path === '') {
      counts.set(numstat[i + 2], value)
      i += 3
    } else {
      counts.set(path, value)
      i += 1
    }
  }

  const files: HarvestFile[] = []
  for (let i = 0; i < raw.length;) {
    const [oldMode, newMode, , , state] = raw[i].slice(1).split(' ')
    const status = state[0] as HarvestFile['status']
    const f: HarvestFile = status === 'R'
      ? { path: raw[i + 2], from: raw[i + 1], status, added: 0, removed: 0, binary: false }
      : { path: raw[i + 1], status, added: 0, removed: 0, binary: false }
    i += status === 'R' ? 3 : 2
    const n = counts.get(f.path) ?? { added: 0, removed: 0 }
    f.added = n.added
    f.removed = n.removed
    f.binary = n.added === null
    if (status !== 'A') f.modeBefore = oldMode
    if (status !== 'D') f.modeAfter = newMode
    files.push(f)
  }
  return { tree, patch, files }
}
