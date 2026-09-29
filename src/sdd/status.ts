import type { Proof } from '../approval/proof.ts'
import type { JiraMode } from '../config.ts'
import type { HeaderResult, SectionState, TaskCount } from './markdown.ts'

// El estado de un flujo SDD como función pura de sus hechos: no lee el disco, no mira el reloj y no
// escribe. Por eso este módulo solo importa tipos.

/** Las profundidades de `sdd-flow`, de menor a mayor. */
export const DEPTHS = ['corta', 'normal', 'completa'] as const
export type Depth = (typeof DEPTHS)[number]
export const GATE_IDS = ['single', 'spec', 'plan-tasks', 'plan', 'tasks'] as const
export type GateId = (typeof GATE_IDS)[number]
export type Artifact = 'spec' | 'plan' | 'tasks'
export const GATES: Record<Depth, readonly GateId[]> = {
  corta: ['single'], normal: ['spec', 'plan-tasks'], completa: ['spec', 'plan', 'tasks'],
}
export const GATE_ARTIFACTS: Record<GateId, readonly Artifact[]> = {
  single: ['plan'], spec: ['spec'], 'plan-tasks': ['plan', 'tasks'], plan: ['plan'], tasks: ['tasks'],
}
/** El ciclo de `status` del header de `plan.md`, en orden. */
export const STATUSES = ['planned', 'plan-approved', 'tasks-ready', 'implementing', 'verified', 'committed', 'pushed', 'pr-open', 'done'] as const
export type PlanStatus = (typeof STATUSES)[number]

export type FileState = 'absent' | 'empty' | 'present' | 'unreadable'
/** Una aprobación registrada; `proof` falta en las de antes de que `sdd approve` exigiera la respuesta del usuario. */
export interface Approval { gate: GateId; depth: Depth; fingerprint: string; previous: Partial<Record<GateId, string>>; at: string; proof?: Proof }
export type ApprovalLog = { state: 'absent' } | { state: 'invalid'; detail: string } | { state: 'ok'; approvals: Approval[] }
export interface FlowFacts {
  id: string
  files: Record<'spec' | 'plan' | 'tasks' | 'handoff', FileState>
  /** `null` sin un plan presente. */
  planHeader: HeaderResult | null
  /** `null` sin un handoff presente. */
  handoffHeader: HeaderResult | null
  planSections: { spec: SectionState; tasks: SectionState } | null
  /** Las tasks de un `tasks.md` presente. */
  tasksFile: TaskCount | null
  /** Las tasks de la sección `## Tasks` de `plan.md`. */
  tasksSection: TaskCount | null
  /** Las huellas que se pueden calcular con lo que está presente. */
  fingerprints: Partial<Record<GateId, string>>
  log: ApprovalLog
  paths: Record<string, string>
  /** Si el repositorio tiene al menos un remoto configurado. */
  hasRemote: boolean
  /** El modo de Jira del flujo, con el override del handoff ya aplicado; sin el campo vale `off`. */
  jira?: JiraMode
}

export type GateState = 'pending' | 'approved' | 'approved_unfingerprinted' | 'stale'
export interface Reason { code: string; detail: string }
export interface GateView { gate: GateId; artifacts: string[]; state: GateState }
export interface GateResolution { depth: Depth | null; gates: GateView[]; blocked: Reason[]; notes: Reason[] }
export type Step = 'no_artifacts' | 'depth' | 'specify' | 'plan' | 'tasks' | 'gate' | 'external_gate'
  | 'implement' | 'verify' | 'review_and_commit' | 'push' | 'open_pr' | 'archive' | 'resolve_blockers'
/** `command` y `detail` los agrega la CLI en un paso de fase: `resolve` nunca los escribe. */
export interface Next { step: Step; gate?: GateId; artifacts?: string[]; task?: string; command?: string; detail?: string }
export interface FlowStatus {
  id: string
  depth: Depth | null
  gates: GateView[]
  tasks: { total: number; done: number; pending: number; first_pending: string | null }
  next: Next
  blocked_reasons: Reason[]
  notes: Reason[]
  paths: Record<string, string>
}

/** Una parte que falta de un gate y el paso que la escribe. En `corta`, las secciones del documento único. */
export interface MissingPart { step: 'specify' | 'plan' | 'tasks'; name: string }

