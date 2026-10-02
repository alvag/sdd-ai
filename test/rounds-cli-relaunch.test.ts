import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decide } from '../src/review/ledger.ts'
import {
  lines, type Setup, git, setup, cli, runFile, runJson, states, grave, firstRound, nextRound, startAndWait, waitRound,
  cliAsync, pause, holdLock, usage, status, bulky, ROUND_REVIEWERS, unavailable, said, resolvedRound,
} from './rounds-cli-fixture.ts'

test('relanzar corre solo los trabajos que faltan', () => {
  const s = setup([said('base'), '__fail__', said('resilience'), said('reliability'), said('readability'), said('risk')])
  const id = startAndWait(s, ['--risk', 'high'])
  assert.deepEqual([runJson(s, id, 'status.json').state, existsSync(runFile(s, id, 'ledger.json'))], ['unavailable', false])
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.round, r.out.launch, r.out.kept], [1, 2, ['base-b1', 'resilience-b1', 'reliability-b1', 'readability-b1']])
  waitRound(s, id)
  const calls = readFileSync(s.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n')
  assert.equal(calls.length, 6)
  assert.deepEqual(runJson(s, id, 'argv-l2.json').jobs.map((j: { key: string }) => j.key), ['risk-b1'])
  assert.deepEqual(runJson(s, id, 'ledger.json').entries.map((e: { id: string; claim: string; reviewer: string }) => [e.id, e.claim, e.reviewer]), [
    ['F-1', 'lo dice base', 'base'], ['F-2', 'lo dice risk', 'risk'], ['F-3', 'lo dice resilience', 'resilience'],
    ['F-4', 'lo dice reliability', 'reliability'], ['F-5', 'lo dice readability', 'readability'],
  ])
})

test('la ronda 1 se relanza con review round', () => {
  const s = setup([unavailable, firstRound([grave])])
  const id = startAndWait(s)
  const v = status(s, id).out
  assert.equal(v.state, 'unavailable')
  assert.match(v.next, new RegExp(`la ronda 1 terminó en unavailable; pregunta al usuario si la relanza: \\./bin/sdd-ai review round ${id}$`))
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.round, r.out.launch], [0, 1, 2])
  waitRound(s, id)
  assert.deepEqual(states(s, id), [['F-1', 'abierto']])
  assert.deepEqual(runJson(s, id, 'rounds.json').rounds.map((x: { n: number; launch: number; state: string }) => [x.n, x.launch, x.state]),
    [[1, 1, 'unavailable'], [1, 2, 'done']])
})

test('al relanzar con otro candidato corren todos y lo admitido queda como historial', () => {
  const s = setup([said('base'), '__fail__', ...Array.from({ length: 8 }, () => said('otra vez'))])
  const id = startAndWait(s, ['--risk', 'high'])
  const before = runJson(s, id, 'rounds.json').rounds[0]
  assert.equal(before.jobs.filter((j: { admitted?: string }) => j.admitted).length, 4)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco, otra versión' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.kept, undefined)
  waitRound(s, id)
  assert.equal(readFileSync(s.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').length, 10)
  const entries = runJson(s, id, 'ledger.json').entries
  assert.deepEqual([entries.length, new Set(entries.map((e: { claim: string }) => e.claim)).size], [5, 1])
  assert.equal(runJson(s, id, 'candidate.json').hash, r.out.candidate_hash)
  assert.ok(existsSync(runFile(s, id, 'admitted-l1-base-b1.json')), 'lo admitido del candidato anterior queda como historial')
  assert.notEqual(before.candidate_hash, r.out.candidate_hash)
})

test('relanzar con una señal alta en el delta se frena', () => {
  const s = setup([unavailable])
  const id = startAndWait(s)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco', 8: 'spawn(x)' }))
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code, r.out.detail], [2, 'risk_high', 'process en a.txt: línea 8: spawn'])
  assert.match(r.out.next, /review start --base \S+ --author codex --risk high$/)
  assert.equal(existsSync(runFile(s, id, 'argv-l2.json')), false)
})

