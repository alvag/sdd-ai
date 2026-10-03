import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { command, eventually, launchAttempt, metrics, preference, prepareAttempt, runAttempt, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'
import { setup, firstRound, startAndWait } from './rounds-cli-fixture.ts'

test('closed attempts are published once before the run finishes', async () => {
  const f = telemetryFixture()
  try {
    preference(f, 'telemetry: on\n')
    const barrier = join(f.home, 'continue')
    const p = prepareAttempt(f, { deadline_sec: 5 }, ['exec', '-m', 'requested-model'])
    const running = launchAttempt(f, p, 'telemetry-script', { FAKE_TELEMETRY_SCRIPT: JSON.stringify([
      { reject: 'model' }, { barrier, usage: { input_tokens: 10, output_tokens: 5 } },
    ]) })
    try {
      await eventually(() => existsSync(`${barrier}.ready`) && telemetryLines(f.home).length === 1 ? true : undefined)
      assert.equal(metrics(p.dir).length, 1)
      assert.equal(JSON.parse(readFileSync(join(p.dir, 'status.json'), 'utf8')).state, 'running')
    } finally { writeFileSync(barrier, '') }
    await running.done
    const before = telemetryLines(f.home)
    assert.equal(before.length, metrics(p.dir).length)
    for (let i = 0; i < 3; i++) command(f, ['wait', p.id, '--max', '1'])
    assert.deepEqual(telemetryLines(f.home), before)
    assert.equal(new Set(before.map((r) => `${r.run}:${r.attempt}`)).size, before.length)
    // Una revisión con una respuesta inadmisible y su corrección: una línea por intento, también la corrección.
    const review = setup(['invalid', firstRound([])])
    review.env.HOME = f.home
    delete review.env.SDD_AI_TELEMETRY
    const id = startAndWait(review)
    const attempts = metrics(join(review.repo, '.sdd-ai', 'runs', id))
    assert.ok(attempts.some((a) => a.admission === 'ok'))
    assert.ok(attempts.some((a) => a.admission?.startsWith('inadmissible')))
    assert.equal(telemetryLines(f.home).filter((l) => l.run === id).length, attempts.length)
  } finally { f.dispose() }
})

test('telemetry records execution metadata and confirmed profiles', async () => {
  const f = telemetryFixture()
  try {
    preference(f, 'telemetry: on\n')
    const r = await runAttempt(f, { family: 'claude' }, 'ok-claude')
    const [line] = telemetryLines(f.home)
    const [attempt] = metrics(r.dir)
    assert.deepEqual(Object.keys(line).sort(), ['schema_version','repository','run','attempt','attempt_kind','flow','step','role','family','model_requested','effort_requested','model_effective','effort_effective','via','closed_at','duration_ms','outcome','thread_id','tokens','token_scope'].sort())
    assert.equal(line.schema_version, 1); assert.equal(line.via, 'process')
    assert.equal(line.run, r.id); assert.equal(line.attempt, 0); assert.equal(line.attempt_kind, 'initial')
    assert.equal(line.closed_at, attempt.ended_at); assert.equal(line.duration_ms, attempt.duration_ms)
    assert.equal(line.outcome, attempt.outcome); assert.equal(line.family, 'claude'); assert.equal(line.role, 'explore')
    assert.equal(line.flow, null); assert.equal(line.step, null)
    assert.equal(line.model_requested, 'requested-model'); assert.equal(line.effort_requested, 'high')
    assert.equal(line.model_effective, 'claude-haiku-4-5-20251001'); assert.equal(line.effort_effective, null)
    const keys = ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens','reasoning_output_tokens']
    assert.deepEqual(Object.keys(line.tokens), keys); assert.deepEqual(Object.keys(line.token_scope), keys)
    for (const key of keys) {
      assert.equal(line.tokens[key], attempt.usage?.[key] ?? null)
      assert.equal(line.token_scope[key], line.tokens[key] === null ? null : 'attempt')
    }
    const codex = await runAttempt(f)
    const unknown = telemetryLines(f.home).find((l) => l.run === codex.id)!
    assert.equal(unknown.model_requested,'requested-model'); assert.equal(unknown.model_effective,null)
    assert.equal(unknown.effort_effective,null)
  } finally { f.dispose() }
})
