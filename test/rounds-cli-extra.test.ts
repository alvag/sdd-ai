import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extraReuse } from '../src/cli.ts'
import { writeClaudeTranscript } from './helpers.ts'
import {
  BIN, lines, type Setup, setup, cli, runFile, runJson, grave, firstRound, startAndWait, waitRound, answerReview, SPEC,
  agrave, afirst, ARTIFACT_AT_CAP, artifactAtCap, diffAtCap, unresolved, twoDisputes, entryOf, runState, resolvedRound,
  aResolved, touchDiff, touchSpec, unavailableRound,
} from './rounds-cli-fixture.ts'

test('--extra exige prueba en una revisión de diff y en una de artefacto', () => {
  const cases: Array<[Setup, string, (s: Setup) => void]> = []
  const d = setup([firstRound([grave]), unresolved, unresolved, resolvedRound])
  cases.push([d, diffAtCap(d), touchDiff])
  const a = setup([...ARTIFACT_AT_CAP, aResolved])
  cases.push([a, artifactAtCap(a), touchSpec])
  for (const [s, id, touch] of cases) {
    touch(s)
    const before = runState(s, id)
    const r = cli(s, ['review', 'round', id, '--extra'])
    assert.equal(r.out.code, 'approval_missing', JSON.stringify(r.out))
    assert.ok(r.out.next.includes('¿Lanzamos la ronda 4'), r.out.next)
    assert.deepEqual(runState(s, id), before)
    answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
    const ok = cli(s, ['review', 'round', id, '--extra'])
    assert.equal(ok.code, 0, JSON.stringify(ok.out))
    waitRound(s, id)
    assert.equal(runJson(s, id, 'ledger.json').completed, 4)
    assert.equal(existsSync(runFile(s, id, 'review.lock')), false)
  }
})

test('review round --extra con el entorno de un worker rechaza con runner_required en diff y en artefacto', () => {
  const d = setup([firstRound([grave]), unresolved, unresolved])
  const a = setup(ARTIFACT_AT_CAP)
  for (const [s, id, touch] of [[d, diffAtCap(d), touchDiff], [a, artifactAtCap(a), touchSpec]] as Array<[Setup, string, (s: Setup) => void]>) {
    touch(s)
    answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
    const before = runState(s, id)
    const worker = { ...s.env, SDD_AI_WORKER: '1' }
    const extra = JSON.parse(spawnSync(BIN, ['review', 'round', id, '--extra'], { cwd: s.repo, env: worker, encoding: 'utf8' }).stdout)
    assert.equal(extra.code, 'runner_required', JSON.stringify(extra))
    const plain = JSON.parse(spawnSync(BIN, ['review', 'round', id], { cwd: s.repo, env: worker, encoding: 'utf8' }).stdout)
    assert.equal(plain.code, 'recursion')
    assert.deepEqual(runState(s, id), before)
  }
})

