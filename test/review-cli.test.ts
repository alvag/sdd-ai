import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assert.match(r.out.detail, /^\d+ > 204800$/)
  assert.deepEqual(runs(s), [])
})

test('review start usa un tope de 1800 s por defecto; run sigue en 600', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  writeFileSync(join(s.repo, 'a.txt'), lines(11))
  const def = cli(s, ['review', 'start', '--base', s.base])
  assert.equal(runJson(s, def.out.id, 'argv.json').deadline_sec, 1800)
  const custom = cli(s, ['review', 'start', '--base', s.base, '--deadline', '900'])
  assert.equal(runJson(s, custom.out.id, 'argv.json').deadline_sec, 900)
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
  assert.deepEqual([w.out.state, w.out.reason, w.out.detail], ['unavailable', 'reviewer_unavailable', 'no pude'])
})

test('sin --base es un error de uso', () => {
  const s = setup({ families: '[codex, claude]', bins: ['codex'] })
  const r = cli(s, ['review', 'start'])
  assert.deepEqual([r.code, r.out.code], [2, 'usage'])
})
