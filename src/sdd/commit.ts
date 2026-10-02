import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, candidateFingerprint, currentBranch, entryDiff, gitDirs, headCommit, indexEntries, indexEnv } from '../git.ts'
import { flowReview, flowReviewBacking, reviewStartCommand, shellArg } from '../review/standing.ts'
import { SddError } from '../types.ts'
import { flowWriterOpen, readHarvest, readReservation, readTakeoverMap, releaseWriter, reserveWriter, runEntries } from '../writer-store.ts'
import { isFlowId } from './id.ts'
import { readHeader, section, setHeaderStatus } from './markdown.ts'
import { type CommitDone, type CommitIntent, type CommitRecord, type PhaseRecord, activeRun, implementOf, latestFinalReceipt, readPhaseRecord, withFlowLock, writeCommitRecord } from './phase-state.ts'
import { type FlowRead, flowDir, readFlow } from './read.ts'
import { restoreIntentOpen } from './restore.ts'
import { type Next, headerData, resolve } from './status.ts'
import { writeTextAtomic } from './verify.ts'
import { readVerifyReceipt } from './verify-receipt.ts'

export const CHANGE_TYPES = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'perf'] as const
/** Un sha de commit completo: 40 hex con SHA-1 o 64 con SHA-256, en minúscula, como lo escribe Git. */
export const isCommitSha = (v: unknown): v is string => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)
export interface MessageInput { changeType: unknown; flowId: string; branch: string | null; subject: string; plan: string }

export function commitMessage(m: MessageInput): string {
  if (!(CHANGE_TYPES as readonly unknown[]).includes(m.changeType)) throw new SddError('change_type_invalid', 'change_type no es un tipo de commit admitido', {
    next: `corrige change_type en el header del plan y del handoff: ${CHANGE_TYPES.join(' | ')}`,
  })
  const ticket = /^[A-Z][A-Z0-9]+-\d+$/.test(m.flowId) ? m.flowId : m.branch?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0]
  const first = `${m.changeType}${ticket ? `(${ticket})` : ''}: ${m.subject}`
  if (!m.subject.trim() || /[\r\n]/.test(m.subject) || /^\p{Lu}/u.test(m.subject) || [...first].length >= 72) {
    throw new SddError('subject_invalid', 'el asunto debe ser una sola línea, no vacía, con inicial minúscula y una primera línea de menos de 72 caracteres')
  }
  const h = readHeader(m.plan)
  const extras = (section(h.ok ? h.body : m.plan, 'Extras (fuera de AC)') ?? '').split('\n').filter((l) => /^- E-?\d+\b/.test(l))
  return `${first}${extras.length ? `\n\n${extras.join('\n')}` : ''}\n`
}

export interface DigestInput {
  flow: string; base: string; entries: ReadonlyArray<readonly [string, string | null]>; message: string
  receipt: { id: string; digest: string }; review: string
}

