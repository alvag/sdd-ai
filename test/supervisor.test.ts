import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRun, readStatus, writeJsonAtomic } from '../src/runs.ts'
import { sliceCandidate } from '../src/review/batch.ts'
import { type Candidate, freeze, snapshot } from '../src/review/candidate.ts'
import { type Ledger, type Reviewer, type RoundPlan, decide, openLedger, targets } from '../src/review/ledger.ts'
import { CORRECTION_RESERVE, REVIEW_PROMPT_BUDGET, closingMessage, renderMaterial, renderReviewPrompt, renderRoundPrompt } from '../src/review/prompt.ts'
import { type ArgvFile, cleanEnv, removeScratch, supervise, writeReceipt } from '../src/supervisor.ts'
import { ARTIFACT_SYSTEM_PROMPT, REFUTER_SYSTEM_PROMPT } from '../src/workers/claude.ts'
import { renderArtifactMaterial, renderArtifactPrompt } from '../src/review/artifact-prompt.ts'
import { freezeArtifact } from '../src/review/artifact.ts'
import { type Family, type Resolution, opposite } from '../src/types.ts'
import { type PhaseRecord, readPhaseRecord, withFlowLock, writePhaseRecord } from '../src/sdd/phase-state.ts'
import { freezeLaunch } from '../src/sdd/publish.ts'
import { readFlow } from '../src/sdd/read.ts'
import { makeFakeBin, makeRepo } from './helpers.ts'

const FAKE = join(import.meta.dirname, 'fake-cli.ts')

function prepare(family: Family, mode: string, over: Partial<ArgvFile> = {}): string {
  const dir = createRun(makeRepo(), 'r')
  writeFileSync(join(dir, 'prompt.md'), 'encargo')
  const argv: ArgvFile = {
    family,
    launch: { cmd: process.execPath, args: [FAKE, '--output-last-message', join(dir, 'result.md')], cwd: dir, stdinFile: join(dir, 'prompt.md') },
    deadline_sec: 30,
    ...over,
  }
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  process.env.FAKE_MODE = mode
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  return dir
}

/** Como `prepare`, con flags de perfil agregados al argv falso. */
function prepareWith(family: Family, mode: string, extra: string[]): string {
  const dir = prepare(family, mode)
  const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as ArgvFile
  const launch = argv.launch ?? { cmd: '', args: [], cwd: dir, stdinFile: '' }
  writeJsonAtomic(join(dir, 'argv.json'), { ...argv, launch: { ...launch, args: [...launch.args, ...extra] } })
  return dir
}

const calls = (dir: string): string[][] =>
  readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() > until) throw new Error('timeout esperando la condición')
    await sleep(50)
  }
}

test('Claude que responde bien termina en done con resultado y sesión', async () => {
  const dir = prepare('claude', 'ok-claude')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.equal(readFileSync(join(dir, 'result.md'), 'utf8'), 'ok')
  assert.equal(s.session_id, '473db793-e2bb-4560-88d1-4c62af94b3eb')
  assert.equal(readStatus(dir).state, 'done')
})

test('Codex que responde bien usa el resultado de --output-last-message', async () => {
  const dir = prepare('codex', 'ok-codex')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.equal(s.session_id, '01a0d50b-9af4-7e53-b865-7e4250ac277a')
})

test('Codex sin auth es launch_failed por auth', async () => {
  const s = await supervise(prepare('codex', 'no-auth-codex'))
  assert.equal(s.state, 'launch_failed')
  assert.equal(s.reason, 'auth')
})

test('Claude que sale limpio sin resultado es failed por empty_result', async () => {
  const s = await supervise(prepare('claude', 'empty-claude'))
  assert.equal(s.state, 'failed')
  assert.equal(s.reason, 'empty_result')
})

test('el tope mata el grupo', async () => {
  const dir = prepare('claude', 'hang-child', { deadline_sec: 1, grace_ms: 200 })
  const s = await supervise(dir)
  assert.equal(s.state, 'timeout')
  const pids = readFileSync(join(dir, 'pids'), 'utf8')
  const status = await waitFor(() => {
    const r = spawnSync('ps', ['-p', pids]).status
    return r === 1 ? r : undefined
  }, 2000)
  assert.equal(status, 1)
})

test('una cancelación termina en cancelled', async () => {
  const dir = prepare('claude', 'hang-child')
  const running = supervise(dir)
  const pid = await waitFor(() => (existsSync(join(dir, 'status.json')) ? readStatus(dir).worker_pid : undefined))
  await sleep(300)
  writeFileSync(join(dir, 'cancel.request'), '')
  process.kill(-pid, 'SIGTERM')
  const s = await running
  assert.equal(s.state, 'cancelled')
})

test('una cancelación pedida antes de lanzar no llega a lanzar al worker', async () => {
  const dir = prepare('claude', 'hang-child')
  writeFileSync(join(dir, 'cancel.request'), '')
  const s = await supervise(dir)
  assert.equal(s.state, 'cancelled')
  assert.equal(existsSync(join(dir, 'pids')), false)
})

test('el supervisor atiende una cancelación sin que nadie mate al worker', async () => {
  const dir = prepare('claude', 'hang-child')
  const started = Date.now()
  const running = supervise(dir)
  await waitFor(() => (existsSync(join(dir, 'status.json')) ? readStatus(dir).worker_pid : undefined))
  writeFileSync(join(dir, 'cancel.request'), '')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.ok(Date.now() - started < 5000, 'la cancelación tardó demasiado')
})

test('una cancelación que el worker ignora termina con SIGKILL tras la gracia', async () => {
  const dir = prepare('claude', 'ignore-term', { grace_ms: 200 })
  const started = Date.now()
  const running = supervise(dir)
  await waitFor(() => (existsSync(join(dir, 'status.json')) ? readStatus(dir).worker_pid : undefined))
  writeFileSync(join(dir, 'cancel.request'), '')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.ok(Date.now() - started < 5000, 'el worker que ignora SIGTERM siguió vivo')
})

test('un CLI que no existe es launch_failed por cli_missing', async () => {
  const dir = prepare('claude', 'ok-claude')
  const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as ArgvFile
  writeJsonAtomic(join(dir, 'argv.json'), { ...argv, launch: { ...argv.launch, cmd: '/no/existe/claude', args: [] } })
  const s = await supervise(dir)
  assert.equal(s.state, 'launch_failed')
  assert.equal(s.reason, 'cli_missing')
})

test('un rechazo de modelo en Claude se reintenta una vez sin el campo y termina en done', async () => {
  const dir = prepareWith('claude', 'reject-model-claude', ['--model', 'no-existe', '--session-id', 's1'])
  const s = await supervise(dir)
  const [first, second] = calls(dir)
  assert.equal(calls(dir).length, 2)
  assert.equal(first.includes('--model'), true)
  assert.equal(second.includes('--model'), false)
  assert.notEqual(second[second.indexOf('--session-id') + 1], 's1')
  assert.equal(s.state, 'done')
  assert.equal(s.result_file, 'result-2.md')
  assert.equal(readFileSync(join(dir, 'result-2.md'), 'utf8'), 'ok')
  const { diagnostic, ...rest } = s.retry ?? { diagnostic: '' }
  assert.deepEqual(rest, { field: 'model', requested: 'no-existe', effective: 'claude-haiku-4-5-20251001' })
  assert.match(diagnostic, /issue with the selected model \(no-existe-xyz\)/)
  assert.equal(existsSync(join(dir, 'argv-2.json')), true)
  assert.equal(existsSync(join(dir, 'stdout-2.log')), true)
})

test('un rechazo de esfuerzo en Codex se reintenta una vez sin el campo y termina en done', async () => {
  const dir = prepareWith('codex', 'reject-effort-codex', ['-c', 'model_reasoning_effort=max'])
  const s = await supervise(dir)
  const c = calls(dir)
  assert.equal(c.length, 2)
  assert.equal(c[1].includes('-c') || c[1].includes('model_reasoning_effort=max'), false)
  assert.equal(s.state, 'done')
  assert.equal(c[1][c[1].indexOf('--output-last-message') + 1], join(dir, 'result-2.md'))
  assert.equal(s.result_file, 'result-2.md')
  const { diagnostic, ...rest } = s.retry ?? { diagnostic: '' }
  assert.deepEqual(rest, { field: 'effort', requested: 'max', effective: 'default del CLI' })
  assert.match(diagnostic, /Supported values are/)
})

test('un segundo rechazo no tiene tercer intento', async () => {
  const dir = prepareWith('codex', 'always-reject-model-codex', ['-m', 'x'])
  const s = await supervise(dir)
  assert.equal(calls(dir).length, 2)
  assert.deepEqual([s.state, s.reason], ['launch_failed', 'model_rejected'])
  assert.deepEqual([s.retry?.field, s.retry?.requested], ['model', 'x'])
})

test('un rechazo sin el campo en el argv no se reintenta', async () => {
  const dir = prepare('codex', 'always-reject-model-codex')
  const s = await supervise(dir)
  assert.equal(calls(dir).length, 1)
  assert.deepEqual([s.state, s.reason], ['launch_failed', 'model_rejected'])
  assert.equal(s.retry, undefined)
})

