import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import type { Family } from '../src/types.ts'
import { sessionFile } from '../src/approval/session.ts'
import { claudeResume } from '../src/workers/claude.ts'
import { codexResume } from '../src/workers/codex.ts'
import { type PhaseRecord } from '../src/sdd/phase-state.ts'
import { answer, calls, cleanup, cli, contracts, corrected, directedAnswer, entries, flowFile, json, makeFixture, put, questionFrom, record, refreshReview, revise, runFile, saveRecord, script, settle, snapshotFiles } from './phase-revision-fixture.ts'

/** codexResume termina con <session> -, Claude usa --resume <session>. */
const resumedSession = (family: Family, args: string[]) => {
  if (family === 'claude') { const index = args.indexOf('--resume'); return index >= 0 ? args[index + 1] : undefined }
  // codexResume produce exec resume ... <thread> -.
  return args[0] === 'exec' && args[1] === 'resume' && args.at(-1) === '-' ? args.at(-2) : undefined
}

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
        const originArgs = json<{ launch: { args: string[] } }>(runFile(s, s.origin, 'argv.json')).launch.args
        const expected = family === 'claude' ? claudeResume(originArgs) : codexResume(originArgs, s.session, runFile(s, e.run, 'result.md'))
        if (family === 'claude') { assert.ok(launch.args.indexOf('--resume') >= 0); assert.equal(launch.args[launch.args.indexOf('--resume') + 1], s.session) }
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
      const previousEntries = entries(s).length
      const count = calls(s).length
      script(s, [{ hang: true }, { hang: true }])
      const timed = revise(s, ['--deadline', '1'])
      assert.equal(timed.code, 0, JSON.stringify(timed.out))
      assert.equal(cli(s, ['wait', timed.out.id, '--max', '15']).out.outcome, 'timeout')
      assert.deepEqual(snapshotFiles(s), beforeTimeout)
      assert.ok(calls(s).length > count, 'timeout debe haber invocado al proveedor')
      for (const args of calls(s).slice(count)) {
        const session = resumedSession(family, args)
        assert.equal(session, s.session)
        assert.ok(args.includes('fake-model'))
      }
      assert.equal(entries(s).length, previousEntries + 1)
      assert.equal(entries(s).at(-1)!.run, timed.out.id); assert.equal(entries(s).at(-1)!.state, 'timeout')
      assert.equal(entries(s).at(-1)!.session_id, s.session)
      // La recuperación de admisión de una corrección continúa la sesión fijada.
      script(s, [{ answer: 'inadmisible' }, { answer: JSON.stringify(corrected('spec', 'Admisión recuperada')) }])
      const admitted = revise(s); assert.equal(admitted.code, 0, JSON.stringify(admitted.out))
      assert.equal((await settle(s, admitted.out.id)).out.outcome, 'published')
      assert.equal(entries(s).at(-1)!.session_id, s.session)
      for (const args of calls(s).slice(-2)) assert.equal(resumedSession(family, args), s.session)
    } finally { await cleanup(s) }
    // El contrato admitido en la recuperación pertenece a su sesión efectiva, no al primer intento.
    const created = makeFixture({ family, approved: false })
    try {
      for (const file of ['spec.md', 'plan.md', 'tasks.md']) rmSync(flowFile(created, file))
      saveRecord(created, { schema_version: 1, last_run: null, phases: {} })
      // El conductor sintético usa la otra familia: la sesión humana nunca es la del productor.
      const originalEnv = { CLAUDECODE: created.env.CLAUDECODE, CODEX_THREAD_ID: created.env.CODEX_THREAD_ID, CODEX_SESSION_ID: created.env.CODEX_SESSION_ID }
      if (family === 'claude') { created.env.CLAUDECODE = '0'; created.env.CODEX_THREAD_ID = 'human-codex'; created.env.CODEX_SESSION_ID = 'human-codex' }
      script(created, [{ answer: 'inadmisible', ...(family === 'codex' ? { session: 'INITIAL_SESSION' } : {}) },
        { answer: JSON.stringify(contracts.spec), ...(family === 'codex' ? { session: 'ADMITTED_SESSION' } : {}) }])
      const start = cli(created, ['sdd', 'phase', 'f', '--request', 'request.md'])
      assert.equal(start.code, 0, JSON.stringify(start.out))
      assert.equal((await settle(created, start.out.id)).out.outcome, 'published')
      for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete created.env[key]; else created.env[key] = value }
      const origin = record(created).documents!.specify!
      assert.equal(calls(created).length, 2)
      if (family === 'codex') assert.equal(origin.session_id, 'ADMITTED_SESSION')
      else {
        const argv = calls(created)
        assert.ok(argv[0].indexOf('--session-id') >= 0); assert.ok(argv[1].indexOf('--session-id') >= 0)
        assert.notEqual(argv[0][argv[0].indexOf('--session-id') + 1], origin.session_id)
        assert.equal(argv[1][argv[1].indexOf('--session-id') + 1], origin.session_id)
      }
      created.origin = start.out.id
      refreshReview(created)
      script(created, [{ answer: JSON.stringify(corrected('spec')) }])
      const correction = revise(created)
      assert.equal(correction.code, 0, JSON.stringify(correction.out))
      assert.equal((await settle(created, correction.out.id)).out.outcome, 'published')
      assert.equal(resumedSession(family, calls(created).at(-1)!), origin.session_id)
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
      script(s, [{ answer: JSON.stringify(contracts.spec) }])
      const start = revise(s, ['--new-session', '--decisions', 'decisions.md'])
      assert.equal(start.code, 0, JSON.stringify(start.out))
      assert.equal((await settle(s, start.out.id)).out.outcome, 'no_changes')
      const e = entries(s).at(-1)!
      assert.equal(e.session_mode, 'new'); assert.equal(e.family, family); assert.ok(e.authorization)
      assert.notEqual(e.session_id, s.session)
      // Misma revisión, ronda, documento y aporte: solo cambia el contador de uso.
      script(s, [{ answer: JSON.stringify(corrected('spec', 'Segunda sesión')) }])
      rmSync(sessionFile(s.env, { runner: family, session: e.session_id! }))
      const second = revise(s, ['--new-session', '--decisions', 'decisions.md'])
      assert.equal(second.out.code, 'approval_missing')
      const q2 = questionFrom(second.out)
      assert.notEqual(questionFrom(changed.out).question, q2.question)
      assert.match(q2.question, /ronda 1, uso 2/)
      assert.equal(calls(s).length, 1)
      answer(s, q2)
      const next = revise(s, ['--new-session', '--decisions', 'decisions.md'])
      assert.equal(next.code, 0, JSON.stringify(next.out)); assert.equal((await settle(s, next.out.id)).out.outcome, 'published')
      assert.notEqual(entries(s).at(-1)!.authorization!.ref, e.authorization!.ref)
      assert.equal(record(s).last_run!.id, s.origin)
      const freshSession = entries(s).at(-1)!.session_id!
      refreshReview(s); script(s, [{ answer: JSON.stringify(corrected('spec', 'Continúa la sesión nueva')) }])
      const resumed = revise(s)
      assert.equal(resumed.code, 0, JSON.stringify(resumed.out)); assert.equal((await settle(s, resumed.out.id)).out.outcome, 'published')
      assert.equal(entries(s).at(-1)!.session_mode, 'same'); assert.equal(entries(s).at(-1)!.session_id, freshSession)
      assert.equal(resumedSession(family, calls(s).at(-1)!), freshSession)
    } finally { await cleanup(s) }
  }
})

