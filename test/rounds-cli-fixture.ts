// Lo común de las rondas de `review` por el binario, que están partidos por tema en `rounds-cli-*.test.ts`.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { type Question } from '../src/approval/question.ts'
import { planRoundJobs } from '../src/review/batch.ts'
import { freeze } from '../src/review/candidate.ts'
import { REVIEW_PROMPT_BUDGET, measure } from '../src/review/prompt.ts'
import { type Reviewer, type RoundPlan, type LedgerEntry } from '../src/review/ledger.ts'
import { askPair, makeFakeBin, makeRepo, telemetryOff, writeClaudeTranscript } from './helpers.ts'

export const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

export const lines = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => `${change[i + 1] ?? `línea ${i + 1}`}\n`).join('')

export interface Setup { repo: string; env: Record<string, string>; base: string }

export const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

/**
 * Repo con a.txt (10 líneas) commiteado, revisor Claude (el autor es Codex), perfiles de revisor y
 * refutador en workers.yml, y el CLI falso guionado con `answers`.
 */
export function setup(answers: string[]): Setup {
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
  const work = mkdtempSync(join(tmpdir(), 'sdd-ai-fake-'))
  writeFileSync(join(work, 'answers.json'), JSON.stringify(answers))
  // Una sesión de Claude Code de fixture: su transcript es donde el usuario responde las preguntas.
  const env: Record<string, string> = telemetryOff({
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sdd-ai-claude-')),
    FAKE_MODE: 'scripted', FAKE_ANSWERS: join(work, 'answers.json'), FAKE_CALLS_FILE: join(work, 'calls'),
  })
  return { repo, env, base: git(repo, 'rev-parse', 'HEAD') }
}

export function cli(s: Setup, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: s.repo, env: s.env, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}

export const runFile = (s: Setup, id: string, name: string) => join(s.repo, '.sdd-ai', 'runs', id, name)

export const runJson = (s: Setup, id: string, name: string) => JSON.parse(readFileSync(runFile(s, id, name), 'utf8'))

export const states = (s: Setup, id: string) => runJson(s, id, 'ledger.json').entries.map((e: { id: string; state: string }) => [e.id, e.state])

export const grave = { axis: 'quality', severity: 'CRITICAL', location: 'a.txt:5', claim: 'la línea 5 no valida', causality: 'introduced', evidence: 'deterministic' }

export const warning = { axis: 'scope', severity: 'WARNING', location: 'a.txt:5', claim: 'sobra el cambio de nombre' }

export const grave2 = { axis: 'spec', severity: 'CRITICAL', location: 'a.txt:5', claim: 'falta el caso vacío', causality: 'introduced', evidence: 'deterministic' }

export const firstRound = (findings: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)}}`

export const nextRound = (responses: unknown[], findings: unknown[] = []) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"responses":${JSON.stringify(responses)},"findings":${JSON.stringify(findings)}}`

/** Lanza la ronda 1 sobre a.txt con la línea 5 cambiada y espera que termine. */
export function startAndWait(s: Setup, extra: string[] = []): string {
  writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  const r = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex', ...extra])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.notEqual(w.code, 3, 'la ronda 1 no terminó')
  return r.out.id
}

export function waitRound(s: Setup, id: string) {
  const w = cli(s, ['wait', id, '--max', '20'])
  assert.notEqual(w.code, 3, 'la ronda no terminó')
  return w
}

/** Responde en el transcript de la sesión la pregunta de `review status` cuyo texto contiene `match`. */
export function answerReview(s: Setup, id: string, match: string, label: string): Question {
  const questions: Question[] = cli(s, ['review', 'status', id]).out.questions
  const q = questions.find((x) => x.question.includes(match))
  assert.ok(q, `no hay una pregunta con ${match}: ${JSON.stringify(questions)}`)
  const session = s.env.CLAUDE_CODE_SESSION_ID
  writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR, session, askPair(session, `tu-${randomUUID()}`, q, label))
  return q
}

export const SPEC = '# Spec\n\n- AC-1: algo observable.\n- AC-2: otra cosa observable.\n'

export const agrave = { of: '.plans/spec.md', axis: 'quality', severity: 'CRITICAL', location: '.plans/spec.md:3', claim: 'AC-1 no se puede observar', evidence: 'inferential' }

export const afirst = (findings: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)},"unverifiable":[]}`

export const anext = (responses: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"responses":${JSON.stringify(responses)},"findings":[],"unverifiable":[]}`

export const aUnresolved = anext([{ id: 'F-1', answer: 'unresolved', evidence: '.plans/spec.md:3' }])

/** Las respuestas del revisor para `artifactAtCap`: un grave que sigue sin resolverse en las rondas 2 y 3. */
export const ARTIFACT_AT_CAP = [afirst([agrave]), aUnresolved, aUnresolved]

