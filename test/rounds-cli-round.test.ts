import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REFUTER_SYSTEM_PROMPT } from '../src/workers/claude.ts'
import {
  lines, git, setup, cli, runFile, runJson, states, grave, warning, firstRound, nextRound, startAndWait, waitRound,
  answerReview, unresolved, usage, status,
} from './rounds-cli-fixture.ts'

test('dos rondas: un aceptado se corrige y queda resuelto; un rechazado se retira', () => {
  const s = setup([firstRound([grave, warning]), nextRound([{ id: 'F-1', answer: 'resolved' }, { id: 'F-2', answer: 'withdrawn' }])])
  const id = startAndWait(s)
  assert.deepEqual(states(s, id), [['F-1', 'abierto'], ['F-2', 'abierto']])
  const e1 = runJson(s, id, 'ledger.json').entries[0]
  assert.deepEqual([e1.axis, e1.severity, e1.location, e1.claim, e1.causality, e1.evidence, e1.round],
    ['quality', 'CRITICAL', 'a.txt:5', 'la línea 5 no valida', 'introduced', 'deterministic', 1])

  const a = cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  assert.equal(a.code, 0, JSON.stringify(a.out))
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-2', '--reason', 'el nombre lo pidió el plan']).code, 0)
  assert.deepEqual(states(s, id), [['F-1', 'aceptado'], ['F-2', 'rechazado']])

  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.round, r.out.next], [2, `./bin/sdd-ai wait ${id}`])
  waitRound(s, id)
  assert.deepEqual(states(s, id), [['F-1', 'resuelto'], ['F-2', 'cerrado']])
  assert.equal(runJson(s, id, 'ledger.json').completed, 2)
  const prompt = readFileSync(runFile(s, id, 'prompt-r2-l1-base-b1.md'), 'utf8')
  assert.match(prompt, /ronda 2 de 3/)
  assert.ok(prompt.includes('el nombre lo pidió el plan'))
  assert.match(prompt, /a\.txt: 5/)
  const plan = runJson(s, id, 'round-r2.json')
  assert.deepEqual([plan.n, plan.identical, plan.changed], [2, false, { 'a.txt': [[5, 5]] }])
  assert.equal(plan.prev_hash, runJson(s, id, 'candidate.json').hash)
})

test('una línea que la corrección devolvió a la base no figura en CAMBIOS de la ronda siguiente', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'cinco cambiada', 8: 'ocho cambiada' }))
  const started = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex'])
  assert.equal(started.code, 0, JSON.stringify(started.out))
  const id = started.out.id
  waitRound(s, id)
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 8: 'ocho corregida' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  waitRound(s, id)
  const prompt = readFileSync(runFile(s, id, 'prompt-r2-l1-base-b1.md'), 'utf8')
  const changes = /<<<CAMBIOS [^\n]+>>>\n([\s\S]*?)<<<FIN CAMBIOS /.exec(prompt)?.[1]
  assert.ok(changes, prompt)
  assert.match(changes, /a\.txt: 8/)
  assert.doesNotMatch(changes, /a\.txt: 5/)
  assert.deepEqual(runJson(s, id, 'round-r2.json').changed, { 'a.txt': [[8, 8]] })
})

