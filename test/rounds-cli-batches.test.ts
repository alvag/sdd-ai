import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  lines, git, setup, cli, runFile, runJson, states, grave, warning, firstRound, nextRound, startAndWait, waitRound,
  status, prompts, block, bulky, ROUND_REVIEWERS, lensPrompts, checkBatchedLenses, checkEmptyLensLots, said, waitJob,
} from './rounds-cli-fixture.ts'

test('la ronda N entera corre un solo revisor dirigido', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.out.batches, undefined)
  waitRound(s, id)
  assert.deepEqual(prompts(s, id, 'prompt-r2-'), ['prompt-r2-l1-base-b1.md'])
  assert.deepEqual(runJson(s, id, 'argv-r2-l1.json').batches, [['a.txt']])
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
})

test('la ronda N en lotes lleva cada pendiente al lote de su archivo', () => {
  const s = setup([
    firstRound([{ ...grave, location: 'x/uno.txt:5' }]), firstRound([{ ...grave, location: 'y/dos.txt:5' }]),
    nextRound([{ id: 'F-1', answer: 'resolved' }]), nextRound([{ id: 'F-2', answer: 'resolved' }]),
  ])
  mkdirSync(join(s.repo, 'x'))
  mkdirSync(join(s.repo, 'y'))
  writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky())
  writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky())
  git(s.repo, 'add', '-N', 'x/uno.txt', 'y/dos.txt')
  const r = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex'])
  assert.deepEqual(r.out.batches, [{ n: 1, paths: ['x/uno.txt'] }, { n: 2, paths: ['y/dos.txt'] }])
  waitRound(s, r.out.id)
  const id = r.out.id
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1', 'F-2']).code, 0)
  writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky('arreglado uno'))
  writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky('arreglado dos'))
  const round = cli(s, ['review', 'round', id])
  assert.equal(round.code, 0, JSON.stringify(round.out))
  waitRound(s, id)
  assert.deepEqual(prompts(s, id, 'prompt-r2-'), ['prompt-r2-l1-base-b1.md', 'prompt-r2-l1-base-b2.md'])
  const verify = (key: string) => block(readFileSync(runFile(s, id, `prompt-r2-l1-${key}.md`), 'utf8'), 'VERIFICAR')
  assert.ok(verify('base-b1').includes('"F-1"') && !verify('base-b1').includes('"F-2"'))
  assert.ok(verify('base-b2').includes('"F-2"') && !verify('base-b2').includes('"F-1"'))
  assert.deepEqual(states(s, id), [['F-1', 'resuelto'], ['F-2', 'resuelto']])
})

test('ronda N: un bloque de pendientes que no entra da prompt_too_large', () => {
  const huge = 'x'.repeat(210_000)
  const s = setup([firstRound([{ ...warning, claim: huge }])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'prompt_too_large', 'el bloque de pendientes de a.txt no entra en el presupuesto'])

  const c = setup([firstRound([{ ...warning, location: 'spec.md:1', claim: huge }])])
  writeFileSync(join(c.repo, 'spec.md'), '# spec\n')
  const cid = startAndWait(c, ['--context', 'spec.md'])
  cli(c, ['review', 'decide', cid, 'reject', 'F-1', '--reason', 'no aplica'])
  const orphan = cli(c, ['review', 'round', cid])
  assert.deepEqual([orphan.code, orphan.out.code, orphan.out.message], [2, 'prompt_too_large', 'el bloque de pendientes sin archivo no entra en el presupuesto'])
  assert.doesNotMatch(orphan.out.message, /contexto/)
  assert.equal(existsSync(runFile(c, cid, 'argv-r2-l1.json')), false)
})

test('sin lentes un delta con señal alta frena la ronda y propone reiniciar con lentes', () => {
  const s = setup([firstRound([grave])])
  const id = startAndWait(s)
  const ids = runJson(s, id, 'ledger.json').entries.map((e: { id: string }) => e.id)
  assert.equal(cli(s, ['review', 'decide', id, 'accept', ...ids]).code, 0)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada', 7: 'exec(cmd)' }))
  const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'risk_high', 'la corrección introduce riesgo alto'])
  assert.equal(r.out.detail, 'process en a.txt: línea 7: exec')
  assert.match(r.out.next, /^pregunta al usuario si reinicia la revisión con lentes: \.\/bin\/sdd-ai review start --base \S+ --author codex --risk high$/)
  assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
  assert.deepEqual(prompts(s, id, 'prompt-r2-'), [])
  assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
})