/** Desde qué `status` del plan el header da por aprobado cada gate. `spec` vale además con `spec_approved_at`. */
const ACCREDITED_FROM: Record<GateId, PlanStatus> = {
  spec: 'planned', plan: 'plan-approved', tasks: 'tasks-ready', 'plan-tasks': 'tasks-ready', single: 'tasks-ready',
}
const STEP_OF: Record<Artifact, MissingPart['step']> = { spec: 'specify', plan: 'plan', tasks: 'tasks' }
/** El paso que sigue a cada `status` de cierre, como en el retomado de `sdd-flow`; `pushed` depende de `pr_url`. */
const CLOSING: Partial<Record<PlanStatus, Step>> = { verified: 'review_and_commit', committed: 'push', 'pr-open': 'archive', done: 'archive' }
/** Los `status` que dicen que la implementación terminó. */
const AFTER_IMPLEMENTING: readonly PlanStatus[] = STATUSES.slice(STATUSES.indexOf('implementing') + 1)
const EXTERNAL_PENDING: readonly unknown[] = ['awaiting', 'changes-requested']
const APPROVED: readonly GateState[] = ['approved', 'approved_unfingerprinted']

export const isDepth = (v: unknown): v is Depth => typeof v === 'string' && (DEPTHS as readonly string[]).includes(v)
const rank = (d: Depth) => DEPTHS.indexOf(d)
export const headerData = (h: HeaderResult | null): Record<string, unknown> | null => (h?.ok ? h.data : null)

/** El `status` del plan si es uno del ciclo y cabe en la profundidad: `plan-approved` es solo de `completa`. */
export function planStatus(facts: FlowFacts, depth: Depth | null): PlanStatus | null {
  const s = headerData(facts.planHeader)?.status
  if (typeof s !== 'string' || !(STATUSES as readonly string[]).includes(s)) return null
  if (s === 'plan-approved' && depth !== null && depth !== 'completa') return null
  return s as PlanStatus
}

/** Lo que le falta a un gate para poder presentarse: un artefacto ausente, vacío o ilegible cuenta como faltante. */
export function missingParts(facts: FlowFacts, gate: GateId): MissingPart[] {
  if (gate === 'single') {
    if (facts.files.plan !== 'present') return [{ step: 'specify', name: 'plan.md' }]
    const parts: MissingPart[] = []
    if (facts.planSections?.spec !== 'present') parts.push({ step: 'specify', name: 'plan.md#Spec' })
    if (facts.planSections?.tasks !== 'present') parts.push({ step: 'tasks', name: 'plan.md#Tasks' })
    return parts
  }
  return GATE_ARTIFACTS[gate].filter((a) => facts.files[a] !== 'present').map((a) => ({ step: STEP_OF[a], name: `${a}.md` }))
}

/** Si el header de `sdd-flow` da el gate por aprobado, sin mirar escaladas ni el registro. */
function headerAccredits(facts: FlowFacts, gate: GateId, status: PlanStatus | null): boolean {
  if (gate === 'spec') {
    const at = headerData(facts.handoffHeader)?.spec_approved_at
    if (at !== undefined && at !== null) return true
  }
  return status !== null && STATUSES.indexOf(status) >= STATUSES.indexOf(ACCREDITED_FROM[gate])
}

/** La aprobación vale si su huella es la de hoy y cada gate anterior sigue con la huella que tenía al aprobarla. */
function isFresh(a: Approval, fingerprints: FlowFacts['fingerprints']): boolean {
  return fingerprints[a.gate] === a.fingerprint
    && Object.entries(a.previous).every(([gate, f]) => fingerprints[gate as GateId] === f)
}

/**
 * La profundidad que manda, su piso y el estado de cada gate. Manda el header del plan si hay plan, y
 * si no el del handoff. El piso es la mayor de las profundidades que el flujo ya declaró: la del
 * handoff cuando manda el plan y las del registro. En un flujo que escaló, el header solo acredita los
 * gates que ya existían en la menor de esas profundidades: los que agregó la escalada se aprueban con
 * `sdd approve`.
 */
