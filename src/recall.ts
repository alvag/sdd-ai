import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { loadVaultPath } from './config.ts'
import { isFlowId } from './sdd/id.ts'
import { FILE_NAMES } from './sdd/read.ts'

export type MatchMode = 'all' | 'any'
export type SourceStatus = 'ok' | 'not_configured' | 'unavailable' | 'unresolved' | 'error'
export interface CitedLine { path: string; line: number; text: string; cut?: true }
export const RECALL_LIMITS = {
  engramHits: 5, engramPerTerm: 20, groups: 5, linesPerGroup: 3, commits: 10, lineChars: 200,
  engramTimeoutMs: 15000, maxVariants: 64,
} as const

/** Minúsculas y sin las marcas de las vocales; conserva la ñ y la ç. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/([aeiouy])\p{M}+/giu, '$1').normalize('NFC').toLowerCase()
}

/** Conserva la primera forma escrita de cada término. */
export function splitTerms(topic: string): string[] {
  const seen = new Set<string>()
  return topic.trim().split(/\s+/).filter((term) => {
    if (!term || seen.has(fold(term))) return false
    seen.add(fold(term))
    return true
  })
}

/** Enumera por cantidad de tramos marcados, sin construir el producto completo. */
export function termVariants(term: string): { variants: string[]; capped: boolean } {
  const plain = fold(term)
  const segments = [...plain.matchAll(/\p{L}+/gu)]
  const accents: Record<string, string[]> = { a: ['á'], e: ['é'], i: ['í'], o: ['ó'], u: ['ú', 'ü'] }
  const choices = segments.map((segment) => {
    const chars = [...segment[0]]
    return chars.flatMap((char, index) => (accents[char] ?? []).map((marked) =>
      [...chars.slice(0, index), marked, ...chars.slice(index + 1)].join('')))
  })
  const variants = new Set([term, plain])
  const selected = new Map<number, string>()
  const emit = () => {
    let offset = 0
    let value = ''
    for (const [index, segment] of segments.entries()) {
      value += plain.slice(offset, segment.index) + (selected.get(index) ?? segment[0])
      offset = segment.index + segment[0].length
    }
    variants.add(value + plain.slice(offset))
  }
  // Solo los tramos con alguna vocal se pueden marcar: recorrer los demás no agrega variantes.
  const markable = choices.flatMap((options, index) => options.length ? [index] : [])
  const enumerate = (start: number, remaining: number): void => {
    if (variants.size > RECALL_LIMITS.maxVariants) return
    if (remaining === 0) { emit(); return }
    for (let position = start; position <= markable.length - remaining; position++) {
      const index = markable[position]
      for (const choice of choices[index]) {
        selected.set(index, choice)
        enumerate(position + 1, remaining - 1)
        selected.delete(index)
        if (variants.size > RECALL_LIMITS.maxVariants) return
      }
    }
  }
  for (let count = 1; count <= markable.length && variants.size <= RECALL_LIMITS.maxVariants; count++) enumerate(0, count)
  return { variants: [...variants].slice(0, RECALL_LIMITS.maxVariants), capped: variants.size > RECALL_LIMITS.maxVariants }
}

export function textMatches(text: string, terms: string[], mode: MatchMode): boolean {
  const value = fold(text)
  return mode === 'all' ? terms.every((term) => value.includes(fold(term))) : terms.some((term) => value.includes(fold(term)))
}

/** Primero con todos los términos y, si no da nada y hay más de uno, con cualquiera. */
function withFallback<T>(terms: string[], search: (mode: MatchMode) => T[]): { match: MatchMode; hits: T[] } {
  const all = search('all')
  if (all.length || terms.length === 1) return { match: 'all', hits: all }
  return { match: 'any', hits: search('any') }
}

