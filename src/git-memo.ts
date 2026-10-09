import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type GitQuery = 'repoRoot' | 'gitDirs' | 'objects'
/** Las variables que redirigen Git: con cualquiera definida, las tres consultas no se memorizan (bypass redirect_env). */
export const GIT_REDIRECT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const
/** Las variables que forman parte de la clave: las de redirección más las que cambian la respuesta sin redirigir. */
export const GIT_QUERY_ENV = [...GIT_REDIRECT_ENV, 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'] as const
export type GitQueryEnvironment = Readonly<Record<string, string | undefined>>
export interface PhysicalIdentity { dev: string; ino: string }
export interface GitMemoEvent {
  v: 1; kind: 'hit' | 'miss' | 'store' | 'discard' | 'bypass'; query: GitQuery; key: string
  scope: number | null; call: number | null; reason: string; seq: number; ref?: number
}
interface Entry { value: unknown; stamp: string; anchor: string; store: number }
interface Scope { id: number; call: number | null; active: boolean; entries: Map<string, Entry> }
interface Context { scope?: Scope; call: number | null; disabled?: 'no_scope' | 'legacy' }
const context = new AsyncLocalStorage<Context>()
const diagnostics = channel('sdd-ai:git-memo')
let nextScope = 0
let nextCall = 0
let nextEvent = 0

/** La ruta ya está normalizada y las identidades se leen fuera de este constructor puro. */
export function gitQueryKey(query: GitQuery, path: string, env: GitQueryEnvironment, identity?: PhysicalIdentity): string {
  return JSON.stringify([query, query === 'gitDirs' && identity ? [identity.dev, identity.ino] : path,
    GIT_QUERY_ENV.map((name) => [name, env[name] === undefined ? null : env[name]])])
}

export const normalizeGitQueryInput = (input: string): string => resolve(input)
export function currentGitQueryScope(): { scope: number | null; call: number | null } {
  const c = context.getStore()
  return { scope: c?.scope?.active && !c.disabled ? c.scope.id : null, call: c?.call ?? null }
}

/** Cada vuelta empieza vacía; las tareas diferidas de un ámbito cerrado no pueden reutilizarlo. */
export function withGitQueryScope<T>(type: 'call' | 'iteration', fn: () => T): T {
  const call = type === 'call' ? ++nextCall : context.getStore()?.call ?? null
  const scope: Scope = { id: ++nextScope, call, active: true, entries: new Map() }
  const close = () => { scope.active = false; scope.entries.clear() }
  return context.run({ scope, call }, () => {
    try {
      const result = fn()
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return Promise.resolve(result).finally(close) as T
      }
      close()
      return result
    } catch (error) { close(); throw error }
  })
}

export function withoutGitQueryMemo<T>(fn: () => T, reason: 'no_scope' | 'legacy' = 'no_scope'): T {
  return context.run({ call: context.getStore()?.call ?? null, disabled: reason }, fn)
}

function emit(kind: GitMemoEvent['kind'], query: GitQuery, key: string, reason: string, ref?: number): number {
  const seq = ++nextEvent
  if (diagnostics.hasSubscribers) diagnostics.publish({ v: 1, kind, query, key, ...currentGitQueryScope(), reason, seq,
    ...(ref !== undefined ? { ref } : {}) } satisfies GitMemoEvent)
  return seq
}

const environment = (): GitQueryEnvironment => Object.fromEntries(GIT_QUERY_ENV.map((name) => [name, process.env[name]]))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** No usar mtime/ctime: index, locks y HEAD cambian sin cambiar la respuesta de estas consultas. */
function directoryIdentity(path: string): PhysicalIdentity {
  const st = statSync(path, { bigint: true })
  if (!st.isDirectory() || st.ino === 0n) throw new Error('identidad de directorio indisponible')
  return { dev: String(st.dev), ino: String(st.ino) }
}

/** Lanza si la ruta no es un directorio con identidad fiable: esa parte de la estampa no se puede leer. */
function assertDirectoryIdentity(path: string): void {
  directoryIdentity(path)
}

