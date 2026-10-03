import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { setup, firstRound, grave, startAndWait } from './rounds-cli-fixture.ts'
import { metrics, preference, runAttempt, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'
import { chainSetup, runBin } from './helpers.ts'
import { storeOf, promptFile } from './chain-cli-fixture.ts'

test('every recorded attempt uses its own role and requested profile', async () => {
  const s = setup(['invalid',firstRound([{ ...grave,evidence: 'inferential' }]),'invalid',
    '{"candidate_hash":"$HASH","results":[{"id":"F-1","result":"corroborated","evidence":"a.txt:5"}]}'])
  const f = telemetryFixture(s.repo)
  try {
    preference(f,'telemetry: on\n'); s.env.HOME=f.home; delete s.env.SDD_AI_TELEMETRY
    const id = startAndWait(s)
    const attempts = metrics(join(s.repo,'.sdd-ai/runs',id))
    const lines = telemetryLines(f.home).filter((l) => l.run === id).sort((a,b) => a.attempt-b.attempt)
    assert.equal(lines.length,attempts.length)
    assert.ok(attempts.some((a) => a.kind === 'correction')); assert.ok(attempts.some((a) => a.kind === 'refutation'))
    for (const [i,a] of attempts.entries()) {
      const l = lines[i]; assert.equal(l.attempt,i); assert.equal(l.attempt_kind,a.kind)
      const refute = a.reviewer === 'refute'
      assert.equal(l.role,refute ? 'refute' : 'code-review'); assert.equal(l.family,'claude')
      assert.equal(l.model_requested,refute ? 'sonnet' : 'opus'); assert.equal(l.effort_requested,refute ? 'medium' : 'high')
      assert.equal(l.effort_effective,null)
    }
    for (const field of ['model','effort']) {
      const args = field === 'model' ? ['exec','-m','requested-model'] : ['exec','-c','model_reasoning_effort=high']
      const r = await runAttempt(f,{ deadline_sec: 1 },'telemetry-script',args,{ FAKE_TELEMETRY_SCRIPT: JSON.stringify([{ reject: field },{ usage: { input_tokens: 2 },hang: true },{ usage: { input_tokens: 4 } }]) })
      const lines = telemetryLines(f.home).filter((l) => l.run === r.id).sort((a,b) => a.attempt-b.attempt)
      assert.equal(lines.length,metrics(r.dir).length); assert.equal(lines.length,3)
      assert.equal(lines[0][`${field}_requested`],field === 'model' ? 'requested-model' : 'high')
      assert.equal(lines[1][`${field}_requested`],null); assert.equal(lines[1].attempt_kind,'profile_retry')
      assert.equal(lines[2][`${field}_requested`],null); assert.equal(lines[2].attempt_kind,'resume')
      assert.equal(lines[0].model_effective,null); assert.equal(lines[1].model_effective,null)
      const review = chainSetup({ bins: ['codex'] }); review.env.HOME=f.home; delete review.env.SDD_AI_TELEMETRY
      writeFileSync(join(review.repo,'src/a.ts'),'export const f = () => 2\n')
      const answers = join(f.home,`retry-${field}.json`)
      writeFileSync(answers,JSON.stringify([field === 'model' ? '__reject_model__' : '__reject_effort__','invalid',firstRound([])]))
      const extra = { FAKE_MODE: 'scripted',FAKE_ANSWERS: answers,FAKE_CALLS_FILE: `${answers}.calls` }
      const started = runBin(review,['review','start','--base',review.base,'--author','claude','--model','requested-model','--effort','high'],extra)
      assert.equal(started.code,0,JSON.stringify(started.out)); runBin(review,['wait',started.out.id,'--max','30'])
      const derived = telemetryLines(f.home).filter((l) => l.run === started.out.id).sort((a,b) => a.attempt-b.attempt)
      assert.deepEqual(derived.map((l) => l.attempt_kind),['initial','profile_retry','correction'])
      for (const l of derived.slice(1)) assert.equal(l[`${field}_requested`],null)
      for (const l of derived) assert.equal(l.role,'code-review')
    }
    const resumed = await runAttempt(f,{ deadline_sec: 1 },'telemetry-script',['exec','-'],{ FAKE_TELEMETRY_SCRIPT: '[{"hang":true},{}]' })
    assert.equal(telemetryLines(f.home).filter((l) => l.run === resumed.id).length,metrics(resumed.dir).length)
    assert.ok(metrics(resumed.dir).some((a) => a.kind === 'resume'))
    const writer = chainSetup({ writers: [{}] }); writer.env.HOME=f.home; delete writer.env.SDD_AI_TELEMETRY
    const w = runBin(writer,['run','--role','implement','--prompt-file',promptFile()]); assert.equal(w.code,0,JSON.stringify(w.out))
    runBin(writer,['wait',w.out.id,'--max','30'])
    const wlines = telemetryLines(f.home).filter((l) => l.run === w.out.id)
    assert.equal(wlines.length,metrics(storeOf(writer,w.out.id)).length)
    for (const l of wlines) assert.deepEqual([l.role,l.family,l.flow,l.step],['implement','codex',null,null])
  } finally { f.dispose() }
})
