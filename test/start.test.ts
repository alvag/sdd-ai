import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { readHeader } from '../src/sdd/markdown.ts'
import { prepareIntent, writeRestoreIntent } from '../src/sdd/restore.ts'
import { type FlowFilesIo, writeFlowFiles } from '../src/sdd/start.ts'
import { SddError } from '../src/types.ts'
import { makeFakeBin } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const scratch: string[] = []
after(() => { for (const path of scratch) rmSync(path, { recursive: true, force: true }) })
interface Setup { root: string; repo: string; bin: string; request: string; env: Record<string, string> }
function put(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}
function git(s: Setup, ...args: string[]): string {
  return execFileSync('git', args, { cwd: s.repo, encoding: 'utf8', env: { ...process.env, ...s.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } }).trim()
}
function configure(s: Setup, families = '[claude, codex]', extra = ''): void {
  put(join(s.repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: ${families}\n  selection: full\n${extra}`)
}
function setup(o: { commits?: boolean; codex?: boolean; families?: string } = {}): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-start-')))
  scratch.push(root)
  const s: Setup = { root, repo: join(root, 'repo'), bin: join(root, 'bin'), request: join(root, 'request.md'), env: {} }
  for (const path of [s.repo, s.bin, join(root, 'home'), join(root, 'codexhome')]) mkdirSync(path)
  symlinkSync(process.execPath, join(s.bin, 'node'))
  s.env = { PATH: `${s.bin}:/usr/bin:/bin`, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codexhome'),
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's-start', FAKE_MODE: 'ok-codex' }
  for (const family of o.codex === false ? ['claude'] : ['claude', 'codex']) {
    put(join(s.bin, family), '#!/bin/sh\nexit 0\n')
    chmodSync(join(s.bin, family), 0o755)
  }
  git(s, 'init', '-q', '-b', 'main')
  if (o.commits !== false) {
    put(join(s.repo, 'base.txt'), 'base\n')
    git(s, 'add', 'base.txt')
    git(s, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial')
  }
  configure(s, o.families)
  put(s.request, Buffer.from('Pedido literal.\r\n\n', 'utf8'))
  return s
}
function cli(s: Setup, args: string[]) {
  const r = spawnSync(BIN, args, { cwd: s.repo, env: s.env, encoding: 'utf8' })
  assert.equal(r.error, undefined)
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}
const flags = (s: Setup) => ['--apply', '--depth', 'normal', '--risk', 'low', '--change-type', 'feat', '--request', s.request]
const preview = (s: Setup, id = 'mi-flujo', extra: string[] = []) => cli(s, ['sdd', 'start', id, ...extra])
const apply = (s: Setup, id = 'mi-flujo', extra: string[] = []) => preview(s, id, [...flags(s), ...extra])

function tree(root: string): Array<{ path: string; bytes?: string; mode: number }> {
  const out: Array<{ path: string; bytes?: string; mode: number }> = []
  const walk = (path: string) => {
    const st = lstatSync(path)
    out.push({ path: relative(root, path), mode: st.mode, ...(st.isFile() ? { bytes: readFileSync(path).toString('base64') } : {}) })
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
  }
  walk(root)
  return out
}
function fakeEngram(s: Setup, fail = false): void {
  put(join(s.bin, 'engram'), fail ? '#!/bin/sh\necho "falló Engram" >&2\nexit 1\n'
    : '#!/bin/sh\ncat <<\'EOF\'\nFound 1 memories:\n\n[1] #42 (decision) — Tema recordado\n    Un antecedente del tema\n    2026-10-01 12:00:00 | project: test | scope: project\n\nEOF\n')
  chmodSync(join(s.bin, 'engram'), 0o755)
}

test('el ensayo de sdd start no escribe nada e informa config, familias, estado del flujo, HEAD, antecedentes y bloqueos, y un id inválido es usage', () => {
  const s = setup()
  const before = tree(s.repo)
  const r = preview(s)
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(tree(s.repo), before)
  assert.equal(existsSync(join(s.repo, '.plans')), false)
  assert.equal(r.out.id, 'mi-flujo')
  assert.equal(r.out.topic, 'mi flujo')
  assert.equal(r.out.config.state, 'ok')
  assert.deepEqual(r.out.families, [{ family: 'claude', cli: true }, { family: 'codex', cli: true }])
  assert.equal(r.out.flow.state, 'absent')
  assert.deepEqual(r.out.head, { branch: 'main', commit: git(s, 'rev-parse', 'HEAD') })
  assert.equal(r.out.base_branch, 'main')
  assert.equal(r.out.origin_sha, r.out.head.commit)
  assert.deepEqual(Object.keys(r.out.antecedents.sources), ['engram', 'vault', 'plans', 'git'])
  assert.match(r.out.antecedents.next, /El vault manda/)
  assert.deepEqual(r.out.blockers, [])
  for (const flag of ['--apply', '--depth', '--risk', '--change-type', '--request']) assert.ok(r.out.next.includes(flag))
  const base = git(s, 'rev-parse', 'HEAD')
  put(join(s.repo, 'base.txt'), 'candidate\n')
  const intent = prepareIntent(s.repo, '20261001-1200-aaaa', base, ['base.txt'])
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  assert.ok(dead)
  writeRestoreIntent(s.repo, { ...intent, owner_pid: dead, owner_lstart: null })
  const pending = tree(s.repo)
  assert.equal(preview(s).code, 0)
  assert.deepEqual(tree(s.repo), pending)
  for (const extra of [[], ['--apply']]) {
    const invalid = preview(s, '../bad', extra)
    assert.notEqual(invalid.code, 0)
    assert.equal(invalid.out.code, 'usage')
    assert.deepEqual(tree(s.repo), pending)
  }
  for (const [flag, value] of [['--depth', 'normal'], ['--risk', 'low'], ['--change-type', 'feat'], ['--request', s.request]]) {
    assert.equal(preview(s, 'mi-flujo', [flag, value]).out.code, 'usage')
    assert.deepEqual(tree(s.repo), pending)
  }
})

test('el ensayo muestra las claves de config que sdd-ai usa con lo que implican, marca las demás y bloquea sin config o con config inválida', () => {
  const s = setup()
  configure(s, '[claude, codex]', 'vault_archive: {mode: auto}\njira_approval: {mode: "off"}\nknowledge-vault: {path_vault: "./vault"}\n')
  const r = preview(s)
  assert.equal(r.code, 0)
  assert.deepEqual(r.out.config.unused, ['vault_archive'])
  assert.deepEqual(r.out.config.used.map((v: { key: string }) => v.key), ['cross_model', 'branch_format', 'branch_prefix', 'default_branch', 'jira_approval.mode', 'knowledge-vault.path_vault'])
  for (const v of r.out.config.used) {
    assert.ok(v.means.length > 0)
    assert.ok(Object.hasOwn(v, 'value'))
  }
  rmSync(join(s.repo, '.sdd-ai', 'config.yml'))
  const missing = preview(s)
  assert.equal(missing.code, 0)
  assert.equal(missing.out.blockers[0].code, 'config_missing')
  assert.equal(missing.out.next, './bin/sdd-ai init')
  for (const [families, extra] of [['[]', ''], ['[claude]', 'jira_approval: {mode: maybe}\n']]) {
    configure(s, families, extra)
    assert.equal(preview(s).out.blockers[0].code, 'config_invalid')
    assert.equal(apply(s).out.code, 'config_invalid')
    assert.equal(existsSync(join(s.repo, '.plans')), false)
  }
  put(join(s.repo, '.sdd-ai', 'config.yml'), 'cross_model: [\n')
  assert.equal(preview(s).out.blockers[0].code, 'config_invalid')
})

test('una familia declarada sin su CLI en el PATH es un bloqueo que la nombra y --apply se niega', () => {
  const s = setup({ codex: false })
  const before = tree(s.repo)
  const r = preview(s)
  assert.equal(r.code, 0)
  assert.deepEqual(r.out.families, [{ family: 'claude', cli: true }, { family: 'codex', cli: false }])
  assert.equal(r.out.blockers[0].code, 'family_cli_missing')
  assert.match(r.out.blockers[0].detail, /codex/)
  const a = apply(s)
  assert.notEqual(a.code, 0)
  assert.equal(a.out.code, 'family_cli_missing')
  assert.deepEqual(tree(s.repo), before)
})

test('con .plans/<id>/ con contenido el ensayo bloquea con flow_exists y --apply se niega sin escribir, y un directorio vacío se adopta', () => {
  const s = setup()
  const dir = join(s.repo, '.plans', 'mi-flujo')
  put(join(dir, 'keep.md'), 'conservar\n')
  const before = tree(s.repo)
  const r = preview(s)
  assert.equal(r.code, 0)
  assert.equal(r.out.flow.state, 'content')
  assert.equal(r.out.blockers[0].code, 'flow_exists')
  assert.equal(r.out.next, './bin/sdd-ai sdd status mi-flujo')
  const a = apply(s)
  assert.equal(a.out.code, 'flow_exists')
  assert.equal(a.out.next, r.out.next)
  assert.deepEqual(tree(s.repo), before)
  rmSync(join(dir, 'keep.md'))
  assert.equal(preview(s).out.flow.state, 'empty')
  assert.deepEqual(preview(s).out.blockers, [])
  assert.equal(apply(s).code, 0)
  assert.deepEqual(readdirSync(dir).sort(), ['antecedentes.json', 'handoff.md', 'pedido.md'])
  const invalid = setup()
  symlinkSync(s.repo, join(invalid.repo, '.plans'))
  assert.equal(preview(invalid).out.blockers[0].code, 'path_invalid')
  assert.equal(apply(invalid).out.code, 'path_invalid')
})

test('con HEAD separado o sin commits bloquea head_unknown, y --base-branch exige una rama local y fija origin_sha a su commit', () => {
  const s = setup()
  git(s, 'checkout', '-q', '--detach')
  for (const extra of [[], ['--base-branch', 'main']]) {
    assert.equal(preview(s, 'mi-flujo', extra).out.blockers[0].code, 'head_unknown')
    assert.equal(apply(s, 'mi-flujo', extra).out.code, 'head_unknown')
  }
  const empty = setup({ commits: false })
  assert.equal(preview(empty).out.blockers[0].code, 'head_unknown')
  assert.equal(apply(empty).out.code, 'head_unknown')
  git(s, 'switch', '-q', 'main')
  git(s, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'segundo')
  for (const base of ['nope', 'main~1', 'main@{1}', 'HEAD']) {
    assert.equal(preview(s, 'mi-flujo', ['--base-branch', base]).out.blockers[0].code, 'base_branch_unknown', base)
    assert.equal(apply(s, 'mi-flujo', ['--base-branch', base]).out.code, 'base_branch_unknown', base)
  }
  const main = git(s, 'rev-parse', 'main')
  git(s, 'switch', '-qc', 'feat')
  git(s, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'feature')
  const r = preview(s, 'mi-flujo', ['--base-branch', 'main'])
  assert.deepEqual(r.out.blockers, [])
  assert.equal(r.out.base_branch, 'main')
  assert.equal(r.out.origin_sha, main)
  assert.notEqual(r.out.origin_sha, r.out.head.commit)
  assert.match(r.out.next, /--base-branch 'main'/)
  const a = apply(s, 'mi-flujo', ['--base-branch', 'main'])
  assert.equal(a.code, 0)
  assert.equal(a.out.handoff.origin_sha, main)
  assert.equal(a.out.handoff.base_branch, 'main')
})

test('--apply sin un flag, con un valor fuera de su vocabulario o con un pedido vacío responde error sin escribir nada', () => {
  const s = setup()
  const before = tree(s.repo)
  for (const flag of ['--depth', '--risk', '--change-type', '--request']) {
    const args = flags(s)
    args.splice(args.indexOf(flag), 2)
    const r = preview(s, 'mi-flujo', args)
    assert.notEqual(r.code, 0)
    assert.equal(r.out.code, 'usage')
    assert.ok(r.out.message.includes(flag))
    assert.deepEqual(tree(s.repo), before)
  }
  for (const [flag, value, vocabulary] of [['--depth', 'media', ['corta', 'normal', 'completa']], ['--risk', 'mid', ['low', 'high', 'unknown']],
    ['--change-type', 'feature', ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'perf']]] as const) {
    const args = flags(s)
    args[args.indexOf(flag) + 1] = value
    const r = preview(s, 'mi-flujo', args)
    assert.equal(r.out.code, 'usage')
    for (const word of [flag, ...vocabulary]) assert.ok(r.out.message.includes(word), word)
    assert.deepEqual(tree(s.repo), before)
  }
  for (const empty of [true, false]) {
    if (empty) put(s.request, '')
    else rmSync(s.request)
    const r = apply(s)
    assert.notEqual(r.code, 0)
    assert.equal(r.out.code, 'request_invalid')
    assert.deepEqual(tree(s.repo), before)
    assert.equal(existsSync(join(s.repo, '.plans', 'mi-flujo')), false)
  }
  const p = setup()
  put(join(p.repo, '.plans', 'lleno', 'handoff.md'), 'x')
  put(join(p.repo, 'base.txt'), 'candidate\n')
  const intent = prepareIntent(p.repo, '20261001-1200-bbbb', git(p, 'rev-parse', 'HEAD'), ['base.txt'])
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  assert.ok(dead)
  writeRestoreIntent(p.repo, { ...intent, owner_pid: dead, owner_lstart: null })
  const pending = tree(p.repo)
  const missing = flags(p)
  missing.splice(missing.indexOf('--depth'), 2)
  for (const [id, args, code] of [['mi-flujo', missing, 'usage'], ['lleno', flags(p), 'flow_exists']] as const) {
    const r = preview(p, id, [...args])
    assert.equal(r.out.code, code, id)
    assert.deepEqual(tree(p.repo), pending, id)
  }
})

test('--apply escribe pedido.md igual al archivo, antecedentes.json de recall y el handoff con el snapshot, y status pasa a specify', () => {
  const s = setup()
  const r = apply(s)
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const dir = join(s.repo, '.plans', 'mi-flujo')
  assert.deepEqual(readFileSync(join(dir, 'pedido.md')), readFileSync(s.request))
  assert.deepEqual(r.out.created.sort(), ['antecedentes.json', 'handoff.md', 'pedido.md'].map((name) => `.plans/mi-flujo/${name}`))
  const antecedents = JSON.parse(readFileSync(join(dir, 'antecedentes.json'), 'utf8'))
  assert.deepEqual(Object.keys(antecedents.sources), ['engram', 'vault', 'plans', 'git'])
  const header = readHeader(readFileSync(join(dir, 'handoff.md'), 'utf8'))
  if (!header.ok) throw new Error(header.detail)
  assert.deepEqual(header.data, {
    phase: 'specify', profundidad: 'normal', risk: 'low', change_type: 'feat', slug: 'mi-flujo', base_branch: 'main', spec_approved_at: null,
    overrides: { branch_prefix: null, base_branch: null, cross_review: null, implement_mode: null, jira_approval: null, worktree: null },
    worktree_location: 'current', origin_sha: git(s, 'rev-parse', 'HEAD'), main_worktree: s.repo, context_root: s.repo,
  })
  assert.deepEqual(r.out.handoff, header.data)
  assert.match(header.body, /## Config y familias/)
  assert.match(header.body, /## Antecedentes/)
  assert.equal(cli(s, ['sdd', 'status', 'mi-flujo']).out.next.step, 'specify')
  assert.equal(r.out.next, './bin/sdd-ai sdd phase mi-flujo --request .plans/mi-flujo/pedido.md')
  assert.equal(statSync(dir).mode & 0o777, statSync(join(s.repo, '.plans')).mode & 0o777)
})

test('si una escritura falla a mitad, .plans/<id>/ queda como estaba y no queda el temporal', () => {
  const files = { 'pedido.md': 'pedido', 'antecedentes.json': '{}', 'handoff.md': 'handoff' }
  for (const empty of [false, true]) {
    const s = setup()
    const dir = join(s.repo, '.plans', 'f1')
    if (empty) mkdirSync(dir, { recursive: true })
    let writes = 0
    const io: FlowFilesIo = { mkdtemp: mkdtempSync, rename: renameSync, rm: (path) => rmSync(path, { recursive: true, force: true }),
      writeFile: (path, data) => { if (++writes === 3) throw new Error('fallo inyectado'); writeFileSync(path, data) } }
    assert.throws(() => writeFlowFiles(s.repo, 'f1', files, io), (e) => e instanceof SddError && e.code === 'flow_write_failed')
    assert.equal(existsSync(dir), empty)
    if (empty) assert.deepEqual(readdirSync(dir), [])
    assert.deepEqual(readdirSync(join(s.repo, '.sdd-ai', 'tmp')), [])
  }
  {
    const s = setup()
    const io: FlowFilesIo = { mkdtemp: mkdtempSync, writeFile: writeFileSync, rm: (path) => rmSync(path, { recursive: true, force: true }),
      rename: () => { throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' }) } }
    assert.throws(() => writeFlowFiles(s.repo, 'f1', files, io), (e) => e instanceof SddError && e.code === 'flow_exists' && e.next === './bin/sdd-ai sdd status f1')
    assert.deepEqual(readdirSync(join(s.repo, '.sdd-ai', 'tmp')), [])
  }
  for (const empty of [false, true]) {
    const s = setup()
    const dir = join(s.repo, '.plans', 'f1')
    if (empty) mkdirSync(dir, { recursive: true })
    assert.equal(existsSync(join(s.repo, '.sdd-ai', 'tmp')), false)
    writeFlowFiles(s.repo, 'f1', files)
    assert.deepEqual(readdirSync(dir).sort(), Object.keys(files).sort())
    for (const [name, bytes] of Object.entries(files)) assert.equal(readFileSync(join(dir, name), 'utf8'), bytes)
    assert.deepEqual(readdirSync(join(s.repo, '.sdd-ai', 'tmp')), [])
  }
})

test('--topic fija el tema de recall, sin él se usa el id con espacios, y una fuente caída queda en su estado sin impedir el arranque', () => {
  const s = setup()
  fakeEngram(s, true)
  assert.equal(preview(s).out.topic, 'mi flujo')
  const before = preview(s, 'mi-flujo', ['--topic', 'otro tema'])
  assert.equal(before.out.antecedents.topic, 'otro tema')
  assert.match(before.out.next, /--topic 'otro tema'/)
  assert.equal(before.out.antecedents.sources.engram.status, 'error')
  assert.equal(apply(s, 'mi-flujo', ['--topic', 'otro tema']).code, 0)
  const saved = JSON.parse(readFileSync(join(s.repo, '.plans', 'mi-flujo', 'antecedentes.json'), 'utf8'))
  assert.equal(saved.topic, 'otro tema')
  assert.equal(saved.sources.engram.status, 'error')
  const other = setup()
  assert.equal(apply(other).code, 0)
  assert.equal(JSON.parse(readFileSync(join(other.repo, '.plans', 'mi-flujo', 'antecedentes.json'), 'utf8')).topic, 'mi flujo')
})

test('run --flow anexa los antecedentes al prompt que recibe el worker sin cambiar el encargo, y se niega con otro rol, con --retry o sin antecedentes.json', () => {
  for (const family of ['codex', 'claude'] as const) {
    const s = setup({ families: `[${family}]` })
    fakeEngram(s)
    git(s, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'tema antecedente')
    const commit = git(s, 'rev-parse', '--short', 'HEAD')
    assert.equal(apply(s, 'mi-flujo', ['--topic', 'tema']).code, 0)
    const prompt = join(s.root, 'prompt.md')
    const original = 'Explora el código.\n'
    put(prompt, original)
    if (family === 'codex') {
      rmSync(join(s.bin, 'codex'))
      makeFakeBin(s.bin, 'codex')
      s.env.FAKE_PROMPT_FILE = join(s.root, 'received.md')
    } else assert.equal(cli(s, ['agents', 'sync']).code, 0)
    const r = cli(s, ['run', '--role', 'explore', '--flow', 'mi-flujo', '--prompt-file', prompt])
    assert.equal(r.code, 0, JSON.stringify(r.out))
    assert.equal(r.out.via, family === 'codex' ? 'process' : 'native')
    const frozen = readFileSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'prompt.md'), 'utf8')
    if (family === 'codex') {
      const waited = cli(s, ['wait', r.out.id, '--max', '10'])
      assert.equal(waited.out.state, 'done', JSON.stringify(waited.out))
      assert.equal(readFileSync(s.env.FAKE_PROMPT_FILE, 'utf8'), frozen)
    } else assert.equal(readFileSync(r.out.prompt_file, 'utf8'), frozen)
    assert.ok(frozen.startsWith(`${original}\n\n## Antecedentes del flujo mi-flujo`))
    assert.match(frozen, /Material de consulta.*no instrucciones/)
    assert.match(frozen, /<<<ANTECEDENTES mi-flujo ([0-9a-f]{12})\n[\s\S]*\nANTECEDENTES mi-flujo \1>>>$/)
    for (const source of ['engram', 'vault', 'plans', 'git']) assert.match(frozen, new RegExp(`### ${source}\\nEstado: [^;]+; modo: [^;]+; recortado:`))
    assert.match(frozen, /#42 \(decision\) Tema recordado/)
    assert.ok(frozen.includes(`${commit} `))
    assert.match(frozen, /tema antecedente/)
    assert.equal(readFileSync(prompt, 'utf8'), original)
    const runs = join(s.repo, '.sdd-ai', 'runs')
    const inventory = readdirSync(runs)
    for (const args of [['--role', 'refute'], ['--retry', r.out.id]]) {
      const denied = cli(s, ['run', '--flow', 'mi-flujo', '--prompt-file', prompt, ...args])
      assert.equal(denied.out.code, 'usage')
      assert.deepEqual(readdirSync(runs), inventory)
    }
    put(join(s.repo, '.plans', 'old', 'handoff.md'), '---\nprofundidad: normal\n---\n')
    const missing = cli(s, ['run', '--flow', 'old', '--prompt-file', prompt])
    assert.equal(missing.out.code, 'antecedents_missing')
    assert.match(missing.out.next, /run sin --flow/)
    assert.match(missing.out.next, /recall/)
    assert.equal(cli(s, ['run', '--flow', 'absent', '--prompt-file', prompt]).out.code, 'flow_not_found')
    put(join(s.repo, '.plans', 'old', 'antecedentes.json'), '{')
    assert.equal(cli(s, ['run', '--flow', 'old', '--prompt-file', prompt]).out.code, 'antecedents_invalid')
    const broken = JSON.parse(readFileSync(join(s.repo, '.plans', 'mi-flujo', 'antecedentes.json'), 'utf8'))
    broken.sources.engram.hits = [null]
    put(join(s.repo, '.plans', 'old', 'antecedentes.json'), JSON.stringify(broken))
    assert.equal(cli(s, ['run', '--flow', 'old', '--prompt-file', prompt]).out.code, 'antecedents_invalid')
    assert.deepEqual(readdirSync(runs), inventory)
  }
})

test('sdd status de un flujo inexistente nombra sdd start con el id y /sdd-flow', () => {
  const s = setup()
  const r = cli(s, ['sdd', 'status', 'nada'])
  assert.equal(r.code, 1)
  assert.equal(r.out.code, 'flow_not_found')
  assert.ok(r.out.next.includes('./bin/sdd-ai sdd start nada'))
  assert.ok(r.out.next.includes('/sdd-flow'))
})

test('sdd start toma la base de --base-branch, de default_branch o de la rama actual e informa las claves de rama del config', () => {
  const s = setup()
  const base = git(s, 'rev-parse', 'HEAD')
  git(s, 'branch', 'base')
  git(s, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'New main')
  configure(s, '[claude, codex]', "default_branch: base\nbranch_format: '{type}/{slug}'\nbranch_prefix: fix\n")
  const r = preview(s)
  assert.equal(r.out.base_branch, 'base')
  assert.equal(r.out.origin_sha, base)
  for (const [key, value] of [['branch_format', '{type}/{slug}'], ['branch_prefix', 'fix'], ['default_branch', 'base']]) {
    const entry = r.out.config.used.find((v: { key: string }) => v.key === key)
    assert.equal(entry.value, value)
    assert.ok(entry.means.length > 0)
    assert.ok(!r.out.config.unused.includes(key))
  }
  const explicit = preview(s, 'mi-flujo', ['--base-branch', 'main'])
  assert.equal(explicit.out.base_branch, 'main')
  assert.equal(explicit.out.origin_sha, git(s, 'rev-parse', 'HEAD'))
  const applied = apply(s)
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.equal(applied.out.handoff.base_branch, 'base')
  assert.equal(applied.out.handoff.origin_sha, base)
  const plain = setup()
  assert.equal(preview(plain).out.base_branch, 'main')
  const used = preview(plain).out.config.used
  for (const key of ['branch_format', 'branch_prefix', 'default_branch']) assert.equal(used.find((v: { key: string }) => v.key === key).value, null)
  configure(plain, '[claude, codex]', 'default_branch: nope\n')
  assert.equal(preview(plain).out.blockers[0].code, 'base_branch_unknown')
  assert.equal(apply(plain).out.code, 'base_branch_unknown')
  assert.equal(preview(plain, 'mi-flujo', ['--base-branch', 'main']).out.base_branch, 'main')
  for (const extra of ['branch_prefix: 3\n', 'default_branch: 3\n', "default_branch: ''\n"]) {
    configure(plain, '[claude, codex]', extra)
    const invalid = preview(plain).out
    assert.equal(invalid.blockers[0].code, 'config_invalid')
    const key = extra.split(':')[0]
    assert.match(invalid.config.used.find((v: { key: string }) => v.key === key).means, new RegExp(key))
    assert.equal(apply(plain).out.code, 'config_invalid')
    assert.equal(existsSync(join(plain.repo, '.plans')), false)
  }
})