/** Corrida con el CLI falso lanzado por su nombre, para que los argv tengan la forma real de cada familia. */
function prepareCli(family: Family, mode: string, args: (dir: string) => string[], over: Partial<ArgvFile> = {}): string {
  const dir = createRun(makeRepo(), 'r')
  writeFileSync(join(dir, 'prompt.md'), 'encargo')
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  makeFakeBin(bin, family)
  const argv: ArgvFile = {
    family, launch: { cmd: join(bin, family), args: args(dir), cwd: dir, stdinFile: join(dir, 'prompt.md') },
    deadline_sec: 1, grace_ms: 200, resume_sec: 5, ...over,
  }
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  process.env.FAKE_MODE = mode
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  return dir
}

const codexArgs = (dir: string) => [
  'exec', '--ignore-user-config', '-s', 'read-only', '-C', dir, '--json', '--output-last-message', join(dir, 'result.md'), '-',
]

test('un timeout con sesión reanuda una vez y termina en done', async () => {
  const dir = prepareCli('claude', 'hang-unless-resume-claude', () => ['-p', '--session-id', 's1'])
  const s = await supervise(dir)
  const [first, second] = calls(dir)
  assert.equal(calls(dir).length, 2)
  assert.equal(first.includes('--resume'), false)
  assert.deepEqual(second, ['-p', '--resume', 's1'])
  assert.equal(s.state, 'done')
  assert.deepEqual([s.resume?.session_id, s.resume?.outcome], ['s1', 'done'])
  assert.equal(s.result_file, 'result-resume.md')
  assert.equal(readFileSync(join(dir, 'result-resume.md'), 'utf8'), 'ok')
  assert.equal(existsSync(join(dir, 'result.md')), false, 'el intento que se colgó no dejó respuesta')
})

test('Codex reanuda con exec resume, sin -C ni -s', async () => {
  const dir = prepareCli('codex', 'hang-unless-resume-codex', codexArgs)
  const s = await supervise(dir)
  const second = calls(dir)[1]
  assert.equal(s.state, 'done')
  assert.deepEqual(second.slice(0, 2), ['exec', 'resume'])
  assert.equal(second.includes('-C') || second.includes('-s'), false)
  assert.equal(second.includes('sandbox_mode="read-only"'), true)
  assert.deepEqual(second.slice(-2), ['T1', '-'])
  assert.equal(s.result_file, 'result-resume.md')
  assert.equal(readFileSync(join(dir, 'result-resume.md'), 'utf8'), 'ok')
})

test('una reanudación de Codex guarda en metrics.json solo su propio consumo', async () => {
  const dir = prepareCli('codex', 'usage-then-hang-unless-resume-codex', codexArgs)
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  const metrics = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'))
  assert.deepEqual(metrics.attempts.map((a: { usage: unknown }) => a.usage), [
    { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 5 },
    { input_tokens: 15, cache_read_input_tokens: 6, output_tokens: 3 },
  ])
})

test('una reanudación de Codex sin el hilo en el stream guarda solo su propio consumo', async () => {
  // El argv ya reanuda el hilo T1, como una corrida encadenada: el stream no lo vuelve a informar.
  const dir = prepareCli('codex', 'resumed-usage-then-hang-codex', (d) => [
    'exec', 'resume', '--json', '--output-last-message', join(d, 'result.md'), '-c', 'sandbox_mode="read-only"', 'T1', '-',
  ])
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.deepEqual(calls(dir).map((c) => c.slice(0, 2)), [['exec', 'resume'], ['exec', 'resume']])
  assert.deepEqual(metrics(dir).attempts.map((a: { usage: unknown }) => a.usage), [
    { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 5 },
    { input_tokens: 15, cache_read_input_tokens: 6, output_tokens: 3 },
  ])
})

test('una reanudación que también se agota termina en timeout con la sesión', async () => {
  process.env.FAKE_FAMILY = 'claude'
  const dir = prepareCli('claude', 'hang-always-session', () => ['-p', '--session-id', 's1'], { resume_sec: 1 })
  const s = await supervise(dir)
  assert.equal(calls(dir).length, 2)
  assert.equal(s.state, 'timeout')
  assert.equal(s.resume?.outcome, 'timeout')
  assert.ok(s.session_id)
})

test('una reanudación que falla termina en timeout con la sesión', async () => {
  const dir = prepareCli('claude', 'hang-unless-resume-fail', () => ['-p', '--session-id', 's1'])
  const s = await supervise(dir)
  assert.equal(calls(dir).length, 2)
  assert.equal(s.state, 'timeout')
  assert.equal(s.session_id, 's1')
  assert.ok(s.resume?.outcome !== undefined && s.resume.outcome !== 'done')
})

test('sin sesión no se reanuda', async () => {
  const dir = prepareCli('claude', 'hang-child', () => ['-p'])
  const s = await supervise(dir)
  assert.equal(calls(dir).length, 1)
  assert.equal(s.state, 'timeout')
  assert.equal(s.resume, undefined)
})

test('una corrida cancelada no se reanuda', async () => {
  process.env.FAKE_FAMILY = 'claude'
  const dir = prepareCli('claude', 'hang-always-session', () => ['-p', '--session-id', 's1'], { deadline_sec: 30 })
  const running = supervise(dir)
  await waitFor(() => (existsSync(join(dir, 'calls')) ? true : undefined))
  writeFileSync(join(dir, 'cancel.request'), 'ya')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.equal(calls(dir).length, 1)
})

const metrics = (dir: string) => JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'))

test('metrics.json registra cada intento con su duración, prompt y tokens', async () => {
  const dir = prepare('claude', 'ok-claude')
  await supervise(dir)
  const m = metrics(dir)
  assert.equal(m.attempts.length, 1)
  const [a] = m.attempts
  assert.equal(a.kind, 'initial')
  assert.equal(a.outcome, 'done')
  assert.equal(a.prompt_bytes, Buffer.byteLength('encargo'))
  assert.ok(Number.isInteger(a.duration_ms) && a.duration_ms >= 0)
  assert.equal(a.usage.output_tokens, 46)
  for (const p of Object.values(a.raw) as string[]) assert.equal(existsSync(join(dir, p)), true, p)
  assert.deepEqual([m.totals.attempts, m.totals.inadmissible], [1, 0])
})

test('metrics.json distingue el reintento de perfil y la reanudación', async () => {
  const retry = prepareWith('claude', 'reject-model-claude', ['--model', 'no-existe', '--session-id', 's1'])
  await supervise(retry)
  assert.deepEqual(metrics(retry).attempts.map((a: { kind: string }) => a.kind), ['initial', 'profile_retry'])
  const resumed = prepareCli('claude', 'hang-unless-resume-claude', () => ['-p', '--session-id', 's1'])
  await supervise(resumed)
  const kinds = metrics(resumed).attempts.map((a: { kind: string; outcome: string }) => [a.kind, a.outcome])
  assert.deepEqual(kinds, [['initial', 'timeout'], ['resume', 'done']])
})

const HASH = `sha256:${'a'.repeat(64)}`
const BASE_PATH = process.env.PATH ?? ''
const BASE_TMP = tmpdir()

/**
 * El CLI falso por su nombre al principio del PATH, como lo lanza el supervisor, y un temporal del
 * sistema propio para ver qué quedó en él.
 */
function isolate(family: Family): string {
  const bin = mkdtempSync(join(BASE_TMP, 'sdd-ai-bin-'))
  makeFakeBin(bin, family)
  process.env.PATH = `${bin}:${BASE_PATH}`
  const tmp = mkdtempSync(join(BASE_TMP, 'sdd-ai-tmp-'))
  process.env.TMPDIR = tmp
  return tmp
}
const scratches = (tmp: string) => readdirSync(tmp).filter((n) => n.startsWith('sdd-ai-review-'))
const resolution = (family: Family, more: Partial<Resolution> = {}): Resolution =>
  ({ family, via: 'process', origin: { model: 'heredado', effort: 'heredado' }, ...more })

/** Corrida de revisión con un candidato fijo de una ruta y un solo trabajo de la base. */
function prepareReview(family: Family, mode: string, pad = 0): string {
  const dir = createRun(makeRepo(), 'r')
  const c: Candidate = {
    base_sha: 'b'.repeat(40), head_sha: null, hash: HASH, left_out: [], context: [], diff: 'diff --git a/a.txt b/a.txt\n',
    files: [{ path: 'a.txt', status: 'M', mode: '100644', sha256: 'x', binary: false, lines: 3, visible: [[1, 3]] }],
  }
  writeJsonAtomic(join(dir, 'candidate.json'), c)
  const prompt = join(dir, 'prompt-l1-base-b1.md')
  writeFileSync(prompt, renderReviewPrompt(c, new Map()) + 'x'.repeat(pad))
  isolate(family)
  const argv: ArgvFile = {
    family, kind: 'review', candidate: join(dir, 'candidate.json'), deadline_sec: 30, resume_sec: 5, round: 1, tag: '', launch_n: 1,
    reviewer_resolution: resolution(family), jobs: [{ key: 'base-b1', reviewer: 'base', batch: 1, paths: ['a.txt'], prompt }],
  }
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  writeJsonAtomic(join(dir, 'resolved.json'), resolution(family))
  process.env.FAKE_MODE = mode
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  return dir
}

const readRunJson = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const session = (args: string[]) => args[args.indexOf('--session-id') + 1]

