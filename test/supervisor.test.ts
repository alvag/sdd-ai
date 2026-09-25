import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRun, readStatus, writeJsonAtomic } from '../src/runs.ts'
import type { Candidate } from '../src/review/candidate.ts'
import { type Ledger, type RoundPlan, decide, openLedger, targets } from '../src/review/ledger.ts'
import { REVIEW_PROMPT_BUDGET, renderMaterial, renderReviewPrompt, renderRoundPrompt } from '../src/review/prompt.ts'
import { type ArgvFile, cleanEnv, supervise } from '../src/supervisor.ts'
import { REFUTER_SYSTEM_PROMPT, claudeReviewLaunch } from '../src/workers/claude.ts'
import { codexReviewLaunch } from '../src/workers/codex.ts'
import { type Family, opposite } from '../src/types.ts'
import { makeFakeBin, makeRepo, warmFakeBin } from './helpers.ts'

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
  writeJsonAtomic(join(dir, 'argv.json'), { ...argv, launch: { ...argv.launch, args: [...argv.launch.args, ...extra] } })
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
  warmFakeBin(bin, family)
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
  assert.equal(readFileSync(join(dir, 'result.md'), 'utf8'), '')
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

/** Corrida de revisión con un candidato fijo de una ruta y el lanzador real de la familia, apuntado al CLI falso. */
function prepareReview(family: Family, mode: string, pad = 0): string {
  const dir = createRun(makeRepo(), 'r')
  const c: Candidate = {
    base_sha: 'b'.repeat(40), head_sha: null, hash: HASH, left_out: [], context: [], diff: 'diff --git a/a.txt b/a.txt\n',
    files: [{ path: 'a.txt', status: 'M', mode: '100644', sha256: 'x', binary: false, lines: 3, visible: [[1, 3]] }],
  }
  writeJsonAtomic(join(dir, 'candidate.json'), c)
  writeFileSync(join(dir, 'prompt.md'), renderReviewPrompt(c, new Map()) + 'x'.repeat(pad))
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  makeFakeBin(bin, family)
  const task = {
    cwd: dir, promptFile: join(dir, 'prompt.md'), resultFile: join(dir, 'result.md'), sessionId: 's1',
    scratch: mkdtempSync(join(tmpdir(), 'sdd-ai-scratch-')),
  }
  const launch = family === 'claude' ? claudeReviewLaunch(task) : codexReviewLaunch(task)
  const argv: ArgvFile = {
    family, kind: 'review', candidate: join(dir, 'candidate.json'), launch: { ...launch, cmd: join(bin, family) },
    deadline_sec: 30, resume_sec: 5,
  }
  writeJsonAtomic(join(dir, 'argv.json'), argv)
  writeJsonAtomic(join(dir, 'resolved.json'), { family, via: 'process', origin: { model: 'heredado', effort: 'heredado' } })
  process.env.FAKE_MODE = mode
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  return dir
}

const readRunJson = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))

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
})

test('un revisor que declara que no pudo inspeccionar termina en unavailable sin reintento', async () => {
  const dir = prepareReview('codex', 'review-unavailable')
  const s = await supervise(dir)
  assert.deepEqual([s.state, s.reason, s.detail], ['unavailable', 'reviewer_unavailable', 'no pude'])
  assert.equal(calls(dir).length, 1)
})

test('una respuesta inadmisible se corrige una vez, en una sesión nueva de Claude', async () => {
  const dir = prepareReview('claude', 'review-bad-then-ok')
  const s = await supervise(dir)
  const [first, second] = calls(dir)
  assert.equal(s.state, 'done')
  assert.equal(calls(dir).length, 2)
  assert.equal(first[first.indexOf('--session-id') + 1], 's1')
  assert.notEqual(second[second.indexOf('--session-id') + 1], 's1')
  assert.match(readFileSync(join(dir, 'prompt-fix.md'), 'utf8'), /CORRECCIÓN[\s\S]*exactamente un objeto JSON/)
  const m = metrics(dir)
  assert.deepEqual(m.attempts.map((a: { kind: string }) => a.kind), ['initial', 'correction'])
  assert.match(m.attempts[0].admission, /^inadmissible: /)
  assert.equal(m.attempts[1].admission, 'ok')
  assert.equal(m.totals.inadmissible, 1)
  assert.deepEqual(m.attempts.map((a: { raw: { result: string } }) => a.raw.result), ['result.md', 'result-fix.md'])
  assert.equal(s.result_file, 'result-fix.md')
  assert.notEqual(readFileSync(join(dir, 'result.md'), 'utf8'), readFileSync(join(dir, 'result-fix.md'), 'utf8'))
})