/** Una revisión de la spec, con un grave aceptado que la ronda 3 todavía ve sin resolver: está en el tope. */
export function artifactAtCap(s: Setup): string {
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
export function diffAtCap(s: Setup): string {
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

export const unresolved = nextRound([{ id: 'F-1', answer: 'unresolved', evidence: 'a.txt:5' }])

/** Corre el CLI sin esperar: dos de estos compiten por la misma revisión. */
export function cliAsync(s: Setup, args: string[], env: Record<string, string> = s.env): Promise<{ code: number | null; out: any }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: s.repo, env })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.on('close', (code) => done({ code, out: JSON.parse(stdout || 'null') }))
  })
}

export const LOCK_TS = join(import.meta.dirname, '..', 'src', 'lock.ts')

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Un proceso hijo que toma el lock con `withLock` y lo retiene hasta `release()`: así dos comandos
 * observan el mismo estado antes de que alguno escriba. Si un test falla antes de soltarlo, el hijo
 * lo suelta solo a los 60 s y no retiene al proceso de los tests.
 */
export async function holdLock(lock: string): Promise<{ release: () => void }> {
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
export function twoDisputes(reasons: [string, string] = ['es intencional', 'no aplica']): { s: Setup; id: string } {
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

export const ledgerText = (s: Setup, id: string) => readFileSync(runFile(s, id, 'ledger.json'), 'utf8')

export const entryOf = (s: Setup, id: string, f: string) => runJson(s, id, 'ledger.json').entries.find((e: { id: string }) => e.id === f)

export function usage(r: { code: number | null; out: { code: string; message: string } }, why: RegExp) {
  assert.equal(r.code, 2, JSON.stringify(r.out))
  assert.match(r.out.message, why)
}

export const status = (s: Setup, id: string) => cli(s, ['review', 'status', id])

export const prompts = (s: Setup, id: string, prefix: string) => readdirSync(join(s.repo, '.sdd-ai', 'runs', id)).filter((f) => f.startsWith(prefix)).sort()

export const block = (text: string, name: string) => text.slice(text.search(new RegExp(`<<<${name} sha256:`)), text.search(new RegExp(`<<<FIN ${name} sha256:`)))

/** Un archivo de unos 120 KB, con su línea 5 a elección: dos no entran juntos en un prompt. */
export const bulky = (line5 = 'x'.repeat(99)) => Array.from({ length: 1200 }, (_, i) => (i === 4 ? line5 : 'x'.repeat(99))).join('\n').concat('\n')

export const ROUND_REVIEWERS: readonly Reviewer[] = ['base', 'risk', 'resilience', 'reliability', 'readability']

export const lensPrompts = (keys: readonly string[]) => keys.map((k) => `prompt-r2-l1-${k}-b1.md`).sort()

export function checkBatchedLenses(): void {
  const none = firstRound([])
  const empty = nextRound([])
  const s = setup([
    firstRound([{ ...grave, location: 'x/uno.txt:5' }]), none, none, none, none, none, none, none, none, none,
    nextRound([{ id: 'F-1', answer: 'resolved' }]), empty, empty, empty, empty, empty, empty, empty, empty, empty,
  ])
  mkdirSync(join(s.repo, 'x'))
  mkdirSync(join(s.repo, 'y'))
  writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky())
  writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky())
  git(s.repo, 'add', '-N', 'x/uno.txt', 'y/dos.txt')
  const r = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex', '--risk', 'high'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const id = r.out.id
  waitRound(s, id)
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky('arreglado uno'))
  writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky('exec(cmd)'))
  const round = cli(s, ['review', 'round', id])
  assert.equal(round.code, 0, JSON.stringify(round.out))
  assert.deepEqual(round.out.batches, [{ n: 1, paths: ['x/uno.txt'] }, { n: 2, paths: ['y/dos.txt'] }])
  waitRound(s, id)
  const jobs = runJson(s, id, 'argv-r2-l1.json').jobs.map((j: { key: string }) => j.key)
  assert.deepEqual(jobs, ROUND_REVIEWERS.flatMap((k) => [`${k}-b1`, `${k}-b2`]))
  const verify = (key: string) => block(readFileSync(runFile(s, id, `prompt-r2-l1-${key}.md`), 'utf8'), 'VERIFICAR')
  assert.ok(verify('base-b1').includes('"F-1"') && !verify('base-b2').includes('"F-1"'))
  for (const key of jobs.filter((k: string) => !k.startsWith('base'))) {
    assert.equal(readFileSync(runFile(s, id, `prompt-r2-l1-${key}.md`), 'utf8').includes('<<<VERIFICAR sha256:'), false, key)
  }
  assert.equal(entryOf(s, id, 'F-1').responses.length, 1)

  const candidate = freeze(s.repo, { base: s.base, context: [] })
  const plan: RoundPlan = { n: 2, prev_hash: candidate.hash, identical: false, targets: [], changed: { 'x/uno.txt': [[5, 5]], 'y/dos.txt': [[5, 5]] } }
  const planned = planRoundJobs(candidate, new Map(), plan, [], 4, ROUND_REVIEWERS)
  assert.equal(planned.batches.length, 2)
  for (const job of planned.jobs) {
    assert.ok(measure(job.text) <= REVIEW_PROMPT_BUDGET, job.key)
    if (job.reviewer !== 'base') assert.deepEqual(job.targets, [])
  }

  // Una lente revisa solo CAMBIOS: en un lote sin líneas que cambiaron no corre.
  const one = planRoundJobs(candidate, new Map(), { ...plan, changed: { 'y/dos.txt': [[5, 5]] } }, [], 4, ROUND_REVIEWERS)
  assert.deepEqual(one.batches, [['x/uno.txt'], ['y/dos.txt']])
  assert.deepEqual(one.jobs.map((j) => j.key), ['base-b1', 'base-b2', ...ROUND_REVIEWERS.slice(1).map((r) => `${r}-b2`)])
  assert.deepEqual(one.reviewers, ROUND_REVIEWERS)
}

