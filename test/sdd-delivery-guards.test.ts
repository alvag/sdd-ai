import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { type TaskActor, section } from '../src/sdd/markdown.ts'
import { admitSpecify, renderSpec } from '../src/sdd/phase.ts'
import { readFlow } from '../src/sdd/read.ts'
import { readPhaseRecord } from '../src/sdd/phase-state.ts'
import { resolve } from '../src/sdd/status.ts'
import { flowReview } from '../src/review/standing.ts'
import { type ChainSetup, chainSetup, chainFlow, runBin, fakeCalls } from './helpers.ts'
import {
  VERIFIED, git, text, put, planPath, registryPath, registry, writeRegistry, reviewPath, json,
  success, wait, report, draft, apply, refused, review,
} from './sdd-commit-fixture.ts'

const repos: string[] = []
after(() => { for (const repo of repos) rmSync(repo, { recursive: true, force: true }) })
const specPath = '.plans/f/spec.md'
const tasksPath = '.plans/f/tasks.md'
const approvalsPath = '.plans/f/sdd-ai-approvals.json'
const contextPath = '.plans/f/review-context.md'
const delivery = ['Abrir el PR después del commit.', 'Esperar la revisión externa después de publicar el PR.']

/** Todos los escenarios usan el productor real de spec, con obligaciones todavía futuras. */
function deliverySpec(): string {
  const result = admitSpecify(JSON.stringify({
    phase: 'specify', known_facts: [], assumptions: [], blocking_questions: [], missing_context: [], findings: [],
    problem: 'f debe dar 2.', background: 'Escenario sintético.', scope: 'Cambiar el resultado precommit.',
    acceptance_criteria: [{ id: 'AC-1', text: 'f da 2.', authority: 'pedido', verification: 'test de f' }], delivery,
  }))
  assert.equal(result.kind, 'admitted', JSON.stringify(result))
  if (result.kind !== 'admitted') throw new Error('spec no admitida')
  return renderSpec(result.review)
}

/** Gates de normal obtenidos después de escribir todos los artefactos, sin responder gates reales. */
function approveNormal(s: ChainSetup): void {
  const { facts } = readFlow(s.repo, 'f')
  assert.equal(facts.planHeader?.ok && facts.planHeader.data.profundidad, 'normal')
  const fp = facts.fingerprints
  assert.ok(fp.spec)
  assert.ok(fp['plan-tasks'])
  put(s, approvalsPath, JSON.stringify({ schema_version: 1, approvals: [
    { gate: 'spec', depth: 'normal', fingerprint: fp.spec, previous: {}, at: '2026-09-29T14:00:00.000Z' },
    { gate: 'plan-tasks', depth: 'normal', fingerprint: fp['plan-tasks'], previous: { spec: fp.spec }, at: '2026-09-29T14:01:00.000Z' },
  ] }))
}

const task = (id: string, actor: TaskActor, done: boolean) =>
  `- [${done ? 'x' : ' '}] **${id} — Trabajo precommit ${id}**  · actor: ${actor}  · cubre: AC-1\n`
  + '  - **Patrón:** src/a.ts:1\n  - **Prueba:** V1\n  - **Archivos:** `src/a.ts`\n  - **Pasos:**\n    1. Comprobar el resultado precommit.\n'

