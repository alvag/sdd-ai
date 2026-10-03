import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { preference, runAttempt, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'

test('telemetry storage failures preserve functional results and emit no warnings', async () => {
  for (const operation of ['mkdirSync','writeFileSync','linkSync','unlinkSync','temporary_unlink']) {
    const f = telemetryFixture()
    try {
      preference(f, 'telemetry: on\n')
      const target = join(f.home, '.sdd-ai', 'telemetry')
      let expired: string | undefined
      if (operation !== 'mkdirSync' && operation !== 'temporary_unlink') {
        mkdirSync(target)
        expired = join(target, `2000-01-01.${randomUUID()}.jsonl`)
        writeFileSync(expired, '{}\n')
      }
      const observations = join(f.home, 'faults.jsonl')
      const faulty = await runAttempt(f, {}, 'ok-codex', [], {
        NODE_OPTIONS: `--import ${join(import.meta.dirname, 'telemetry-fault-preload.ts')}`,
        SDD_AI_TEST_FAULT_TARGET: target, SDD_AI_TEST_FAULT_OPERATION: operation === 'temporary_unlink' ? 'unlinkSync' : operation, SDD_AI_TEST_FAULT_OBSERVATIONS: observations,
      })
      assert.ok(existsSync(observations), `${operation} no fue observada`)
      const events = readFileSync(observations, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.ok(events.some((e) => e.operation === (operation === 'temporary_unlink' ? 'unlinkSync' : operation) && e.failed), `${operation} no falló realmente`)
      if (expired && operation !== 'unlinkSync') assert.equal(existsSync(expired),false,'la publicación fallida no impide limpiar')
      const off = await runAttempt(f, {}, 'ok-codex', [], { SDD_AI_TELEMETRY: 'off' })
      assert.equal(faulty.code, off.code); assert.equal(faulty.out.state, off.out.state)
      assert.equal(readFileSync(join(faulty.dir, 'result.md'), 'utf8'), readFileSync(join(off.dir, 'result.md'), 'utf8'))
      assert.equal(faulty.stderr, off.stderr); assert.doesNotMatch(JSON.stringify(faulty.out), /telemetry|telemetría|injected/)
      if (operation === 'unlinkSync' || operation === 'temporary_unlink') assert.ok(telemetryLines(f.home).some((l) => l.run === faulty.id), 'la retirada fallida no impide publicar')
      else assert.equal(telemetryLines(f.home).some((l) => l.run === faulty.id), false)
    } finally { f.dispose() }
  }
  for (const operation of ['readFileSync','gitDirs']) {
    const f = telemetryFixture()
    try {
      preference(f,'telemetry: on\n')
      const observations = join(f.home,'failures')
      const r = await runAttempt(f,{},'ok-codex',[],{
        NODE_OPTIONS: `--import ${join(import.meta.dirname,'telemetry-fault-preload.ts')}`,
        SDD_AI_TEST_FAULT_TARGET: operation === 'gitDirs' ? f.root : join(f.home,'.sdd-ai/config.yml'),
        SDD_AI_TEST_FAULT_OPERATION: operation,SDD_AI_TEST_FAULT_OBSERVATIONS: observations,
      })
      assert.ok(readFileSync(observations,'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.operation === operation && e.failed))
      assert.equal(r.out.state,'done'); assert.equal(r.stderr,''); assert.deepEqual(telemetryLines(f.home),[])
    } finally { f.dispose() }
  }
})
