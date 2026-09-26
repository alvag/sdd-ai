import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REFUTER_SYSTEM_PROMPT } from '../src/workers/claude.ts'
import { makeFakeBin, makeRepo, warmFakeBin } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const lines = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => `${change[i + 1] ?? `línea ${i + 1}`}\n`).join('')

interface Setup { repo: string; env: Record<string, string>; base: string }

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

/**
 * Repo con a.txt (10 líneas) commiteado, revisor Claude (el autor es Codex), perfiles de revisor y
 * refutador en workers.yml, y el CLI falso guionado con `answers`.
 */
function setup(answers: string[]): Setup {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  writeFileSync(join(repo, '.sdd-ai', '.gitignore'), '*\n')
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n')
  writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), [
    'schema_version: 1', 'roles:',
    '  code-review:', '    claude:', '      model: opus', '      effort: alto',
    '  refute:', '    claude:', '      model: sonnet', '      effort: medio', '',
  ].join('\n'))
  writeFileSync(join(repo, 'a.txt'), lines(10))
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'base')
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  makeFakeBin(bin, 'claude')
  warmFakeBin(bin, 'claude')
  const work = mkdtempSync(join(tmpdir(), 'sdd-ai-fake-'))
  writeFileSync(join(work, 'answers.json'), JSON.stringify(answers))
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1',
    FAKE_MODE: 'scripted', FAKE_ANSWERS: join(work, 'answers.json'), FAKE_CALLS_FILE: join(work, 'calls'),
  }
  return { repo, env, base: git(repo, 'rev-parse', 'HEAD') }
}

function cli(s: Setup, args: string[]) {
  const r = spawnSync(BIN, args, { cwd: s.repo, env: s.env, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}

const runFile = (s: Setup, id: string, name: string) => join(s.repo, '.sdd-ai', 'runs', id, name)
const runJson = (s: Setup, id: string, name: string) => JSON.parse(readFileSync(runFile(s, id, name), 'utf8'))
const states = (s: Setup, id: string) => runJson(s, id, 'ledger.json').entries.map((e: { id: string; state: string }) => [e.id, e.state])

const grave = { axis: 'quality', severity: 'CRITICAL', location: 'a.txt:5', claim: 'la línea 5 no valida', causality: 'introduced', evidence: 'deterministic' }
const warning = { axis: 'scope', severity: 'WARNING', location: 'a.txt:5', claim: 'sobra el cambio de nombre' }
const firstRound = (findings: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)}}`
const nextRound = (responses: unknown[], findings: unknown[] = []) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"responses":${JSON.stringify(responses)},"findings":${JSON.stringify(findings)}}`

/** Lanza la ronda 1 sobre a.txt con la línea 5 cambiada y espera que termine. */
function startAndWait(s: Setup, extra: string[] = []): string {
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  const r = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex', ...extra])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.notEqual(w.code, 3, 'la ronda 1 no terminó')
  return r.out.id
}

function waitRound(s: Setup, id: string) {
  const w = cli(s, ['wait', id, '--max', '20'])
  assert.notEqual(w.code, 3, 'la ronda no terminó')
  return w
}

function usage(r: { code: number | null; out: { code: string; message: string } }, why: RegExp) {
  assert.equal(r.code, 2, JSON.stringify(r.out))
  assert.match(r.out.message, why)
}

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
  assert.equal(cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', 'decide la persona: se queda']).code, 0)
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

const status = (s: Setup, id: string) => cli(s, ['review', 'status', id])

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

const prompts = (s: Setup, id: string, prefix: string) => readdirSync(join(s.repo, '.sdd-ai', 'runs', id)).filter((f) => f.startsWith(prefix)).sort()
const block = (text: string, name: string) => text.slice(text.search(new RegExp(`<<<${name} sha256:`)), text.search(new RegExp(`<<<FIN ${name} sha256:`)))

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

/** Un archivo de unos 120 KB, con su línea 5 a elección: dos no entran juntos en un prompt. */
const bulky = (line5 = 'x'.repeat(99)) => Array.from({ length: 1200 }, (_, i) => (i === 4 ? line5 : 'x'.repeat(99))).join('\n').concat('\n')

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

test('un delta con señal alta frena la ronda y propone --risk high', () => {
  for (const extra of [[], ['--risk', 'high']]) {
    const s = setup(Array.from({ length: 5 }, () => firstRound([grave])))
    const id = startAndWait(s, extra)
    const ids = runJson(s, id, 'ledger.json').entries.map((e: { id: string }) => e.id)
    assert.equal(cli(s, ['review', 'decide', id, 'accept', ...ids]).code, 0)
    writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada', 7: 'exec(cmd)' }))
    const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
    const r = cli(s, ['review', 'round', id])
    assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'risk_high', 'la corrección introduce riesgo alto'])
    assert.equal(r.out.detail, 'process en a.txt: línea 7: exec')
    assert.match(r.out.next, /^pregunta al usuario si reinicia la revisión con lentes: \.\/bin\/sdd-ai review start --base \S+ --author codex --risk high$/)
    assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
    assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
  }
})

const unavailable = '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"findings":[]}'
const said = (who: string) => firstRound([{ ...warning, claim: `lo dice ${who}` }])

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

/** Espera hasta que el trabajo `key` de la ronda esté corriendo. */
function waitJob(s: Setup, id: string, key: string): void {
  const until = Date.now() + 30_000
  while (runJson(s, id, 'status.json').job?.key !== key || runJson(s, id, 'status.json').state !== 'running') {
    assert.ok(Date.now() < until, `el trabajo ${key} no arrancó`)
    spawnSync('sleep', ['0.1'])
  }
}

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
