import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { type Ledger } from '../src/review/ledger.ts'
import { disputeQuestion, extraQuestion } from '../src/approval/question.ts'
import { answer, calls, cleanup, cli, contracts, corrected, directedAnswer, entries, flowFile, json, makeFixture, put, refreshReview, revise, runFile, script, settle } from './phase-revision-fixture.ts'

test('la ronda conserva el ledger y distingue productor conductor y autoria mezclada', async () => {
  for (const scenario of ['producer', 'mixed', 'mixed-multiple', 'conductor', 'no_changes', 'failed']) {
    const s = makeFixture()
    try {
      const before = readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8')
      const original = readFileSync(flowFile(s, 'spec.md'), 'utf8')
      const reviewer = readFileSync(runFile(s, s.review, 'resolved.json'), 'utf8')
      if (scenario !== 'conductor') {
        script(s, scenario === 'failed' ? [{ execution_failure: true }] : [{ answer: JSON.stringify(scenario === 'no_changes' ? contracts.spec : corrected('spec')) }])
        const start = revise(s); assert.equal(start.code, 0, JSON.stringify(start.out))
        const outcome = (await settle(s, start.out.id)).out.outcome
        assert.equal(outcome, scenario === 'failed' ? 'failed' : scenario === 'no_changes' ? 'no_changes' : 'published')
        assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), before)
      }
      if (scenario === 'mixed-multiple') {
        // Una intervención entre publicaciones rompe la cadena de huellas del productor.
        writeFileSync(flowFile(s, 'spec.md'), original)
        script(s, [{ answer: JSON.stringify(corrected('spec', 'Segunda publicación')) }])
        const again = revise(s); assert.equal(again.code, 0, JSON.stringify(again.out))
        assert.equal((await settle(s, again.out.id)).out.outcome, 'published')
        assert.equal(entries(s).filter((e) => e.result?.state === 'published' && e.result.digest).length, 2)
        assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), before)
      }
      if (scenario !== 'producer' && scenario !== 'mixed-multiple') writeFileSync(flowFile(s, 'spec.md'), readFileSync(flowFile(s, 'spec.md'), 'utf8').replace('Publicar un resultado.', 'Publicar un resultado. Retoque inline.'))
      const response = JSON.parse(directedAnswer(s, 'resolved'))
      // La línea 9 pertenece al cuerpo corregido y +5 identifica la adición en CAMBIOS.
      if (scenario === 'producer') response.findings = [{ of: '.plans/f/spec.md', axis: 'quality', severity: 'WARNING', location: '.plans/f/spec.md:9',
        claim: 'La corrección introdujo una incoherencia.', evidence: 'deterministic', cause: '+5' }]
      script(s, [{ answer: JSON.stringify(response) }])
      const start = cli(s, ['review', 'round', s.review]); assert.equal(start.code, 0, JSON.stringify(start.out))
      await settle(s, s.review)
      const rounds = json<{ rounds: Array<{ correction_provenance: { author: string; family?: string }; jobs: Array<{ prompt: string }> }> }>(runFile(s, s.review, 'rounds.json'))
      const latest = rounds.rounds.at(-1)!
      assert.equal(latest.correction_provenance.author, scenario === 'producer' ? 'producer' : scenario.startsWith('mixed') ? 'mixed' : 'conductor')
      if (scenario === 'producer') assert.equal(latest.correction_provenance.family, s.family)
      const promptFiles = ['prompt-r2-l1-base-b1.md', 'prompt-r2-l1.md']
      const actual = readdirSync(`${s.repo}/.sdd-ai/runs/${s.review}`).filter((p) => p.startsWith('prompt-r2') && p.endsWith('.md'))
      assert.ok(actual.length > 0 && actual.every((p) => promptFiles.includes(p)), JSON.stringify(actual))
      for (const promptFile of actual) {
        const prompt = readFileSync(runFile(s, s.review, promptFile), 'utf8')
        if (scenario === 'producer') assert.ok(prompt.includes(`el productor de familia ${s.family} corrigió los hallazgos aceptados del artefacto`))
        else if (scenario.startsWith('mixed')) assert.ok(prompt.includes('el productor y el conductor corrigieron los hallazgos aceptados del artefacto'))
        else {
          assert.ok(prompt.includes('el conductor corrigió los que aceptó; los hallazgos rechazados conservan el motivo del conductor'))
          assert.ok(!prompt.includes('el productor de familia')); assert.ok(!prompt.includes('el productor y el conductor corrigieron'))
        }
        assert.match(prompt, /CAMBIOS/)
      }
      const ledger = json<Ledger>(runFile(s, s.review, 'ledger.json'))
      assert.equal(ledger.completed, 2); assert.equal(ledger.entries[0].id, 'F-1'); assert.equal(ledger.entries[0].state, 'resuelto')
      assert.deepEqual(ledger.entries[0].decision, JSON.parse(before).entries[0].decision)
      assert.equal(ledger.entries[0].responses.at(-1)!.answer, 'resolved')
      assert.equal(readFileSync(runFile(s, s.review, 'resolved.json'), 'utf8'), reviewer)
      if (scenario === 'producer') { assert.equal(ledger.entries[1].id, 'F-2'); assert.equal(ledger.entries[1].cause, '+5') }
    } finally { await cleanup(s) }
  }
})

