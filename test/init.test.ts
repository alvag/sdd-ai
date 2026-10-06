import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { parse } from 'yaml'
import { makeFakeBin, makeRepo } from './helpers.ts'
import { copyModSource } from './mod-fixture.ts'

const ROOT = join(import.meta.dirname, '..')
const BIN = join(ROOT, 'bin', 'sdd-ai')
/** Las fuentes que hacen de un repo un checkout de sdd-ai, copiadas del paquete. */
const SOURCES = ['agents/worker.md', 'skills/sdd-ai/SKILL.md', '.claude/settings.json', '.codex/hooks.json']
const CATALOG = ['gpt-6.1-sol', 'gpt-6-luna']

/** Los perfiles que tiene que escribir `init` en un `workers.yml` nuevo. */
const DEFAULTS = {
  explore: { claude: { model: 'sonnet', effort: 'alto' }, codex: { model: 'gpt-6-luna', effort: 'alto' } },
  'counter-plan': { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  investigate: { claude: { model: 'opus', effort: 'muy_alto' }, codex: { model: 'gpt-6.1-sol', effort: 'muy_alto' } },
  debate: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  'design-review': { claude: { model: 'opus', effort: 'muy_alto' }, codex: { model: 'gpt-6.1-sol', effort: 'muy_alto' } },
  implement: { claude: { model: 'sonnet', effort: 'medio' }, codex: { model: 'gpt-6.1-sol', effort: 'medio' } },
  refute: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  'code-review': { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  specify: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  plan: { claude: { model: 'opus', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
  tasks: { claude: { model: 'sonnet', effort: 'alto' }, codex: { model: 'gpt-6.1-sol', effort: 'alto' } },
}

const TWO_FAMILIES = 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n'

interface Checkout { repo: string; env: Record<string, string> }
type Catalog = string[] | { client_version?: string; models: Array<{ slug: string; description?: string }> }
interface Options { bins?: Array<'claude' | 'codex'>; catalog?: Catalog | null; version?: string; config?: string; workers?: string; sources?: boolean }

function environment(bins: Array<'claude' | 'codex'>, catalog: Catalog | null, version?: string): Record<string, string> {
  // PATH controlado: node para el shebang y solo los CLIs falsos pedidos, nunca los reales.
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const b of bins) makeFakeBin(bin, b)
  const codexHome = mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-'))
  if (catalog !== null) writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify(Array.isArray(catalog) ? { models: catalog.map((slug) => ({ slug })) } : catalog))
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-home-')), CODEX_HOME: codexHome, SDD_AI_PROJECTION: 'off', ...(version ? { FAKE_VERSION: version } : {}) }
}

/** Un checkout de sdd-ai con commit, sin `.sdd-ai/` salvo lo que se pida. */
function checkout(o: Options = {}): Checkout {
  const repo = makeRepo()
  if (o.sources !== false) {
    copyModSource(repo)
    for (const rel of SOURCES) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true })
      copyFileSync(join(ROOT, rel), join(repo, rel))
    }
    mkdirSync(join(repo, 'bin'))
    writeFileSync(join(repo, 'bin', 'sdd-ai'), '')
    writeFileSync(join(repo, 'bin', 'sdd-ai-hook'), '')
  } else {
    writeFileSync(join(repo, 'README.md'), 'otro proyecto\n')
  }
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: repo })
  if (o.config !== undefined || o.workers !== undefined) mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  if (o.config !== undefined) writeFileSync(join(repo, '.sdd-ai', 'config.yml'), o.config)
  if (o.workers !== undefined) writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), o.workers)
  return { repo, env: environment(o.bins ?? ['claude', 'codex'], o.catalog === undefined ? CATALOG : o.catalog, o.version) }
}

/** La salida del binario es JSON sin un tipo fijo: cada prueba mira los campos que le importan. */
type Out = Record<string, any>

function cli(c: Checkout, args: string[], cwd = c.repo): { code: number | null; out: Out } {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: c.env, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null') as Out }
}

