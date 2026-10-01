import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type Stats, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { readBinding } from './backstop.ts'
import { gitDirs } from './git.ts'
import { tryWithLock } from './lock.ts'
import { type OpenState, runOpenness } from './open-runs.ts'
import { isRunId, readJson } from './runs.ts'
import { isFlowId } from './sdd/id.ts'
import { FILE_NAMES } from './sdd/read.ts'
import { SddError } from './types.ts'

export type UnitKind = 'run' | 'receipt' | 'attestation' | 'takeover' | 'hook_session' | 'tmp'
export type EntryKind = 'run' | 'writer_store' | 'receipt' | 'attestation' | 'takeover' | 'hook_session' | 'tmp'
export type KeepReason = 'open' | 'unreadable' | 'cited' | 'bound' | 'recent'
export interface Entry { kind: EntryKind; path: string; bytes: number }
export interface Candidate { kind: UnitKind; id: string; entries: Entry[]; review: boolean; bytes: number; fingerprint: string }
export interface Kept { kind: UnitKind; id: string; reason: KeepReason; flows?: string[]; open?: OpenState; next?: string }
export interface PruneContext { root: string; gitDir: string; keepDays: number; now: number }
export interface PrunePlan { candidates: Candidate[]; kept: Kept[]; bytes: number; digest: string }

/** La ventana por defecto, en días. */
export const DEFAULT_KEEP_DAYS = 7

