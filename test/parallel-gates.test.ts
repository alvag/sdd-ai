import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { cli, deadPid, git, readJsonFile } from './cli-run-fixture.ts'
import { legacyReservation, releaseMutex } from './legacy-reservation-fixture.ts'
import { STALE_DIGEST, branchFlow, commitArgs, parallelFixture, prepareCommit } from './parallel-worktrees-fixture.ts'
import { readFlow } from '../src/sdd/read.ts'
import { writerPrompt } from '../src/writer.ts'

const records = (root: string) => {
  const { gitDir, commonDir } = gitDirs(root)
  return Object.fromEntries([...new Set([join(root, '.plans'), join(gitDir, 'sdd-ai'), join(commonDir, 'sdd-ai')])]
    .flatMap((dir) => existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((name) => join(dir, name)) : [])
    .filter((file) => lstatSync(file).isFile()).sort().map((file) => [file, readFileSync(file).toString('hex')]))
}

test('la concurrencia conserva autoridad y gates y consultar branch o ensayar commit no toca reservas', async () => {
  const f = parallelFixture()
  try {
    branchFlow(f.left, 'branch-flow')
    const digest = prepareCommit(f.left)
    const contract = writerPrompt('change')
    assert.match(contract, /[Nn]o commitees/)
    assert.match(contract, /\.git/)
    assert.match(contract, /\.sdd-ai/)
    const head = git(f.left.repo, 'rev-parse', 'HEAD')
    for (const args of [['sdd', 'branch', 'branch-flow', '--apply'], commitArgs(digest)]) {
      assert.equal(cli(f.left, args, { SDD_AI_WORKER: '1' }).out.code, 'recursion')
    }
    assert.equal(cli(f.left, commitArgs(STALE_DIGEST)).out.code, 'digest_mismatch')
    const branchHandoff = join(f.left.repo, '.plans', 'branch-flow', 'handoff.md')
    writeFileSync(branchHandoff, readFileSync(branchHandoff, 'utf8').replace('profundidad: corta', 'profundidad: normal'))
    // En normal la spec va en su propio archivo; en corta, branchFlow no la escribe.
    writeFileSync(join(f.left.repo, '.plans', 'branch-flow', 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** crea rama. (pedido)\n')
    assert.equal(cli(f.left, ['sdd', 'branch', 'branch-flow', '--apply']).out.code, 'spec_not_approved')
    const approvals = { schema_version: 1, approvals: [{ gate: 'spec', depth: 'normal', fingerprint: readFlow(f.left.repo, 'branch-flow').facts.fingerprints.spec,
      previous: {}, at: '2026-10-02T14:00:00.000Z' }] }
    writeFileSync(join(f.left.repo, '.plans', 'branch-flow', 'sdd-ai-approvals.json'), JSON.stringify(approvals))
    assert.equal(cli(f.left, ['sdd', 'branch', 'branch-flow']).out.blockers.some((b: { code: string }) => b.code === 'spec_not_approved'), false)
    const branchSpec = join(f.left.repo, '.plans', 'branch-flow', 'spec.md')
    writeFileSync(branchSpec, `${readFileSync(branchSpec, 'utf8')}\nChanged.\n`)
    assert.equal(cli(f.left, ['sdd', 'branch', 'branch-flow', '--apply']).out.code, 'spec_not_approved')
    const draft = cli(f.left, commitArgs()).out
    const receipt = join(gitDirs(f.left.repo).gitDir, 'sdd-ai', 'verify', draft.receipt.id, 'receipt.json')
    const savedReceipt = join(f.scratch, 'receipt.json')
    renameSync(receipt, savedReceipt)
    assert.equal(cli(f.left, commitArgs()).out.code, 'step_not_commit')
    renameSync(savedReceipt, receipt)
    const candidate = join(f.left.repo, 'src/a.ts')
    const code = readFileSync(candidate)
    writeFileSync(candidate, 'export const f = () => 3\n')
    assert.equal(cli(f.left, commitArgs()).out.code, 'step_not_commit')
    writeFileSync(candidate, code)
    const reviewRequest = join(f.left.repo, '.sdd-ai', 'runs', draft.review.id, 'request.json')
    const requestBytes = readFileSync(reviewRequest)
    const request = readJsonFile(reviewRequest)
    delete request.flow
    writeFileSync(reviewRequest, JSON.stringify(request))
    assert.equal(cli(f.left, commitArgs()).out.code, 'review_missing')
    writeFileSync(reviewRequest, requestBytes)
    const reviewStatus = join(f.left.repo, '.sdd-ai', 'runs', draft.review.id, 'status.json')
    const statusBytes = readFileSync(reviewStatus)
    const status = readJsonFile(reviewStatus)
    // Una ronda cancelada no deja la revisión en done: ya no está convergida.
    status.state = 'cancelled'
    writeFileSync(reviewStatus, JSON.stringify(status))
    assert.equal(cli(f.left, commitArgs()).out.code, 'review_missing')
    writeFileSync(reviewStatus, statusBytes)
    assert.equal(git(f.left.repo, 'rev-parse', 'HEAD'), head)
    const lock = legacyReservation(f.left.repo, 'old-commit', 'commit', deadPid())
    releaseMutex(lock)
    const bytes = readFileSync(lock)
    const mutex = readFileSync(`${lock}.release`)
    const plan = join(f.left.repo, '.plans', 'f', 'plan.md')
    const before = readFileSync(plan)
    const allBefore = records(f.left.repo)
    // Cada consulta llega a mirar las reservas: el preview informa la reserva legacy como bloqueo de `new` y el
    // ensayo la nombra. Así la ausencia de escrituras sale del camino normal, no de un fallo temprano.
    const query = cli(f.left, ['sdd', 'branch', 'branch-flow'])
    assert.equal(query.code, 0, JSON.stringify(query.out))
    assert.ok(query.out.exits.some((e: { blockers: { code: string }[] }) => e.blockers.some((b) => b.code === 'writer_open')), JSON.stringify(query.out.exits))
    const dryRun = cli(f.left, commitArgs())
    assert.equal(dryRun.out.code, 'writer_open', JSON.stringify(dryRun.out))
    assert.ok(String(dryRun.out.message).includes('old-commit'))
    assert.deepEqual(readFileSync(lock), bytes)
    assert.deepEqual(readFileSync(plan), before)
    assert.deepEqual(readFileSync(`${lock}.release`), mutex)
    assert.deepEqual(records(f.left.repo), allBefore)
    const restore = join(gitDirs(f.left.repo).gitDir, 'sdd-ai', 'verify', 'restore-intent.json')
    mkdirSync(join(restore, '..'), { recursive: true })
    writeFileSync(restore, JSON.stringify({ receipt: 'pending', checkout: f.left.repo, owner_pid: deadPid(), owner_lstart: null, paths: [] }))
    const pending = readFileSync(restore)
    const pendingRecords = records(f.left.repo)
    const result = cli(f.left, commitArgs())
    assert.equal(result.out.code, 'restore_pending')
    // Con una restauración pendiente, la consulta de branch y el ensayo de start tampoco la ejecutan: los dos
    // responden por el camino normal, sin escribir nada.
    assert.equal(cli(f.left, ['sdd', 'branch', 'branch-flow']).code, 0)
    const started = cli(f.left, ['sdd', 'start', 'another-flow'])
    assert.equal(started.code, 0, JSON.stringify(started.out))
    assert.equal(started.out.flow.state, 'absent')
    assert.deepEqual(readFileSync(restore), pending)
    assert.deepEqual(readFileSync(lock), bytes)
    assert.deepEqual(records(f.left.repo), pendingRecords)
  } finally { await f.close() }
})
