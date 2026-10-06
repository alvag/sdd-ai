import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Question, disputeQuestion, extraQuestion } from '../src/approval/question.ts'
import { askPair, writeClaudeTranscript } from './helpers.ts'
import {
  BIN, lines, setup, cli, runFile, states, grave, grave2, firstRound, nextRound, startAndWait, waitRound, answerReview,
  ARTIFACT_AT_CAP, artifactAtCap, diffAtCap, unresolved, cliAsync, pause, holdLock, twoDisputes, ledgerText, entryOf,
} from './rounds-cli-fixture.ts'

test('la vista trae la pregunta de cada disputa decidible, también la redecidible, y la de la ronda extra en el tope', () => {
  const maintained = (id: string) => ({ id, answer: 'maintained', evidence: 'a.txt:5' })
  const s = setup([firstRound([grave, grave2]), nextRound([maintained('F-1'), maintained('F-2')])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional'])
  cli(s, ['review', 'decide', id, 'reject', 'F-2', '--reason', 'no aplica'])
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  const expected = [
    disputeQuestion(id, { id: 'F-1', claim: grave.claim }, 2, 'es intencional'),
    disputeQuestion(id, { id: 'F-2', claim: grave2.claim }, 2, 'no aplica'),
  ]
  assert.deepEqual(cli(s, ['review', 'status', id]).out.questions, expected)
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  assert.deepEqual(states(s, id), [['F-1', 'aceptado'], ['F-2', 'en-disputa']])
  assert.deepEqual(cli(s, ['review', 'status', id]).out.questions, expected)

  const capped = setup([firstRound([grave]), unresolved, unresolved])
  const cid = diffAtCap(capped)
  assert.deepEqual(cli(capped, ['review', 'status', cid]).out.questions, [extraQuestion(cid, 4)])
})

test('con una ronda en curso la vista no trae preguntas', () => {
  // Sin ledger: la ronda 1 no terminó.
  const u = setup(['__fail__', '__fail__'])
  const started = cli(u, ['review', 'start', '--base', u.base, '--author', 'codex'])
  waitRound(u, started.out.id)
  assert.deepEqual(cli(u, ['review', 'status', started.out.id]).out.questions, [])
  writeFileSync(runFile(u, started.out.id, 'status.json'), JSON.stringify({ state: 'running', round: 1, launch: 1 }))
  assert.deepEqual(cli(u, ['review', 'status', started.out.id]).out.questions, [])

  // Con ledger y una disputa: en curso, o con otra operación tomando la revisión, no hay preguntas.
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'maintained', evidence: 'a.txt:5' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional'])
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  assert.equal(cli(s, ['review', 'status', id]).out.questions.length, 1)
  const done = readFileSync(runFile(s, id, 'status.json'), 'utf8')
  writeFileSync(runFile(s, id, 'status.json'), JSON.stringify({ state: 'running', round: 2, launch: 1 }))
  assert.deepEqual(cli(s, ['review', 'status', id]).out.questions, [])
  writeFileSync(runFile(s, id, 'status.json'), done)
  writeFileSync(runFile(s, id, 'review.lock'), `${JSON.stringify({ pid: process.pid, lstart: null })}\n`)
  const busy = cli(s, ['review', 'status', id]).out
  assert.deepEqual(busy.questions, [])
  assert.match(busy.next, /otra operación de la revisión está en curso/)
  rmSync(runFile(s, id, 'review.lock'))

  // En el tope con una disputa sin decidir: la pregunta de la disputa y no la de la ronda extra.
  const d = setup([
    firstRound([grave]), nextRound([{ id: 'F-1', answer: 'unresolved', evidence: 'a.txt:5' }], [grave2]),
    nextRound([{ id: 'F-1', answer: 'unresolved', evidence: 'a.txt:5' }, { id: 'F-2', answer: 'maintained', evidence: 'a.txt:5' }]),
  ])
  const did = startAndWait(d)
  cli(d, ['review', 'decide', did, 'accept', 'F-1'])
  for (const n of [2, 3]) {
    writeFileSync(join(d.repo, 'a.txt'), lines(10, { 5: `línea cinco, intento ${n}` }))
    assert.equal(cli(d, ['review', 'round', did]).code, 0)
    waitRound(d, did)
    if (n === 2) cli(d, ['review', 'decide', did, 'reject', 'F-2', '--reason', 'no aplica'])
  }
  assert.deepEqual(states(d, did), [['F-1', 'aceptado'], ['F-2', 'en-disputa']])
  assert.deepEqual(cli(d, ['review', 'status', did]).out.questions.map((q: Question) => q.header), ['Disputa F-2'])

  // En un artefacto con un insumo cambiado, la ronda extra no se puede lanzar y no se pregunta.
  const a = setup(ARTIFACT_AT_CAP)
  const aid = artifactAtCap(a)
  assert.deepEqual(cli(a, ['review', 'status', aid]).out.questions, [extraQuestion(aid, 4)])
  writeFileSync(join(a.repo, '.plans', 'pedido.md'), 'Quiero otra cosa.\n')
  assert.deepEqual(cli(a, ['review', 'status', aid]).out.questions, [])
})

test('decide sobre una disputa exige prueba y sobre un hallazgo abierto no', () => {
  // Un hallazgo abierto se decide sin preguntar, también sin la sesión de un runner.
  const o = setup([firstRound([grave])])
  const oid = startAndWait(o)
  const { CLAUDE_CODE_SESSION_ID: _, ...noSession } = o.env
  const r0 = spawnSync(process.execPath, [BIN, 'review', 'decide', oid, 'accept', 'F-1'], { cwd: o.repo, env: noSession, encoding: 'utf8' })
  assert.equal(r0.status, 0, r0.stdout)

  const { s, id } = twoDisputes()
  const before = ledgerText(s, id)
  const missing = cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  assert.equal(missing.out.code, 'approval_missing', JSON.stringify(missing.out))
  assert.equal(ledgerText(s, id), before)
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  const worker = spawnSync(process.execPath, [BIN, 'review', 'decide', id, 'accept', 'F-1'], { cwd: s.repo, env: { ...s.env, SDD_AI_WORKER: '1' }, encoding: 'utf8' })
  assert.equal(JSON.parse(worker.stdout).code, 'runner_required')
  assert.equal(ledgerText(s, id), before)
  const ok = cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  assert.equal(ok.code, 0, JSON.stringify(ok.out))
  const proof = entryOf(s, id, 'F-1').decision.proof
  assert.deepEqual(Object.keys(proof), ['runner', 'source', 'ref', 'session', 'answered_at'])
  assert.equal(proof.session, s.env.CLAUDE_CODE_SESSION_ID)
  // La vista del propio comando se arma con la revisión ya suelta: trae la pregunta de la otra disputa.
  assert.ok(ok.out.questions.some((q: Question) => q.question.includes('disputa F-2')), JSON.stringify(ok.out.questions))
})

test('cada disputa exige su prueba y un reject conjunto con motivos distintos se rechaza entero', () => {
  const { s, id } = twoDisputes()
  const before = ledgerText(s, id)
  answerReview(s, id, 'disputa F-1', 'Mantener el rechazo')
  answerReview(s, id, 'disputa F-2', 'Mantener el rechazo')
  const mixed = cli(s, ['review', 'decide', id, 'reject', 'F-1', 'F-2'])
  assert.equal(mixed.out.code, 'approval_contradicted', JSON.stringify(mixed.out))
  assert.match(mixed.out.next, /por separado/)
  assert.equal(ledgerText(s, id), before)
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  const partial = cli(s, ['review', 'decide', id, 'accept', 'F-1', 'F-2'])
  assert.equal(partial.out.code, 'approval_contradicted', JSON.stringify(partial.out))
  assert.equal(ledgerText(s, id), before)
  answerReview(s, id, 'disputa F-2', 'Aceptar el hallazgo')
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1', 'F-2']).code, 0)
  const refs = ['F-1', 'F-2'].map((f) => entryOf(s, id, f).decision.proof.ref)
  assert.notEqual(refs[0], refs[1])
})

test('un reject mixto con --reason igual al motivo de sus disputas se registra, y sin --reason o con otro motivo se rechaza', () => {
  const s = setup([firstRound([grave, grave2]), nextRound([{ id: 'F-1', answer: 'maintained', evidence: 'a.txt:5' }, { id: 'F-2', answer: 'unresolved', evidence: 'a.txt:5' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional'])
  cli(s, ['review', 'decide', id, 'accept', 'F-2'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco, otra vez' }))
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  assert.deepEqual(states(s, id), [['F-1', 'en-disputa'], ['F-2', 'aceptado']])
  const before = ledgerText(s, id)
  answerReview(s, id, 'disputa F-1', 'Mantener el rechazo')
  const bare = cli(s, ['review', 'decide', id, 'reject', 'F-1', 'F-2'])
  assert.equal(bare.out.code, 'usage', JSON.stringify(bare.out))
  assert.match(bare.out.next, /por separado/)
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-1', 'F-2', '--reason', 'otra cosa']).out.code, 'approval_contradicted')
  assert.equal(ledgerText(s, id), before)
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-1', 'F-2', '--reason', 'es intencional']).code, 0)
  assert.deepEqual(states(s, id), [['F-1', 'cerrado'], ['F-2', 'rechazado']])
  assert.equal(entryOf(s, id, 'F-2').decision.reason, 'es intencional')
  assert.equal(entryOf(s, id, 'F-2').decision.proof, undefined)
  assert.equal(entryOf(s, id, 'F-1').decision.proof.runner, 'claude')
})

test('un --reason distinto del motivo mostrado rechaza', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'maintained', evidence: 'a.txt:5' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional'])
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  const before = ledgerText(s, id)
  answerReview(s, id, 'disputa F-1', 'Mantener el rechazo')
  const r = cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'decide la persona: se queda'])
  assert.equal(r.out.code, 'approval_contradicted', JSON.stringify(r.out))
  assert.equal(ledgerText(s, id), before)
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-1']).code, 0)
  assert.equal(entryOf(s, id, 'F-1').decision.reason, 'es intencional')
})

test('redecidir una disputa pide otra respuesta y la decisión reemplazada queda en superseded', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'maintained', evidence: 'a.txt:5' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional'])
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  const first = entryOf(s, id, 'F-1').decision.proof.ref
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-1']).out.code, 'approval_contradicted')
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).out.code, 'approval_reused')
  answerReview(s, id, 'disputa F-1', 'Mantener el rechazo')
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-1']).code, 0)
  const e = entryOf(s, id, 'F-1')
  assert.equal(e.state, 'cerrado')
  assert.deepEqual(e.superseded.map((d: { action: string; after_round: number }) => [d.action, d.after_round]), [['reject', 1], ['accept', 2]])
  assert.equal(e.superseded[1].proof.ref, first)
  assert.notEqual(e.decision.proof.ref, first)
})

test('dos decide simultáneos con la misma prueba registran uno', async () => {
  const { s, id } = twoDisputes()
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  const hold = await holdLock(runFile(s, id, 'review.lock'))
  try {
    const both = Promise.all([cliAsync(s, ['review', 'decide', id, 'accept', 'F-1']), cliAsync(s, ['review', 'decide', id, 'accept', 'F-1'])])
    await pause(1000)
    hold.release()
    const results = await both
    assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results.map((r) => r.out)))
    assert.deepEqual(results.filter((r) => r.code !== 0).map((r) => r.out.code), ['decision_conflict'])
    assert.deepEqual(entryOf(s, id, 'F-1').superseded.map((d: { action: string }) => d.action), ['reject'])
  } finally {
    hold.release()
  }
})

test('dos decide sobre la misma disputa con pruebas distintas registran uno y el otro rechaza con decision_conflict', async () => {
  const { s, id } = twoDisputes()
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  const other = { ...s.env, CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sdd-ai-claude-')) }
  const q = cli(s, ['review', 'status', id]).out.questions.find((x: Question) => x.question.includes('disputa F-1'))
  writeClaudeTranscript(other.CLAUDE_CONFIG_DIR, other.CLAUDE_CODE_SESSION_ID, askPair(other.CLAUDE_CODE_SESSION_ID, 'tu-other', q, 'Aceptar el hallazgo'))
  const hold = await holdLock(runFile(s, id, 'review.lock'))
  try {
    const both = Promise.all([cliAsync(s, ['review', 'decide', id, 'accept', 'F-1']), cliAsync(s, ['review', 'decide', id, 'accept', 'F-1'], other)])
    await pause(1000)
    hold.release()
    const results = await both
    assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results.map((r) => r.out)))
    assert.deepEqual(results.filter((r) => r.code !== 0).map((r) => r.out.code), ['decision_conflict'])
  } finally {
    hold.release()
  }
})

test('dos decide sobre disputas distintas registran los dos', async () => {
  const { s, id } = twoDisputes()
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  answerReview(s, id, 'disputa F-2', 'Aceptar el hallazgo')
  const hold = await holdLock(runFile(s, id, 'review.lock'))
  try {
    const both = Promise.all([cliAsync(s, ['review', 'decide', id, 'accept', 'F-1']), cliAsync(s, ['review', 'decide', id, 'accept', 'F-2'])])
    await pause(1000)
    hold.release()
    const results = await both
    assert.deepEqual(results.map((r) => r.code), [0, 0], JSON.stringify(results.map((r) => r.out)))
    assert.deepEqual(states(s, id), [['F-1', 'aceptado'], ['F-2', 'aceptado']])
  } finally {
    hold.release()
  }
})
