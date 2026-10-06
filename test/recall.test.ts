import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { type EngramHit, type RecallResult, recall, searchEngram, searchVault, termVariants } from '../src/recall.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const scratch: string[] = []
after(() => { for (const path of scratch) rmSync(path, { recursive: true, force: true }) })
interface FakeMap { variants?: Record<string, EngramHit[]>; exit?: number; stderr?: string; sleep?: number; raw?: string }
interface Call { argv: string[]; cwd: string; project?: string; start: number; end?: number }
interface Setup { root: string; repo: string; vault: string; bin: string; env: Record<string, string>; map: string; log: string }

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } }).trim()
}
function commit(s: Setup, message: string): void {
  git(s.repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', message)
}
function fake(s: Setup, map: FakeMap): void { put(s.map, JSON.stringify(map)) }
function setup(withEngram = true): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-recall-')))
  scratch.push(root)
  const s: Setup = { root, repo: join(root, 'repo'), vault: join(root, 'vault'), bin: join(root, 'bin'),
    map: join(root, 'map.json'), log: join(root, 'engram.jsonl'), env: {} }
  mkdirSync(s.repo)
  mkdirSync(s.bin)
  mkdirSync(join(root, 'home'))
  git(s.repo, 'init', '-q', '-b', 'main')
  commit(s, 'Initial')
  symlinkSync(process.execPath, join(s.bin, 'node'))
  s.env = { PATH: `${s.bin}:/usr/bin:/bin`, HOME: join(root, 'home'), FAKE_ENGRAM: s.map, FAKE_LOG: s.log, SDD_AI_PROJECTION: 'off' }
  fake(s, {})
  if (withEngram) {
    const script = join(root, 'fake-engram.cjs')
    put(script, `const fs = require('node:fs');
const map = JSON.parse(fs.readFileSync(process.env.FAKE_ENGRAM, 'utf8'));
const call = { argv: process.argv.slice(2), cwd: process.cwd(), project: process.env.ENGRAM_PROJECT, start: Date.now() };
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(call) + '\\n');
setTimeout(() => {
  call.end = Date.now();
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(call) + '\\n');
  if (map.exit) { process.stderr.write(map.stderr || 'error'); process.exit(map.exit); }
  if (map.raw !== undefined) { process.stdout.write(map.raw); return; }
  const variants = call.argv.slice(5);
  const hits = new Map();
  for (const term of variants) for (const hit of (map.variants || {})[term] || []) if (!hits.has(hit.id)) hits.set(hit.id, hit);
  const selected = [...hits.values()].slice(0, 20);
  if (!selected.length) { console.log('No memories found for: ' + JSON.stringify(variants.join(' '))); return; }
  console.log('Found ' + selected.length + ' memories:\\n');
  selected.forEach((hit, i) => {
    console.log('[' + (i + 1) + '] #' + hit.id + ' (' + hit.type + ') — ' + hit.title);
    console.log('    ' + hit.preview);
    console.log('    ' + hit.date + (hit.project ? ' | project: ' + hit.project : '') + ' | scope: ' + hit.scope + '\\n');
  });
}, map.sleep || 0);
`)
    put(join(s.bin, 'engram'), `#!/bin/sh\nexec node "${script}" "$@"\n`)
    chmodSync(join(s.bin, 'engram'), 0o755)
  }
  return s
}
function cli(s: Setup, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: s.repo, env: { ...s.env, ...extra }, encoding: 'utf8' })
  assert.equal(result.error, undefined)
  return { code: result.status, out: JSON.parse(result.stdout), stderr: result.stderr }
}
function query(s: Setup, topic: string): RecallResult & { state: string; next: string } {
  const result = cli(s, ['recall', topic])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.out.state, 'ok')
  return result.out
}
function calls(s: Setup): Call[] {
  return existsSync(s.log) ? readFileSync(s.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}
function hit(id: number): EngramHit {
  return { id, type: 'decision', title: `Memory ${id}`, preview: 'Primera línea\nsegunda línea', preview_truncated: true,
    date: '2026-10-01 12:00:00', project: 'project', scope: 'project' }
}
function configure(s: Setup, registry?: string): void {
  put(join(s.repo, '.sdd-ai', 'config.yml'), `knowledge-vault:\n  path_vault: ${JSON.stringify(s.vault)}\n`)
  put(join(s.vault, '.kv', 'identidades.tsv'), registry ?? `project\t\t${git(s.repo, 'rev-list', '--max-parents=0', 'HEAD')}\t${s.repo}\n`)
}
function flow(s: Setup, id: string, body: string, date: string | null = '2026-10-01'): void {
  put(join(s.vault, 'projects', 'project', 'sdd', `${id}.md`), `---\ntype: sdd-flow\ntitle: Spec — un flujo: con dos puntos\nstate: archived\n${date ? `date: ${date}\n` : ''}summary: Decisión: registrada (a2c6a7c)\n---\n${body}\n`)
}
function fingerprint(root: string): Array<{ path: string; size: number; sha256: string }> {
  const files: Array<{ path: string; size: number; sha256: string }> = []
  const walk = (path: string) => {
    const info = lstatSync(path)
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
    else if (info.isFile()) files.push({ path: relative(root, path), size: info.size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
  }
  walk(root)
  return files
}

test('recall sin tema responde usage sin consultar fuentes y con tema devuelve las cuatro fuentes con estado, modo, aciertos y recorte', () => {
  const s = setup()
  for (const args of [['recall'], ['recall', '   '], ['recall', '--']]) {
    const result = cli(s, args)
    assert.equal(result.code, 2)
    assert.equal(result.out.code, 'usage')
    assert.deepEqual(calls(s), [])
  }
  const dashed = cli(s, ['recall', '--unknown'])
  assert.equal(dashed.code, 0)
  assert.equal(dashed.out.topic, '--unknown')
  assert.equal(cli(s, ['recall', '--', '-x']).out.topic, '-x')
  const out = cli(s, ['recall', 'tema', 'TÉMA', 'otro']).out
  assert.equal(out.state, 'ok')
  assert.equal(out.topic, 'tema TÉMA otro')
  assert.deepEqual(out.terms, ['tema', 'otro'])
  assert.deepEqual(Object.keys(out.sources), ['engram', 'vault', 'plans', 'git'])
  for (const [name, list] of [['engram', 'hits'], ['vault', 'flows'], ['plans', 'groups'], ['git', 'commits']]) {
    assert.equal(typeof out.sources[name].status, 'string')
    assert.equal(typeof out.sources[name].truncated, 'boolean')
    assert.ok(Array.isArray(out.sources[name][list]))
    if (out.sources[name].status === 'ok') assert.ok(['all', 'any'].includes(out.sources[name].match))
  }
})

test('cada fuente busca con todos los términos y, si no da nada, con cualquiera, y declara el modo', () => {
  const s = setup()
  configure(s)
  flow(s, 'f1', 'alfa beta')
  put(join(s.repo, '.plans', 'f1', 'spec.md'), 'alfa')
  put(join(s.repo, '.plans', 'f1', 'plan.md'), 'beta')
  put(join(s.repo, '.plans', 'hallazgos.md'), 'alfa')
  commit(s, 'alfa beta')
  fake(s, { variants: { alfa: [hit(1)], beta: [hit(1)] } })
  let sources = query(s, 'alfa beta').sources
  assert.equal(sources.vault.match, 'all')
  assert.equal(sources.plans.match, 'any')
  assert.equal(sources.git.match, 'all')
  assert.equal(sources.engram.match, 'all')
  flow(s, 'f1', 'alfa')
  put(join(s.vault, 'projects', 'project', 'sdd', 'f1', 'plan.md'), 'beta')
  sources = query(s, 'alfa beta').sources
  assert.equal(sources.vault.match, 'any')
  for (const source of Object.values(query(s, 'alfa').sources)) assert.equal(source.match, 'all')
  const any = query(s, 'alfa ausente').sources
  for (const source of Object.values(any)) assert.equal(source.match, 'any')
})

test('el vault, plans y git encuentran una palabra con tilde o sin ella en las dos direcciones', () => {
  const s = setup()
  configure(s)
  for (const [stored, topic] of [['Búsqueda', 'busqueda'], ['busqueda', 'BÚSQUEDA']]) {
    flow(s, 'f1', stored)
    put(join(s.repo, '.plans', 'hallazgos.md'), stored)
    commit(s, stored)
    const sources = query(s, topic).sources
    assert.equal(sources.vault.flows.length, 1)
    assert.equal(sources.plans.groups.length, 1)
    assert.ok(sources.git.commits.some((entry) => entry.subject === stored))
  }
  flow(s, 'f1', 'ano')
  put(join(s.repo, '.plans', 'hallazgos.md'), 'ano')
  commit(s, 'ano')
  const sources = query(s, 'año').sources
  assert.equal(sources.vault.flows.length, 0)
  assert.equal(sources.plans.groups.length, 0)
  assert.equal(sources.git.commits.length, 0)
  flow(s, 'f1', 'LINGÜÍSTICA garçon')
  assert.equal(query(s, 'linguistica').sources.vault.flows.length, 1)
  assert.equal(query(s, 'garcon').sources.vault.flows.length, 0)
})

test('engram recibe una búsqueda por término con sus variantes en orden y todos los términos son los aciertos comunes', () => {
  const s = setup()
  fake(s, { variants: { búsqueda: [hit(1), hit(2)], vault: [hit(2), hit(3)] } })
  const source = query(s, 'busqueda vault').sources.engram
  assert.equal(source.match, 'all')
  assert.deepEqual(source.hits.map((entry) => entry.id), [2])
  const log = calls(s).filter((call) => call.end === undefined)
  assert.equal(log.length, 2)
  assert.deepEqual(log[0].argv, ['search', '--match', 'any', '--limit', '20', 'busqueda', 'búsqueda', 'büsqueda', 'busqúeda', 'busqüeda', 'busquéda', 'busquedá'])
  fake(s, { variants: { busqueda: [hit(1), hit(2)], vault: [hit(3), hit(4)] } })
  const union = query(s, 'busqueda vault').sources.engram
  assert.equal(union.match, 'any')
  assert.deepEqual(union.hits.map((entry) => entry.id), [3, 1, 4, 2])
  fake(s, { variants: { tema: Array.from({ length: 7 }, (_, i) => hit(i + 1)) } })
  assert.equal(query(s, 'tema').sources.engram.hits.length, 5)
  assert.equal(query(s, 'tema').sources.engram.truncated, true)
})

test('las variantes de un término compuesto combinan sus tramos y pasadas las 64 se recortan conservando las dos primeras', () => {
  assert.ok(termVariants('teorico-practico').variants.includes('teórico-práctico'))
  assert.deepEqual(termVariants('busqueda').variants.slice(0, 3), ['busqueda', 'búsqueda', 'büsqueda'])
  assert.deepEqual(termVariants('u').variants, ['u', 'ú', 'ü'])
  const term = 'Áaaaa-eeee-iiii-oooo-uuuu'
  const result = termVariants(term)
  assert.equal(result.variants.length, 64)
  assert.equal(result.capped, true)
  assert.deepEqual(result.variants.slice(0, 2), [term, 'aaaaa-eeee-iiii-oooo-uuuu'])
  assert.equal(new Set(result.variants).size, 64)
  assert.deepEqual(termVariants('a-a').variants, ['a-a', 'á-a', 'a-á', 'á-á'])
})

test('engram corre sin --project ni ENGRAM_PROJECT desde la raíz y cada acierto trae id, tipo, título, recorte, fecha, proyecto y alcance', () => {
  const s = setup()
  fake(s, { variants: { tema: [hit(1)] } })
  const result = cli(s, ['recall', 'tema'], { ENGRAM_PROJECT: 'wrong' })
  assert.equal(result.code, 0)
  assert.deepEqual(result.out.sources.engram.hits, [hit(1)])
  assert.equal(result.out.sources.engram.project, 'project')
  for (const call of calls(s)) {
    assert.equal(call.cwd, s.repo)
    assert.equal(call.project, undefined)
    assert.ok(!call.argv.includes('--project'))
  }
  fake(s, { variants: { tema: [{ ...hit(2), project: null }] } })
  assert.equal(query(s, 'tema').sources.engram.hits[0].project, null)
  rmSync(s.log, { force: true })
  query(s, '--project otro --all')
  const flags = ['--type', '--project', '--all', '--limit', '--scope', '--match']
  const started = calls(s).filter((call) => call.end === undefined)
  assert.equal(started.length, 3)
  for (const call of started) assert.ok(call.argv.slice(5).every((arg) => !flags.includes(arg)), call.argv.join(' '))
  assert.deepEqual(started.map((call) => call.argv[5]), ['"--project"', 'otro', '"--all"'])
})

test('engram ausente queda unavailable y un error, una salida irreconocible o un cero con listas llenas quedan marcados sin tumbar las otras fuentes', () => {
  const absent = setup(false)
  assert.equal(query(absent, 'tema').sources.engram.status, 'unavailable')
  const s = setup()
  for (const [map, reason] of [
    [{ exit: 1, stderr: 'engram: unknown project: x\nother' }, 'engram: unknown project: x'],
    [{ raw: 'garbage' }, 'unrecognized_output'],
    [{ raw: 'Found 2 memories:\n\n[1] #1 (decision) — title\n    body\n    2026-10-01 | scope: project\n' }, 'unrecognized_output'],
  ] as Array<[FakeMap, string]>) {
    fake(s, map)
    const sources = query(s, 'tema').sources
    assert.equal(sources.engram.status, 'error')
    assert.equal(sources.engram.reason, reason)
    assert.deepEqual(sources.engram.hits, [])
    assert.equal(sources.plans.status, 'ok')
    assert.equal(sources.git.status, 'ok')
    assert.equal(sources.vault.status, 'not_configured')
  }
  fake(s, { variants: { alfa: Array.from({ length: 20 }, (_, i) => hit(i + 1)), beta: [hit(21)] } })
  const source = query(s, 'alfa beta').sources.engram
  assert.equal(source.match, 'any')
  assert.equal(source.incomplete, true)
  assert.equal(source.truncated, true)
  fake(s, {})
  assert.equal(query(s, 'a-a-a-a-a-a-a-a').sources.engram.incomplete, true)
  chmodSync(join(s.bin, 'engram'), 0o644)
  const blocked = query(s, 'tema').sources.engram
  assert.equal(blocked.status, 'error')
  assert.match(blocked.reason ?? '', /EACCES/)
})

test('engram que no responde dentro del tope queda en error por timeout', () => {
  const s = setup()
  fake(s, { sleep: 5000 })
  let start = Date.now()
  let source = searchEngram(s.repo, ['tema'], { env: s.env, timeoutMs: 300 })
  assert.equal(source.status, 'error')
  assert.equal(source.reason, 'timeout')
  assert.ok(Date.now() - start < 3000)
  rmSync(s.log, { force: true })
  fake(s, { sleep: 400 })
  source = searchEngram(s.repo, ['alfa', 'beta', 'gamma'], { env: s.env, timeoutMs: 900 })
  assert.equal(source.reason, 'timeout')
  const log = calls(s)
  assert.ok(log.filter((call) => call.end !== undefined).length < 3)
  fake(s, { sleep: 5000 })
  start = Date.now()
  const result = recall(s.repo, 'tema', { env: s.env, engramTimeoutMs: 300 })
  assert.equal(result.sources.engram.reason, 'timeout')
  assert.ok(Date.now() - start < 3000)
  assert.equal(result.sources.plans.status, 'ok')
  assert.equal(result.sources.git.status, 'ok')
})

test('el vault sale solo de path_vault, queda not_configured sin él, error con raíz o registro ilegibles y unresolved sin un proyecto único', () => {
  const s = setup()
  const config = join(s.repo, '.sdd-ai', 'config.yml')
  assert.equal(query(s, 'tema').sources.vault.status, 'not_configured')
  put(config, 'other: true\n')
  assert.equal(query(s, 'tema').sources.vault.status, 'not_configured')
  for (const text of ['knowledge-vault:\n  path_vault: 3\n', 'knowledge-vault: [', 'knowledge-vault:\n  path_vault: /no/such/vault\n']) {
    put(config, text)
    const sources = query(s, 'tema').sources
    assert.equal(sources.vault.status, 'error')
    assert.equal(sources.plans.status, 'ok')
    assert.equal(sources.git.status, 'ok')
  }
  configure(s, 'one\ttwo\tthree\n')
  assert.equal(query(s, 'tema').sources.vault.status, 'error')
  rmSync(join(s.vault, '.kv', 'identidades.tsv'))
  assert.equal(query(s, 'tema').sources.vault.status, 'error')
  configure(s, 'other\t\tunrelated\t/path\n')
  let source = query(s, 'tema').sources.vault
  assert.equal(source.status, 'unresolved')
  assert.deepEqual(source.candidates, [])
  git(s.repo, 'remote', 'add', 'origin', 'git@EXAMPLE.com:Owner/Repo.git')
  configure(s, `by-root\t\t${git(s.repo, 'rev-list', '--max-parents=0', 'HEAD')}\t/path\nby-remote\thttps://example.com/owner/repo.git\tother\t/path\n`)
  source = query(s, 'tema').sources.vault
  assert.equal(source.status, 'unresolved')
  assert.deepEqual(source.candidates, ['by-root', 'by-remote'])
  configure(s, 'project\thttps://example.com/owner/repo.git\tother\t/path\n')
  put(config, 'knowledge-vault:\n  path_vault: ../vault\n')
  source = query(s, 'tema').sources.vault
  assert.equal(source.status, 'ok')
  assert.equal(source.project, 'project')
  symlinkSync(s.vault, join(s.root, 'vault-link'))
  put(config, 'knowledge-vault:\n  path_vault: ../vault-link\n')
  assert.equal(query(s, 'tema').sources.vault.status, 'ok')
  const late = searchVault(s.repo, ['tema'], Date.now() - 1)
  assert.equal(late.status, 'error')
  assert.match(late.reason ?? '', /Git no respondió/)
})

test('el vault busca solo nodos y documentos de flujo sin evidencia, agrupa por flujo con state, date y summary y ordena por términos y fecha', () => {
  const s = setup()
  configure(s)
  flow(s, 'old', 'tema', '2025-01-01')
  flow(s, 'new', ['tema ' + 'x'.repeat(220), 'no coincide', 'tema', 'tema', 'tema', 'tema'].join('\n'), '2026-10-01')
  flow(s, 'undated', 'tema', null)
  const base = join(s.vault, 'projects', 'project')
  put(join(base, 'index.md'), 'exclusive')
  put(join(base, 'sdd', 'index.md'), 'exclusive')
  put(join(base, 'sdd', 'new', 'index.md'), 'exclusive')
  put(join(base, 'sdd', 'new', 'evidencia', 'x.md'), 'exclusive')
  symlinkSync(join(base, 'index.md'), join(base, 'sdd', 'linked.md'))
  assert.equal(query(s, 'exclusive').sources.vault.flows.length, 0)
  const source = query(s, 'tema').sources.vault
  assert.deepEqual(source.flows.map((entry) => entry.flow), ['new', 'old', 'undated'])
  const newest = source.flows[0]
  assert.equal(newest.state, 'archived')
  assert.equal(newest.date, '2026-10-01')
  assert.equal(newest.summary, 'Decisión: registrada (a2c6a7c)')
  assert.equal(newest.node, 'sdd/new.md')
  assert.equal(newest.lines.length, 3)
  assert.equal(newest.omitted_lines, 2)
  assert.equal(newest.lines[0].path, 'sdd/new.md')
  assert.equal(newest.lines[0].line, 8)
  assert.equal([...newest.lines[0].text].length, 200)
  assert.equal(newest.lines[0].cut, true)
  for (const id of ['f1', 'f2', 'f3']) flow(s, id, 'tema', '2026-01-01')
  const capped = query(s, 'tema').sources.vault
  assert.equal(capped.flows.length, 5)
  assert.equal(capped.truncated, true)
  flow(s, 'priority', 'tema otro', '2020-01-01')
  assert.equal(query(s, 'tema otro missing').sources.vault.flows[0].flow, 'priority')
})

test('plans busca todo el Markdown del checkout y los flujos abiertos de otros worktrees, agrupa por flujo o documento y avisa si no hay .plans', () => {
  const s = setup()
  let source = query(s, 'tema').sources.plans
  assert.equal(source.present, false)
  assert.equal(source.status, 'ok')
  assert.deepEqual(source.groups, [])
  const other = join(s.root, 'other')
  git(s.repo, 'worktree', 'add', '-q', '--detach', other)
  put(join(s.repo, '.plans', 'hallazgos.md'), 'tema')
  put(join(s.repo, '.plans', 'f1', 'spec.md'), 'tema')
  put(join(s.repo, '.plans', 'archived', 'f0', 'plan.md'), 'tema')
  put(join(s.repo, '.plans', 'notas', 'x.md'), 'tema')
  put(join(other, '.plans', 'f2', 'handoff.md'), 'tema')
  put(join(other, '.plans', 'hallazgos.md'), 'tema')
  put(join(other, '.plans', 'archived', 'f3', 'spec.md'), 'tema')
  put(join(other, '.plans', 'notas', 'x.md'), 'tema')
  source = query(s, 'tema').sources.plans
  assert.equal(source.groups.length, 5)
  const find = (id: string) => source.groups.find((group) => group.id === id)
  assert.equal(find('hallazgos.md')?.kind, 'document')
  assert.equal(find('notas/x.md')?.kind, 'document')
  assert.equal(find('f1')?.kind, 'flow')
  assert.equal(find('archived/f0')?.kind, 'flow')
  assert.equal(find('f2')?.worktree, other)
  assert.equal(find('f2')?.lines[0].path, '.plans/f2/handoff.md')
  assert.ok(!find('archived/f3'))
  assert.equal(source.groups.filter((group) => group.worktree === other).length, 1)
  put(join(s.repo, '.plans', 'older', 'spec.md'), 'ranking')
  put(join(s.repo, '.plans', 'newer', 'spec.md'), 'ranking')
  put(join(s.repo, '.plans', 'newer', 'notes.md'), 'sin coincidencias')
  utimesSync(join(s.repo, '.plans', 'older', 'spec.md'), 100, 200)
  utimesSync(join(s.repo, '.plans', 'newer', 'spec.md'), 100, 100)
  utimesSync(join(s.repo, '.plans', 'newer', 'notes.md'), 100, 300)
  assert.deepEqual(query(s, 'ranking').sources.plans.groups.map((group) => group.id), ['newer', 'older'])
  put(join(s.repo, '.plans', 'ranking.md'), 'ranking')
  assert.equal(query(s, 'tema ranking').sources.plans.truncated, true)
  const linked = setup()
  const target = join(linked.root, 'external-plans')
  put(join(target, 'x.md'), 'tema')
  symlinkSync(target, join(linked.repo, '.plans'))
  assert.equal(query(linked, 'tema').sources.plans.present, false)
  assert.deepEqual(query(linked, 'tema').sources.plans.groups, [])
})

test('git busca en los mensajes de todas las ramas y cada commit trae sha corto, fecha, refs y asunto', () => {
  const s = setup()
  git(s.repo, 'checkout', '-qb', 'other')
  commit(s, 'Subject\n\nbody-only-term')
  git(s.repo, 'checkout', '-q', 'main')
  const commits = query(s, 'body-only-term').sources.git.commits
  assert.equal(commits.length, 1)
  assert.equal(commits[0].subject, 'Subject')
  assert.match(commits[0].sha, /^[0-9a-f]{7,40}$/)
  assert.match(commits[0].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(commits[0].refs.includes('other'))
  for (let i = 0; i < 12; i++) commit(s, `matching ${i}`)
  const source = query(s, 'matching').sources.git
  assert.equal(source.commits.length, 10)
  assert.equal(source.truncated, true)
  assert.equal(source.commits[0].subject, 'matching 11')
})

test('el next dice qué fuente manda, que recordar no autoriza una acción, que se cita el origen y cómo leer el contenido completo', () => {
  const s = setup()
  const next = query(s, 'tema').next
  for (const word of ['vault manda', 'Engram', 'viejos', 'código y Git mandan', 'contradicción', 'verifica en el código', 'no autoriza', 'origen', 'mem_get_observation', 'MCP', 'ruta', 'git show <sha>']) {
    assert.ok(next.includes(word), word)
  }
})

test('recall no escribe en el repositorio, en .plans, en el vault ni en .sdd-ai y responde con una restauración de verify pendiente', () => {
  const s = setup()
  configure(s)
  flow(s, 'f1', 'tema')
  put(join(s.repo, '.plans', 'f1', 'spec.md'), 'tema')
  const intent = join(s.repo, '.git', 'sdd-ai', 'verify', 'restore-intent.json')
  put(intent, JSON.stringify({ receipt: 'test', checkout: s.repo, owner_pid: 2147483647, owner_lstart: null, paths: [] }))
  const before = [fingerprint(s.repo), fingerprint(s.vault)]
  const content = readFileSync(intent)
  assert.equal(query(s, 'tema').state, 'ok')
  assert.deepEqual([fingerprint(s.repo), fingerprint(s.vault)], before)
  assert.deepEqual(readFileSync(intent), content)
})
