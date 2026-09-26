import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LENSES } from '../src/review/ledger.ts'
import { LENS_MANDATES } from '../src/review/prompt.ts'
import { makeFakeBin, makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const lines = (n: number) => Array.from({ length: n }, (_, i) => `línea ${i + 1}\n`).join('')

interface Setup { repo: string; env: Record<string, string>; base: string }

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

/** Repo con una base commiteada (a.txt de 10 líneas), la config de familias y CLIs falsos en un PATH controlado. */
function setup(opts: { families: string; bins: Array<'claude' | 'codex'>; mode?: string }): Setup {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  writeFileSync(join(repo, '.sdd-ai', '.gitignore'), '*\n')
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: ${opts.families}\n  selection: full\n`)
  writeFileSync(join(repo, 'a.txt'), lines(10))
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'base')
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const b of opts.bins) makeFakeBin(bin, b)
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1',
    CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')), FAKE_MODE: opts.mode ?? 'review-ok',
  }
  return { repo, env, base: git(repo, 'rev-parse', 'HEAD') }
}

function cli(s: Setup, args: string[]) {
  const r = spawnSync(BIN, args, { cwd: s.repo, env: s.env, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}

const runs = (s: Setup) => {
  const dir = join(s.repo, '.sdd-ai', 'runs')
  return existsSync(dir) ? readdirSync(dir) : []
}
const runJson = (s: Setup, id: string, name: string) => JSON.parse(readFileSync(join(s.repo, '.sdd-ai', 'runs', id, name), 'utf8'))

test('start congela lo modificado y lo agregado con add -N, y lista lo que quedó afuera', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(10).replace('línea 5\n', 'línea cinco\n'))
  writeFileSync(join(s.repo, 'nuevo.txt'), 'nuevo\n')
  writeFileSync(join(s.repo, 'suelto.txt'), 'suelto\n')
  git(s.repo, 'add', '-N', 'nuevo.txt')
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual([r.out.via, r.out.family, r.out.degradations], ['process', 'codex', []])
  assert.deepEqual([...r.out.files].sort(), ['a.txt', 'nuevo.txt'])
  assert.deepEqual(r.out.left_out, ['suelto.txt'])
  assert.match(r.out.candidate_hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(r.out.next, `./bin/sdd-ai wait ${r.out.id}`)
})

test('con una sola familia revisa la del autor y la degradación se ve en start, status y el recibo', () => {
  const s = setup({ families: '[claude]', bins: ['claude'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const r = cli(s, ['review', 'start', '--base', s.base, '--author', 'claude'])
  assert.deepEqual([r.out.family, r.out.degradations], ['claude', ['same_family']])
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.equal(w.code, 0, JSON.stringify(w.out))
  assert.deepEqual(w.out.degradations, ['same_family'])
  const receipt = runJson(s, r.out.id, 'receipt.json')
  assert.ok(receipt.degradations.includes('same_family'))
  assert.ok(w.out.reviewer.model_effective)
  assert.equal(w.out.reviewer.model_effective, receipt.reviewer.model_effective)
})

test('wait sobre una revisión devuelve la vista de review status con los ejes', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const r = cli(s, ['review', 'start', '--base', s.base])
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.equal(w.code, 0, JSON.stringify(w.out))
  assert.deepEqual([w.out.state, w.out.stale, w.out.axes], ['done', false, { scope: 'ok', spec: 'ok', quality: 'ok' }])
  assert.deepEqual([w.out.reviewer.family, w.out.candidate_hash], ['codex', r.out.candidate_hash])
  assert.deepEqual([w.out.ledger, w.out.pending, w.out.tool_events], [[], [], []])
  assert.equal(typeof w.out.next, 'string')
})

test('review status marca stale si el diff cambió o si la base ya no resuelve', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  git(s.repo, 'branch', 'base-temp', s.base)
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const r = cli(s, ['review', 'start', '--base', 'base-temp'])
  cli(s, ['wait', r.out.id, '--max', '20'])
  assert.equal(cli(s, ['review', 'status', r.out.id]).out.stale, false)
  writeFileSync(join(s.repo, 'a.txt'), lines(12))
  const changed = cli(s, ['review', 'status', r.out.id])
  assert.equal(changed.out.stale, true)
  assert.match(changed.out.next, /review start --base base-temp/)
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  assert.equal(cli(s, ['review', 'status', r.out.id]).out.stale, false)
  git(s.repo, 'branch', '-D', 'base-temp')
  assert.equal(cli(s, ['review', 'status', r.out.id]).out.stale, true)
})

test('la revisión nueva que propone stale entrecomilla las rutas de contexto', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, "mi spec's.md"), '# spec\n')
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const r = cli(s, ['review', 'start', '--base', s.base, '--context', "mi spec's.md"])
  cli(s, ['wait', r.out.id, '--max', '20'])
  writeFileSync(join(s.repo, 'a.txt'), lines(12))
  const st = cli(s, ['review', 'status', r.out.id])
  assert.equal(st.out.stale, true)
  assert.match(st.out.next, /--context '\S*\/mi spec'\\''s\.md' --author/)
})

test('con --head, un ref que avanza se informa sin marcar stale', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  git(s.repo, 'checkout', '-qb', 'tema')
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  git(s.repo, 'commit', '-qam', 'uno')
  const r = cli(s, ['review', 'start', '--base', s.base, '--head', 'tema'])
  assert.deepEqual(r.out.left_out, [])
  cli(s, ['wait', r.out.id, '--max', '20'])
  writeFileSync(join(s.repo, 'a.txt'), lines(12))
  git(s.repo, 'commit', '-qam', 'dos')
  const st = cli(s, ['review', 'status', r.out.id])
  assert.deepEqual([st.out.stale, st.out.ref_moved], [false, true])
})

test('un candidato que pasa del presupuesto se rechaza antes de crear la corrida', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'grande.txt'), 'x'.repeat(100).concat('\n').repeat(2200))
  git(s.repo, 'add', '-N', 'grande.txt')
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'prompt_too_large')
  assert.match(r.out.detail, /^grande\.txt: su sección numerada mide \d+ bytes; el prompt con ese archivo solo mide \d+ > 204800$/)
  assert.deepEqual(runs(s), [])
})

test('review start usa un tope de 1800 s por defecto; run sigue en 600', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const def = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(runJson(s, def.out.id, 'argv-l1.json').deadline_sec, 1800)
  const custom = cli(s, ['review', 'start', '--base', s.base, '--deadline', '900'])
  assert.equal(runJson(s, custom.out.id, 'argv-l1.json').deadline_sec, 900)
  const prompt = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(prompt, 'encargo\n')
  const run = cli(s, ['run', '--prompt-file', prompt])
  assert.equal(runJson(s, run.out.id, 'argv.json').deadline_sec, 600)
})

test('una revisión unavailable sale con código 1 y el motivo', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'], mode: 'review-unavailable' })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const r = cli(s, ['review', 'start', '--base', s.base])
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.equal(w.code, 1)
  assert.deepEqual([w.out.state, w.out.reason, w.out.detail], ['unavailable', 'jobs_incomplete', 'base-b1: unavailable/reviewer_unavailable'])
})

test('sin --base es un error de uso', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  const r = cli(s, ['review', 'start'])
  assert.deepEqual([r.code, r.out.code], [2, 'usage'])
})

test('review start devuelve y congela el nivel y sus motivos', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  mkdirSync(join(s.repo, 'auth'))
  writeFileSync(join(s.repo, 'auth', 'x.txt'), 'x\n')
  git(s.repo, 'add', '-N', 'auth/x.txt')
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const reasons = [{ signal: 'path', path: 'auth/x.txt', detail: 'segmento auth' }]
  assert.deepEqual(r.out.risk, { level: 'high', reasons, forced: false })
  assert.deepEqual(runJson(s, r.out.id, 'request.json').risk, { level: 'high', classified: 'high', reasons, forced: false })
  cli(s, ['wait', r.out.id, '--max', '20'])
  git(s.repo, 'rm', '-q', '--cached', 'auth/x.txt')
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const plain = cli(s, ['review', 'start', '--base', s.base])
  assert.deepEqual(plain.out.risk, { level: 'normal', reasons: [], forced: false })
})

test('--risk high sube el nivel y registra que fue a mano', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const r = cli(s, ['review', 'start', '--base', s.base, '--risk', 'high'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual(r.out.risk, { level: 'high', reasons: [], forced: true })
  assert.deepEqual(runJson(s, r.out.id, 'request.json').risk, { level: 'high', classified: 'normal', reasons: [], forced: true })
})

test('--risk high es el único valor: no acepta otro', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  for (const value of ['normal', 'low', 'HIGH']) {
    const r = cli(s, ['review', 'start', '--base', s.base, '--risk', value])
    assert.deepEqual([r.code, r.out.code], [2, 'usage'])
    assert.match(r.out.message, /nunca se baja/)
  }
  assert.deepEqual(runs(s), [])
})

test('una corrida que no lanza su supervisor no deja temporales', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  const tmp = mkdtempSync(join(tmpdir(), 'sdd-ai-tmp-'))
  s.env.TMPDIR = tmp
  writeFileSync(join(s.repo, 'grande.txt'), 'x'.repeat(100).concat('\n').repeat(2200))
  git(s.repo, 'add', '-N', 'grande.txt')
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(r.out.code, 'prompt_too_large')
  assert.deepEqual(readdirSync(tmp), [])
  git(s.repo, 'rm', '-q', '--cached', 'grande.txt')
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const ok = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(cli(s, ['wait', ok.out.id, '--max', '20']).out.state, 'done')
  assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('sdd-ai-review-')), [])
})

/** Un archivo de `kb` KB en `path`, agregado con add -N. */
function big(s: Setup, path: string, kb: number): void {
  mkdirSync(join(s.repo, path, '..'), { recursive: true })
  writeFileSync(join(s.repo, path), 'x'.repeat(99).concat('\n').repeat(kb * 10))
  git(s.repo, 'add', '-N', path)
}
const callsOf = (s: Setup) => readFileSync(s.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])

test('el nivel normal corre solo la base, sin lentes', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  s.env.FAKE_CALLS_FILE = join(mkdtempSync(join(tmpdir(), 'sdd-ai-calls-')), 'calls')
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.deepEqual([r.out.risk.level, r.out.reviewers, r.out.batches], ['normal', ['base'], undefined])
  assert.equal(cli(s, ['wait', r.out.id, '--max', '20']).out.state, 'done')
  assert.equal(callsOf(s).length, 1)
  const dir = join(s.repo, '.sdd-ai', 'runs', r.out.id)
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('prompt-')), ['prompt-l1-base-b1.md'])
})

test('el nivel alto corre la base y las cuatro lentes en orden, cada una aislada', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  s.env.FAKE_CALLS_FILE = join(mkdtempSync(join(tmpdir(), 'sdd-ai-calls-')), 'calls')
  mkdirSync(join(s.repo, 'src', 'auth'), { recursive: true })
  writeFileSync(join(s.repo, 'src', 'auth', 'x.txt'), 'x\n')
  git(s.repo, 'add', '-N', 'src/auth/x.txt')
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.deepEqual([r.out.risk.level, r.out.reviewers], ['high', ['base', ...LENSES]])
  assert.equal(cli(s, ['wait', r.out.id, '--max', '30']).out.state, 'done')
  const argv = runJson(s, r.out.id, 'argv-l1.json')
  assert.deepEqual(argv.jobs.map((j: { key: string }) => j.key), ['base-b1', 'risk-b1', 'resilience-b1', 'reliability-b1', 'readability-b1'])
  const prompt = (key: string) => readFileSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, `prompt-l1-${key}.md`), 'utf8')
  assert.match(prompt('base-b1'), /1\. SCOPE/)
  for (const lens of LENSES) assert.ok(prompt(`${lens}-b1`).includes(LENS_MANDATES[lens]), lens)
  const calls = callsOf(s)
  assert.equal(calls.length, 5)
  const scratch = calls.map((c) => c[c.indexOf('-C') + 1])
  assert.equal(new Set(scratch).size, 5, 'cada revisor corre en su propio temporal, con un exec nuevo')
  const attempts = runJson(s, r.out.id, 'metrics.json').attempts
  assert.deepEqual(attempts.map((a: { reviewer: string }) => a.reviewer), ['base', ...LENSES])
})

test('si un prompt de algún lote de la ronda 1 no entra no se crea la corrida', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  big(s, 'x/uno.txt', 120)
  big(s, 'y/dos.txt', 120)
  const ok = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(ok.code, 0, JSON.stringify(ok.out))
  assert.deepEqual(ok.out.batches, [{ n: 1, paths: ['x/uno.txt'] }, { n: 2, paths: ['y/dos.txt'] }])
  assert.equal(cli(s, ['wait', ok.out.id, '--max', '30']).out.state, 'done')
  big(s, 'z/grande.txt', 210)
  const before = runs(s)
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.deepEqual([r.code, r.out.code], [2, 'prompt_too_large'])
  assert.deepEqual(runs(s), before)
})

test('un archivo que no entra solo da prompt_too_large con su ruta y su tamaño', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  big(s, 'z/grande.txt', 210)
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'prompt_too_large', 'el archivo z/grande.txt no entra solo en el presupuesto'])
  const m = /^z\/grande\.txt: su sección numerada mide (\d+) bytes; el prompt con ese archivo solo mide (\d+) > 204800$/.exec(r.out.detail)
  assert.ok(m, r.out.detail)
  assert.ok(Number(m[1]) > 210_000 && Number(m[2]) > Number(m[1]))
  assert.deepEqual(runs(s), [])
})

test('el contexto solo que no entra se nombra', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  writeFileSync(join(s.repo, 'spec.md'), 'x'.repeat(99).concat('\n').repeat(2100))
  const r = cli(s, ['review', 'start', '--base', s.base, '--context', 'spec.md'])
  assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'prompt_too_large', 'el contexto solo no entra en el presupuesto'])
  assert.match(r.out.next, /qué contexto quitar/)
  assert.deepEqual(runs(s), [])
})

test('el next de prompt_too_large con un archivo no sugiere un diff más chico', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  big(s, 'grande.txt', 210)
  const r = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(r.out.code, 'prompt_too_large')
  assert.doesNotMatch(r.out.next, /más chico/)
  assert.match(r.out.next, /review no puede revisar grande\.txt: pregunta al usuario si lo saca del cambio o lo revisa por fuera de review/)
})

test('start, status y wait muestran el nivel, los motivos, los revisores y los lotes', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  big(s, 'auth/uno.txt', 120)
  big(s, 'y/dos.txt', 120)
  const r = cli(s, ['review', 'start', '--base', s.base])
  const risk = { level: 'high', reasons: [{ signal: 'path', path: 'auth/uno.txt', detail: 'segmento auth' }], forced: false }
  const lots = [{ n: 1, paths: ['auth/uno.txt'] }, { n: 2, paths: ['y/dos.txt'] }]
  const reviewers = ['base', ...LENSES]
  assert.deepEqual([r.out.risk, r.out.reviewers, r.out.batches], [risk, reviewers, lots])
  const early = cli(s, ['wait', r.out.id, '--max', '0'])
  assert.equal(early.code, 3, 'la ronda sigue en curso')
  assert.deepEqual([early.out.risk, early.out.reviewers, early.out.batches], [risk, reviewers, lots])
  const w = cli(s, ['wait', r.out.id, '--max', '60'])
  assert.equal(w.out.state, 'done', JSON.stringify(w.out))
  for (const out of [w.out, cli(s, ['review', 'status', r.out.id]).out]) {
    assert.deepEqual([out.risk, out.reviewers, out.batches], [risk, reviewers, lots])
    assert.equal(out.jobs.length, 10)
  }
})
