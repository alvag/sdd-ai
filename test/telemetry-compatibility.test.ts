import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runBin } from './helpers.ts'
import { committable, draft, registry, registryPath, success, text, writeRegistry } from './sdd-commit-fixture.ts'
import { preference, prepareAttempt, launchAttempt, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'
import { setup, firstRound, grave, nextRound, startAndWait, cli, lines, waitRound } from './rounds-cli-fixture.ts'

test('legacy records remain readable without retroactive citations or telemetry export', async () => {
  const { s } = committable()
  const old = registry(s); delete old.reviews; writeRegistry(s,old)
  const before = text(s,registryPath)
  const f = telemetryFixture(s.repo)
  try {
    preference(f,'telemetry: on\n')
    const extra = { HOME: f.home, SDD_AI_TELEMETRY: 'on' }
    assert.equal(success(runBin(s,['sdd','status','f'],extra)).next.command,'./bin/sdd-ai sdd commit f --subject "<asunto>"')
    assert.equal(draft(s).code,0)
    assert.equal(text(s,registryPath),before)
    assert.deepEqual(telemetryLines(f.home),[])
    const p = prepareAttempt(f,{ execution: undefined })
    writeFileSync(join(p.dir,'metrics.json'),JSON.stringify({ attempts: [],totals: { duration_ms: 0,attempts: 0,inadmissible: 0 } }))
    const result = await launchAttempt(f,p).done
    assert.equal(result.code,0); assert.equal(result.out.state,'done')
    assert.ok(existsSync(join(p.dir,'result.md'))); assert.equal(readFileSync(join(p.dir,'result.md'),'utf8'),'ok')
    assert.deepEqual(telemetryLines(f.home),[]); assert.equal(text(s,registryPath),before)
    // Un intento ya cerrado en metrics.json no se exporta: solo se publica el que cierra con la telemetría encendida.
    const closed = prepareAttempt(f)
    const at = '2026-01-01T00:00:00.000Z'
    writeFileSync(join(closed.dir,'metrics.json'),JSON.stringify({ attempts: [{ round: 1,kind: 'initial',suffix: '',started_at: at,ended_at: at,duration_ms: 1,
      prompt_bytes: 1,outcome: 'done',raw: { stdout: 'stdout.log',stderr: 'stderr.log',result: null },usage: { input_tokens: 5 } }],
    totals: { duration_ms: 1,attempts: 1,inadmissible: 0 } }))
    assert.equal((await launchAttempt(f,closed).done).code,0)
    // V19 es green_on_base: se afirma solo la ausencia del intento antiguo, que también vale en la base.
    assert.equal(telemetryLines(f.home).some((l) => l.run === closed.id && l.attempt === 0),false)
    const legacy = setup([firstRound([grave]),nextRound([{ id: 'F-1',answer: 'resolved' }])])
    legacy.env.HOME=f.home
    const dir = join(legacy.repo,'.plans/f'); mkdirSync(dir,{ recursive: true })
    writeFileSync(join(dir,'handoff.md'),'# Handoff\n')
    writeFileSync(join(dir,'plan.md'),`---\nbase_commit: ${legacy.base}\n---\n\n# Plan\n`)
    const id = startAndWait(legacy,['--flow','f','--untracked'])
    const path = join(dir,'sdd-ai-phases.json')
    writeFileSync(path,JSON.stringify({ schema_version: 1,last_run: null,phases: {} }))
    assert.equal(cli(legacy,['review','decide',id,'accept','F-1']).code,0)
    writeFileSync(join(legacy.repo,'a.txt'),lines(10,{ 5: 'validated line' }))
    assert.equal(cli(legacy,['review','round',id]).code,0); waitRound(legacy,id)
    assert.equal('reviews' in JSON.parse(readFileSync(path,'utf8')),false)
  } finally { f.dispose() }
})
