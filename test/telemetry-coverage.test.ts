import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setup, firstRound, grave, startAndWait } from './rounds-cli-fixture.ts'
import { metrics, preference, runAttempt, telemetryFixture, telemetryLines, prepareAttempt, launchAttempt } from './telemetry-fixture.ts'
import { awaitObservation, ownProcesses, withOwned } from './scenario-readiness.ts'
import { chainSetup, runBin } from './helpers.ts'
import { storeOf, promptFile } from './chain-cli-fixture.ts'

test('every recorded attempt uses its own role and requested profile', async () => {
  const s = setup(['invalid',firstRound([{ ...grave,evidence: 'inferential' }]),'invalid',
    '{"candidate_hash":"$HASH","results":[{"id":"F-1","result":"corroborated","evidence":"a.txt:5"}]}'])
  const f = telemetryFixture(s.repo)
  const owned = ownProcesses()
  owned.directory(f.home)
  await withOwned(owned, async () => {
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
      const r = prepareAttempt(f, { deadline_sec: 10 }, args)
      const barriers = [0, 1, 2].map((i) => join(r.dir, `attempt-${i}`))
      const launched = launchAttempt(f, r, 'telemetry-script', { FAKE_TELEMETRY_SCRIPT: JSON.stringify([
        { reject: field, barrier: barriers[0] }, { usage: { input_tokens: 2 }, hang: true, barrier: barriers[1] },
        { usage: { input_tokens: 4 }, barrier: barriers[2] },
      ]) }, owned)
      for (const [i, barrier] of barriers.entries()) {
        await awaitObservation(`intento guionado ${i} de ${field}`, () => {
          const ready = existsSync(`${barrier}.ready`)
          const status = join(r.dir, 'status.json')
          const pid = existsSync(status) ? JSON.parse(readFileSync(status, 'utf8')).worker_pid : undefined
          if (ready && pid) owned.add(pid)
          const prior = existsSync(join(r.dir, 'metrics.json')) ? metrics(r.dir) : []
          const value = ready && pid && (i === 0 || prior.length === i) ? true : undefined
          return { value, detail: { ready, pid, prior: prior.map((a) => ({ kind: a.kind, outcome: a.outcome })) } }
        })
        if (i === 1) assert.equal(metrics(r.dir)[0].outcome, 'launch_failed', 'se observó el rechazo inicial')
        writeFileSync(barrier, '')
        if (i === 1) {
          await awaitObservation('sesión abierta del segundo intento antes del vencimiento', () => {
            const stdout = join(r.dir, 'stdout-2.log')
            const session = existsSync(stdout) && readFileSync(stdout, 'utf8').includes('thread.started')
            const attempts = metrics(r.dir)
            return { value: session && attempts.length === 1 ? true : undefined, detail: { session, attempts: attempts.map((a) => a.kind) } }
          })
        }
        if (i === 2) assert.equal(metrics(r.dir)[1].outcome, 'timeout', 'se observó el vencimiento del segundo intento')
      }
      const result = await launched.done
      assert.equal(result.code, 0, result.stderr)
      const lines = telemetryLines(f.home).filter((l) => l.run === r.id).sort((a,b) => a.attempt-b.attempt)
      assert.equal(lines.length,metrics(r.dir).length); assert.equal(lines.length,3)
      for (const [i, attempt] of metrics(r.dir).entries()) {
        assert.equal(lines[i].attempt, i)
        assert.equal(lines[i].attempt_kind, attempt.kind)
      }
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
  } finally { owned.completion(() => f.dispose()) }
  })
})