test('la ronda siguiente usa el revisor de la ronda 1 en una sesión nueva, y un refutador del rol refute', () => {
  const inferential = { ...grave, evidence: 'inferential' }
  const s = setup([
    firstRound([inferential]), `{"candidate_hash":"$HASH","results":[{"id":"F-1","result":"corroborated","evidence":"a.txt:5"}]}`,
    nextRound([{ id: 'F-1', answer: 'resolved' }]),
  ])
  const id = startAndWait(s)
  const first = runJson(s, id, 'argv-l1.json')
  assert.deepEqual([first.refuter_resolution.model, first.refuter_resolution.effort], ['sonnet', 'medium'])
  assert.deepEqual([first.reviewer_resolution.model, first.reviewer_resolution.effort], ['opus', 'high'])
  assert.ok(existsSync(runFile(s, id, 'material.md')))
  assert.ok(existsSync(runFile(s, id, 'blobs')))
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  const second = runJson(s, id, 'argv-r2-l1.json')
  assert.deepEqual([second.round, second.tag, second.extra, second.launch_n], [2, '-r2', false, 1])
  assert.equal(second.family, 'claude')
  assert.deepEqual(second.reviewer_resolution, first.reviewer_resolution)
  assert.equal(second.jobs[0].prompt, runFile(s, id, 'prompt-r2-l1-base-b1.md'))
  assert.equal(second.deadline_sec, first.deadline_sec)
  const flag = (args: string[], f: string) => args[args.indexOf(f) + 1]
  const [review1, refute1, review2] = readFileSync(s.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
  assert.deepEqual([flag(refute1, '--model'), flag(refute1, '--effort'), flag(refute1, '--system-prompt')], ['sonnet', 'medium', REFUTER_SYSTEM_PROMPT])
  assert.deepEqual([flag(review2, '--model'), flag(review2, '--effort')], ['opus', 'high'])
  assert.notEqual(flag(review2, '--session-id'), flag(review1, '--session-id'))
  const cwds = readFileSync(`${s.env.FAKE_CALLS_FILE}.cwd`, 'utf8').trim().split('\n')
  assert.equal(new Set(cwds).size, 3, 'cada trabajo corre en su propio temporal')
})

test('decide: errores de uso que no cambian nada', () => {
  const s = setup([firstRound([grave, warning])])
  const id = startAndWait(s)
  const before = readFileSync(runFile(s, id, 'ledger.json'), 'utf8')
  usage(cli(s, ['review', 'decide', id, 'reject', 'F-1']), /motivo/)
  usage(cli(s, ['review', 'decide', id, 'accept', 'F-9']), /F-9/)
  usage(cli(s, ['review', 'decide', id, 'accept', 'F-1', 'F-9']), /F-9/)
  usage(cli(s, ['review', 'decide', id, 'approve', 'F-1']), /approve/)
  usage(cli(s, ['review', 'decide', id, 'accept']), /ID/)
  assert.equal(readFileSync(runFile(s, id, 'ledger.json'), 'utf8'), before)
  const status = runJson(s, id, 'status.json')
  writeFileSync(runFile(s, id, 'status.json'), JSON.stringify({ ...status, state: 'running' }))
  usage(cli(s, ['review', 'decide', id, 'accept', 'F-1']), /en curso/)
  assert.equal(readFileSync(runFile(s, id, 'ledger.json'), 'utf8'), before)
})

test('decide sobre una revisión sin ledger es un error de uso', () => {
  const s = setup(['{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"findings":[]}'])
  const id = startAndWait(s)
  usage(cli(s, ['review', 'decide', id, 'accept', 'F-1']), /hallazgos admitidos/)
})

test('round no lanza con un hallazgo sin decidir, con aceptados sobre el mismo candidato, ni sin nada que hacer', () => {
  const s = setup([firstRound([grave, warning])])
  const id = startAndWait(s)
  const open = cli(s, ['review', 'round', id])
  usage(open, /F-1, F-2/)
  assert.match(open.out.next, /review decide/)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  cli(s, ['review', 'decide', id, 'reject', 'F-2', '--reason', 'no aplica'])
  const same = cli(s, ['review', 'round', id])
  usage(same, /idéntico/)
  assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
  assert.equal(runJson(s, id, 'status.json').round, 1)
})

test('round sin nada que verificar ni responder no lanza', () => {
  const s = setup([firstRound([])])
  const id = startAndWait(s)
  usage(cli(s, ['review', 'round', id]), /nada que verificar ni responder/)
})

test('con solo rechazados, la ronda corre sobre el mismo candidato y no admite regresiones', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'maintained', evidence: 'a.txt:5' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional'])
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  waitRound(s, id)
  const plan = runJson(s, id, 'round-r2.json')
  assert.deepEqual([plan.identical, plan.changed, plan.targets], [true, {}, [{ id: 'F-1', kind: 'respond' }]])
  assert.match(readFileSync(runFile(s, id, 'prompt-r2-l1-base-b1.md'), 'utf8'), /no se admite ningún hallazgo nuevo/)
  assert.deepEqual(states(s, id), [['F-1', 'en-disputa']])
  answerReview(s, id, 'disputa F-1', 'Mantener el rechazo')
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'es intencional']).code, 0)
  assert.deepEqual(states(s, id), [['F-1', 'cerrado']])
})

test('con --head la ronda congela el ref nuevo con la misma base y el mismo contexto', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  writeFileSync(join(s.repo, 'spec.md'), '# spec\n')
  git(s.repo, 'checkout', '-qb', 'tema')
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  git(s.repo, 'commit', '-qam', 'uno')
  const r = cli(s, ['review', 'start', '--base', s.base, '--head', 'tema', '--context', 'spec.md', '--author', 'codex'])
  waitRound(s, r.out.id)
  const id = r.out.id
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  git(s.repo, 'commit', '-qam', 'dos')
  assert.equal(cli(s, ['review', 'round', id, '--head', 'tema']).code, 0)
  waitRound(s, id)
  const c1 = runJson(s, id, 'candidate.json')
  const c2 = runJson(s, id, 'candidate-r2.json')
  assert.equal(c2.base_sha, c1.base_sha)
  assert.equal(c2.head_sha, git(s.repo, 'rev-parse', 'tema'))
  assert.deepEqual(c2.context, c1.context)
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
})