test('una revisión con lentes corre la base y las lentes sobre un delta con señal alta', () => {
  const inChanges = { ...warning, location: 'a.txt:7', claim: 'el exec no valida su entrada' }
  const outside = { ...warning, location: 'a.txt:2', claim: 'una línea que no cambió' }
  const s = setup([
    firstRound([grave]), firstRound([{ ...warning, claim: 'lo dice risk' }]), firstRound([]), firstRound([]), firstRound([]),
    nextRound([{ id: 'F-1', answer: 'resolved' }, { id: 'F-2', answer: 'withdrawn' }]),
    nextRound([], [inChanges]), nextRound([]), nextRound([]), nextRound([], [outside]), nextRound([]),
  ])
  const id = startAndWait(s, ['--risk', 'high'])
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-2', '--reason', 'es intencional']).code, 0)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada', 7: 'exec(cmd)' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual(r.out.reviewers, ROUND_REVIEWERS)
  assert.deepEqual(r.out.delta_risk.reasons, [{ signal: 'process', path: 'a.txt', detail: 'línea 7: exec' }])
  waitRound(s, id)

  const files = prompts(s, id, 'prompt-r2-').filter((f) => !f.endsWith('-fix.md'))
  assert.deepEqual(files, lensPrompts(ROUND_REVIEWERS))
  for (const lens of ROUND_REVIEWERS.slice(1)) {
    const text = readFileSync(runFile(s, id, `prompt-r2-l1-${lens}-b1.md`), 'utf8')
    assert.match(block(text, 'CAMBIOS'), /a\.txt: 5, 7/)
    assert.equal(text.includes('<<<VERIFICAR sha256:') || text.includes('<<<RESPONDER sha256:'), false)
  }
  assert.ok(block(readFileSync(runFile(s, id, 'prompt-r2-l1-base-b1.md'), 'utf8'), 'VERIFICAR').includes('"F-1"'))

  // Una lente que cita fuera de CAMBIOS no se admite: su corrección trae el motivo.
  assert.ok(existsSync(runFile(s, id, 'prompt-r2-l1-readability-b1-fix.md')))
  const entries = runJson(s, id, 'ledger.json').entries
  assert.deepEqual(entries.map((e: { id: string }) => e.id), ['F-1', 'F-2', 'F-3'])
  assert.deepEqual(entries.map((e: { claim: string }) => e.claim).includes('una línea que no cambió'), false)
  assert.deepEqual([entries[2].reviewer, entries[2].batch, entries[2].claim], ['risk', 1, 'el exec no valida su entrada'])
  assert.deepEqual(entries.slice(0, 2).map((e: { responses: unknown[] }) => e.responses.length), [1, 1])
  checkBatchedLenses()
  checkEmptyLensLots()
})

test('con lentes un delta sin señal nueva corre solo la base', () => {
  const s = setup([firstRound([grave]), firstRound([]), firstRound([]), firstRound([]), firstRound([]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s, ['--risk', 'high'])
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.reviewers, undefined)
  assert.equal(r.out.delta_risk, undefined)
  waitRound(s, id)
  assert.deepEqual(prompts(s, id, 'prompt-r2-'), ['prompt-r2-l1-base-b1.md'])
})

test('una ronda cuyo delta agrega mkdirSync a un import con execFileSync se lanza solo con la base', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 1: "import { execFileSync } from 'node:child_process'" }))
  git(s.repo, 'commit', '-qam', 'import')
  const base = git(s.repo, 'rev-parse', 'HEAD')
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 1: "import { execFileSync } from 'node:child_process'", 5: 'línea cinco' }))
  const started = cli(s, ['review', 'start', '--base', base, '--author', 'codex'])
  assert.equal(started.code, 0, JSON.stringify(started.out))
  const id = started.out.id
  waitRound(s, id)
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 1: "import { execFileSync, mkdirSync } from 'node:child_process'", 5: 'línea cinco validada' }))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.reviewers, undefined)
  assert.equal(r.out.delta_risk, undefined)
  waitRound(s, id)
  assert.deepEqual(prompts(s, id, 'prompt-r2-'), ['prompt-r2-l1-base-b1.md'])
})

test('status, wait y el recibo muestran la procedencia', () => {
  const s = setup([said('base'), said('risk'), said('resilience'), said('reliability'), said('readability')])
  const id = startAndWait(s, ['--risk', 'high'])
  const expected = [['F-1', 'base', 1], ['F-2', 'risk', 1], ['F-3', 'resilience', 1], ['F-4', 'reliability', 1], ['F-5', 'readability', 1]]
  const provenance = (entries: Array<{ id: string; reviewer: string; batch: number }>) => entries.map((e) => [e.id, e.reviewer, e.batch])
  assert.deepEqual(provenance(status(s, id).out.ledger), expected)
  assert.deepEqual(provenance(cli(s, ['wait', id, '--max', '5']).out.ledger), expected)
  assert.deepEqual(provenance(runJson(s, id, 'receipt.json').ledger.entries), expected)
})