/** Ensayo y aplicación con los mismos flags. */
function initAndApply(c: Checkout, flags: string[] = [], cwd = c.repo): { dry: Out; applied: { code: number | null; out: Out } } {
  const dry = cli(c, ['init', ...flags], cwd)
  assert.equal(dry.code, 0, JSON.stringify(dry.out))
  return { dry: dry.out, applied: cli(c, ['init', '--apply', '--digest', dry.out.digest, ...flags], cwd) }
}

/** Cada archivo del árbol, fuera de `.git` salvo su `info/exclude`, con su contenido. */
function snapshot(repo: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.git') walk(file)
      } else {
        out.set(relative(repo, file), readFileSync(file, 'utf8'))
      }
    }
  }
  walk(repo)
  const exclude = join(repo, '.git', 'info', 'exclude')
  if (existsSync(exclude)) out.set('.git/info/exclude', readFileSync(exclude, 'utf8'))
  return out
}

/** Contenido y fecha de modificación de lo que `init` administra. */
function stamps(repo: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const dir of ['.sdd-ai', '.claude', '.codex', '.agents']) {
    const walk = (d: string) => {
      if (!existsSync(d)) return
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const file = join(d, entry.name)
        if (entry.isDirectory()) walk(file)
        else out.set(relative(repo, file), `${statSync(file).mtimeMs}:${readFileSync(file, 'utf8')}`)
      }
    }
    walk(join(repo, dir))
  }
  return out
}

const read = (c: Checkout, rel: string) => readFileSync(join(c.repo, rel), 'utf8')
const fileOf = (plan: Out, path: string): Out => plan.files.find((f: Out) => f.path === path)
const codes = (plan: Out): string[] => plan.notes.map((n: Out) => n.code)

test('init se niega fuera de un checkout de sdd-ai sin escribir nada', () => {
  const c = checkout({ sources: false })
  const before = snapshot(c.repo)
  for (const args of [['init'], ['init', '--apply', '--digest', '0123456789abcdef']]) {
    const r = cli(c, args)
    assert.equal(r.code, 2)
    assert.equal(r.out.code, 'runtime_missing')
    assert.match(r.out.next, /instalación global/)
  }
  assert.deepEqual(snapshot(c.repo), before)
})

test('el ensayo de init no escribe nada y muestra config, preguntas, archivos, agentes y digest', () => {
  const fresh = checkout()
  const before = snapshot(fresh.repo)
  const r = cli(fresh, ['init'])
  assert.equal(r.code, 0)
  const plan = r.out
  assert.equal(plan.mode, 'dry_run')
  assert.equal(plan.current, null)
  assert.deepEqual(plan.detected, ['claude', 'codex'])
  assert.deepEqual(plan.questions.map((q: Out) => q.id), ['families', 'jira_approval', 'telemetry'])
  const config = fileOf(plan, '.sdd-ai/config.yml')
  assert.equal(config.action, 'create')
  assert.match(config.content, /families: \[claude, codex\]/)
  assert.match(config.content, /selection: full/)
  assert.match(config.content, /mode: "off"/)
  assert.equal(fileOf(plan, '.sdd-ai/workers.yml').action, 'create')
  assert.deepEqual({ ...fileOf(plan, '.sdd-ai/.gitignore') }, { path: '.sdd-ai/.gitignore', action: 'create', content: '*\n' })
  const agents = plan.agents.map((a: Out) => a.path)
  for (const path of ['.claude/agents/sdd-ai-explore.md', '.codex/agents/sdd-ai-explore.toml', '.claude/skills/sdd-ai/SKILL.md', '.agents/skills/sdd-ai/SKILL.md']) {
    assert.ok(agents.includes(path), path)
  }
  assert.match(plan.digest, /^[0-9a-f]{16}$/)
  assert.ok(plan.next.includes(`init --apply --digest ${plan.digest}`), plan.next)
  assert.equal('writes' in plan, false)
  assert.deepEqual(snapshot(fresh.repo), before)

  const configured = checkout({ config: TWO_FAMILIES })
  const kept = snapshot(configured.repo)
  const again = cli(configured, ['init']).out
  assert.deepEqual(again.current, { families: ['codex', 'claude'], selection: 'full', jira: 'off' })
  assert.equal(fileOf(again, '.sdd-ai/config.yml').action, 'unchanged')
  assert.deepEqual(snapshot(configured.repo), kept)
})

