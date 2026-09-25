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
  const prompt = readFileSync(runFile(s, id, 'prompt-r2.md'), 'utf8')
  assert.match(prompt, /ronda 2 de 3/)
  assert.ok(prompt.includes('el nombre lo pidió el plan'))
  assert.match(prompt, /a\.txt: 5/)
  const plan = runJson(s, id, 'round-r2.json')
  assert.deepEqual([plan.n, plan.identical, plan.changed], [2, false, { 'a.txt': [[5, 5]] }])
  assert.equal(plan.prev_hash, runJson(s, id, 'candidate.json').hash)
})

test('la ronda siguiente usa el revisor de la ronda 1 en una sesión nueva, y un refutador del rol refute', () => {
  const s = setup([firstRound([grave]), nextRound([{ id: 'F-1', answer: 'resolved' }])])
  const id = startAndWait(s)
  const first = runJson(s, id, 'argv.json')
  const flag = (args: string[], f: string) => args[args.indexOf(f) + 1]
  assert.deepEqual([flag(first.refuter_launch.args, '--model'), flag(first.refuter_launch.args, '--effort')], ['sonnet', 'medium'])
  assert.equal(flag(first.refuter_launch.args, '--system-prompt'), REFUTER_SYSTEM_PROMPT)
  assert.equal(first.refuter_launch.stdinFile, runFile(s, id, 'prompt-refute.md'))
  assert.ok(existsSync(runFile(s, id, 'material.md')))
  assert.ok(existsSync(runFile(s, id, 'blobs')))
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  const second = runJson(s, id, 'argv-r2.json')
  assert.deepEqual([second.round, second.tag, second.extra], [2, '-r2', false])
  assert.equal(second.family, 'claude')
  assert.deepEqual([flag(second.launch.args, '--model'), flag(second.launch.args, '--effort')], ['opus', 'high'])
  assert.notEqual(flag(second.launch.args, '--session-id'), flag(first.launch.args, '--session-id'))
  assert.notEqual(second.launch.cwd, first.launch.cwd)
  assert.equal(second.launch.stdinFile, runFile(s, id, 'prompt-r2.md'))
  assert.equal(second.refuter_launch.stdinFile, runFile(s, id, 'prompt-r2-refute.md'))
  assert.equal(second.deadline_sec, first.deadline_sec)
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
  const r = cli(s, ['review', 'round', id])
  usage(r, /ronda 1/)
  assert.match(r.out.next, /review start --base/)
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
  assert.equal(existsSync(runFile(s, id, 'argv-r2.json')), false)
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
  assert.match(readFileSync(runFile(s, id, 'prompt-r2.md'), 'utf8'), /no se admite ningún hallazgo nuevo/)
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
  assert.equal(existsSync(runFile(s, id, 'argv-r4.json')), false)
  const extra = cli(s, ['review', 'round', id, '--extra'])
  assert.equal(extra.code, 0, JSON.stringify(extra.out))
  waitRound(s, id)
  assert.equal(runJson(s, id, 'argv-r4.json').extra, true)
  assert.deepEqual(states(s, id), [['F-1', 'resuelto']])
  assert.equal(runJson(s, id, 'ledger.json').completed, 4)
})

test('un prompt de ronda que no entra en el presupuesto no crea archivos de la ronda ni lanza', () => {
  const s = setup([firstRound([grave])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, 'grande.txt'), 'x'.repeat(100).concat('\n').repeat(2200))
  git(s.repo, 'add', '-N', 'grande.txt')
  const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'prompt_too_large')
  assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
  assert.match(r.out.detail, /^\d+ > 204800$/)
  for (const f of ['argv-r2.json', 'prompt-r2.md', 'candidate-r2.json', 'round-r2.json']) assert.equal(existsSync(runFile(s, id, f)), false, f)
  assert.equal(runJson(s, id, 'status.json').state, 'done')
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
  assert.deepEqual([w.code, w.out.state, w.out.round, w.out.completed, w.out.reason], [1, 'unavailable', 2, 1, 'reviewer_unavailable'])
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
  assert.deepEqual([v.refuted, v.inconclusive, v.pending], [['F-1'], ['F-2'], ['F-2']])
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