export interface SourceFile { display: string; text: string }
export function citeGroup(files: SourceFile[], terms: string[], mode: MatchMode):
  { lines: CitedLine[]; omitted_lines: number; termCount: number } | null {
  const matching = files.filter((file) => textMatches(file.text, terms, mode))
  if (!matching.length) return null
  const found = new Set<string>()
  const lines: Array<{ citation: CitedLine; count: number; file: number }> = []
  for (const [index, file] of matching.entries()) {
    for (const term of terms) if (textMatches(file.text, [term], 'all')) found.add(fold(term))
    for (const [line, text] of file.text.split('\n').entries()) {
      const count = terms.filter((term) => textMatches(text, [term], 'all')).length
      if (!count) continue
      const chars = [...text.trim()]
      lines.push({ file: index, count, citation: {
        path: file.display, line: line + 1, text: chars.slice(0, RECALL_LIMITS.lineChars).join(''),
        ...(chars.length > RECALL_LIMITS.lineChars ? { cut: true as const } : {}),
      } })
    }
  }
  lines.sort((a, b) => b.count - a.count || a.file - b.file || a.citation.line - b.citation.line)
  return { lines: lines.slice(0, RECALL_LIMITS.linesPerGroup).map((line) => line.citation),
    omitted_lines: Math.max(0, lines.length - RECALL_LIMITS.linesPerGroup), termCount: found.size }
}

export interface EngramHit {
  id: number; type: string; title: string; preview: string; preview_truncated: true
  date: string; project: string | null; scope: string
}
export interface EngramSource {
  status: SourceStatus; match?: MatchMode; incomplete?: boolean; truncated: boolean; reason?: string
  project?: string | null; hits: EngramHit[]
}

/** Un cambio del formato del CLI deja la fuente en error, sin inventar aciertos. */
export function parseEngramSearch(stdout: string): EngramHit[] | null {
  const text = stdout.replace(/\r\n/g, '\n').trimEnd()
  if (/^No memories found for: "(?:[^"\\]|\\.)*"$/.test(text)) return []
  const lines = text.split('\n')
  const header = /^Found (\d+) memories:$/.exec(lines.shift() ?? '')
  if (!header) return null
  const hits: EngramHit[] = []
  while (lines.length) {
    if (lines[0] === '') { lines.shift(); continue }
    const title = /^\[(\d+)\] #(\d+) \(([^()\n]+)\) — (.*)$/.exec(lines.shift() ?? '')
    if (!title || Number(title[1]) !== hits.length + 1 || !lines[0]?.startsWith('    ')) return null
    const preview = [(lines.shift() ?? '').slice(4)]
    let metadata: RegExpExecArray | null = null
    while (lines.length) {
      metadata = /^    (\d{4}-\d{2}-\d{2}(?:[ T][^|]+?)?)(?: \| project: (.+?))? \| scope: (\S.*)$/.exec(lines[0])
      if (metadata) { lines.shift(); break }
      if (/^\[\d+\] #/.test(lines[0])) return null
      preview.push(lines.shift() ?? '')
    }
    if (!metadata) return null
    const id = Number(title[2])
    if (!Number.isSafeInteger(id) || hits.some((hit) => hit.id === id)) return null
    hits.push({ id, type: title[3], title: title[4], preview: preview.join('\n'), preview_truncated: true,
      date: metadata[1], project: metadata[2] ?? null, scope: metadata[3] })
  }
  return Number(header[1]) === hits.length ? hits : null
}

/**
 * El CLI de Engram toma como flag un argumento idéntico a una de las suyas aunque venga entre los de la consulta
 * (`--all` ampliaría la búsqueda a otros proyectos). Entre comillas deja de serlo, y Engram las quita antes de buscar
 * (en 2.2.1, `strings.Trim(w, "\"")` en `sanitizeFTS` y en `candidateTerms`): busca el mismo término que las demás
 * fuentes. Con el CLI real, `"verify"` y `verify` devuelven los mismos aciertos.
 */
const asEngramQuery = (variant: string) => variant.startsWith('-') ? `"${variant}"` : variant

