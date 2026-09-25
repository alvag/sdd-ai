import { SddError } from '../types.ts'
import { type Finding, GRAVE } from './admit.ts'

export type { Evidence } from './admit.ts'
export type FindingState = 'abierto' | 'aceptado' | 'rechazado' | 'en-disputa'
  | 'resuelto' | 'cerrado' | 'refutado' | 'fuera-de-alcance'
export type Answer = 'resolved' | 'unresolved' | 'withdrawn' | 'maintained'
export type RefuteResult = 'corroborated' | 'refuted' | 'inconclusive'
export interface Decision { action: 'accept' | 'reject'; reason?: string; from: FindingState; after_round: number }
export interface RoundResponse { round: number; answer: Answer; evidence?: string; note?: string }
export interface LedgerEntry extends Finding {
  id: string; round: number; state: FindingState
  decision?: Decision; responses: RoundResponse[]
  refutation?: { result: RefuteResult; evidence?: string; note?: string; reason?: string }
}
export interface Ledger { completed: number; next_id: number; entries: LedgerEntry[] }
export interface Target { id: string; kind: 'verify' | 'respond' }
export interface Axes { scope: 'ok' | 'fail'; spec: 'ok' | 'warn' | 'fail'; quality: 'ok' | 'fail' }
export type ChangedRanges = Record<string, Array<[number, number]> | 'binary'>
/** Lo que la ronda `n` verifica y responde, y dónde puede encontrar regresiones. */
export interface RoundPlan {
  n: number; prev_hash: string; identical: boolean
  targets: Target[]; changed: ChangedRanges
  /** El ref que se pasó con `--head`, si la ronda revisaba un ref y no el árbol. */
  head?: string
}

/** Estados en los que un hallazgo sigue contando para el veredicto. */
const STANDING: ReadonlySet<FindingState> = new Set<FindingState>(['abierto', 'aceptado', 'rechazado', 'en-disputa'])

const ANSWER_STATE: Record<Answer, FindingState> = {
  resolved: 'resuelto', unresolved: 'aceptado', withdrawn: 'cerrado', maintained: 'en-disputa',
}

const DECISION_STATE: Partial<Record<FindingState, Record<Decision['action'], FindingState>>> = {
  'abierto': { accept: 'aceptado', reject: 'rechazado' },
  'en-disputa': { accept: 'aceptado', reject: 'cerrado' },
  'aceptado': { accept: 'aceptado', reject: 'rechazado' },
}

const outOfScope = (f: Finding) => GRAVE.has(f.severity) && f.causality === 'pre-existing'

function entry(f: Finding, id: number, round: number): LedgerEntry {
  return { ...f, id: `F-${id}`, round, state: outOfScope(f) ? 'fuera-de-alcance' : 'abierto', responses: [] }
}

function copy(l: Ledger): Ledger {
  return structuredClone(l)
}

/** Los hallazgos de la ronda 1, con los IDs en el orden en que llegaron. */
export function openLedger(findings: Finding[]): Ledger {
  return { completed: 1, next_id: findings.length + 1, entries: findings.map((f, i) => entry(f, i + 1, 1)) }
}

/**
 * Un hallazgo espera decisión si está abierto o en disputa, si su decisión se tomó después de la
 * última ronda (todavía se puede cambiar), o si es un aceptado que la última ronda vio sin resolver.
 */
function awaitsDecision(e: LedgerEntry, completed: number): boolean {
  if (e.state === 'abierto' || e.state === 'en-disputa') return true
  if (e.decision?.after_round === completed) return true
  const last = e.responses.at(-1)
  return e.state === 'aceptado' && last?.round === completed && last.answer === 'unresolved'
}

/** Aplica la decisión a todos los IDs o a ninguno: la lista se valida entera antes de cambiar nada. */
export function decide(l: Ledger, action: 'accept' | 'reject', ids: string[], reason?: string): Ledger {
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw new SddError('usage', 'falta al menos un ID de hallazgo (F-n)')
  if (action === 'reject' && (reason === undefined || reason.trim() === '')) {
    throw new SddError('usage', 'un rechazo necesita un motivo', { next: 'agrega --reason "<por qué no se corrige>"' })
  }
  const next = copy(l)
  const chosen = unique.map((id) => {
    const e = next.entries.find((x) => x.id === id)
    if (!e) throw new SddError('usage', `el hallazgo ${id} no existe en esta revisión`)
    if (!awaitsDecision(e, next.completed)) throw new SddError('usage', `el hallazgo ${id} no espera decisión: está ${e.state}`)
    return e
  })
  for (const e of chosen) {
    const from = e.decision?.after_round === next.completed ? e.decision.from : e.state
    const to = DECISION_STATE[from]?.[action]
    if (!to) throw new Error(`transición de decisión sin definir: ${from} con ${action}`)
    e.decision = { action, ...(reason !== undefined && reason.trim() !== '' ? { reason } : {}), from, after_round: next.completed }
    e.state = to
  }
  return next
}