test('las preguntas de init traen lo vigente primero y las respuestas cambian el ensayo', () => {
  const c = checkout({ config: TWO_FAMILIES })
  const plan = cli(c, ['init']).out
  const [families, jira] = plan.questions
  assert.equal(families.flag, '--families')
  assert.equal(families.options[0].value, 'codex,claude')
  assert.match(families.options[0].label, /\(actual\)/)
  assert.deepEqual(families.options.map((o: Out) => o.value).slice(1).sort(), ['claude', 'codex'])
  assert.equal(jira.flag, '--jira')
  assert.deepEqual(jira.options.map((o: Out) => o.value), ['off', 'on'])
  assert.match(jira.options[0].label, /\(actual\)/)

  const single = checkout({ bins: ['claude'] })
  const one = cli(single, ['init']).out
  assert.deepEqual(one.questions.map((q: Out) => q.id), ['jira_approval', 'telemetry'])
  assert.match(fileOf(one, '.sdd-ai/config.yml').content, /families: \[claude\]\n {2}selection: full/)

  const answered = cli(c, ['init', '--families', 'claude', '--jira', 'on']).out
  const config = fileOf(answered, '.sdd-ai/config.yml')
  assert.equal(config.action, 'update')
  assert.match(config.content, /families: \[claude\]/)
  assert.match(config.content, /selection: user_choice/)
  assert.match(config.content, /mode: "on"/)
  assert.notEqual(answered.digest, plan.digest)
  assert.ok(answered.next.includes('--families claude'), answered.next)
})

test('init --apply escribe lo que mostró el ensayo y se niega si algo cambió desde entonces', () => {
  const c = checkout()
  const { dry, applied } = initAndApply(c)
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.equal(applied.out.mode, 'applied')
  for (const f of dry.files.filter((f: Out) => f.action === 'create' || f.action === 'update')) {
    assert.equal(read(c, f.path), f.content, f.path)
  }

  const changed = checkout({ config: TWO_FAMILIES, workers: 'schema_version: 1\nroles: {}\n' })
  const plan = cli(changed, ['init']).out
  writeFileSync(join(changed.repo, '.sdd-ai', 'workers.yml'), 'schema_version: 1\nroles:\n  explore:\n    claude:\n      model: opus\n')
  const edited = snapshot(changed.repo)
  const refused = cli(changed, ['init', '--apply', '--digest', plan.digest])
  assert.equal(refused.code, 2)
  assert.equal(refused.out.code, 'digest_mismatch')
  assert.deepEqual(snapshot(changed.repo), edited)

  // Una fuente de los agentes que cambia después del ensayo también vence su digest.
  const source = checkout()
  const before = cli(source, ['init']).out
  writeFileSync(join(source.repo, 'agents', 'worker.md'), `${read(source, 'agents/worker.md')}\nUna línea más.\n`)
  const stale = cli(source, ['init', '--apply', '--digest', before.digest])
  assert.equal(stale.out.code, 'digest_mismatch')
  assert.equal(existsSync(join(source.repo, '.sdd-ai')), false)

  const noDigest = cli(changed, ['init', '--apply'])
  assert.equal(noDigest.code, 2)
  assert.equal(noDigest.out.code, 'usage')
})