test('devolver al productor no concede rondas extra ni resuelve disputas', async () => {
  const s = makeFixture()
  try {
    refreshReview(s, 3)
    const ledger = readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8')
    script(s, [{ answer: JSON.stringify(corrected('spec')) }])
    const start = revise(s); assert.equal(start.code, 0, JSON.stringify(start.out)); assert.equal((await settle(s, start.out.id)).out.outcome, 'published')
    assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), ledger)
    const count = calls(s).length
    const capped = cli(s, ['review', 'round', s.review])
    assert.notEqual(capped.code, 0); assert.equal(capped.out.code, 'round_cap')
    const extra = cli(s, ['review', 'round', s.review, '--extra'])
    assert.equal(extra.out.code, 'approval_missing'); assert.equal(calls(s).length, count)
    assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), ledger)
    // El tope conserva tres rondas; se autoriza únicamente la cuarta.
    answer(s, extraQuestion(s.review, 4))
    script(s, [{ answer: directedAnswer(s, 'unresolved') }])
    const authorized = cli(s, ['review', 'round', s.review, '--extra'])
    assert.equal(authorized.code, 0, JSON.stringify(authorized.out)); await settle(s, s.review)
    assert.equal(json<Ledger>(runFile(s, s.review, 'ledger.json')).completed, 4)
    assert.equal(json<Ledger>(runFile(s, s.review, 'ledger.json')).entries[0].id, 'F-1')
    assert.equal(json<Ledger>(runFile(s, s.review, 'ledger.json')).entries[0].state, 'aceptado')
    assert.equal(calls(s).length, count + 1)
  } finally { await cleanup(s) }
  const dispute = makeFixture()
  try {
    const ledger = json<Ledger>(runFile(dispute, dispute.review, 'ledger.json'))
    ledger.entries[0].state = 'en-disputa'; ledger.entries[0].decision = { action: 'reject', from: 'en-disputa', after_round: 1, reason: 'Ya está descrito.' }
    ledger.entries[0].responses = [{ round: 1, answer: 'maintained', evidence: '.plans/f/spec.md:5' }]
    put(runFile(dispute, dispute.review, 'ledger.json'), ledger)
    const before = readFileSync(runFile(dispute, dispute.review, 'ledger.json'), 'utf8')
    assert.equal(revise(dispute).out.code, 'decisions_pending')
    const decision = cli(dispute, ['review', 'decide', dispute.review, 'accept', 'F-1'])
    assert.equal(decision.out.code, 'approval_missing')
    assert.equal(calls(dispute).length, 0); assert.equal(readFileSync(runFile(dispute, dispute.review, 'ledger.json'), 'utf8'), before)
    assert.equal(entries(dispute).length, 0)
    answer(dispute, disputeQuestion(dispute.review, ledger.entries[0], 1, 'Ya está descrito.'))
    const authorized = cli(dispute, ['review', 'decide', dispute.review, 'accept', 'F-1'])
    assert.equal(authorized.code, 0, JSON.stringify(authorized.out))
    const decided = json<Ledger>(runFile(dispute, dispute.review, 'ledger.json'))
    assert.equal(decided.completed, 1); assert.equal(decided.entries[0].state, 'aceptado')
    assert.ok(decided.entries[0].decision!.proof); assert.equal(decided.entries[0].superseded!.at(-1)!.reason, 'Ya está descrito.')
    assert.deepEqual(decided.entries[0].responses, ledger.entries[0].responses)
    const correction = revise(dispute); assert.equal(correction.code, 0, JSON.stringify(correction.out))
    assert.equal((await settle(dispute, correction.out.id)).out.outcome, 'published')
    assert.deepEqual(json<Ledger>(runFile(dispute, dispute.review, 'ledger.json')), decided)
  } finally { await cleanup(dispute) }
})