export function commitDigest(d: DigestInput): string {
  const canonical = { flow: d.flow, base: d.base, entries: [...d.entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), message: d.message, receipt: { id: d.receipt.id, digest: d.receipt.digest }, review: d.review }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

const commitCommand = (id: string, subject: string, digest?: string) => `./bin/sdd-ai sdd commit ${id} --subject ${shellArg(subject)}${digest ? ` --apply --digest ${digest}` : ''}`
// El tope por defecto de execFileSync es 1 MiB; un `diff-tree` o un `reflog` de un repositorio grande lo
// supera, y cortar esa salida haría que el verbo decida con información parcial.
const GIT_MAX_BUFFER = 256 * 1024 * 1024
const git = (root: string, args: string[], env?: NodeJS.ProcessEnv, input?: Buffer | string) => execFileSync('git', args, {
  cwd: root, env: { ...process.env, ...env }, input, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'],
})
const rev = (root: string, ref: string) => git(root, ['rev-parse', ref]).trim()
const messageOf = (root: string, commit: string) => git(root, ['log', '-1', '--format=%B', commit]).replace(/\n+$/, '\n')
const nextOf = (root: string, id: string) => resolve(readFlow(root, id).facts).next
const excluded = (p: string) => ['.plans/', '.specify/', '.cross-model/', '.sdd-ai/'].some((prefix) => p.startsWith(prefix))
type Origin = { kind: 'run' | 'takeover'; id: string } | { kind: 'unattributed' }
interface CommitPath { path: string; status: 'A' | 'D' | 'M'; origin: Origin; sensitive?: true }
/** Lo aprobado en el ensayo, sin lo que fija recién la aplicación: el padre, el árbol esperado y la fecha. */
type Approved = Omit<CommitIntent, 'state' | 'at' | 'parent' | 'tree'>
/**
 * De dónde sale el reconocimiento de un commit ya hecho: el registro en `done`, la intención que dejó una
 * aplicación cortada, o el contenido y el mensaje aprobados de un commit sin registro (por ejemplo, a mano).
 */
type Recognition = { source: 'done'; record: CommitDone } | { source: 'intent'; record: CommitIntent }
  | { source: 'content'; record: Omit<CommitDone, 'state' | 'sha' | 'at'> }
interface CommitPlan {
  output: Record<string, unknown>; entries: Array<[string, string | null]>; paths: CommitPath[]; message: string; digest: string
  approved: Approved | null; recognition: Recognition | null; pending: string[]
}

/** El flujo con su plan y lo que el commit lee del header; rechaza un id inválido, un flujo sin plan o sin base. */
function commitFlow(root: string, id: string, subject: string): { read: FlowRead; header: Record<string, unknown> | null; base: string; message: string } {
  if (!isFlowId(id)) throw new SddError('flow_not_found', `no existe el flujo ${id}`)
  const read = readFlow(root, id)
  if (read.facts.files.plan === 'absent') throw new SddError('flow_not_found', `el flujo ${id} no tiene plan.md`, { next: `./bin/sdd-ai sdd status ${id}` })
  const header = headerData(read.facts.planHeader)
  const plan = readFileSync(join(flowDir(root, id), 'plan.md'), 'utf8')
  const message = commitMessage({ changeType: header?.change_type, flowId: typeof header?.id === 'string' ? header.id : id,
    branch: typeof header?.branch === 'string' ? header.branch : currentBranch(root), subject, plan })
  const base = header?.base_commit
  if (!isCommitSha(base)) {
    throw new SddError('plan_invalid', 'el header del plan no declara un base_commit con forma de sha completo', {
      next: 'escribe en base_commit el sha completo de la base (40 o 64 caracteres hex en minúscula) y vuelve a aprobar el plan',
    })
  }
  return { read, header, base, message }
}

function origins(root: string, id: string, record: PhaseRecord): Map<string, Origin> {
  const out = new Map<string, Origin>()
  const maps = new Map<string, Map<string, string>>()
  for (const chain of implementOf(record).chains) {
    for (const e of chain.entries) {
      try {
        if (e.kind === 'takeover') {
          const map = readTakeoverMap(root, e.map)
          const parent = e.parent ? maps.get(e.parent) : null
          if (map && parent) for (const p of entryDiff(parent, map, id)) out.set(p, { kind: 'takeover', id: e.id })
          if (map) maps.set(e.id, map)
        } else {
          const harvest = readHarvest(root, e.run)
          for (const p of harvest?.delta ?? []) out.set(p, { kind: 'run', id: e.run })
          const map = runEntries(root, e.run)
          if (map) maps.set(e.run, map)
        }
      } catch {
        // La atribución es informativa: un almacén retirado no impide el ensayo.
      }
    }
  }
  return out
}

function scratch<T>(fn: (dir: string, index: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-commit-'))
  try { return fn(dir, join(dir, 'index')) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function updateEntries(root: string, entries: Array<[string, string | null]>, env: NodeJS.ProcessEnv): void {
  if (entries.length) git(root, ['update-index', '-z', '--index-info'], env,
    entries.map(([path, value]) => `${value ?? `0 ${'0'.repeat(40)}`}\t${path}\0`).join(''))
}

/** El árbol del padre con las rutas del candidato aplicadas, en el índice de `env`: el mismo cálculo para el commit y el reconocimiento. */
function treeOn(root: string, parent: string, entries: Array<[string, string | null]>, env: NodeJS.ProcessEnv): string {
  git(root, ['read-tree', parent], env)
  updateEntries(root, entries, env)
  return git(root, ['write-tree'], env).trim()
}

/** Reconstruye contra un padre sin escribir objetos ni índices en Git. */
function candidateTree(root: string, base: string, parent: string, entries: Array<[string, string | null]>): string {
  return scratch((_dir, index) => {
    const checkout = { root, gitDir: gitDirs(root).gitDir }
    buildIndex(checkout, base, index)
    return treeOn(root, parent, entries, indexEnv(checkout, index))
  })
}

/**
 * El commit del flujo, si `head` ya lo es. Las tres fuentes comparan contra lo aprobado: el sha del registro,
 * la intención (padre, árbol y mensaje) o, sin registro, el contenido verificado y revisado de ahora.
 */
function recognize(root: string, id: string, base: string, head: string, record: PhaseRecord, names: string[],
  entries: Array<[string, string | null]>, message: string): Recognition | null {
  const c = record.commit
  if (c?.state === 'done') return c.sha === head ? { source: 'done', record: c } : null
  const headParent = (() => {
    try {
      return rev(root, `${head}^`)
    } catch {
      return null
    }
  })()
  if (headParent === null) return null
  const headTree = rev(root, `${head}^{tree}`)
  const headMessage = messageOf(root, head)
  if (c?.state === 'intent') {
    if (headParent === c.parent && headTree === c.tree && headMessage === c.message) return { source: 'intent', record: c }
  }
  // Sin registro que coincida: primero lo barato (mensaje y rutas), después el respaldo del contenido.
  if (names.length === 0 || headMessage !== message) return null
  const ref = latestFinalReceipt(record)
  if (!ref) return null
  try {
    const receipt = readVerifyReceipt(root, ref)
    if (receipt.flow !== id || !receipt.green) return null
    const now = candidateFingerprint(root, id, base)
    if (receipt.after.base_commit !== now.base_commit || receipt.after.tree !== now.tree) return null
    if (candidateTree(root, base, headParent, entries) !== headTree) return null
    const backing = flowReviewBacking(root, id, base)
    if (!backing.ok) return null
    const receiptRef = { id: ref.id, digest: ref.digest }
    const digest = commitDigest({ flow: id, base, entries, message, receipt: receiptRef, review: backing.review.id })
    return { source: 'content', record: { parent: headParent, tree: headTree, message, paths: names, digest, receipt: receiptRef, review: backing.review.id } }
  } catch {
    // Sin respaldo del mismo contenido, se aplican las precondiciones normales.
    return null
  }
}

function computeCommit(root: string, id: string, subject: string, o: { own?: string; head?: string } = {}): CommitPlan {
  const { read, header, base, message } = commitFlow(root, id, subject)
  if (restoreIntentOpen(root)) throw new SddError('restore_pending', 'hay una restauración de verify pendiente', { next: `./bin/sdd-ai sdd status ${id}` })
  const record = readPhaseRecord(root, id)
  const reservation = readReservation(root)
  if ((reservation && reservation.id !== o.own) || flowWriterOpen(root, id) || activeRun(root, record)) {
    throw new SddError('writer_open', 'hay un writer o una verificación en vuelo', { next: 'espera a que termine antes de commitear' })
  }
  const before = indexEntries(root, base, { kind: 'base' })!
  const current = indexEntries(root, base, { kind: 'current' })!
  const names = entryDiff(before, current, id).filter((p) => !excluded(p))
  const entries: Array<[string, string | null]> = names.map((p) => [p, current.get(p) ?? null])
  const attribution = origins(root, id, record)
  const paths: CommitPath[] = names.map((path) => ({ path, status: !before.has(path) ? 'A' : !current.has(path) ? 'D' : 'M',
    origin: attribution.get(path) ?? { kind: 'unattributed' },
    ...(['.claude/', '.codex/', '.agents/'].some((p) => path.startsWith(p)) ? { sensitive: true as const } : {}) }))
  const head = o.head ?? headCommit(root)!
  const recognition = recognize(root, id, base, head, record, names, entries, message)
  if (recognition) {
    const pending = [...(recognition.source === 'done' ? [] : ['index', 'registry']), ...(header?.status !== 'committed' ? ['header'] : [])]
    return { entries, paths, message: recognition.record.message, digest: recognition.record.digest, approved: null, recognition, pending,
      output: { state: 'already_committed', sha: head, digest: recognition.record.digest, pending,
        next: pending.length ? commitCommand(id, subject, recognition.record.digest) : nextOf(root, id) } }
  }
  const status = resolve(read.facts)
  if (status.next.step !== 'review_and_commit') throw new SddError('step_not_commit', `el paso es ${status.next.step}, no review_and_commit`, { next: `./bin/sdd-ai sdd status ${id}` })
  if (read.facts.contract !== 'structured') throw new SddError('contract_prose', 'el contrato en prosa no tiene recibo', { next: 'haz el commit a mano tras revisar y pedir el permiso del usuario' })
  const ref = latestFinalReceipt(record)
  if (read.facts.receipt !== 'valid' || !ref) throw new SddError('receipt_invalid', 'falta un recibo final válido', { next: `./bin/sdd-ai sdd verify ${id}` })
  const review = flowReview(root, id, base)
  if (!review.ok) throw new SddError('review_missing', 'falta una revisión convergida y vigente del flujo', {
    detail: `${review.reason}${review.latest ? `: ${review.latest}` : ''}`, next: reviewStartCommand(id, base),
  })
  const headEntries = indexEntries(root, head, { kind: 'base' })!
  if (!entries.some(([p, value]) => (headEntries.get(p) ?? null) !== value)) throw new SddError('nothing_to_commit', 'el candidato no cambia ninguna ruta de HEAD', { next: `./bin/sdd-ai sdd status ${id}` })
  const receipt = { id: ref.id, digest: ref.digest }
  const digest = commitDigest({ flow: id, base, entries, message, receipt, review: review.review.id })
  return { entries, paths, message, digest, recognition: null, pending: [],
    approved: { message, paths: names, digest, receipt, review: review.review.id },
    output: { state: 'dry_run', flow: id, paths, message, receipt, review: review.review, digest, next: commitCommand(id, subject, digest) } }
}

export function planCommit(root: string, id: string, subject: string): Record<string, unknown> {
  return computeCommit(root, id, subject).output
}

function probeGit(root: string): void {
  const { gitDir, commonDir } = gitDirs(root)
  for (const dir of new Set([gitDir, join(commonDir, 'objects'), join(commonDir, 'refs')])) {
    const probe = join(dir, `sdd-ai-commit-probe-${process.pid}-${randomBytes(4).toString('hex')}`)
    try {
      writeFileSync(probe, '', { flag: 'wx' })
      unlinkSync(probe)
    } catch {
      throw new SddError('git_unwritable', 'no se puede escribir en el directorio de Git', {
        next: 'repite el mismo comando pidiendo salir del sandbox (escalada); si el usuario no la aprueba, el commit lo hace él desde su terminal',
      })
    }
  }
}

function syncIndex(root: string, sha: string, paths: string[]): void {
  scratch((dir) => {
    const file = join(dir, 'paths')
    writeFileSync(file, paths.map((p) => `${p}\0`).join(''))
    git(root, ['--literal-pathspecs', 'reset', '-q', sha, `--pathspec-from-file=${file}`, '--pathspec-file-nul'])
  })
}

/** Completa lo que falte después de un commit del flujo: el índice real, el registro `done` y el header. */
function finishCommit(root: string, id: string, sha: string, recognition: Recognition): void {
  if (recognition.source !== 'done') {
    syncIndex(root, sha, recognition.record.paths)
    const r = recognition.record
    writeCommitRecord(root, id, { state: 'done', at: 'at' in r ? r.at : new Date().toISOString(), digest: r.digest, parent: r.parent, tree: r.tree,
      message: r.message, paths: r.paths, receipt: r.receipt, review: r.review, sha })
  }
  const plan = join(flowDir(root, id), 'plan.md')
  const text = readFileSync(plan, 'utf8')
  if (headerData(readHeader(text))?.status !== 'committed') writeTextAtomic(plan, setHeaderStatus(text, 'committed'))
}

/** `finishCommit` con el commit ya creado: una falla acá no lo deshace, y repetir el `--apply` la completa. */
function finishOrExplain(root: string, id: string, subject: string, sha: string, digest: string, recognition: Recognition): void {
  try {
    finishCommit(root, id, sha, recognition)
  } catch (e) {
    throw new SddError('commit_incomplete', `el commit ${sha} existe, pero no se completó el índice, el registro o el header`, {
      detail: (e as Error).message, next: `repite el mismo comando para completarlo: ${commitCommand(id, subject, digest)}`,
    })
  }
}

/** Cuántas entradas del reflog se leen para buscar las de este intento: son las últimas, y un hook no hace cientos. */
const REFLOG_WINDOW = 256

/**
 * Los commits del reflog de HEAD cuya entrada lleva la marca de este intento. El nonce es único, así que alcanza con
 * las últimas entradas. Una falla de lectura se informa: tratarla como «sin marca» culparía a un avance ajeno.
 */
function markedCommits(root: string, nonce: string): Set<string> {
  let out: string
  try {
    out = git(root, ['reflog', 'show', `-n${REFLOG_WINDOW}`, '--format=%H%x00%gs', 'HEAD'])
  } catch (e) {
    throw new SddError('reflog_unreadable', 'no se pudo leer el reflog para saber qué commits creó el intento', {
      detail: (e as Error).message, next: 'revisa el historial con el usuario antes de seguir; la intención del registro queda para reconocer el commit',
    })
  }
  return new Set(out.split('\n').filter(Boolean).map((l) => l.split('\0'))
    .filter(([, action]) => action?.startsWith(`sdd-ai commit ${nonce}:`)).map(([sha]) => sha))
}

/**
 * Los commits entre HEAD y `parent` por primer padre, si todos llevan la marca de este intento: son del verbo o
 * de un hook que corrió dentro del mismo `git commit`. `null` si aparece uno sin la marca (un avance ajeno, que
 * nunca se deshace) o si la cadena no llega a `parent`. Vacío si HEAD sigue en `parent`.
 */
function attemptChain(root: string, parent: string, marked: Set<string>): string[] | null {
  const chain: string[] = []
  let c = headCommit(root)
  while (c !== parent) {
    if (!c || !marked.has(c)) return null
    chain.push(c)
    try {
      c = rev(root, `${c}^`)
    } catch {
      return null
    }
  }
  return chain
}

/** La rama a la que apunta HEAD, o `null` con HEAD separado. */
function headRef(root: string): string | null {
  try {
    return git(root, ['symbolic-ref', '-q', 'HEAD']).trim() || null
  } catch {
    return null
  }
}

/** El `next` de una salida que no movió ninguna referencia: dice si la intención quedó en el registro. */
function untouchedNext(marked: Set<string>): string {
  return marked.size > 0
    ? 'revisa el historial con el usuario antes de seguir; la intención del registro queda para reconocer el commit del intento'
    : 'revisa el historial con el usuario antes de seguir; no quedó ningún commit del intento y el registro volvió a como estaba'
}

/** Qué difiere el commit del verbo de lo aprobado: rutas contra el árbol esperado y el mensaje. Vacío si no se puede leer. */
function differences(root: string, verbCommit: string, tree: string, message: string): string[] {
  try {
    const changed = git(root, ['diff-tree', '-r', '--name-only', '-z', tree, `${verbCommit}^{tree}`]).split('\0').filter(Boolean)
    return messageOf(root, verbCommit) === message ? changed : [...changed, 'message']
  } catch {
    return []
  }
}

export function applyCommit(root: string, id: string, subject: string, digest: string): Record<string, unknown> {
  // El mensaje y el flujo se validan antes incluso de las comprobaciones de escritura.
  commitFlow(root, id, subject)
  probeGit(root)
  return withFlowLock(root, id, () => {
    const reservation = `commit-${id}`
    const reserved = reserveWriter(root, reservation, 'commit')
    if (!reserved.ok) throw new SddError('writer_open', `el repositorio está reservado por ${reserved.holder}`, { next: 'espera a que termine antes de commitear' })
    try {
      // El HEAD que fija esta aplicación. Si hay que commitear, es el padre del commit; si ya está hecho, es ese commit.
      const pinned = headCommit(root)!
      const draft = computeCommit(root, id, subject, { own: reservation, head: pinned })
      if (digest !== draft.digest) throw new SddError('digest_mismatch', 'el digest no coincide con el ensayo actual', { next: commitCommand(id, subject) })
      if (draft.recognition) {
        finishOrExplain(root, id, subject, pinned, draft.digest, draft.recognition)
        return { state: 'already_committed', sha: pinned, digest: draft.digest, next: nextOf(root, id) }
      }
      return scratch((dir, index) => commitOnce(root, id, subject, pinned, draft, dir, index))
    } finally {
      releaseWriter(root, reservation)
    }
  })
}

/**
 * El commit con el índice propio sobre `parent`. Si no queda nada de este intento en el historial, el registro vuelve
 * a como estaba antes; si queda algo que no se pudo deshacer, la intención se conserva para reconocerlo después.
 */
function commitOnce(root: string, id: string, subject: string, parent: string, draft: CommitPlan, dir: string, index: string): Record<string, unknown> {
  const env = { GIT_INDEX_FILE: index }
  git(root, ['read-tree', parent], env)
  for (const [path, value] of draft.entries) {
    if (value === null) continue
    const [mode, expected] = value.split(' ')
    const bytes = mode === '120000' ? Buffer.from(readlinkSync(join(root, path))) : readFileSync(join(root, path))
    const sha = git(root, ['hash-object', '-w', '--no-filters', '--stdin'], env, bytes).trim()
    if (sha !== expected) throw new SddError('digest_mismatch', `cambió ${path} desde el ensayo`, { next: commitCommand(id, subject) })
  }
  const tree = treeOn(root, parent, draft.entries, env)
  const previous = readPhaseRecord(root, id).commit
  if (previous?.state === 'intent' && previous.parent !== parent) throw new SddError('intent_stale', 'hay una intención de commit de otro padre', {
    detail: `parent: ${previous.parent}; tree: ${previous.tree}`, next: 'revisa el historial con el usuario antes de seguir',
  })
  const intent: CommitIntent = { ...draft.approved!, state: 'intent', at: new Date().toISOString(), parent, tree }
  writeCommitRecord(root, id, intent)
  let done = false
  let ran = false
  let undone = false
  // Los commits con la marca de este intento, si se llegaron a leer: vacío prueba que no quedó ninguno.
  let marked: Set<string> | null = null
  try {
    if (headCommit(root) !== parent) throw new SddError('head_moved', 'HEAD cambió antes del commit', { next: commitCommand(id, subject) })
    const branch = headRef(root)
    const file = join(dir, 'message')
    writeFileSync(file, draft.message)
    const nonce = randomBytes(8).toString('hex')
    ran = true
    const result = spawnSync('git', ['-c', 'core.logAllRefUpdates=true', 'commit', '--file', file, '--cleanup=verbatim'], {
      cwd: root, env: { ...process.env, ...env, GIT_REFLOG_ACTION: `sdd-ai commit ${nonce}` }, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER,
    })
    const gitError = `${result.stderr || result.error?.message || ''}`
    const head = headCommit(root)!
    if (headRef(root) !== branch) {
      // Un hook cambió de rama: deshacer sobre HEAD movería otra rama. No se toca nada; las marcas dicen si quedó
      // un commit del intento, y con él la intención.
      marked = markedCommits(root, nonce)
      throw new SddError('commit_altered', 'un hook cambió la rama de HEAD durante el commit: no se movió ninguna referencia', {
        detail: `${gitError}; antes: ${branch ?? 'HEAD separado'}; ahora: ${headRef(root) ?? 'HEAD separado'} en ${head}`,
        next: untouchedNext(marked),
      })
    }
    // Los hooks heredan GIT_REFLOG_ACTION: lo marcado es todo lo que hizo este intento, propio o de un hook.
    marked = markedCommits(root, nonce)
    const chain = attemptChain(root, parent, marked)
    if (chain === null) {
      throw new SddError('commit_failed', 'HEAD avanzó con commits que no son de este intento: no se movió ninguna referencia', {
        detail: `${gitError}; HEAD: ${head}`, next: untouchedNext(marked),
      })
    }
    if (chain.length === 0) throw new SddError('commit_failed', 'Git no creó el commit del flujo', { detail: gitError, next: commitCommand(id, subject) })
    // El commit del verbo es el más viejo de la cadena: el único cuyo padre es `parent`.
    const verbCommit = chain[chain.length - 1]
    const exact = result.status === 0 && chain.length === 1 && rev(root, `${verbCommit}^{tree}`) === tree && messageOf(root, verbCommit) === draft.message
    if (!exact) {
      try {
        // Sobre la rama concreta y con el valor viejo esperado: si algo la movió mientras tanto, no se pisa.
        git(root, branch ? ['update-ref', '-m', 'sdd-ai: deshace su commit', branch, parent, head]
          : ['update-ref', '--no-deref', '-m', 'sdd-ai: deshace su commit', 'HEAD', parent, head])
        undone = true
      } catch (e) {
        throw new SddError('commit_altered', `no se pudo deshacer el commit ${head}: la rama cambió mientras tanto`, {
          detail: `${(e as Error).message}; commits del intento: ${chain.join(', ')}`,
          next: 'revisa el historial con el usuario antes de seguir; la intención del registro queda para reconocer el commit',
        })
      }
      const changed = differences(root, verbCommit, tree, draft.message)
      throw new SddError(result.status !== 0 ? 'commit_failed' : 'commit_altered', 'se deshizo lo que creó el intento: Git falló o un hook alteró el commit', {
        detail: `${gitError}; commits deshechos: ${chain.join(', ')}${changed.length ? `; diferencias: ${changed.join(', ')}` : ''}; si el hook tocó el árbol, el recibo quedó vencido`,
        next: commitCommand(id, subject),
      })
    }
    done = true
    finishOrExplain(root, id, subject, verbCommit, draft.digest, { source: 'intent', record: intent })
    return { state: 'committed', sha: verbCommit, paths: draft.paths, message: draft.message, next: nextOf(root, id) }
  } finally {
    // Sin commit de este intento (no corrió, se deshizo hasta `parent` o el reflog no tiene ninguno), el registro
    // vuelve a como estaba. Si pudo quedar uno, o no se sabe, la intención se conserva para reconocerlo después.
    if (!done && (!ran || undone || marked?.size === 0)) writeCommitRecord(root, id, previous)
  }
}

export function commitNext(root: string, id: string, next: Next): Next {
  try {
    const { facts } = readFlow(root, id)
    const base = headerData(facts.planHeader)?.base_commit
    if (facts.contract !== 'structured' || facts.receipt !== 'valid' || !isCommitSha(base)) return next
    const review = flowReview(root, id, base)
    if (!review.ok) return next
    return { ...next, command: `./bin/sdd-ai sdd commit ${id} --subject "<asunto>"`,
      detail: `la revisión ${review.review.id} está convergida y vigente; muestra el ensayo al usuario y pide su sí antes de --apply` }
  } catch {
    return next
  }
}
