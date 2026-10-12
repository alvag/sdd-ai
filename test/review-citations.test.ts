import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { F_ROW, chainFlow, chainSetup, runBin } from './helpers.ts'
import { newRunId } from '../src/runs.ts'
import { candidateFingerprint } from '../src/git.ts'
import { attestQuestion } from '../src/approval/question.ts'
import { attestRow, prepareVerify } from '../src/sdd/verify.ts'
import { releaseReservation } from '../src/writer-store.ts'
import { MANUAL_ROW, answered } from './sdd-verify-fixture.ts'
import { holdLock, cliAsync, firstRound, nextRound } from './rounds-cli-fixture.ts'
import { apply, committable, draft, file, git, markAll, put, registry, registryPath, review, success, text, wait, writeRegistry } from './sdd-commit-fixture.ts'
import { telemetryFixture } from './telemetry-fixture.ts'
import { awaitObservation } from './scenario-readiness.ts'

test('diff reviews accumulate citations before run creation and preserve them across rounds', () => {
  const { s } = committable({ review: false })
  const f = telemetryFixture(s.repo)
  try {
    const observations = join(f.home,'order')
    const extra = { SDD_AI_TELEMETRY: 'off', HOME: f.home, FAKE_MODE: 'review-ok',
      NODE_OPTIONS: `--import ${join(import.meta.dirname,'telemetry-fault-preload.ts')}`,
      SDD_AI_TEST_FAULT_TARGET: join(s.repo,'.sdd-ai/runs'), SDD_AI_TEST_FAULT_OBSERVATIONS: observations,
      SDD_AI_TEST_CITATION_REGISTRY: file(s,registryPath), SDD_AI_TEST_CITATION_RUNS: join(s.repo,'.sdd-ai/runs'),
      FAKE_PROBE_FILE: file(s,registryPath),
    }
    const previous = registry(s)
    const ids: string[] = []
    for (let i=0;i<2;i++) {
      const r = success(runBin(s,['review','start','--base',s.base,'--untracked','--flow','f','--author','claude'],extra))
      ids.push(r.id); wait(s,r.id)
      // El revisor falso copió el registro al arrancar: la cita ya estaba antes de lanzar al worker.
      assert.match(readFileSync(`${s.calls}.probe`,'utf8'),new RegExp(r.id))
      assert.deepEqual(registry(s).reviews,ids)
    }
    const events = readFileSync(observations,'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const id of ids) assert.ok(events.some((e) => e.operation === 'create_run' && e.id === id && e.registry.reviews.includes(id)))
    assert.deepEqual(registry(s).verify,previous.verify)
    // Una ronda de una revisión convergida no debe retirar la cita, aun cuando el verbo se niegue.
    runBin(s,['review','round',ids[0]],extra)
    assert.deepEqual(registry(s).reviews,ids)
    const answers = join(f.home,'rounds.json')
    writeFileSync(answers,JSON.stringify([firstRound([{ axis: 'quality',severity: 'CRITICAL',location: 'src/a.ts:1',claim: 'Missing validation.',causality: 'introduced',evidence: 'deterministic' }]),nextRound([{ id: 'F-1',answer: 'resolved' }])]))
    const scripted = { ...extra,FAKE_MODE: 'scripted',FAKE_ANSWERS: answers,FAKE_CALLS_FILE: `${answers}.calls` }
    const third = success(runBin(s,['review','start','--base',s.base,'--untracked','--flow','f','--author','claude'],scripted)).id
    wait(s,third); ids.push(third)
    success(runBin(s,['review','decide',third,'accept','F-1']))
    put(s,'src/a.ts','export const f = () => 3\n')
    success(runBin(s,['review','round',third],scripted)); wait(s,third)
    assert.deepEqual(registry(s).reviews,ids)
  } finally { f.dispose() }
})

test('citation failures prevent launch and later start failures retain the citation', async () => {
  const s = chainSetup({ bins: ['codex','claude'],families: '[codex, claude]' }); chainFlow(s)
  put(s,'src/a.ts','export const f = () => 2\n')
  const args = ['review','start','--base',s.base,'--untracked','--flow','f','--author','claude']
  const runs = join(s.repo,'.sdd-ai/runs')
  const count = () => existsSync(runs) ? readdirSync(runs).length : 0
  const before = count()
  put(s,registryPath,'invalid')
  assert.equal(runBin(s,args,{ FAKE_MODE: 'review-ok' }).out.code,'phases_invalid'); assert.equal(count(),before)
  rmSync(file(s,registryPath))
  const handoff = text(s,'.plans/f/handoff.md')
  rmSync(file(s,'.plans/f/handoff.md'))
  assert.equal(runBin(s,args,{ FAKE_MODE: 'review-ok' }).out.code,'flow_not_found'); assert.equal(count(),before)
  put(s,'.plans/f/handoff.md',handoff)
  const destination = file(s,'.plans/f/other.json'); writeFileSync(destination,'{}')
  symlinkSync(destination,file(s,registryPath))
  assert.equal(runBin(s,args,{ FAKE_MODE: 'review-ok' }).out.code,'path_invalid'); assert.equal(count(),before)
  rmSync(file(s,registryPath)); rmSync(destination)
  const lock = file(s,'.plans/f/sdd-ai-approvals.lock')
  writeFileSync(lock,JSON.stringify({ pid: 2147483647,lstart: null }))
  assert.equal(runBin(s,args,{ FAKE_MODE: 'review-ok' }).out.code,'flow_busy'); assert.equal(count(),before)
  rmSync(lock)
  const held = await holdLock(lock)
  const f = telemetryFixture(s.repo)
  const waiting = join(f.home,'waiting')
  try {
    const initialPlan = text(s,'.plans/f/plan.md')
    assert.match(initialPlan,new RegExp(`^base_commit: ${s.base}$`,'m'))
    assert.equal(existsSync(file(s,registryPath)),false)
    const initialRuns = existsSync(runs) ? readdirSync(runs).sort() : []
    // El registro del ejecutable falso es distinto del registro de citas ausente.
    const initialCalls = existsSync(s.calls) ? readFileSync(s.calls,'utf8') : null
    const holder = readFileSync(lock,'utf8')
    const pending = cliAsync({ repo: s.repo,env: { ...s.env,FAKE_MODE: 'review-ok',
      NODE_OPTIONS: `--import ${join(import.meta.dirname,'telemetry-fault-preload.ts')}`,
      SDD_AI_TEST_FAULT_TARGET: lock,SDD_AI_TEST_FAULT_OBSERVATIONS: waiting,
    },base: s.base },args)
    try {
      // El evento anterior a linkSync acredita llegada tras la lectura inicial, no adquisición ni ps.
      await awaitObservation('review start llega al lock exacto de la cita', () => {
        const events = existsSync(waiting) ? readFileSync(waiting,'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
        const arrived = events.some((e) => e.operation === 'linkSync' && e.path.startsWith(`${lock}.`) && /^\d+\.[a-f0-9]+\.tmp$/.test(e.path.slice(lock.length + 1)))
        return { value: arrived ? true : undefined, detail: events }
      })
      assert.equal(readFileSync(lock,'utf8'),holder)
      assert.equal(existsSync(file(s,registryPath)),false)
      put(s,'.plans/f/plan.md',initialPlan.replace(s.base,'0'.repeat(40)))
      assert.equal(count(),before)
      held.release()
      const result = await pending
      assert.notEqual(result.code,0); assert.notEqual(result.code,null)
      assert.equal(result.out.code,'flow_base_mismatch')
      assert.equal(existsSync(file(s,registryPath)),false)
      assert.deepEqual(existsSync(runs) ? readdirSync(runs).sort() : [],initialRuns)
      assert.equal(existsSync(s.calls) ? readFileSync(s.calls,'utf8') : null,initialCalls)
    } finally {
      held.release()
      await pending
      put(s,'.plans/f/plan.md',initialPlan)
    }
    const failedWrite = runBin(s,args,{ FAKE_MODE: 'review-ok',HOME: f.home,SDD_AI_TELEMETRY: 'off',
      NODE_OPTIONS: `--import ${join(import.meta.dirname,'telemetry-fault-preload.ts')}`,
      SDD_AI_TEST_FAULT_TARGET: file(s,registryPath),SDD_AI_TEST_FAULT_OPERATION: 'writeFileSync',SDD_AI_TEST_FAULT_OBSERVATIONS: join(f.home,'failed-write'),
    })
    assert.notEqual(failedWrite.code,0); assert.equal(count(),before); assert.equal(existsSync(s.calls),false)
    const r = runBin(s,args,{ FAKE_MODE: 'review-ok',HOME: f.home,SDD_AI_TELEMETRY: 'off',
      NODE_OPTIONS: `--import ${join(import.meta.dirname,'telemetry-fault-preload.ts')}`,
      SDD_AI_TEST_FAULT_TARGET: runs,SDD_AI_TEST_FAULT_OPERATION: 'mkdirSync',SDD_AI_TEST_FAULT_OBSERVATIONS: join(f.home,'failed'),
    })
    assert.notEqual(r.code,0); assert.equal(count(),before)
    assert.equal(registry(s).reviews.length,1)
    assert.doesNotMatch(JSON.stringify(success(runBin(s,['sdd','status','f']))),/sdd commit f/)
  } finally { held.release(); f.dispose() }
})

test('citations survive later phase writer verify and commit registry writes', () => {
  const s = chainSetup({ bins: ['codex','claude'],families: '[codex, claude]',
    writers: [{ actions: [{ write: 'src/a.ts',content: 'export const f = () => 2\n' }], report: JSON.stringify({ phase: 'implement',missing_context: [],tasks: [{ id: 'T1',completion: 'done',change_kind: 'behavior_change',changed: 'done',deviation: null,check: 'V1' }] })+'\nSTATUS: done' }] })
  git(s,'config','user.name','t'); git(s,'config','user.email','t@t')
  chainFlow(s)
  const citations = [newRunId(),newRunId()]
  writeRegistry(s,{ schema_version: 1,last_run: null,phases: {},reviews: citations })
  for (const name of ['spec.md','plan.md','tasks.md','sdd-ai-approvals.json']) rmSync(file(s,`.plans/f/${name}`))
  put(s,'.plans/f/handoff.md','---\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: null\n---\n\n# Handoff\n')
  put(s,'.plans/f/request.md','Requested feature.\n')
  const answers = file(s,'.plans/f/phase-answers.json')
  writeFileSync(answers,JSON.stringify([JSON.stringify({ phase: 'specify',known_facts: [],assumptions: [],blocking_questions: [],missing_context: [],
    acceptance_criteria: [{ id: 'AC-1',text: 'f gives 2',authority: 'pedido',verification: 'test' }],problem: 'Problem.',background: 'Context.',scope: 'Feature.' })]))
  const doc = success(runBin(s,['sdd','phase','f','--request','.plans/f/request.md'],{ FAKE_MODE: 'scripted',FAKE_ANSWERS: answers,FAKE_CALLS_FILE: `${answers}.calls` })).id
  assert.equal(wait(s,doc).outcome,'published')
  assert.deepEqual(registry(s).reviews,citations)
  chainFlow(s,{ rows: [F_ROW,{ ...MANUAL_ROW,acs: ['AC-1'] }] })
  const run = success(runBin(s,['sdd','phase','f'])).id; wait(s,run)
  assert.deepEqual(registry(s).reviews,citations)
  markAll(s)
  const start = prepareVerify(s.repo,'f','final')
  // Solo hacen falta la base y la huella del plan para la pregunta: la reserva de verify se suelta enseguida.
  assert.equal(releaseReservation(start.reservation).state,'released')
  const q = attestQuestion('f','V2',MANUAL_ROW.observation,candidateFingerprint(s.repo,'f',start.baseCommit),start.planFingerprint)
  const env = answered(q,'Acreditar')
  attestRow(s.repo,'f','V2',{ ...s.env,...env })
  assert.deepEqual(registry(s).reviews,citations)
  success(runBin(s,['sdd','verify','f']))
  assert.deepEqual(registry(s).reviews,citations)
  const id = review(s); const all = [...citations,id]
  assert.deepEqual(registry(s).reviews,all)
  const f = telemetryFixture(s.repo)
  try {
    const observations = join(f.home,'commit-writes')
    success(runBin(s,['sdd','commit','f','--subject','agrega el cambio','--apply','--digest',success(draft(s)).digest],{
      HOME: f.home,SDD_AI_TELEMETRY: 'off',NODE_OPTIONS: `--import ${join(import.meta.dirname,'telemetry-fault-preload.ts')}`,
      SDD_AI_TEST_FAULT_TARGET: file(s,'.plans/f'),SDD_AI_TEST_FAULT_OBSERVATIONS: observations,SDD_AI_TEST_CITATION_REGISTRY: file(s,registryPath),
    }))
    const writes = readFileSync(observations,'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.operation === 'registry_write')
    for (const state of ['intent','done']) assert.ok(writes.some((e) => e.record.commit?.state === state && JSON.stringify(e.record.reviews) === JSON.stringify(all)))
  } finally { f.dispose() }
  assert.deepEqual(registry(s).reviews,all); assert.equal(registry(s).commit.state,'done')
})
