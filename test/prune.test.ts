import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { type Candidate, type EntryKind, type Kept, planPrune, pruneContext, pruneUnit } from '../src/prune.ts'
import { makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const scratch: string[] = []
after(() => { for (const path of scratch.reverse()) rmSync(path, { recursive: true, force: true }) })

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

function repo(): string {
  const root = makeRepo('sdd-ai-prune-')
  scratch.push(root)
  git(root, 'commit', '--allow-empty', '-qm', 'base')
  return root
}

function outside(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-prune-out-')))
  scratch.push(path)
  return path
}

function worktree(root: string): string {
  const path = join(outside(), 'checkout')
  git(root, 'worktree', 'add', '--detach', path, 'HEAD')
  return path
}

function put(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
  return path
}

function age(path: string, days = 10): void {
  const time = new Date(Date.now() - days * 86_400_000)
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), days)
  utimesSync(path, time, time)
}

function run(root: string, id: string, o: { state?: string; session?: string | null; delivered?: boolean; review?: boolean; pending?: boolean; native?: boolean; writer?: boolean; harvest?: boolean } = {}): string {
  const dir = join(root, '.sdd-ai', 'runs', id)
  const session = o.session === null ? undefined : o.session ?? 's1'
  put(join(dir, 'request.json'), { session, kind: o.review ? 'review' : 'worker' })
  put(join(dir, 'status.json'), { state: o.state ?? 'done' })
  if (o.delivered !== false) put(join(dir, 'delivered.json'), { round: null, launch: null })
  if (o.review) put(join(dir, 'ledger.json'), { completed: 1, entries: o.pending ? [{ id: 'finding-1', state: 'abierto' }] : [] })
  if (o.native) put(join(dir, 'native.json'), { agent: 'sdd-ai-explore', family: 'claude', role: 'explore' })
  if (o.writer) {
    const store = join(gitDirs(root).gitDir, 'sdd-ai', 'runs', id)
    put(join(store, 'control.json'), { session })
    if (o.harvest !== false) put(join(store, 'harvest.json'), { state: o.state ?? 'done' })
    put(join(store, 'delivered.json'), { round: null, launch: null })
    age(store)
  }
  age(dir)
  return dir
}

function flow(root: string, id: string, text: string, file = 'plan.md'): string {
  return put(join(root, '.plans', id, file), text)
}

interface Output {
  state: string; code?: string; message?: string; next: string; digest: string; keep_days: number; bytes: number; freed_bytes: number; detail: string
  candidates: Partial<Record<EntryKind, Array<{ id: string; path: string; bytes: number }>>>
  kept: Kept[]; kept_on_recheck: Array<{ kind: string; id: string; reason: string }>
  deleted: Array<{ kind: string; id: string; bytes: number }>
}

function prune(root: string, ...args: string[]): { code: number | null; out: Output } {
  const r = spawnSync(process.execPath, [BIN, 'prune', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, SDD_AI_PROJECTION: 'off' },
  })
  assert.ifError(r.error)
  assert.notEqual(r.stdout.trim(), '', r.stderr)
  return { code: r.status, out: JSON.parse(r.stdout) as Output }
}

const candidateIds = (out: Output, kind: EntryKind) => (out.candidates[kind] ?? []).map((e) => e.id)
const keptReason = (out: Output, id: string) => out.kept.find((k) => k.id === id)?.reason

