import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { DEFAULT_BRANCH_FORMAT, loadBranchConfig } from '../config.ts'
import { branchCommit, branchRefConflict, createBranch, currentBranch, dirtyPaths, headCommit, isCommit, isValidBranchName, switchBranch } from '../git.ts'
import { SddError } from '../types.ts'
import { flowWriterOpen, readReservation, releaseWriter, reserveWriter, writerLockPath, writerReservation } from '../writer-store.ts'
import { activeRun, readPhaseRecord, withFlowLock } from './phase-state.ts'
import { LOCK_FILE, flowDir, lstatOrNull, readFlow } from './read.ts'
import { CHANGE_TYPES, quote } from './start.ts'
import { type FlowFacts, headerData, resolve } from './status.ts'
import { writeTextAtomic } from './verify.ts'

export type BranchExit = 'new' | 'current'
export type BranchAsk = 'exit' | 'base_advanced'
export type BranchRetake = 'none' | 'handoff' | 'create' | 'switch'
export type BranchBlockerCode = 'flow_blocked' | 'handoff_invalid' | 'config_invalid' | 'spec_not_approved' | 'plan_exists'
  | 'head_unknown' | 'tree_dirty' | 'phase_running' | 'writer_open' | 'flow_busy' | 'base_branch_unknown'
  | 'branch_name_invalid' | 'branch_is_base' | 'branch_exists'
export interface BranchBlocker { code: BranchBlockerCode; detail: string; next: string }
export interface BranchNameParts {
  name: string; format: string; type: string; type_source: 'flag' | 'config' | 'change_type'; ticket: string | null; slug: string | null
  slug_source: 'handoff' | 'id' | null
}
export interface BranchOptions { current?: boolean; prefix?: string; refreeze?: boolean }
export interface BranchPreview {
  state: 'ok'; id: string; name: BranchNameParts | null
  head: { branch: string | null; commit: string | null }
  base: { branch: string | null; origin_sha: string | null; tip: string | null; advanced: boolean }
  recorded: string | null; retake: BranchRetake | null
  exits: Array<{ exit: BranchExit; blockers: BranchBlocker[] }>
  recommended: BranchExit | null; ask: BranchAsk[]; blockers: BranchBlocker[]; next: string
}
export interface BranchIo { createBranch(root: string, name: string, start: string): void; switchBranch(root: string, name: string): void }
export interface BranchApplied {
  state: 'ok'; id: string; branch: string; exit: BranchExit | 'recorded'; base_commit: string
  base: BranchPreview['base']; created: boolean; switched: boolean; handoff_written: boolean
  origin_sha?: { before: string | null; after: string }
}
const GIT_IO: BranchIo = { createBranch, switchBranch }
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null
const statusCommand = (id: string) => `./bin/sdd-ai sdd status ${id}`
const applyCommand = (id: string) => `./bin/sdd-ai sdd branch ${id} --apply`
const rechooseHint = (id: string) => `elige otra rama con ${applyCommand(id)} --prefix <p>, o registra la actual con --current`
const dirty = (root: string) => dirtyPaths(root, { renameSources: true }).filter((p) => !['.plans/', '.specify/', '.sdd-ai/', '.cross-model/'].some((allowed) => p.startsWith(allowed)))

export function branchName(o: { format: string; prefix?: string; configPrefix: string | null; changeType: string; id: string; slug: unknown }): BranchNameParts {
  const type_source = o.prefix !== undefined ? 'flag' : o.configPrefix ? 'config' : 'change_type'
  const type = (o.prefix ?? o.configPrefix ?? (o.changeType === 'feat' ? 'feature' : o.changeType)).replace(/\/+$/, '')
  const ticket = /^[A-Z][A-Z0-9]+-\d+$/.test(o.id) ? o.id : null
  const fromHandoff = text(o.slug)
  const raw = fromHandoff ?? o.id
  const slug = ticket && raw === o.id ? null : raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null
  const slug_source = slug === null ? null : fromHandoff !== null ? 'handoff' : 'id'
  let name = o.format
  const parts = { type, ticket, slug }
  // Un placeholder vacío se lleva un separador vecino: el que lo sigue y, si no hay, el que lo precede.
  for (const key of ['ticket', 'slug'] as const) {
    if (parts[key] !== null) continue
    const token = `{${key}}`
    while (name.includes(token)) {
      const index = name.indexOf(token)
      const after = index + token.length
      if (/[-_/.]/.test(name[after] ?? '')) name = name.slice(0, index) + name.slice(after + 1)
      else if (index > 0 && /[-_/.]/.test(name[index - 1])) name = name.slice(0, index - 1) + name.slice(after)
      else name = name.slice(0, index) + name.slice(after)
    }
  }
  name = name.replace(/\{(type|ticket|slug)\}/g, (_, key: keyof typeof parts) => parts[key] ?? '')
  return { name, format: o.format, type, type_source, ticket, slug, slug_source }
}

