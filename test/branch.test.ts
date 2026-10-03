import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createBranch } from '../src/git.ts'
import { branchApply } from '../src/sdd/branch.ts'
import { readHeader } from '../src/sdd/markdown.ts'
import { readFlow } from '../src/sdd/read.ts'
import { acquireReservation, ownReservation, releaseReservation, storeRoot } from '../src/writer-store.ts'
import { SddError } from '../src/types.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const scratch: string[] = []
after(() => { for (const path of scratch) rmSync(path, { recursive: true, force: true }) })
interface Setup { root: string; repo: string; env: Record<string, string>; id: string; base: string }
const AT = '2026-10-02T12:00:00.000Z'
const reserveWriter = (root: string, id: string) => acquireReservation(root, id, 'writer')
const releaseWriter = (root: string, id: string) => {
  const h = ownReservation(root, 'writer', id)
  if (h) releaseReservation(h)
}
function put(path: string, body: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body) }
function git(s: Setup, ...args: string[]): string {
  return execFileSync('git', args, { cwd: s.repo, encoding: 'utf8', env: { ...process.env, ...s.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } }).trim()
}
function config(s: Setup, extra = ''): void {
  put(join(s.repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: [codex]\n  selection: full\n${extra}`)
}
function setup(o: { id?: string; approved?: boolean; depth?: string; slug?: string; changeType?: string } = {}): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-branch-')))
  scratch.push(root)
  for (const dir of ['repo', 'bin', 'home']) mkdirSync(join(root, dir))
  symlinkSync(process.execPath, join(root, 'bin', 'node'))
  const s: Setup = { root, repo: join(root, 'repo'), env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: join(root, 'home') }, id: o.id ?? 'mi-flujo', base: '' }
  git(s, 'init', '-q', '-b', 'main')
  put(join(s.repo, 'base.txt'), 'base\n')
  git(s, 'add', 'base.txt')
  git(s, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial')
  s.base = git(s, 'rev-parse', 'HEAD')
  config(s)
  if (o.depth !== 'corta') put(join(s.repo, '.plans', s.id, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** exporta. (pedido)\n')
  put(handoff(s), `---\nphase: specify\nprofundidad: ${o.depth ?? 'normal'}\nrisk: low\nchange_type: ${o.changeType ?? 'feat'}\nslug: ${o.slug ?? s.id}\nbase_branch: main\nspec_approved_at: ${o.approved === false ? 'null' : AT}\noverrides: {jira_approval: null}\nworktree_location: ${s.repo}\norigin_sha: ${s.base}\n# x\ncustom: keep\n---\n\n# Flujo ${s.id}\n\nCuerpo original.\n`)
  return s
}
const handoff = (s: Setup) => join(s.repo, '.plans', s.id, 'handoff.md')
const raw = (s: Setup) => readFileSync(handoff(s), 'utf8')
function header(s: Setup): Record<string, unknown> { const h = readHeader(raw(s)); assert.ok(h.ok); return h.data }
function edit(s: Setup, from: string, to: string): void { put(handoff(s), raw(s).replace(from, to)) }
function approval(s: Setup, at = AT): void {
  const fingerprint = readFlow(s.repo, s.id).facts.fingerprints.spec
  put(join(s.repo, '.plans', s.id, 'sdd-ai-approvals.json'), JSON.stringify({ schema_version: 1, approvals: [{ gate: 'spec', depth: 'normal', fingerprint, previous: {}, at }] }))
}
function cli(s: Setup, ...flags: string[]) {
  const r = spawnSync(BIN, ['sdd', 'branch', s.id, ...flags], { cwd: s.repo, env: s.env, encoding: 'utf8' })
  assert.equal(r.error, undefined)
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}
function tree(path: string): unknown {
  if (!existsSync(path)) return null
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [entry.name,
    entry.isDirectory() ? tree(join(path, entry.name)) : readFileSync(join(path, entry.name)).toString('base64')])
}
const photo = (s: Setup) => ({ plans: tree(join(s.repo, '.plans')), refs: git(s, 'for-each-ref', '--format=%(refname) %(objectname)'), head: git(s, 'rev-parse', 'HEAD') })
const exitCodes = (out: ReturnType<typeof cli>['out'], exit = 'new'): string[] => out.exits.find((e: { exit: string }) => e.exit === exit).blockers.map((b: { code: string }) => b.code)
function denied(s: Setup, code: string, flags: string[] = ['--apply']): void {
  const before = photo(s)
  const r = cli(s, ...flags)
  assert.notEqual(r.code, 0, r.stderr)
  assert.equal(r.out.code, code)
  assert.deepEqual(photo(s), before)
}

test('el ensayo de sdd branch no escribe nada ni crea refs e informa el nombre, HEAD, la base, las salidas, la recomendada, ask, los bloqueos y el next', () => {
  const s = setup()
  const before = photo(s)
  const r = cli(s)
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(photo(s), before)
  assert.deepEqual(r.out.name, { name: 'feature/mi-flujo', format: '{type}/{ticket}-{slug}', type: 'feature', type_source: 'change_type', ticket: null, slug: 'mi-flujo', slug_source: 'handoff' })
  assert.deepEqual(r.out.head, { branch: 'main', commit: s.base })
  assert.deepEqual(r.out.base, { branch: 'main', origin_sha: s.base, tip: s.base, advanced: false })
  assert.deepEqual(r.out.exits.map((e: { exit: string }) => e.exit), ['new', 'current'])
  assert.equal(r.out.recommended, 'new')
  assert.deepEqual(r.out.ask, [])
  assert.deepEqual(r.out.blockers, [])
  assert.equal(r.out.next, './bin/sdd-ai sdd branch mi-flujo --apply')
})

test('sdd branch bloquea la spec sin aprobar, plan.md presente, HEAD separado, el árbol sucio, una fase o un writer del flujo en vuelo y el flujo tomado, y --apply se niega sin escribir', () => {
  const cases: Array<[string, (s: Setup) => void]> = [
    ['spec_not_approved', (s) => edit(s, `spec_approved_at: ${AT}`, 'spec_approved_at: null')],
    ['spec_not_approved', (s) => {
      approval(s)
      const spec = join(s.repo, '.plans', s.id, 'spec.md')
      put(spec, `${readFileSync(spec, 'utf8')}\nCambio posterior.\n`)
    }],
    ['plan_exists', (s) => put(join(s.repo, '.plans', s.id, 'plan.md'), '---\nprofundidad: normal\nstatus: planned\n---\n\n# Plan\n')],
    ['head_unknown', (s) => { git(s, 'switch', '--detach') }],
    ['tree_dirty', (s) => put(join(s.repo, 'dirty.txt'), 'dirty')],
    ['phase_running', (s) => {
      put(join(s.repo, '.plans', s.id, 'sdd-ai-phases.json'), JSON.stringify({ schema_version: 1, last_run: { id: '20261002-1200-aaaa', step: 'plan' }, phases: {} }))
      put(join(s.repo, '.sdd-ai', 'runs', '20261002-1200-aaaa', 'status.json'), JSON.stringify({ state: 'running' }))
    }],
    ['writer_open', (s) => put(join(s.repo, '.git', 'sdd-ai', 'runs', '20261002-1200-bbbb', 'control.json'), JSON.stringify({ id: '20261002-1200-bbbb', phase: { flow: s.id } }))],
    ['flow_busy', (s) => put(join(s.repo, '.plans', s.id, 'sdd-ai-approvals.lock'), JSON.stringify({ pid: 999999, lstart: null }))],
  ]
  for (const [code, mutate] of cases) {
    const s = setup()
    mutate(s)
    const blocked = cli(s).out
    assert.ok(blocked.blockers.some((b: { code: string }) => b.code === code), code)
    assert.equal(blocked.recommended, null, code)
    denied(s, code)
    if (code === 'tree_dirty' || code === 'phase_running') {
      git(s, 'switch', '-c', 'otra')
      denied(s, code, ['--apply', '--current'])
      git(s, 'switch', 'main')
      edit(s, 'phase: specify', `branch: feature/${s.id}\nbase_commit: ${s.base}\nphase: specify`)
      denied(s, code)
    }
  }
  const clean = setup()
  put(join(clean.repo, '.plans', 'extra.txt'), 'allowed')
  put(join(clean.repo, '.sdd-ai', 'extra.txt'), 'allowed')
  assert.deepEqual(cli(clean).out.blockers, [])
  git(clean, 'mv', 'base.txt', '.plans/x')
  const blocker = cli(clean).out.blockers.find((b: { code: string }) => b.code === 'tree_dirty')
  assert.match(blocker.detail, /base\.txt/)
  denied(clean, 'tree_dirty')
})

test('el nombre de la rama sale de branch_format con el prefijo de --prefix, de branch_prefix o del change_type, omite lo que falta con su separador y rechaza un formato o un nombre inválidos', () => {
  const s = setup()
  assert.equal(cli(s).out.name.name, 'feature/mi-flujo')
  config(s, 'branch_prefix: fix/\n')
  assert.equal(cli(s).out.name.name, 'fix/mi-flujo')
  assert.equal(cli(s, '--prefix', 'chore').out.name.type_source, 'flag')
  assert.equal(cli(s, '--prefix', 'chore').out.name.name, 'chore/mi-flujo')
  config(s, "branch_format: '{slug}_{type}'\n")
  assert.equal(cli(s).out.name.name, 'mi-flujo_feature')
  const ticket = setup({ id: 'ABC-123', slug: 'export-csv', changeType: 'fix' })
  assert.equal(cli(ticket).out.name.name, 'fix/ABC-123-export-csv')
  edit(ticket, 'slug: export-csv', 'slug: ABC-123')
  assert.equal(cli(ticket).out.name.name, 'fix/ABC-123')
  edit(ticket, 'slug: ABC-123', 'slug: Exportación CSV')
  assert.equal(cli(ticket).out.name.name, 'fix/ABC-123-exportacion-csv')
  assert.equal(cli(ticket).out.name.slug_source, 'handoff')
  edit(ticket, 'slug: Exportación CSV\n', '')
  assert.deepEqual([cli(ticket).out.name.name, cli(ticket).out.name.slug_source], ['fix/ABC-123', null])
  const unslugged = setup()
  edit(unslugged, 'slug: mi-flujo\n', '')
  assert.deepEqual([cli(unslugged).out.name.name, cli(unslugged).out.name.slug_source], ['feature/mi-flujo', 'id'])
  config(s, "branch_format: '{type}/{nope}'\n")
  assert.ok(cli(s).out.blockers.some((b: { code: string }) => b.code === 'config_invalid'))
  denied(s, 'config_invalid')
  for (const extra of ['branch_format: 3\n', "branch_format: ''\n", 'branch_prefix: 3\n']) {
    config(s, extra)
    denied(s, 'config_invalid')
  }
  config(s, 'branch_format: [\n')
  assert.deepEqual(cli(s).out.blockers.map((b: { code: string }) => b.code).filter((c: string) => ['flow_blocked', 'config_invalid'].includes(c)), ['flow_blocked', 'config_invalid'])
  denied(s, 'flow_blocked')
  config(s, 'branch_prefix: a..b\n')
  assert.ok(exitCodes(cli(s).out).includes('branch_name_invalid'))
  denied(s, 'branch_name_invalid')
  config(s, 'default_branch: 3\n')
  assert.deepEqual(cli(s).out.blockers, [])
  assert.equal(cli(s).out.name.name, 'feature/mi-flujo')
})

test('el ensayo recomienda la rama actual si ya tiene el nombre, una nueva desde la base y, desde otra rama, según el id, con los bloqueos de cada salida', () => {
  const s = setup()
  assert.equal(cli(s).out.recommended, 'new')
  git(s, 'switch', '-c', 'feature/mi-flujo')
  assert.equal(cli(s).out.recommended, 'current')
  assert.deepEqual(cli(s).out.ask, [])
  git(s, 'switch', 'main')
  assert.equal(cli(s).out.recommended, null)
  assert.ok(!cli(s).out.next.includes('--apply'))
  git(s, 'branch', '-D', 'feature/mi-flujo')
  git(s, 'switch', '-c', 'trabajo-mi-flujo')
  assert.equal(cli(s).out.recommended, 'new')
  assert.deepEqual(cli(s).out.ask, ['exit'])
  git(s, 'switch', '-c', 'otra')
  assert.equal(cli(s).out.recommended, 'current')
  assert.deepEqual(cli(s).out.ask, ['exit'])
  git(s, 'branch', 'feature/mi-flujo')
  assert.ok(exitCodes(cli(s).out).includes('branch_exists'))
  assert.equal(cli(s).out.recommended, 'current')
  git(s, 'branch', '-D', 'feature/mi-flujo')
  edit(s, `origin_sha: ${s.base}`, `origin_sha: ${'f'.repeat(40)}`)
  assert.ok(exitCodes(cli(s).out).includes('base_branch_unknown'))
  assert.equal(cli(s).out.recommended, 'current')
  edit(s, `origin_sha: ${'f'.repeat(40)}`, `origin_sha: ${s.base}`)
  git(s, 'switch', 'main')
  git(s, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Advanced')
  git(s, 'switch', 'otra')
  assert.deepEqual(cli(s).out.ask, ['exit', 'base_advanced'])
  put(join(s.repo, 'dirty.txt'), 'dirty')
  assert.deepEqual([cli(s).out.recommended, cli(s).out.ask], [null, []])
  rmSync(join(s.repo, 'dirty.txt'))
  git(s, 'branch', '-D', 'main')
  assert.equal(cli(s).out.base.tip, null)
  assert.equal(cli(s).out.base.advanced, false)
  assert.deepEqual(cli(s).out.ask, ['exit'])
  const nested = setup()
  git(nested, 'branch', 'feature')
  const conflict = cli(nested).out
  assert.ok(exitCodes(conflict).includes('branch_exists'))
  assert.match(conflict.exits[0].blockers.find((b: { code: string }) => b.code === 'branch_exists').detail, /feature/)
  assert.equal(conflict.recommended, null)
  denied(nested, 'branch_exists')
})

test('sdd branch --apply corta la rama nueva desde origin_sha, avisa si la base avanzó y con --refreeze corta desde la punta y actualiza origin_sha', () => {
  for (const refreeze of [false, true]) {
    const s = setup()
    git(s, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Advanced')
    const tip = git(s, 'rev-parse', 'HEAD')
    assert.equal(cli(s).out.base.advanced, true)
    assert.deepEqual(cli(s).out.ask, ['base_advanced'])
    const r = cli(s, '--apply', ...(refreeze ? ['--refreeze'] : []))
    assert.equal(r.code, 0, JSON.stringify(r.out))
    assert.equal(git(s, 'symbolic-ref', '--short', 'HEAD'), 'feature/mi-flujo')
    assert.equal(git(s, 'rev-parse', 'HEAD'), refreeze ? tip : s.base)
    assert.deepEqual(r.out.base, { branch: 'main', origin_sha: s.base, tip, advanced: true })
    assert.equal(header(s).origin_sha, refreeze ? tip : s.base)
    if (refreeze) assert.deepEqual(r.out.origin_sha, { before: s.base, after: tip })
  }
  const s = setup()
  denied(s, 'usage', ['--apply', '--current', '--refreeze'])
  denied(s, 'usage', ['--apply', '--current', '--prefix', 'x'])
  denied(s, 'usage', ['--current'])
  denied(s, 'usage', ['--refreeze'])
})

test('sdd branch --apply --current registra la rama actual sin mover HEAD ni crear refs y se niega sobre la base', () => {
  const s = setup()
  denied(s, 'branch_is_base', ['--apply', '--current'])
  git(s, 'switch', '-c', 'otra')
  const before = git(s, 'for-each-ref', '--format=%(refname) %(objectname)')
  const r = cli(s, '--apply', '--current')
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(git(s, 'symbolic-ref', '--short', 'HEAD'), 'otra')
  assert.equal(git(s, 'rev-parse', 'HEAD'), s.base)
  assert.equal(git(s, 'for-each-ref', '--format=%(refname) %(objectname)'), before)
  assert.equal(header(s).branch, 'otra')
  assert.equal(header(s).base_commit, s.base)
  assert.equal(r.out.created, false)
  assert.equal(r.out.switched, false)
})

test('sdd branch --apply deja en el handoff la rama, el prefijo, el commit base, la aprobación de la spec y phase plan sin tocar el resto', () => {
  const s = setup()
  approval(s)
  edit(s, `spec_approved_at: ${AT}`, 'spec_approved_at: null')
  const before = header(s)
  assert.equal(cli(s, '--apply').code, 0)
  const after = header(s)
  assert.equal(after.branch, 'feature/mi-flujo')
  assert.equal(after.worktree_branch, after.branch)
  assert.equal(after.branch_prefix, 'feature')
  assert.equal(after.base_commit, s.base)
  assert.equal(after.spec_approved_at, AT)
  assert.equal(after.phase, 'plan')
  for (const key of Object.keys(before).filter((k) => !['phase', 'spec_approved_at'].includes(k))) assert.deepEqual(after[key], before[key])
  assert.match(raw(s), /# x/)
  assert.match(raw(s), /# Flujo mi-flujo\n\nCuerpo original\.\n\n## Rama/)
  const short = setup({ depth: 'corta', approved: false })
  assert.equal(cli(short, '--apply').code, 0)
  assert.equal(header(short).spec_approved_at, null)
  const headerOnly = setup()
  assert.equal(cli(headerOnly, '--apply').code, 0)
  assert.equal(header(headerOnly).spec_approved_at, AT)
  const legacy = setup()
  edit(legacy, `origin_sha: ${legacy.base}\n`, '')
  assert.equal(cli(legacy, '--apply').code, 0)
  assert.equal(header(legacy).origin_sha, legacy.base)
})

test('sdd branch --apply se puede repetir: no cambia nada, completa el handoff, crea la rama que falta o vuelve a ella, y una rama ajena con ese nombre es branch_exists', () => {
  const s = setup()
  approval(s)
  assert.equal(cli(s, '--apply').code, 0)
  const before = raw(s)
  for (const flags of [[], ['--current'], ['--refreeze'], ['--prefix', 'feature']]) {
    const r = cli(s, '--apply', ...flags)
    assert.equal(r.code, 0, JSON.stringify(r.out))
    assert.deepEqual([r.out.created, r.out.switched, r.out.handoff_written], [false, false, false])
    assert.equal(raw(s), before)
  }
  edit(s, `spec_approved_at: ${AT}`, 'spec_approved_at: 2026-10-01T00:00:00.000Z')
  const completed = cli(s, '--apply')
  assert.deepEqual([completed.out.created, completed.out.switched, completed.out.handoff_written], [false, false, true])
  assert.equal(header(s).spec_approved_at, AT)
  assert.equal((raw(s).match(/^## Rama$/gm) ?? []).length, 1)
  denied(s, 'branch_recorded', ['--apply', '--prefix', 'chore'])
  git(s, 'switch', 'main')
  denied(s, 'branch_recorded', ['--apply', '--current'])
  const switched = cli(s, '--apply')
  assert.deepEqual([switched.out.created, switched.out.switched], [false, true])
  git(s, 'switch', 'main')
  git(s, 'branch', '-D', 'feature/mi-flujo')
  const recreated = cli(s, '--apply')
  assert.deepEqual([recreated.out.created, recreated.out.switched], [true, true])
  assert.equal(git(s, 'rev-parse', 'HEAD'), s.base)
  edit(s, `base_commit: ${s.base}\n`, '')
  assert.ok(cli(s).out.blockers.some((b: { code: string }) => b.code === 'handoff_invalid'))
  denied(s, 'handoff_invalid')
  const collision = setup()
  git(collision, 'branch', 'feature/mi-flujo')
  denied(collision, 'branch_exists')
  const stuck = setup()
  edit(stuck, 'phase: specify', `branch: feature/mi-flujo\nbase_commit: ${stuck.base}\nphase: specify`)
  git(stuck, 'branch', 'feature')
  assert.equal(cli(stuck).out.retake, 'create')
  assert.ok(cli(stuck).out.blockers.some((b: { code: string }) => b.code === 'branch_exists'))
  denied(stuck, 'branch_exists')
  const rechosen = cli(stuck, '--apply', '--prefix', 'fix')
  assert.equal(rechosen.code, 0, JSON.stringify(rechosen.out))
  assert.equal(header(stuck).branch, 'fix/mi-flujo')
  assert.equal(git(stuck, 'symbolic-ref', '--short', 'HEAD'), 'fix/mi-flujo')
})

test('la reserva local excluye crear ramas y la de otro checkout permite aplicar branch', () => {
  const s = setup()
  const worktree = join(s.root, 'linked')
  git(s, 'worktree', 'add', '-b', 'otra', worktree)
  const linked = { ...s, repo: worktree }
  config(linked)
  put(handoff(linked), raw(s))
  put(join(linked.repo, '.plans', s.id, 'spec.md'), readFileSync(join(s.repo, '.plans', s.id, 'spec.md'), 'utf8'))
  assert.equal(reserveWriter(linked.repo, 'other').ok, true)
  try {
    assert.ok(exitCodes(cli(linked).out).includes('writer_open'))
    denied(linked, 'writer_open')
    assert.equal(cli(linked, '--apply', '--current').code, 0)
  } finally { releaseWriter(linked.repo, 'other') }
  assert.equal(reserveWriter(s.repo, 'other').ok, true)
  try {
    assert.equal(cli(linked, '--apply').code, 0)
    git(linked, 'switch', '-c', 'tercera')
    const resumed = cli(linked, '--apply')
    assert.equal(resumed.code, 0, JSON.stringify(resumed.out))
    assert.equal(resumed.out.switched, true)
    assert.equal(resumed.out.created, false)
  } finally { releaseWriter(s.repo, 'other') }
  const broken = setup()
  put(join(storeRoot(broken.repo), 'writer.lock'), 'invalid JSON')
  assert.ok(exitCodes(cli(broken).out).includes('writer_open'))
  denied(broken, 'writer_open')
})

test('la rama se crea con la reserva de writer tomada y la reserva se libera al terminar', () => {
  for (const fail of [false, true]) {
    const s = setup()
    const linked = join(s.root, 'linked')
    git(s, 'worktree', 'add', '-b', 'otra', linked)
    const io = { createBranch(root: string, name: string, start: string) {
      assert.equal(ownReservation(root)?.kind, 'branch')
      const other = reserveWriter(linked, 'x')
      assert.equal(other.ok, true)
      releaseWriter(linked, 'x')
      if (fail) throw new Error('Git failure')
      createBranch(root, name, start)
    }, switchBranch() { assert.fail('unexpected switch') } }
    if (fail) {
      assert.throws(() => branchApply(s.repo, s.id, {}, io), (e: unknown) => e instanceof SddError && e.code === 'branch_create_failed' && e.next === './bin/sdd-ai sdd branch mi-flujo --apply')
      assert.equal(header(s).branch, 'feature/mi-flujo')
      assert.equal(header(s).base_commit, s.base)
      assert.equal(git(s, 'branch', '--list', 'feature/mi-flujo'), '')
    } else assert.equal(branchApply(s.repo, s.id, {}, io).created, true)
    assert.equal(ownReservation(s.repo), undefined)
    if (fail) {
      assert.equal(branchApply(s.repo, s.id, {}).created, true)
      assert.equal(git(s, 'rev-parse', 'HEAD'), s.base)
    }
  }
})