function normalFlow(o: { chain?: boolean; actor?: TaskActor; done?: boolean } = {}): ChainSetup {
  const actor = o.actor ?? 'writer'
  const pending = o.done === false
  const writerReport = report(['T1'], pending && actor === 'writer' ? ['T2'] : [])
  const s = chainSetup({ bins: ['codex'], families: '[codex]', writers: [
    { actions: [{ write: 'src/a.ts', content: VERIFIED }], report: writerReport },
  ] })
  repos.push(s.repo)
  git(s, 'config', 'user.name', 't')
  git(s, 'config', 'user.email', 't@t')
  // Solo se reutiliza la preparación; no committable/reviewedFlow, que crean otros motores.
  chainFlow(s, { tasks: 2, status: o.chain ? 'tasks-ready' : 'implementing' })
  put(s, specPath, deliverySpec())
  put(s, planPath, text(s, planPath).replace('profundidad: completa', 'profundidad: normal'))
  put(s, '.plans/f/handoff.md', text(s, '.plans/f/handoff.md').replace('profundidad: completa', 'profundidad: normal'))
  put(s, tasksPath, '# Tasks\n\n' + task('T1', 'writer', !o.chain) + '\n' + task('T2', actor, !pending))
  approveNormal(s)
  if (o.chain) {
    const launched = success(runBin(s, ['sdd', 'phase', 'f']))
    assert.equal(wait(s, launched.id).state, 'done')
    const record = registry(s)
    assert.ok(record.implement, 'la preparación necesita una cadena real de writer de fase')
    put(s, tasksPath, text(s, tasksPath).replace('- [ ] **T1', '- [x] **T1'))
  } else put(s, 'src/a.ts', VERIFIED)
  assert.ok(resolve(readFlow(s.repo, 'f').facts).gates.every((g) => g.state === 'approved'))
  return s
}

function verifiedFlow(): { s: ChainSetup; reviewId: string } {
  const s = normalFlow()
  const verified = success(runBin(s, ['sdd', 'verify', 'f']))
  assert.equal(verified.green, true, JSON.stringify(verified))
  assert.deepEqual(verified.questions ?? [], [])
  assert.ok(verified.rows.every((r: { outcome: string; attestation?: string }) => r.outcome === 'passed' && !r.attestation))
  assert.equal(readFlow(s.repo, 'f').facts.receipt, 'valid')
  put(s, contextPath, 'Contexto de revisión inicial.\n')
  // El autor sintético Claude selecciona el único revisor instalado: Codex falso.
  const reviewId = review(s, ['--context', contextPath])
  assert.equal(flowReview(s.repo, 'f', s.base).ok, true)
  assert.equal(success(draft(s)).state, 'dry_run')
  assert.ok(fakeCalls(s).length > 0)
  return { s, reviewId }
}

test('la entrega futura separada permite verify y commit y permanece en la spec', () => {
  const { s } = verifiedFlow()
  const before = text(s, specPath)
  assert.equal(section(before, 'Entrega posterior al commit')?.trim(), delivery.map((d) => `- ${d}`).join('\n'))
  assert.equal(resolve(readFlow(s.repo, 'f').facts).next.step, 'review_and_commit')
  const record = registry(s)
  assert.equal(record.verify.attestations.length, 0)
  const d = success(draft(s))
  const committed = success(apply(s, d.digest))
  assert.equal(committed.state, 'committed')
  assert.equal(text(s, specPath), before)
  assert.match(text(s, planPath), /^status: committed$/m)
})

test('las tasks precommit pendientes bloquean verify para todo actor incluso con takeover y status adelantado', () => {
  for (const actor of ['writer', 'conductor', 'user'] as const) {
    for (const takeover of [false, true]) {
      for (const status of ['implementing', 'verified']) {
        const s = normalFlow({ actor, done: false, chain: takeover })
        put(s, planPath, text(s, planPath).replace(/^status: .+$/m, `status: ${status}`))
        const state = resolve(readFlow(s.repo, 'f').facts)
        assert.equal(state.depth, 'normal')
        assert.ok(state.gates.every((g) => g.state === 'approved'), JSON.stringify(state))
        assert.equal(state.tasks.pending, 1)
        assert.equal(state.tasks.pending_assignments?.[0]?.actor, actor)
        if (status === 'verified') {
          assert.ok(state.blocked_reasons.some((r) => r.code === 'status_ahead'), JSON.stringify(state))
        } else {
          assert.equal(state.next.step, 'implement')
          assert.deepEqual(state.blocked_reasons, [])
        }
        const r = runBin(s, ['sdd', 'verify', 'f', ...(takeover ? ['--takeover', '--reason', 'Trabajo precommit pendiente'] : [])])
        assert.notEqual(r.code, 0, `${actor}/${takeover}/${status}: ${JSON.stringify(r.out)}`)
        assert.equal(r.out.code, status === 'verified' ? 'flow_blocked' : 'verify_not_now', JSON.stringify(r.out))
        if (status === 'verified') assert.match(r.out.message, /status_ahead/)
        assert.equal(readPhaseRecord(s.repo, 'f').verify?.receipts?.length ?? 0, 0)
      }
    }
  }
})