test('init fusiona config.yml y conserva las demás claves y los comentarios', () => {
  const config = [
    '# config de prueba',
    'cross_model:',
    '  schema_version: 1',
    '  families: [codex, claude]   # las dos',
    '  selection: full',
    'knowledge-vault:',
    '  path_vault: "/tmp/vault"',
    'vault_archive:',
    '  mode: "on"   # rescatar',
    '',
  ].join('\n')
  const c = checkout({ config })
  const { applied } = initAndApply(c, ['--families', 'claude'])
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  const text = read(c, '.sdd-ai/config.yml')
  for (const kept of ['# config de prueba', '# las dos', '# rescatar', 'path_vault: "/tmp/vault"', 'mode: "on"']) assert.ok(text.includes(kept), kept)
  const doc = parse(text) as Out
  assert.deepEqual(doc.cross_model, { schema_version: 1, families: ['claude'], selection: 'user_choice' })
  assert.deepEqual(doc['knowledge-vault'], { path_vault: '/tmp/vault' })
  assert.deepEqual(doc.vault_archive, { mode: 'on' })
  // La respuesta de Jira es la vigente, `off` por ausencia: no se agrega una clave que no cambia nada.
  assert.equal(doc.jira_approval, undefined)
  const reread = cli(c, ['init'])
  assert.equal(reread.code, 0, JSON.stringify(reread.out))
  assert.deepEqual(reread.out.current.families, ['claude'])
})

test('sin workers.yml, init lo crea con los perfiles por defecto', () => {
  const c = checkout()
  const { applied } = initAndApply(c)
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.deepEqual(parse(read(c, '.sdd-ai/workers.yml')), { schema_version: 1, roles: DEFAULTS })
})

test('con un catálogo de Codex de un cliente más viejo, init no valida los modelos y avisa con las dos versiones', () => {
  const catalog = { client_version: '0.156.1', models: [{ slug: 'gpt-6-luna' }] }
  const workers = 'schema_version: 1\nroles:\n  implement:\n    codex: { model: gpt-6.1-sol, effort: medio }\n'
  const c = checkout({ config: TWO_FAMILIES, workers, catalog, version: '0.159.0' })
  const dry = cli(c, ['init']).out
  assert.deepEqual(dry.workers.removed, [])
  const result = parse(fileOf(dry, '.sdd-ai/workers.yml').content) as Out
  assert.equal(result.roles.implement.codex.model, 'gpt-6.1-sol')
  const note = dry.notes.find((n: Out) => n.code === 'codex_catalog_outdated')
  assert.ok(note)
  assert.match(note.detail, /0\.156\.1/)
  assert.match(note.detail, /0\.159\.0/)
  assert.equal(codes(dry).includes('codex_default_not_in_catalog'), false)
  assert.equal(codes(dry).includes('codex_catalog_missing'), false)

  const fresh = checkout({ catalog, version: '0.159.0' })
  const freshDry = cli(fresh, ['init']).out
  assert.deepEqual((parse(fileOf(freshDry, '.sdd-ai/workers.yml').content) as Out).roles, DEFAULTS)

  // Un sufijo de prerelease no impide comparar: el triplete 0.156.0 es anterior al instalado.
  const prerelease = checkout({ config: TWO_FAMILIES, workers, catalog: { ...catalog, client_version: '0.156.0-alpha.1' }, version: '0.159.0' })
  assert.ok(codes(cli(prerelease, ['init']).out).includes('codex_catalog_outdated'))

  for (const client_version of ['0.159.0', '0.159.2']) {
    const valid = checkout({ config: TWO_FAMILIES, workers, catalog: { ...catalog, client_version }, version: '0.159.0' })
    const validated = cli(valid, ['init']).out
    assert.ok(validated.workers.removed.some((r: Out) => r.path === 'roles.implement.codex'))
    assert.ok(codes(validated).includes('codex_default_not_in_catalog'))
    assert.equal(codes(validated).includes('codex_catalog_outdated'), false)
  }

  c.env.FAKE_VERSION = '0.160.0'
  const refused = cli(c, ['init', '--apply', '--digest', dry.digest])
  assert.equal(refused.code, 2)
  assert.equal(refused.out.code, 'digest_mismatch')
  c.env.FAKE_VERSION = '0.159.0'
  writeFileSync(join(c.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ ...catalog, client_version: '0.156.2' }))
  assert.equal(cli(c, ['init', '--apply', '--digest', dry.digest]).out.code, 'digest_mismatch')
})

