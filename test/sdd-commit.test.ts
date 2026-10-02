import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChainSetup, approveFlowGates, chainFlow, chainSetup, fakePrompts, runBin } from './helpers.ts'

const subject = 'agrega el cambio'
/** El contenido de `src/a.ts` que verifica la fila de la fixture: varias pruebas lo restauran para volver al candidato. */
const VERIFIED = 'export const f = () => 2\n'
/** Un digest con forma válida que no es el de ningún ensayo: o la negativa llega antes de compararlo, o no coincide. */
const FOREIGN_DIGEST = `sha256:${'0'.repeat(64)}`
const git = (s: ChainSetup, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
  cwd: s.repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim()
const file = (s: ChainSetup, path: string) => join(s.repo, path)
const text = (s: ChainSetup, path: string) => readFileSync(file(s, path), 'utf8')
const put = (s: ChainSetup, path: string, value: string) => {
  mkdirSync(join(file(s, path), '..'), { recursive: true })
  writeFileSync(file(s, path), value)
}
const planPath = '.plans/f/plan.md'
const registryPath = '.plans/f/sdd-ai-phases.json'
const registry = (s: ChainSetup) => JSON.parse(text(s, registryPath))
const writeRegistry = (s: ChainSetup, r: unknown) => put(s, registryPath, `${JSON.stringify(r, null, 2)}\n`)
const reviewPath = (id: string, name: string) => `.sdd-ai/runs/${id}/${name}.json`
const json = (s: ChainSetup, path: string) => JSON.parse(text(s, path))
const markAll = (s: ChainSetup) => put(s, '.plans/f/tasks.md', text(s, '.plans/f/tasks.md').replaceAll('- [ ]', '- [x]'))
const report = (done: string[], pending: string[] = []) => `${JSON.stringify({ phase: 'implement', missing_context: [],
  tasks: [...done.map((id) => ({ id, completion: 'done' })), ...pending.map((id) => ({ id, completion: 'pending' }))]
    .map((t) => ({ ...t, change_kind: 'behavior_change', changed: 'resultado', deviation: null, check: 'V1' })),
})}\nSTATUS: done\n`
const success = (r: ReturnType<typeof runBin>) => {
  assert.equal(r.code, 0, `${JSON.stringify(r.out)}\n${r.stderr}`)
  return r.out
}
const wait = (s: ChainSetup, id: string) => success(runBin(s, ['wait', id, '--max', '60']))
const draft = (s: ChainSetup, value = subject) => runBin(s, ['sdd', 'commit', 'f', '--subject', value])
const apply = (s: ChainSetup, digest: string, value = subject) => runBin(s, ['sdd', 'commit', 'f', '--subject', value, '--apply', '--digest', digest])
const snapshot = (s: ChainSetup) => ({
  head: git(s, 'rev-parse', 'HEAD'), index: readFileSync(file(s, '.git/index')),
  objects: readdirSync(file(s, '.git/objects'), { recursive: true }).sort(),
  plan: text(s, planPath), registry: existsSync(file(s, registryPath)) ? text(s, registryPath) : null,
  // diff-files no refresca el índice: un `git diff` lo reescribiría y la comparación de bytes fallaría sola.
  diff: git(s, 'diff-files', '--binary', '-p'),
})
const unchanged = (s: ChainSetup, before: ReturnType<typeof snapshot>) => assert.deepEqual(snapshot(s), before)
const refused = (s: ChainSetup, code: string, digest?: string) => {
  const before = snapshot(s)
  for (const r of [draft(s), ...(digest ? [apply(s, digest)] : [])]) {
    assert.notEqual(r.code, 0, JSON.stringify(r.out))
    assert.equal(r.out.code, code, JSON.stringify(r.out))
    assert.ok(r.out.next, JSON.stringify(r.out))
    unchanged(s, before)
  }
}

function review(s: ChainSetup, extra: string[] = []): string {
  const r = success(runBin(s, ['review', 'start', '--base', s.base, '--untracked', '--flow', 'f', '--author', 'claude', ...extra], { FAKE_MODE: 'review-ok' }))
  assert.equal(wait(s, r.id).state, 'done')
  return r.id
}

/** Un candidato verificado y revisado; las variantes preparan su base antes de crear el flujo. */
function committable(o: { chain?: boolean; takeover?: boolean; prepare?: (s: ChainSetup) => void; edit?: (s: ChainSetup) => void; review?: boolean } = {}) {
  const s = chainSetup({ bins: ['codex', 'claude'], families: '[codex, claude]',
    writers: [{ actions: [{ write: 'src/a.ts', content: VERIFIED }], report: report(['T1']) }] })
  git(s, 'config', 'user.name', 't')
  git(s, 'config', 'user.email', 't@t')
  if (o.prepare) {
    o.prepare(s)
    git(s, 'add', '-A')
    git(s, 'commit', '-q', '-m', 'fixture')
    s.base = git(s, 'rev-parse', 'HEAD')
  }
  chainFlow(s, { status: o.chain ? 'tasks-ready' : 'implementing' })
  let run: string | undefined
  if (o.chain) {
    run = success(runBin(s, ['sdd', 'phase', 'f'])).id
    wait(s, run!)
  } else put(s, 'src/a.ts', VERIFIED)
  o.edit?.(s)
  markAll(s)
  const verified = success(runBin(s, ['sdd', 'verify', 'f', ...(o.takeover ? ['--takeover', '--reason', 'edición del conductor'] : [])]))
  assert.equal(verified.green, true, JSON.stringify(verified))
  assert.match(text(s, planPath), /^status: verified$/m)
  const reviewId = o.review === false ? undefined : review(s)
  return { s, run, reviewId, verified }
}

test('el ensayo de sdd commit no cambia nada y devuelve las rutas con su origen, el mensaje, el recibo, la revisión, el digest y el comando', () => {
  const { s, run, reviewId, verified } = committable({ chain: true, takeover: true, edit: (s) => {
    put(s, 'src/conductor.ts', 'export const value = 3\n')
  } })
  const before = snapshot(s)
  const out = success(draft(s))
  unchanged(s, before)
  assert.equal(out.state, 'dry_run')
  assert.equal(out.flow, 'f')
  assert.deepEqual(out.paths.find((p: { path: string }) => p.path === 'src/a.ts').origin, { kind: 'run', id: run })
  const takeover = registry(s).implement.chains[0].entries.at(-1).id
  assert.deepEqual(out.paths.find((p: { path: string }) => p.path === 'src/conductor.ts').origin, { kind: 'takeover', id: takeover })
  assert.equal(out.message, `feat: ${subject}\n`)
  assert.equal(out.receipt.id, verified.receipt)
  assert.equal(out.review.id, reviewId)
  assert.equal(out.review.family, 'codex')
  assert.deepEqual(out.review.degradations, [])
  assert.match(out.digest, /^sha256:[a-f0-9]{64}$/)
  assert.ok(out.next.includes(`--apply --digest ${out.digest}`))
})

test('sdd commit commitea el candidato verificado con renombres, borrados y modos, y nunca .plans, .specify, .cross-model ni .sdd-ai', () => {
  const { s } = committable({ prepare: (s) => {
    put(s, 'old.txt', 'renombrado\n'); put(s, 'deleted.txt', 'borrado\n'); put(s, 'script.sh', '#!/bin/sh\nexit 0\n')
    put(s, '.sdd-ai/frozen.txt', 'base\n'); git(s, 'add', '-f', '.sdd-ai/frozen.txt')
  }, edit: (s) => {
    renameSync(file(s, 'old.txt'), file(s, 'new.txt'))
    rmSync(file(s, 'deleted.txt'))
    chmodSync(file(s, 'script.sh'), 0o755)
    put(s, '.git/info/exclude', '')
    put(s, '.sdd-ai/.gitignore', '*\n'); put(s, '.sdd-ai/frozen.txt', 'no entra\n')
    put(s, '.plans/other.txt', 'no entra\n')
    put(s, '.specify/example.txt', 'no entra\n'); put(s, '.cross-model/example.txt', 'no entra\n')
    put(s, '.agents/example.txt', 'sensible\n')
  } })
  // Precondición: Git no ignora las rutas de .plans, .specify y .cross-model, y ve cambiado .sdd-ai/frozen.txt, que
  // está rastreado aunque .sdd-ai/ tenga su propio `*`. Así la exclusión de las cuatro es del verbo, no de Git.
  assert.equal(spawnSync('git', ['check-ignore', '.plans/other.txt', '.specify/example.txt', '.cross-model/example.txt'], { cwd: s.repo }).status, 1)
  assert.equal(git(s, 'diff-files', '--name-only', '--', '.sdd-ai/frozen.txt'), '.sdd-ai/frozen.txt')
  const d = success(draft(s))
  const paths = new Map<string, string>(d.paths.map((p: { path: string; status: string }) => [p.path, p.status]))
  assert.equal(paths.get('old.txt'), 'D'); assert.equal(paths.get('new.txt'), 'A')
  assert.equal(paths.get('deleted.txt'), 'D'); assert.equal(paths.get('script.sh'), 'M')
  assert.equal(d.paths.find((p: { path: string }) => p.path === '.agents/example.txt').sensitive, true)
  assert.ok([...paths.keys()].every((p) => !/^\.(plans|specify|cross-model|sdd-ai)\//.test(p)))
  const committed = success(apply(s, d.digest))
  assert.equal(committed.state, 'committed')
  const changed = git(s, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD').split('\0').filter(Boolean).sort()
  assert.deepEqual(changed, [...paths.keys()].sort())
  assert.match(git(s, 'ls-tree', 'HEAD', 'script.sh'), /^100755 /)
  assert.equal(git(s, 'show', 'HEAD:new.txt'), 'renombrado')
  assert.equal(git(s, 'show', 'HEAD:.sdd-ai/frozen.txt'), 'base')
  assert.equal(git(s, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').some((p) => /^\.(plans|specify|cross-model)\//.test(p)), false)
})

test('sdd commit rechaza sin tocar nada un change_type inválido y un asunto vacío, de varias líneas, con mayúscula inicial o demasiado largo', () => {
  const { s } = committable()
  for (const value of ['', ' ', 'dos\nlíneas', 'dos\rlíneas', 'Mayúscula', 'a'.repeat(72)]) {
    const before = snapshot(s)
    assert.equal(draft(s, value).out.code, 'subject_invalid')
    assert.equal(apply(s, FOREIGN_DIGEST, value).out.code, 'subject_invalid')
    unchanged(s, before)
  }
  put(s, planPath, text(s, planPath).replace('change_type: feat', 'change_type: invalid'))
  refused(s, 'change_type_invalid', FOREIGN_DIGEST)
})

test('sdd commit --apply crea un solo commit con el contenido verificado, preserva lo staged de afuera aunque una ruta tenga metacaracteres, pasa el header a committed y lo registra', () => {
  const { s, reviewId, verified } = committable({ prepare: (s) => {
    put(s, 'x.txt', 'base\n'); put(s, 'axb', 'base\n')
  }, edit: (s) => {
    put(s, 'x.txt', 'staged\n'); put(s, 'axb', 'staged\n')
    git(s, 'add', 'x.txt', 'axb')
    put(s, 'x.txt', 'base\n'); put(s, 'axb', 'base\n'); put(s, 'a*b', 'candidato\n')
  } })
  const staged = [git(s, 'show', ':x.txt'), git(s, 'show', ':axb')]
  const before = text(s, planPath)
  const parent = git(s, 'rev-parse', 'HEAD')
  const d = success(draft(s))
  const out = success(apply(s, d.digest))
  assert.equal(out.state, 'committed')
  assert.equal(git(s, 'rev-parse', 'HEAD^'), parent)
  assert.equal(out.sha, git(s, 'rev-parse', 'HEAD'))
  assert.equal(git(s, 'show', 'HEAD:src/a.ts'), 'export const f = () => 2')
  assert.equal(git(s, 'show', 'HEAD:a*b'), 'candidato')
  assert.deepEqual([git(s, 'show', ':x.txt'), git(s, 'show', ':axb')], staged)
  assert.equal(git(s, '--literal-pathspecs', 'diff', '--cached', 'HEAD', '--', 'src/a.ts', 'a*b'), '')
  assert.equal(text(s, planPath), before.replace('status: verified', 'status: committed'))
  const c = registry(s).commit
  assert.equal(c.state, 'done'); assert.equal(c.sha, out.sha); assert.equal(c.digest, d.digest)
  assert.equal(c.receipt.id, verified.receipt); assert.equal(c.review, reviewId)
  assert.equal(success(runBin(s, ['sdd', 'status', 'f'])).next.step, 'archive')
  git(s, 'remote', 'add', 'origin', 'https://example.invalid/repo.git')
  assert.equal(success(runBin(s, ['sdd', 'status', 'f'])).next.step, 'push')
})

test('el registro de fases rechaza un commit cuya fecha no es un instante ISO completo', () => {
  const { s } = committable()
  success(apply(s, success(draft(s)).digest))
  const r = registry(s)
  // Solo fecha, sin hora, también se rechaza: el registro guarda el instante del commit.
  for (const at of ['October 1, 2026', '2026-10-01', 'invalid']) {
    writeRegistry(s, { ...r, commit: { ...r.commit, at } })
    const invalidBefore = snapshot(s)
    assert.equal(draft(s).out.code, 'phases_invalid')
    unchanged(s, invalidBefore)
  }
})

test('sdd commit commitea sobre un HEAD que avanzó desde la base y deja su entrada de reflog aunque el repo tenga el reflog apagado', () => {
  const advanced = committable()
  const approved = success(draft(advanced.s))
  // Con el reflog apagado, el verbo igual tiene que poder identificar su commit: lo fuerza para ese comando. Con
  // core.logAllRefUpdates=false, Git sigue agregando entradas a un log que ya existe y solo deja de crearlo; por eso
  // se borra .git/logs: así la única forma de que aparezca la entrada del verbo es que él fuerce el reflog.
  git(advanced.s, 'config', 'core.logAllRefUpdates', 'false')
  git(advanced.s, 'commit', '--allow-empty', '-q', '-m', 'avance del padre')
  rmSync(file(advanced.s, '.git/logs'), { recursive: true, force: true })
  const advancedParent = git(advanced.s, 'rev-parse', 'HEAD')
  assert.equal(success(draft(advanced.s)).digest, approved.digest)
  const committed = success(apply(advanced.s, approved.digest))
  assert.equal(git(advanced.s, 'rev-parse', 'HEAD^'), advancedParent)
  assert.equal(committed.sha, git(advanced.s, 'rev-parse', 'HEAD'))
  assert.match(git(advanced.s, 'reflog', 'show', '--format=%gs', '-n', '1', 'HEAD'), /^sdd-ai commit [a-f0-9]+:/)
})

test('sdd commit --apply sin digest o con uno que no coincide no toca nada', () => {
  const { s } = committable()
  const before = snapshot(s)
  const missing = runBin(s, ['sdd', 'commit', 'f', '--subject', subject, '--apply'])
  assert.equal(missing.out.code, 'usage'); unchanged(s, before)
  const mismatch = apply(s, FOREIGN_DIGEST)
  assert.equal(mismatch.out.code, 'digest_mismatch'); unchanged(s, before)
  assert.equal(runBin(s, ['sdd', 'commit', 'f', '--subject', subject, '--digest', 'x']).out.code, 'usage')
  unchanged(s, before)
})

test('sdd commit se niega sin tocar nada fuera de review_and_commit, con el recibo vencido, con contrato en prosa, sin revisión convergida y vigente del candidato entero, con una restauración pendiente o con un writer o un verify en vuelo', () => {
  const a = committable()
  const digest = success(draft(a.s)).digest
  const original = text(a.s, planPath)
  put(a.s, planPath, original.replace('status: verified', 'status: implementing'))
  refused(a.s, 'step_not_commit', digest)
  put(a.s, planPath, original)
  put(a.s, 'src/a.ts', 'export const f = () => 3\n')
  refused(a.s, 'step_not_commit', digest)
  put(a.s, 'src/a.ts', VERIFIED)
  put(a.s, planPath, original.slice(0, original.indexOf('## Verification')) + '## Verification\n\nPruebas manuales.\n')
  approveFlowGates(a.s.repo)
  refused(a.s, 'contract_prose', digest)
  const b = committable({ review: false })
  refused(b.s, 'review_missing', FOREIGN_DIGEST)
  const c = committable()
  const requestPath = reviewPath(c.reviewId!, 'request')
  const request = json(c.s, requestPath)
  for (const mutate of [
    (r: any) => { delete r.flow },
    (r: any) => { delete r.selection.untracked },
    (r: any) => { r.selection.head = 'HEAD' },
    (r: any) => { r.selection.base = 'HEAD'; r.selection.untracked = false },
    (r: any) => { r.selection.context = ['missing-context.md'] },
  ]) {
    const changed = structuredClone(request); mutate(changed)
    put(c.s, requestPath, JSON.stringify(changed))
    refused(c.s, 'review_missing', digest)
  }
  put(c.s, requestPath, JSON.stringify(request))
  const ledgerPath = reviewPath(c.reviewId!, 'ledger')
  const ledger = json(c.s, ledgerPath)
  for (const state of ['abierto', 'aceptado', 'rechazado', 'en-disputa']) {
    put(c.s, ledgerPath, JSON.stringify({ ...ledger, entries: [{ id: 'F-1', state, opened_round: 1, seen_round: 1 }] }))
    refused(c.s, 'review_missing', digest)
  }
  put(c.s, ledgerPath, JSON.stringify(ledger))
  const statusPath = reviewPath(c.reviewId!, 'status')
  const status = json(c.s, statusPath)
  put(c.s, statusPath, JSON.stringify({ ...status, state: 'running' }))
  refused(c.s, 'review_missing', digest)
  put(c.s, statusPath, JSON.stringify(status))
  put(c.s, `.sdd-ai/runs/${c.reviewId}/review.lock`, 'ocupado')
  refused(c.s, 'review_missing', digest)
  rmSync(file(c.s, `.sdd-ai/runs/${c.reviewId}/review.lock`))
  put(c.s, '.git/sdd-ai/verify/restore-intent.json', JSON.stringify({ receipt: 'pending', checkout: c.s.repo,
    owner_pid: process.pid, owner_lstart: null, paths: [] }))
  refused(c.s, 'restore_pending', digest)
  rmSync(file(c.s, '.git/sdd-ai/verify/restore-intent.json'))
  for (const kind of ['verify', undefined]) {
    put(c.s, '.git/sdd-ai/writer.lock', JSON.stringify({ id: 'busy', pid: process.pid, lstart: null, gitDir: file(c.s, '.git'), kind }))
    refused(c.s, 'writer_open', digest)
    rmSync(file(c.s, '.git/sdd-ai/writer.lock'))
  }
  const active = '20261001-0001-aaaa'
  const r = registry(c.s)
  r.last_run = { id: active, step: 'implement' }
  writeRegistry(c.s, r)
  put(c.s, `.sdd-ai/runs/${active}/status.json`, JSON.stringify({ state: 'running' }))
  refused(c.s, 'writer_open', digest)
  const e = committable()
  put(e.s, '.sdd-ai/config.yml', text(e.s, '.sdd-ai/config.yml') + 'jira_approval:\n  mode: "on"\n')
  put(e.s, '.plans/f/handoff.md', text(e.s, '.plans/f/handoff.md').replace('---\n\n# Handoff', 'gate_status: awaiting\n---\n\n# Handoff'))
  refused(e.s, 'step_not_commit', FOREIGN_DIGEST)
})

test('repetir sdd commit reconoce el commit del flujo por el registro o por el contenido y el mensaje aprobados: el ensayo no escribe y devuelve el digest, el --apply completa el índice, el registro y el header salvo con un writer en vuelo, y otro contenido no se reconoce', () => {
  for (const mode of ['done', 'intent', 'manual', 'manual_header']) {
    const { s } = committable()
    const d = success(draft(s))
    const original = text(s, planPath)
    const parent = git(s, 'rev-parse', 'HEAD')
    if (mode === 'done') success(apply(s, d.digest))
    else {
      git(s, 'add', 'src/a.ts')
      const tree = git(s, 'write-tree')
      if (mode === 'intent') {
        const r = registry(s)
        r.commit = { state: 'intent', at: new Date().toISOString(), digest: d.digest, parent, tree, message: d.message,
          paths: d.paths.map((p: { path: string }) => p.path), receipt: d.receipt, review: d.review.id }
        writeRegistry(s, r)
      }
      put(s, '.git/commit-message', d.message)
      git(s, 'commit', '-q', '--file', file(s, '.git/commit-message'), '--cleanup=verbatim')
      git(s, 'reset', '-q', parent, '--', 'src/a.ts')
    }
    const sha = git(s, 'rev-parse', 'HEAD')
    if (mode === 'done') put(s, planPath, original)
    if (mode === 'manual_header') put(s, planPath, original.replace('status: verified', 'status: committed'))
    const before = snapshot(s)
    const repeated = success(draft(s))
    unchanged(s, before)
    assert.equal(repeated.state, 'already_committed'); assert.equal(repeated.sha, sha); assert.equal(repeated.digest, d.digest)
    assert.deepEqual(repeated.pending, mode === 'done' ? ['header'] : ['index', 'registry', ...(mode === 'manual_header' ? [] : ['header'])])
    assert.equal(apply(s, FOREIGN_DIGEST).out.code, 'digest_mismatch')
    unchanged(s, before)
    put(s, '.git/sdd-ai/writer.lock', JSON.stringify({ id: 'busy', pid: process.pid, lstart: null, gitDir: file(s, '.git'), kind: 'verify' }))
    refused(s, 'writer_open', d.digest)
    rmSync(file(s, '.git/sdd-ai/writer.lock'))
    put(s, '.git/sdd-ai/verify/restore-intent.json', JSON.stringify({ receipt: 'pending', checkout: s.repo,
      owner_pid: process.pid, owner_lstart: null, paths: [] }))
    refused(s, 'restore_pending', d.digest)
    rmSync(file(s, '.git/sdd-ai/verify/restore-intent.json'))
    const completed = success(apply(s, d.digest))
    assert.equal(completed.state, 'already_committed'); assert.equal(completed.sha, sha)
    assert.equal(git(s, 'rev-parse', 'HEAD'), sha)
    assert.equal(git(s, 'diff', '--cached', 'HEAD', '--', 'src/a.ts'), '')
    assert.equal(registry(s).commit.state, 'done'); assert.match(text(s, planPath), /^status: committed$/m)
    assert.deepEqual(success(draft(s)).pending, [])
    assert.equal(success(apply(s, d.digest)).sha, sha)
  }
  const { s } = committable()
  const d = success(draft(s))
  put(s, 'src/a.ts', 'export const f = () => 4\n')
  git(s, 'add', 'src/a.ts'); put(s, '.git/commit-message', d.message)
  git(s, 'commit', '-q', '--file', file(s, '.git/commit-message'))
  // Con el árbol verificado, HEAD tiene otro contenido: el ensayo sigue siendo un ensayo normal, no un reconocimiento.
  put(s, 'src/a.ts', VERIFIED)
  const verifiedTree = snapshot(s)
  assert.equal(success(draft(s)).state, 'dry_run'); unchanged(s, verifiedTree)
  // Con el árbol de HEAD, el recibo venció: se niega por el paso, sin escribir nada.
  put(s, 'src/a.ts', 'export const f = () => 4\n')
  const before = snapshot(s)
  assert.equal(draft(s).out.code, 'step_not_commit'); unchanged(s, before)
  assert.equal(apply(s, d.digest).out.code, 'step_not_commit')
  unchanged(s, before)
})

test('un hook de Git que falla, que altera el contenido o el mensaje, o un HEAD que se movió, dejan HEAD, el índice, el header y el registro como estaban', () => {
  for (const kind of ['failure', 'content', 'message', 'race', 'hook-commit', 'post-commit']) {
    const { s } = committable()
    const d = success(draft(s))
    git(s, 'config', 'core.logAllRefUpdates', 'false')
    let hook: string
    if (kind === 'failure') hook = '#!/bin/sh\necho hook-failed >&2\nexit 1\n'
    else if (kind === 'content') hook = '#!/bin/sh\nprintf "export const f = () => 3\\n" > src/a.ts\ngit add src/a.ts\n'
    else if (kind === 'message') hook = '#!/bin/sh\nprintf "\\nadded by hook\\n" >> "$1"\n'
    else if (kind === 'race') hook = '#!/bin/sh\ntree=$(git write-tree)\nother=$(printf "foreign\\n" | git commit-tree "$tree" -p HEAD)\ngit update-ref refs/heads/foreign "$other"\ngit update-ref HEAD "$other"\nprintf "%s" "$other" > .git/foreign-sha\nexit 1\n'
    // Los hooks heredan GIT_REFLOG_ACTION: su commit lleva la misma marca que el del verbo.
    else if (kind === 'hook-commit') hook = '#!/bin/sh\ngit -c user.name=h -c user.email=h@h commit -q --allow-empty --no-verify -m "del hook"\ngit rev-parse HEAD > .git/foreign-sha\n'
    // post-commit corre también tras el commit del propio hook: la marca evita que se llame sin fin.
    else hook = '#!/bin/sh\n[ -f .git/hook-ran ] && exit 0\ntouch .git/hook-ran\ngit -c user.name=h -c user.email=h@h commit -q --allow-empty --no-verify -m "encima"\ngit rev-parse HEAD > .git/foreign-sha\n'
    const hookPath = `.git/hooks/${kind === 'message' ? 'commit-msg' : kind === 'post-commit' ? 'post-commit' : 'pre-commit'}`
    put(s, hookPath, hook); chmodSync(file(s, hookPath), 0o755)
    const before = snapshot(s)
    const r = apply(s, d.digest)
    assert.equal(r.out.code, ['content', 'message', 'post-commit'].includes(kind) ? 'commit_altered' : 'commit_failed', JSON.stringify(r.out))
    const after = snapshot(s)
    assert.deepEqual(after.index, before.index); assert.equal(after.plan, before.plan); assert.equal(after.registry, before.registry)
    if (kind === 'hook-commit' || kind === 'post-commit') {
      // Lo que hizo un hook dentro del mismo git commit lleva la marca del intento: se deshace con él, y la salida
      // nombra cada commit deshecho.
      assert.equal(after.head, before.head)
      assert.ok(r.out.detail.includes(text(s, '.git/foreign-sha').trim()), r.out.detail)
      if (kind === 'post-commit') {
        // También se nombra el commit del verbo, el de su asunto con la marca del intento.
        const own = /^([0-9a-f]+) sdd-ai commit [0-9a-f]+: feat: agrega el cambio$/m.exec(git(s, 'reflog', 'show', '--format=%H %gs', 'HEAD'))
        assert.ok(own && r.out.detail.includes(own[1]), r.out.detail)
      }
    } else if (kind === 'race') {
      assert.equal(after.head, text(s, '.git/foreign-sha')); assert.notEqual(after.head, before.head)
      assert.ok(r.out.detail.includes(after.head))
    } else assert.equal(after.head, before.head)
    if (kind === 'failure') assert.match(r.out.detail, /hook-failed/)
    if (kind === 'content') { assert.match(r.out.detail, /src\/a.ts/); assert.match(text(s, 'src/a.ts'), /=> 3/) }
    if (kind === 'message') assert.match(r.out.detail, /message/)
  }
})

// A diferencia de los casos de la prueba anterior, cuando un hook cambia de rama deshacer movería otra rama, así que
// el verbo no toca ninguna referencia. La rama del flujo queda como estaba, pero HEAD queda en la del hook.
test('si un hook cambia de rama durante el commit, sdd commit no mueve ninguna referencia y conserva la intención', () => {
  const { s } = committable()
  const d = success(draft(s))
  put(s, '.git/hooks/pre-commit', '#!/bin/sh\ngit checkout -q -b hooked\n'); chmodSync(file(s, '.git/hooks/pre-commit'), 0o755)
  const branch = git(s, 'symbolic-ref', 'HEAD')
  const before = snapshot(s)
  const r = apply(s, d.digest)
  assert.equal(r.out.code, 'commit_altered', JSON.stringify(r.out))
  assert.equal(git(s, 'rev-parse', branch), before.head)
  assert.equal(git(s, 'symbolic-ref', 'HEAD'), 'refs/heads/hooked')
  assert.match(r.out.detail, /hooked/)
  // El commit del verbo quedó en la rama del hook: la intención se conserva para reconocerlo.
  assert.equal(registry(s).commit.state, 'intent')
  assert.deepEqual(snapshot(s).index, before.index); assert.equal(snapshot(s).plan, before.plan)
})

test('sin escritura en el directorio de Git, sdd commit --apply se niega con git_unwritable antes de tocar el índice', (t) => {
  // root escribe aunque el directorio sea 0555: ahí chmod no simula el sandbox.
  if (process.getuid?.() === 0) return t.skip('corre como root: chmod no quita la escritura')
  const { s } = committable()
  const d = success(draft(s))
  const before = snapshot(s)
  for (const dir of ['.git/objects', '.git/refs']) {
    const mode = statSync(file(s, dir)).mode & 0o7777
    chmodSync(file(s, dir), 0o555)
    try {
      const r = apply(s, d.digest)
      assert.equal(r.out.code, 'git_unwritable', JSON.stringify(r.out))
      assert.match(r.out.next, /escalada/)
      unchanged(s, before)
    } finally { chmodSync(file(s, dir), mode) }
  }
})

test('review start --flow guarda el flujo en la corrida y rechaza un flujo que no existe, una revisión sin --untracked ni --harvest y otra base', () => {
  const { s, reviewId } = committable()
  assert.equal(json(s, reviewPath(reviewId!, 'request')).flow, 'f')
  const args = ['review', 'start', '--base', s.base, '--author', 'claude']
  const before = snapshot(s)
  for (const [flags, code] of [
    [['--untracked', '--flow', 'missing'], 'flow_not_found'],
    [['--flow', 'f'], 'usage'], [['--flow', 'f', '--untracked', '--head', 'HEAD'], 'usage'],
    [['--flow', 'f', '--artifact', planPath, '--kind', 'spec', '--request', 'src/a.ts'], 'usage'],
  ] as Array<[string[], string]>) {
    assert.equal(runBin(s, [...args, ...flags], { FAKE_MODE: 'review-ok' }).out.code, code)
    unchanged(s, before)
  }
  git(s, 'commit', '--allow-empty', '-q', '-m', 'otra base')
  const after = snapshot(s)
  const mismatch = runBin(s, ['review', 'start', '--base', 'HEAD', '--untracked', '--flow', 'f'], { FAKE_MODE: 'review-ok' })
  assert.equal(mismatch.out.code, 'flow_base_mismatch'); unchanged(s, after)
  const chained = committable({ chain: true, review: false })
  const harvested = success(runBin(chained.s, ['review', 'start', '--harvest', chained.run!, '--flow', 'f'], { FAKE_MODE: 'review-ok' }))
  wait(chained.s, harvested.id)
  assert.equal(json(chained.s, reviewPath(harvested.id, 'request')).flow, 'f')
})

test('con una revisión del flujo convergida, vigente y del candidato entero, sdd status propone el ensayo de sdd commit con cadena y sin ella, y si no la hay propone review start con --flow', () => {
  for (const chain of [false, true]) {
    const { s } = committable({ chain, review: false })
    const next = () => success(runBin(s, ['sdd', 'status', 'f'])).next
    assert.equal(next().step, 'review_and_commit'); assert.match(next().command, /review start .*--flow f/)
    const id = review(s)
    assert.equal(next().command, './bin/sdd-ai sdd commit f --subject "<asunto>"')
    assert.ok(next().detail.includes(id))
    const reqPath = reviewPath(id, 'request')
    const req = json(s, reqPath)
    for (const altered of [
      { ...req, flow: undefined }, { ...req, selection: { ...req.selection, untracked: false } },
      { ...req, selection: { artifact: file(s, planPath), kind: 'plan', inputs: [], context: [] } },
      { ...req, selection: { ...req.selection, context: ['absent.md'] } },
    ]) {
      put(s, reqPath, JSON.stringify(altered))
      assert.match(next().command, /review start .*--flow f/)
    }
    put(s, reqPath, JSON.stringify(req))
    const statusPath = reviewPath(id, 'status')
    const status = json(s, statusPath)
    put(s, statusPath, JSON.stringify({ ...status, state: 'running' }))
    assert.match(next().command, /review start .*--flow f/)
    put(s, statusPath, JSON.stringify(status))
    const ledgerPath = reviewPath(id, 'ledger')
    const ledger = json(s, ledgerPath)
    put(s, ledgerPath, JSON.stringify({ ...ledger, entries: [{ id: 'F-1', state: 'aceptado', opened_round: 1, seen_round: 1 }] }))
    assert.match(next().command, /review start .*--flow f/)
    put(s, ledgerPath, JSON.stringify(ledger))
    put(s, `.sdd-ai/runs/${id}/review.lock`, 'ocupado')
    assert.match(next().command, /review start .*--flow f/)
    rmSync(file(s, `.sdd-ai/runs/${id}/review.lock`))
    assert.match(next().command, /sdd commit/)
    put(s, reqPath, JSON.stringify({ ...req, degradations: ['same_family'] }))
    assert.match(next().command, /sdd commit/)
  }
})

test('una corrida nueva de la cadena registra el digest del encargo, la familia y el perfil, también heredado de un origen anterior, y copia el encargo al flujo con ese digest', () => {
  const s = chainSetup({ bins: ['codex', 'claude'], families: '[codex, claude]', writers: [
    { actions: [{ write: 'src/one.ts', content: 'export const one = 1\n' }], report: report(['T1'], ['T2', 'T3']) },
    { actions: [{ write: 'src/two.ts', content: 'export const two = 2\n' }], report: report(['T2'], ['T3']) },
    { actions: [{ write: 'src/three.ts', content: 'export const three = 3\n' }], report: report(['T3']) },
  ] })
  put(s, '.sdd-ai/workers.yml', 'schema_version: 1\nroles:\n  implement:\n    codex:\n      model: test-model\n      effort: alto\n')
  chainFlow(s, { tasks: 3 })
  const first = success(runBin(s, ['sdd', 'phase', 'f']))
  wait(s, first.id)
  const initial = registry(s).implement.chains[0].entries[0]
  assert.equal(initial.launch.family, 'codex'); assert.equal(initial.launch.model, 'test-model'); assert.equal(initial.launch.effort, 'high')
  const checkPrompt = (id: string, launch: any, n: number) => {
    const bytes = readFileSync(file(s, `.plans/f/runs/${id}/encargo.md`))
    assert.equal(launch.prompt_digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    assert.equal(bytes.toString('utf8'), fakePrompts(s)[n])
  }
  checkPrompt(first.id, initial.launch, 0)
  // Un origen anterior conserva el perfil concreto en resolved.json.
  const old = registry(s)
  delete old.implement.chains[0].entries[0].launch
  writeRegistry(s, old)
  const controlPath = `.git/sdd-ai/runs/${first.id}/control.json`
  const control = json(s, controlPath)
  const bytes = readFileSync(file(s, registryPath))
  control.phase.registry = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  put(s, controlPath, JSON.stringify(control))
  // La resolución de ahora daría otro perfil: si la corrida nueva lo toma de acá y no del origen, la prueba falla.
  put(s, '.sdd-ai/workers.yml', 'schema_version: 1\nroles:\n  implement:\n    codex:\n      model: other-model\n      effort: bajo\n')
  const second = success(runBin(s, ['sdd', 'phase', 'f', '--blocks']))
  wait(s, second.id)
  const inherited = registry(s).implement.chains[0].entries[1]
  assert.deepEqual([inherited.launch.family, inherited.launch.model, inherited.launch.effort], ['codex', 'test-model', 'high'])
  checkPrompt(second.id, inherited.launch, 1)
  const third = success(runBin(s, ['sdd', 'phase', 'f']))
  wait(s, third.id)
  const last = registry(s).implement.chains[0].entries[2]
  assert.deepEqual([last.launch.family, last.launch.model, last.launch.effort], ['codex', 'test-model', 'high'])
  checkPrompt(third.id, last.launch, 2)
})