function approvedAt(facts: FlowFacts): unknown {
  if (resolve(facts).depth === 'corta') return null
  return (facts.log.state === 'ok' ? facts.log.approvals.filter((a) => a.gate === 'spec').at(-1)?.at : undefined)
    ?? headerData(facts.handoffHeader)?.spec_approved_at
}

function complete(root: string, facts: FlowFacts, branch: string): boolean {
  const h = headerData(facts.handoffHeader)
  return !!h && h.branch === branch && h.worktree_branch === branch && !!text(h.branch_prefix)
    && !!text(h.base_commit) && isCommit(root, String(h.base_commit)) && h.spec_approved_at === approvedAt(facts) && h.phase === 'plan'
}

export function branchPreview(root: string, id: string, o: BranchOptions & { locked?: boolean } = {}): BranchPreview {
  const { facts } = readFlow(root, id)
  const status = resolve(facts)
  const h = headerData(facts.handoffHeader)
  const blockers: BranchBlocker[] = []
  const add = (code: BranchBlockerCode, detail: string, next = statusCommand(id)) => blockers.push({ code, detail, next })
  if (status.blocked_reasons.length) add('flow_blocked', JSON.stringify(status.blocked_reasons))
  if (!h || !CHANGE_TYPES.some((t) => t === h.change_type)) {
    add('handoff_invalid', 'falta un handoff válido con change_type', `corrige change_type en el header de .plans/${id}/handoff.md: ${CHANGE_TYPES.join(', ')}`)
  }
  let config = { format: DEFAULT_BRANCH_FORMAT, prefix: null as string | null }
  try { config = loadBranchConfig(root) } catch (e) {
    if (!(e instanceof SddError)) throw e
    add('config_invalid', e.message, 'corrige .sdd-ai/config.yml según el detalle')
  }
  const name = h && CHANGE_TYPES.some((t) => t === h.change_type) && !blockers.some((b) => b.code === 'config_invalid')
    ? branchName({ format: config.format, prefix: o.prefix, configPrefix: config.prefix, changeType: String(h.change_type), id, slug: h.slug }) : null
  if (status.depth !== 'corta' && !status.gates.some((g) => g.gate === 'spec' && ['approved', 'approved_unfingerprinted'].includes(g.state))) {
    add('spec_not_approved', 'el gate spec no está aprobado o su aprobación venció')
  }
  if (facts.files.plan !== 'absent') add('plan_exists', 'plan.md ya existe')
  const head = { branch: currentBranch(root), commit: headCommit(root) ?? null }
  if (!head.branch || !head.commit) add('head_unknown', 'HEAD está separado o el repositorio no tiene commits', 'pasa a una rama con commits con git switch <rama>')
  const paths = dirty(root)
  if (paths.length) add('tree_dirty', paths.join(', '), 'commitea o guarda los cambios fuera de los directorios del flujo')
  const running = activeRun(root, readPhaseRecord(root, id))
  if (running) add('phase_running', `la fase ${running} sigue activa`, `./bin/sdd-ai wait ${running}`)
  const writer = flowWriterOpen(root, id)
  if (writer) add('writer_open', `el writer ${writer} sigue abierto`, `./bin/sdd-ai wait ${writer}`)
  if (!o.locked && lstatOrNull(join(flowDir(root, id), LOCK_FILE))) add('flow_busy', 'otro comando tiene tomado el flujo', `si no hay otro sdd approve, sdd phase ni sdd branch corriendo, borra .plans/${id}/${LOCK_FILE} y vuelve a correr el comando`)
  const recorded = text(h?.branch)
  const baseBranch = text(h?.base_branch)
  if (!recorded && !baseBranch) add('base_branch_unknown', 'falta base_branch en el handoff', 'completa base_branch en el handoff')
  const origin_sha = text(h?.origin_sha)
  const tip = baseBranch ? branchCommit(root, baseBranch) ?? null : null
  const base = { branch: baseBranch, origin_sha, tip, advanced: !!origin_sha && !!tip && origin_sha !== tip }
  const reservation = writerReservation(root)
  const writerBlock = (): BranchBlocker => ({ code: 'writer_open', detail: `la reserva de writer está tomada por ${reservation}`, next: reservationNext(root) })
  const exists = recorded !== null && !!branchCommit(root, recorded)
  // Una rama registrada que todavía no existe es solo una intención: --prefix o --current la reemplazan por otra elección.
  const rechoose = recorded !== null && !exists && (o.current || o.prefix !== undefined)
  if (recorded && !rechoose) {
    const retake: BranchRetake = !exists ? 'create' : head.branch !== recorded ? 'switch' : complete(root, facts, recorded) ? 'none' : 'handoff'
    if (!text(h?.base_commit) || !isCommit(root, String(h?.base_commit))) add('handoff_invalid', 'base_commit falta o no es un commit', 'completa base_commit a mano en el handoff y vuelve a correr sdd branch')
    const conflict = retake === 'create' ? branchRefConflict(root, recorded) : null
    if (conflict) blockers.push({ code: 'branch_exists', detail: `la rama ${conflict} impide crear ${recorded}`, next: rechooseHint(id) })
    if (retake === 'create' && reservation !== null) blockers.push(writerBlock())
    return { state: 'ok', id, name, head, base, recorded, retake, exits: [], recommended: null, ask: [], blockers,
      next: blockers[0]?.next ?? (retake === 'none' ? statusCommand(id) : applyCommand(id)) }
  }
  const newBlockers: BranchBlocker[] = []
  const currentBlockers: BranchBlocker[] = []
  const exitBlock = (code: BranchBlockerCode, detail: string, next = statusCommand(id)) => newBlockers.push({ code, detail, next })
  if (!name || !isValidBranchName(root, name.name)) exitBlock('branch_name_invalid', `nombre de rama inválido: ${name?.name ?? ''}`, 'corrige branch_format, branch_prefix o --prefix')
  if (name?.name === baseBranch) exitBlock('branch_is_base', 'el nombre construido es la rama base', 'elige otro prefijo con --prefix')
  if (name && branchCommit(root, name.name)) exitBlock('branch_exists', `la rama ${name.name} ya existe y el handoff no la nombra`, 'elige otro prefijo o registra la rama actual con --current')
  const conflict = name && !branchCommit(root, name.name) ? branchRefConflict(root, name.name) : null
  if (conflict) exitBlock('branch_exists', `la rama ${conflict} impide crear ${name?.name}`, 'elige otro prefijo o registra la rama actual con --current')
  if (reservation !== null) newBlockers.push(writerBlock())
  const start = startCommit(base, o.refreeze)
  if (!start || !isCommit(root, start)) exitBlock('base_branch_unknown', 'el commit de arranque no existe', 'crea la rama base local o corrige origin_sha en el handoff')
  if (head.branch && head.branch === baseBranch) currentBlockers.push({ code: 'branch_is_base', detail: 'la rama actual es la base', next: 'crea una rama nueva sin --current' })
  const exits = [{ exit: 'new' as const, blockers: newBlockers }, { exit: 'current' as const, blockers: currentBlockers }]
  const ask: BranchAsk[] = []
  const preferred: BranchExit = name?.name === head.branch ? 'current' : head.branch === baseBranch ? 'new' : head.branch?.includes(id) ? 'new' : 'current'
  if (name?.name !== head.branch && head.branch !== baseBranch) ask.push('exit')
  const preferredBlockers = preferred === 'new' ? newBlockers : currentBlockers
  const otherBlockers = preferred === 'new' ? currentBlockers : newBlockers
  let recommended: BranchExit | null = preferred
  if (preferredBlockers.length) {
    recommended = otherBlockers.length ? null : preferred === 'new' ? 'current' : 'new'
    if (recommended && !ask.includes('exit')) ask.push('exit')
  }
  if (base.advanced && !newBlockers.length) ask.push('base_advanced')
  // Con un bloqueo del flujo no hay nada que elegir: ninguna salida se aplicaría.
  if (blockers.length) return { state: 'ok', id, name, head, base, recorded, retake: null, exits, recommended: null, ask: [], blockers, next: blockers[0].next }
  return { state: 'ok', id, name, head, base, recorded, retake: null, exits, recommended, ask, blockers,
    next: exitNext(id, o, recommended, preferredBlockers[0]) }
}