const KINDS: UnitKind[] = ['run', 'receipt', 'attestation', 'takeover', 'hook_session', 'tmp']
const FLOW_FILES: Array<keyof typeof FILE_NAMES> = ['spec', 'plan', 'tasks', 'handoff']
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export function pruneContext(root: string, keepDays: number, now = Date.now()): PruneContext {
  return { root: resolve(root), gitDir: gitDirs(root).gitDir, keepDays, now }
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function bases(ctx: PruneContext) {
  const home = join(ctx.root, '.sdd-ai')
  const gitHome = join(ctx.gitDir, 'sdd-ai')
  return {
    home, runs: join(home, 'runs'), hooks: join(home, 'hooks'), route: join(home, 'hooks', 'route'), tmp: join(home, 'tmp'),
    gitHome, writers: join(gitHome, 'runs'), verify: join(gitHome, 'verify'),
    attestations: join(gitHome, 'verify', 'attestations'), takeovers: join(gitHome, 'takeovers'),
  }
}

function validateBases(ctx: PruneContext): void {
  for (const path of Object.values(bases(ctx))) {
    const stat = statOrNull(path)
    if (stat && !stat.isDirectory()) {
      throw new SddError('path_invalid', `la base no es un directorio real: ${relative(ctx.root, path)}`, {
        next: 'reemplaza la base por un directorio real antes de repetir el ensayo',
      })
    }
  }
}

const names = (path: string) => statOrNull(path) ? readdirSync(path).sort() : []
/** Un directorio o un enlace: el enlace también es una unidad, que se mide y se borra sin seguirlo. */
const directoryOrLink = (path: string) => {
  const stat = statOrNull(path)
  return stat !== null && (stat.isDirectory() || stat.isSymbolicLink())
}

/** Sin seguir enlaces: un enlace se mide y se borra como tal, nunca se recorre su destino. */
function walk(path: string, visit: (path: string, stat: Stats) => void, skip: (path: string) => boolean = () => false): void {
  if (skip(path)) return
  // Una corrida activa renombra y borra temporales: lo que desaparece a mitad del recorrido no se cuenta.
  const stat = statOrNull(path)
  if (stat === null) return
  visit(path, stat)
  if (!stat.isDirectory()) return
  let children: string[]
  try {
    children = readdirSync(path).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  for (const name of children) walk(join(path, name), visit, skip)
}

function entry(kind: EntryKind, path: string): Entry {
  let bytes = 0
  walk(path, (_, stat) => { if (stat.isFile()) bytes += stat.size })
  return { kind, path, bytes }
}

function unitEntries(ctx: PruneContext, kind: UnitKind, id: string): Entry[] {
  const b = bases(ctx)
  const entries: Entry[] = []
  const add = (entryKind: EntryKind, path: string, directory = false) => {
    if (directory ? directoryOrLink(path) : statOrNull(path) !== null) entries.push(entry(entryKind, path))
  }
  switch (kind) {
    case 'run':
      add('run', join(b.runs, id), true)
      add('writer_store', join(b.writers, id), true)
      break
    case 'receipt': add('receipt', join(b.verify, id), true); break
    case 'attestation': add('attestation', join(b.attestations, `${id}.json`)); break
    case 'takeover': add('takeover', join(b.takeovers, `${id}.json`)); break
    case 'hook_session':
      add('hook_session', join(b.hooks, `${id}.json`))
      for (const ext of ['json', 'jsonl', 'lock']) add('hook_session', join(b.route, `${id}.${ext}`))
      break
    case 'tmp': add('tmp', join(b.tmp, id)); break
  }
  return entries
}

/**
 * `prune` toma el `review.lock` de una revisión para recomprobarla y borrarla, y ese lock no puede contar
 * como actividad: si contara, la revisión cambiaría por el solo intento y nunca se borraría. Por eso, en
 * una revisión, el lock y sus temporales no se miran, y la raíz de la corrida, cuyo tamaño y mtime cambian
 * al crearlos y borrarlos, entra sin esos dos datos. El costo está en la edad: un archivo borrado de la raíz
 * de una revisión, sin otro cambio, no la rejuvenece. La huella sí lo ve, porque cambia la lista de nodos, así
 * que un borrado posterior al ensayo frena la aplicación de esa revisión.
 */
function reviewSkip(e: Entry, review: boolean): (path: string) => boolean {
  return (path) => review && e.kind === 'run' && /^review\.lock(?:\..*\.tmp)?$/.test(relative(e.path, path))
}

const reviewRoot = (e: Entry, review: boolean, path: string) => review && e.kind === 'run' && path === e.path

function fingerprintOf(entries: Entry[], review: boolean): string {
  const lines: string[] = []
  for (const e of entries) {
    walk(e.path, (path, stat) => {
      const type = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f'
      const prefix = `${e.kind}:${path}\t${type}`
      lines.push(reviewRoot(e, review, path) ? prefix : `${prefix}\t${stat.size}\t${stat.mtimeMs}`)
    }, reviewSkip(e, review))
  }
  return hash(lines.sort().join('\n'))
}

function newest(entries: Entry[], review: boolean): number {
  let mtime = 0
  for (const e of entries) {
    walk(e.path, (path, stat) => { if (!reviewRoot(e, review, path)) mtime = Math.max(mtime, stat.mtimeMs) }, reviewSkip(e, review))
  }
  return mtime
}

interface FlowText { flow: string; text: string }

/** Las citas detrás de un enlace no se leen: protegerían menos de lo que el ensayo dice, así que se frena. */
const linkInFlows = (path: string) => new SddError('flow_unreadable', `un enlace en .plans no se recorre: ${path}`, {
  next: 'reemplaza el enlace por el directorio o el archivo real, o sácalo de .plans, y repite el ensayo',
})

function readFlowTexts(ctx: PruneContext): FlowText[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: ctx.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const checkouts = new Set([ctx.root, ...output.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9))])
  const texts: FlowText[] = []
  for (const checkout of [...checkouts].sort().filter((path) => existsSync(path))) {
    const plans = join(checkout, '.plans')
    const plansStat = statOrNull(plans)
    if (plansStat?.isSymbolicLink()) throw linkInFlows(plans)
    if (!plansStat?.isDirectory()) continue
    for (const id of names(plans)) {
      const dir = join(plans, id)
      if (id === 'archived' || !isFlowId(id)) continue
      const dirStat = statOrNull(dir)
      if (dirStat?.isSymbolicLink()) throw linkInFlows(dir)
      if (!dirStat?.isDirectory()) continue
      if (!FLOW_FILES.some((key) => statOrNull(join(dir, FILE_NAMES[key])) !== null)) continue
      const read = (path: string): void => {
        try {
          const stat = lstatSync(path)
          if (stat.isSymbolicLink()) throw linkInFlows(path)
          if (stat.isDirectory()) for (const name of readdirSync(path).sort()) read(join(path, name))
          else if (stat.isFile()) texts.push({ flow: id, text: readFileSync(path, 'utf8') })
        } catch (e) {
          if (e instanceof SddError) throw e
          throw new SddError('flow_unreadable', `no se puede leer el archivo del flujo: ${path}`, {
            detail: (e as Error).message, next: 'restablece la lectura del flujo y repite el ensayo',
          })
        }
      }
      read(dir)
    }
  }
  return texts
}

