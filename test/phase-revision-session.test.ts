import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { sessionFile } from '../src/approval/session.ts'
import { claudeResume } from '../src/workers/claude.ts'
import { codexResume } from '../src/workers/codex.ts'
import { type PhaseRecord } from '../src/sdd/phase-state.ts'
import { answer, calls, cleanup, cli, contracts, corrected, directedAnswer, entries, flowFile, json, makeFixture, put, questionFrom, record, refreshReview, revise, runFile, saveRecord, script, settle, snapshotFiles } from './phase-revision-fixture.ts'

test('las correcciones sucesivas reanudan con el resume de la sesion registrada en cada familia', async () => {
  for (const family of ['claude', 'codex'] as const) {
    const s = makeFixture({ family })
    try {
      for (let n = 1; n <= 2; n++) {
        script(s, [{ answer: JSON.stringify(corrected('spec', `Ronda ${n}`)) }])
        const start = revise(s)
        assert.equal(start.code, 0, JSON.stringify(start.out))
        assert.equal((await settle(s, start.out.id)).out.outcome, 'published')
        const e = entries(s).at(-1)!
        assert.equal(e.session_id, s.session); assert.equal(e.session_mode, 'same'); assert.equal(e.family, family)
        const launch = json<{ launch: { args: string[] } }>(runFile(s, e.run, 'argv.json')).launch
        const expected = family === 'claude' ? claudeResume(e.launch.args) : codexResume(e.launch.args, s.session, runFile(s, e.run, 'result.md'))
        assert.deepEqual(launch.args, expected)
        assert.deepEqual(calls(s).at(-1), expected)
        assert.ok(launch.args.includes('fake-model')); assert.ok(launch.args.some((a) => a === '--resume' || a === 'resume'))
        if (n === 1) {
          script(s, [{ answer: directedAnswer(s) }])
          const round = cli(s, ['review', 'round', s.review])
          assert.equal(round.code, 0, JSON.stringify(round.out))
          await settle(s, s.review)
          assert.equal(json<{ completed: number }>(runFile(s, s.review, 'ledger.json')).completed, 2)
        }
      }
      assert.equal(entries(s)[1].parent_run, entries(s)[0].run)
      refreshReview(s)
      const beforeTimeout = snapshotFiles(s)
      const count = calls(s).length
      script(s, [{ hang: true }, { hang: true }])
      const timed = revise(s, ['--deadline', '1'])
      assert.equal(timed.code, 0, JSON.stringify(timed.out))
      assert.equal(cli(s, ['wait', timed.out.id, '--max', '15']).out.outcome, 'timeout')
      assert.deepEqual(snapshotFiles(s), beforeTimeout)
      for (const args of calls(s).slice(count)) {
        const session = family === 'claude' ? args[args.indexOf('--resume') + 1] : args.at(-2)
        assert.equal(session, s.session)
        assert.ok(args.includes('fake-model'))
      }
      assert.equal(entries(s).at(-1)!.session_id, s.session)
    } finally { await cleanup(s) }
    // El contrato admitido en la recuperación pertenece a su sesión efectiva, no al primer intento.
    const created = makeFixture({ family, approved: false })
    try {
      for (const file of ['spec.md', 'plan.md', 'tasks.md']) rmSync(flowFile(created, file))
      saveRecord(created, { schema_version: 1, last_run: null, phases: {} })
      if (family === 'claude') { created.env.CLAUDECODE = '0'; created.env.CODEX_THREAD_ID = 'human-codex'; created.env.CODEX_SESSION_ID = 'human-codex' }
      script(created, [{ answer: 'inadmisible', ...(family === 'codex' ? { session: 'INITIAL_SESSION' } : {}) },
        { answer: JSON.stringify(contracts.spec), ...(family === 'codex' ? { session: 'ADMITTED_SESSION' } : {}) }])
      const start = cli(created, ['sdd', 'phase', 'f', '--request', 'request.md'])
      assert.equal(start.code, 0, JSON.stringify(start.out))
      assert.equal((await settle(created, start.out.id)).out.outcome, 'published')
      created.env.CLAUDECODE = '1'; delete created.env.CODEX_THREAD_ID; delete created.env.CODEX_SESSION_ID
      const origin = record(created).documents!.specify!
      assert.equal(calls(created).length, 2)
      if (family === 'codex') assert.equal(origin.session_id, 'ADMITTED_SESSION')
      else {
        const argv = calls(created)
        assert.notEqual(argv[0][argv[0].indexOf('--session-id') + 1], origin.session_id)
        assert.equal(argv[1][argv[1].indexOf('--session-id') + 1], origin.session_id)
      }
      created.origin = start.out.id
      refreshReview(created)
      script(created, [{ answer: JSON.stringify(corrected('spec')) }])
      const correction = revise(created)
      assert.equal(correction.code, 0, JSON.stringify(correction.out))
      await settle(created, correction.out.id)
      assert.equal(entries(created).at(-1)!.session_id, origin.session_id)
    } finally { await cleanup(created) }
  }
})