test('una revisión admitida deja veredicto y recibo, y el recibo no autoriza nada', async () => {
  const dir = prepareReview('claude', 'review-ok')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.deepEqual(readRunJson(dir, 'verdict.json'), { scope: 'ok', spec: 'ok', quality: 'ok', findings: [], out_of_scope: [] })
  assert.deepEqual(readRunJson(dir, 'ledger.json'), { completed: 1, next_id: 1, entries: [] })
  const r = readRunJson(dir, 'receipt.json')
  assert.equal(r.candidate_hash, HASH)
  assert.deepEqual([r.reviewer.family, r.reviewer.model_effective], ['claude', 'claude-falso'])
  assert.deepEqual(r.tool_events, [])
  assert.match(r.note, /no autoriza commit ni push/)
  assert.equal(metrics(dir).attempts[0].admission, 'ok')
  assert.equal(s.result_file, undefined, 'una revisión no apunta a un resultado')
})

test('un revisor que declara que no pudo inspeccionar deja la ronda unavailable sin reintento', async () => {
  const dir = prepareReview('codex', 'review-unavailable')
  const s = await supervise(dir)
  assert.deepEqual([s.state, s.reason, s.detail], ['unavailable', 'jobs_incomplete', 'base-b1: unavailable/reviewer_unavailable'])
  const [job] = readRunJson(dir, 'rounds.json').rounds[0].jobs
  assert.deepEqual([job.key, job.state, job.reason, job.detail], ['base-b1', 'unavailable', 'reviewer_unavailable', 'no pude'])
  assert.equal(calls(dir).length, 1)
})

test('una respuesta inadmisible se corrige una vez, en una sesión nueva de Claude', async () => {
  const dir = prepareReview('claude', 'review-bad-then-ok')
  const s = await supervise(dir)
  const [first, second] = calls(dir)
  assert.equal(s.state, 'done')
  assert.equal(calls(dir).length, 2)
  assert.notEqual(session(second), session(first))
  assert.match(readFileSync(join(dir, 'prompt-l1-base-b1-fix.md'), 'utf8'), /CORRECCIÓN[\s\S]*exactamente un objeto JSON/)
  const m = metrics(dir)
  assert.deepEqual(m.attempts.map((a: { kind: string }) => a.kind), ['initial', 'correction'])
  assert.match(m.attempts[0].admission, /^inadmissible: /)
  assert.equal(m.attempts[1].admission, 'ok')
  assert.equal(m.totals.inadmissible, 1)
  assert.deepEqual(m.attempts.map((a: { raw: { result: string } }) => a.raw.result), ['result-l1-base-b1.md', 'result-l1-base-b1-fix.md'])
  assert.notEqual(readFileSync(join(dir, 'result-l1-base-b1.md'), 'utf8'), readFileSync(join(dir, 'result-l1-base-b1-fix.md'), 'utf8'))
})

test('la corrección de Codex es un exec nuevo, no una reanudación', async () => {
  const dir = prepareReview('codex', 'review-bad-then-ok')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.deepEqual(calls(dir)[1].slice(0, 2), ['exec', '--ignore-user-config'])
  assert.equal(existsSync(join(dir, 'result-l1-base-b1-fix.md')), true)
})

test('dos respuestas inadmisibles dejan la ronda unavailable', async () => {
  const dir = prepareReview('claude', 'review-bad-always')
  const s = await supervise(dir)
  assert.deepEqual([s.state, s.reason, s.detail], ['unavailable', 'jobs_incomplete', 'base-b1: unavailable/inadmissible_twice'])
  assert.equal(calls(dir).length, 2)
})

test('si el prompt corregido no entra en el presupuesto, no se relanza', async () => {
  const probe = prepareReview('claude', 'review-bad-always')
  const size = readFileSync(join(probe, 'prompt-l1-base-b1.md')).length
  const dir = prepareReview('claude', 'review-bad-always', REVIEW_PROMPT_BUDGET - size - 50)
  const s = await supervise(dir)
  assert.deepEqual([s.state, s.detail], ['unavailable', 'base-b1: unavailable/correction_over_budget'])
  assert.equal(calls(dir).length, 1)
})

test('con la reserva, un trabajo medido nunca termina en correction_over_budget', async () => {
  const probe = prepareReview('claude', 'scripted')
  const size = readFileSync(join(probe, 'prompt-l1-base-b1.md')).length
  const dir = prepareReview('claude', 'scripted', REVIEW_PROMPT_BUDGET - CORRECTION_RESERVE - size)
  assert.equal(readFileSync(join(dir, 'prompt-l1-base-b1.md')).length, REVIEW_PROMPT_BUDGET - CORRECTION_RESERVE)
  writeJsonAtomic(join(dir, 'answers.json'), [
    `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":["a.txt","${'x'.repeat(10000)}"]},"findings":[]}`,
    `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":[]}`,
  ])
  process.env.FAKE_ANSWERS = join(dir, 'answers.json')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.equal(calls(dir).length, 2)
  assert.match(readFileSync(join(dir, 'prompt-l1-base-b1-fix.md'), 'utf8'), /motivo recortado/)
})

test('cleanEnv quita las señales de sesión del conductor y marca al worker', () => {
  const env = cleanEnv({
    PATH: 'p', HOME: 'h', CLAUDECODE: '1', CLAUDE_EFFORT: 'x', CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 't',
    CODEX_SESSION_ID: 's', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_CI: '1', CODEX_HOME: 'c',
  })
  assert.deepEqual(env, { PATH: 'p', HOME: 'h', CODEX_HOME: 'c', SDD_AI_WORKER: '1' })
})

const ROUND_CANDIDATE: Candidate = {
  base_sha: 'b'.repeat(40), head_sha: null, hash: HASH, left_out: [], context: [], diff: 'diff --git a/a.txt b/a.txt\n',
  files: [{ path: 'a.txt', status: 'M', mode: '100644', sha256: 'x', binary: false, lines: 3, visible: [[1, 3]] }],
}
/** Dos archivos para repartir en dos lotes. */
const TWO: Candidate = {
  ...ROUND_CANDIDATE, diff: 'diff --git a/a.txt b/a.txt\ndiff --git a/b.txt b/b.txt\n',
  files: [...ROUND_CANDIDATE.files, { path: 'b.txt', status: 'M', mode: '100644', sha256: 'y', binary: false, lines: 3, visible: [[1, 3]] }],
}
const inferential = { axis: 'quality', severity: 'CRITICAL', location: 'a.txt:2', claim: 'puede fallar con una lista vacía', causality: 'introduced', evidence: 'inferential' }
const deterministic = { ...inferential, claim: 'la línea 2 no valida', evidence: 'deterministic' }
const firstRound = (findings: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)}}`
const nextRound = (responses: unknown[], findings: unknown[] = []) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"responses":${JSON.stringify(responses)},"findings":${JSON.stringify(findings)}}`
const refutation = (results: unknown[]) => `{"candidate_hash":"$HASH","results":${JSON.stringify(results)}}`

interface JobSpec { key: string; reviewer: Reviewer; batch: number; paths: string[] }
interface RoundSetup {
  round?: number; ledger?: Ledger; plan?: RoundPlan; deadline_sec?: number; resume_sec?: number
  candidate?: Candidate; jobs?: JobSpec[]; launch?: number
  /** El repo de un candidato congelado de verdad: sus blobs quedan en la corrida, como los deja la CLI. */
  repo?: string
}

/**
 * Una ronda preparada como la deja la CLI: candidato, material, un prompt por trabajo, y revisor y
 * refutador resueltos a la familia del CLI falso guionado.
 */
function prepareRound(family: Family, answers: string[], o: RoundSetup = {}): { dir: string; argvName: string; tmp: string } {
  const dir = createRun(makeRepo(), 'r')
  const n = o.round ?? 1
  const tag = n === 1 ? '' : `-r${n}`
  const k = o.launch ?? 1
  const c = o.candidate ?? ROUND_CANDIDATE
  writeJsonAtomic(join(dir, `candidate${tag}.json`), c)
  if (o.repo) snapshot(o.repo, c, dir)
  const material = renderMaterial(c, new Map())
  const specs = o.jobs ?? [{ key: 'base-b1', reviewer: 'base', batch: 1, paths: c.files.map((f) => f.path) }]
  const jobs = specs.map((j) => {
    const view = j.paths.length === c.files.length ? undefined : sliceCandidate(c, j.paths)
    const text = o.plan && o.ledger
      ? renderRoundPrompt(c, view ? renderMaterial(c, new Map(), view) : material, o.plan, o.ledger.entries, 3, view ? j.paths : undefined)
      : renderReviewPrompt(c, new Map(), { reviewer: j.reviewer, ...(view ? { view } : {}) })
    const prompt = join(dir, `prompt${tag}-l${k}-${j.key}.md`)
    writeFileSync(prompt, text)
    return { ...j, prompt }
  })
  if (o.ledger) writeJsonAtomic(join(dir, 'ledger.json'), o.ledger)
  if (o.plan) writeJsonAtomic(join(dir, `round${tag}.json`), o.plan)
  writeJsonAtomic(join(dir, 'request.json'), { kind: 'review', selection: { base: 'main', context: [] }, author: opposite(family), degradations: [] })
  const reviewer = resolution(family, { model: 'm', effort: 'high', origin: { model: 'workers', effort: 'workers' } })
  writeJsonAtomic(join(dir, 'resolved.json'), reviewer)
  const tmp = isolate(family)
  const argvName = `argv${tag}-l${k}.json`
  const argv: ArgvFile = {
    family, kind: 'review', candidate: join(dir, `candidate${tag}.json`), deadline_sec: o.deadline_sec ?? 30, grace_ms: 200,
    resume_sec: o.resume_sec ?? 5, round: n, tag, launch_n: k,
    reviewer_resolution: reviewer, refuter_resolution: resolution(family), jobs, ...(o.plan ? { plan: join(dir, `round${tag}.json`) } : {}),
  }
  writeJsonAtomic(join(dir, argvName), argv)
  writeJsonAtomic(join(dir, 'answers.json'), answers)
  process.env.FAKE_MODE = 'scripted'
  process.env.FAKE_ANSWERS = join(dir, 'answers.json')
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  return { dir, argvName, tmp }
}

