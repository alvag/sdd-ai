import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HeaderResult } from '../src/sdd/markdown.ts'
import {
  type Approval, type ApprovalLog, type Depth, type FlowFacts, GATE_ARTIFACTS, GATES, type GateId, type GateResolution, type Reason,
  resolve, resolveGates,
} from '../src/sdd/status.ts'

const fp = (c: string) => `sha256:${c.repeat(64)}`
const FP: Record<GateId, string> = { spec: fp('a'), plan: fp('b'), tasks: fp('c'), 'plan-tasks': fp('d'), single: fp('e') }
const SPEC_APPROVED_AT = '2026-09-27T18:31:17-05:00'

const hdr = (data: Record<string, unknown>): HeaderResult => ({ ok: true, data, body: '' })
const approval = (gate: GateId, depth: Depth, fingerprint: string, previous: Partial<Record<GateId, string>> = {}): Approval =>
  ({ gate, depth, fingerprint, previous, at: '2026-09-28T10:00:00.000Z' })
const log = (...approvals: Approval[]): ApprovalLog => ({ state: 'ok', approvals })
const states = (r: { gates: Array<{ gate: GateId; state: string }> }) => Object.fromEntries(r.gates.map((g) => [g.gate, g.state]))
const codes = (rs: Reason[]) => rs.map((r) => r.code)
const noteFor = (r: GateResolution, code: string) => r.notes.filter((n) => n.code === code).map((n) => n.detail)

/**
 * Un flujo en memoria con el layout de su profundidad, las huellas escritas a mano y los dos headers:
 * el del plan con `status` y el del handoff con la misma profundidad y la spec aprobada.
 */
function flow(depth: Depth, status: string, o: Partial<FlowFacts> = {}): FlowFacts {
  const corta = depth === 'corta'
  const tasks = { total: 2, done: 1, firstPending: 'T2 — segunda' }
  return {
    id: 'f',
    files: { spec: corta ? 'absent' : 'present', plan: 'present', tasks: corta ? 'absent' : 'present', handoff: 'present' },
    planHeader: hdr({ profundidad: depth, status }),
    handoffHeader: hdr({ profundidad: depth, spec_approved_at: SPEC_APPROVED_AT }),
    planSections: corta ? { spec: 'present', tasks: 'present' } : { spec: 'absent', tasks: 'absent' },
    tasksFile: corta ? null : tasks,
    tasksSection: corta ? tasks : null,
    fingerprints: corta ? { plan: FP.plan, single: FP.single } : { spec: FP.spec, plan: FP.plan, tasks: FP.tasks, 'plan-tasks': FP['plan-tasks'] },
    log: { state: 'absent' },
    paths: { dir: '.plans/f' },
    ...o,
  }
}

test('cada profundidad tiene sus gates y su layout', () => {
  assert.deepEqual(GATES, { corta: ['single'], normal: ['spec', 'plan-tasks'], completa: ['spec', 'plan', 'tasks'] })
  assert.deepEqual(GATE_ARTIFACTS, { single: ['plan'], spec: ['spec'], 'plan-tasks': ['plan', 'tasks'], plan: ['plan'], tasks: ['tasks'] })

  assert.deepEqual(resolveGates(flow('corta', 'planned')).gates, [{ gate: 'single', artifacts: ['plan.md'], state: 'pending' }])
  assert.deepEqual(resolveGates(flow('normal', 'planned')).gates, [
    { gate: 'spec', artifacts: ['spec.md'], state: 'approved_unfingerprinted' },
    { gate: 'plan-tasks', artifacts: ['plan.md', 'tasks.md'], state: 'pending' },
  ])
  const completa = resolveGates(flow('completa', 'plan-approved'))
  assert.equal(completa.depth, 'completa')
  assert.deepEqual(completa.gates.map((g) => [g.gate, g.artifacts]), [['spec', ['spec.md']], ['plan', ['plan.md']], ['tasks', ['tasks.md']]])
  assert.deepEqual(completa.blocked, [])
})

