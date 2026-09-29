import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { type Question, disputeQuestion, extraQuestion } from '../src/approval/question.ts'
import { extraReuse } from '../src/cli.ts'
import { decide } from '../src/review/ledger.ts'
import { REFUTER_SYSTEM_PROMPT } from '../src/workers/claude.ts'
import { askPair, makeFakeBin, makeRepo, warmFakeBin, writeClaudeTranscript } from './helpers.ts'

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
    '  refute:', '    claude:', '      model: sonnet', '      effort: medio',
    '  design-review:', '    claude:', '      model: opus', '      effort: muy_alto', '',
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
  // Una sesión de Claude Code de fixture: su transcript es donde el usuario responde las preguntas.
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sdd-ai-claude-')),
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
const grave2 = { axis: 'spec', severity: 'CRITICAL', location: 'a.txt:5', claim: 'falta el caso vacío', causality: 'introduced', evidence: 'deterministic' }
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

/** Responde en el transcript de la sesión la pregunta de `review status` cuyo texto contiene `match`. */
function answerReview(s: Setup, id: string, match: string, label: string): Question {
  const questions: Question[] = cli(s, ['review', 'status', id]).out.questions
  const q = questions.find((x) => x.question.includes(match))
  assert.ok(q, `no hay una pregunta con ${match}: ${JSON.stringify(questions)}`)
  const session = s.env.CLAUDE_CODE_SESSION_ID
  writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR, session, askPair(session, `tu-${randomUUID()}`, q, label))
  return q
}

const SPEC = '# Spec\n\n- AC-1: algo observable.\n- AC-2: otra cosa observable.\n'
const agrave = { of: '.plans/spec.md', axis: 'quality', severity: 'CRITICAL', location: '.plans/spec.md:3', claim: 'AC-1 no se puede observar', evidence: 'inferential' }
const afirst = (findings: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)},"unverifiable":[]}`
const anext = (responses: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"responses":${JSON.stringify(responses)},"findings":[],"unverifiable":[]}`
const aUnresolved = anext([{ id: 'F-1', answer: 'unresolved', evidence: '.plans/spec.md:3' }])
/** Las respuestas del revisor para `artifactAtCap`: un grave que sigue sin resolverse en las rondas 2 y 3. */
const ARTIFACT_AT_CAP = [afirst([agrave]), aUnresolved, aUnresolved]

/** Una revisión de la spec, con un grave aceptado que la ronda 3 todavía ve sin resolver: está en el tope. */
function artifactAtCap(s: Setup): string {
  writeFileSync(join(s.repo, '.git', 'info', 'exclude'), '.plans/\n')
  mkdirSync(join(s.repo, '.plans'))
  writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC)
  writeFileSync(join(s.repo, '.plans', 'pedido.md'), 'Quiero algo observable.\n')
  const r = cli(s, ['review', 'start', '--artifact', '.plans/spec.md', '--kind', 'spec', '--request', '.plans/pedido.md', '--author', 'codex'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const id = r.out.id
  waitRound(s, id)
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  for (const n of [2, 3]) {
    writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC.replace('algo observable', `algo observable, intento ${n}`))
    const round = cli(s, ['review', 'round', id])
    assert.equal(round.code, 0, JSON.stringify(round.out))
    waitRound(s, id)
  }
  assert.equal(runJson(s, id, 'ledger.json').completed, 3)
  return id
}

/** Una revisión de diff con F-1 aceptado y sin resolver después de la ronda 3: está en el tope. */
function diffAtCap(s: Setup): string {
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  for (const n of [2, 3]) {
    writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: `línea cinco, intento ${n}` }))
    assert.equal(cli(s, ['review', 'round', id]).code, 0)
    waitRound(s, id)
  }
  assert.equal(runJson(s, id, 'ledger.json').completed, 3)
  return id
}
const unresolved = nextRound([{ id: 'F-1', answer: 'unresolved', evidence: 'a.txt:5' }])

/** Corre el CLI sin esperar: dos de estos compiten por la misma revisión. */
function cliAsync(s: Setup, args: string[], env: Record<string, string> = s.env): Promise<{ code: number | null; out: any }> {
  return new Promise((done) => {
    const child = spawn(BIN, args, { cwd: s.repo, env })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.on('close', (code) => done({ code, out: JSON.parse(stdout || 'null') }))
  })
}