const ledgerOf = (dir: string): Ledger => readRunJson(dir, 'ledger.json')
const kinds = (dir: string) => metrics(dir).attempts.map((a: { kind: string; round: number; suffix: string }) => [a.round, a.kind, a.suffix])
const cwds = (dir: string) => readFileSync(join(dir, 'calls.cwd'), 'utf8').trim().split('\n')
const twoLots: JobSpec[] = [{ key: 'base-b1', reviewer: 'base', batch: 1, paths: ['a.txt'] }, { key: 'base-b2', reviewer: 'base', batch: 2, paths: ['b.txt'] }]

for (const family of ['claude', 'codex'] as const) {
  test(`${family}: un grave inferencial de la ronda 1 va al refutador, y refuted lo deja refutado`, async () => {
    const { dir, argvName } = prepareRound(family, [
      firstRound([inferential, deterministic]),
      refutation([{ id: 'F-1', result: 'refuted', evidence: 'a.txt:1', note: 'la guarda está en la línea 1' }]),
    ])
    const s = await supervise(dir, argvName)
    assert.equal(s.state, 'done')
    const l = ledgerOf(dir)
    assert.deepEqual(l.entries.map((e) => [e.id, e.state]), [['F-1', 'refutado'], ['F-2', 'abierto']])
    assert.deepEqual(l.entries[0].refutation, { result: 'refuted', evidence: 'a.txt:1', note: 'la guarda está en la línea 1' })
    const refutePrompt = readFileSync(join(dir, 'prompt-l1-refute-s1.md'), 'utf8')
    assert.match(refutePrompt, /refutador aislado/)
    assert.ok(refutePrompt.includes('"F-1"') && !refutePrompt.includes('"F-2"'))
    assert.deepEqual(kinds(dir), [[1, 'initial', ''], [1, 'refutation', '']])
    if (family === 'claude') assert.equal(calls(dir)[1][calls(dir)[1].indexOf('--system-prompt') + 1], REFUTER_SYSTEM_PROMPT)
    const round = readRunJson(dir, 'rounds.json').rounds[0]
    assert.deepEqual([round.n, round.state, round.refutation.ids, round.refutation.outcome], [1, 'done', ['F-1'], 'admitted'])
    assert.deepEqual(round.refutation.tool_events, [])
    assert.equal(readRunJson(dir, 'verdict.json').quality, 'fail')
  })
}

test('sin graves inferenciales no hay refutación', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([deterministic])])
  await supervise(dir, argvName)
  assert.equal(calls(dir).length, 1)
  assert.equal(existsSync(join(dir, 'prompt-l1-refute-s1.md')), false)
  assert.equal(readRunJson(dir, 'rounds.json').rounds[0].refutation, undefined)
})

test('un refutador que falla deja la tanda inconclusive, nunca refutada', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([inferential]), '__fail__'])
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  const [e] = ledgerOf(dir).entries
  assert.equal(e.state, 'abierto')
  assert.equal(e.refutation?.result, 'inconclusive')
  assert.match(e.refutation?.reason ?? '', /failed/)
  assert.equal(readRunJson(dir, 'rounds.json').rounds[0].refutation.outcome, 'inconclusive')
})

test('un refutador que se agota deja la tanda inconclusive por timeout, sin reanudarse', async () => {
  const { dir, argvName } = prepareRound('codex', [firstRound([inferential]), '__hang__'], { deadline_sec: 1 })
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.equal(calls(dir).length, 2)
  assert.deepEqual(ledgerOf(dir).entries[0].refutation, { result: 'inconclusive', reason: 'timeout' })
})

test('un refutador inadmisible dos veces deja la tanda inconclusive', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([inferential]), 'no sé', 'tampoco'])
  await supervise(dir, argvName)
  assert.deepEqual(kinds(dir), [[1, 'initial', ''], [1, 'refutation', ''], [1, 'refutation', '-fix']])
  assert.ok(readFileSync(join(dir, 'prompt-l1-refute-s1-fix.md'), 'utf8').startsWith(readFileSync(join(dir, 'prompt-l1-refute-s1.md'), 'utf8')))
  assert.deepEqual(ledgerOf(dir).entries[0].refutation, { result: 'inconclusive', reason: 'inadmissible_twice' })
})

test('cancel en la refutación deja la ronda cancelled con su ledger', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([inferential, { ...inferential, location: 'a.txt:3' }]), '__hang__'])
  const running = supervise(dir, argvName)
  await waitFor(() => (existsSync(join(dir, 'calls')) && calls(dir).length === 2 ? true : undefined))
  await sleep(200)
  writeFileSync(join(dir, 'cancel.request'), 'ya')
  const s = await running
  assert.equal(s.state, 'cancelled')
  const l = ledgerOf(dir)
  assert.equal(l.completed, 1)
  assert.deepEqual(l.entries.map((e) => [e.id, e.refutation]), [
    ['F-1', { result: 'inconclusive', reason: 'cancelled' }], ['F-2', { result: 'inconclusive', reason: 'cancelled' }],
  ])
  assert.equal(readRunJson(dir, 'receipt.json').candidate_hash, HASH)
  const round = readRunJson(dir, 'rounds.json').rounds[0]
  assert.deepEqual([round.state, round.refutation.outcome, round.refutation.reason], ['cancelled', 'inconclusive', 'cancelled'])
})

/** Ledger después de una ronda 1 con dos graves deterministas: F-1 aceptado y F-2 rechazado. */
function roundTwo(): { ledger: Ledger; plan: RoundPlan } {
  const opened = openLedger([deterministic, { ...deterministic, axis: 'scope' }] as Parameters<typeof openLedger>[0])
  const ledger = decide(decide(opened, 'accept', ['F-1']), 'reject', ['F-2'], 'es intencional')
  const plan: RoundPlan = { n: 2, prev_hash: `sha256:${'0'.repeat(64)}`, identical: false, targets: targets(ledger), changed: { 'a.txt': [[2, 2]] } }
  return { ledger, plan }
}
const answered = [{ id: 'F-1', answer: 'resolved' }, { id: 'F-2', answer: 'withdrawn' }]

test('la ronda 2 escribe sus archivos con -r2 y su lanzamiento, aplica las respuestas y abre las regresiones', async () => {
  const { ledger, plan } = roundTwo()
  const { dir, argvName } = prepareRound('claude', [nextRound(answered, [{ ...deterministic, severity: 'WARNING', claim: 'regresión' }])], { round: 2, ledger, plan })
  const s = await supervise(dir, argvName)
  assert.deepEqual([s.state, s.round], ['done', 2])
  for (const f of ['stdout-r2-l1-base-b1.log', 'stderr-r2-l1-base-b1.log', 'result-r2-l1-base-b1.md', 'admitted-r2-l1-base-b1.json']) {
    assert.equal(existsSync(join(dir, f)), true, f)
  }
  for (const f of ['stdout.log', 'result.md', 'result-r2.md']) assert.equal(existsSync(join(dir, f)), false, f)
  const l = ledgerOf(dir)
  assert.deepEqual(l.entries.map((e) => [e.id, e.state, e.round]), [['F-1', 'resuelto', 1], ['F-2', 'cerrado', 1], ['F-3', 'abierto', 2]])
  assert.deepEqual([l.entries[2].reviewer, l.entries[2].batch], ['base', 1])
  assert.equal(l.completed, 2)
  const r = readRunJson(dir, 'rounds.json').rounds
  assert.deepEqual(r.map((x: { n: number; tag: string; state: string; launch: number }) => [x.n, x.tag, x.state, x.launch]), [[2, '-r2', 'done', 1]])
  assert.deepEqual(kinds(dir), [[2, 'initial', '']])
})

test('la corrección de la ronda 2 parte del prompt de su trabajo', async () => {
  const { ledger, plan } = roundTwo()
  const { dir, argvName } = prepareRound('codex', ['sin JSON', nextRound(answered)], { round: 2, ledger, plan })
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.ok(readFileSync(join(dir, 'prompt-r2-l1-base-b1-fix.md'), 'utf8').startsWith(readFileSync(join(dir, 'prompt-r2-l1-base-b1.md'), 'utf8')))
  assert.equal(existsSync(join(dir, 'result-r2-l1-base-b1-fix.md')), true)
  assert.equal(existsSync(join(dir, 'prompt-fix.md')), false)
  assert.equal(ledgerOf(dir).entries[0].state, 'resuelto')
})

test('una ronda 2 que agota el tope se reanuda con el resume de su trabajo', async () => {
  const { ledger, plan } = roundTwo()
  // La reanudación solo recibe el mensaje de cierre: la respuesta guionada lleva el hash y las rutas literales.
  const literal = nextRound(answered).replace('$HASH', HASH).replace('$PATHS', '["a.txt"]')
  const { dir, argvName } = prepareRound('claude', ['__hang__', literal], { round: 2, ledger, plan, deadline_sec: 1 })
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.equal(s.resume?.outcome, 'done')
  assert.match(readFileSync(join(dir, 'resume-r2-l1-base-b1.md'), 'utf8'), /Se agotó el tiempo/)
  assert.equal(existsSync(join(dir, 'argv-r2-l1-base-b1-resume.json')), true)
  assert.deepEqual(kinds(dir), [[2, 'initial', ''], [2, 'resume', '-resume']])
  assert.equal(ledgerOf(dir).entries[0].state, 'resuelto')
})

