import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  lines, git, setup, cli, runFile, runJson, grave, warning, firstRound, nextRound, startAndWait, waitRound,
  answerReview, diffAtCap, unresolved, twoDisputes, status, touchDiff, unavailableRound,
} from './rounds-cli-fixture.ts'

test('la vista trae la ronda, el ledger, los pendientes y el paso siguiente: decidir', () => {
  const s = setup([firstRound([grave, warning])])
  const id = startAndWait(s)
  const v = status(s, id).out
  assert.deepEqual([v.state, v.round, v.completed], ['done', 1, 1])
  assert.deepEqual(v.ledger.map((e: { id: string; state: string; claim: string }) => [e.id, e.state, e.claim]),
    [['F-1', 'abierto', 'la línea 5 no valida'], ['F-2', 'abierto', 'sobra el cambio de nombre']])
  assert.deepEqual([v.pending, v.disputes, v.refuted, v.inconclusive], [['F-1', 'F-2'], [], [], []])
  assert.deepEqual([v.risk, v.reviewers, v.batches], [{ level: 'normal', reasons: [], forced: false }, ['base'], undefined])
  assert.deepEqual(v.axes, { scope: 'ok', spec: 'ok', quality: 'fail' })
  assert.deepEqual([v.stale, v.tool_events, v.reviewer.family, v.reviewer.model_effective], [false, [], 'claude', 'claude-falso'])
  assert.match(v.next, new RegExp(`\\(F-1, F-2\\): \\./bin/sdd-ai review decide ${id} accept`))
})

test('la vista con todo decidido propone corregir y lanzar la ronda, aunque el diff ya cambió', () => {
  const s = setup([firstRound([grave])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const v = status(s, id).out
  assert.equal(v.stale, true)
  assert.deepEqual(v.pending, [])
  assert.match(v.next, new RegExp(`corrige los aceptados \\(F-1\\) y lanza \\./bin/sdd-ai review round ${id}`))
})

test('con solo rechazados, la vista propone lanzar la ronda para que el revisor responda', () => {
  const s = setup([firstRound([grave])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'no'])
  assert.match(status(s, id).out.next, new RegExp(`review round ${id}.*responda`))
})

test('una disputa se le pregunta al usuario; el conductor no la decide', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'maintained', evidence: 'a.txt:5' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional'])
  cli(s, ['review', 'round', id])
  waitRound(s, id)
  const v = status(s, id).out
  assert.deepEqual([v.round, v.completed, v.pending, v.disputes], [2, 2, [], ['F-1']])
  assert.match(v.next, /pregunta al usuario por cada disputa \(F-1\)/)
  const e = v.ledger[0]
  assert.deepEqual([e.decision.reason, e.responses[0].answer, e.responses[0].evidence], ['es intencional', 'maintained', 'a.txt:5'])
})

test('después de la ronda 3 con vigentes, la vista propone el checkpoint con los dos caminos', () => {
  const unresolved = nextRound([{ id: 'F-1', answer: 'unresolved', evidence: 'a.txt:5' }])
  const s = setup([firstRound([grave]), unresolved, unresolved])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  for (const n of [2, 3]) {
    writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: `línea cinco, intento ${n}` }))
    cli(s, ['review', 'round', id])
    waitRound(s, id)
  }
  const v = status(s, id).out
  assert.equal(v.completed, 3)
  assert.match(v.next, /pregunta al usuario/)
  assert.match(v.next, new RegExp(`review round ${id} --extra`))
  assert.match(v.next, /dejar la revisión como está/)
})

test('una ronda que no terminó propone relanzarla; una ronda en curso, esperar', () => {
  const s = setup([firstRound([grave]), '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"responses":[],"findings":[]}'])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  cli(s, ['review', 'round', id])
  const w = waitRound(s, id)
  assert.deepEqual([w.code, w.out.state, w.out.round, w.out.completed, w.out.reason], [1, 'unavailable', 2, 1, 'jobs_incomplete'])
  assert.match(w.out.next, new RegExp(`review round ${id}`))
  const st = runJson(s, id, 'status.json')
  writeFileSync(runFile(s, id, 'status.json'), JSON.stringify({ ...st, state: 'running' }))
  assert.equal(status(s, id).out.next, `./bin/sdd-ai wait ${id}`)
})

test('refutados e inconclusos se ven aparte; un refutado no hace fallar el eje', () => {
  const inferential = { ...grave, evidence: 'inferential', claim: 'puede fallar con una lista vacía' }
  const s = setup([
    firstRound([inferential, { ...inferential, axis: 'scope' }]),
    `{"candidate_hash":"$HASH","results":[{"id":"F-1","result":"refuted","evidence":"a.txt:5"},{"id":"F-2","result":"inconclusive","evidence":"a.txt:5"}]}`,
  ])
  const id = startAndWait(s)
  const v = status(s, id).out
  assert.deepEqual([v.refuted, v.inconclusive, v.pending], [['F-1'], [{ id: 'F-2', reason: 'refuter_inconclusive' }], ['F-2']])
  assert.deepEqual(v.axes, { scope: 'fail', spec: 'ok', quality: 'ok' })
})

