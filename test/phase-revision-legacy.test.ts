import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { bytesHash, headerHash, readFlow } from '../src/sdd/read.ts'
import { renderTasks, type TasksContract } from '../src/sdd/phase.ts'
import { calls, cleanup, cli, contracts, corrected, entries, concurrentCli, flowFile, json, makeFixture, put, record, refreshReview, revise, runFile, saveRecord, script, settle, snapshotFiles, waitFor } from './phase-revision-fixture.ts'

test('la adopcion heredada exige origen verificable y no transforma corridas vivas', async () => {
  for (const mode of ['valid', 'missing', 'ambiguous', 'wrong-path', 'wrong-source', 'wrong-contract', 'session-unknown']) {
    const s = makeFixture()
    try {
      const r = record(s); delete r.documents; saveRecord(s, r)
      if (mode === 'missing') rmSync(`${s.repo}/.sdd-ai/runs/${s.origin}`, { recursive: true })
      if (mode === 'ambiguous') cpSync(`${s.repo}/.sdd-ai/runs/${s.origin}`, `${s.repo}/.sdd-ai/runs/other-origin`, { recursive: true })
      if (mode === 'wrong-path') put(runFile(s, s.origin, 'phase.json'), { outcome: 'published', artifact: '.plans/f/plan.md' })
      if (mode === 'wrong-source') writeFileSync(runFile(s, s.origin, 'request.md'), 'Otro pedido.\n')
      if (mode === 'wrong-contract') put(runFile(s, s.origin, 'contract.json'), corrected('spec'))
      if (mode === 'session-unknown') {
        const producer = json<{ launch: unknown; session_id?: string }>(runFile(s, s.origin, 'producer.json')); delete producer.session_id
        put(runFile(s, s.origin, 'producer.json'), producer)
      }
      const before = snapshotFiles(s)
      const registryBefore = readFileSync(flowFile(s, 'sdd-ai-phases.json'), 'utf8')
      const ledgerBefore = readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8')
      const start = revise(s)
      if (mode === 'valid') {
        assert.equal(start.code, 0, JSON.stringify(start.out)); assert.equal((await settle(s, start.out.id)).out.outcome, 'published')
        const status = cli(s, ['sdd', 'status', 'f']).out
        assert.ok(status.gates.every((g: { state: string }) => g.state !== 'approved_unfingerprinted'))
        assert.ok(status.next.question)
        assert.equal(readFileSync(flowFile(s, 'handoff.md'), 'utf8'), before['handoff.md']); assert.equal(readFileSync(flowFile(s, 'plan.md'), 'utf8'), before['plan.md'])
        assert.equal(entries(s).at(-1)!.origin_run, s.origin); assert.equal(entries(s).at(-1)!.session_id, s.session)
        assert.equal(calls(s).length, 1)
      } else {
        assert.equal(start.out.code, mode === 'ambiguous' ? 'origin_ambiguous' : mode === 'session-unknown' ? 'session_unrecoverable' : 'origin_missing', JSON.stringify(start.out))
        assert.equal(calls(s).length, 0); assert.deepEqual(snapshotFiles(s), before)
        assert.equal(readFileSync(flowFile(s, 'sdd-ai-phases.json'), 'utf8'), registryBefore)
        assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), ledgerBefore)
      }
    } finally { await cleanup(s) }
  }
  const legacy = makeFixture({ artifact: 'tasks' })
  try {
    const original = structuredClone(contracts.tasks) as TasksContract
    delete original.tasks[0].actor
    writeFileSync(flowFile(legacy, 'tasks.md'), renderTasks(original))
    put(runFile(legacy, legacy.origin, 'contract.json'), original)
    const argv = json<{ phase: { task_actors?: true } }>(runFile(legacy, legacy.origin, 'argv.json'))
    delete argv.phase.task_actors; put(runFile(legacy, legacy.origin, 'argv.json'), argv)
    const r = record(legacy); delete r.documents; saveRecord(legacy, r)
    refreshReview(legacy)
    const changed = structuredClone(original); changed.tasks[0].title += ' corregido'
    script(legacy, [{ answer: JSON.stringify(changed) }])
    const before = snapshotFiles(legacy)
    const start = revise(legacy); assert.equal(start.code, 0, JSON.stringify(start.out))
    assert.equal((await settle(legacy, start.out.id)).out.outcome, 'published')
    assert.equal(readFileSync(flowFile(legacy, 'tasks.md'), 'utf8'), renderTasks(changed))
    assert.doesNotMatch(readFileSync(flowFile(legacy, 'tasks.md'), 'utf8'), /actor:/)
    assert.equal(json<{ phase: { task_actors?: true } }>(runFile(legacy, start.out.id, 'argv.json')).phase.task_actors, undefined)
    for (const [name, bytes] of Object.entries(before)) if (name !== 'tasks.md') assert.equal(snapshotFiles(legacy)[name], bytes)
    assert.equal(entries(legacy)[0].session_id, legacy.session); assert.equal(calls(legacy).length, 1)
  } finally { await cleanup(legacy) }
  const live = makeFixture({ approved: false })
  const barrier = join(live.work, 'release')
  try {
    for (const name of ['spec.md', 'plan.md', 'tasks.md']) rmSync(flowFile(live, name))
    saveRecord(live, { schema_version: 1, last_run: null, phases: {} })
    script(live, [{ barrier, answer: JSON.stringify(contracts.spec) }])
    // Corrida heredada fabricada antes de lanzar: sin producer, copias ni campos de la capacidad.
    const run = 'legacy-live'
    const dir = runFile(live, run, '')
    const originArgv = json<{ family: string; launch: { cmd: string; args: string[]; cwd: string; stdinFile: string } }>(runFile(live, live.origin, 'argv.json'))
    const launch = { ...originArgv.launch, args: [...originArgv.launch.args], stdinFile: join(dir, 'prompt.md') }
    const output = launch.args.indexOf('--output-last-message'); if (output >= 0) launch.args[output + 1] = join(dir, 'result.md')
    put(join(dir, 'request.json'), { kind: 'phase', flow: 'f', step: 'specify', role: 'specify', amended: false })
    put(join(dir, 'resolved.json'), json(runFile(live, live.origin, 'resolved.json')))
    put(join(dir, 'status.json'), { state: 'launching' })
    writeFileSync(join(dir, 'prompt.md'), 'Pedido heredado: publica un resultado.')
    put(join(dir, 'argv.json'), { family: live.family, launch, deadline_sec: 30, phase: {
      root: live.repo, flow: 'f', step: 'specify', depth: live.depth, amended: false,
      inputs: { request: bytesHash(readFileSync(join(live.repo, 'request.md'))) }, request_path: join(live.repo, 'request.md'),
      handoff_header: headerHash(readFlow(live.repo, 'f').facts.handoffHeader),
    } })
    saveRecord(live, { schema_version: 1, last_run: { id: run, step: 'specify' }, phases: {} })
    const running = concurrentCli(live, ['__supervise', dir, 'argv.json'])
    await waitFor(`${barrier}.ready`)
    assert.equal(json<{ phase: { revision?: unknown } }>(join(dir, 'argv.json')).phase.revision, undefined)
    assert.equal(revise(live).out.code, 'phase_running')
    writeFileSync(barrier, '')
    assert.equal((await settle(live, run)).out.outcome, 'published')
    await running
    assert.equal(record(live).revisions, undefined)
    assert.equal(record(live).documents!.specify!.run, run)
  } finally { writeFileSync(barrier, ''); await cleanup(live) }
})