test('una ronda 2 unavailable no cambia el ledger y queda registrada', async () => {
  const { ledger, plan } = roundTwo()
  const { dir, argvName } = prepareRound('claude', [
    '{"candidate_hash":"$HASH","inspection":{"status":"unavailable","paths":[],"reason":"no pude"},"responses":[],"findings":[]}',
  ], { round: 2, ledger, plan })
  const before = readFileSync(join(dir, 'ledger.json'), 'utf8')
  const s = await supervise(dir, argvName)
  assert.deepEqual([s.state, s.reason], ['unavailable', 'jobs_incomplete'])
  assert.equal(readFileSync(join(dir, 'ledger.json'), 'utf8'), before)
  assert.deepEqual(readRunJson(dir, 'rounds.json').rounds.map((x: { n: number; state: string }) => [x.n, x.state]), [[2, 'unavailable']])
})

test('el recibo lista cada ronda con su candidato, e incluye el ledger y la nota', async () => {
  const { ledger, plan } = roundTwo()
  const { dir, argvName } = prepareRound('claude', [nextRound(answered)], { round: 2, ledger, plan })
  writeJsonAtomic(join(dir, 'rounds.json'), { rounds: [{
    n: 1, tag: '', candidate_hash: `sha256:${'0'.repeat(64)}`, base_sha: 'b'.repeat(40), head_sha: null, state: 'done',
    started_at: 'x', ended_at: 'y', extra: false, model_effective: 'claude-falso', tool_events: [],
  }] })
  await supervise(dir, argvName)
  const r = readRunJson(dir, 'receipt.json')
  assert.deepEqual(r.rounds.map((x: { n: number; candidate_hash: string }) => [x.n, x.candidate_hash]), [[1, `sha256:${'0'.repeat(64)}`], [2, HASH]])
  assert.equal(r.candidate_hash, HASH)
  assert.deepEqual(r.ledger.entries.map((e: { state: string }) => e.state), ['resuelto', 'cerrado'])
  assert.deepEqual(r.axes, { scope: 'ok', spec: 'ok', quality: 'ok' })
  assert.deepEqual([r.reviewer.family, r.reviewer.model_requested, r.reviewer.model_effective], ['claude', 'm', 'claude-falso'])
  assert.match(r.note, /no autoriza commit ni push/)
})

test('los trabajos corren en serie, cada uno con su propio plazo', async () => {
  const { dir, argvName } = prepareRound('claude', ['__hang__', '__hang__', firstRound([])],
    { candidate: TWO, jobs: twoLots, deadline_sec: 1, resume_sec: 1 })
  const s = await supervise(dir, argvName)
  const attempts = metrics(dir).attempts as Array<{ batch: number; kind: string; started_at: string; ended_at: string }>
  const firstEnd = Math.max(...attempts.filter((a) => a.batch === 1).map((a) => Date.parse(a.ended_at)))
  const secondStart = attempts.find((a) => a.batch === 2)?.started_at ?? ''
  assert.ok(Date.parse(secondStart) >= firstEnd, 'el segundo empezó después de que terminó el primero')
  assert.ok(Date.parse(secondStart) - Date.parse(attempts[0].started_at) > 1000, 'el primero consumió más que un plazo')
  const jobs = readRunJson(dir, 'rounds.json').rounds[0].jobs
  assert.deepEqual(jobs.map((j: { key: string; state: string }) => [j.key, j.state]), [['base-b1', 'timeout'], ['base-b2', 'done']])
  assert.ok(jobs[1].admitted)
  assert.deepEqual([s.state, s.reason, s.detail], ['unavailable', 'jobs_incomplete', 'base-b1: timeout, base-b2: done'])
})

test('cancel detiene el trabajo en curso y no lanza los demás', async () => {
  const { dir, argvName } = prepareRound('claude', ['__hang__', firstRound([])], { candidate: TWO, jobs: twoLots })
  const running = supervise(dir, argvName)
  await waitFor(() => (existsSync(join(dir, 'calls')) ? true : undefined))
  await sleep(200)
  writeFileSync(join(dir, 'cancel.request'), 'ya')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.equal(calls(dir).length, 1)
  const round = readRunJson(dir, 'rounds.json').rounds[0]
  assert.deepEqual([round.state, round.jobs.map((j: { key: string; state: string }) => [j.key, j.state])], ['cancelled', [['base-b1', 'cancelled']]])
})

test('un trabajo no admitido deja la ronda unavailable y los demás corren', async () => {
  const { dir, argvName } = prepareRound('claude', ['__fail__', firstRound([{ ...deterministic, location: 'b.txt:2' }])], { candidate: TWO, jobs: twoLots })
  const s = await supervise(dir, argvName)
  assert.equal(calls(dir).length, 2)
  assert.deepEqual([s.state, s.reason, s.detail], ['unavailable', 'jobs_incomplete', 'base-b1: launch_failed/unknown, base-b2: done'])
  const jobs = readRunJson(dir, 'rounds.json').rounds[0].jobs
  assert.deepEqual(jobs.map((j: { key: string; state: string; launch: number }) => [j.key, j.state, j.launch]), [['base-b1', 'launch_failed', 1], ['base-b2', 'done', 1]])
  assert.equal(existsSync(join(dir, 'ledger.json')), false)
})

test('cada respuesta se admite contra su lote: exactamente sus rutas', async () => {
  const wrong = '{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":["a.txt","b.txt"]},"findings":[]}'
  const { dir, argvName } = prepareRound('claude', [firstRound([]), wrong, wrong], { candidate: TWO, jobs: twoLots })
  const s = await supervise(dir, argvName)
  assert.deepEqual([s.state, s.detail], ['unavailable', 'base-b1: done, base-b2: unavailable/inadmissible_twice'])
  const prompts = ['prompt-l1-base-b1.md', 'prompt-l1-base-b2.md'].map((f) => readFileSync(join(dir, f), 'utf8'))
  assert.ok(prompts[0].includes('\nLOTE: a.txt\n') && prompts[1].includes('\nLOTE: b.txt\n'))
  assert.match(metrics(dir).attempts[1].admission, /inspection\.paths trae rutas que no son del candidato: a\.txt/)
})

test('contra su lote, una cita a un archivo de otro lote se rechaza', async () => {
  const other = firstRound([{ ...deterministic, location: 'b.txt:2' }])
  const { dir, argvName } = prepareRound('claude', [other, other, firstRound([])], { candidate: TWO, jobs: twoLots })
  const s = await supervise(dir, argvName)
  assert.deepEqual([s.state, s.detail], ['unavailable', 'base-b1: unavailable/inadmissible_twice, base-b2: done'])
  assert.match(metrics(dir).attempts[0].admission, /b\.txt:2 apunta a una ruta que no está en el candidato/)
})

test('el ledger se abre solo cuando todos los trabajos fueron admitidos', async () => {
  const jobs: JobSpec[] = [
    { key: 'base-b1', reviewer: 'base', batch: 1, paths: ['a.txt'] }, { key: 'base-b2', reviewer: 'base', batch: 2, paths: ['b.txt'] },
    { key: 'risk-b1', reviewer: 'risk', batch: 1, paths: ['a.txt'] }, { key: 'risk-b2', reviewer: 'risk', batch: 2, paths: ['b.txt'] },
  ]
  const at = (claim: string, location: string) => ({ ...deterministic, severity: 'WARNING', claim, location })
  const { dir, argvName } = prepareRound('claude', [
    firstRound([at('base 1', 'a.txt:1')]), firstRound([at('base 2', 'b.txt:1')]),
    firstRound([at('riesgo 1', 'a.txt:2')]), firstRound([at('riesgo 2', 'b.txt:2')]),
  ], { candidate: TWO, jobs })
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.deepEqual(ledgerOf(dir).entries.map((e) => [e.id, e.claim, e.reviewer, e.batch]), [
    ['F-1', 'base 1', 'base', 1], ['F-2', 'base 2', 'base', 2], ['F-3', 'riesgo 1', 'risk', 1], ['F-4', 'riesgo 2', 'risk', 2],
  ])
  assert.equal(readRunJson(dir, 'rounds.json').rounds[0].jobs.length, 4)
})

test('un relanzamiento no pisa logs, prompt, resultado ni argv', async () => {
  const { dir, argvName } = prepareRound('claude', ['__fail__', firstRound([])])
  await supervise(dir, argvName)
  const names = ['stdout-l1-base-b1.log', 'stderr-l1-base-b1.log', 'prompt-l1-base-b1.md', 'argv-l1.json']
  const before = names.map((f) => readFileSync(join(dir, f), 'utf8'))
  const argv = readRunJson(dir, argvName) as ArgvFile
  const prompt = join(dir, 'prompt-l2-base-b1.md')
  writeFileSync(prompt, `${readFileSync(join(dir, 'prompt-l1-base-b1.md'), 'utf8')}\n`)
  writeJsonAtomic(join(dir, 'argv-l2.json'), { ...argv, launch_n: 2, jobs: (argv.jobs ?? []).map((j) => ({ ...j, prompt })) })
  const s = await supervise(dir, 'argv-l2.json')
  assert.equal(s.state, 'done')
  assert.deepEqual(names.map((f) => readFileSync(join(dir, f), 'utf8')), before)
  for (const f of ['stdout-l2-base-b1.log', 'result-l2-base-b1.md', 'admitted-l2-base-b1.json']) assert.equal(existsSync(join(dir, f)), true, f)
  assert.deepEqual(readRunJson(dir, 'rounds.json').rounds.map((r: { launch: number; state: string }) => [r.launch, r.state]), [[1, 'unavailable'], [2, 'done']])
})