/**
 * Qué hacer con una reserva de writer tomada, según quién la tiene. Solo la de `sdd branch` se puede borrar a mano si su
 * proceso murió: la de un writer, `sdd verify` o `sdd commit` la libera su propio comando, que antes deja el árbol en
 * orden.
 */
function reservationNext(root: string): string {
  const held = readReservation(root)
  if (held?.kind === 'branch') {
    return `espera a que termine sdd branch y vuelve a correrlo; si su proceso ya no corre, la reserva quedó huérfana: borra ${writerLockPath(root)}`
  }
  if (held?.kind === 'verify') return 'espera a que termine sdd verify y vuelve a correr sdd branch'
  if (held?.kind === 'commit') return 'espera a que termine sdd commit y vuelve a correr sdd branch'
  return held ? `recibe esa corrida (./bin/sdd-ai wait ${held.id}) y vuelve a correr sdd branch` : 'espera a que se libere la reserva de writer y vuelve a correr sdd branch'
}

/** El commit desde el que corta `new`: la punta de la base con `--refreeze` o sin `origin_sha`, y si no, `origin_sha`. */
function startCommit(base: BranchPreview['base'], refreeze?: boolean): string | null {
  return refreeze || !base.origin_sha ? base.tip : base.origin_sha
}

/** El `--apply` de la salida recomendada; sin recomendación, el `next` del bloqueo de la que tocaba recomendar. */
function exitNext(id: string, o: BranchOptions, recommended: BranchExit | null, blocker: BranchBlocker | undefined): string {
  if (recommended === 'current') return `${applyCommand(id)} --current`
  if (recommended === 'new') return o.prefix === undefined ? applyCommand(id) : `${applyCommand(id)} --prefix ${quote(o.prefix)}`
  return blocker?.next ?? statusCommand(id)
}