/** Lo que la ronda siguiente tiene que verificar (aceptados) y responder (rechazados). */
export function targets(l: Ledger): Target[] {
  const out: Target[] = []
  for (const e of l.entries) {
    if (e.state === 'aceptado') out.push({ id: e.id, kind: 'verify' })
    else if (e.state === 'rechazado') out.push({ id: e.id, kind: 'respond' })
  }
  return out
}

/** Los hallazgos que impiden lanzar la ronda siguiente hasta que se decidan. */
export function undecided(l: Ledger): string[] {
  return l.entries.filter((e) => e.state === 'abierto' || e.state === 'en-disputa').map((e) => e.id)
}

export function applyRound(l: Ledger, n: number,
  responses: Array<{ id: string; answer: Answer; evidence?: string; note?: string }>,
  regressions: Finding[]): Ledger {
  const next = copy(l)
  for (const r of responses) {
    const e = next.entries.find((x) => x.id === r.id)
    if (!e) throw new Error(`respuesta a un hallazgo que no está en el ledger: ${r.id}`)
    e.state = ANSWER_STATE[r.answer]
    e.responses.push({
      round: n, answer: r.answer,
      ...(r.evidence !== undefined ? { evidence: r.evidence } : {}),
      ...(r.note !== undefined ? { note: r.note } : {}),
    })
  }
  for (const f of regressions) next.entries.push(entry(f, next.next_id++, n))
  next.completed = n
  return next
}

/** Los graves de la ronda `n` que solo se sostienen razonando: son los que vale la pena intentar refutar. */
export function refutationBatch(l: Ledger, n: number): LedgerEntry[] {
  return l.entries.filter((e) => e.round === n && e.state === 'abierto' && GRAVE.has(e.severity)
    && e.evidence === 'inferential' && (e.causality === 'introduced' || e.causality === 'worsened'))
}

/** Solo `refuted` saca un hallazgo; un refutador que no respondió nunca cuenta como refutación. */
export function applyRefutation(l: Ledger,
  outcome: { results: Array<{ id: string; result: RefuteResult; evidence?: string; note?: string }> }
         | { failed: string, ids: string[] }): Ledger {
  const next = copy(l)
  const find = (id: string) => {
    const e = next.entries.find((x) => x.id === id)
    if (!e) throw new Error(`resultado de refutación para un hallazgo que no está en el ledger: ${id}`)
    return e
  }
  if ('failed' in outcome) {
    for (const id of outcome.ids) find(id).refutation = { result: 'inconclusive', reason: outcome.failed }
    return next
  }
  for (const r of outcome.results) {
    const e = find(r.id)
    e.refutation = {
      result: r.result,
      ...(r.evidence !== undefined ? { evidence: r.evidence } : {}),
      ...(r.note !== undefined ? { note: r.note } : {}),
    }
    if (r.result === 'refuted') e.state = 'refutado'
  }
  return next
}

/** Los hallazgos que siguen contando para el veredicto. */
export function standing(l: Ledger): LedgerEntry[] {
  return l.entries.filter((e) => STANDING.has(e.state))
}

/** Cada eje falla con un grave que el cambio introdujo o empeoró y que sigue vigente. */
export function axesOf(l: Ledger): Axes {
  const current = standing(l)
  const fails = (axis: Finding['axis']) => current.some((e) => e.axis === axis && GRAVE.has(e.severity)
    && (e.causality === 'introduced' || e.causality === 'worsened'))
  let spec: Axes['spec'] = 'ok'
  if (fails('spec')) spec = 'fail'
  else if (current.some((e) => e.axis === 'spec' && e.severity === 'WARNING')) spec = 'warn'
  return { scope: fails('scope') ? 'fail' : 'ok', spec, quality: fails('quality') ? 'fail' : 'ok' }
}