function protection(ctx: PruneContext, kind: UnitKind, id: string, flows: FlowText[]): Kept | null {
  if (kind === 'run') {
    try {
      const open = runOpenness(ctx.root, id, join(ctx.gitDir, 'sdd-ai', 'runs'))
      if (open) return { kind, id, reason: 'open', open: open.open, next: open.next }
    } catch {
      return { kind, id, reason: 'unreadable' }
    }
  }
  const binding = kind === 'hook_session' ? readBinding(ctx.root, id) : null
  if (binding === 'unreadable') return { kind, id, reason: 'unreadable' }
  if (['run', 'receipt', 'attestation', 'takeover'].includes(kind)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const token = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`)
    const cited = [...new Set(flows.filter((f) => token.test(f.text)).map((f) => f.flow))].sort()
    if (cited.length > 0) return { kind, id, reason: 'cited', flows: cited }
  }
  if (binding && isFlowId(binding.id) && binding.id !== 'archived'
    && statOrNull(join(ctx.root, '.plans', binding.id))?.isDirectory()) return { kind, id, reason: 'bound' }
  return null
}

function isReview(entries: Entry[]): boolean {
  const run = entries.find((e) => e.kind === 'run')
  if (!run || !lstatSync(run.path).isDirectory()) return false
  try {
    return readJson<{ kind?: string }>(join(run.path, 'request.json')).kind === 'review'
  } catch {
    return false
  }
}

export function planPrune(ctx: PruneContext): PrunePlan {
  validateBases(ctx)
  const b = bases(ctx)
  const ids: Record<UnitKind, Set<string>> = {
    run: new Set(), receipt: new Set(), attestation: new Set(), takeover: new Set(), hook_session: new Set(), tmp: new Set(names(b.tmp)),
  }
  for (const base of [b.runs, b.writers]) for (const id of names(base)) {
    if (isRunId(id) && directoryOrLink(join(base, id))) ids.run.add(id)
  }
  for (const id of names(b.verify)) if (id !== 'attestations' && directoryOrLink(join(b.verify, id))) ids.receipt.add(id)
  for (const [kind, base] of [['attestation', b.attestations], ['takeover', b.takeovers]] as const) {
    for (const name of names(base)) if (name.endsWith('.json')) ids[kind].add(name.slice(0, -5))
  }
  for (const name of names(b.hooks)) if (name.endsWith('.json')) ids.hook_session.add(name.slice(0, -5))
  for (const name of names(b.route)) {
    const match = /^(.*)\.(json|jsonl|lock)$/.exec(name)
    if (match) ids.hook_session.add(match[1])
  }
  const flows = readFlowTexts(ctx)
  const candidates: Candidate[] = []
  const kept: Kept[] = []
  for (const kind of KINDS) for (const id of [...ids[kind]].sort()) {
    // Las protecciones van antes de recorrer la unidad: una corrida abierta no se mide.
    const keep = protection(ctx, kind, id, flows)
    if (keep) {
      kept.push(keep)
      continue
    }
    const entries = unitEntries(ctx, kind, id)
    const review = kind === 'run' && isReview(entries)
    if (ctx.now - newest(entries, review) < ctx.keepDays * 86_400_000) kept.push({ kind, id, reason: 'recent' })
    else candidates.push({ kind, id, entries, review, bytes: entries.reduce((sum, e) => sum + e.bytes, 0), fingerprint: fingerprintOf(entries, review) })
  }
  const digest = hash(JSON.stringify({
    root: ctx.root, git_dir: ctx.gitDir, keep_days: ctx.keepDays,
    candidates: candidates.map(({ kind, id, entries, fingerprint }) => ({ kind, id, entries: entries.map(({ kind, path }) => ({ kind, path })), fingerprint })),
  }))
  return { candidates, kept, bytes: candidates.reduce((sum, c) => sum + c.bytes, 0), digest }
}

export type UnitOutcome = { deleted: true; bytes: number } | { deleted: false; reason: KeepReason | 'changed' | 'busy' }

/** La ruta que falló y las entradas de la unidad que ya se borraron. */
export class PruneFailure extends Error {
  path: string
  removed: string[]
  constructor(path: string, removed: string[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.path = path
    this.removed = removed
  }
}

export function pruneUnit(ctx: PruneContext, c: Candidate): UnitOutcome {
  validateBases(ctx)
  const body = (): UnitOutcome => {
    const keep = protection(ctx, c.kind, c.id, readFlowTexts(ctx))
    if (keep) return { deleted: false, reason: keep.reason }
    const entries = unitEntries(ctx, c.kind, c.id)
    if (fingerprintOf(entries, c.review) !== c.fingerprint) return { deleted: false, reason: 'changed' }
    const removed: string[] = []
    for (const e of entries) {
      try {
        rmSync(e.path, { recursive: true, force: true })
        if (statOrNull(e.path)) throw new Error('la entrada sigue existiendo después de borrarla')
        removed.push(e.path)
      } catch (error) {
        throw new PruneFailure(e.path, removed, error)
      }
    }
    return { deleted: true, bytes: c.bytes }
  }
  if (!c.review) return body()
  const run = c.entries.find((e) => e.kind === 'run')!
  // Si la raíz dejó de ser un directorio, no se escribe el lock a través de un enlace.
  if (!statOrNull(run.path)?.isDirectory()) return { deleted: false, reason: 'changed' }
  const locked = tryWithLock(join(run.path, 'review.lock'), body)
  return locked.ok ? locked.value : { deleted: false, reason: 'busy' }
}

type Deleted = Array<{ kind: UnitKind; id: string; bytes: number }>
export type ApplyResult =
  | { kind: 'mismatch' }
  | { kind: 'failed'; deleted: Deleted; bytes: number; failed: { kind: UnitKind; id: string; path: string; error: string; removed: string[] } }
  | { kind: 'applied'; deleted: Deleted; kept: Array<{ kind: UnitKind; id: string; reason: KeepReason | 'changed' | 'busy' }>; bytes: number }

export function applyPrune(ctx: PruneContext, digest: string): ApplyResult {
  const plan = planPrune(ctx)
  if (plan.digest !== digest) return { kind: 'mismatch' }
  const deleted: Deleted = []
  const kept: Array<{ kind: UnitKind; id: string; reason: KeepReason | 'changed' | 'busy' }> = []
  for (const c of plan.candidates) {
    try {
      const result = pruneUnit(ctx, c)
      if (result.deleted) deleted.push({ kind: c.kind, id: c.id, bytes: result.bytes })
      else kept.push({ kind: c.kind, id: c.id, reason: result.reason })
    } catch (e) {
      return { kind: 'failed', deleted, bytes: deleted.reduce((sum, d) => sum + d.bytes, 0), failed: {
        kind: c.kind, id: c.id, path: e instanceof PruneFailure ? e.path : c.entries[0].path,
        error: e instanceof Error ? e.message : String(e), removed: e instanceof PruneFailure ? e.removed : [],
      } }
    }
  }
  return { kind: 'applied', deleted, kept, bytes: deleted.reduce((sum, d) => sum + d.bytes, 0) }
}