test('el ensayo de prune no borra nada y muestra candidatos por tipo, lo conservado con su motivo, el digest y el comando', () => {
  const root = repo()
  run(root, 'old', { writer: true })
  const gitHome = join(gitDirs(root).gitDir, 'sdd-ai')
  const receipt = dirname(put(join(gitHome, 'verify', 'receipt-old', 'receipt.json'), {}))
  const attestation = put(join(gitHome, 'verify', 'attestations', 'att-old.json'), {})
  const takeover = put(join(gitHome, 'takeovers', 't-old.json'), {})
  const hooks = put(join(root, '.sdd-ai', 'hooks', 'old-session.json'), {})
  const tmp = put(join(root, '.sdd-ai', 'tmp', 'old-file'), 'temporal')
  for (const path of [receipt, attestation, takeover, hooks, tmp]) age(path)
  const recent = run(root, 'recent')
  utimesSync(recent, new Date(), new Date())
  run(root, 'open', { state: 'running' })
  run(root, 'cited')
  flow(root, 'f', 'corrida cited')
  const { code, out } = prune(root)
  assert.equal(code, 0)
  assert.equal(out.state, 'dry_run')
  assert.equal(out.keep_days, 7)
  for (const [kind, id] of [['run', 'old'], ['writer_store', 'old'], ['receipt', 'receipt-old'], ['attestation', 'att-old'], ['takeover', 't-old'], ['hook_session', 'old-session'], ['tmp', 'old-file']] as const) {
    assert.deepEqual(candidateIds(out, kind), [id])
    for (const e of out.candidates[kind]!) {
      assert.ok(e.bytes > 0)
      assert.equal(existsSync(join(root, e.path)), true)
    }
  }
  assert.equal(out.bytes, Object.values(out.candidates).flat().reduce((sum, e) => sum + e.bytes, 0))
  assert.equal(keptReason(out, 'recent'), 'recent')
  assert.equal(keptReason(out, 'open'), 'open')
  assert.match(out.kept.find((k) => k.id === 'open')!.next!, /wait open/)
  assert.equal(keptReason(out, 'cited'), 'cited')
  assert.deepEqual(out.kept.find((k) => k.id === 'cited')!.flows, ['f'])
  assert.match(out.digest, /^[0-9a-f]{64}$/)
  assert.ok(out.next.includes(`./bin/sdd-ai prune --apply --digest ${out.digest}`))
  assert.equal(prune(root).out.digest, out.digest)
})

test('prune --apply borra lo que mostró el ensayo y se niega sin digest o con uno que no coincide', () => {
  const root = repo()
  const old = run(root, 'old', { writer: true })
  const recent = run(root, 'recent')
  utimesSync(recent, new Date(), new Date())
  const draft = prune(root).out
  const missing = prune(root, '--apply')
  assert.equal(missing.code, 2)
  assert.equal(missing.out.code, 'usage')
  assert.equal(existsSync(old), true)
  assert.equal(prune(root, '--digest', draft.digest).out.code, 'usage')
  const mismatch = prune(root, '--apply', '--digest', 'wrong')
  assert.equal(mismatch.code, 2)
  assert.equal(mismatch.out.code, 'digest_mismatch')
  assert.equal(existsSync(old), true)
  // Una corrida nueva y reciente no altera los candidatos del ensayo.
  const fresh = run(root, 'fresh')
  utimesSync(fresh, new Date(), new Date())
  const applied = prune(root, '--apply', '--digest', draft.digest)
  assert.equal(applied.code, 0)
  assert.equal(applied.out.state, 'applied')
  assert.deepEqual(applied.out.deleted.map((d) => d.id), ['old'])
  assert.equal(applied.out.freed_bytes, draft.bytes)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(join(gitDirs(root).gitDir, 'sdd-ai', 'runs', 'old')), false)
  assert.equal(existsSync(recent), true)
  assert.equal(existsSync(fresh), true)
  const another = run(root, 'another')
  const stale = prune(root, '--apply', '--digest', draft.digest)
  assert.equal(stale.out.code, 'digest_mismatch')
  assert.equal(existsSync(another), true)
  const empty = repo()
  assert.equal(prune(empty).out.next, 'no hay nada que borrar')
})

test('prune --apply conserva como ocupada una revisión cuyo lock tiene otro proceso vivo', () => {
  const root = repo()
  const dir = run(root, 'review', { review: true })
  put(join(dir, 'review.lock'), { pid: process.pid, lstart: null })
  age(dir)
  const out = prune(root).out
  assert.deepEqual(candidateIds(out, 'run'), ['review'])
  const applied = prune(root, '--apply', '--digest', out.digest)
  assert.equal(applied.code, 0)
  assert.deepEqual(applied.out.kept_on_recheck, [{ kind: 'run', id: 'review', reason: 'busy' }])
  assert.equal(existsSync(dir), true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'review.lock'), 'utf8')).pid, process.pid)
  // El intento ocupado no cuenta como actividad: el ensayo siguiente la sigue mostrando como candidata.
  assert.deepEqual(candidateIds(prune(root).out, 'run'), ['review'])
  rmSync(join(dir, 'review.lock'))
  age(dir)
  // El lock propio no cambia la huella ni cuenta como actividad durante la recomprobación.
  const unlocked = prune(root).out
  const done = prune(root, '--apply', '--digest', unlocked.digest)
  assert.equal(done.code, 0)
  assert.equal(existsSync(dir), false)
  const orphan = run(root, 'orphan', { review: true })
  put(join(orphan, 'review.lock'), 'lock anterior')
  age(orphan)
  const orphanPlan = prune(root).out
  assert.equal(prune(root, '--apply', '--digest', orphanPlan.digest).out.kept_on_recheck[0].reason, 'busy')
})