test('relanzar la ronda 1 de una revisión con lentes con una señal alta nueva corre base y lentes', () => {
  const none = firstRound([])
  const s = setup([none, '__fail__', none, none, none, none, none, none, none, none])
  const id = startAndWait(s, ['--risk', 'high'])
  assert.deepEqual([runJson(s, id, 'status.json').state, existsSync(runFile(s, id, 'ledger.json'))], ['unavailable', false])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco', 8: 'spawn(x)' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.id, r.out.round, r.out.launch, r.out.kept], [id, 1, 2, undefined])
  assert.deepEqual(r.out.reviewers, ROUND_REVIEWERS)
  waitRound(s, id)
  assert.deepEqual(runJson(s, id, 'argv-l2.json').jobs.map((j: { key: string }) => j.key), ROUND_REVIEWERS.map((k) => `${k}-b1`))
  assert.deepEqual(runJson(s, id, 'rounds.json').rounds.map((x: { n: number; launch: number; state: string }) => [x.n, x.launch, x.state]),
    [[1, 1, 'unavailable'], [1, 2, 'done']])
  assert.equal(existsSync(runFile(s, id, 'ledger.json')), true)
})

test('relanzar la ronda 1 con un archivo que no entra deja la corrida intacta', () => {
  const s = setup([unavailable])
  const id = startAndWait(s)
  const files = ['candidate.json', 'material.md', 'status.json', 'rounds.json']
  const before = files.map((f) => readFileSync(runFile(s, id, f), 'utf8'))
  const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
  writeFileSync(join(s.repo, 'grande.txt'), 'x'.repeat(100).concat('\n').repeat(2200))
  git(s.repo, 'add', '-N', 'grande.txt')
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'prompt_too_large', 'el archivo grande.txt no entra solo en el presupuesto'])
  assert.deepEqual(files.map((f) => readFileSync(runFile(s, id, f), 'utf8')), before)
  assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
  assert.equal(existsSync(runFile(s, id, 'argv-l2.json')), false)
})

test('relanzar vuelve a correr un trabajo cuyo encargo cambió', () => {
  const round1 = [firstRound([{ ...grave, location: 'x/uno.txt:5' }]), firstRound([{ ...grave, location: 'y/dos.txt:5' }])]
  const prepare = (answers: string[]) => {
    const s = setup([...round1, ...answers])
    mkdirSync(join(s.repo, 'x'))
    mkdirSync(join(s.repo, 'y'))
    writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky())
    writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky())
    git(s.repo, 'add', '-N', 'x/uno.txt', 'y/dos.txt')
    const id = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex']).out.id
    waitRound(s, id)
    return { s, id }
  }
  const callCount = (s: Setup) => readFileSync(s.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').length

  // Un aceptado que pasa a rechazado entre intentos.
  const a = prepare([nextRound([{ id: 'F-1', answer: 'resolved' }]), '__fail__',
    nextRound([{ id: 'F-1', answer: 'withdrawn' }]), nextRound([{ id: 'F-2', answer: 'withdrawn' }])])
  cli(a.s, ['review', 'decide', a.id, 'accept', 'F-1'])
  cli(a.s, ['review', 'decide', a.id, 'reject', 'F-2', '--reason', 'motivo uno'])
  writeFileSync(join(a.s.repo, 'x', 'uno.txt'), bulky('arreglado'))
  cli(a.s, ['review', 'round', a.id])
  waitRound(a.s, a.id)
  assert.equal(runJson(a.s, a.id, 'status.json').state, 'unavailable')
  cli(a.s, ['review', 'decide', a.id, 'reject', 'F-1', '--reason', 'al final no se corrige'])
  const ra = cli(a.s, ['review', 'round', a.id])
  assert.deepEqual([ra.out.round, ra.out.kept], [2, undefined])
  waitRound(a.s, a.id)
  assert.equal(callCount(a.s), 6)
  assert.deepEqual(states(a.s, a.id), [['F-1', 'cerrado'], ['F-2', 'cerrado']])

  // El mismo rechazo con otro motivo.
  const b = prepare(['__fail__', nextRound([{ id: 'F-2', answer: 'withdrawn' }]),
    nextRound([{ id: 'F-1', answer: 'resolved' }]), nextRound([{ id: 'F-2', answer: 'withdrawn' }])])
  cli(b.s, ['review', 'decide', b.id, 'accept', 'F-1'])
  cli(b.s, ['review', 'decide', b.id, 'reject', 'F-2', '--reason', 'motivo uno'])
  writeFileSync(join(b.s.repo, 'x', 'uno.txt'), bulky('arreglado'))
  cli(b.s, ['review', 'round', b.id])
  waitRound(b.s, b.id)
  cli(b.s, ['review', 'decide', b.id, 'reject', 'F-2', '--reason', 'otro motivo'])
  const rb = cli(b.s, ['review', 'round', b.id])
  assert.deepEqual([rb.out.round, rb.out.kept], [2, undefined])
  waitRound(b.s, b.id)
  assert.equal(callCount(b.s), 6)
  assert.ok(readFileSync(runFile(b.s, b.id, 'prompt-r2-l2-base-b2.md'), 'utf8').includes('otro motivo'))
  assert.deepEqual(states(b.s, b.id), [['F-1', 'resuelto'], ['F-2', 'cerrado']])
})

