import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCK_FILE } from '../src/sdd/read.ts'
import { alive, cli, deadPid, implement, readJsonFile, storeOf } from './cli-run-fixture.ts'
import { legacyLock, legacyReservation, legacyRun, releaseMutex } from './legacy-reservation-fixture.ts'
import { STALE_DIGEST, arrived, branchFlow, checkoutLock, commitArgs, duplicateFlow, kill, parallelFixture, prepareCommit, refsLock, release, verifyBarrierFlow } from './parallel-worktrees-fixture.ts'

test('los huérfanos de branch y commit conservan su alcance y diagnóstico manual y las liberaciones atrasadas nunca eliminan otra reserva', async () => {
  const f = parallelFixture()
  try {
    const digest = prepareCommit(f.left)
    duplicateFlow(f.left, 'local-verify', f.barrier('never-verify'))
    const verifyGate = f.barrier('foreign-verify')
    verifyBarrierFlow(f.right, verifyGate)
    branchFlow(f.right, 'other')
    const barrier = f.barrier('commit')
    const run = f.launch(f.left, commitArgs(digest), { SDD_TEST_BARRIER: barrier })
    await arrived(barrier)
    kill(run.child.pid!)
    await run.done
    // La primera diferencia contra la base: un huérfano de commit no bloquea otro checkout.
    const writer = await f.writer(f.right, 'allowed')
    assert.equal(existsSync(checkoutLock(f.left)), true)
    assert.equal(existsSync(refsLock(f.left)), true)
    assert.ok(alive(writer.group.pid))
    release(writer.barrier)
    cli(f.right, ['wait', writer.id, '--max', '15'])
    const rejected = cli(f.right, ['sdd', 'branch', 'other', '--apply'])
    assert.equal(rejected.out.code, 'refs_busy', JSON.stringify(rejected.out))
    assert.equal(cli(f.right, commitArgs(STALE_DIGEST)).out.code, 'refs_busy')
    assert.match(rejected.out.next, /hooks.*hijos/)
    assert.ok(rejected.out.detail.includes(refsLock(f.left)))
    assert.ok(rejected.out.detail.includes(checkoutLock(f.left)))
    assert.equal(implement(f.left).out.code, 'refs_busy')
    assert.equal(cli(f.left, ['sdd', 'verify', 'local-verify']).out.code, 'refs_busy')
    const foreignVerify = f.launch(f.right, ['sdd', 'verify', 'f'])
    await arrived(verifyGate)
    assert.ok(alive(foreignVerify.child.pid!))
    release(verifyGate)
    assert.equal((await foreignVerify.done).code, 0)
    const before = readFileSync(refsLock(f.left))
    cli(f.right, ['cancel', readJsonFile(checkoutLock(f.left)).id])
    assert.deepEqual(readFileSync(refsLock(f.left)), before)
    unlinkSync(refsLock(f.left)); unlinkSync(checkoutLock(f.left))
    // El lock del flujo que dejó SIGKILL se limpia aparte, y limpiar no declara completado el commit.
    const flowLock = join(f.left.repo, '.plans', 'f', LOCK_FILE)
    if (existsSync(flowLock)) unlinkSync(flowLock)
    assert.doesNotMatch(readFileSync(join(f.left.repo, '.plans', 'f', 'plan.md'), 'utf8'), /^status: committed$/m)
  } finally { await f.close() }
})

test('un huérfano de branch bloquea branch y commit en todo el repositorio y writer y verify solo en su checkout, y un handle anterior no libera otro token con el mismo id', async () => {
  const orphan = parallelFixture()
  try {
    branchFlow(orphan.left, 'orphan-branch')
    branchFlow(orphan.right, 'contender')
    const localGate = orphan.barrier('local-verify')
    verifyBarrierFlow(orphan.left, localGate)
    const foreignGate = orphan.barrier('foreign-verify')
    verifyBarrierFlow(orphan.right, foreignGate)
    const barrier = orphan.barrier('branch')
    const run = orphan.launch(orphan.left, ['sdd', 'branch', 'orphan-branch', '--apply'], { SDD_TEST_BARRIER: barrier })
    await arrived(barrier)
    kill(run.child.pid!)
    await run.done
    const writer = await orphan.writer(orphan.right, 'allowed')
    assert.equal(implement(orphan.left).out.code, 'refs_busy')
    assert.equal(cli(orphan.left, ['sdd', 'verify', 'f']).out.code, 'refs_busy')
    release(writer.barrier)
    cli(orphan.right, ['wait', writer.id, '--max', '15'])
    // Con el writer del otro checkout ya recibido, lo único que frena a branch y commit allí es la reserva huérfana.
    const conflict = cli(orphan.right, ['sdd', 'branch', 'contender', '--apply'])
    assert.equal(conflict.out.code, 'refs_busy')
    assert.equal(cli(orphan.right, commitArgs(STALE_DIGEST)).out.code, 'refs_busy')
    assert.match(conflict.out.next, /hooks.*hijos/)
    const verifier = orphan.launch(orphan.right, ['sdd', 'verify', 'f'])
    await arrived(foreignGate)
    release(foreignGate)
    assert.equal((await verifier.done).code, 0)
    for (const file of [checkoutLock(orphan.left), refsLock(orphan.left)]) unlinkSync(file)
    const old = await orphan.writer(orphan.right, 'old')
    release(old.barrier)
    cli(orphan.right, ['wait', old.id, '--max', '15'])
    const fresh = await orphan.writer(orphan.right, 'fresh')
    const current = readJsonFile(checkoutLock(orphan.right))
    current.id = old.id
    writeFileSync(checkoutLock(orphan.right), JSON.stringify(current))
    const bytes = readFileSync(checkoutLock(orphan.right))
    cli(orphan.right, ['wait', old.id, '--max', '1'])
    assert.deepEqual(readFileSync(checkoutLock(orphan.right)), bytes, 'un handle anterior no libera otro token con el mismo id')
    assert.ok(alive(fresh.group.pid))
    release(fresh.barrier)
    // La reserva fabricada sigue siendo de otro token; la prueba acredita el cese antes de limpiarla.
    cli(orphan.right, ['wait', fresh.id, '--max', '15'])
    unlinkSync(checkoutLock(orphan.right))
  } finally { await orphan.close() }
})