test('la ampliacion de creacion con context conserva su significado junto a la devolucion', async () => {
  for (const repeated of [false, true]) {
    const s = makeFixture({ approved: false })
    try {
      for (const name of ['spec.md', 'plan.md', 'tasks.md']) rmSync(flowFile(s, name))
      saveRecord(s, { schema_version: 1, last_run: null, phases: {} })
      const c = structuredClone(contracts.spec); c.blocking_questions = ['¿Qué resultado?']
      script(s, [{ answer: JSON.stringify(c) }])
      const first = cli(s, ['sdd', 'phase', 'f', '--request', 'request.md'])
      assert.equal(first.code, 0, JSON.stringify(first.out)); assert.equal((await settle(s, first.out.id)).out.outcome, 'awaiting_context')
      assert.equal(record(s).phases.specify!.awaiting!.run, first.out.id)
      assert.equal(record(s).revisions, undefined)
      writeFileSync(`${s.repo}/answers.md`, 'Max: el resultado público.\n')
      script(s, [{ answer: JSON.stringify(repeated ? c : contracts.spec) }])
      const second = cli(s, ['sdd', 'phase', 'f', '--context', 'answers.md'])
      assert.equal(second.code, 0, JSON.stringify(second.out))
      assert.equal((await settle(s, second.out.id)).out.outcome, repeated ? 'closed_inline' : 'published')
      const state = record(s).phases.specify!
      assert.equal(state.awaiting, undefined); assert.equal(state.amended!.consumed, true)
      assert.equal(Boolean(state.inline), repeated); assert.equal(record(s).revisions, undefined)
      assert.equal(calls(s).length, 2)
      const prompt = readFileSync(runFile(s, second.out.id, 'prompt.md'), 'utf8')
      assert.ok(prompt.includes('Max: el resultado público.')); assert.match(prompt, /Ampliación/)
      if (repeated) {
        const before = snapshotFiles(s); const previous = structuredClone(record(s))
        assert.notEqual(cli(s, ['sdd', 'phase', 'f', '--context', 'answers.md']).code, 0)
        assert.equal(calls(s).length, 2); assert.deepEqual(snapshotFiles(s), before); assert.deepEqual(record(s), previous)
      }
    } finally { await cleanup(s) }
  }
})
