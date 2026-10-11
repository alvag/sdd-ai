import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { type Ledger } from '../src/review/ledger.ts'
import { type ReviewRequest } from '../src/review/standing.ts'
import { resolve } from '../src/sdd/status.ts'
import { readFlow } from '../src/sdd/read.ts'
import { calls, cleanup, cli, entries, flowFile, json, makeFixture, put, record, refreshReview, revise, runFile, saveRecord, settle, snapshotFiles } from './phase-revision-fixture.ts'

test('la devolucion admite las tres fases antes de implement en ambas profundidades', async () => {
  for (const depth of ['normal', 'completa'] as const) for (const artifact of ['spec', 'plan', 'tasks'] as const) for (const stage of artifact === 'tasks' ? ['gate', 'approved'] : ['gate', 'approved', 'posterior']) {
    const s = makeFixture({ depth, artifact, approved: stage !== 'gate' })
    try {
      // Gate propio, aprobación propia y paso documental posterior son estados distintos.
      if (artifact === 'spec' && stage !== 'posterior') {
        rmSync(flowFile(s, 'plan.md')); rmSync(flowFile(s, 'tasks.md'))
      } else if (artifact === 'plan' && stage !== 'approved') {
        if (stage === 'posterior' || depth === 'completa') rmSync(flowFile(s, 'tasks.md'))
        const status = stage === 'posterior' && depth === 'completa' ? 'plan-approved' : 'planned'
        writeFileSync(flowFile(s, 'plan.md'), readFileSync(flowFile(s, 'plan.md'), 'utf8').replace(/status: (planned|tasks-ready)/, `status: ${status}`))
      } else if (artifact === 'tasks' && stage === 'gate' && depth === 'completa') {
        writeFileSync(flowFile(s, 'plan.md'), readFileSync(flowFile(s, 'plan.md'), 'utf8').replace('status: planned', 'status: plan-approved'))
      }
      // Los gates de plan/tasks parten de una spec ya aprobada.
      if (artifact !== 'spec') writeFileSync(flowFile(s, 'handoff.md'), readFileSync(flowFile(s, 'handoff.md'), 'utf8').replace('spec_approved_at: null', 'spec_approved_at: 2026-10-10T00:00:00Z'))
      // Congela la revisión después de elegir la versión documental y sus fuentes.
      refreshReview(s)
      const next = resolve(readFlow(s.repo, 'f').facts).next
      const expected = stage === 'approved' ? (artifact === 'spec' ? 'plan' : 'implement')
        : stage === 'posterior' ? (artifact === 'spec' ? 'implement' : 'tasks') : 'gate'
      assert.equal(next.step, expected, `${depth}/${artifact}/${stage}: ${JSON.stringify(next)}`)
      if (stage === 'gate') assert.equal(next.gate, artifact === 'spec' ? 'spec' : depth === 'normal' ? 'plan-tasks' : artifact)
      const before = snapshotFiles(s)
      const ledger = readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8')
      const usages = [
        ['--request', 'request.md'], ['--classes', 'request.md'], ['--blocks'], ['--families', 'codex'],
      ]
      if (depth === 'normal' && artifact === 'spec' && stage === 'gate') {
        for (const extra of usages) assert.equal(revise(s, extra).out.code, 'usage')
        for (const flag of [['--review', s.review], ['--decisions', 'request.md'], ['--new-session']]) {
          assert.equal(cli(s, ['sdd', 'phase', 'f', ...flag]).out.code, 'usage')
        }
        assert.equal(cli(s, ['sdd', 'phase', 'f', '--revise', artifact]).out.code, 'usage')
      }
      assert.equal(calls(s).length, 0)
      const launched = revise(s)
      assert.equal(launched.code, 0, JSON.stringify(launched.out))
      const finished = await settle(s, launched.out.id)
      assert.equal(finished.out.outcome, 'published', JSON.stringify(finished.out))
      const entry = entries(s).at(-1)!
      assert.equal(entry.phase, artifact === 'spec' ? 'specify' : artifact)
      assert.equal(entry.artifact, `.plans/f/${artifact}.md`)
      assert.equal(entry.origin_run, s.origin)
      assert.equal(record(s).last_run?.id, s.origin)
      assert.equal(calls(s).length, 1)
      assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), ledger)
      const after = snapshotFiles(s)
      for (const [name, bytes] of Object.entries(before)) if (name !== `${artifact}.md`) assert.equal(after[name], bytes)
    } finally { await cleanup(s) }
  }
})