const LOCK_TS = join(import.meta.dirname, '..', 'src', 'lock.ts')
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Un proceso hijo que toma el lock con `withLock` y lo retiene hasta `release()`: así dos comandos
 * observan el mismo estado antes de que alguno escriba. Si un test falla antes de soltarlo, el hijo
 * lo suelta solo a los 60 s y no retiene al proceso de los tests.
 */
async function holdLock(lock: string): Promise<{ release: () => void }> {
  const flag = join(mkdtempSync(join(tmpdir(), 'sdd-ai-hold-')), 'soltar')
  const code = `import { withLock } from ${JSON.stringify(LOCK_TS)}
import { existsSync } from 'node:fs'
const until = Date.now() + 60000
withLock(${JSON.stringify(lock)}, () => new Error('ocupado'), () => {
  process.stdout.write('tomado\\n')
  while (!existsSync(${JSON.stringify(flag)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
})`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code])
  await new Promise<void>((done) => child.stdout.on('data', (b: Buffer) => { if (b.toString('utf8').includes('tomado')) done() }))
  child.stdout.destroy()
  child.unref()
  return { release: () => writeFileSync(flag, '') }
}

/** Una revisión con F-1 y F-2 en disputa después de la ronda 2, rechazados con los motivos dados. */
function twoDisputes(reasons: [string, string] = ['es intencional', 'no aplica']): { s: Setup; id: string } {
  const maintained = (x: string) => ({ id: x, answer: 'maintained', evidence: 'a.txt:5' })
  const s = setup([firstRound([grave, grave2]), nextRound([maintained('F-1'), maintained('F-2')])])
  const id = startAndWait(s)
  cli(s, ['review', 'decide', id, 'reject', 'F-1', '--reason', reasons[0]])
  cli(s, ['review', 'decide', id, 'reject', 'F-2', '--reason', reasons[1]])
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  waitRound(s, id)
  assert.deepEqual(states(s, id), [['F-1', 'en-disputa'], ['F-2', 'en-disputa']])
  return { s, id }
}
const ledgerText = (s: Setup, id: string) => readFileSync(runFile(s, id, 'ledger.json'), 'utf8')
const entryOf = (s: Setup, id: string, f: string) => runJson(s, id, 'ledger.json').entries.find((e: { id: string }) => e.id === f)

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
  const r0 = spawnSync(BIN, ['review', 'decide', oid, 'accept', 'F-1'], { cwd: o.repo, env: noSession, encoding: 'utf8' })
  assert.equal(r0.status, 0, r0.stdout)

  const { s, id } = twoDisputes()
  const before = ledgerText(s, id)
  const missing = cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  assert.equal(missing.out.code, 'approval_missing', JSON.stringify(missing.out))
  assert.equal(ledgerText(s, id), before)
  answerReview(s, id, 'disputa F-1', 'Aceptar el hallazgo')
  const worker = spawnSync(BIN, ['review', 'decide', id, 'accept', 'F-1'], { cwd: s.repo, env: { ...s.env, SDD_AI_WORKER: '1' }, encoding: 'utf8' })
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

/** Cada archivo de la corrida, recursivo, con el sha256 de su contenido. */
function runState(s: Setup, id: string, dir = runFile(s, id, ''), acc: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (readdirSync(dir, { withFileTypes: true }).find((d) => d.name === name)?.isDirectory()) runState(s, id, p, acc)
    else acc.push(`${p.slice(runFile(s, id, '').length)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
  }
  return acc
}
const resolvedRound = nextRound([{ id: 'F-1', answer: 'resolved' }])
const aResolved = anext([{ id: 'F-1', answer: 'resolved' }])
/** Deja el sujeto de cada revisión cambiado, para que la ronda extra no sea idéntica a la anterior. */
const touchDiff = (s: Setup) => writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco, intento 4' }))
const touchSpec = (s: Setup) => writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC.replace('algo observable', 'algo observable, intento 4'))
const unavailableRound = '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"responses":[],"findings":[]}'

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