export function checkEmptyLensLots(): void {
  const s = setup([])
  const clean = freeze(s.repo, { base: s.base, context: [] })
  const plan: RoundPlan = { n: 2, prev_hash: clean.hash, identical: false, targets: [], changed: {} }
  const empty = planRoundJobs(clean, new Map(), plan, [], 4, ROUND_REVIEWERS)
  assert.deepEqual(empty.batches, [[]])
  assert.deepEqual(empty.jobs.map((j) => j.key), ['base-b1'])
  assert.deepEqual(empty.reviewers, ['base'])

  // Un pendiente huérfano puede ocupar el primer lote sin rutas: las lentes empiezan en el siguiente.
  writeFileSync(join(s.repo, 'a.txt'), bulky('exec(cmd)'))
  const candidate = freeze(s.repo, { base: s.base, context: [] })
  const entry: LedgerEntry = { ...grave, axis: 'quality', severity: 'CRITICAL', causality: 'introduced', evidence: 'deterministic', id: 'F-1', state: 'aceptado' as const, reviewer: 'base' as const, batch: 1,
    location: 'orphan.txt:1', responses: [], round: 1, claim: 'x'.repeat(115000) }
  const pending: RoundPlan = { ...plan, targets: [{ id: 'F-1', kind: 'verify' }], changed: { 'a.txt': [[5, 5]] } }
  const split = planRoundJobs(candidate, new Map(), pending, [entry], 4, ROUND_REVIEWERS)
  assert.deepEqual(split.batches, [[], ['a.txt']])
  assert.deepEqual(split.jobs.filter((j) => j.reviewer !== 'base').map((j) => j.key), ROUND_REVIEWERS.slice(1).map((r) => `${r}-b2`))
  for (const job of split.jobs) {
    assert.ok(measure(job.text) <= REVIEW_PROMPT_BUDGET, job.key)
    if (job.reviewer !== 'base') assert.deepEqual(job.targets, [])
  }

  // Sin líneas citables en CAMBIOS, la ronda corre solo la base aunque el candidato tenga archivos.
  const uncited = planRoundJobs(candidate, new Map(), plan, [], 4, ROUND_REVIEWERS)
  assert.deepEqual(uncited.jobs.map((j) => j.key), ['base-b1'])
  assert.deepEqual(uncited.reviewers, ['base'])
}

export const unavailable = '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"findings":[]}'

export const said = (who: string) => firstRound([{ ...warning, claim: `lo dice ${who}` }])

/** Espera hasta que el trabajo `key` de la ronda esté corriendo. */
export function waitJob(s: Setup, id: string, key: string): void {
  const until = Date.now() + 30_000
  while (runJson(s, id, 'status.json').job?.key !== key || runJson(s, id, 'status.json').state !== 'running') {
    assert.ok(Date.now() < until, `el trabajo ${key} no arrancó`)
    spawnSync('sleep', ['0.1'])
  }
}

/** Cada archivo de la corrida, recursivo, con el sha256 de su contenido. */
export function runState(s: Setup, id: string, dir = runFile(s, id, ''), acc: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (readdirSync(dir, { withFileTypes: true }).find((d) => d.name === name)?.isDirectory()) runState(s, id, p, acc)
    else acc.push(`${p.slice(runFile(s, id, '').length)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
  }
  return acc
}

export const resolvedRound = nextRound([{ id: 'F-1', answer: 'resolved' }])

export const aResolved = anext([{ id: 'F-1', answer: 'resolved' }])

/** Deja el sujeto de cada revisión cambiado, para que la ronda extra no sea idéntica a la anterior. */
export const touchDiff = (s: Setup) => writeFileSync(join(s.repo, 'a.txt'), lines(10, { 5: 'línea cinco, intento 4' }))

export const touchSpec = (s: Setup) => writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC.replace('algo observable', 'algo observable, intento 4'))

export const unavailableRound = '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"responses":[],"findings":[]}'