test('la profundidad solo escala, con o sin aprobaciones registradas', () => {
  const reduced = resolveGates(flow('normal', 'planned', { handoffHeader: hdr({ profundidad: 'completa' }) }))
  assert.equal(reduced.depth, 'normal')
  assert.deepEqual(codes(reduced.blocked), ['depth_reduced'])

  const byLog = resolveGates(flow('normal', 'planned', { log: log(approval('spec', 'completa', FP.spec)) }))
  assert.deepEqual(codes(byLog.blocked), ['depth_reduced'])

  // Sin plan manda el handoff, y el piso lo pone el registro.
  const handoffOnly = resolveGates(flow('normal', 'planned', {
    files: { spec: 'present', plan: 'absent', tasks: 'absent', handoff: 'present' }, planHeader: null, planSections: null,
    log: log(approval('spec', 'completa', FP.spec)),
  }))
  assert.equal(handoffOnly.depth, 'normal')
  assert.deepEqual(codes(handoffOnly.blocked), ['depth_reduced'])

  const escalated = resolveGates(flow('completa', 'planned', { handoffHeader: hdr({ profundidad: 'normal' }) }))
  assert.deepEqual(escalated.blocked, [])
})

test('después de escalar el header no acredita los gates nuevos y la aprobación de spec sigue', () => {
  const byHeader = resolveGates(flow('completa', 'tasks-ready', { handoffHeader: hdr({ profundidad: 'normal', spec_approved_at: SPEC_APPROVED_AT }) }))
  assert.deepEqual(states(byHeader), { spec: 'approved_unfingerprinted', plan: 'pending', tasks: 'pending' })

  const byLog = resolveGates(flow('completa', 'tasks-ready', {
    handoffHeader: hdr({ profundidad: 'normal', spec_approved_at: SPEC_APPROVED_AT }),
    log: log(approval('spec', 'normal', FP.spec), approval('plan-tasks', 'normal', FP['plan-tasks'], { spec: FP.spec })),
  }))
  assert.deepEqual(states(byLog), { spec: 'approved', plan: 'pending', tasks: 'pending' })
  assert.deepEqual(byLog.blocked, [])
})

test('con dos escaladas seguidas el header no acredita ningún gate que agregó la cadena', () => {
  const r = resolveGates(flow('completa', 'tasks-ready', {
    handoffHeader: hdr({ profundidad: 'normal', spec_approved_at: SPEC_APPROVED_AT }),
    log: log(approval('single', 'corta', FP.single)),
  }))
  assert.deepEqual(states(r), { spec: 'pending', plan: 'pending', tasks: 'pending' })
  assert.deepEqual(r.blocked, [])
})

test('un gate acreditado por el header queda approved_unfingerprinted con nota, y un plan acredita la spec', () => {
  const noPlan: Partial<FlowFacts> = {
    files: { spec: 'present', plan: 'absent', tasks: 'absent', handoff: 'present' }, planHeader: null, planSections: null, tasksFile: null,
  }
  const specOnly = resolveGates(flow('completa', 'planned', noPlan))
  assert.deepEqual(states(specOnly), { spec: 'approved_unfingerprinted', plan: 'pending', tasks: 'pending' })
  assert.equal(noteFor(specOnly, 'approved_unfingerprinted').length, 1)
  assert.match(noteFor(specOnly, 'approved_unfingerprinted')[0], /spec/)

  const notApproved = resolveGates(flow('completa', 'planned', { ...noPlan, handoffHeader: hdr({ profundidad: 'completa', spec_approved_at: null }) }))
  assert.deepEqual(states(notApproved), { spec: 'pending', plan: 'pending', tasks: 'pending' })

  assert.deepEqual(states(resolveGates(flow('completa', 'plan-approved'))), { spec: 'approved_unfingerprinted', plan: 'approved_unfingerprinted', tasks: 'pending' })
  const all = resolveGates(flow('completa', 'tasks-ready'))
  assert.deepEqual(states(all), { spec: 'approved_unfingerprinted', plan: 'approved_unfingerprinted', tasks: 'approved_unfingerprinted' })
  assert.equal(noteFor(all, 'approved_unfingerprinted').length, 3)
  assert.deepEqual(states(resolveGates(flow('normal', 'tasks-ready'))), { spec: 'approved_unfingerprinted', 'plan-tasks': 'approved_unfingerprinted' })
  assert.deepEqual(states(resolveGates(flow('corta', 'tasks-ready'))), { single: 'approved_unfingerprinted' })

  // Sin handoff, un plan con un `status` válido acredita la spec.
  const planOnly = resolveGates(flow('completa', 'planned', { files: { spec: 'present', plan: 'present', tasks: 'absent', handoff: 'absent' }, handoffHeader: null }))
  assert.deepEqual(states(planOnly), { spec: 'approved_unfingerprinted', plan: 'pending', tasks: 'pending' })
})