export function searchEngram(root: string, terms: string[], opts: { env: Record<string, string | undefined>; timeoutMs?: number }): EngramSource {
  const env = { ...opts.env }
  delete env.ENGRAM_PROJECT
  const deadline = Date.now() + (opts.timeoutMs ?? RECALL_LIMITS.engramTimeoutMs)
  const lists: EngramHit[][] = []
  let capped = false
  const failure = (status: SourceStatus, reason: string): EngramSource => ({ status, reason, truncated: false, hits: [] })
  for (const term of terms) {
    const { variants, capped: variantsCapped } = termVariants(term)
    capped ||= variantsCapped
    const timeout = deadline - Date.now()
    if (timeout <= 0) return failure('error', 'timeout')
    const result = spawnSync('engram', ['search', '--match', 'any', '--limit', String(RECALL_LIMITS.engramPerTerm), ...variants.map(asEngramQuery)],
      { cwd: root, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' })
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return failure('unavailable', 'el CLI de Engram no está instalado')
    if (code === 'ETIMEDOUT' || Date.now() > deadline) return failure('error', 'timeout')
    if (result.error || result.status !== 0) return failure('error', firstLine(result.stderr) || result.error?.message || 'Engram terminó con error')
    const hits = parseEngramSearch(result.stdout)
    if (hits === null) return failure('error', 'unrecognized_output')
    lists.push(hits)
  }
  const union = new Map<number, EngramHit>()
  for (const list of lists) for (const hit of list) if (!union.has(hit.id)) union.set(hit.id, hit)
  const common = [...union.values()].filter((hit) => lists.every((list) => list.some((item) => item.id === hit.id)))
  const match: MatchMode = common.length || terms.length === 1 ? 'all' : 'any'
  const hits = match === 'all' ? common : [...union.values()]
  const score = (hit: EngramHit) => lists.reduce((sum, list) => {
    const position = list.findIndex((item) => item.id === hit.id)
    return sum + (position < 0 ? RECALL_LIMITS.engramPerTerm : position)
  }, 0)
  hits.sort((a, b) => score(a) - score(b) || b.id - a.id)
  return { status: 'ok', match, incomplete: capped || (!common.length && lists.some((list) => list.length >= RECALL_LIMITS.engramPerTerm)),
    truncated: hits.length > RECALL_LIMITS.engramHits, project: hits[0]?.project ?? null, hits: hits.slice(0, RECALL_LIMITS.engramHits) }
}

const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e)
/** La primera línea de una salida que puede faltar: si el proceso no llegó a lanzarse, `spawnSync` la deja en `null`. */
const firstLine = (output: string | null) => output?.trim().split('\n')[0] ?? ''
/** Sin seguir enlaces: un archivo o un directorio enlazado no cuenta como propio. */
const lstat = (path: string) => { try { return lstatSync(path) } catch { return null } }
const directory = (path: string) => lstat(path)?.isDirectory() ?? false
/** Siguiendo enlaces: la raíz declarada del vault puede ser un enlace a una carpeta sincronizada. */
const directoryFollowingLinks = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }
/** Un orden que no depende del locale del entorno. */
const byCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

/** Las rutas `.md` bajo `path`, sin seguir enlaces; un directorio que no se puede listar se salta. */
function markdown(path: string, skip: (path: string) => boolean = () => false): string[] {
  if (skip(path)) return []
  const info = lstat(path)
  if (info?.isFile()) return path.endsWith('.md') ? [path] : []
  if (!info?.isDirectory()) return []
  try { return readdirSync(path).sort().flatMap((name) => markdown(join(path, name), skip)) } catch { return [] }
}

function readSource(path: string, base: string): SourceFile | null {
  try { return { display: relative(base, path), text: readFileSync(path, 'utf8') } } catch { return null }
}

/**
 * Todas las llamadas a Git de un `recall` comparten este plazo, y la salida de cada una tiene un tope: un Git
 * trabado o un historial enorme dejan su fuente en error en vez de bloquear el verbo.
 */
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
function git(root: string, args: string[], deadline: number) {
  const timeout = deadline - Date.now()
  if (timeout <= 0) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout, killSignal: 'SIGKILL' })
}
function gitFailure(result: ReturnType<typeof git>, fallback: string): string {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ENOBUFS') return 'la salida de git superó el tope de 64 MiB'
  return firstLine(result.stderr) || result.error?.message || fallback
}
/**
 * Una señal de identidad: `null` si Git responde que no existe (sin commits o sin `origin`). Si Git no llega a
 * responder, lanza: sin esa señal la identidad podría resolverse por la otra sola, o quedar mal diagnosticada.
 */