test('review decide y review round --extra aceptan --conductor con las dos señales', () => {
  const both = (s: Setup) => ({ ...s.env, CODEX_THREAD_ID: 't-1', CODEX_SESSION_ID: 'c-1', CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codex-')) })
  const run = (s: Setup, env: Record<string, string>, args: string[]) =>
    JSON.parse(spawnSync(BIN, args, { cwd: s.repo, env, encoding: 'utf8' }).stdout)

  const { s, id } = twoDisputes()
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  const env = both(s)
  const decide1 = ['review', 'decide', id, 'accept', 'F-1']
  assert.equal(run(s, env, decide1).code, 'conductor_unknown')
  assert.equal(run(s, env, [...decide1, '--conductor', 'codex']).code, 'approval_missing')
  assert.equal(run(s, env, [...decide1, '--conductor', 'claude']).state, 'done')
  assert.equal(entryOf(s, id, 'F-1').decision.proof.runner, 'claude')

  const c = setup([firstRound([grave]), unresolved, unresolved, resolvedRound])
  const cid = diffAtCap(c)
  touchDiff(c)
  answerReview(c, cid, 'ronda 4', 'Lanzar la ronda 4')
  const cenv = both(c)
  const round = ['review', 'round', cid, '--extra']
  assert.equal(run(c, cenv, round).code, 'conductor_unknown')
  assert.equal(run(c, cenv, [...round, '--conductor', 'codex']).code, 'approval_missing')
  assert.equal(run(c, cenv, [...round, '--conductor', 'claude']).round, 4)
  waitRound(c, cid)
})

test('el recibo de review round trae questions vacío y conserva sus campos, en diff y en artefacto', () => {
  const d = setup([firstRound([grave]), resolvedRound])
  const did = startAndWait(d)
  cli(d, ['review', 'decide', did, 'accept', 'F-1'])
  writeFileSync(join(d.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const r = cli(d, ['review', 'round', did])
  assert.deepEqual(Object.keys(r.out), ['id', 'round', 'launch', 'family', 'candidate_hash', 'identical', 'targets', 'changed', 'left_out', 'questions', 'next'])
  assert.deepEqual(r.out.questions, [])
  waitRound(d, did)

  const a = setup([afirst([agrave]), aResolved])
  writeFileSync(join(a.repo, '.git', 'info', 'exclude'), '.plans/\n')
  mkdirSync(join(a.repo, '.plans'))
  writeFileSync(join(a.repo, '.plans', 'spec.md'), SPEC)
  writeFileSync(join(a.repo, '.plans', 'pedido.md'), 'Quiero algo observable.\n')
  const started = cli(a, ['review', 'start', '--artifact', '.plans/spec.md', '--kind', 'spec', '--request', '.plans/pedido.md', '--author', 'codex'])
  waitRound(a, started.out.id)
  cli(a, ['review', 'decide', started.out.id, 'accept', 'F-1'])
  touchSpec(a)
  const ar = cli(a, ['review', 'round', started.out.id])
  assert.deepEqual(Object.keys(ar.out), ['id', 'round', 'launch', 'family', 'candidate_hash', 'identical', 'targets', 'changed', 'removed', 'questions', 'next'])
  assert.deepEqual(ar.out.questions, [])
  waitRound(a, started.out.id)
})

test('la prueba de la ronda n no lanza la n+1', () => {
  const s = setup([firstRound([grave]), unresolved, unresolved, unresolved])
  const id = diffAtCap(s)
  touchDiff(s)
  answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
  assert.equal(cli(s, ['review', 'round', id, '--extra']).code, 0)
  waitRound(s, id)
  assert.equal(runJson(s, id, 'ledger.json').completed, 4)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco, intento 5' }))
  const r = cli(s, ['review', 'round', id, '--extra'])
  assert.equal(r.out.code, 'approval_missing', JSON.stringify(r.out))
  assert.ok(r.out.next.includes('¿Lanzamos la ronda 5'))
  assert.deepEqual(runJson(s, id, 'extra-approvals.json').rounds.map((x: { round: number }) => x.round), [4])
})

test('relanzar la ronda extra reusa la prueba en la misma sesión y pide otra tras un Dejar, en otra sesión, sin prueba previa o con la fuente ilegible', () => {
  const s = setup([firstRound([grave]), unresolved, unresolved, unavailableRound, unavailableRound, unavailableRound])
  const id = diffAtCap(s)
  touchDiff(s)
  const dir = runFile(s, id, '')
  const entries = () => runJson(s, id, 'extra-approvals.json').rounds.map((x: { round: number; proof: { ref: string } }) => [x.round, x.proof.ref])
  answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
  assert.equal(cli(s, ['review', 'round', id, '--extra']).code, 0)
  assert.equal(waitRound(s, id).out.state, 'unavailable')
  const [first] = entries()
  // En la misma sesión, el relanzamiento reusa la prueba y no registra otra.
  assert.equal(extraReuse(s.env, undefined, dir, id, 4).reuse, true)
  assert.deepEqual(cli(s, ['review', 'round', id, '--extra']).out.launch, 2)
  waitRound(s, id)
  assert.deepEqual(entries(), [first])
  // Sin prueba registrada para la ronda, o en otra sesión, pide otra respuesta.
  assert.equal(extraReuse(s.env, undefined, dir, id, 5).reuse, false)
  const other = { ...s.env, CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sdd-ai-claude-')) }
  assert.match((extraReuse(other, undefined, dir, id, 4) as { reason: string }).reason, /otra sesión/)
  assert.equal(JSON.parse(spawnSync(BIN, ['review', 'round', id, '--extra'], { cwd: s.repo, env: other, encoding: 'utf8' }).stdout).code, 'approval_missing')
  // Un Dejar posterior la anula: el relanzamiento se rechaza hasta un Lanzar nuevo, que se agrega como otra entrada.
  answerReview(s, id, 'ronda 4', 'Dejar la revisión como está')
  assert.match((extraReuse(s.env, undefined, dir, id, 4) as { reason: string }).reason, /posterior/)
  assert.equal(cli(s, ['review', 'round', id, '--extra']).out.code, 'approval_contradicted')
  answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
  assert.equal(cli(s, ['review', 'round', id, '--extra']).out.launch, 3)
  waitRound(s, id)
  assert.equal(entries().length, 2)
  assert.deepEqual(entries().map((e: [number, string]) => e[0]), [4, 4])
  // Con la fuente ilegible después de la respuesta, no se puede descartar un Dejar.
  writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR, s.env.CLAUDE_CODE_SESSION_ID, ['{roto'])
  assert.match((extraReuse(s.env, undefined, dir, id, 4) as { reason: string }).reason, /no se pudo leer/)
  assert.equal(cli(s, ['review', 'round', id, '--extra']).out.code, 'approval_missing')
})

test('extra-approvals.json registra la ronda antes del lanzamiento', () => {
  const s = setup([firstRound([grave]), unresolved, unresolved, resolvedRound])
  const id = diffAtCap(s)
  touchDiff(s)
  answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
  const env = { ...s.env, FAKE_PROBE_FILE: runFile(s, id, 'extra-approvals.json') }
  const r = spawnSync(BIN, ['review', 'round', id, '--extra'], { cwd: s.repo, env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout)
  waitRound(s, id)
  // Una sola invocación del revisor, que ya encontró la prueba de la ronda 4 escrita.
  const seen = JSON.parse(readFileSync(`${s.env.FAKE_CALLS_FILE}.probe`, 'utf8'))
  assert.deepEqual(seen.rounds.map((x: { round: number }) => x.round), [4])
})

test('status y wait dicen si el relanzamiento de una ronda extra reusa la prueba o pide otra; con la fuente ilegible dicen que pide otra, y con dos señales dicen que no se puede determinar sin elegir la sesión, sin afirmar que haga falta otra respuesta y sin fallar', () => {
  const s = setup([firstRound([grave]), unresolved, unresolved, unavailableRound])
  const id = diffAtCap(s)
  touchDiff(s)
  answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
  assert.equal(cli(s, ['review', 'round', id, '--extra']).code, 0)
  waitRound(s, id)
  const nexts = (env: Record<string, string>) => [['review', 'status', id], ['wait', id, '--max', '5']].map((args) => {
    const r = spawnSync(BIN, args, { cwd: s.repo, env, encoding: 'utf8' })
    const out = JSON.parse(r.stdout)
    assert.equal(out.state, 'unavailable', r.stdout)
    return out.next as string
  })
  for (const next of nexts(s.env)) assert.match(next, /reusa la respuesta que el usuario ya dio para la ronda 4/)

  const both = { ...s.env, CODEX_THREAD_ID: 't-1', CODEX_SESSION_ID: 'c-1', CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codex-')) }
  for (const next of nexts(both)) {
    assert.match(next, /no se puede determinar si el relanzamiento reusa la respuesta del usuario sin elegir la sesión/)
    assert.doesNotMatch(next, /pide otra respuesta/)
    assert.match(next, /--conductor/)
  }

  answerReview(s, id, 'ronda 4', 'Dejar la revisión como está')
  for (const next of nexts(s.env)) assert.match(next, /pide otra respuesta del usuario \(una respuesta posterior/)
  answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
  writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR, s.env.CLAUDE_CODE_SESSION_ID, ['{roto'])
  for (const next of nexts(s.env)) assert.match(next, /pide otra respuesta del usuario \(no se pudo leer el archivo de la sesión/)
})