export function resolveGates(facts: FlowFacts): GateResolution {
  const blocked: Reason[] = []
  const notes: Reason[] = []
  const headers: Array<[string, HeaderResult | null]> = [['plan.md', facts.planHeader], ['handoff.md', facts.handoffHeader]]
  for (const [name, h] of headers) {
    if (h && !h.ok) blocked.push({ code: 'header_invalid', detail: `${name}: ${h.detail}` })
  }

  const [governingName, governing] = facts.planHeader ? headers[0] : headers[1]
  let depth: Depth | null = null
  if (governing?.ok) {
    if (isDepth(governing.data.profundidad)) depth = governing.data.profundidad
    else blocked.push({ code: 'depth_invalid', detail: `${governingName} no declara una profundidad válida: corta, normal o completa` })
  }
  if (depth === null) return { depth, gates: [], blocked, notes }

  const approvals = facts.log.state === 'ok' ? facts.log.approvals : []
  const earlier: Depth[] = approvals.map((a) => a.depth)
  const handoffDepth = headerData(facts.handoffHeader)?.profundidad
  if (facts.planHeader && isDepth(handoffDepth)) earlier.push(handoffDepth)
  const floor = earlier.reduce<Depth | null>((m, d) => (m === null || rank(d) > rank(m) ? d : m), null)
  const lowest = earlier.reduce<Depth | null>((m, d) => (m === null || rank(d) < rank(m) ? d : m), null)
  if (floor !== null && rank(depth) < rank(floor)) {
    blocked.push({ code: 'depth_reduced', detail: `la profundidad es ${depth}, y el flujo ya había declarado ${floor}: la profundidad solo escala` })
  }
  const escalatedFrom = lowest !== null && rank(lowest) < rank(depth) ? lowest : null

  const status = planStatus(facts, depth)
  const gates = GATES[depth].map((gate): GateView => {
    const byHeader = headerAccredits(facts, gate, status)
    const last = approvals.findLast((a) => a.gate === gate)
    let state: GateState
    if (last) {
      state = isFresh(last, facts.fingerprints) ? 'approved' : 'stale'
      if (state === 'approved' && last.proof === undefined) {
        notes.push({ code: 'approval_unproven', detail: `el gate ${gate} tiene una aprobación registrada sin prueba del runner: se registró antes de que sdd approve exigiera la respuesta del usuario` })
      }
      if (state === 'approved' && !byHeader) {
        notes.push({ code: 'header_behind', detail: `el gate ${gate} tiene una aprobación registrada vigente que el header de sdd-flow todavía no refleja` })
      }
      if (state === 'stale' && byHeader) {
        notes.push({ code: 'header_ahead', detail: `el header de sdd-flow da por aprobado el gate ${gate}, pero su aprobación registrada venció: sdd-flow retomaría más adelante de lo que el registro sostiene` })
      }
    } else if (byHeader && (escalatedFrom === null || GATES[escalatedFrom].includes(gate))) {
      // Un gate aprobado cuyo artefacto quedó vacío vence; si lo que falta son las tasks, lo dice tasks_empty.
      state = missingParts(facts, gate).some((p) => p.step !== 'tasks') ? 'stale' : 'approved_unfingerprinted'
      if (state === 'approved_unfingerprinted') {
        notes.push({ code: 'approved_unfingerprinted', detail: `el header de sdd-flow da por aprobado el gate ${gate} sin una aprobación registrada con sdd approve ni prueba del runner: un cambio en sus artefactos no se detecta` })
      }
    } else {
      state = 'pending'
    }
    return { gate, artifacts: GATE_ARTIFACTS[gate].map((a) => `${a}.md`), state }
  })
  return { depth, gates, blocked, notes }
}

/**
 * La respuesta de `sdd status`: sobre `resolveGates`, suma los demás bloqueos, las tasks del artefacto
 * de la profundidad y `next`. `next` sale del primer caso que aplica: bloqueos, sin artefactos, sin
 * profundidad, el primer gate que no está aprobado, los `status` de cierre, las tasks pendientes y
 * `verify`. Así un gate vencido gana a lo que diga el header.
 */