test('una unidad que cambió, se abrió o pasó a estar citada después del plan no se borra', () => {
  const root = repo()
  const changed = run(root, 'changed')
  const opened = run(root, 'opened')
  const cited = run(root, 'cited')
  const later = run(root, 'later')
  const hook = put(join(root, '.sdd-ai', 'hooks', 's1.json'), {})
  age(hook)
  flow(root, 'f', 'sin citas', 'handoff.md')
  const ctx = pruneContext(root, 7)
  const plan = planPrune(ctx)
  const candidate = (id: string): Candidate => {
    const c = plan.candidates.find((c) => c.id === id)
    assert.ok(c, id)
    return c
  }
  put(join(changed, 'new.txt'), 'nuevo')
  assert.deepEqual(pruneUnit(ctx, candidate('changed')), { deleted: false, reason: 'changed' })
  put(join(opened, 'status.json'), { state: 'running' })
  assert.deepEqual(pruneUnit(ctx, candidate('opened')), { deleted: false, reason: 'open' })
  flow(root, 'f', 'cited', 'handoff.md')
  assert.deepEqual(pruneUnit(ctx, candidate('cited')), { deleted: false, reason: 'cited' })
  put(join(root, '.sdd-ai', 'hooks', 'route', 's1.json'), {})
  assert.deepEqual(pruneUnit(ctx, candidate('s1')), { deleted: false, reason: 'changed' })
  const other = worktree(root)
  flow(other, 'other-flow', 'later')
  assert.deepEqual(pruneUnit(ctx, candidate('later')), { deleted: false, reason: 'cited' })
  for (const path of [changed, opened, cited, later, hook]) assert.equal(existsSync(path), true)
})

test('si un borrado falla, prune --apply se detiene e informa lo borrado y lo que falló', () => {
  const root = repo()
  const first = run(root, 'a-first')
  const second = run(root, 'b-writer', { writer: true })
  const store = join(gitDirs(root).gitDir, 'sdd-ai', 'runs', 'b-writer')
  const blocked = dirname(put(join(store, 'blocked', 'file'), 'no se puede borrar'))
  age(store)
  chmodSync(blocked, 0o555)
  try {
    const draft = prune(root).out
    const applied = prune(root, '--apply', '--digest', draft.digest)
    assert.equal(applied.code, 2)
    assert.equal(applied.out.code, 'prune_failed')
    const detail = JSON.parse(applied.out.detail)
    assert.deepEqual(detail.deleted.map((d: { id: string }) => d.id), ['a-first'])
    assert.equal(detail.failed.id, 'b-writer')
    assert.equal(detail.failed.path, relative(root, store))
    assert.deepEqual(detail.failed.removed, [relative(root, second)])
    assert.equal(existsSync(first), false)
    assert.equal(existsSync(second), false)
    assert.equal(existsSync(join(blocked, 'file')), true)
  } finally {
    chmodSync(blocked, 0o755)
  }
  const lockRoot = repo()
  const before = run(lockRoot, 'a-first')
  const review = run(lockRoot, 'b-review', { review: true })
  chmodSync(review, 0o555)
  try {
    const draft = prune(lockRoot).out
    const applied = prune(lockRoot, '--apply', '--digest', draft.digest)
    assert.equal(applied.code, 2)
    assert.equal(applied.out.code, 'prune_failed')
    const detail = JSON.parse(applied.out.detail)
    assert.deepEqual(detail.deleted.map((d: { id: string }) => d.id), ['a-first'])
    assert.equal(detail.failed.path, relative(lockRoot, review))
    assert.deepEqual(detail.failed.removed, [])
    assert.equal(existsSync(before), false)
    assert.equal(existsSync(review), true)
  } finally {
    chmodSync(review, 0o755)
  }
})

test('la ventana cuenta la última modificación de la unidad, directorios incluidos, y --keep-days la cambia', () => {
  const root = repo()
  const dir = run(root, 'old-with-new-dir')
  mkdirSync(join(dir, 'empty'))
  age(dir)
  age(join(dir, 'empty'), 1)
  const empty = join(root, '.sdd-ai', 'tmp', 'empty')
  mkdirSync(empty, { recursive: true })
  age(empty)
  const out = prune(root).out
  assert.equal(keptReason(out, 'old-with-new-dir'), 'recent')
  assert.deepEqual(candidateIds(out, 'tmp'), ['empty'])
  assert.equal(out.candidates.tmp![0].bytes, 0)
  const longer = prune(root, '--keep-days', '30').out
  assert.equal(keptReason(longer, 'empty'), 'recent')
  assert.equal(longer.keep_days, 30)
  for (const value of ['0', 'x', '-1', '1.5']) assert.equal(prune(root, '--keep-days', value).out.code, 'usage')
  const custom = prune(root, '--keep-days', '2').out
  assert.match(custom.next, /prune --keep-days 2 --apply --digest/)
})