test('una sesion nueva requiere el flag y una respuesta humana ligada a cada uso', async () => {
  for (const family of ['claude', 'codex'] as const) {
    const s = makeFixture({ family })
    try {
      rmSync(sessionFile(s.env, { runner: family, session: s.session }))
      assert.equal(revise(s).out.code, 'session_unrecoverable')
      const refused = revise(s, ['--new-session'])
      assert.equal(refused.out.code, 'approval_missing'); assert.equal(calls(s).length, 0)
      const q = questionFrom(refused.out)
      answer(s, q)
      writeFileSync(`${s.repo}/decisions.md`, 'Max aclara el resultado.\n')
      const altered = revise(s, ['--new-session', '--decisions', 'decisions.md'])
      assert.equal(altered.out.code, 'approval_missing'); assert.equal(calls(s).length, 0)
      const bound = questionFrom(altered.out); assert.notEqual(bound.question, q.question)
      answer(s, bound)
      writeFileSync(`${s.repo}/decisions.md`, 'Max aclara otro detalle del resultado.\n')
      const changed = revise(s, ['--new-session', '--decisions', 'decisions.md'])
      assert.equal(changed.out.code, 'approval_missing'); assert.equal(calls(s).length, 0)
      answer(s, questionFrom(changed.out))
      const start = revise(s, ['--new-session', '--decisions', 'decisions.md'])
      assert.equal(start.code, 0, JSON.stringify(start.out))
      await settle(s, start.out.id)
      const e = entries(s).at(-1)!
      assert.equal(e.session_mode, 'new'); assert.equal(e.family, family); assert.ok(e.authorization)
      assert.notEqual(e.session_id, s.session)
      refreshReview(s)
      script(s, [{ answer: JSON.stringify(corrected('spec', 'Segunda sesión')) }])
      rmSync(sessionFile(s.env, { runner: family, session: e.session_id! }))
      const second = revise(s, ['--new-session'])
      assert.equal(second.out.code, 'approval_missing')
      const q2 = questionFrom(second.out)
      assert.notEqual(q.question, q2.question)
      assert.equal(calls(s).length, 1)
      answer(s, q2)
      const next = revise(s, ['--new-session'])
      assert.equal(next.code, 0, JSON.stringify(next.out)); await settle(s, next.out.id)
      assert.notEqual(entries(s).at(-1)!.authorization!.ref, e.authorization!.ref)
      assert.equal(record(s).last_run!.id, s.origin)
      const freshSession = entries(s).at(-1)!.session_id!
      refreshReview(s); script(s, [{ answer: JSON.stringify(corrected('spec', 'Continúa la sesión nueva')) }])
      const resumed = revise(s)
      assert.equal(resumed.code, 0, JSON.stringify(resumed.out)); await settle(s, resumed.out.id)
      assert.equal(entries(s).at(-1)!.session_mode, 'same'); assert.equal(entries(s).at(-1)!.session_id, freshSession)
      assert.equal(family === 'claude' ? calls(s).at(-1)![calls(s).at(-1)!.indexOf('--resume') + 1] : calls(s).at(-1)!.at(-2), freshSession)
    } finally { await cleanup(s) }
  }
})