export function resolve(facts: FlowFacts): FlowStatus {
  const { depth, gates, blocked, notes } = resolveGates(facts)
  const plan = headerData(facts.planHeader)

  for (const name of ['spec', 'plan', 'tasks', 'handoff'] as const) {
    if (facts.files[name] === 'unreadable') blocked.push({ code: 'artifact_unreadable', detail: `${name}.md existe y no se puede leer` })
  }
  if (facts.log.state === 'invalid') blocked.push({ code: 'approvals_invalid', detail: `el registro de aprobaciones no sirve: ${facts.log.detail}` })
  const noArtifacts = (['spec', 'plan', 'handoff'] as const).every((a) => facts.files[a] !== 'present')
  if (facts.jira?.mode === 'invalid' && !noArtifacts) {
    blocked.push({ code: 'jira_approval_invalid', detail: `${facts.jira.detail}: corrige el valor o quita la clave` })
  }

  if (depth === 'corta') {
    for (const name of ['spec', 'tasks'] as const) {
      if (facts.files[name] === 'present') blocked.push({ code: 'layout_mismatch', detail: `en corta la ${name} va como sección ## de plan.md, y hay un ${name}.md` })
    }
  } else if (depth !== null) {
    for (const [name, title] of [['spec', 'Spec'], ['tasks', 'Tasks']] as const) {
      if (facts.planSections?.[name] === 'present') blocked.push({ code: 'layout_mismatch', detail: `en ${depth} la ${name} va en ${name}.md, y plan.md tiene una sección ## ${title}` })
    }
  }

  const status = planStatus(facts, depth)
  if (plan !== null && status === null) {
    blocked.push({ code: 'status_invalid', detail: `plan.md tiene un status que no sirve para ${depth ?? 'esta profundidad'}: ${JSON.stringify(plan.status ?? null)}` })
  }

  const count = (depth === 'corta' ? facts.tasksSection : facts.tasksFile) ?? { total: 0, done: 0, firstPending: null }
  const pending = count.total - count.done
  if (status !== null && AFTER_IMPLEMENTING.includes(status) && pending > 0) {
    blocked.push({ code: 'status_ahead', detail: `plan.md dice ${status} y quedan ${pending} tasks pendientes` })
  }
  if (depth !== null && count.total === 0) {
    const written = depth === 'corta' ? facts.planSections?.tasks === 'present' : facts.files.tasks === 'present'
    const tasksGate = gates[gates.length - 1]
    if (written || APPROVED.includes(tasksGate.state)) {
      blocked.push({ code: 'tasks_empty', detail: written ? 'el artefacto de tasks tiene contenido y ninguna task' : `el gate ${tasksGate.gate} cuenta como aprobado y no hay ninguna task` })
    }
  }

  const gateStatus = headerData(facts.handoffHeader)?.gate_status
  const external = EXTERNAL_PENDING.includes(gateStatus)
  // Con Jira en on, la spec necesita la aprobación externa aunque el handoff no tenga gate_status.
  const held = facts.jira?.mode === 'on' && gateStatus !== 'approved'
  if (external) {
    notes.push({ code: 'external_gate', detail: `el handoff espera la aprobación externa de la spec (gate_status: ${String(gateStatus)}): no se implementa hasta que vuelva` })
  } else if (held) {
    const said = gateStatus === undefined ? 'no tiene gate_status' : `dice gate_status: ${String(gateStatus)}`
    notes.push({ code: 'external_gate', detail: `con jira_approval en on la spec necesita la aprobación externa, y el handoff ${said}: no se implementa ni se commitea hasta que diga approved` })
  }

  const next = ((): Next => {
    if (blocked.length > 0) return { step: 'resolve_blockers' }
    if (noArtifacts) return { step: 'no_artifacts' }
    if (depth === null) return { step: 'depth' }
    const open = gates.find((g) => !APPROVED.includes(g.state))
    if (open) {
      const missing = missingParts(facts, open.gate)
      if (missing.length > 0) return { step: missing[0].step, artifacts: missing.map((p) => p.name) }
      return { step: 'gate', gate: open.gate, artifacts: open.artifacts }
    }
    // Sin remoto no hay push ni PR posibles: `committed` y `pushed` pasan a archivar.
    if (!facts.hasRemote && (status === 'committed' || status === 'pushed')) return { step: 'archive' }
    if (status === 'pushed') return { step: typeof plan?.pr_url === 'string' && plan.pr_url !== '' ? 'archive' : 'open_pr' }
    const closing = status !== null ? CLOSING[status] : undefined
    if (closing) return held && closing === 'review_and_commit' ? { step: 'external_gate' } : { step: closing }
    if (pending > 0) return external || held ? { step: 'external_gate' } : { step: 'implement', task: count.firstPending ?? '' }
    return held ? { step: 'external_gate' } : { step: 'verify' }
  })()

  return {
    id: facts.id,
    depth,
    gates,
    tasks: { total: count.total, done: count.done, pending, first_pending: count.firstPending },
    next,
    blocked_reasons: blocked,
    notes,
    paths: facts.paths,
  }
}
