import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainFlow, chainSetup, runBin } from './helpers.ts'
import { setup as runSetup, cli as runCli } from './cli-run-fixture.ts'
import { setup as reviewSetup, cli as reviewCli, afirst, anext, waitRound } from './rounds-cli-fixture.ts'
import { implReport } from './chain-cli-fixture.ts'
import { preference, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'

test('dispatch preserves explicit flow and step associations without inference', () => {
  const s = runSetup({ families: '[codex]',bins: ['codex'] })
  const f = telemetryFixture(s.repo)
  try {
    preference(f,'telemetry: on\n'); s.env.HOME = f.home; delete s.env.SDD_AI_TELEMETRY
    const flow = join(s.repo,'.plans/f'); mkdirSync(flow,{ recursive: true })
    writeFileSync(join(flow,'handoff.md'),'# Handoff\n')
    writeFileSync(join(flow,'antecedentes.json'),JSON.stringify({ topic: 'PRIVATE_CONTEXT_MARKER',terms: [],sources: {
      engram: { status: 'ok',truncated: false,hits: [] },vault: { status: 'ok',truncated: false,flows: [] },
      plans: { status: 'ok',truncated: false,groups: [] },git: { status: 'ok',truncated: false,commits: [] },
    } }))
    const first = runCli(s,['run','--prompt-file',s.prompt,'--flow','f']); assert.equal(first.code,0,JSON.stringify(first.out))
    const ids = [first.out.id]
    for (let i=0;i<2;i++) {
      runCli(s,['wait',ids.at(-1)!,'--max','20'])
      const retry = runCli(s,['run','--retry',ids.at(-1)!]); assert.equal(retry.code,0,JSON.stringify(retry.out)); ids.push(retry.out.id)
    }
    runCli(s,['wait',ids.at(-1)!,'--max','20'])
    for (const id of ids) {
      const line = telemetryLines(f.home).find((l) => l.run === id)!
      assert.deepEqual([line.flow,line.step,line.role],['f',null,'explore'])
      const dir = join(s.repo,'.sdd-ai/runs',id)
      assert.equal(JSON.parse(readFileSync(join(dir,'request.json'),'utf8')).flow,'f')
      assert.equal(readFileSync(join(dir,'prompt.md'),'utf8'),readFileSync(join(s.repo,'.sdd-ai/runs',ids[0],'prompt.md'),'utf8'))
    }
    const free = runCli(s,['run','--prompt-file',s.prompt]); runCli(s,['wait',free.out.id,'--max','20'])
    assert.deepEqual(telemetryLines(f.home).filter((l) => l.run === free.out.id).map((l) => [l.flow,l.step]),[[null,null]])
    const native = runSetup({ families: '[claude]' }); native.env.HOME=f.home; delete native.env.SDD_AI_TELEMETRY
    assert.equal(runCli(native,['agents','sync']).code,0)
    const delegated = runCli(native,['run','--prompt-file',native.prompt]); assert.equal(delegated.out.via,'native')
    assert.equal(telemetryLines(f.home).some((l) => l.run === delegated.out.id),false)

    for (const kind of ['spec','plan','tasks']) {
      const r = reviewSetup(['__fail__',afirst([{ of: `.plans/f/${kind}.md`,axis: 'quality',severity: 'CRITICAL',location: `.plans/f/${kind}.md:3`,claim: 'Ambiguous requirement.',evidence: 'inferential' }]),anext([{ id: 'F-1',answer: 'resolved' }])])
      r.env.HOME=f.home; delete r.env.SDD_AI_TELEMETRY
      const dir = join(r.repo,'.plans/f'); mkdirSync(dir,{ recursive: true })
      writeFileSync(join(dir,'handoff.md'),'# Handoff\n')
      for (const name of ['spec','plan','tasks','request']) if (name !== 'plan' || kind !== 'spec') writeFileSync(join(dir,`${name}.md`),'# Document\n\nContent.\n')
      if (kind === 'spec') assert.equal(existsSync(join(dir,'plan.md')),false)
      const inputs = kind === 'spec' ? ['--request','.plans/f/request.md'] : kind === 'plan' ? ['--spec','.plans/f/spec.md'] : ['--spec','.plans/f/spec.md','--plan','.plans/f/plan.md']
      const started = reviewCli(r,['review','start','--artifact',`.plans/f/${kind}.md`,'--kind',kind,'--flow','f','--author','codex',...inputs])
      assert.equal(started.code,0,JSON.stringify(started.out)); waitRound(r,started.out.id)
      const relaunched = reviewCli(r,['review','round',started.out.id]); assert.equal(relaunched.code,0,JSON.stringify(relaunched.out)); waitRound(r,started.out.id)
      assert.equal(reviewCli(r,['review','decide',started.out.id,'accept','F-1']).code,0)
      writeFileSync(join(dir,`${kind}.md`),'# Document\n\nClarified content.\n')
      const round = reviewCli(r,['review','round',started.out.id]); assert.equal(round.code,0,JSON.stringify(round.out)); waitRound(r,started.out.id)
      const runLines = telemetryLines(f.home).filter((l) => l.run === started.out.id)
      assert.ok(runLines.length > 0)
      for (const line of runLines) assert.deepEqual([line.flow,line.step,line.role],['f',kind === 'spec' ? 'specify' : kind,'design-review'])
      assert.equal(existsSync(join(dir,'sdd-ai-phases.json')),false)
      assert.equal(reviewCli(r,['review','start','--artifact',`.plans/f/${kind}.md`,'--kind',kind,'--flow','f','--head','HEAD',...inputs]).out.code,'usage')
    }
    const writer = chainSetup({ bins: ['codex','claude'],families: '[codex, claude]',writers: [
      { actions: [{ write: 'src/a.ts',content: 'export const f = () => 2\n' }],report: implReport(['T1'],['T2']) },
      { actions: [{ write: 'src/t2.ts',content: '2\n' }],report: implReport(['T2']) },
    ] })
    chainFlow(writer,{ tasks: 2 }); writer.env.HOME=f.home; delete writer.env.SDD_AI_TELEMETRY
    const started = runBin(writer,['sdd','phase','f']); assert.equal(started.code,0,JSON.stringify(started.out))
    runBin(writer,['wait',started.out.id,'--max','30'])
    const line = telemetryLines(f.home).find((l) => l.run === started.out.id)!
    assert.deepEqual([line.flow,line.step,line.role],['f','implement','implement'])
    const continuation = runBin(writer,['sdd','phase','f']); assert.equal(continuation.code,0,JSON.stringify(continuation.out))
    runBin(writer,['wait',continuation.out.id,'--max','30'])
    const continued = telemetryLines(f.home).find((l) => l.run === continuation.out.id)!
    assert.deepEqual([continued.flow,continued.step,continued.role],['f','implement','implement'])
    const review = runBin(writer,['review','start','--base',writer.base,'--untracked','--flow','f','--author','claude'],{ FAKE_MODE: 'review-ok' })
    assert.equal(review.code,0,JSON.stringify(review.out))
    {
      runBin(writer,['wait',review.out.id,'--max','20'])
      const line = telemetryLines(f.home).find((l) => l.run === review.out.id)!
      assert.deepEqual([line.flow,line.step,line.role],['f','review_and_commit','code-review'])
    }
    for (const step of ['specify','plan','tasks']) {
      const phase = runSetup({ families: '[codex]',bins: ['codex'],mode: 'scripted' })
      phase.env.HOME=f.home; delete phase.env.SDD_AI_TELEMETRY
      execFileSync('git',['-c','user.name=t','-c','user.email=t@t','commit','--allow-empty','-qm','base'],{ cwd: phase.repo })
      execFileSync('git',['checkout','-qb','feature/f'],{ cwd: phase.repo })
      writeFileSync(join(phase.repo,'.git/info/exclude'),'.plans/\n.sdd-ai/\n')
      const dir = join(phase.repo,'.plans/f'); mkdirSync(dir,{ recursive: true })
      writeFileSync(join(dir,'handoff.md'),`---\nphase: specify\nbranch: feature/f\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: ${step === 'specify' ? 'null' : '2026-09-29T08:59:18-05:00'}\n---\n\n# Handoff\n`)
      if (step !== 'specify') writeFileSync(join(dir,'spec.md'),'# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** result. (pedido)\n')
      if (step === 'tasks') writeFileSync(join(dir,'plan.md'),'---\nid: f\nbranch: feature/f\nbase_commit: x\nchange_type: feat\nprofundidad: completa\nrisk: low\nstatus: plan-approved\ncreated_at: 2026-09-29T09:00:00-05:00\n---\n\n# Plan\n\n## Enfoque\n\nOne.\n')
      const answers = join(f.home,`phase-${step}.json`)
      writeFileSync(answers,JSON.stringify(['invalid','invalid']))
      phase.env.FAKE_ANSWERS=answers; phase.env.FAKE_CALLS_FILE=`${answers}.calls`
      writeFileSync(join(phase.repo,'request.md'),'Requested feature.\n')
      const dispatched = runCli(phase,['sdd','phase','f',...(step === 'specify' ? ['--request','request.md'] : [])])
      assert.equal(dispatched.code,0,JSON.stringify(dispatched.out)); runCli(phase,['wait',dispatched.out.id,'--max','20'])
      const lines = telemetryLines(f.home).filter((l) => l.run === dispatched.out.id)
      assert.ok(lines.length>0); for (const l of lines) assert.deepEqual([l.flow,l.step,l.role],['f',step,step])
    }
  } finally { f.dispose() }
})