export function assertBranchApplicable(preview: BranchPreview, o: BranchOptions): void {
  const retaking = preview.retake !== null
  const blockers = [...preview.blockers, ...(retaking ? [] : preview.exits.find((e) => e.exit === (o.current ? 'current' : 'new'))?.blockers ?? [])]
  const first = blockers[0]
  if (first) throw new SddError(first.code, first.detail, { detail: JSON.stringify(blockers), next: first.next })
  if (retaking && ((o.current && preview.head.branch !== preview.recorded) || (o.prefix !== undefined && preview.name?.name !== preview.recorded))) {
    throw new SddError('branch_recorded', `el flujo ya tiene la rama ${preview.recorded}; los flags la contradicen`, { next: applyCommand(preview.id) })
  }
}

function writeHandoff(root: string, id: string, preview: BranchPreview, branch: string, baseCommit: string, exit: BranchApplied['exit'], origin: string | null): void {
  const file = join(flowDir(root, id), 'handoff.md')
  const raw = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!match) throw new SddError('handoff_invalid', 'el handoff no tiene header YAML', { next: statusCommand(id) })
  const { facts } = readFlow(root, id)
  const h = headerData(facts.handoffHeader)
  const doc = parseDocument(match[1])
  const prefix = exit === 'recorded' ? text(h?.branch_prefix) ?? preview.name?.type : preview.name?.type
  for (const [key, value] of Object.entries({ branch, worktree_branch: branch, branch_prefix: prefix, base_commit: baseCommit, spec_approved_at: approvedAt(facts), phase: 'plan' })) doc.set(key, value)
  if (origin !== null) doc.set('origin_sha', origin)
  const lines = ['## Rama', '', `- Rama: ${branch}`, `- Salida: ${exit}`, `- Base: ${preview.base.branch ?? 'desconocida'}`, `- Commit base: ${baseCommit}`]
  if (origin !== null && preview.base.origin_sha !== origin && preview.base.origin_sha !== null) lines.push(`- origin_sha anterior: ${preview.base.origin_sha}`, `- origin_sha nuevo: ${origin}`)
  const section = `${lines.join('\n')}\n\n`
  let body = raw.slice(match[0].length)
  const heading = /^## Rama\s*$/m.exec(body)
  if (heading) {
    const rest = body.slice(heading.index + heading[0].length)
    const next = /^## /m.exec(rest)
    body = body.slice(0, heading.index) + section + (next ? rest.slice(next.index) : '')
  } else body += `${body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n'}${section}`
  writeTextAtomic(file, `---\n${doc.toString()}---\n${body}`)
}