test('cada revision incompatible se rechaza antes de lanzar y conserva los archivos', async () => {
  const mutations: Array<[string, (s: ReturnType<typeof makeFixture>) => void]> = [
    ['review_missing', (s) => rmSync(dirname(runFile(s, s.review, 'request.json')), { recursive: true })],
    ['review_unreadable', (s) => writeFileSync(runFile(s, s.review, 'request.json'), '{')],
    ['review_active', (s) => put(runFile(s, s.review, 'status.json'), { state: 'running' })],
    ['review_diff', (s) => { const q = json<ReviewRequest>(runFile(s, s.review, 'request.json')); q.selection = { base: 'HEAD', context: [] }; put(runFile(s, s.review, 'request.json'), q) }],
    ['review_flow_mismatch', (s) => { const q = json<ReviewRequest>(runFile(s, s.review, 'request.json')); q.flow = 'other'; put(runFile(s, s.review, 'request.json'), q) }],
    ['review_artifact_mismatch', (s) => { const q = json<ReviewRequest>(runFile(s, s.review, 'request.json')); q.selection = { ...s.selection, artifact: '.plans/f/tasks.md' }; put(runFile(s, s.review, 'request.json'), q) }],
    ['review_kind_mismatch', (s) => { const q = json<ReviewRequest>(runFile(s, s.review, 'request.json')); q.selection = { ...s.selection, kind: 'tasks' }; put(runFile(s, s.review, 'request.json'), q) }],
    ['review_candidate_changed', (s) => writeFileSync(flowFile(s, 'spec.md'), readFileSync(flowFile(s, 'spec.md'), 'utf8') + '\nCambio posterior.\n')],
    ['review_sources_changed', (s) => writeFileSync(`${s.repo}/request.md`, 'Otro pedido.\n')],
    ['review_sources_changed', (s) => writeFileSync(`${s.repo}/context.md`, 'Otro contexto.\n')],
    ['decisions_pending', (s) => { const l = json<Ledger>(runFile(s, s.review, 'ledger.json')); l.entries[0].state = 'abierto'; delete l.entries[0].decision; put(runFile(s, s.review, 'ledger.json'), l) }],
    ['accepted_missing', (s) => { const l = json<Ledger>(runFile(s, s.review, 'ledger.json')); l.entries = []; put(runFile(s, s.review, 'ledger.json'), l) }],
    ['same_family_reviewer', (s) => put(runFile(s, s.review, 'resolved.json'), { family: s.family })],
  ]
  for (const [cause, mutate] of mutations) {
    const s = makeFixture()
    try {
      put(flowFile(s, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [{ gate: 'spec', depth: 'normal',
        fingerprint: readFlow(s.repo, 'f').facts.fingerprints.spec, previous: {}, at: '2026-10-10T00:00:00Z' }] })
      mutate(s)
      const before = snapshotFiles(s)
      const ledger = cause === 'review_missing' ? null : readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8')
      const r = revise(s)
      assert.equal(r.out.code, cause, JSON.stringify(r.out))
      assert.equal(calls(s).length, 0)
      assert.deepEqual(snapshotFiles(s), before)
      if (ledger !== null) assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), ledger)
      assert.equal(entries(s).length, 0)
    } finally { await cleanup(s) }
  }
  const dependent = makeFixture({ artifact: 'plan' })
  try {
    writeFileSync(flowFile(dependent, 'spec.md'), readFileSync(flowFile(dependent, 'spec.md'), 'utf8') + '\nCorrección de la spec.\n')
    assert.equal(revise(dependent).out.code, 'review_sources_changed')
    assert.equal(calls(dependent).length, 0)
  } finally { await cleanup(dependent) }
})

test('la devolucion se rechaza en corta y una vez iniciado implement', async () => {
  for (const mode of ['short', 'marked', 'verify-receipt', 'implement-record', 'implement-running', 'implement-done', 'implement', 'fix']) {
    const s = makeFixture()
    try {
      put(flowFile(s, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [{ gate: 'spec', depth: 'normal',
        fingerprint: readFlow(s.repo, 'f').facts.fingerprints.spec, previous: {}, at: '2026-10-10T00:00:00Z' }] })
      if (mode === 'short') {
        for (const file of ['handoff.md', 'plan.md']) writeFileSync(flowFile(s, file), readFileSync(flowFile(s, file), 'utf8').replace('profundidad: normal', 'profundidad: corta'))
      } else if (mode === 'marked') writeFileSync(flowFile(s, 'tasks.md'), readFileSync(flowFile(s, 'tasks.md'), 'utf8').replace('- [ ]', '- [x]'))
      else if (mode === 'verify-receipt') { const r = record(s); r.verify = { receipts: [{ id: 'verify-run', digest: `sha256:${'a'.repeat(64)}`, mode: 'final' }], attestations: [] }; saveRecord(s, r) }
      else if (mode === 'implement-record') { const r = record(s); r.last_run = { id: 'writer-run', step: 'implement' }; saveRecord(s, r) }
      else if (mode.startsWith('implement-')) {
        put(runFile(s, 'writer-run', 'request.json'), { kind: 'phase', flow: 'f', role: 'implement', step: 'implement' })
        put(runFile(s, 'writer-run', 'status.json'), { state: mode.endsWith('running') ? 'running' : 'done' })
      }
      const before = snapshotFiles(s)
      const r = mode === 'implement' || mode === 'fix' ? cli(s, ['sdd', 'phase', 'f', '--revise', mode, '--review', s.review]) : revise(s)
      assert.equal(r.out.code, mode === 'short' ? 'revision_depth' : mode === 'implement' || mode === 'fix' ? 'usage' : 'implementation_started', JSON.stringify(r.out))
      assert.equal(calls(s).length, 0)
      assert.deepEqual(snapshotFiles(s), before)
    } finally { await cleanup(s) }
  }
})