test('delivery no evita gates vencidos ni los controles vigentes de commit', () => {
  const { s, reviewId } = verifiedFlow()
  const originals = {
    spec: text(s, specPath), plan: text(s, planPath), tasks: text(s, tasksPath),
    registry: text(s, registryPath), request: text(s, reviewPath(reviewId, 'request')), context: text(s, contextPath),
  }
  const restore = () => {
    put(s, specPath, originals.spec)
    put(s, planPath, originals.plan)
    put(s, tasksPath, originals.tasks)
    put(s, registryPath, originals.registry)
    put(s, reviewPath(reviewId, 'request'), originals.request)
    put(s, contextPath, originals.context)
    assert.equal(readFlow(s.repo, 'f').facts.receipt, 'valid')
    assert.equal(flowReview(s.repo, 'f', s.base).ok, true)
    assert.equal(success(draft(s)).state, 'dry_run')
  }
  const digest = success(draft(s)).digest
  for (const mutation of ['spec', 'plan', 'remove-task'] as const) {
    restore()
    if (mutation === 'spec') put(s, specPath, originals.spec.replace('Escenario sintético.', 'Antecedente sustantivo distinto.'))
    if (mutation === 'plan') put(s, planPath, originals.plan.replace('Uno.', 'Otro mecanismo precommit.'))
    if (mutation === 'remove-task') put(s, tasksPath, '# Tasks\n\n' + task('T1', 'writer', true))
    const state = resolve(readFlow(s.repo, 'f').facts)
    const gate = mutation === 'spec' ? 'spec' : 'plan-tasks'
    assert.equal(state.gates.find((g) => g.gate === gate)?.state, 'stale', JSON.stringify(state))
    assert.equal(state.next.step, 'gate')
    assert.equal(state.next.gate, gate)
    assert.ok(!state.blocked_reasons.some((r) => r.code === 'tasks_empty'))
    if (mutation === 'remove-task') {
      assert.equal(state.tasks.total, 1)
      assert.match(text(s, tasksPath), /cubre: AC-1/)
      assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'verify_not_now')
    }
    refused(s, 'step_not_commit', digest)
  }
  for (const invalid of [false, true]) {
    restore()
    const record = registry(s)
    if (invalid) record.verify.receipts.at(-1).digest = `sha256:${'0'.repeat(64)}`
    else record.verify.receipts = []
    writeRegistry(s, record)
    const read = readFlow(s.repo, 'f')
    assert.equal(read.facts.receipt, 'stale')
    const state = resolve(read.facts)
    assert.ok(state.gates.every((g) => g.state === 'approved'))
    assert.equal(state.next.step, 'verify')
    assert.ok(state.notes.some((r) => r.code === 'verified_stale'))
    assert.equal(flowReview(s.repo, 'f', s.base).ok, true)
    // Status detecta primero el recibo inválido: no se exige receipt_invalid si no es alcanzable.
    refused(s, 'step_not_commit', digest)
  }
  restore()
  const request = json(s, reviewPath(reviewId, 'request'))
  delete request.flow
  put(s, reviewPath(reviewId, 'request'), JSON.stringify(request))
  assert.deepEqual(flowReview(s.repo, 'f', s.base), { ok: false, reason: 'review_missing' })
  assert.equal(readFlow(s.repo, 'f').facts.receipt, 'valid')
  refused(s, 'review_missing', digest)
  restore()
  // Cambiar solo un contexto externo al candidato vence la revisión sin vencer recibo ni gates.
  put(s, contextPath, 'Contexto de revisión cambiado.\n')
  const stale = flowReview(s.repo, 'f', s.base)
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.reason, 'review_stale')
  assert.equal(readFlow(s.repo, 'f').facts.receipt, 'valid')
  assert.equal(resolve(readFlow(s.repo, 'f').facts).next.step, 'review_and_commit')
  refused(s, 'review_missing', digest)
  restore()
  assert.equal(text(s, specPath), originals.spec)
})
