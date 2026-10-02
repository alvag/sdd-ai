import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import {
  VERIFIED, FOREIGN_DIGEST, git, file, text, put, planPath, registry, writeRegistry, success, draft, apply, snapshot,
  unchanged, refused, committable,
} from './sdd-commit-fixture.ts'

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