test('metrics registra revisor, lote y lanzamiento, y un resultado ausente queda ausente', async () => {
  const { dir, argvName } = prepareRound('claude', ['__fail__'], { launch: 3 })
  await supervise(dir, argvName)
  const [a] = metrics(dir).attempts
  assert.deepEqual([a.reviewer, a.batch, a.launch, a.round], ['base', 1, 3, 1])
  assert.equal(a.raw.result, null)
  assert.equal(existsSync(join(dir, 'result-l3-base-b1.md')), false)
  assert.deepEqual([a.raw.stdout, a.raw.stderr], ['stdout-l3-base-b1.log', 'stderr-l3-base-b1.log'])
})

test('un lanzamiento nunca lee el resultado de otro', async () => {
  const { dir, argvName } = prepareRound('codex', [firstRound([]), '__fail__'])
  assert.equal((await supervise(dir, argvName)).state, 'done')
  const argv = readRunJson(dir, argvName) as ArgvFile
  writeJsonAtomic(join(dir, 'argv-l2.json'), { ...argv, launch_n: 2 })
  const s = await supervise(dir, 'argv-l2.json')
  assert.notEqual(s.state, 'done')
  assert.equal(existsSync(join(dir, 'result-l2-base-b1.md')), false)
  assert.equal(calls(dir)[1][calls(dir)[1].indexOf('--output-last-message') + 1], join(dir, 'result-l2-base-b1.md'))
})

test('cada trabajo borra su temporal al terminar, sea cual sea el final', async () => {
  const jobs: JobSpec[] = [...twoLots, { key: 'risk-b1', reviewer: 'risk', batch: 1, paths: ['a.txt'] }]
  const { dir, argvName, tmp } = prepareRound('claude', [firstRound([]), '__fail__', '__hang__', '__hang__'],
    { candidate: TWO, jobs, deadline_sec: 1, resume_sec: 1 })
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'unavailable')
  assert.equal(calls(dir).length, 4)
  assert.deepEqual(scratches(tmp), [])
  const real = realpathSync(tmp)
  for (const cwd of cwds(dir)) assert.ok(cwd.startsWith(`${real}/sdd-ai-review-`), cwd)
  assert.equal(new Set(cwds(dir)).size, 3, 'la reanudación usa el temporal de su trabajo')
})

test('el refutador no crea temporal si no corre', async () => {
  const { dir, argvName, tmp } = prepareRound('claude', [firstRound([deterministic])])
  await supervise(dir, argvName)
  assert.equal(cwds(dir).length, 1)
  assert.deepEqual(scratches(tmp), [])
})

test('el borrado solo alcanza temporales de sdd-ai', () => {
  const tmp = isolate('claude')
  const other = mkdtempSync(join(tmp, 'otro-'))
  const outside = mkdtempSync(join(makeRepo(), 'sdd-ai-review-'))
  const target = mkdtempSync(join(BASE_TMP, 'sdd-ai-destino-'))
  const link = join(tmp, 'sdd-ai-review-x')
  symlinkSync(target, link)
  const own = mkdtempSync(join(tmp, 'sdd-ai-review-'))
  mkdirSync(join(own, 'adentro'))
  assert.deepEqual([removeScratch(other), removeScratch(outside), removeScratch(link)], [false, false, false])
  assert.deepEqual([existsSync(other), existsSync(outside), existsSync(target)], [true, true, true])
  assert.equal(removeScratch(own), true)
  assert.equal(existsSync(own), false)
})

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
/** Un archivo de unos 120 KB: dos no entran juntos en un prompt. */
const bulky = (tag: string) => Array.from({ length: 1200 }, (_, i) => `${tag} ${String(i + 1).padStart(4, '0')} ${'x'.repeat(90)}`).join('\n').concat('\n')

/** Un candidato congelado de verdad, con dos archivos grandes en dos directorios y, si se pide, un contexto. */
function bulkyCandidate(context?: string): { repo: string; c: Candidate } {
  const repo = makeRepo()
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  mkdirSync(join(repo, 'x'))
  mkdirSync(join(repo, 'y'))
  writeFileSync(join(repo, 'x', 'uno.txt'), bulky('uno'))
  writeFileSync(join(repo, 'y', 'dos.txt'), bulky('dos'))
  git(repo, 'add', '-N', 'x/uno.txt', 'y/dos.txt')
  if (context) writeFileSync(join(repo, 'spec.md'), context)
  return { repo, c: freeze(repo, { base, context: context ? ['spec.md'] : [] }) }
}
const bulkyLots: JobSpec[] = [
  { key: 'base-b1', reviewer: 'base', batch: 1, paths: ['x/uno.txt'] }, { key: 'base-b2', reviewer: 'base', batch: 2, paths: ['y/dos.txt'] },
]
const onUno = { ...inferential, location: 'x/uno.txt:5' }
const onDos = { ...inferential, location: 'y/dos.txt:5' }

test('el refutador recibe el material entero si entra', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'a.txt'), 'uno\ndos\ntres\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'uno\nDOS\ntres\n')
  writeFileSync(join(repo, 'spec.md'), '# spec congelada\n')
  const c = freeze(repo, { base, context: ['spec.md'] })
  const { dir, argvName } = prepareRound('claude', [
    firstRound([inferential]), refutation([{ id: 'F-1', result: 'corroborated', evidence: 'a.txt:2' }]),
  ], { candidate: c, repo })
  writeFileSync(join(repo, 'spec.md'), '# spec cambiada después\n')
  assert.equal((await supervise(dir, argvName)).state, 'done')
  const prompt = readFileSync(join(dir, 'prompt-l1-refute-s1.md'), 'utf8')
  assert.ok(prompt.endsWith(`${renderMaterial(c, new Map([['spec.md', '# spec congelada\n']]))}\n`), 'el material entero, con el contexto de los blobs')
  const r = readRunJson(dir, 'rounds.json').rounds[0].refutation
  assert.deepEqual([r.outcome, r.trimmed, r.batches], ['admitted', false, [{ ids: ['F-1'], paths: ['a.txt'], outcome: 'admitted' }]])
})

test('el refutador parte la tanda por hallazgos cuando no entra', async () => {
  const { repo, c } = bulkyCandidate()
  const { dir, argvName } = prepareRound('claude', [
    firstRound([onUno]), firstRound([onDos]),
    refutation([{ id: 'F-1', result: 'corroborated', evidence: 'x/uno.txt:5' }]), refutation([{ id: 'F-2', result: 'refuted', evidence: 'y/dos.txt:5' }]),
  ], { candidate: c, repo, jobs: bulkyLots })
  assert.equal((await supervise(dir, argvName)).state, 'done')
  const r = readRunJson(dir, 'rounds.json').rounds[0].refutation
  assert.deepEqual([r.outcome, r.trimmed, r.batches], ['admitted', true, [
    { ids: ['F-1'], paths: ['x/uno.txt'], outcome: 'admitted' }, { ids: ['F-2'], paths: ['y/dos.txt'], outcome: 'admitted' },
  ]])
  assert.deepEqual(ledgerOf(dir).entries.map((e) => [e.id, e.state, e.refutation?.result]), [['F-1', 'abierto', 'corroborated'], ['F-2', 'refutado', 'refuted']])
  const first = readFileSync(join(dir, 'prompt-l1-refute-s1.md'), 'utf8')
  assert.ok(first.includes('│diff --git a/x/uno.txt b/x/uno.txt') && !first.includes('│diff --git a/y/dos.txt b/y/dos.txt'))
})

test('en el refutador, un hallazgo que no entra solo queda inconclusive sin lanzarse', async () => {
  const { repo, c } = bulkyCandidate()
  const { dir, argvName } = prepareRound('claude', [
    firstRound([{ ...onUno, claim: 'x'.repeat(100_000) }]), firstRound([onDos]),
    refutation([{ id: 'F-2', result: 'corroborated', evidence: 'y/dos.txt:5' }]),
  ], { candidate: c, repo, jobs: bulkyLots })
  assert.equal((await supervise(dir, argvName)).state, 'done')
  assert.equal(calls(dir).length, 3)
  assert.deepEqual(ledgerOf(dir).entries[0].refutation, { result: 'inconclusive', reason: 'prompt_too_large' })
  const r = readRunJson(dir, 'rounds.json').rounds[0].refutation
  assert.deepEqual([r.outcome, r.batches], ['partial', [
    { ids: ['F-1'], paths: ['x/uno.txt'], outcome: 'inconclusive', reason: 'prompt_too_large' },
    { ids: ['F-2'], paths: ['y/dos.txt'], outcome: 'admitted' },
  ]])
  assert.ok(readFileSync(join(dir, 'prompt-l1-refute-s1.md'), 'utf8').includes('"F-2"'))
})