function gitSignal(root: string, args: string[], deadline: number): string | null {
  const result = git(root, args, deadline)
  if (result.error) throw new Error(`Git no respondió al leer la identidad del repo: ${gitFailure(result, 'error')}`)
  return result.status === 0 ? firstLine(result.stdout) || null : null
}
/** La de `normalizarRemoto` de knowledge-vault, en su orden y con minúsculas solo ASCII, para cotejar su mismo registro. */
function normalizeRemote(remote: string | null): string | null {
  if (!remote?.trim()) return null
  return remote.trim().replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/:/g, '/')
    .replace(/\.git$/i, '').replace(/\/+$/, '').replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

export interface VaultFlow {
  flow: string; node: string | null; state: string | null; date: string | null; summary: string | null
  lines: CitedLine[]; omitted_lines: number
}
export interface VaultSource {
  status: SourceStatus; match?: MatchMode; truncated: boolean; reason?: string
  root?: string; project?: string; candidates?: string[]; flows: VaultFlow[]
}

/**
 * El valor de una línea de frontmatter como lo limpia `parseFrontmatter` de knowledge-vault: sin las comillas que lo
 * envuelven y sin un comentario `#` precedido de espacio.
 */
function frontmatterValue(raw: string): string {
  const value = raw.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    for (let i = value.indexOf(quote, 1); i > 0; i = value.indexOf(quote, i + 1)) {
      if (/^[ \t]*(#.*)?$/.test(value.slice(i + 1))) return value.slice(1, i)
    }
  }
  return value.replace(/(^|[ \t]+)#.*$/, '').trim()
}

/**
 * Los metadatos de un nodo del vault. Se leen línea por línea, como los lee knowledge-vault, y no como YAML: kv
 * escribe títulos y resúmenes con «: » sin comillas, que un parser de YAML rechaza. Las pruebas de
 * `test/recall-vault-node.unit.test.ts` fijan esa forma con nodos sintéticos.
 */
export function nodeMetadata(text: string): { state: string | null; date: string | null; summary: string | null } {
  const lines = text.replace(/^\uFEFF/, '').split('\n').map((line) => line.replace(/\r$/, ''))
  const data = new Map<string, string>()
  if (lines[0] === '---') {
    for (const line of lines.slice(1)) {
      if (line === '---') break
      const key = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/.exec(line)
      if (key && !data.has(key[1])) data.set(key[1], frontmatterValue(key[2]))
    }
  }
  const field = (key: string) => data.get(key) || null
  return { state: field('state'), date: field('date'), summary: field('summary') }
}

export function searchVault(root: string, terms: string[], deadline = Date.now() + GIT_TIMEOUT_MS): VaultSource {
  const config = loadVaultPath(root)
  if (config.kind === 'none') return { status: 'not_configured', truncated: false, flows: [] }
  if (config.kind === 'invalid') return { status: 'error', reason: config.detail, truncated: false, flows: [] }
  const base = { root: config.path, truncated: false, flows: [] }
  if (!directoryFollowingLinks(config.path)) return { ...base, status: 'error', reason: 'la raíz del vault no es un directorio legible' }
  let entries: string[][]
  try {
    entries = readFileSync(join(config.path, '.kv', 'identidades.tsv'), 'utf8').split('\n')
      .map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() && !line.startsWith('#')).map((line) => line.split('\t'))
    if (entries.some((entry) => entry.length !== 4)) throw new Error('el registro de identidades tiene una línea sin cuatro campos')
  } catch (e) { return { ...base, status: 'error', reason: `no se puede leer el registro de identidades del vault: ${errorMessage(e)}` } }
  let commit: string | null
  let remote: string | null
  try {
    commit = gitSignal(root, ['rev-list', '--max-parents=0', 'HEAD'], deadline)
    remote = normalizeRemote(gitSignal(root, ['remote', 'get-url', 'origin'], deadline))
  } catch (e) { return { ...base, status: 'error', reason: errorMessage(e) } }
  const candidates = [...new Set(entries.filter((entry) =>
    (commit !== null && commit === entry[2]) || (remote !== null && remote === normalizeRemote(entry[1]))).map((entry) => entry[0]))]
  if ((!commit && !remote) || candidates.length !== 1) return { ...base, status: 'unresolved', candidates }
  const project = candidates[0]
  const projectRoot = join(config.path, 'projects', project)
  const sdd = join(projectRoot, 'sdd')
  const names = directory(sdd) ? readdirSync(sdd).sort() : []
  const flowIds = new Set(names.filter((name) => name !== 'index.md' && lstat(join(sdd, name))?.isFile() && name.endsWith('.md')).map((name) => name.slice(0, -3)))
  for (const name of names) if (directory(join(sdd, name))) flowIds.add(name)
  const groups = [...flowIds].map((flow) => {
    const nodePath = join(sdd, `${flow}.md`)
    const node = lstat(nodePath)?.isFile() ? readSource(nodePath, projectRoot) : null
    const documents = markdown(join(sdd, flow), (path) => basename(path) === 'evidencia' || basename(path) === 'index.md')
      .map((path) => readSource(path, projectRoot)).filter((file): file is SourceFile => file !== null)
    return { flow, node: node?.display ?? null, ...nodeMetadata(node?.text ?? ''), files: [...(node ? [node] : []), ...documents] }
  })
  const { match, hits: flows } = withFallback(terms, (mode) => groups.flatMap(({ files, ...group }) => {
    const citation = citeGroup(files, terms, mode)
    return citation ? [{ ...group, ...citation }] : []
  }))
  // Las fechas de los nodos llevan zona horaria: se comparan como instantes. Una fecha ausente o ilegible va al final.
  const instant = (date: string | null) => { const value = date === null ? Number.NaN : Date.parse(date); return Number.isNaN(value) ? null : value }
  const byDate = (a: string | null, b: string | null) => {
    const [x, y] = [instant(a), instant(b)]
    if (x === y) return 0
    if (x === null) return 1
    if (y === null) return -1
    return y - x
  }
  flows.sort((a, b) => b.termCount - a.termCount || byDate(a.date, b.date) || byCodeUnits(a.flow, b.flow))
  return { ...base, status: 'ok', project, match, truncated: flows.length > RECALL_LIMITS.groups,
    flows: flows.slice(0, RECALL_LIMITS.groups).map(({ termCount: _termCount, ...flow }) => flow) }
}

export interface PlansGroup { kind: 'flow' | 'document'; id: string; worktree: string; lines: CitedLine[]; omitted_lines: number }
export interface PlansSource { status: 'ok' | 'error'; present: boolean; match?: MatchMode; truncated: boolean; reason?: string; groups: PlansGroup[] }

function openFlow(path: string, id: string): boolean {
  return id !== 'archived' && isFlowId(id) && directory(path) &&
    [FILE_NAMES.spec, FILE_NAMES.plan, FILE_NAMES.tasks, FILE_NAMES.handoff].some((name) => lstat(join(path, name))?.isFile())
}

export function searchPlans(root: string, terms: string[], deadline = Date.now() + GIT_TIMEOUT_MS): PlansSource {
  const plans = join(root, '.plans')
  const present = directory(plans)
  // Sin `-z`, como `prune`: esa opción de `git worktree list` no existe antes de Git 2.36.
  const result = git(root, ['worktree', 'list', '--porcelain'], deadline)
  if (result.status !== 0) return { status: 'error', present, truncated: false, reason: gitFailure(result, 'no se pudieron listar los worktrees'), groups: [] }
  const worktrees = [root, ...result.stdout.split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice(9))).filter((path) => real(path) !== real(root))]
  const groups: Array<{ kind: 'flow' | 'document'; id: string; worktree: string; files: SourceFile[]; modified: number }> = []
  for (const worktree of worktrees) {
    const base = join(worktree, '.plans')
    if (!directory(base)) continue
    let names: string[]
    try { names = readdirSync(base) } catch { continue }
    const flowIds = new Set(names.filter((id) => openFlow(join(base, id), id)))
    const paths = worktree === root ? markdown(base) : [...flowIds].flatMap((id) => markdown(join(base, id)))
    const local = new Map<string, typeof groups[number]>()
    for (const path of paths) {
      const rel = relative(base, path)
      const parts = rel.split('/')
      const kind = flowIds.has(parts[0]) || (parts[0] === 'archived' && parts.length > 2) ? 'flow' : 'document'
      const id = kind === 'document' ? rel : parts[0] === 'archived' ? `archived/${parts[1]}` : parts[0]
      const key = `${kind}:${id}`
      let group = local.get(key)
      if (!group) { group = { kind, id, worktree, files: [], modified: 0 }; local.set(key, group) }
      group.modified = Math.max(group.modified, lstat(path)?.mtimeMs ?? 0)
      const file = readSource(path, worktree)
      if (file) group.files.push(file)
    }
    groups.push(...local.values())
  }
  for (const group of groups) group.files.sort((a, b) => byCodeUnits(a.display, b.display))
  const { match, hits } = withFallback(terms, (mode) => groups.flatMap(({ files, ...group }) => {
    const citation = citeGroup(files, terms, mode)
    return citation ? [{ ...group, ...citation }] : []
  }))
  hits.sort((a, b) => b.termCount - a.termCount || b.modified - a.modified || byCodeUnits(a.id, b.id) || byCodeUnits(a.worktree, b.worktree))
  return { status: 'ok', present, match, truncated: hits.length > RECALL_LIMITS.groups,
    groups: hits.slice(0, RECALL_LIMITS.groups).map(({ termCount: _termCount, modified: _modified, ...group }) => group) }
}