test('una corrida en vuelo se conserva tenga o no sesión, y una terminada sin sesión dueña es candidata', () => {
  const root = repo()
  run(root, 'running', { state: 'running', session: null })
  run(root, 'writer', { writer: true, harvest: false, session: null })
  run(root, 'native', { native: true, state: 'delegated', session: null })
  const reserved = run(root, 'reserved', { native: true, state: 'delegated', session: null })
  put(join(reserved, 'launch.json'), { tool_use_id: 'tool-1' })
  age(reserved)
  run(root, 'review', { review: true, pending: true, session: null })
  run(root, 'undelivered', { delivered: false })
  run(root, 'no-owner', { delivered: false, session: null })
  const broken = run(root, 'unreadable')
  put(join(broken, 'status.json'), '{')
  age(broken)
  const out = prune(root).out
  for (const id of ['running', 'writer', 'native', 'reserved', 'review', 'undelivered']) {
    assert.equal(keptReason(out, id), 'open', id)
    assert.ok(out.kept.find((k) => k.id === id)!.next)
  }
  assert.deepEqual(candidateIds(out, 'run'), ['no-owner'])
  assert.equal(keptReason(out, 'unreadable'), 'unreadable')
})

test('lo que cita un flujo abierto del checkout o de un worktree se conserva, y un archivo de flujo ilegible frena prune', () => {
  const root = repo()
  const local = run(root, 'local-id')
  const remote = run(root, 'remote-id')
  run(root, 'archived-id')
  run(root, 'token')
  flow(root, 'local-flow', 'local-id token-long')
  put(join(root, '.plans', 'archived', 'f', 'plan.md'), 'archived-id')
  const other = worktree(root)
  flow(other, 'remote-flow', 'remote-id', 'handoff.md')
  const gitHome = join(gitDirs(root).gitDir, 'sdd-ai')
  const receipt = dirname(put(join(gitHome, 'verify', 'receipt-id', 'receipt.json'), {}))
  const att = put(join(gitHome, 'verify', 'attestations', 'att-id.json'), {})
  const take = put(join(gitHome, 'takeovers', 't-id.json'), {})
  for (const path of [receipt, att, take]) age(path)
  const nested = put(join(root, '.plans', 'local-flow', 'notes', 'refs.txt'), 'receipt-id att-id t-id')
  const out = prune(root).out
  assert.deepEqual(out.kept.find((k) => k.id === 'local-id')!.flows, ['local-flow'])
  assert.deepEqual(out.kept.find((k) => k.id === 'remote-id')!.flows, ['remote-flow'])
  for (const id of ['receipt-id', 'att-id', 't-id']) assert.equal(keptReason(out, id), 'cited')
  assert.deepEqual(candidateIds(out, 'run'), ['archived-id', 'token'])
  chmodSync(nested, 0o000)
  try {
    const dry = prune(root)
    assert.equal(dry.code, 2)
    assert.equal(dry.out.code, 'flow_unreadable')
    assert.ok(dry.out.message?.includes(nested))
    const apply = prune(root, '--apply', '--digest', out.digest)
    assert.equal(apply.out.code, 'flow_unreadable')
    for (const path of [local, remote, receipt, att, take]) assert.equal(existsSync(path), true)
  } finally {
    chmodSync(nested, 0o644)
  }
  // Un flujo detrás de un enlace no se recorre: frena igual que un archivo ilegible.
  const linked = join(outside(), 'linked-flow')
  put(join(linked, 'plan.md'), 'local-id')
  symlinkSync(linked, join(root, '.plans', 'linked-flow'))
  const viaLink = prune(root)
  assert.equal(viaLink.out.code, 'flow_unreadable')
  assert.ok(viaLink.out.message?.includes(join(root, '.plans', 'linked-flow')))
})