test('una aprobación vencida prevalece sobre el header, y header_behind y header_ahead van a notas', () => {
  const ahead = resolveGates(flow('completa', 'tasks-ready', { log: log(approval('spec', 'completa', fp('9'))) }))
  assert.equal(states(ahead).spec, 'stale')
  assert.equal(noteFor(ahead, 'header_ahead').length, 1)
  assert.match(noteFor(ahead, 'header_ahead')[0], /spec/)

  const behind = resolveGates(flow('completa', 'planned', {
    log: log(approval('spec', 'completa', FP.spec), approval('plan', 'completa', FP.plan, { spec: FP.spec })),
  }))
  assert.deepEqual(states(behind), { spec: 'approved', plan: 'approved', tasks: 'pending' })
  assert.equal(noteFor(behind, 'header_behind').length, 1)
  assert.match(noteFor(behind, 'header_behind')[0], /plan/)
  assert.deepEqual(behind.blocked, [])
})

test('cambiar la huella de un gate anterior vence los posteriores aunque se reapruebe', () => {
  const old = fp('0')
  const r = resolveGates(flow('completa', 'implementing', {
    log: log(
      approval('spec', 'completa', old),
      approval('plan', 'completa', FP.plan, { spec: old }),
      approval('tasks', 'completa', FP.tasks, { spec: old, plan: FP.plan }),
      approval('spec', 'completa', FP.spec),
    ),
  }))
  assert.deepEqual(states(r), { spec: 'approved', plan: 'stale', tasks: 'stale' })
})

const DONE = { total: 2, done: 2, firstPending: null }
const noPlan: Partial<FlowFacts> = {
  files: { spec: 'present', plan: 'absent', tasks: 'absent', handoff: 'present' }, planHeader: null, planSections: null, tasksFile: null,
}

test('la respuesta trae profundidad, gates, tasks, next, bloqueos, notas y rutas', () => {
  const r = resolve(flow('completa', 'implementing', { paths: { dir: '.plans/f', spec: '.plans/f/spec.md' } }))
  assert.deepEqual(Object.keys(r), ['id', 'depth', 'gates', 'tasks', 'next', 'blocked_reasons', 'notes', 'paths'])
  assert.equal(r.id, 'f')
  assert.equal(r.depth, 'completa')
  assert.deepEqual(r.gates, [
    { gate: 'spec', artifacts: ['spec.md'], state: 'approved_unfingerprinted' },
    { gate: 'plan', artifacts: ['plan.md'], state: 'approved_unfingerprinted' },
    { gate: 'tasks', artifacts: ['tasks.md'], state: 'approved_unfingerprinted' },
  ])
  assert.deepEqual(r.tasks, { total: 2, done: 1, pending: 1, first_pending: 'T2 — segunda' })
  assert.deepEqual(r.next, { step: 'implement', task: 'T2 — segunda' })
  assert.deepEqual(r.blocked_reasons, [])
  assert.deepEqual(codes(r.notes), ['approved_unfingerprinted', 'approved_unfingerprinted', 'approved_unfingerprinted'])
  for (const n of r.notes) assert.deepEqual(Object.keys(n), ['code', 'detail'])
  assert.deepEqual(r.paths, { dir: '.plans/f', spec: '.plans/f/spec.md' })
})

test('sin profundidad next es depth y sin artefactos es no_artifacts, sin bloquear', () => {
  const specOnly = resolve(flow('completa', 'planned', { ...noPlan, files: { spec: 'present', plan: 'absent', tasks: 'absent', handoff: 'absent' }, handoffHeader: null }))
  assert.equal(specOnly.depth, null)
  assert.deepEqual(specOnly.gates, [])
  assert.deepEqual(specOnly.next, { step: 'depth' })
  assert.deepEqual(specOnly.blocked_reasons, [])

  for (const spec of ['absent', 'empty'] as const) {
    const empty = resolve(flow('completa', 'planned', { ...noPlan, files: { spec, plan: 'absent', tasks: 'absent', handoff: 'absent' }, handoffHeader: null }))
    assert.deepEqual(empty.next, { step: 'no_artifacts' })
    assert.deepEqual(empty.blocked_reasons, [])
  }
})