test('las negativas de sesion distinguen sesion ausente proveedor ausente origen ambiguo y sesion recuperable', async () => {
  for (const mode of ['missing', 'provider', 'ambiguous', 'recoverable']) {
    const family = 'codex' as const
    const s = makeFixture({ family, bins: mode === 'provider' ? (['claude', 'codex'] as const).filter((bin) => bin !== family) : ['claude', 'codex'] })
    try {
      if (mode === 'missing') rmSync(sessionFile(s.env, { runner: s.family, session: s.session }))
      if (mode === 'ambiguous') {
        const r = record(s); delete r.documents; saveRecord(s, r)
        const copy = 'other-producer'
        const source = `${s.repo}/.sdd-ai/runs/${s.origin}`
        cpSync(source, `${s.repo}/.sdd-ai/runs/${copy}`, { recursive: true })
      }
      const before = snapshotFiles(s)
      const r = revise(s, mode === 'recoverable' ? ['--new-session'] : [])
      assert.equal(r.out.code, mode === 'missing' ? 'session_unrecoverable' : mode === 'provider' ? 'cli_missing' : mode === 'ambiguous' ? 'origin_ambiguous' : 'session_recoverable', JSON.stringify(r.out))
      if (mode !== 'recoverable') {
        const flagged = revise(s, ['--new-session'])
        assert.equal(flagged.out.code, mode === 'missing' ? 'approval_missing' : mode === 'provider' ? 'cli_missing' : 'origin_ambiguous', JSON.stringify(flagged.out))
        if (mode !== 'missing') assert.ok(!flagged.out.next?.includes('selección simple:'))
      }
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
        const first = revise(s); assert.equal(first.code, 0, JSON.stringify(first.out))
        assert.equal((await settle(s, first.out.id)).out.outcome, 'awaiting_context')
        writeFileSync(`${s.repo}/answers.md`, 'Max: el resultado observable.\n')
      }
      script(s, [{ reject_resume: true }])
      const before = snapshotFiles(s)
      const start = continuation ? cli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--context', 'answers.md']) : revise(s)
      assert.equal(start.code, 0, JSON.stringify(start.out))
      const finished = await settle(s, start.out.id)
      assert.equal(finished.out.outcome, 'resume_rejected', JSON.stringify(finished.out))
      assert.equal(entries(s).at(-1)!.session_recoverable, false)
      assert.equal(entries(s).at(-1)!.state, continuation ? 'awaiting_context' : 'resume_rejected')
      assert.ok(existsSync(sessionFile(s.env, { runner: s.family, session: s.session }))); assert.deepEqual(snapshotFiles(s), before)
      const args = ['sdd', 'phase', 'f', '--revise', 'spec', ...(continuation ? ['--context', 'answers.md'] : ['--review', s.review])]
      const launches = calls(s).length
      assert.equal(cli(s, args).out.code, 'session_unrecoverable')
      const refused = cli(s, [...args, '--new-session']); assert.equal(refused.out.code, 'approval_missing')
      assert.equal(calls(s).length, launches)
      answer(s, questionFrom(refused.out))
      if (continuation) writeFileSync(`${s.repo}/answers.md`, 'Max: contexto adicional nuevo.\n')
      script(s, [{ answer: JSON.stringify(corrected('spec')) }])
      const fresh = cli(s, [...args, '--new-session'])
      assert.equal(fresh.code, 0, JSON.stringify(fresh.out)); assert.equal((await settle(s, fresh.out.id)).out.outcome, 'published')
      assert.equal(entries(s).at(-1)!.session_mode, 'new'); assert.equal(entries(s).at(-1)!.family, s.family)
      assert.notEqual(entries(s).at(-1)!.session_id, s.session)
      assert.equal(resumedSession(s.family, calls(s).at(-1)!), undefined)
      if (continuation) assert.ok(readFileSync(runFile(s, fresh.out.id, 'prompt.md'), 'utf8').includes('Max: el resultado observable.'))
    } finally { await cleanup(s) }
  }
})