test('tope: después de la ronda 3 hace falta --extra, que concede una sola ronda; antes es un error de uso', () => {
  const unresolved = nextRound([{ id: 'F-1', answer: 'unresolved', evidence: 'a.txt:5' }])
  const s = setup([firstRound([grave]), unresolved, unresolved, nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  usage(cli(s, ['review', 'round', id, '--extra']), /--extra/)
  for (const n of [2, 3]) {
    writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: `línea cinco, intento ${n}` }))
    assert.equal(cli(s, ['review', 'round', id]).code, 0)
    waitRound(s, id)
  }
  assert.equal(runJson(s, id, 'ledger.json').completed, 3)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco, intento 4' }))
  const capped = cli(s, ['review', 'round', id])
  usage(capped, /3 rondas/)
  assert.match(capped.out.next, /--extra/)
  assert.equal(existsSync(runFile(s, id, 'argv-r4-l1.json')), false)
  answerReview(s, id, 'ronda 4', 'Lanzar la ronda 4')
  const extra = cli(s, ['review', 'round', id, '--extra'])
  assert.equal(extra.code, 0, JSON.stringify(extra.out))
  waitRound(s, id)
  assert.equal(runJson(s, id, 'argv-r4-l1.json').extra, true)
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
  assert.equal(runJson(s, id, 'ledger.json').completed, 4)
})

test('review round con un archivo que no entra solo no lanza y deja la corrida como estaba', () => {
  const s = setup([firstRound([grave])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'grande.txt'), 'x'.repeat(100).concat('\n').repeat(2200))
  git(s.repo, 'add', '-N', 'grande.txt')
  const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
  const before = ['ledger.json', 'status.json'].map((f) => readFileSync(runFile(s, id, f), 'utf8'))
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'prompt_too_large', 'el archivo grande.txt no entra solo en el presupuesto'])
  assert.match(r.out.detail, /^grande\.txt: su sección numerada mide \d+ bytes; el prompt con ese archivo solo mide \d+ > 204800$/)
  assert.match(r.out.next, /review no puede revisar grande\.txt: pregunta al usuario si lo saca del cambio o lo revisa por fuera de review/)
  assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
  assert.deepEqual(['ledger.json', 'status.json'].map((f) => readFileSync(runFile(s, id, f), 'utf8')), before)
  for (const f of ['argv-r2-l1.json', 'prompt-r2-l1-base-b1.md', 'candidate-r2.json', 'round-r2.json']) assert.equal(existsSync(runFile(s, id, f)), false, f)
})

test('una ronda unavailable no cambia el ledger ni cuenta, y se relanza con el mismo número', () => {
  const s = setup([
    firstRound([grave]),
    '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"responses":[],"findings":[]}',
    nextRound([{ id: 'F-1', answer: 'resolved' }]),
  ])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  cli(s, ['review', 'round', id])
  const w = waitRound(s, id)
  assert.deepEqual([w.out.state, runJson(s, id, 'status.json').round], ['unavailable', 2])
  assert.equal(runJson(s, id, 'ledger.json').completed, 1)
  assert.deepEqual(states(s, id), [['F-1', 'aceptado']])
  const again = cli(s, ['review', 'round', id])
  assert.equal(again.out.round, 2)
  waitRound(s, id)
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
  assert.deepEqual(runJson(s, id, 'rounds.json').rounds.map((r: { n: number; state: string }) => [r.n, r.state]),
    [[1, 'done'], [2, 'unavailable'], [2, 'done']])
})

test('una ronda cuyo supervisor no arrancó se ve en launch_failed y se relanza con el mismo número', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const st = runJson(s, id, 'status.json')
  writeFileSync(runFile(s, id, 'status.json'), JSON.stringify({
    ...st, state: 'launch_failed', reason: 'supervisor_not_started', detail: 'el sistema no lanzó el proceso supervisor', round: 2, launch: 1,
  }))
  const view = cli(s, ['review', 'status', id])
  assert.deepEqual([view.out.state, view.out.reason], ['launch_failed', 'supervisor_not_started'])
  assert.match(view.out.next, new RegExp(`review round ${id}`))
  const again = cli(s, ['review', 'round', id])
  assert.equal(again.out.round, 2)
  assert.equal(waitRound(s, id).out.state, 'done')
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
})

test('round borra un pedido de cancelación viejo y reinicia el estado', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s)
  writeFileSync(runFile(s, id, 'cancel.request'), 'viejo')
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  const status = runJson(s, id, 'status.json')
  writeFileSync(runFile(s, id, 'status.json'), JSON.stringify({ ...status, detail: 'de la ronda anterior' }))
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  cli(s, ['review', 'round', id])
  const w = waitRound(s, id)
  assert.equal(w.out.state, 'done')
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
  assert.equal(runJson(s, id, 'status.json').detail, undefined)
})