test('una sub-tanda que falla no vuelve unavailable la ronda', async () => {
  const { repo, c } = bulkyCandidate()
  const { dir, argvName } = prepareRound('claude', [
    firstRound([onUno]), firstRound([onDos]), '__fail__', refutation([{ id: 'F-2', result: 'refuted', evidence: 'y/dos.txt:5' }]),
  ], { candidate: c, repo, jobs: bulkyLots })
  assert.equal((await supervise(dir, argvName)).state, 'done')
  const [f1, f2] = ledgerOf(dir).entries
  assert.deepEqual([f1.state, f1.refutation?.result, f2.state], ['abierto', 'inconclusive', 'refutado'])
  assert.match(f1.refutation?.reason ?? '', /launch_failed/)
  assert.equal(readRunJson(dir, 'rounds.json').rounds[0].refutation.outcome, 'partial')
})

test('el progreso muestra la sub-tanda de refutación en curso', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([inferential]), '__hang__'])
  const running = supervise(dir, argvName)
  const job = await waitFor(() => {
    const j = existsSync(join(dir, 'status.json')) ? readStatus(dir).job : undefined
    return j?.phase === 'refutation' ? j : undefined
  })
  assert.deepEqual(job, { phase: 'refutation', key: 'refute-s1', index: 1, total: 1 })
  writeFileSync(join(dir, 'cancel.request'), 'ya')
  assert.equal((await running).state, 'cancelled')
  assert.equal(readStatus(dir).job, undefined)
})

test('metrics registra cada sub-tanda con su lanzamiento', async () => {
  const { dir, argvName } = prepareRound('claude', [
    firstRound([inferential]), refutation([{ id: 'F-1', result: 'corroborated', evidence: 'a.txt:2' }]),
  ], { launch: 2 })
  await supervise(dir, argvName)
  const [review, refuted] = metrics(dir).attempts
  assert.deepEqual([review.reviewer, review.batch, review.launch], ['base', 1, 2])
  assert.deepEqual([refuted.reviewer, refuted.batch, refuted.launch, refuted.kind], ['refute', 1, 2, 'refutation'])
  assert.deepEqual([refuted.raw.stdout, refuted.raw.result], ['stdout-l2-refute-s1.log', 'result-l2-refute-s1.md'])
})

test('el recibo toma la última ronda que avanzó el ledger', async () => {
  const { ledger, plan } = roundTwo()
  const { dir, argvName } = prepareRound('claude', [nextRound(answered)], { round: 2, ledger, plan })
  const earlier = `sha256:${'0'.repeat(64)}`
  const refuted = { ids: ['F-1'], outcome: 'admitted', tool_events: [], trimmed: false, batches: [] }
  const round1 = {
    n: 1, tag: '', candidate_hash: earlier, base_sha: 'b'.repeat(40), head_sha: null, state: 'done',
    started_at: 'x', ended_at: 'y', extra: false, model_effective: 'claude-falso', tool_events: [], refutation: refuted,
  }
  writeJsonAtomic(join(dir, 'rounds.json'), { rounds: [round1] })
  await supervise(dir, argvName)
  const r = readRunJson(dir, 'receipt.json')
  assert.equal(r.rounds[1].refutation, undefined)
  assert.equal(r.candidate_hash, HASH, 'una ronda terminada sin refutación también avanzó el ledger')
  const later = `sha256:${'9'.repeat(64)}`
  writeJsonAtomic(join(dir, 'rounds.json'), { rounds: [...readRunJson(dir, 'rounds.json').rounds,
    { ...round1, n: 3, candidate_hash: later, state: 'cancelled' }, { ...round1, n: 4, candidate_hash: earlier, state: 'cancelled', refutation: undefined }] })
  writeReceipt(dir)
  assert.equal(readRunJson(dir, 'receipt.json').candidate_hash, later, 'una ronda cancelada en la refutación avanzó el ledger')
})

test('un cancel durante la corrección deja la ronda cancelled', async () => {
  const { dir, argvName } = prepareRound('claude', ['sin JSON', '__hang__'])
  const running = supervise(dir, argvName)
  await waitFor(() => (existsSync(join(dir, 'calls')) && calls(dir).length === 2 ? true : undefined))
  await sleep(200)
  writeFileSync(join(dir, 'cancel.request'), 'ya')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.deepEqual(readRunJson(dir, 'rounds.json').rounds[0].jobs.map((j: { key: string; state: string }) => [j.key, j.state]), [['base-b1', 'cancelled']])
})

test('un cancel durante la corrección del refutador deja la ronda cancelled', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([inferential]), 'no sé', '__hang__'])
  const running = supervise(dir, argvName)
  await waitFor(() => (existsSync(join(dir, 'calls')) && calls(dir).length === 3 ? true : undefined))
  await sleep(200)
  writeFileSync(join(dir, 'cancel.request'), 'ya')
  const s = await running
  assert.equal(s.state, 'cancelled')
  assert.deepEqual(ledgerOf(dir).entries[0].refutation, { result: 'inconclusive', reason: 'cancelled' })
})

/** Una ronda 1 de artefacto preparada como la deja la CLI: un solo trabajo, sin resolución de refutador. */
function prepareArtifactRound(family: Family, answers: string[]): { dir: string; argvName: string } {
  const repo = makeRepo()
  mkdirSync(join(repo, '.plans'))
  writeFileSync(join(repo, '.plans', 'spec.md'), '# Spec\n\n- AC-1: algo observable.\n')
  writeFileSync(join(repo, '.plans', 'plan.md'), '# Plan\n\nAC-1 se cumple con resolve.\n')
  const sel = { artifact: '.plans/plan.md', kind: 'plan' as const, inputs: [{ role: 'spec' as const, path: '.plans/spec.md' }], context: [] }
  const { candidate: c, bytes } = freezeArtifact(repo, sel)
  const dir = createRun(repo, 'a')
  writeJsonAtomic(join(dir, 'candidate.json'), c)
  snapshot(repo, c, dir, bytes)
  const prompt = join(dir, 'prompt-l1-base-b1.md')
  writeFileSync(prompt, renderArtifactPrompt(c, renderArtifactMaterial(c, bytes)))
  writeJsonAtomic(join(dir, 'request.json'), { kind: 'review', selection: sel, author: opposite(family), degradations: [] })
  const reviewer = resolution(family, { model: 'm', effort: 'high', origin: { model: 'workers', effort: 'workers' } })
  writeJsonAtomic(join(dir, 'resolved.json'), reviewer)
  isolate(family)
  const argv: ArgvFile = {
    family, kind: 'review', candidate: join(dir, 'candidate.json'), deadline_sec: 30, grace_ms: 200, resume_sec: 5,
    round: 1, tag: '', launch_n: 1, reviewer_resolution: reviewer,
    jobs: [{ key: 'base-b1', reviewer: 'base', batch: 1, paths: ['.plans/plan.md'], prompt }],
  }
  writeJsonAtomic(join(dir, 'argv-l1.json'), argv)
  writeJsonAtomic(join(dir, 'answers.json'), answers)
  process.env.FAKE_MODE = 'scripted'
  process.env.FAKE_ANSWERS = join(dir, 'answers.json')
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  return { dir, argvName: 'argv-l1.json' }
}

