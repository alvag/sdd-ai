import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import { writeJsonAtomic } from '../runs.ts'
import { sha256 } from '../review/candidate.ts'
import { SddError } from '../types.ts'
import { flowWriterOpen } from '../writer-store.ts'
import { readHeader } from './markdown.ts'
import { activeRun, readPhaseRecord } from './phase-state.ts'
import { type FlowRead } from './read.ts'
import { ACCREDITED_FROM, GATES, STATUSES, type FlowFacts, type FlowStatus, type GateId, headerData, planStatus, resolveGates } from './status.ts'
import { writeTextAtomic } from './verify.ts'

export interface ApproveDeps {
  writeJson: typeof writeJsonAtomic
  writeText: typeof writeTextAtomic
  activity: (root: string, id: string) => void
}
export interface SyncField { path: string; field: 'spec_approved_at' | 'status'; expected: string; current: unknown }
export interface SyncEdit extends SyncField { text: string; key: 'handoff' | 'plan' }
export interface SyncPendingResult {
  state: 'sync_pending'; code: 'approval_sync_pending'; approval_registered: true
  id: string; gate: GateId; at: string; pending_headers: SyncField[]
  message: string; detail: string; recovery_command: string; status: FlowStatus | null
}
export class ApprovalSyncPending extends Error {
  result: SyncPendingResult
  constructor(result: SyncPendingResult) { super(result.message); this.result = result }
}

/** Si el gate tiene hoy una aprobación registrada vigente: la definición que usan la recuperación y la proyección. */
export function gateApproved(facts: FlowFacts, gate: GateId): boolean {
  return resolveGates(facts).gates.find((g) => g.gate === gate)?.state === 'approved'
}

/** Solo proyecta decisiones probadas y vigentes del prefijo solicitado. */
export function selectFields(facts: FlowFacts, gate: GateId): SyncField[] {
  const resolution = resolveGates(facts)
  if (!resolution.depth || facts.log.state !== 'ok') return []
  const out: SyncField[] = []
  for (const g of GATES[resolution.depth].slice(0, GATES[resolution.depth].indexOf(gate) + 1)) {
    const entry = facts.log.approvals.findLast((a) => a.gate === g)
    if (!entry?.proof || !gateApproved(facts, g)) continue
    if (g === 'spec') {
      const header = headerData(facts.handoffHeader)
      if (facts.files.handoff === 'present' && header && header.spec_approved_at !== entry.at) {
        out.push({ path: `.plans/${facts.id}/handoff.md`, field: 'spec_approved_at', expected: entry.at, current: header.spec_approved_at ?? null })
      }
    } else {
      const current = planStatus(facts, resolution.depth)
      const expected = ACCREDITED_FROM[g]
      if (facts.files.plan === 'present' && current && STATUSES.indexOf(current) < STATUSES.indexOf(expected)) {
        const field = { path: `.plans/${facts.id}/plan.md`, field: 'status' as const, expected, current }
        const old = out.findIndex((f) => f.field === 'status')
        if (old < 0) out.push(field)
        else out[old] = field
      }
    }
  }
  return out
}

/** Sustituye el escalar, conservando el resto del documento original. */
export function prepareHeader(text: string, field: SyncField): string {
  const before = readHeader(text)
  const bounds = /^[ \t]*---[ \t]*\r?\n([\s\S]*?)^[ \t]*---[ \t]*(?:\r?\n|$)/m.exec(text)
  if (!before.ok || !bounds || bounds.index !== 0) throw new SddError('header_invalid', `${field.path}: header inválido`)
  const yaml = bounds[1]
  const offset = bounds[0].indexOf('\n') + 1
  const doc = parseDocument(yaml, { keepSourceTokens: true })
  const node = doc.get(field.field, true)
  let updated: string
  if (node === undefined) {
    const nl = text.includes('\r\n') ? '\r\n' : '\n'
    updated = text.slice(0, offset + yaml.length) + `${field.field}: ${field.expected}${nl}` + text.slice(offset + yaml.length)
  } else {
    if (!isScalar(node) || !node.range) throw new SddError('header_invalid', `${field.path}: ${field.field} no es un escalar`)
    let start = node.range[0], end = node.range[1], value = field.expected
    if (node.value === null) {
      const pair = isMap(doc.contents) ? doc.contents.items.find((p) => isScalar(p.key) && p.key.value === field.field) : undefined
      if (!pair || !isScalar(pair.key) || !pair.key.range) throw new SddError('header_invalid', `${field.path}: clave no localizable`)
      const colon = yaml.indexOf(':', pair.key.range[1])
      start = colon + 1
      const line = yaml.slice(start).split(/\r?\n/)[0]
      const token = /^[ \t]*(?:null|Null|NULL|~)?(?=[ \t]*(?:#|$))/.exec(line)
      if (!token) throw new SddError('header_invalid', `${field.path}: nulo no localizable`)
      end = start + token[0].length
      value = ` ${value}${yaml[end] === '#' ? ' ' : ''}`
    }
    updated = text.slice(0, offset + start) + value + text.slice(offset + end)
  }
  const after = readHeader(updated)
  if (!after.ok || after.data[field.field] !== field.expected) throw new SddError('header_invalid', `${field.path}: no se pudo preparar ${field.field}`)
  for (const key of Object.keys(before.data)) {
    if (key !== field.field && JSON.stringify(before.data[key]) !== JSON.stringify(after.data[key])) {
      throw new SddError('header_invalid', `${field.path}: cambió el campo ajeno ${key}`)
    }
  }
  return updated
}
export function prepareEdits(root: string, read: FlowRead, gate: GateId): SyncEdit[] {
  return selectFields(read.facts, gate).map((field) => {
    const key = field.field === 'status' ? 'plan' : 'handoff'
    const text = readFileSync(join(root, field.path), 'utf8')
    if (read.digests[key] !== `present:${sha256(text)}`) throw new SddError('artifacts_unstable', `${field.path}: cambió mientras se preparaba`, { next: 'repite sdd approve' })
    return { ...field, key, text: prepareHeader(text, field) }
  })
}
export function pendingFields(root: string, fields: SyncField[]): SyncField[] {
  return fields.flatMap((field) => {
    let current: unknown = null
    try {
      const path = join(root, field.path)
      if (!lstatSync(path).isFile()) throw new Error('header no regular')
      const h = readHeader(readFileSync(path, 'utf8')); if (h.ok) current = h.data[field.field] ?? null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      /* La relectura puede ser incierta; detail explica el impedimento. */
    }
    if (field.field === 'status' && typeof current === 'string' && STATUSES.indexOf(current as typeof STATUSES[number]) >= STATUSES.indexOf(field.expected as typeof STATUSES[number])) return []
    return current === field.expected ? [] : [{ path: field.path, field: field.field, expected: field.expected, current }]
  })
}
/** Lanza si el flujo tiene una fase o un writer abiertos, o si no se puede descartar actividad; si no, vuelve sin más. */
export function assertNoActivity(root: string, id: string): void {
  const run = activeRun(root, readPhaseRecord(root, id, true), true)
  if (run) throw new SddError('phase_running', `la fase ${run} sigue activa`, { next: `./bin/sdd-ai wait ${run}` })
  const writer = flowWriterOpen(root, id, true)
  if (writer) throw new SddError('writer_open', `el writer ${writer} sigue abierto`, { next: `./bin/sdd-ai wait ${writer}` })
}
export const REAL_DEPS: ApproveDeps = { writeJson: writeJsonAtomic, writeText: writeTextAtomic, activity: assertNoActivity }