test('las negativas de sesion distinguen sesion ausente proveedor ausente origen ambiguo y sesion recuperable', async () => {
  for (const mode of ['missing', 'provider', 'ambiguous', 'recoverable']) {
    const s = makeFixture({ bins: mode === 'provider' ? ['claude'] : ['claude', 'codex'] })
    try {
      if (mode === 'missing') rmSync(sessionFile(s.env, { runner: s.family, session: s.session }))
      if (mode === 'ambiguous') {
        const r = record(s); delete r.documents; saveRecord(s, r)
        const copy = 'other-producer'
        const source = `${s.repo}/.sdd-ai/runs/${s.origin}`
        const { cpSync } = await import('node:fs')
        cpSync(source, `${s.repo}/.sdd-ai/runs/${copy}`, { recursive: true })
      }
      const before = snapshotFiles(s)
      const r = revise(s, mode === 'recoverable' ? ['--new-session'] : [])
      assert.equal(r.out.code, mode === 'missing' ? 'session_unrecoverable' : mode === 'provider' ? 'cli_missing' : mode === 'ambiguous' ? 'origin_ambiguous' : 'session_recoverable', JSON.stringify(r.out))
      assert.equal(calls(s).length, 0); assert.deepEqual(snapshotFiles(s), before); assert.equal(entries(s).length, 0)
    } finally { await cleanup(s) }
  }
})

test('un resume rechazado vuelve la sesion no recuperable y habilita la sesion nueva autorizada', async () => {
  for (const continuation of [false, true]) {
    const s = makeFixture()
    try {
      if (continuation) {
        const c = corrected('spec'); c.blocking_questions = ['¿Cuál resultado?']
        script(s, [{ answer: JSON.stringify(c) }])
        const first = revise(s); await settle(s, first.out.id)
        writeFileSync(`${s.repo}/answers.md`, 'Max: el resultado observable.\n')
      }
      script(s, [{ reject_resume: true }])
      const start = continuation ? cli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--context', 'answers.md']) : revise(s)
      assert.equal(start.code, 0, JSON.stringify(start.out))
      const before = snapshotFiles(s)
      const finished = await settle(s, start.out.id)
      assert.equal(finished.out.outcome, 'resume_rejected', JSON.stringify(finished.out))
      assert.equal(entries(s).at(-1)!.session_recoverable, false)
      assert.equal(entries(s).at(-1)!.state, continuation ? 'awaiting_context' : 'resume_rejected')
      assert.ok(sessionFile(s.env, { runner: s.family, session: s.session })); assert.deepEqual(snapshotFiles(s), before)
      const args = ['sdd', 'phase', 'f', '--revise', 'spec', ...(continuation ? ['--context', 'answers.md'] : ['--review', s.review])]
      assert.equal(cli(s, args).out.code, 'session_unrecoverable')
      const refused = cli(s, [...args, '--new-session']); assert.equal(refused.out.code, 'approval_missing')
      answer(s, questionFrom(refused.out))
      script(s, [{ answer: JSON.stringify(corrected('spec')) }])
      const fresh = cli(s, [...args, '--new-session'])
      assert.equal(fresh.code, 0, JSON.stringify(fresh.out)); await settle(s, fresh.out.id)
      assert.equal(entries(s).at(-1)!.session_mode, 'new'); assert.equal(entries(s).at(-1)!.family, s.family)
      if (continuation) assert.ok(readFileSync(runFile(s, fresh.out.id, 'prompt.md'), 'utf8').includes('Max: el resultado observable.'))
    } finally { await cleanup(s) }
  }
})