test('un layout de otra profundidad bloquea y un artefacto pendiente no', () => {
  for (const files of [{ spec: 'present', tasks: 'absent' }, { spec: 'absent', tasks: 'present' }] as const) {
    const r = resolve(flow('corta', 'planned', { files: { ...files, plan: 'present', handoff: 'present' } }))
    assert.deepEqual(codes(r.blocked_reasons), ['layout_mismatch'])
    assert.deepEqual(r.next, { step: 'resolve_blockers' })
  }
  for (const planSections of [{ spec: 'present', tasks: 'absent' }, { spec: 'absent', tasks: 'present' }] as const) {
    assert.deepEqual(codes(resolve(flow('completa', 'planned', { planSections })).blocked_reasons), ['layout_mismatch'])
  }
  // Con la spec en su gate, que falten plan.md y tasks.md no bloquea: el flujo todavía no llegó ahí.
  const pending = resolve(flow('completa', 'planned', { ...noPlan, handoffHeader: hdr({ profundidad: 'completa', spec_approved_at: null }) }))
  assert.deepEqual(pending.blocked_reasons, [])
  assert.deepEqual(pending.next, { step: 'gate', gate: 'spec', artifacts: ['spec.md'] })
})

test('next recorre los gates en orden y un artefacto posterior no hace avanzar', () => {
  assert.deepEqual(resolve(flow('completa', 'planned')).next, { step: 'gate', gate: 'plan', artifacts: ['plan.md'] })
  assert.deepEqual(resolve(flow('completa', 'planned', noPlan)).next, { step: 'plan', artifacts: ['plan.md'] })
  assert.deepEqual(resolve(flow('completa', 'plan-approved', { files: { spec: 'present', plan: 'present', tasks: 'absent', handoff: 'present' }, tasksFile: null })).next,
    { step: 'tasks', artifacts: ['tasks.md'] })
  assert.deepEqual(resolve(flow('normal', 'planned')).next, { step: 'gate', gate: 'plan-tasks', artifacts: ['plan.md', 'tasks.md'] })
  assert.deepEqual(resolve(flow('normal', 'planned', { files: { spec: 'present', plan: 'present', tasks: 'absent', handoff: 'present' }, tasksFile: null })).next,
    { step: 'tasks', artifacts: ['tasks.md'] })
})

test('con los gates aprobados next es implement con la primera pendiente o verify', () => {
  assert.deepEqual(resolve(flow('completa', 'tasks-ready')).next, { step: 'implement', task: 'T2 — segunda' })
  assert.deepEqual(resolve(flow('corta', 'implementing')).next, { step: 'implement', task: 'T2 — segunda' })
  const done = resolve(flow('completa', 'implementing', { tasksFile: DONE }))
  assert.deepEqual(done.next, { step: 'verify' })
  assert.deepEqual(done.tasks, { total: 2, done: 2, pending: 0, first_pending: null })
})

test('desde verified, committed, pushed y pr-open next sigue la tabla de retomado', () => {
  const closing = (status: string, extra: Record<string, unknown> = {}) =>
    resolve(flow('completa', status, { tasksFile: DONE, planHeader: hdr({ profundidad: 'completa', status, ...extra }) })).next
  assert.deepEqual(closing('verified'), { step: 'review_and_commit' })
  assert.deepEqual(closing('committed'), { step: 'push' })
  assert.deepEqual(closing('pushed'), { step: 'open_pr' })
  assert.deepEqual(closing('pushed', { pr_url: 'https://example.test/pr/1' }), { step: 'archive' })
  assert.deepEqual(closing('pr-open', { pr_url: 'https://example.test/pr/1' }), { step: 'archive' })
  assert.deepEqual(closing('done'), { step: 'archive' })
})

test('un gate vencido gana a los estados de cierre del header', () => {
  const r = resolve(flow('completa', 'verified', { tasksFile: DONE, log: log(approval('spec', 'completa', fp('9'))) }))
  assert.equal(states(r).spec, 'stale')
  assert.deepEqual(r.next, { step: 'gate', gate: 'spec', artifacts: ['spec.md'] })
})