test('las reservas ilegibles o de cese incierto se conservan y explican el bloqueo', async () => {
  const opaque = parallelFixture()
  try {
    branchFlow(opaque.right, 'contender')
    const completed = await opaque.writer(opaque.left, 'identity')
    const identity = readJsonFile(checkoutLock(opaque.left))
    release(completed.barrier)
    cli(opaque.left, ['wait', completed.id, '--max', '15'])
    writeFileSync(refsLock(opaque.left), '{unreadable')
    const bytes = readFileSync(refsLock(opaque.left))
    assert.equal(cli(opaque.right, ['sdd', 'branch', 'contender', '--apply']).out.code, 'refs_busy')
    const allowed = await opaque.writer(opaque.right, 'opaque-refs')
    release(allowed.barrier)
    cli(opaque.right, ['wait', allowed.id, '--max', '15'])
    assert.deepEqual(readFileSync(refsLock(opaque.left)), bytes)
    unlinkSync(refsLock(opaque.left))
    writeFileSync(checkoutLock(opaque.left), '{unreadable')
    assert.equal(implement(opaque.left).out.code, 'writer_open')
    assert.equal(readFileSync(checkoutLock(opaque.left), 'utf8'), '{unreadable')
    unlinkSync(checkoutLock(opaque.left))
    for (const domain of ['checkout', 'refs']) {
      const path = domain === 'checkout' ? checkoutLock(opaque.left) : refsLock(opaque.left)
      writeFileSync(path, JSON.stringify({ ...identity, path, domain, kind: 'commit', id: 'commit-uncertain', pid: process.pid, lstart: null }))
    }
    const retained = readFileSync(refsLock(opaque.left))
    const uncertain = cli(opaque.right, ['sdd', 'branch', 'contender', '--apply'])
    assert.equal(uncertain.out.code, 'refs_busy')
    assert.match(uncertain.out.detail, /no se pudo acreditar/)
    assert.match(uncertain.out.next, /comprueba.*hooks.*hijos/)
    assert.deepEqual(readFileSync(refsLock(opaque.left)), retained)
    // Son identidades fabricadas: no representan una aplicación ni hijos pendientes.
    unlinkSync(checkoutLock(opaque.left)); unlinkSync(refsLock(opaque.left))
  } finally { await opaque.close() }
})

test('con el mutex de liberación tomado por un proceso vivo la liberación de una reserva no la borra', async () => {
  const f = parallelFixture()
  try {
    const id = 'legacy-mutex'
    legacyRun(f.left, id)
    const lock = legacyReservation(f.left.repo, id)
    const before = readFileSync(lock)
    releaseMutex(lock)
    const wait = cli(f.left, ['wait', id, '--max', '1'])
    assert.equal(existsSync(lock), true, 'el mutex vivo conserva la reserva')
    assert.deepEqual(readFileSync(lock), before)
    assert.match(wait.stderr, /release_busy/)
    unlinkSync(`${lock}.release`)
    cli(f.left, ['wait', id, '--max', '1'])
    assert.equal(existsSync(lock), false)
  } finally { await f.close() }
})

test('con un mutex de liberación abandonado lanzar un writer en ese checkout se rechaza con release_abandoned y la ruta del mutex', async () => {
  const f = parallelFixture()
  try {
    releaseMutex(checkoutLock(f.left), deadPid())
    const result = implement(f.left)
    assert.equal(result.out.code, 'release_abandoned', JSON.stringify(result.out))
    assert.ok(result.out.message.includes(`${checkoutLock(f.left)}.release`))
    unlinkSync(`${checkoutLock(f.left)}.release`)
    const writer = await f.writer(f.left, 'retry')
    release(writer.barrier)
  } finally { await f.close() }
})
