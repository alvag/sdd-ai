import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type HarvestFile, buildIndex, captureTree, gitDirs, removeIndex } from './git.ts'
import type { Outcome } from './outcome.ts'
import { readJson, writeJsonAtomic } from './runs.ts'
import { type Conductor, type Family, type RunState, SddError } from './types.ts'
import { artifactHash, headerHash, readFlow } from './sdd/read.ts'
import { hasEndMark } from './writer.ts'

/**
 * El almacén de control de un writer vive en el directorio de Git, que ningún writer puede escribir: el
 * sandbox de Codex lo protege y Claude en modo restringido lo trata como ruta sensible sin quién
 * apruebe. La reserva es una por repositorio, en el directorio común; el almacén de cada corrida es del
 * checkout que la lanzó.
 */
export function storeRoot(root: string): string {
  return join(gitDirs(root).commonDir, 'sdd-ai')
}

export function storeDir(root: string, id: string): string {
  return join(gitDirs(root).gitDir, 'sdd-ai', 'runs', id)
}

/**
 * Si el binario puede escribir la raíz de la reserva y el directorio de los almacenes. Dentro del
 * sandbox de un conductor Codex no puede: `run` falla cerrado y pide escalar.
 */
export function canWriteStore(root: string): boolean {
  const { gitDir, commonDir } = gitDirs(root)
  for (const dir of [join(commonDir, 'sdd-ai'), join(gitDir, 'sdd-ai', 'runs')]) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.probe.${process.pid}.${randomBytes(4).toString('hex')}`)
      writeFileSync(probe, '')
      unlinkSync(probe)
    } catch {
      return false
    }
  }
  return true
}

/** Quién tiene la reserva: la corrida, el proceso `run` que la tomó y el directorio de Git de su checkout. */
export interface Reservation { id: string; pid: number; lstart: string | null; gitDir: string }

const lockOf = (root: string) => join(storeRoot(root), 'writer.lock')

export function readReservation(root: string): Reservation | undefined {
  try {
    return readJson<Reservation>(lockOf(root))
  } catch {
    return undefined
  }
}

/**
 * Toma la reserva de writer del repositorio. El contenido se escribe en un temporal propio y el lock
 * nace con `link`, que falla si ya existe y lo deja completo desde que aparece.
 */
export function reserveWriter(root: string, id: string): { ok: true } | { ok: false; holder: string } {
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const seen = readProcess(process.pid)
  const mine: Reservation = { id, pid: process.pid, lstart: seen && seen !== 'gone' ? seen.lstart : null, gitDir: gitDirs(root).gitDir }
  const tmp = join(dir, `writer.lock.${process.pid}.${randomBytes(4).toString('hex')}`)
  writeFileSync(tmp, `${JSON.stringify(mine)}\n`)
  try {
    linkSync(tmp, lockOf(root))
    return { ok: true }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    return { ok: false, holder: readReservation(root)?.id ?? 'desconocida' }
  } finally {
    unlinkSync(tmp)
  }
}

/** Libera la reserva solo si es de esta corrida. */
export function releaseWriter(root: string, id: string): void {
  if (readReservation(root)?.id !== id) return
  try {
    unlinkSync(lockOf(root))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

export interface InventoryEntry { type: 'file' | 'dir' | 'link'; mode: number; hash?: string; target?: string }
export interface Flagged { path: string; before?: InventoryEntry; after?: InventoryEntry }
/** El grupo de procesos del writer, para acreditar que un grupo vivo sigue siendo el suyo. */
export interface GroupIdentity { pid: number; pgid: number; lstart: string | null; argvHash: string }

export interface WriterControl {
  id: string; base: string; family: Family
  /** El encargo del conductor, tal como llegó a `run`. */
  prompt: string
  /** La sesión dueña, si la hay. */
  session?: string
  /** Rutas reales al lanzar: `wait`, `cancel`, `--retry` y la captura usan estas. */
  checkout: { root: string; gitDir: string; commonDir: string }
  request: { role: 'implement'; families?: string; model?: string; effort?: string; conductor: Conductor; deadline_sec: number }
  /** La corrida visible tal como quedó antes de lanzar: después, sdd-ai no escribe ahí. */
  preLaunch: Record<string, InventoryEntry>
  /** Cuándo empezó el supervisor a lanzar al writer. */
  spawning?: string
  inventory: Record<string, InventoryEntry>
  runDir: { dev: number; ino: number }
  group?: GroupIdentity
  /** Un writer de fase: el flujo, las tasks pendientes y las huellas de sus insumos al lanzar. */
  phase?: { flow: string; pending: string[]; inputs: Record<string, string>; handoff_header: string }
}

const controlFile = (root: string, id: string) => join(storeDir(root, id), 'control.json')

export function writeControl(root: string, c: WriterControl): void {
  mkdirSync(storeDir(root, c.id), { recursive: true })
  writeJsonAtomic(controlFile(root, c.id), c)
}

export function readControl(root: string, id: string): WriterControl {
  const file = controlFile(root, id)
  if (!existsSync(file)) {
    throw new SddError('run_not_found', `no existe la corrida ${id} en este checkout`, { next: 'revisa el id y corre el comando desde el checkout que la lanzó' })
  }
  return readJson<WriterControl>(file)
}

/** Si existe el control de un writer con ese id en este checkout. */
export function isWriterRun(root: string, id: string): boolean {
  try {
    return existsSync(controlFile(root, id))
  } catch {
    return false
  }
}

export function recordGroup(root: string, id: string, g: GroupIdentity): void {
  writeControl(root, { ...readControl(root, id), group: g })
}

const hashOf = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** Una entrada del inventario, sin seguir enlaces. */
export function entryOf(abs: string): InventoryEntry | undefined {
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return undefined
  }
  const mode = st.mode & 0o7777
  if (st.isSymbolicLink()) return { type: 'link', mode, target: readlinkSync(abs) }
  if (st.isDirectory()) return { type: 'dir', mode }
  return { type: 'file', mode, hash: hashOf(readFileSync(abs)) }
}

/**
 * Recorre `dir` sin seguir enlaces y deja cada entrada bajo `prefix`. `skip` excluye el contenido de
 * nombres de primer nivel, pero no que se hayan vuelto un enlace: un directorio excluido reemplazado por
 * un enlace sale en el inventario.
 */
export function walkInto(out: Record<string, InventoryEntry>, dir: string, prefix: string, skip: ReadonlySet<string> = new Set()): void {
  const top = entryOf(dir)
  if (!top) return
  out[prefix] = top
  if (top.type !== 'dir') return
  const visit = (abs: string, key: string, first: boolean) => {
    for (const name of readdirSync(abs)) {
      if (first && skip.has(name)) {
        const e = entryOf(join(abs, name))
        if (e?.type === 'link') out[`${key}/${name}`] = e
        continue
      }
      const e = entryOf(join(abs, name))
      if (!e) continue
      out[`${key}/${name}`] = e
      if (e.type === 'dir') visit(join(abs, name), `${key}/${name}`, false)
    }
  }
  visit(dir, prefix, true)
}

/** Lo que sdd-ai y Git escriben por su cuenta mientras el writer corre; el almacén, además. */
const SDD_SKIP = new Set(['runs', 'hooks', 'tmp'])
const GIT_SKIP = new Set(['index', 'objects', 'logs', 'sdd-ai', 'worktrees'])

/**
 * Las rutas sensibles del checkout: `.claude/`, `.codex/`, `.agents/`, `.sdd-ai/` y, en un worktree, el
 * archivo `.git`, con claves relativas a la raíz; el directorio de Git del checkout y el común, con
 * claves absolutas. Lo ignorado entra igual. Después de lanzar se pasan los directorios registrados:
 * volver a resolverlos leería el archivo `.git` que el writer pudo cambiar.
 */
export function sensitiveInventory(root: string, dirs: { gitDir: string; commonDir: string } = gitDirs(root)): Record<string, InventoryEntry> {
  const out: Record<string, InventoryEntry> = {}
  for (const d of ['.claude', '.codex', '.agents']) walkInto(out, join(root, d), d)
  walkInto(out, join(root, '.sdd-ai'), '.sdd-ai', SDD_SKIP)
  const dotGit = entryOf(join(root, '.git'))
  if (dotGit?.type === 'file') out['.git'] = dotGit
  const { gitDir, commonDir } = dirs
  walkInto(out, commonDir, commonDir, GIT_SKIP)
  if (gitDir !== commonDir) walkInto(out, gitDir, gitDir, GIT_SKIP)
  return out
}

export function diffInventory(before: Record<string, InventoryEntry>, after: Record<string, InventoryEntry>): Flagged[] {
  const out: Flagged[] = []
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[path]
    const a = after[path]
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    const f: Flagged = { path }
    if (b) f.before = b
    if (a) f.after = a
    out.push(f)
  }
  return out
}

/**
 * Lo que `ps` dice de un proceso: su grupo, su hora de inicio y el hash de su línea de comando. `gone`
 * si no existe; nada si no hay `ps`. `LC_ALL=C` fija el formato de la hora.
 */
export function readProcess(pid: number): { pgid: number; lstart: string; argvHash: string } | 'gone' | undefined {
  let out: string
  try {
    out = execFileSync('ps', ['-ww', '-o', 'pgid=,lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    })
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'gone'
  }
  // `lstart` ocupa siempre cinco campos: día, mes, día del mes, hora y año.
  const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s(.*)$/.exec(out.split('\n')[0] ?? '')
  if (!m) return 'gone'
  return { pgid: Number(m[1]), lstart: m[2], argvHash: hashOf(m[3].trim()) }
}

const validGroup = (g: GroupIdentity) => Number.isInteger(g.pgid) && g.pgid > 1 && Number.isInteger(g.pid) && g.pid > 1

/** `gone` cuando el grupo ya no tiene procesos; `unknown` si existe pero no se puede consultar. */
export function groupState(g: GroupIdentity): 'gone' | 'alive' | 'unknown' {
  // `kill(-1)` alcanza a todos los procesos del usuario y `kill(-0)` al grupo propio: nunca se consultan.
  if (!validGroup(g)) return 'unknown'
  try {
    process.kill(-g.pgid, 0)
    return 'alive'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

/**
 * Si el líder del grupo sigue siendo el writer: los cuatro datos tienen que coincidir. Sin `ps`, o sin
 * la hora de inicio registrada, no afirma nada.
 */
export function leaderMatches(g: GroupIdentity): boolean | undefined {
  if (g.lstart === null || !validGroup(g)) return undefined
  const seen = readProcess(g.pid)
  if (seen === undefined) return undefined
  if (seen === 'gone') return false
  return seen.pgid === g.pgid && seen.lstart === g.lstart && seen.argvHash === g.argvHash
}

/**
 * La cosecha congelada de un writer, que es también el terminal de su corrida. `patchFile` es la ruta
 * absoluta del `diff.patch` en el almacén.
 */
export interface HarvestRecord {
  state: RunState; reason?: string; detail?: string
  base: string; tree: string; files: HarvestFile[]; patchFile: string
  flagged: Flagged[]; runAltered: Flagged[]; headMoved: boolean
  report?: string; endMark: boolean
  /** En un writer de fase, si la spec, el plan, las tasks o el header del handoff siguen como al lanzar. */
  phase_inputs?: 'unchanged' | 'changed'
}

/** La corrida visible, `.sdd-ai/runs/<id>/`, con claves relativas a ella. */
export function runInventory(root: string, id: string): Record<string, InventoryEntry> {
  const out: Record<string, InventoryEntry> = {}
  walkInto(out, join(root, '.sdd-ai', 'runs', id), '.')
  return out
}

/** El directorio de la corrida visible: si el writer lo reemplazó, su inodo cambió. */
export function runDirIdentity(root: string, id: string): { dev: number; ino: number } | undefined {
  try {
    const st = lstatSync(join(root, '.sdd-ai', 'runs', id))
    return { dev: st.dev, ino: st.ino }
  } catch {
    return undefined
  }
}

const harvestFile = (dir: string) => join(dir, 'harvest.json')

export function readHarvest(root: string, id: string): HarvestRecord | undefined {
  const file = harvestFile(storeDir(root, id))
  return existsSync(file) ? readJson<HarvestRecord>(file) : undefined
}

/** El proceso dueño de una reclamación: vive si `ps` lo ve con la misma hora de inicio. */
function ownerAlive(owner: { pid: number; lstart: string | null }): boolean {
  const seen = readProcess(owner.pid)
  if (seen === undefined) {
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  return seen !== 'gone' && (owner.lstart === null || seen.lstart === owner.lstart)
}

const CLAIM = /^harvest\.claim\.(\d+)$/

/** Crea la reclamación `n` con `link`: gana uno solo, y nunca se mueve ni se borra una existente. */
function claim(dir: string, n: number): boolean {
  const seen = readProcess(process.pid)
  const tmp = join(dir, `harvest.claim.tmp.${process.pid}.${randomBytes(4).toString('hex')}`)
  writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, lstart: seen && seen !== 'gone' ? seen.lstart : null })}\n`)
  try {
    linkSync(tmp, join(dir, `harvest.claim.${n}`))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    return false
  } finally {
    unlinkSync(tmp)
  }
}

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function headOf(gitDir: string): string | undefined {
  try {
    return execFileSync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Si el árbol del checkout sigue siendo el de la base, visto como lo ve la cosecha: sin filtros y con
 * los archivos nuevos. No usa `git status`, que puede correr un filtro `clean` sobre el árbol.
 */
export function captureTreeAtBase(root: string, id: string): boolean {
  const { checkout, base } = readControl(root, id)
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-index-'))
  try {
    const tree = buildIndex({ root: checkout.root, gitDir: checkout.gitDir }, base, join(scratch, 'index'))
    const baseTree = execFileSync('git', ['--git-dir', checkout.gitDir, 'rev-parse', `${base}^{tree}`], { encoding: 'utf8' }).trim()
    return tree === baseTree
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Si el árbol de trabajo sigue siendo el que congeló la cosecha de ese writer. */
export function harvestTreeHolds(root: string, id: string): boolean {
  try {
    const h = readHarvest(root, id)
    if (!h) return false
    const { checkout, base } = readControl(root, id)
    const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-index-'))
    try {
      return buildIndex({ root: checkout.root, gitDir: checkout.gitDir }, base, join(scratch, 'index')) === h.tree
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } catch {
    return false
  }
}

/** Cuánto espera a que otro publique la cosecha que reclamó antes de darse por vencido. */
const CLAIM_WAIT_MS = 120_000

/**
 * Congela la cosecha del writer: el árbol real contra la base, el patch, lo señalado y la corrida
 * alterada. Publica el patch, después el registro, que es el terminal, y recién entonces libera la
 * reserva. Es idempotente: una reclamación numerada decide quién congela; el que pierde espera el
 * registro y lo devuelve. Una reclamación cuyo dueño murió sin publicar se rescata con la siguiente.
 */
export async function freezeHarvest(root: string, id: string, outcome: Outcome, report?: string,
  hooks: { beforeRescue?: () => Promise<void> } = {}): Promise<HarvestRecord> {
  const dir = storeDir(root, id)
  const control = readControl(root, id)
  const { checkout } = control
  const release = () => releaseAt(checkout.commonDir, id)
  const until = Date.now() + CLAIM_WAIT_MS
  for (;;) {
    if (existsSync(harvestFile(dir))) {
      release()
      return readJson<HarvestRecord>(harvestFile(dir))
    }
    const claims = readdirSync(dir).map((f) => CLAIM.exec(f)?.[1]).filter((n) => n !== undefined).map(Number)
    const top = Math.max(0, ...claims)
    let mine = false
    if (top === 0) {
      mine = claim(dir, 1)
    } else if (!ownerAlive(readJson<{ pid: number; lstart: string | null }>(join(dir, `harvest.claim.${top}`)))) {
      await hooks.beforeRescue?.()
      mine = claim(dir, top + 1)
    }
    if (mine) break
    if (Date.now() > until) {
      throw new SddError('harvest_busy', `otro proceso está congelando la cosecha de ${id} y no terminó`, { next: `./bin/sdd-ai wait ${id}` })
    }
    await sleep(100)
  }

  const indexFile = join(dir, 'harvest.index')
  removeIndex(indexFile)
  const cap = captureTree({ root: checkout.root, gitDir: checkout.gitDir }, control.base, indexFile)
  removeIndex(indexFile)
  const flagged = diffInventory(control.inventory, sensitiveInventory(checkout.root, checkout))
  const run = runInventory(checkout.root, id)
  const runAltered = diffInventory(control.preLaunch, run)
  // Un directorio reemplazado por otro igual solo se nota en su inodo.
  const now = runDirIdentity(checkout.root, id)
  if (now && (now.dev !== control.runDir.dev || now.ino !== control.runDir.ino) && !runAltered.some((f) => f.path === '.')) {
    runAltered.unshift({ path: '.', before: control.preLaunch['.'], after: run['.'] })
  }
  const patchFile = join(dir, 'diff.patch')
  writeAtomic(patchFile, cap.patch)
  const record: HarvestRecord = {
    state: outcome.state, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}),
    base: control.base, tree: cap.tree, files: cap.files, patchFile, flagged, runAltered,
    headMoved: headOf(checkout.gitDir) !== control.base, ...(report !== undefined ? { report } : {}), endMark: hasEndMark(report ?? ''),
    ...(control.phase ? { phase_inputs: phaseInputs(checkout.root, control.phase) } : {}),
  }
  writeAtomic(harvestFile(dir), `${JSON.stringify(record, null, 2)}\n`)
  release()
  return record
}

/** Si los insumos de un writer de fase son los que congeló al lanzar; un flujo que ya no se lee cambió. */
function phaseInputs(root: string, phase: NonNullable<WriterControl['phase']>): 'unchanged' | 'changed' {
  try {
    const read = readFlow(root, phase.flow)
    const now: Record<string, string> = { spec: artifactHash(read, 'spec'), plan: artifactHash(read, 'plan'), tasks: artifactHash(read, 'tasks') }
    const same = Object.entries(phase.inputs).every(([k, v]) => now[k] === v) && headerHash(read.facts.handoffHeader) === phase.handoff_header
    return same ? 'unchanged' : 'changed'
  } catch {
    return 'changed'
  }
}

/** `releaseWriter` con el directorio común registrado, sin volver a resolverlo. */
function releaseAt(commonDir: string, id: string): void {
  const lock = join(commonDir, 'sdd-ai', 'writer.lock')
  try {
    if (readJson<Reservation>(lock).id !== id) return
    unlinkSync(lock)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw e
  }
}
