import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preference, runAttempt, telemetryFixture, telemetryLines, metrics } from './telemetry-fixture.ts'
import { chainFlow, chainSetup, runBin } from './helpers.ts'
import { implReport, storeOf } from './chain-cli-fixture.ts'

test('attempt tokens preserve missing counters and identify unknown thread baselines', async () => {
  const f = telemetryFixture()
  try {
    preference(f, 'telemetry: on\n')
    const cases = [
      { first: { input_tokens: 10, output_tokens: 0 }, last: { input_tokens: 15, output_tokens: 4, cached_input_tokens: 2 }, expected: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 2 } },
      { first: undefined, last: { input_tokens: 15, output_tokens: 0 }, expected: { input_tokens: 15, output_tokens: 0 } },
    ]
    for (const c of cases) {
      const r = await runAttempt(f, { deadline_sec: 1 }, 'telemetry-script', ['exec', '-'], {
        FAKE_TELEMETRY_SCRIPT: JSON.stringify([{ usage: c.first, hang: true }, { usage: c.last }]),
      })
      const lines = telemetryLines(f.home).filter((l) => l.run === r.id).sort((a,b) => a.attempt - b.attempt)
      assert.equal(lines.length, 2)
      const resumed = lines[1]
      assert.equal(resumed.attempt_kind, 'resume'); assert.equal(resumed.thread_id, 'TELEMETRY_THREAD')
      for (const [key, value] of Object.entries(c.expected)) {
        assert.equal(resumed.tokens[key], value)
        assert.equal(metrics(r.dir)[1].usage[key],value)
        const known = c.first !== undefined && key in c.first
        assert.equal(resumed.token_scope[key], known ? 'attempt' : 'thread_cumulative')
      }
      assert.equal(resumed.tokens.reasoning_output_tokens, null); assert.equal(resumed.token_scope.reasoning_output_tokens, null)
      // Las métricas conservan el cálculo existente y no adquieren scopes.
      assert.equal('token_scope' in metrics(r.dir)[1], false)
    }
    const chained = await runAttempt(f, {}, 'telemetry-script', ['exec', 'resume', 'TELEMETRY_THREAD', '-'], {
      FAKE_TELEMETRY_SCRIPT: JSON.stringify([{ usage: { input_tokens: 80, output_tokens: 9 } }]),
    })
    const line = telemetryLines(f.home).find((l) => l.run === chained.id)!
    assert.equal(line.tokens.input_tokens, 80); assert.equal(line.token_scope.input_tokens, 'thread_cumulative')
    const absent = await runAttempt(f, {}, 'telemetry-script', [], { FAKE_TELEMETRY_SCRIPT: '[{}]' })
    assert.ok(Object.values(telemetryLines(f.home).find((l) => l.run === absent.id)!.tokens).every((v) => v === null))
    const claude = await runAttempt(f, { family: 'claude' }, 'telemetry-script', ['--output-format', 'stream-json'], {
      FAKE_TELEMETRY_SCRIPT: JSON.stringify([{ usage: { input_tokens: 3, output_tokens: 0 } }]),
    })
    const cl = telemetryLines(f.home).find((l) => l.run === claude.id)!
    assert.equal(cl.tokens.output_tokens, 0); assert.equal(cl.token_scope.input_tokens, 'attempt')
    const complete = await runAttempt(f, {}, 'telemetry-script', [], {
      FAKE_TELEMETRY_SCRIPT: '[{"usage":{"input_tokens":4,"output_tokens":2,"cached_input_tokens":1,"cache_write_input_tokens":0,"reasoning_output_tokens":1}}]',
    })
    const full = telemetryLines(f.home).find((l) => l.run === complete.id)!
    assert.deepEqual(full.tokens, { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, reasoning_output_tokens: 1 })
    assert.ok(Object.values(full.token_scope).every((v) => v === 'attempt'))

    // La segunda corrida de la cadena reanuda el hilo de la primera en un supervisor nuevo: no conoce el acumulado.
    const writer = chainSetup({ writers: [
      { actions: [{ write: 'src/t1.ts', content: '1\n' }], report: implReport(['T1'], ['T2']) },
      { actions: [{ write: 'src/t2.ts', content: '2\n' }], report: implReport(['T2']) },
    ] })
    chainFlow(writer, { tasks: 2 })
    writer.env.HOME = f.home
    delete writer.env.SDD_AI_TELEMETRY
    for (const link of ['first', 'next']) {
      const launched = runBin(writer, ['sdd', 'phase', 'f'])
      assert.equal(launched.code, 0, `${link}: ${JSON.stringify(launched.out)}`)
      const waited = runBin(writer, ['wait', launched.out.id, '--max', '30'])
      assert.equal(waited.code, 0, `${link}: ${JSON.stringify(waited.out)}`)
      if (link === 'next') {
        const resumedWriter = telemetryLines(f.home).find((l) => l.run === launched.out.id)!
        assert.equal(resumedWriter.tokens.input_tokens, 10)
        assert.equal(resumedWriter.token_scope.input_tokens, 'thread_cumulative')
        assert.ok(resumedWriter.thread_id)
        assert.equal(resumedWriter.flow, 'f')
        assert.equal(resumedWriter.step, 'implement')
        assert.equal(metrics(storeOf(writer, launched.out.id))[0].usage.input_tokens, 10)
      }
    }
  } finally { f.dispose() }
})