export function branchApply(root: string, id: string, o: BranchOptions = {}, io: BranchIo = GIT_IO): BranchApplied {
  return withFlowLock(root, id, (): BranchApplied => {
    const p = branchPreview(root, id, { ...o, locked: true })
    assertBranchApplicable(p, o)
    const { facts } = readFlow(root, id)
    const h = headerData(facts.handoffHeader)
    const retaking = p.retake !== null
    const exit = retaking ? 'recorded' : o.current ? 'current' : 'new'
    const branch = retaking ? p.recorded! : o.current ? p.head.branch! : p.name!.name
    const baseCommit = retaking ? String(h!.base_commit) : o.current ? p.head.commit! : startCommit(p.base, o.refreeze)!
    const origin = !retaking && !o.current && (o.refreeze || !p.base.origin_sha) ? baseCommit : null
    const creating = retaking ? p.retake === 'create' : !o.current
    const switching = creating || p.retake === 'switch'
    const writing = !retaking || !complete(root, facts, branch)
    const reservationId = `branch-${id}`
    if (creating) {
      const reservation = reserveWriter(root, reservationId, 'branch')
      if (!reservation.ok) throw new SddError('writer_open', `la reserva está tomada por ${reservation.holder}`, { next: 'espera a que termine y vuelve a correr sdd branch' })
    }
    try {
      if (creating) {
        const taken = branchCommit(root, branch) ? branch : branchRefConflict(root, branch)
        if (taken) throw new SddError('branch_exists', `la rama ${taken} ya existe o impide crear ${branch}`, { next: rechooseHint(id) })
        const paths = dirty(root)
        if (paths.length) throw new SddError('tree_dirty', paths.join(', '), { next: 'commitea o guarda los cambios y vuelve a correr sdd branch' })
        if (!isCommit(root, baseCommit)) throw new SddError('base_branch_unknown', 'el commit de arranque no existe', { next: statusCommand(id) })
      }
      if (writing) writeHandoff(root, id, p, branch, baseCommit, exit, origin)
      try {
        if (creating) io.createBranch(root, branch, baseCommit)
        else if (switching) io.switchBranch(root, branch)
      } catch (e) {
        const detail = String((e as { stderr?: unknown }).stderr ?? e)
        if (!creating) throw new SddError('branch_switch_failed', `no se pudo volver a la rama ${branch}: corrige la causa y repite`, { detail, next: applyCommand(id) })
        throw new SddError('branch_create_failed', `no se pudo crear la rama ${branch}: corrige la causa y repite, o ${rechooseHint(id)}`, { detail, next: applyCommand(id) })
      }
      return { state: 'ok', id, branch, exit, base_commit: baseCommit, base: p.base, created: creating, switched: switching, handoff_written: writing,
        ...(origin !== null && origin !== p.base.origin_sha ? { origin_sha: { before: p.base.origin_sha, after: origin } } : {}) }
    } finally {
      if (creating) releaseWriter(root, reservationId)
    }
  })
}