test('prune no borra en otro worktree ni toca la reserva, la restauración ni la config, y se niega si una base es un enlace', () => {
  const root = repo()
  run(root, 'local')
  const other = worktree(root)
  const otherRun = run(other, 'other-run')
  const gitHome = join(gitDirs(root).gitDir, 'sdd-ai')
  const protectedFiles = [
    put(join(gitHome, 'writer.lock'), { id: 'writer', pid: process.pid, lstart: null }),
    put(join(gitHome, 'verify', 'restore-intent.json'), { checkout: other }),
    put(join(root, '.sdd-ai', 'config.yml'), 'config'), put(join(root, '.sdd-ai', 'workers.yml'), 'workers'),
    put(join(root, '.sdd-ai', '.gitignore'), '*\n'),
    put(join(root, '.sdd-ai', 'runs', 'loose-file'), 'suelto'), put(join(gitHome, 'verify', 'loose-file'), 'suelto'),
  ]
  for (const path of protectedFiles) age(path)
  const draft = prune(root).out
  assert.deepEqual(candidateIds(draft, 'run'), ['local'])
  const applied = prune(root, '--apply', '--digest', draft.digest)
  assert.equal(applied.code, 0)
  assert.equal(existsSync(otherRun), true)
  for (const path of protectedFiles) assert.equal(existsSync(path), true)
  const target = outside()
  put(join(target, 'keep'), 'no borrar')
  symlinkSync(target, join(root, '.sdd-ai', 'tmp'))
  const linked = prune(root)
  assert.equal(linked.code, 2)
  assert.equal(linked.out.code, 'path_invalid')
  assert.equal(prune(root, '--apply', '--digest', draft.digest).out.code, 'path_invalid')
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'no borrar')
  rmSync(join(root, '.sdd-ai', 'tmp'))
  mkdirSync(join(root, '.sdd-ai', 'tmp'))
  const link = join(root, '.sdd-ai', 'tmp', 'link')
  symlinkSync(target, link)
  const old = new Date(Date.now() - 10 * 86_400_000)
  // La edad del enlace se fija sin modificar su destino.
  lutimesSync(link, old, old)
  const linkPlan = prune(root).out
  assert.equal(prune(root, '--apply', '--digest', linkPlan.digest).code, 0)
  assert.equal(existsSync(link), false)
  assert.equal(existsSync(join(target, 'keep')), true)
})

test('una sesión de hooks vieja se borra entera salvo que esté ligada a un flujo abierto o tenga el estado ilegible', () => {
  const root = repo()
  const hookPaths = (id: string) => [join(root, '.sdd-ai', 'hooks', `${id}.json`), ...['json', 'jsonl', 'lock'].map((ext) => join(root, '.sdd-ai', 'hooks', 'route', `${id}.${ext}`))]
  for (const path of hookPaths('old')) { put(path, {}); age(path) }
  const only = put(join(root, '.sdd-ai', 'hooks', 'only.json'), {})
  age(only)
  flow(root, 'f', 'flujo abierto')
  for (const path of hookPaths('bound')) { put(path, {}); age(path) }
  const binding = join(root, '.sdd-ai', 'hooks', 'route', 'bound.json')
  put(binding, { flow: { id: 'f', step: 'plan', gate: null, at: '2026-01-01' } })
  age(binding)
  const unreadable = put(join(root, '.sdd-ai', 'hooks', 'route', 'broken.json'), '{')
  age(unreadable)
  for (const path of hookPaths('active')) { put(path, {}); age(path) }
  age(hookPaths('active')[2], 1)
  const draft = prune(root).out
  assert.equal(keptReason(draft, 'bound'), 'bound')
  assert.equal(keptReason(draft, 'broken'), 'unreadable')
  assert.equal(keptReason(draft, 'active'), 'recent')
  assert.deepEqual([...new Set(candidateIds(draft, 'hook_session'))], ['old', 'only'])
  const applied = prune(root, '--apply', '--digest', draft.digest)
  assert.equal(applied.code, 0)
  for (const path of [...hookPaths('old'), only]) assert.equal(existsSync(path), false)
  for (const path of [...hookPaths('bound'), ...hookPaths('active'), unreadable]) assert.equal(existsSync(path), true)
})

test('una entrada vieja de tmp es candidata y una reciente se conserva', () => {
  const root = repo()
  const old = put(join(root, '.sdd-ai', 'tmp', 'old'), 'viejo')
  const recent = put(join(root, '.sdd-ai', 'tmp', 'recent'), 'nuevo')
  age(old)
  const draft = prune(root).out
  assert.deepEqual(candidateIds(draft, 'tmp'), ['old'])
  assert.equal(keptReason(draft, 'recent'), 'recent')
  assert.equal(prune(root, '--apply', '--digest', draft.digest).code, 0)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(recent), true)
})