test('un gate aprobado cuyo artefacto quedó vacío está vencido y next pide escribirlo', () => {
  const emptySpec: Partial<FlowFacts> = {
    files: { spec: 'empty', plan: 'present', tasks: 'present', handoff: 'present' },
    fingerprints: { plan: FP.plan, tasks: FP.tasks, 'plan-tasks': FP['plan-tasks'] },
  }
  const registered = resolve(flow('completa', 'planned', { ...emptySpec, log: log(approval('spec', 'completa', FP.spec)) }))
  assert.equal(states(registered).spec, 'stale')
  assert.deepEqual(registered.next, { step: 'specify', artifacts: ['spec.md'] })

  const byHeader = resolve(flow('completa', 'implementing', emptySpec))
  assert.equal(states(byHeader).spec, 'stale')
  assert.deepEqual(byHeader.next, { step: 'specify', artifacts: ['spec.md'] })
  assert.deepEqual(byHeader.blocked_reasons, [])
})

test('cada contradicción va a blocked_reasons con su código y next es resolve_blockers', () => {
  const cases: Array<[string, FlowFacts]> = [
    ['header_invalid', flow('completa', 'planned', { planHeader: { ok: false, detail: 'no tiene header' } })],
    ['header_invalid', flow('completa', 'planned', { handoffHeader: { ok: false, detail: 'el header no cierra' } })],
    ['depth_invalid', flow('completa', 'planned', { planHeader: hdr({ profundidad: 'larga', status: 'planned' }) })],
    ['depth_invalid', flow('completa', 'planned', { ...noPlan, handoffHeader: hdr({ spec_approved_at: null }) })],
    ['depth_reduced', flow('normal', 'planned', { handoffHeader: hdr({ profundidad: 'completa' }) })],
    ['layout_mismatch', flow('corta', 'planned', { files: { spec: 'present', plan: 'present', tasks: 'absent', handoff: 'present' } })],
    ['status_invalid', flow('completa', 'planned', { planHeader: hdr({ profundidad: 'completa' }) })],
    ['status_invalid', flow('completa', 'revisado')],
    ['status_invalid', flow('normal', 'plan-approved')],
    ['status_ahead', flow('completa', 'verified')],
    // Un tasks.md con prosa y sin tasks bloquea aunque su gate no haya llegado.
    ['tasks_empty', flow('completa', 'planned', { tasksFile: { total: 0, done: 0, firstPending: null } })],
    // Un gate de tasks que cuenta como aprobado sin ninguna task, con el artefacto vacío.
    ['tasks_empty', flow('completa', 'tasks-ready', { files: { spec: 'present', plan: 'present', tasks: 'empty', handoff: 'present' }, tasksFile: null })],
    ['artifact_unreadable', flow('completa', 'planned', { files: { spec: 'unreadable', plan: 'present', tasks: 'present', handoff: 'present' } })],
    ['approvals_invalid', flow('completa', 'planned', { log: { state: 'invalid', detail: 'approvals no es una lista' } })],
  ]
  for (const [code, facts] of cases) {
    const r = resolve(facts)
    assert.ok(codes(r.blocked_reasons).includes(code), `${code}: ${JSON.stringify(r.blocked_reasons)}`)
    assert.deepEqual(r.next, { step: 'resolve_blockers' }, code)
    for (const b of r.blocked_reasons) assert.notEqual(b.detail, '')
  }
})

