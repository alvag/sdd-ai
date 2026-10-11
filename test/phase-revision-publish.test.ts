import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { renderPlan, renderSpec, renderTasks, type PlanContract, type SpecifyContract, type TasksContract } from '../src/sdd/phase.ts'
import { bytesHash, readFlow } from '../src/sdd/read.ts'
import { resolve } from '../src/sdd/status.ts'
import { readVerification } from '../src/sdd/verification-contract.ts'
import { resolveDocumentProducer } from '../src/phase-session.ts'
import { prepareRevisionCandidate, validateRevision, withRevisionLocks } from '../src/sdd/revision.ts'
import { calls, cleanup, contracts, corrected, entries, flowFile, makeFixture, record, refreshReview, revise, runFile, saveRecord, script, settle, snapshotFiles } from './phase-revision-fixture.ts'

const parts = (text: string) => { const h = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[0] ?? ''; return { header: h, body: text.slice(h.length).trim() } }
test('la correccion reemplaza el cuerpo conserva el header detecta contenido identico y no toca otros artefactos', async () => {
  for (const artifact of ['spec', 'plan', 'tasks'] as const) for (const header of [false, true]) {
    const s = makeFixture({ artifact, header })
    try {
      if (header) {
        const original = readFileSync(flowFile(s, `${artifact}.md`), 'utf8')
        const prefix = parts(original).header
        const literal = prefix.replaceAll('\n', '\r\n').replace(/---\r\n$/, '--- \t\r\n')
        writeFileSync(flowFile(s, `${artifact}.md`), literal + original.slice(prefix.length))
        refreshReview(s)
      }
      const before = snapshotFiles(s); const initialHeader = parts(before[`${artifact}.md`]).header
      const materials = Object.fromEntries(['request.md', ...s.selection.inputs.map((i) => i.path), ...s.selection.context]
        .map((path) => [path, readFileSync(`${s.repo}/${path}`)]))
      const ledger = readFileSync(runFile(s, s.review, 'ledger.json'))
      const c = corrected(artifact)
      script(s, [{ answer: JSON.stringify(c) }])
      const start = revise(s); assert.equal(start.code, 0, JSON.stringify(start.out))
      const finished = await settle(s, start.out.id)
      assert.equal(finished.out.outcome, 'published', JSON.stringify(finished.out))
      const after = snapshotFiles(s)
      assert.equal(parts(after[`${artifact}.md`]).header, initialHeader)
      const rendered = c.phase === 'specify' ? renderSpec(c) : c.phase === 'tasks' ? renderTasks(c)
        : renderPlan(c, { id: 'f', branch: 'ignored', base_commit: 'ignored', change_type: 'feat', profundidad: s.depth, risk: 'high', status: 'planned', created_at: '2000-01-01T00:00:00Z' }, ['AC-1'])
      assert.equal(parts(after[`${artifact}.md`]).body, parts(rendered).body)
      assert.equal(entries(s).at(-1)!.result!.digest, bytesHash(after[`${artifact}.md`]))
      for (const name of Object.keys(before)) if (name !== `${artifact}.md`) assert.equal(after[name], before[name])
      for (const [path, bytes] of Object.entries(materials)) assert.deepEqual(readFileSync(`${s.repo}/${path}`), bytes)
      assert.deepEqual(readFileSync(runFile(s, s.review, 'ledger.json')), ledger)
      const barriers = structuredClone(record(s).revisions!.barriers)
      refreshReview(s); script(s, [{ answer: JSON.stringify(c) }])
      const metadata = statSync(flowFile(s, `${artifact}.md`), { bigint: true })
      const same = revise(s); assert.equal(same.code, 0, JSON.stringify(same.out))
      assert.equal((await settle(s, same.out.id)).out.outcome, 'no_changes')
      assert.deepEqual(snapshotFiles(s), after); assert.deepEqual(record(s).revisions!.barriers, barriers)
      const unchanged = statSync(flowFile(s, `${artifact}.md`), { bigint: true })
      assert.equal(unchanged.ino, metadata.ino); assert.equal(unchanged.mtimeNs, metadata.mtimeNs); assert.equal(unchanged.ctimeNs, metadata.ctimeNs)
      assert.ok(!readdirSync(`${s.repo}/.plans/f`).some((name) => name.endsWith('.tmp')))
    } finally { await cleanup(s) }
  }
  const blocked = makeFixture({ artifact: 'plan' })
  try {
    const c = corrected('plan') as PlanContract
    c.verification.rows = [{ id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert', argv: ['node', '--test', 'test/new.test.ts'],
      timeout_ms: 60000, expect: { exit_code: 0 }, implementation_paths: ['src/new.ts'], test_paths: ['test/new.test.ts'],
      test_name: 'nuevo comportamiento', report_format: 'tap' }]
    const before = readFileSync(flowFile(blocked, 'plan.md'), 'utf8')
    script(blocked, [{ answer: JSON.stringify(c) }])
    const start = revise(blocked); assert.equal(start.code, 0, JSON.stringify(start.out))
    const finished = await settle(blocked, start.out.id)
    assert.equal(finished.out.outcome, 'not_published'); assert.equal(finished.out.cause, 'candidate_blocked')
    assert.equal(readFileSync(flowFile(blocked, 'plan.md'), 'utf8'), before)
    // El mismo código ya presente no impide corregir el cuerpo del documento.
    const initialHeader = parts(before).header
    const rendered = renderPlan(c, { id: 'f', branch: 'ignored', base_commit: 'ignored', change_type: 'feat', profundidad: 'normal', risk: 'high', status: 'planned', created_at: '2000-01-01T00:00:00Z' }, ['AC-1'])
    writeFileSync(flowFile(blocked, 'plan.md'), initialHeader + '\n' + parts(rendered).body + '\n')
    refreshReview(blocked)
    c.approach += ' Ajuste coherente.'
    script(blocked, [{ answer: JSON.stringify(c) }])
    const existing = revise(blocked); assert.equal(existing.code, 0, JSON.stringify(existing.out))
    const published = await settle(blocked, existing.out.id)
    assert.equal(published.out.outcome, 'published', JSON.stringify(published.out))
    assert.ok(entries(blocked).at(-1)!.result!.blocked_reasons!.some((r) => r.code === 'revert_path_not_in_base'))
  } finally { await cleanup(blocked) }
  const legacy = makeFixture({ artifact: 'tasks' })
  try {
    const c = structuredClone(contracts.tasks) as TasksContract; delete c.tasks[0].actor
    writeFileSync(flowFile(legacy, 'tasks.md'), renderTasks(c))
    const r = record(legacy); delete r.documents!.tasks!.task_actors; saveRecord(legacy, r)
    refreshReview(legacy)
    c.tasks[0].title += ' corregido'; c.tasks[0].steps.push('Mantener la coherencia.')
    script(legacy, [{ answer: JSON.stringify(c) }])
    const start = revise(legacy); assert.equal(start.code, 0, JSON.stringify(start.out))
    assert.equal((await settle(legacy, start.out.id)).out.outcome, 'published')
    assert.equal(readFileSync(flowFile(legacy, 'tasks.md'), 'utf8'), renderTasks(c))
    assert.doesNotMatch(readFileSync(flowFile(legacy, 'tasks.md'), 'utf8'), /actor:/)
  } finally { await cleanup(legacy) }
  const dependent = makeFixture()
  try {
    const before = snapshotFiles(dependent)
    const c = corrected('spec') as SpecifyContract
    c.acceptance_criteria.push({ id: 'AC-2', text: 'El mismo resultado sigue siendo observable.', authority: 'pedido', verification: 'inspección' })
    script(dependent, [{ answer: JSON.stringify(c) }])
    const start = revise(dependent); assert.equal(start.code, 0, JSON.stringify(start.out))
    assert.equal((await settle(dependent, start.out.id)).out.outcome, 'published')
    assert.equal(readFileSync(flowFile(dependent, 'plan.md'), 'utf8'), before['plan.md'])
    assert.equal(readFileSync(flowFile(dependent, 'tasks.md'), 'utf8'), before['tasks.md'])
    assert.throws(() => readVerification(before['plan.md'], ['AC-1', 'AC-2']), /AC-2|cobertura|criterio/)
  } finally { await cleanup(dependent) }
  const newlyBlocked = makeFixture()
  try {
    // La spec tiene un ID incorrecto: el plan no se admite contra ese ID y todavía
    // no expone sus rutas de reversión. Corregir el ID revela un bloqueo del plan.
    const originalSpec = structuredClone(contracts.spec) as SpecifyContract
    originalSpec.acceptance_criteria[0].id = 'AC-2'
    writeFileSync(flowFile(newlyBlocked, 'spec.md'), renderSpec(originalSpec))
    const plan = structuredClone(contracts.plan) as PlanContract
    plan.verification.rows = [{ id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert', argv: ['node', '--test', 'test/new.test.ts'],
      timeout_ms: 60000, expect: { exit_code: 0 }, implementation_paths: ['src/new.ts'], test_paths: ['test/new.test.ts'],
      test_name: 'nuevo comportamiento', report_format: 'tap' }]
    const originalPlan = readFileSync(flowFile(newlyBlocked, 'plan.md'), 'utf8')
    const rendered = renderPlan(plan, { id: 'f', branch: 'ignored', base_commit: 'ignored', change_type: 'feat', profundidad: 'normal', risk: 'high', status: 'planned', created_at: '2000-01-01T00:00:00Z' }, ['AC-1'])
    writeFileSync(flowFile(newlyBlocked, 'plan.md'), parts(originalPlan).header + '\n' + parts(rendered).body + '\n')
    refreshReview(newlyBlocked)
    const before = snapshotFiles(newlyBlocked)
    assert.throws(() => readVerification(before['plan.md'], ['AC-2']), /AC-1|AC-2|cobertura|criterio/)
    assert.ok(!resolve(readFlow(newlyBlocked.repo, 'f').facts).blocked_reasons.some((r) => r.code === 'revert_path_not_in_base'))
    script(newlyBlocked, [{ answer: JSON.stringify(corrected('spec')) }])
    const start = revise(newlyBlocked); assert.equal(start.code, 0, JSON.stringify(start.out))
    const result = await settle(newlyBlocked, start.out.id)
    assert.equal(result.out.outcome, 'published', JSON.stringify(result.out))
    assert.ok(entries(newlyBlocked).at(-1)!.result!.blocked_reasons!.some((r) => r.code === 'revert_path_not_in_base'))
    assert.ok(resolve(readFlow(newlyBlocked.repo, 'f').facts).blocked_reasons.some((r) => r.code === 'revert_path_not_in_base'))
    for (const [name, bytes] of Object.entries(before)) if (name !== 'spec.md') assert.equal(snapshotFiles(newlyBlocked)[name], bytes)
    assert.equal(calls(newlyBlocked).length, 1)
  } finally { await cleanup(newlyBlocked) }
  const headerless = makeFixture({ artifact: 'plan' })
  try {
    const validated = withRevisionLocks(headerless.repo, 'f', headerless.review, () =>
      validateRevision(headerless.repo, 'f', 'plan', headerless.review,
        resolveDocumentProducer(headerless.repo, 'f', 'plan', headerless.env)))
    const original = parts(readFileSync(flowFile(headerless, 'plan.md'), 'utf8')).body + '\n'
    writeFileSync(flowFile(headerless, 'plan.md'), original)
    refreshReview(headerless)
    const before = snapshotFiles(headerless)
    // El armado del candidato conserva la ausencia del header. La solicitud CLI
    // sigue rechazando este flujo inválido: esta comprobación no saltea sus gates.
    const c = corrected('plan') as PlanContract
    const candidate = prepareRevisionCandidate(headerless.repo, { ...validated, document: Buffer.from(original) }, c)
    assert.equal(parts(candidate.text).header, '')
    const rendered = renderPlan(c, { id: 'f', branch: 'ignored', base_commit: 'ignored', change_type: 'feat', profundidad: 'normal', risk: 'high', status: 'planned', created_at: '2000-01-01T00:00:00Z' }, ['AC-1'])
    assert.equal(parts(candidate.text).body, parts(rendered).body)
    assert.equal(candidate.previous_digest, bytesHash(original)); assert.equal(candidate.result_digest, bytesHash(candidate.text))
    assert.deepEqual(snapshotFiles(headerless), before)
    const rejected = revise(headerless)
    assert.equal(rejected.out.code, 'revision_depth', JSON.stringify(rejected.out))
    assert.equal(calls(headerless).length, 0); assert.equal(entries(headerless).length, 0)
    assert.deepEqual(snapshotFiles(headerless), before)
  } finally { await cleanup(headerless) }
  for (const kind of ['link', 'directory']) {
    const linked = makeFixture()
    try {
      const original = readFileSync(flowFile(linked, 'spec.md'), 'utf8')
      writeFileSync(`${linked.work}/outside.md`, original)
      rmSync(flowFile(linked, 'spec.md'))
      if (kind === 'link') symlinkSync(`${linked.work}/outside.md`, flowFile(linked, 'spec.md'))
      else mkdirSync(flowFile(linked, 'spec.md'))
      const rejected = revise(linked)
      assert.notEqual(rejected.code, 0); assert.equal(entries(linked).length, 0); assert.equal(calls(linked).length, 0)
      assert.equal(readFileSync(`${linked.work}/outside.md`, 'utf8'), original)
    } finally { await cleanup(linked) }
  }
})