test('status y wait muestran el progreso mientras la ronda corre', () => {
  const s = setup(['__hang__'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  const id = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex']).out.id
  waitJob(s, id, 'base-b1')
  const progress = { phase: 'review', key: 'base-b1', reviewer: 'base', batch: 1, index: 1, total: 1 }
  assert.deepEqual(status(s, id).out.progress, progress)
  const w = cli(s, ['wait', id, '--max', '1'])
  assert.deepEqual([w.code, w.out.state, w.out.round, w.out.progress, w.out.reviewers], [3, 'running', 1, progress, ['base']])
  assert.deepEqual(w.out.risk, { level: 'normal', reasons: [], forced: false })
  cli(s, ['cancel', id])
  assert.equal(waitRound(s, id).out.progress, undefined)
})

test('el progreso nombra los lotes y revisores del lanzamiento en curso', () => {
  const quiet = Array.from({ length: 9 }, () => firstRound([]))
  const s = setup([firstRound([{ ...grave, location: 'x/uno.txt:5' }]), ...quiet, '__hang__'])
  mkdirSync(join(s.repo, 'x'))
  mkdirSync(join(s.repo, 'y'))
  writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky())
  writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky())
  git(s.repo, 'add', '-N', 'x/uno.txt', 'y/dos.txt')
  const id = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex', '--risk', 'high']).out.id
  waitRound(s, id)
  assert.deepEqual(status(s, id).out.reviewers, ['base', 'risk', 'resilience', 'reliability', 'readability'])
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky('arreglado'))
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitJob(s, id, 'base-b1')
  const lots = [{ n: 1, paths: ['x/uno.txt'] }, { n: 2, paths: ['y/dos.txt'] }]
  for (const out of [status(s, id).out, cli(s, ['wait', id, '--max', '1']).out]) {
    assert.deepEqual([out.round, out.reviewers, out.batches, out.progress.key, out.progress.total], [2, ['base'], lots, 'base-b1', 2])
  }
  cli(s, ['cancel', id])
  waitRound(s, id)
})

test('lotes declarados: status, wait y el recibo nombran los lotes, sus archivos y el límite entre lotes', () => {
  const s = setup([firstRound([{ ...warning, location: 'x/uno.txt:5' }]), firstRound([])])
  mkdirSync(join(s.repo, 'x'))
  mkdirSync(join(s.repo, 'y'))
  writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky())
  writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky())
  git(s.repo, 'add', '-N', 'x/uno.txt', 'y/dos.txt')
  const id = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex']).out.id
  const w = waitRound(s, id).out
  const lots = [{ n: 1, paths: ['x/uno.txt'] }, { n: 2, paths: ['y/dos.txt'] }]
  const note = 'las relaciones entre archivos de lotes distintos no se revisaron juntas'
  for (const out of [w, status(s, id).out]) {
    assert.deepEqual([out.batches, out.batches_note], [lots, note])
    assert.deepEqual(out.jobs.map((j: { key: string; state: string }) => [j.key, j.state]), [['base-b1', 'done'], ['base-b2', 'done']])
    assert.deepEqual([out.ledger[0].reviewer, out.ledger[0].batch], ['base', 1])
  }
  const round = runJson(s, id, 'receipt.json').rounds[0]
  assert.deepEqual([round.batches, round.batches_note, round.jobs.length], [lots, note, 2])
})

test('una corrida anterior se lee como normal, sin lotes y base, y review round la continúa', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s)
  // La forma de una corrida anterior a esta fase: sin nivel, sin trabajos ni lotes, sin procedencia ni modo anterior.
  const request = runJson(s, id, 'request.json')
  delete request.risk
  writeFileSync(runFile(s, id, 'request.json'), JSON.stringify(request))
  const rounds = runJson(s, id, 'rounds.json')
  for (const r of rounds.rounds) for (const k of ['launch', 'risk', 'batches', 'jobs']) delete r[k]
  writeFileSync(runFile(s, id, 'rounds.json'), JSON.stringify(rounds))
  const ledger = runJson(s, id, 'ledger.json')
  for (const e of ledger.entries) for (const k of ['reviewer', 'batch']) delete e[k]
  writeFileSync(runFile(s, id, 'ledger.json'), JSON.stringify(ledger))
  const candidate = runJson(s, id, 'candidate.json')
  for (const f of candidate.files) delete f.old_mode
  writeFileSync(runFile(s, id, 'candidate.json'), JSON.stringify(candidate))
  const v = status(s, id).out
  assert.deepEqual([v.risk, v.reviewers, v.batches, v.jobs], [{ level: 'normal', reasons: [], forced: false }, ['base'], undefined, undefined])
  assert.deepEqual([v.ledger[0].reviewer, v.ledger[0].batch], ['base', 1])
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  const receipt = runJson(s, id, 'receipt.json')
  assert.deepEqual([receipt.ledger.entries[0].reviewer, receipt.ledger.entries[0].batch], ['base', 1])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.round], [0, 2])
  waitRound(s, id)
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
})
