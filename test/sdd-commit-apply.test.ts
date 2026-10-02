import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, renameSync, rmSync } from 'node:fs'
import { runBin } from './helpers.ts'
import {
  subject, git, file, text, put, planPath, registry, success, draft, apply, snapshot, unchanged, committable,
} from './sdd-commit-fixture.ts'

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