const artifactRound = (findings: unknown[], unverifiable: unknown[] = []) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)},"unverifiable":${JSON.stringify(unverifiable)}}`
const planGrave = { of: '.plans/plan.md', axis: 'spec', severity: 'CRITICAL', location: '.plans/plan.md:3', claim: 'AC-1 no tiene mecanismo', evidence: 'inferential' }

test('un artefacto corre un solo trabajo contra el candidato entero, con su system prompt', async () => {
  const { dir, argvName } = prepareArtifactRound('claude', [artifactRound([])])
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.equal(calls(dir).length, 1)
  assert.equal(calls(dir)[0][calls(dir)[0].indexOf('--system-prompt') + 1], ARTIFACT_SYSTEM_PROMPT)
})

test('una revisión de artefacto nunca lanza el refutador', async () => {
  // Con causality introduced, un diff mandaría este hallazgo al refutador.
  const { dir, argvName } = prepareArtifactRound('claude', [artifactRound([{ ...planGrave, causality: 'introduced' }]), '__fail__'])
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.equal(calls(dir).length, 1)
  const l = ledgerOf(dir)
  assert.deepEqual([l.artifact, l.entries.map((e) => [e.id, e.state])], [true, [['F-1', 'abierto']]])
  assert.equal(readRunJson(dir, 'rounds.json').rounds[0].refutation, undefined)
  assert.deepEqual(scratches(tmpdir()).filter((n) => n.includes('refute')), [])
})

test('las no verificables no cuentan para el veredicto', async () => {
  const { dir, argvName } = prepareArtifactRound('codex', [artifactRound([], [{ location: '.plans/plan.md:3', claim: 'no viajó resolve' }])])
  await supervise(dir, argvName)
  const verdict = readRunJson(dir, 'verdict.json')
  assert.deepEqual([verdict.scope, verdict.spec, verdict.quality], ['ok', 'ok', 'ok'])
  assert.deepEqual(readRunJson(dir, 'rounds.json').rounds[0].unverifiable, [{ location: '.plans/plan.md:3', claim: 'no viajó resolve' }])
  assert.deepEqual(readRunJson(dir, 'receipt.json').unverifiable, [{ location: '.plans/plan.md:3', claim: 'no viajó resolve' }])
})

test('el recibo de un artefacto dice que el gate lo decide la persona y no menciona commit ni push', async () => {
  const informative = { ...planGrave, of: '.plans/spec.md', location: '.plans/spec.md:3', claim: 'la spec se contradice' }
  const { dir, argvName } = prepareArtifactRound('claude', [artifactRound([planGrave, informative])])
  await supervise(dir, argvName)
  const receipt = readRunJson(dir, 'receipt.json')
  assert.equal(receipt.note, 'el veredicto informa; el gate del artefacto lo decide la persona')
  assert.doesNotMatch(JSON.stringify({ note: receipt.note }), /commit|push/)
  assert.deepEqual(receipt.risk, { level: 'no_aplica' })
  assert.deepEqual(receipt.informative, [{ id: 'F-2', of: '.plans/spec.md', severity: 'CRITICAL', claim: 'la spec se contradice', location: '.plans/spec.md:3' }])
  assert.deepEqual(readRunJson(dir, 'verdict.json').informative, receipt.informative)
  assert.equal(readRunJson(dir, 'verdict.json').spec, 'fail')
})

test('el cierre del writer pide terminar sin archivos a medio escribir', () => {
  const m = closingMessage('write')
  assert.match(m, /Se agotó el tiempo/)
  assert.match(m, /a medio escribir/)
  assert.match(m, /no empieces cambios nuevos/)
  assert.match(m, /STATUS: done/)
  assert.notEqual(m, closingMessage('run'))
})

/** Una corrida de fase `specify` sobre un flujo en disco, con las respuestas guionadas del hijo. */
function preparePhase(answers: string[], o: { amended?: boolean; record?: PhaseRecord } = {}) {
  const repo = makeRepo()
  const flow = join(repo, '.plans', 'f')
  mkdirSync(flow, { recursive: true })
  writeFileSync(join(flow, 'handoff.md'), '---\nprofundidad: completa\nrisk: low\nchange_type: feat\n---\n\n# Handoff\n')
  const request = join(mkdtempSync(join(tmpdir(), 'sdd-ai-pedido-')), 'pedido.md')
  writeFileSync(request, 'Quiero exportar.\n')
  const dir = createRun(repo, 'p1')
  writeFileSync(join(dir, 'prompt.md'), 'encargo de fase')
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers))
  const launch = freezeLaunch(readFlow(repo, 'f'), {
    step: 'specify', depth: 'completa', amended: o.amended ?? false, request: { path: request, bytes: readFileSync(request) },
  })
  const argv: ArgvFile = {
    family: 'claude', kind: 'phase', deadline_sec: 30, phase: { ...launch, root: repo },
    launch: { cmd: process.execPath, args: [FAKE], cwd: repo, stdinFile: join(dir, 'prompt.md') },
  }
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  withFlowLock(repo, 'f', () => writePhaseRecord(repo, 'f', o.record ?? { schema_version: 1, last_run: { id: 'p1', step: 'specify' }, phases: {} }))
  process.env.FAKE_MODE = 'scripted'
  process.env.FAKE_ANSWERS = join(dir, 'answers.json')
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  return { repo, flow, dir }
}

const SPEC_CONTRACT = {
  phase: 'specify', known_facts: [], assumptions: ['uno'], blocking_questions: [], missing_context: [],
  acceptance_criteria: [{ id: 'AC-1', text: 'exporta', authority: 'pedido', verification: 'test' }],
  problem: 'Problema.', background: 'Nada.', scope: 'Todo.',
}
const phaseOut = (dir: string) => JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8'))

test('la fase admite su contrato con una sola corrección y descarta next', async () => {
  const fixed = preparePhase([JSON.stringify({ ...SPEC_CONTRACT, extra: 1 }), JSON.stringify(SPEC_CONTRACT)])
  assert.equal((await supervise(fixed.dir)).state, 'done')
  assert.equal(calls(fixed.dir).length, 2)
  assert.match(readFileSync(join(fixed.dir, 'prompt-fix.md'), 'utf8'), /extra/)
  assert.deepEqual([phaseOut(fixed.dir).outcome, phaseOut(fixed.dir).artifact], ['published', '.plans/f/spec.md'])
  assert.deepEqual(phaseOut(fixed.dir).assumptions, ['uno'])
  assert.ok(existsSync(join(fixed.flow, 'spec.md')))
  assert.deepEqual(JSON.parse(readFileSync(join(fixed.dir, 'contract.json'), 'utf8')), SPEC_CONTRACT)

  const missing = Object.fromEntries(Object.entries(SPEC_CONTRACT).filter(([k]) => k !== 'scope'))
  const twice = preparePhase([JSON.stringify(missing), JSON.stringify(missing)])
  const s = await supervise(twice.dir)
  assert.deepEqual([s.state, s.reason], ['unavailable', 'inadmissible_twice'])
  assert.equal(phaseOut(twice.dir).outcome, 'not_admitted')
  assert.match(phaseOut(twice.dir).cause, /scope/)
  assert.equal(existsSync(join(twice.flow, 'spec.md')), false)
  assert.equal(existsSync(join(twice.dir, 'contract.json')), false)

  const next = preparePhase([JSON.stringify({ ...SPEC_CONTRACT, next: 'plan' })])
  assert.equal((await supervise(next.dir)).state, 'done')
  assert.equal(calls(next.dir).length, 1)
  assert.equal(phaseOut(next.dir).outcome, 'published')
})

test('la fase con faltantes espera ampliación, la ampliada con faltantes se cierra inline y una sin publicar no consume nada', async () => {
  const asking = { ...SPEC_CONTRACT, blocking_questions: ['¿CSV o TSV?'], missing_context: ['el esquema'] }
  const first = preparePhase([JSON.stringify(asking)])
  assert.equal((await supervise(first.dir)).state, 'done')
  assert.deepEqual(phaseOut(first.dir), { outcome: 'awaiting_context', assumptions: ['uno'], blocking_questions: ['¿CSV o TSV?'], missing_context: ['el esquema'] })
  assert.deepEqual(readPhaseRecord(first.repo, 'f').phases.specify, { awaiting: { run: 'p1', blocking_questions: ['¿CSV o TSV?'], missing_context: ['el esquema'] } })
  assert.equal(existsSync(join(first.flow, 'spec.md')), false)

  const waiting: PhaseRecord = {
    schema_version: 1, last_run: { id: 'p1', step: 'specify' },
    phases: { specify: { awaiting: { run: 'p0', blocking_questions: ['¿CSV o TSV?'], missing_context: [] }, amended: { run: 'p1', consumed: false } } },
  }
  const again = preparePhase([JSON.stringify(asking)], { amended: true, record: waiting })
  await supervise(again.dir)
  assert.equal(phaseOut(again.dir).outcome, 'closed_inline')
  const closed = readPhaseRecord(again.repo, 'f').phases.specify
  assert.deepEqual([closed?.awaiting, closed?.amended, closed?.inline?.run], [undefined, { run: 'p1', consumed: true }, 'p1'])

  const published = preparePhase([JSON.stringify(SPEC_CONTRACT)], { amended: true, record: waiting })
  await supervise(published.dir)
  assert.equal(phaseOut(published.dir).outcome, 'published')
  assert.deepEqual(readPhaseRecord(published.repo, 'f').phases.specify, { amended: { run: 'p1', consumed: true } })

  const blocked = preparePhase([JSON.stringify(SPEC_CONTRACT)], { amended: true, record: waiting })
  writeFileSync(join(blocked.flow, 'spec.md'), 'la escribió otro\n')
  const b = await supervise(blocked.dir)
  assert.deepEqual([b.state, b.reason], ['failed', 'not_published'])
  assert.equal(phaseOut(blocked.dir).outcome, 'not_published')
  assert.deepEqual(readPhaseRecord(blocked.repo, 'f').phases.specify, waiting.phases.specify)
})

test('supervisor encadenado: el cierre por timeout de una corrida que reanuda conserva su argv de reanudación', async () => {
  const { chainFlow, chainSetup, runBin } = await import('./helpers.ts')
  const done = (ids: string[], pending: string[] = []) => `Hecho.\n\n${JSON.stringify({ phase: 'implement', missing_context: [],
    tasks: [...ids.map((id) => ({ id, completion: 'done' })), ...pending.map((id) => ({ id, completion: 'pending' }))].map((t) => ({ ...t, change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'V1' })) })}\n\nSTATUS: done\n`
  const s = chainSetup({ writers: [
    { actions: [{ write: 'src/t1.ts', content: '1\n' }], report: done(['T1'], ['T2']) },
    { actions: [{ write: 'src/t2.ts', content: '2\n' }], hang: true },
    { report: done(['T2']) },
  ] })
  chainFlow(s, { tasks: 2 })
  runBin(s, ['wait', runBin(s, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  const cont = runBin(s, ['sdd', 'phase', 'f', '--deadline', '3'])
  assert.equal(cont.code, 0, JSON.stringify(cont.out))
  const w = runBin(s, ['wait', cont.out.id, '--max', '60'])
  assert.equal(w.out.state, 'done', JSON.stringify(w.out))
  const store = join(s.repo, '.git', 'sdd-ai', 'runs', cont.out.id)
  const launched = JSON.parse(readFileSync(join(store, 'argv.json'), 'utf8')).launch.args as string[]
  const resumed = JSON.parse(readFileSync(join(store, 'argv-resume.json'), 'utf8')).launch.args as string[]
  // El argv ya reanudaba la sesión del writer anterior: el cierre usa el mismo, sin anidar otro resume.
  assert.deepEqual(resumed, launched)
  assert.equal(launched.filter((a) => a === 'resume').length, 1)
  assert.deepEqual(w.out.left, [])
})