test('sin nada vigente la revisión queda vigente, y si el diff cambia se avisa como en 2b', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  cli(s, ['review', 'round', id])
  waitRound(s, id)
  const v = status(s, id).out
  assert.deepEqual([v.stale, v.axes], [false, { scope: 'ok', spec: 'ok', quality: 'ok' }])
  assert.equal(v.candidate_hash, runJson(s, id, 'candidate-r2.json').hash)
  assert.match(v.next, /vigente/)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'otra cosa' }))
  const changed = status(s, id).out
  assert.equal(changed.stale, true)
  assert.match(changed.next, /review start --base/)
})

test('una ronda reanudada trae resume con la sesión, el inicio y el resultado', () => {
  const s = setup(['__hang__', firstRound([])])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  const r = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex', '--deadline', '1'])
  const w = waitRound(s, r.out.id)
  assert.equal(w.out.state, 'done')
  assert.deepEqual([typeof w.out.resume.session_id, typeof w.out.resume.started_at, w.out.resume.outcome], ['string', 'string', 'done'])
})

test('una ronda con --head que no terminó propone relanzarla con el mismo ref', () => {
  const s = setup([firstRound([grave]), '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"responses":[],"findings":[]}'])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  git(s.repo, 'checkout', '-qb', 'arreglo')
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  git(s.repo, 'commit', '-qam', 'arreglo')
  cli(s, ['review', 'round', id, '--head', 'arreglo'])
  const w = waitRound(s, id)
  assert.equal(w.out.state, 'unavailable')
  assert.match(w.out.next, new RegExp(`\\./bin/sdd-ai review round ${id} --head arreglo$`))
})

test('ref_moved mira el ref de la última ronda completada, no el de la ronda 1', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'unresolved', evidence: 'a.txt:5' }])])
  git(s.repo, 'checkout', '-qb', 'uno')
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  git(s.repo, 'commit', '-qam', 'uno')
  const r = cli(s, ['review', 'start', '--base', s.base, '--head', 'uno', '--author', 'codex'])
  waitRound(s, r.out.id)
  const id = r.out.id
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  git(s.repo, 'checkout', '-qb', 'dos')
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco, otra vez' }))
  git(s.repo, 'commit', '-qam', 'dos')
  cli(s, ['review', 'round', id, '--head', 'dos'])
  waitRound(s, id)
  assert.deepEqual([status(s, id).out.stale, status(s, id).out.ref_moved], [false, false])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'tercera' }))
  git(s.repo, 'commit', '-qam', 'tres')
  assert.deepEqual([status(s, id).out.stale, status(s, id).out.ref_moved], [false, true])
})

test('los tool_events de la vista son los de la última ronda completada', () => {
  const s = setup([firstRound([grave]), '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"responses":[],"findings":[]}'])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  cli(s, ['review', 'round', id])
  waitRound(s, id)
  const rounds = runJson(s, id, 'rounds.json')
  rounds.rounds[1].tool_events = ['Bash']
  writeFileSync(runFile(s, id, 'rounds.json'), JSON.stringify(rounds))
  assert.deepEqual(status(s, id).out.tool_events, [])
})

test('todo next que reinicia conserva --risk high', () => {
  const s = setup(Array.from({ length: 5 }, () => firstRound([])))
  const id = startAndWait(s, ['--risk', 'high'])
  assert.equal(runJson(s, id, 'request.json').risk.forced, true)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'otra cosa' }))
  const v = status(s, id).out
  assert.equal(v.stale, true)
  assert.match(v.next, /review start --base \S+ --author codex --risk high$/)
})

test('los next de disputas, del tope, del relanzamiento y de los rechazos nombran la pregunta y cómo hacerla en cada runner', () => {
  const howTo = (next: string) => {
    assert.match(next, /AskUserQuestion/, next)
    assert.match(next, /Codex/, next)
  }
  const { s, id } = twoDisputes()
  const disputes = cli(s, ['review', 'status', id]).out.next
  assert.match(disputes, /pregunta al usuario por cada disputa \(F-1, F-2\)/)
  howTo(disputes)
  const rejected = cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  assert.equal(rejected.out.code, 'approval_missing')
  assert.ok(rejected.out.next.includes('¿Qué hacemos con la disputa F-1'), rejected.out.next)
  howTo(rejected.out.next)

  const c = setup([firstRound([grave]), unresolved, unresolved, unavailableRound])
  const cid = diffAtCap(c)
  const cap = cli(c, ['review', 'status', cid]).out.next
  assert.match(cap, /--extra/)
  howTo(cap)
  touchDiff(c)
  const capError = cli(c, ['review', 'round', cid])
  assert.equal(capError.out.code, 'round_cap')
  assert.ok(capError.out.next.includes('¿Lanzamos la ronda 4'), capError.out.next)
  howTo(capError.out.next)
  answerReview(c, cid, 'ronda 4', 'Lanzar la ronda 4')
  assert.equal(cli(c, ['review', 'round', cid, '--extra']).code, 0)
  waitRound(c, cid)
  answerReview(c, cid, 'ronda 4', 'Dejar la revisión como está')
  const relaunch = cli(c, ['review', 'status', cid]).out.next
  assert.match(relaunch, new RegExp(`review round ${cid} --extra`))
  assert.match(relaunch, /pide otra respuesta/)
  howTo(relaunch)
})