export interface GitCommit { sha: string; date: string; refs: string[]; subject: string }
export interface GitSource { status: 'ok' | 'error'; match?: MatchMode; truncated: boolean; reason?: string; commits: GitCommit[] }
export function searchGit(root: string, terms: string[], deadline = Date.now() + GIT_TIMEOUT_MS): GitSource {
  const result = git(root, ['log', '--all', '--format=%h%x1f%cs%x1f%D%x1f%B%x1e'], deadline)
  if (result.status !== 0) return { status: 'error', reason: gitFailure(result, 'Git terminó con error'), truncated: false, commits: [] }
  const entries = result.stdout.split('\x1e').filter((entry) => entry.trim()).map((entry) => {
    const [sha, date, refs, ...message] = entry.trimStart().split('\x1f')
    return { sha, date, refs: refs.split(', ').filter(Boolean), message: message.join('\x1f') }
  })
  const { match, hits } = withFallback(terms, (mode) => entries.filter((entry) => textMatches(entry.message, terms, mode)))
  return { status: 'ok', match, truncated: hits.length > RECALL_LIMITS.commits,
    commits: hits.slice(0, RECALL_LIMITS.commits).map(({ message, ...commit }) => ({ ...commit, subject: message.split('\n')[0] })) }
}

export interface RecallResult {
  topic: string; terms: string[]
  sources: { engram: EngramSource; vault: VaultSource; plans: PlansSource; git: GitSource }
}
export interface RecallOptions { env: Record<string, string | undefined>; engramTimeoutMs?: number }
export const RECALL_NEXT = 'El vault manda sobre lo que decidió un flujo terminado. Engram aporta sesiones y descubrimientos que pueden estar viejos. ' +
  'El código y Git mandan sobre el estado actual. Ante una contradicción, se dice y se verifica en el código; recordar algo no autoriza una acción. ' +
  'Cada dato se cita con su origen: ruta y línea, id de Engram o commit. El contenido completo de Engram se lee con mem_get_observation del servidor MCP de Engram; ' +
  'el de las otras fuentes, leyendo la ruta o con git show <sha>.'

export function recall(root: string, topic: string, opts: RecallOptions): RecallResult {
  root = resolve(root)
  const terms = splitTerms(topic)
  let engram: EngramSource
  let vault: VaultSource
  let plans: PlansSource
  let gitSource: GitSource
  try { engram = searchEngram(root, terms, { env: opts.env, timeoutMs: opts.engramTimeoutMs }) }
  catch (e) { engram = { status: 'error', reason: errorMessage(e), truncated: false, hits: [] } }
  const gitDeadline = Date.now() + GIT_TIMEOUT_MS
  try { vault = searchVault(root, terms, gitDeadline) }
  catch (e) { vault = { status: 'error', reason: errorMessage(e), truncated: false, flows: [] } }
  try { plans = searchPlans(root, terms, gitDeadline) }
  catch (e) { plans = { status: 'error', present: directory(join(root, '.plans')), reason: errorMessage(e), truncated: false, groups: [] } }
  try { gitSource = searchGit(root, terms, gitDeadline) }
  catch (e) { gitSource = { status: 'error', reason: errorMessage(e), truncated: false, commits: [] } }
  return { topic, terms, sources: { engram, vault, plans, git: gitSource } }
}