test('en corta, una sección Spec o Tasks vacía pide escribirla antes del gate single', () => {
  const noTasks = { total: 0, done: 0, firstPending: null }
  const specEmpty = resolve(flow('corta', 'planned', { planSections: { spec: 'empty', tasks: 'present' } }))
  assert.deepEqual(states(specEmpty), { single: 'pending' })
  assert.deepEqual(specEmpty.next, { step: 'specify', artifacts: ['plan.md#Spec'] })
  const tasksEmpty = resolve(flow('corta', 'planned', { planSections: { spec: 'present', tasks: 'empty' }, tasksSection: noTasks }))
  assert.deepEqual(states(tasksEmpty), { single: 'pending' })
  assert.deepEqual(tasksEmpty.next, { step: 'tasks', artifacts: ['plan.md#Tasks'] })
  assert.deepEqual(tasksEmpty.blocked_reasons, [])

  // Acreditado por el header: sin tasks bloquea, y sin spec vence.
  const accreditedTasks = resolve(flow('corta', 'tasks-ready', { planSections: { spec: 'present', tasks: 'empty' }, tasksSection: noTasks }))
  assert.deepEqual(codes(accreditedTasks.blocked_reasons), ['tasks_empty'])
  assert.deepEqual(accreditedTasks.next, { step: 'resolve_blockers' })
  const accreditedSpec = resolve(flow('corta', 'tasks-ready', { planSections: { spec: 'empty', tasks: 'present' } }))
  assert.deepEqual(states(accreditedSpec), { single: 'stale' })
  assert.deepEqual(accreditedSpec.next, { step: 'specify', artifacts: ['plan.md#Spec'] })

  // Con aprobación registrada, vaciar una sección cambia la huella: el gate vence y no cuenta como aprobado.
  const registered = resolve(flow('corta', 'tasks-ready', {
    planSections: { spec: 'present', tasks: 'empty' }, tasksSection: noTasks, fingerprints: { plan: FP.plan, single: fp('f') },
    log: log(approval('single', 'corta', FP.single)),
  }))
  assert.deepEqual(states(registered), { single: 'stale' })
  assert.deepEqual(registered.next, { step: 'tasks', artifacts: ['plan.md#Tasks'] })
  assert.deepEqual(registered.blocked_reasons, [])
})

test('un gate externo pendiente deja planificar y cambia implement por external_gate', () => {
  for (const gateStatus of ['awaiting', 'changes-requested']) {
    const handoffHeader = hdr({ profundidad: 'completa', spec_approved_at: SPEC_APPROVED_AT, gate_status: gateStatus })
    const planning = resolve(flow('completa', 'planned', { handoffHeader }))
    assert.deepEqual(planning.next, { step: 'gate', gate: 'plan', artifacts: ['plan.md'] })
    assert.deepEqual(planning.blocked_reasons, [])
    assert.equal(planning.notes.filter((n) => n.code === 'external_gate').length, 1)
    assert.deepEqual(resolve(flow('completa', 'implementing', { handoffHeader })).next, { step: 'external_gate' })
    assert.deepEqual(resolve(flow('completa', 'implementing', { handoffHeader, tasksFile: DONE })).next, { step: 'verify' })
  }
  const approved = hdr({ profundidad: 'completa', spec_approved_at: SPEC_APPROVED_AT, gate_status: 'approved' })
  assert.deepEqual(resolve(flow('completa', 'implementing', { handoffHeader: approved })).next, { step: 'implement', task: 'T2 — segunda' })
})

test('resolve da la misma respuesta con los mismos hechos, armados en memoria', () => {
  const facts = flow('normal', 'implementing', { log: log(approval('spec', 'normal', FP.spec)) })
  const first = resolve(facts)
  assert.deepEqual(resolve(facts), first)
  assert.deepEqual(resolve(structuredClone(facts)), first)
})

test('una aprobación sin proof cuenta y deja la nota approval_unproven', () => {
  const proof = { runner: 'claude' as const, source: 'ask_user_question' as const, ref: 'tu-1:0123456789abcdef', session: 's-1', answered_at: '2026-09-28T12:00:00.000Z' }
  const r = resolveGates(flow('completa', 'planned', {
    handoffHeader: hdr({ profundidad: 'completa' }),
    log: log(approval('spec', 'completa', FP.spec), { ...approval('plan', 'completa', FP.plan, { spec: FP.spec }), proof }),
  }))
  assert.deepEqual(states(r), { spec: 'approved', plan: 'approved', tasks: 'pending' })
  assert.equal(noteFor(r, 'approval_unproven').length, 1)
  assert.match(noteFor(r, 'approval_unproven')[0], /gate spec/)
  assert.deepEqual(r.blocked, [])
})

test('la nota de approved_unfingerprinted dice que no tiene prueba del runner', () => {
  const r = resolveGates(flow('completa', 'planned'))
  assert.match(noteFor(r, 'approved_unfingerprinted')[0], /sin una aprobación registrada con sdd approve ni prueba del runner/)
})
