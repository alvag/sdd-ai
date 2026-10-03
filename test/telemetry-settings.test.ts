import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eventually, launchAttempt, preference, prepareAttempt, runAttempt, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'

test('activation follows user settings at each closure and the captured environment override', async () => {
  const f = telemetryFixture()
  const other = telemetryFixture(undefined, f.home)
  try {
    const cases: Array<[string | null, string | undefined, boolean]> = [
      [null, undefined, false], ['other: true\n', undefined, false], ['telemetry: off\n', undefined, false],
      ['telemetry: on\n', undefined, true], ['telemetry: invalid\n', undefined, false],
      ['telemetry: on\n', 'off', false], ['telemetry: off\n', 'on', true],
      ['telemetry: on\n', 'invalid', true], ['[broken', 'on', true], ['[broken', undefined, false],
    ]
    for (const at of [f, other]) for (const [content, override, enabled] of cases) {
      if (content === null) rmSync(join(f.home, '.sdd-ai', 'config.yml'), { force: true })
      else preference(f, content)
      if (override === undefined) delete at.env.SDD_AI_TELEMETRY
      else at.env.SDD_AI_TELEMETRY = override
      const r = await runAttempt(at)
      assert.equal(telemetryLines(f.home).some((l) => l.run === r.id), enabled)
    }
    for (const override of [undefined, 'on', 'off']) {
      preference(f, 'telemetry: on\n')
      if (override === undefined) delete f.env.SDD_AI_TELEMETRY
      else f.env.SDD_AI_TELEMETRY = override
      const barrier = join(f.home, `resume-${override ?? 'file'}`)
      const p = prepareAttempt(f, { deadline_sec: 1 }, ['exec', '-'])
      const running = launchAttempt(f, p, 'telemetry-script', {
        FAKE_TELEMETRY_SCRIPT: JSON.stringify([{ hang: true }, { barrier, usage: { input_tokens: 7 } }]),
      })
      try {
        await eventually(() => existsSync(`${barrier}.ready`) ? true : undefined)
        assert.equal(telemetryLines(f.home).filter((l) => l.run === p.id).length, override === 'off' ? 0 : 1)
        preference(f, 'telemetry: off\n')
      } finally { writeFileSync(barrier, '') }
      await running.done
      assert.equal(telemetryLines(f.home).filter((l) => l.run === p.id).length, override === 'on' ? 2 : override === 'off' ? 0 : 1)
    }
    // Un archivo de preferencia ilegible apaga la telemetría, salvo que el entorno la encienda.
    rmSync(join(f.home, '.sdd-ai', 'config.yml'))
    mkdirSync(join(f.home, '.sdd-ai', 'config.yml'))
    for (const override of [undefined, 'on']) {
      if (override === undefined) delete f.env.SDD_AI_TELEMETRY
      else f.env.SDD_AI_TELEMETRY = override
      const r = await runAttempt(f)
      assert.equal(telemetryLines(f.home).some((l) => l.run === r.id), override === 'on')
    }
  } finally { f.dispose(); other.dispose() }
})