test('la corrección de Codex es un exec nuevo, no una reanudación', async () => {
  const dir = prepareReview('codex', 'review-bad-then-ok')
  const s = await supervise(dir)
  assert.equal(s.state, 'done')
  assert.deepEqual(calls(dir)[1].slice(0, 2), ['exec', '--ignore-user-config'])
  assert.equal(existsSync(join(dir, 'result-fix.md')), true)
})

test('dos respuestas inadmisibles terminan en unavailable', async () => {
  const dir = prepareReview('claude', 'review-bad-always')
  const s = await supervise(dir)
  assert.deepEqual([s.state, s.reason], ['unavailable', 'inadmissible_twice'])
  assert.equal(calls(dir).length, 2)
})

test('si el prompt corregido no entra en el presupuesto, no se relanza', async () => {
  const probe = prepareReview('claude', 'review-bad-always')
  const size = readFileSync(join(probe, 'prompt.md')).length
  const dir = prepareReview('claude', 'review-bad-always', REVIEW_PROMPT_BUDGET - size - 50)
  const s = await supervise(dir)
  assert.deepEqual([s.state, s.reason], ['unavailable', 'correction_over_budget'])
  assert.equal(calls(dir).length, 1)
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
const inferential = { axis: 'quality', severity: 'CRITICAL', location: 'a.txt:2', claim: 'puede fallar con una lista vacía', causality: 'introduced', evidence: 'inferential' }
const deterministic = { ...inferential, claim: 'la línea 2 no valida', evidence: 'deterministic' }
const firstRound = (findings: unknown[]) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)}}`
const nextRound = (responses: unknown[], findings: unknown[] = []) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"responses":${JSON.stringify(responses)},"findings":${JSON.stringify(findings)}}`
const refutation = (results: unknown[]) => `{"candidate_hash":"$HASH","results":${JSON.stringify(results)}}`

interface RoundSetup { round?: number; ledger?: Ledger; plan?: RoundPlan; deadline_sec?: number; materialPad?: number }