test('una ronda cancelada en la refutación se sigue con decide, sin relanzarla', () => {
  const s = setup([firstRound([{ ...grave, evidence: 'inferential' }]), '__hang__'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  const r = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex'])
  const id = r.out.id
  const until = Date.now() + 20_000
  while (runJson(s, id, 'status.json').job?.phase !== 'refutation') {
    assert.ok(Date.now() < until, 'la refutación no arrancó')
    spawnSync('sleep', ['0.1'])
  }
  assert.equal(cli(s, ['cancel', id]).code, 0)
  const w = waitRound(s, id)
  assert.deepEqual([w.out.state, w.out.completed], ['cancelled', 1])
  assert.match(w.out.next, /^decide cada hallazgo \(F-1\)/)
  assert.doesNotMatch(w.out.next, /relanza/)
  assert.equal(runJson(s, id, 'ledger.json').entries[0].refutation.reason, 'cancelled')
  usage(cli(s, ['review', 'round', id]), /sin decidir: F-1/)
})

test('una ronda que arranca mientras decide tiene el lock espera y relee el ledger', async () => {
  const s = setup([firstRound([grave]), resolvedRound])
  const id = startAndWait(s)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const hold = await holdLock(runFile(s, id, 'review.lock'))
  try {
    let finished = false
    const round = cliAsync(s, ['review', 'round', id]).then((r) => { finished = true; return r })
    await pause(1000)
    assert.equal(finished, false)
    // Con la revisión tomada, otro comando decide F-1; la ronda lo ve al releer.
    writeFileSync(runFile(s, id, 'ledger.json'), JSON.stringify(decide(runJson(s, id, 'ledger.json'), 'accept', ['F-1'])))
    hold.release()
    const r = await round
    assert.equal(r.code, 0, JSON.stringify(r.out))
    assert.equal(r.out.round, 2)
    waitRound(s, id)
    assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
  } finally {
    hold.release()
  }
})

test('dos review round para la misma ronda lanzan una y el otro rechaza con decision_conflict aunque la primera ya haya terminado', async () => {
  const s = setup([firstRound([grave]), resolvedRound, resolvedRound])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const hold = await holdLock(runFile(s, id, 'review.lock'))
  try {
    const both = Promise.all([cliAsync(s, ['review', 'round', id]), cliAsync(s, ['review', 'round', id])])
    await pause(1000)
    hold.release()
    const results = await both
    assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results.map((r) => r.out)))
    assert.deepEqual(results.filter((r) => r.code !== 0).map((r) => r.out.code), ['decision_conflict'])
    waitRound(s, id)
    // Terminada la primera, el segundo intento tampoco lanza la ronda 3 en su lugar: ya no hay nada que hacer.
    assert.equal(runJson(s, id, 'ledger.json').completed, 2)
  } finally {
    hold.release()
  }
})