test('init avisa de los perfiles de Codex con un modelo de una generación anterior sin cambiarlos', () => {
  const catalog = { client_version: '0.159.0', models: [
    { slug: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.' },
    { slug: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.' },
    { slug: 'gpt-5.6-terra', description: 'Older balanced model for straightforward work.' },
  ] }
  const workers = 'schema_version: 1\nroles:\n  implement:\n    codex: { model: gpt-5.6-terra, effort: medio }\n'
  const c = checkout({ config: TWO_FAMILIES, workers, catalog, version: '0.159.0' })
  const { dry, applied } = initAndApply(c)
  const notes = dry.notes.filter((n: Out) => n.code === 'codex_model_older_generation')
  assert.equal(notes.length, 1)
  for (const text of ['implement', 'gpt-5.6-terra', 'gpt-6.1-sol', catalog.models[2].description]) assert.ok(notes[0].detail.includes(text), text)
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.equal((parse(read(c, '.sdd-ai/workers.yml')) as Out).roles.implement.codex.model, 'gpt-5.6-terra')

  const outdated = checkout({ config: TWO_FAMILIES, workers, catalog: { ...catalog, client_version: '0.156.1' }, version: '0.159.0' })
  assert.equal(codes(cli(outdated, ['init']).out).includes('codex_model_older_generation'), false)
  const absent = checkout({ config: TWO_FAMILIES, workers, catalog: null, version: '0.159.0' })
  assert.equal(codes(cli(absent, ['init']).out).includes('codex_model_older_generation'), false)
})

test('con un workers.yml existente, init agrega lo que falta y quita los perfiles inexistentes', () => {
  const workers = [
    'schema_version: 1',
    'roles:',
    '  pr:',
    '    claude: { model: opus, effort: alto }',
    '  foo:',
    '    codex: { model: gpt-6.1-sol, effort: alto }',
    '  explore:',
    '    codex: { model: gpt-9-nada, effort: alto }',
    '  implement:',
    '    claude: { model: opus, effort: maximo }',
    '',
  ].join('\n')
  const c = checkout({ config: TWO_FAMILIES, workers })
  const { dry, applied } = initAndApply(c)
  assert.deepEqual(dry.workers.removed.map((r: Out) => [r.path, r.reason]), [
    ['roles.pr', 'retired'], ['roles.foo', 'unknown'], ['roles.explore.codex', 'model_not_in_catalog'],
  ])
  assert.deepEqual(dry.workers.differs.map((d: Out) => d.path), ['roles.implement.claude'])
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  const roles = (parse(read(c, '.sdd-ai/workers.yml')) as Out).roles
  assert.equal(roles.pr, undefined)
  assert.equal(roles.foo, undefined)
  assert.deepEqual(roles.explore, DEFAULTS.explore)
  assert.deepEqual(roles.implement, { claude: { model: 'opus', effort: 'maximo' }, codex: DEFAULTS.implement.codex })
  assert.deepEqual(Object.keys(roles).sort(), Object.keys(DEFAULTS).sort())

  const unknownModel = 'schema_version: 1\nroles:\n  explore:\n    codex: { model: gpt-9-nada, effort: alto }\n'
  const noCatalog = checkout({ config: TWO_FAMILIES, workers: unknownModel, catalog: null })
  const blind = initAndApply(noCatalog)
  assert.deepEqual(blind.dry.workers.removed, [])
  assert.ok(codes(blind.dry).includes('codex_catalog_missing'))
  assert.equal((parse(read(noCatalog, '.sdd-ai/workers.yml')) as Out).roles.explore.codex.model, 'gpt-9-nada')

  // El default también se quita si su modelo no está en el catálogo, y no se vuelve a agregar.
  const defaultOut = 'schema_version: 1\nroles:\n  explore:\n    codex: { model: gpt-6-luna, effort: alto }\n'
  const oldCatalog = checkout({ config: TWO_FAMILIES, workers: defaultOut, catalog: ['gpt-6.1-sol'] })
  const dropped = initAndApply(oldCatalog)
  assert.deepEqual(dropped.dry.workers.removed.map((r: Out) => r.path), ['roles.explore.codex'])
  assert.ok(codes(dropped.dry).includes('codex_default_not_in_catalog'))
  assert.equal((parse(read(oldCatalog, '.sdd-ai/workers.yml')) as Out).roles.explore.codex, undefined)

  const broken = 'schema_version: 1\nroles:\n  explore:\n    claude: { model: opus, effort: ultra }\n'
  const invalid = checkout({ config: TWO_FAMILIES, workers: broken })
  const rejected = initAndApply(invalid)
  const file = fileOf(rejected.dry, '.sdd-ai/workers.yml')
  assert.equal(file.action, 'invalid')
  assert.equal(file.error.code, 'workers_invalid')
  assert.ok(codes(rejected.dry).includes('agents_skipped'))
  assert.equal(rejected.applied.code, 0, JSON.stringify(rejected.applied.out))
  assert.equal(read(invalid, '.sdd-ai/workers.yml'), broken)
})

test('en un worktree sin config, init siembra la del checkout principal', () => {
  const own = 'schema_version: 1\nroles:\n  explore:\n    claude:\n      model: opus\n      effort: alto\n'
  const main = checkout({ config: TWO_FAMILIES, workers: own })
  const worktree = join(realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-wt-'))), 'wt')
  execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'wt'], { cwd: main.repo })

  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-vacio-')))
  const bad = cli(main, ['init', '--from', empty], worktree)
  assert.equal(bad.code, 2)
  assert.equal(bad.out.code, 'seed_source_invalid')

  const { dry, applied } = initAndApply(main, [], worktree)
  assert.deepEqual(dry.seed, { from: main.repo })
  assert.deepEqual(dry.current.families, ['codex', 'claude'])
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.equal(readFileSync(join(worktree, '.sdd-ai', 'config.yml'), 'utf8'), TWO_FAMILIES)
  const roles = (parse(readFileSync(join(worktree, '.sdd-ai', 'workers.yml'), 'utf8')) as Out).roles
  assert.deepEqual(roles.explore, { claude: { model: 'opus', effort: 'alto' }, codex: DEFAULTS.explore.codex })
  assert.deepEqual(roles['code-review'], DEFAULTS['code-review'])

  const other = checkout({ config: TWO_FAMILIES })
  const second = join(dirname(worktree), 'wt2')
  execFileSync('git', ['worktree', 'add', '-q', second, '-b', 'wt2'], { cwd: main.repo })
  // Una ruta con una sustitución de la shell llega al comando entre comillas simples.
  const odd = join(realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-raro-'))), 'o$(touch pwned)')
  mkdirSync(join(odd, '.sdd-ai'), { recursive: true })
  writeFileSync(join(odd, '.sdd-ai', 'config.yml'), TWO_FAMILIES)
  const quoted = cli(main, ['init', '--from', odd], second)
  assert.equal(quoted.code, 0, JSON.stringify(quoted.out))
  assert.ok(quoted.out.next.includes(`--from '${odd}'`), quoted.out.next)

  const seeded = initAndApply(main, ['--from', other.repo], second)
  assert.deepEqual(seeded.dry.seed, { from: other.repo })
  assert.equal(seeded.applied.code, 0, JSON.stringify(seeded.applied.out))
  assert.deepEqual(parse(readFileSync(join(second, '.sdd-ai', 'workers.yml'), 'utf8')), { schema_version: 1, roles: DEFAULTS })
})

test('init --apply crea el gitignore, sincroniza los agentes y trae el reporte de doctor', () => {
  const c = checkout()
  const { applied } = initAndApply(c)
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.equal(read(c, '.sdd-ai/.gitignore'), '*\n')
  assert.match(read(c, '.claude/agents/sdd-ai-explore.md'), /^model: sonnet$/m)
  assert.match(read(c, '.codex/agents/sdd-ai-explore.toml'), /^model = "gpt-6-luna"$/m)
  const skill = read(c, 'skills/sdd-ai/SKILL.md')
  assert.equal(read(c, '.claude/skills/sdd-ai/SKILL.md'), skill)
  assert.equal(read(c, '.agents/skills/sdd-ai/SKILL.md'), skill)
  assert.ok(applied.out.agents.written.length > 0)
  assert.deepEqual(applied.out.doctor.clis.map((r: Out) => r.family), ['claude', 'codex'])
  assert.deepEqual(applied.out.doctor.skill.copies.map((s: Out) => s.state), ['ok', 'ok'])
  assert.match(applied.out.closing, /workers\.yml/)

  // Un agente generado para un rol que ya no existe sale en el ensayo, y la aplicación lo borra aunque
  // sea lo único que cambia.
  const leftover = join(c.repo, '.claude', 'agents', 'sdd-ai-viejo.md')
  writeFileSync(leftover, '<!-- generado por sdd-ai desde agents/worker.md · no editar a mano -->\n')
  const again = initAndApply(c)
  assert.deepEqual(again.dry.agents, [{ path: '.claude/agents/sdd-ai-viejo.md', state: 'leftover' }])
  assert.equal(again.applied.code, 0, JSON.stringify(again.applied.out))
  assert.deepEqual(again.applied.out.agents.removed, ['.claude/agents/sdd-ai-viejo.md'])
  assert.equal(existsSync(leftover), false)
})

test('init avisa de hooks, node_modules y .plans sin escribir hooks ni ignores', () => {
  const c = checkout()
  const settings = JSON.parse(read(c, '.claude/settings.json')) as Out
  delete settings.hooks.Stop
  writeFileSync(join(c.repo, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))
  const guarded = ['.claude/settings.json', '.codex/hooks.json', '.git/info/exclude']
  const before = guarded.map((rel) => read(c, rel))
  const { dry, applied } = initAndApply(c)
  for (const code of ['hooks_missing', 'codex_hooks_approval', 'node_modules_missing', 'plans_not_ignored']) {
    assert.ok(codes(dry).includes(code), code)
  }
  const hooks = dry.notes.filter((n: Out) => n.code === 'hooks_missing')
  assert.equal(hooks.length, 1)
  assert.match(hooks[0].detail, /\.claude\/settings\.json/)
  assert.match(hooks[0].detail, /Stop/)
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.deepEqual(guarded.map((rel) => read(c, rel)), before)
  assert.equal(existsSync(join(c.repo, '.gitignore')), false)

  // Un archivo de hooks que no se puede leer es un aviso más, no un error.
  const unreadable = checkout()
  chmodSync(join(unreadable.repo, '.codex', 'hooks.json'), 0o000)
  const r = cli(unreadable, ['init'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.ok(r.out.notes.some((n: Out) => n.code === 'hooks_missing' && n.detail.includes('.codex/hooks.json')))
})

test('una segunda corrida de init no cambia nada', () => {
  const c = checkout({ config: TWO_FAMILIES })
  assert.equal(initAndApply(c).applied.code, 0)
  const before = stamps(c.repo)
  const { dry, applied } = initAndApply(c)
  assert.deepEqual(dry.files.map((f: Out) => f.action), ['unchanged', 'unchanged', 'unchanged'])
  assert.deepEqual(dry.agents, [])
  assert.equal(applied.code, 0, JSON.stringify(applied.out))
  assert.deepEqual(applied.out.written, [])
  assert.equal(applied.out.agents, null)
  assert.deepEqual(stamps(c.repo), before)

  // Un catálogo que no trae un modelo por defecto no hace que ese perfil se quite y se agregue en cada
  // corrida.
  const partial = checkout({ catalog: ['gpt-6.1-sol'] })
  assert.equal(initAndApply(partial).applied.code, 0)
  const second = cli(partial, ['init']).out
  assert.deepEqual(second.files.map((f: Out) => f.action), ['unchanged', 'unchanged', 'unchanged'])
  assert.deepEqual(second.workers.removed, [])
  assert.ok(codes(second).includes('codex_default_not_in_catalog'))
  assert.equal((parse(read(partial, '.sdd-ai/workers.yml')) as Out).roles.explore.codex, undefined)
})

test('el uso del binario lista init', () => {
  const c = checkout({ sources: false })
  const r = cli(c, ['nada'])
  assert.equal(r.code, 2)
  assert.match(r.out.next, /\binit\b/)
})