/** Una ronda preparada como la deja la CLI: candidato, material, prompt, revisor y refutador apuntados al CLI falso guionado. */
function prepareRound(family: Family, answers: string[], o: RoundSetup = {}): { dir: string; argvName: string } {
  const dir = createRun(makeRepo(), 'r')
  const n = o.round ?? 1
  const tag = n === 1 ? '' : `-r${n}`
  writeJsonAtomic(join(dir, `candidate${tag}.json`), ROUND_CANDIDATE)
  const material = renderMaterial(ROUND_CANDIDATE, new Map()) + 'x'.repeat(o.materialPad ?? 0)
  writeFileSync(join(dir, `material${tag}.md`), material)
  const prompt = o.plan && o.ledger
    ? renderRoundPrompt(ROUND_CANDIDATE, material, o.plan, o.ledger.entries, 3)
    : renderReviewPrompt(ROUND_CANDIDATE, new Map())
  writeFileSync(join(dir, `prompt${tag}.md`), prompt)
  if (o.ledger) writeJsonAtomic(join(dir, 'ledger.json'), o.ledger)
  if (o.plan) writeJsonAtomic(join(dir, `round${tag}.json`), o.plan)
  writeJsonAtomic(join(dir, 'request.json'), { kind: 'review', selection: { base: 'main', context: [] }, author: opposite(family), degradations: [] })
  writeJsonAtomic(join(dir, 'resolved.json'), { family, via: 'process', model: 'm', effort: 'high', origin: { model: 'workers', effort: 'workers' } })
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  makeFakeBin(bin, family)
  warmFakeBin(bin, family)
  const scratch = () => mkdtempSync(join(tmpdir(), 'sdd-ai-scratch-'))
  const task = { cwd: dir, promptFile: join(dir, `prompt${tag}.md`), resultFile: join(dir, `result${tag}.md`), sessionId: 's1', scratch: scratch() }
  const launch = family === 'claude' ? claudeReviewLaunch(task) : codexReviewLaunch(task)
  const rtask = { cwd: dir, promptFile: join(dir, `prompt${tag}-refute.md`), resultFile: join(dir, `result${tag}-refute.md`), sessionId: 's2', scratch: scratch() }
  const refuter = family === 'claude' ? claudeReviewLaunch({ ...rtask, systemPrompt: REFUTER_SYSTEM_PROMPT }) : codexReviewLaunch(rtask)
  const argvName = `argv${tag}.json`
  const argv: ArgvFile = {
    family, kind: 'review', candidate: join(dir, `candidate${tag}.json`), launch: { ...launch, cmd: join(bin, family) },
    deadline_sec: o.deadline_sec ?? 30, grace_ms: 200, resume_sec: 5, round: n, tag, material: join(dir, `material${tag}.md`),
    refuter_launch: { ...refuter, cmd: join(bin, family) }, ...(o.plan ? { plan: join(dir, `round${tag}.json`) } : {}),
  }
  writeJsonAtomic(join(dir, argvName), argv)
  writeJsonAtomic(join(dir, 'answers.json'), answers)
  process.env.FAKE_MODE = 'scripted'
  process.env.FAKE_ANSWERS = join(dir, 'answers.json')
  process.env.FAKE_CALLS_FILE = join(dir, 'calls')
  process.env.FAKE_PID_FILE = join(dir, 'pids')
  return { dir, argvName }
}

const ledgerOf = (dir: string): Ledger => readRunJson(dir, 'ledger.json')
const kinds = (dir: string) => metrics(dir).attempts.map((a: { kind: string; round: number; suffix: string }) => [a.round, a.kind, a.suffix])

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
    const refutePrompt = readFileSync(join(dir, 'prompt-refute.md'), 'utf8')
    assert.match(refutePrompt, /refutador aislado/)
    assert.ok(refutePrompt.includes('"F-1"') && !refutePrompt.includes('"F-2"'))
    assert.deepEqual(kinds(dir), [[1, 'initial', ''], [1, 'refutation', '-refute']])
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
  assert.equal(existsSync(join(dir, 'prompt-refute.md')), false)
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
  assert.deepEqual(kinds(dir), [[1, 'initial', ''], [1, 'refutation', '-refute'], [1, 'refutation', '-refute-fix']])
  assert.ok(readFileSync(join(dir, 'prompt-refute-fix.md'), 'utf8').startsWith(readFileSync(join(dir, 'prompt-refute.md'), 'utf8')))
  assert.deepEqual(ledgerOf(dir).entries[0].refutation, { result: 'inconclusive', reason: 'inadmissible_twice' })
})

test('un refutador cancelado deja la tanda inconclusive por cancelled y la ronda en done', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([inferential]), '__hang__'])
  const running = supervise(dir, argvName)
  await waitFor(() => (existsSync(join(dir, 'calls')) && calls(dir).length === 2 ? true : undefined))
  await sleep(200)
  writeFileSync(join(dir, 'cancel.request'), 'ya')
  const s = await running
  assert.equal(s.state, 'done')
  assert.deepEqual(ledgerOf(dir).entries[0].refutation, { result: 'inconclusive', reason: 'cancelled' })
})

test('un prompt de refutación que no entra en el presupuesto deja la tanda inconclusive sin lanzar', async () => {
  const { dir, argvName } = prepareRound('claude', [firstRound([inferential])], { materialPad: REVIEW_PROMPT_BUDGET })
  await supervise(dir, argvName)
  assert.equal(calls(dir).length, 1)
  assert.deepEqual(ledgerOf(dir).entries[0].refutation, { result: 'inconclusive', reason: 'prompt_too_large' })
})