/**
 * La evidencia de una entrada para la estampa: tipo, dispositivo e inodo, y el contenido si se pide. No guarda la ruta
 * real, que depende de la grafía con que se pregunta: así dos grafías de la misma entrada dan la misma estampa. Un
 * enlace agrega su destino literal y la identidad de lo que apunta.
 */
function entryEvidence(path: string, contents = false): unknown {
  let st
  try { st = lstatSync(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (st.ino === 0n) throw new Error('identidad indisponible')
  return { dev: String(st.dev), ino: String(st.ino), type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
    link: st.isSymbolicLink() ? readlinkSync(path) : null,
    target: st.isSymbolicLink() ? targetIdentity(realpathSync(path)) : null,
    content: contents ? readFileSync(path).toString('base64') : null }
}

/** La identidad de lo que apunta un enlace, sea directorio, archivo u otro. */
function targetIdentity(path: string): unknown {
  const st = statSync(path, { bigint: true })
  if (st.ino === 0n) throw new Error('identidad indisponible')
  return { dev: String(st.dev), ino: String(st.ino), type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other' }
}

interface Layout { gitDir: string; commonDir: string; evidence: unknown }
/**
 * La disposición de un directorio Git. Con `config`, la evidencia suma `config` y `config.worktree`, que pueden cambiar
 * la raíz y los directorios que informa Git; la ruta de objetos no depende de ellos (paso 4 del plan).
 */
function gitLayout(gitDir: string, config = true): Layout {
  const gitEvidence = entryEvidence(gitDir)
  assertDirectoryIdentity(gitDir)
  const commonFile = join(gitDir, 'commondir')
  const commonEvidence = entryEvidence(commonFile, true)
  const commonDir = commonEvidence === null ? realpathSync(gitDir) : realpathSync(resolve(gitDir, readFileSync(commonFile, 'utf8').trim()))
  assertDirectoryIdentity(commonDir)
  return { gitDir: realpathSync(gitDir), commonDir, evidence: [gitEvidence, commonEvidence, entryEvidence(commonDir),
    ...(config ? [entryEvidence(join(commonDir, 'config'), true), entryEvidence(join(gitDir, 'config.worktree'), true)] : [])] }
}

function rootLayout(root: string): Layout {
  const dot = join(root, '.git')
  const st = statSync(dot)
  const dotEvidence = entryEvidence(dot, st.isFile())
  let dir = dot
  if (st.isFile()) {
    const match = /^gitdir: (.+)\s*$/.exec(readFileSync(dot, 'utf8'))
    if (!match) throw new Error('gitfile ilegible')
    dir = resolve(root, match[1].trim())
  } else if (!st.isDirectory()) throw new Error('identificación desconocida')
  const layout = gitLayout(dir)
  return { ...layout, evidence: [entryEvidence(root), dotEvidence, layout.evidence] }
}

interface Capture { evidence: unknown; root?: string; gitDir: string; commonDir: string; objects?: string }
function capture(query: GitQuery, input: string, env: GitQueryEnvironment): Capture {
  if (query === 'objects') {
    const layout = gitLayout(input, false)
    const objects = env.GIT_OBJECT_DIRECTORY !== undefined ? resolve(env.GIT_OBJECT_DIRECTORY) : join(layout.commonDir, 'objects')
    assertDirectoryIdentity(objects)
    return { ...layout, objects, evidence: [layout.evidence, entryEvidence(objects), process.cwd()] }
  }
  if (query === 'gitDirs') return rootLayout(realpathSync(input))
  const trail: unknown[] = []
  let root = realpathSync(input)
  for (;;) {
    const dot = entryEvidence(join(root, '.git'))
    trail.push([root, entryEvidence(root), dot])
    if (dot !== null) {
      const layout = rootLayout(root)
      return { ...layout, root, evidence: [realpathSync(input), trail, layout.evidence] }
    }
    const parent = dirname(root)
    if (parent === root) throw new Error('sin identificación')
    root = parent
  }
}

function coherent(query: GitQuery, value: unknown, stamp: Capture): boolean {
  if (query === 'gitDirs') {
    // Por identidad física y no por cadena: dos grafías de la misma raíz (que comparten clave) dan rutas con distinta
    // grafía, y deben resultar coherentes con la misma estampa.
    const dirs = value as { gitDir: string; commonDir: string }
    const sameDirectory = (a: string, b: string) => same(directoryIdentity(a), directoryIdentity(b))
    return sameDirectory(dirs.gitDir, stamp.gitDir) && sameDirectory(dirs.commonDir, stamp.commonDir)
  }
  // El valor conserva la grafía de Git; solo la comparación física resuelve los alias.
  if (typeof value !== 'string') return false
  return realpathSync(value) === realpathSync(query === 'repoRoot' ? stamp.root! : stamp.objects!)
}

/**
 * Dónde está hoy lo que devuelve una entrada: la ruta real y la identidad de cada ruta del valor. La estampa no guarda
 * rutas, para que dos grafías de la misma raíz compartan entrada; por eso un repositorio renombrado o un padre movido
 * con un enlace en la ruta anterior dejan la estampa igual. El ancla sí cambia (o no se puede leer), y la entrada se
 * descarta antes de devolver una ruta que ya no es la del repositorio.
 */
function valueAnchor(query: GitQuery, value: unknown): string {
  const dirs = value as { gitDir: string; commonDir: string }
  const paths = query === 'gitDirs' ? [dirs.gitDir, dirs.commonDir] : [value as string]
  return JSON.stringify(paths.map((path) => [realpathSync(path), targetIdentity(path)]))
}

/** Un fallo de captura no cambia el resultado ni los errores de la consulta Git. */
export function memoGitQuery<T>(query: GitQuery, input: string, compute: () => T): T {
  const env = environment()
  const normalized = normalizeGitQueryInput(input)
  let physical: PhysicalIdentity | undefined
  if (query === 'gitDirs') { try { physical = directoryIdentity(normalized) } catch { /* Consulta fresca. */ } }
  const key = gitQueryKey(query, normalized, env, physical)
  const c = context.getStore()
  const bypass = c?.disabled ?? (!c?.scope?.active ? 'no_scope' : GIT_REDIRECT_ENV.some((name) => env[name] !== undefined) ? 'redirect_env' : null)
  if (bypass) { emit('bypass', query, key, bypass); return compute() }
  const scope = c!.scope!
  let before: Capture
  const entry = scope.entries.get(key)
  try { before = capture(query, normalized, env) } catch {
    if (entry) { scope.entries.delete(key); emit('discard', query, key, 'stamp_unreadable', entry.store) }
    emit('bypass', query, key, 'stamp_unreadable')
    return compute()
  }
  const stamp = JSON.stringify([env, before.evidence])
  if (entry) {
    let valid = false
    try { valid = entry.stamp === stamp && valueAnchor(query, entry.value) === entry.anchor } catch { /* El valor ya no está donde estaba. */ }
    if (valid) { emit('hit', query, key, 'valid_stamp'); return entry.value as T }
    scope.entries.delete(key)
    emit('discard', query, key, 'stale_stamp', entry.store)
  }
  const miss = emit('miss', query, key, 'not_stored')
  const value = compute()
  let after: Capture
  try { after = capture(query, normalized, environment()) } catch {
    emit('discard', query, key, 'stamp_unreadable', miss); return value
  }
  if (!same(env, environment()) || !same(before, after)) { emit('discard', query, key, 'unstable', miss); return value }
  let anchor: string | null = null
  try { if (coherent(query, value, after)) anchor = valueAnchor(query, value) } catch { /* Sin evidencia de coherencia. */ }
  if (anchor === null) { emit('discard', query, key, 'incoherent', miss); return value }
  if (scope.active) {
    const store = emit('store', query, key, 'stable', miss)
    scope.entries.set(key, { value, stamp, anchor, store })
  }
  return value
}
