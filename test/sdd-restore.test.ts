import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import {
  type RestoreIntent, closeRestoreIntent, inspectRevertPaths, prepareIntent, recoverPendingRestore, restoreIntentOpen, revertPaths,
  writeRestoreIntent,
} from '../src/sdd/restore.ts'
import type { TestRow } from '../src/sdd/verification-contract.ts'
import { SddError } from '../src/types.ts'
import { readReservation, recordVerifyGroup, releaseOrphanVerifyReservation, reserveWriter, storeRoot } from '../src/writer-store.ts'
import { makeRepo } from './helpers.ts'

const gitIn = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

function repoWith(files: Record<string, string | Buffer>): { repo: string; base: string } {
  const repo = makeRepo()
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  return { repo, base: gitIn(repo, 'rev-parse', 'HEAD') }
}

const row = (implementation_paths: string[], test_paths = ['test/a.test.ts']): TestRow => ({
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert', argv: ['node'], timeout_ms: 1000, expect: { exit_code: 0 },
  implementation_paths, test_paths, test_name: 'x', report_format: 'tap',
})

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof SddError) return e.code
    throw e
  }
  return 'ok'
}

/** Un pid que ya terminó: el de un proceso que se lanzó y se esperó. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number

test('una fila es confirmable solo con archivos de texto modificados, presentes en los dos lados y propios', () => {
  const { repo, base } = repoWith({
    'src/a.ts': 'a\n', 'src/same.ts': 's\n', 'src/mode.ts': 'm\n', 'src/gone.ts': 'g\n', 'src/old.ts': 'o\n',
    'src/bin.dat': Buffer.from([1, 0, 2]), 'test/a.test.ts': 't\n', 'src/link.ts': 'l\n',
  })
  writeFileSync(join(repo, 'src/a.ts'), 'a2\n')
  chmodSync(join(repo, 'src/mode.ts'), 0o755)
  unlinkSync(join(repo, 'src/gone.ts'))
  gitIn(repo, 'mv', 'src/old.ts', 'src/renamed.ts')
  writeFileSync(join(repo, 'src/bin.dat'), Buffer.from([1, 0, 3]))
  writeFileSync(join(repo, 'src/new.ts'), 'n\n')
  unlinkSync(join(repo, 'src/link.ts'))
  symlinkSync('/etc/hosts', join(repo, 'src/link.ts'))

  assert.deepEqual(inspectRevertPaths(repo, base, row(['src/a.ts'])), { eligible: true })
  const cases: Array<[string[], string[] | undefined, RegExp]> = [
    [['src/new.ts'], undefined, /es nueva en el cambio/],
    [['test/a.test.ts'], undefined, /es también una ruta de la prueba/],
    [['src/gone.ts'], undefined, /fue borrada o renombrada/],
    [['src/old.ts'], undefined, /fue borrada o renombrada/],
    [['src/renamed.ts'], undefined, /es nueva en el cambio/],
    [['src/mode.ts'], undefined, /solo cambió de modo/],
    [['src/same.ts'], undefined, /no cambió respecto de la base/],
    [['src/bin.dat'], undefined, /es binaria/],
    [['src/link.ts'], undefined, /es un enlace/],
    // Todas se validan antes de tocar ninguna: una ruta mala invalida la fila entera.
    [['src/a.ts', 'src/new.ts'], undefined, /src\/new.ts es nueva/],
  ]
  for (const [paths, tests, reason] of cases) {
    const r = inspectRevertPaths(repo, base, row(paths, tests))
    assert.equal(r.eligible, false, paths.join())
    if (!r.eligible) assert.match(r.reason, reason, paths.join())
  }
  assert.equal(readFileSync(join(repo, 'src/a.ts'), 'utf8'), 'a2\n')
})

/** Un repo con dos rutas cambiadas y la intención de revertirlas, escrita por un dueño que ya murió. */
function withIntent(): { repo: string; base: string; intent: RestoreIntent } {
  const { repo, base } = repoWith({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' })
  writeFileSync(join(repo, 'src/a.ts'), 'a2\n')
  writeFileSync(join(repo, 'src/b.ts'), 'b2\n')
  chmodSync(join(repo, 'src/b.ts'), 0o755)
  const intent = { ...prepareIntent(repo, '20260929-1500-aaaa', base, ['src/a.ts', 'src/b.ts']), owner_pid: deadPid(), owner_lstart: null }
  writeRestoreIntent(repo, intent)
  return { repo, base, intent }
}

const content = (repo: string) => [readFileSync(join(repo, 'src/a.ts'), 'utf8'), readFileSync(join(repo, 'src/b.ts'), 'utf8')]

test('la recuperación restaura cada estado intermedio de una interrupción y es repetible', () => {
  const states: Array<[string, (repo: string, intent: RestoreIntent) => void]> = [
    ['recién escrita, sin revertir', () => {}],
    ['una revertida y otra no', (repo) => writeFileSync(join(repo, 'src/a.ts'), 'a\n')],
    ['todas revertidas', (repo, intent) => revertPaths(repo, intent)],
    ['restauración a medias', (repo, intent) => {
      revertPaths(repo, intent)
      writeFileSync(join(repo, 'src/a.ts'), 'a2\n')
    }],
  ]
  for (const [name, setup] of states) {
    const { repo, intent } = withIntent()
    setup(repo, intent)
    assert.deepEqual(recoverPendingRestore(repo, 'blocking'), { state: 'restored' }, name)
    assert.deepEqual(content(repo), ['a2\n', 'b2\n'], name)
    assert.equal(statSync(join(repo, 'src/b.ts')).mode & 0o777, 0o755, name)
    assert.equal(restoreIntentOpen(repo), false, name)
    // Una segunda recuperación no encuentra nada.
    assert.deepEqual(recoverPendingRestore(repo, 'blocking'), { state: 'none' }, name)
  }
})

test('una ruta con un tercer contenido o convertida en enlace frena la recuperación sin tocar ninguna', () => {
  for (const edit of [
    (repo: string) => writeFileSync(join(repo, 'src/a.ts'), 'editado a mano\n'),
    (repo: string) => {
      unlinkSync(join(repo, 'src/a.ts'))
      symlinkSync('/etc/hosts', join(repo, 'src/a.ts'))
    },
  ]) {
    const { repo, intent } = withIntent()
    revertPaths(repo, intent)
    edit(repo)
    const before = readFileSync(join(repo, 'src/b.ts'), 'utf8')
    assert.equal(codeOf(() => recoverPendingRestore(repo, 'blocking')), 'restore_conflict')
    assert.equal(readFileSync(join(repo, 'src/b.ts'), 'utf8'), before)
    assert.equal(restoreIntentOpen(repo), true)
  }
})

test('la intención de otro checkout se ignora y la de un dueño vivo solo se informa o detiene', () => {
  const other = withIntent()
  writeRestoreIntent(other.repo, { ...other.intent, checkout: '/otro/checkout' })
  assert.deepEqual(recoverPendingRestore(other.repo, 'blocking'), { state: 'none' })
  assert.equal(restoreIntentOpen(other.repo), true)

  const alive = withIntent()
  writeRestoreIntent(alive.repo, { ...alive.intent, owner_pid: process.pid, owner_lstart: null })
  assert.deepEqual(recoverPendingRestore(alive.repo, 'non_blocking'), { state: 'in_progress' })
  assert.equal(codeOf(() => recoverPendingRestore(alive.repo, 'blocking')), 'verify_in_progress')
  closeRestoreIntent(alive.repo)
})

test('un lock de recuperación huérfano no se roba: pide borrarlo a mano', () => {
  const { repo } = withIntent()
  const lock = join(gitDirs(repo).gitDir, 'sdd-ai', 'verify', 'restore.lock')
  writeFileSync(lock, `${JSON.stringify({ pid: deadPid(), lstart: null })}\n`)
  try {
    recoverPendingRestore(repo, 'blocking')
    assert.fail('se esperaba recovery_busy')
  } catch (e) {
    assert.ok(e instanceof SddError)
    assert.equal(e.code, 'recovery_busy')
    assert.ok(e.next?.includes(lock))
  }
  assert.equal(restoreIntentOpen(repo), true)
  unlinkSync(lock)
  assert.deepEqual(recoverPendingRestore(repo, 'blocking'), { state: 'restored' })
})

test('la recuperación libera la reserva de una verificación muerta y nunca la de un writer', () => {
  const { repo } = repoWith({ 'a.txt': 'a\n' })
  const lock = join(storeRoot(repo), 'writer.lock')
  // Una verificación viva conserva su reserva, aunque no haya intención.
  assert.deepEqual(reserveWriter(repo, '20260929-1500-aaaa', 'verify'), { ok: true })
  recoverPendingRestore(repo, 'blocking')
  assert.equal(readReservation(repo)?.kind, 'verify')
  // Muerta, se libera sin intención de por medio.
  writeFileSync(lock, `${JSON.stringify({ ...readReservation(repo), pid: deadPid(), lstart: null })}\n`)
  recoverPendingRestore(repo, 'non_blocking')
  assert.equal(existsSync(lock), false)
  // La de un writer, viva o muerta, no se toca.
  assert.deepEqual(reserveWriter(repo, '20260929-1501-bbbb'), { ok: true })
  writeFileSync(lock, `${JSON.stringify({ ...readReservation(repo), pid: deadPid(), lstart: null })}\n`)
  recoverPendingRestore(repo, 'blocking')
  assert.equal(readReservation(repo)?.id, '20260929-1501-bbbb')
  // Con una verificación reservada, otro writer recibe quién la tiene.
  unlinkSync(lock)
  reserveWriter(repo, '20260929-1502-cccc', 'verify')
  assert.deepEqual(reserveWriter(repo, '20260929-1503-dddd'), { ok: false, holder: 'la verificación 20260929-1502-cccc', verify: true })
})

test('el revert no pisa una ruta que cambió después de guardar su contenido, y entonces no toca ninguna', () => {
  const { repo, intent } = withIntent()
  writeFileSync(join(repo, 'src/b.ts'), 'editado a mano\n')
  assert.deepEqual(revertPaths(repo, intent), ['src/b.ts'])
  assert.deepEqual(content(repo), ['a2\n', 'editado a mano\n'])
  // Un cambio de modo también es una edición: no se revierte ni se pierde en la restauración.
  const other = withIntent()
  chmodSync(join(other.repo, 'src/b.ts'), 0o644)
  assert.deepEqual(revertPaths(other.repo, other.intent), ['src/b.ts'])
  assert.deepEqual(content(other.repo), ['a2\n', 'b2\n'])
  assert.equal(statSync(join(other.repo, 'src/b.ts')).mode & 0o777, 0o644)
})

/** Un grupo de procesos vivo, como el que deja una fila de verify: su líder es el pgid. */
function liveGroup(): { pgid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  return { pgid: child.pid as number, stop: async () => {
    process.kill(-(child.pid as number), 'SIGKILL')
    await exited
  } }
}

test('con el dueño muerto y la fila todavía corriendo en su grupo, ni la reserva ni la restauración se liberan', async () => {
  const { repo, intent } = withIntent()
  revertPaths(repo, intent)
  const lock = join(storeRoot(repo), 'writer.lock')
  assert.deepEqual(reserveWriter(repo, intent.receipt, 'verify'), { ok: true })
  const group = liveGroup()
  try {
    recordVerifyGroup(repo, intent.receipt, group.pgid)
    writeFileSync(lock, `${JSON.stringify({ ...readReservation(repo), pid: deadPid(), lstart: null })}\n`)
    assert.equal(releaseOrphanVerifyReservation(repo), false)
    assert.deepEqual(recoverPendingRestore(repo, 'non_blocking'), { state: 'in_progress' })
    assert.equal(codeOf(() => recoverPendingRestore(repo, 'blocking')), 'verify_in_progress')
    // Nada se restauró mientras la fila sigue viva.
    assert.deepEqual(content(repo), ['a\n', 'b\n'])
  } finally {
    await group.stop()
  }
  assert.deepEqual(recoverPendingRestore(repo, 'blocking'), { state: 'restored' })
  assert.deepEqual(content(repo), ['a2\n', 'b2\n'])
  assert.equal(existsSync(lock), false)
})

test('la reserva anota el grupo de la fila en curso y lo quita al terminarla', () => {
  const { repo } = repoWith({ 'a.txt': 'a\n' })
  reserveWriter(repo, '20260929-1500-aaaa', 'verify')
  recordVerifyGroup(repo, '20260929-1500-aaaa', 4242)
  assert.equal(readReservation(repo)?.group, 4242)
  // La de otra corrida no se toca.
  recordVerifyGroup(repo, '20260929-1501-bbbb', 99)
  assert.equal(readReservation(repo)?.group, 4242)
  recordVerifyGroup(repo, '20260929-1500-aaaa', null)
  assert.equal(readReservation(repo)?.group, undefined)
  assert.equal(readReservation(repo)?.kind, 'verify')
})