/** Ledger después de una ronda 1 con dos graves deterministas: F-1 aceptado y F-2 rechazado. */
function roundTwo(): { ledger: Ledger; plan: RoundPlan } {
  const opened = openLedger([deterministic, { ...deterministic, axis: 'scope' }] as Parameters<typeof openLedger>[0])
  const ledger = decide(decide(opened, 'accept', ['F-1']), 'reject', ['F-2'], 'es intencional')
  const plan: RoundPlan = { n: 2, prev_hash: `sha256:${'0'.repeat(64)}`, identical: false, targets: targets(ledger), changed: { 'a.txt': [[2, 2]] } }
  return { ledger, plan }
}
const answered = [{ id: 'F-1', answer: 'resolved' }, { id: 'F-2', answer: 'withdrawn' }]

test('la ronda 2 escribe sus archivos con -r2, aplica las respuestas y abre las regresiones', async () => {
  const { ledger, plan } = roundTwo()
  const { dir, argvName } = prepareRound('claude', [nextRound(answered, [{ ...deterministic, severity: 'WARNING', claim: 'regresión' }])], { round: 2, ledger, plan })
  const s = await supervise(dir, argvName)
  assert.deepEqual([s.state, s.round, s.result_file], ['done', 2, 'result-r2.md'])
  for (const f of ['stdout-r2.log', 'stderr-r2.log', 'result-r2.md']) assert.equal(existsSync(join(dir, f)), true, f)
  for (const f of ['stdout.log', 'result.md']) assert.equal(existsSync(join(dir, f)), false, f)
  const l = ledgerOf(dir)
  assert.deepEqual(l.entries.map((e) => [e.id, e.state, e.round]), [['F-1', 'resuelto', 1], ['F-2', 'cerrado', 1], ['F-3', 'abierto', 2]])
  assert.equal(l.completed, 2)
  const r = readRunJson(dir, 'rounds.json').rounds
  assert.deepEqual(r.map((x: { n: number; tag: string; state: string }) => [x.n, x.tag, x.state]), [[2, '-r2', 'done']])
  assert.deepEqual(kinds(dir), [[2, 'initial', '']])
})

test('la corrección de la ronda 2 parte de prompt-r2.md', async () => {
  const { ledger, plan } = roundTwo()
  const { dir, argvName } = prepareRound('codex', ['sin JSON', nextRound(answered)], { round: 2, ledger, plan })
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.ok(readFileSync(join(dir, 'prompt-r2-fix.md'), 'utf8').startsWith(readFileSync(join(dir, 'prompt-r2.md'), 'utf8')))
  assert.equal(existsSync(join(dir, 'result-r2-fix.md')), true)
  assert.equal(existsSync(join(dir, 'prompt-fix.md')), false)
  assert.equal(ledgerOf(dir).entries[0].state, 'resuelto')
})

test('una ronda 2 que agota el tope se reanuda con resume-r2.md', async () => {
  const { ledger, plan } = roundTwo()
  // La reanudación solo recibe el mensaje de cierre: la respuesta guionada lleva el hash y las rutas literales.
  const literal = nextRound(answered).replace('$HASH', HASH).replace('$PATHS', '["a.txt"]')
  const { dir, argvName } = prepareRound('claude', ['__hang__', literal], { round: 2, ledger, plan, deadline_sec: 1 })
  const s = await supervise(dir, argvName)
  assert.equal(s.state, 'done')
  assert.equal(s.resume?.outcome, 'done')
  assert.match(readFileSync(join(dir, 'resume-r2.md'), 'utf8'), /Se agotó el tiempo/)
  assert.equal(existsSync(join(dir, 'argv-r2-resume.json')), true)
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
  assert.deepEqual([s.state, s.reason], ['unavailable', 'reviewer_unavailable'])
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
