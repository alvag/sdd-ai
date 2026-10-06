import { test } from 'node:test'
import assert from 'node:assert/strict'

// Estos tests llaman al binario en el mismo proceso y no prueban la publicación de la proyección: se apaga, como hace
// `npm test`, también cuando el archivo corre suelto (las filas de verify). Así ningún publicador en segundo plano
// escribe en el directorio temporal mientras la fixture lo borra.
process.env.SDD_AI_PROJECTION = 'off'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runHook } from '../src/hooks.ts'
import { readNotificationSignal, readNotificationSignals } from '../src/notification.ts'
import { SIGNAL_TTL_MS } from '../mods/sdd-ai/hooks/notification.ts'
import { notificationFixture } from './notification-fixture.ts'
import { payload } from './hook-contract.ts'
import { diffInventory, sensitiveInventory, sensitiveInventoryV2 } from '../src/writer-store.ts'

test('Stop suppresses only a live Claude notifier and preserves unconsumed reminders', () => {
  const f = notificationFixture()
  const owner = { family: 'claude' as const, session: 'owner' }
  const stop = (cli: 'claude' | 'codex' = 'claude') => runHook(JSON.stringify(payload(cli, 'stop', { cwd: f.root, session_id: owner.session })), cli)
  try {
    f.run('run', { session: owner.session, conductor: { family: owner.family } }, 'done')
    const path = f.signalFor(owner)
    assert.equal(readNotificationSignal(f.root, owner, Date.now()).kind, 'live')
    assert.equal(stop(), '')
    assert.equal(existsSync(join(f.root, '.sdd-ai', 'hooks', 'owner.json')), false)
    f.signalFor(owner, { operational: false })
    assert.notEqual(stop(), '')
    assert.equal(stop(), '')
    rmSync(join(f.root, '.sdd-ai', 'hooks', 'owner.json'))
    f.signalFor(owner, { updated_at: Date.now() - SIGNAL_TTL_MS - 1 })
    assert.notEqual(stop(), '')
    rmSync(join(f.root, '.sdd-ai', 'hooks', 'owner.json'))
    f.signalFor(owner)
    assert.notEqual(stop('codex'), '')
    // Ni siquiera una señal de Codex vigente y operativa calla a Stop en Codex: Codex no tiene avisador.
    rmSync(join(f.root, '.sdd-ai', 'hooks', 'owner.json'), { force: true })
    f.signalFor({ family: 'codex', session: owner.session })
    assert.equal(readNotificationSignal(f.root, { family: 'codex', session: owner.session }, Date.now()).kind, 'live')
    assert.notEqual(stop('codex'), '')
    rmSync(path)
    assert.equal(readNotificationSignal(f.root, owner, Date.now()).kind, 'inactive')
  } finally { f.dispose() }
})

test('signal readers reject links invalid identities and mismatched or expired clocks', () => {
  const f = notificationFixture()
  const owner = { family: 'claude' as const, session: 'owner' }
  const read = () => readNotificationSignal(f.root, owner, Date.now())
  try {
    const path = f.signalFor(owner)
    utimesSync(path, new Date(0), new Date(0))
    assert.equal(read().kind, 'inactive')
    f.signalFor(owner, { checkout: { ...f.checkout, root: '/other' } })
    assert.equal(read().kind, 'unknown')
    writeFileSync(path, '{')
    assert.equal(read().kind, 'unknown')
    assert.equal(readNotificationSignals(f.root, Date.now()).complete, false)
    rmSync(path)
    symlinkSync(join(f.scratch, 'absent'), path)
    assert.equal(read().kind, 'unknown')
    rmSync(path)
    mkdirSync(path)
    assert.equal(read().kind, 'unknown')
    rmSync(path, { recursive: true })
    const directory = join(f.root, '.sdd-ai', 'hooks', 'notifications')
    rmSync(directory, { recursive: true })
    symlinkSync(f.scratch, directory)
    assert.equal(read().kind, 'unknown')
    assert.equal(readNotificationSignal(f.root, { ...owner, session: '../escape' }, Date.now()).kind, 'unknown')
  } finally { f.dispose() }
})

test('operational Stop leaves a changed flow binding untouched until the notifier expires', () => {
  const f = notificationFixture()
  const owner = { family: 'claude' as const, session: 'owner' }
  const stop = (active = false) => runHook(JSON.stringify(payload('claude', 'stop', { cwd: f.root, session_id: owner.session, stop_hook_active: active })), 'claude')
  try {
    f.flow('flow'); f.binding(owner.session, 'flow'); f.signalFor(owner)
    const path = join(f.root, '.sdd-ai', 'hooks', 'route', 'owner.json')
    const before = readFileSync(path, 'utf8')
    assert.equal(stop(), '')
    assert.equal(readFileSync(path, 'utf8'), before)
    f.signalFor(owner, { updated_at: Date.now() - SIGNAL_TTL_MS - 1000 })
    assert.equal(stop(true), '')
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.notEqual(stop(), '')
    assert.equal(stop(), '')
  } finally { f.dispose() }
})

for (const segments of [['.sdd-ai'], ['.sdd-ai', 'hooks'], ['.sdd-ai', 'hooks', 'notifications']]) {
  test(`signal reader rejects a linked directory at ${segments.join('/')}`, () => {
    const f = notificationFixture()
    const owner = { family: 'claude' as const, session: 'owner' }
    try {
      f.signalFor(owner)
      const path = join(f.root, ...segments)
      const moved = join(f.scratch, 'moved')
      renameSync(path, moved)
      symlinkSync(moved, path)
      assert.equal(readNotificationSignal(f.root, owner, Date.now()).kind, 'unknown')
      assert.equal(readNotificationSignals(f.root, Date.now()).complete, false)
    } finally { f.dispose() }
  })
}

test('signal inventories distinguish missing entries from unreadable identities and both expired clocks', () => {
  const f = notificationFixture()
  const owner = { family: 'claude' as const, session: 'owner' }
  try {
    assert.deepEqual(readNotificationSignals(f.root, Date.now()), { items: [], complete: true })
    for (const session of ['', '.', '..', '../outside', 'a/b', 'x'.repeat(129)]) {
      assert.equal(readNotificationSignal(f.root, { ...owner, session }, Date.now()).kind, 'unknown')
    }
    f.signalFor(owner, { updated_at: Date.now() + 60000 })
    assert.equal(readNotificationSignal(f.root, owner, Date.now()).kind, 'unknown')
    const path = f.signalFor(owner, { updated_at: Date.now() - 6000 })
    utimesSync(path, new Date(), new Date())
    assert.equal(readNotificationSignal(f.root, owner, Date.now()).kind, 'inactive')
    f.signalFor(owner)
    utimesSync(path, new Date(0), new Date(0))
    assert.equal(readNotificationSignal(f.root, owner, Date.now()).kind, 'inactive')
    f.signalFor(owner)
    const directory = join(f.root, '.sdd-ai', 'hooks', 'notifications')
    // Un archivo que no es una señal (un .DS_Store de Finder, otra familia) no deja el inventario incompleto.
    writeFileSync(join(directory, 'unknown-family-owner.json'), '{}')
    writeFileSync(join(directory, '.DS_Store'), 'x')
    assert.equal(readNotificationSignals(f.root, Date.now()).complete, true)
    rmSync(join(directory, 'unknown-family-owner.json'))
    rmSync(join(directory, '.DS_Store'))
    // Un nombre de señal con una sesión inválida sí lo deja incompleto.
    writeFileSync(join(directory, 'claude-a b.json'), '{}')
    assert.equal(readNotificationSignals(f.root, Date.now()).complete, false)
    rmSync(join(directory, 'claude-a b.json'))
    // Una señal truncada pesa mientras su fecha está vigente y deja de pesar cuando vence.
    const truncated = join(directory, 'claude-truncated.json')
    writeFileSync(truncated, '{"schema_version":')
    assert.equal(readNotificationSignal(f.root, { family: 'claude', session: 'truncated' }, Date.now()).kind, 'unknown')
    assert.equal(readNotificationSignals(f.root, Date.now()).complete, false)
    utimesSync(truncated, new Date(0), new Date(0))
    assert.equal(readNotificationSignal(f.root, { family: 'claude', session: 'truncated' }, Date.now()).kind, 'inactive')
    assert.equal(readNotificationSignals(f.root, Date.now()).complete, true)
    rmSync(truncated)
    f.signalFor(owner, { session: 'foreign' })
    assert.equal(readNotificationSignal(f.root, owner, Date.now()).kind, 'unknown')
    assert.equal(readNotificationSignals(f.root, Date.now()).complete, false)
  } finally { f.dispose() }
})

test('own notifier signals stay outside both protected writer sensitive inventories', () => {
  const f = notificationFixture()
  try {
    const writer = f.writer('writer', 'running', 'owner')
    const before = sensitiveInventory(f.root, writer.control.checkout)
    const beforeV2 = sensitiveInventoryV2(f.root, writer.control.checkout)
    f.signalFor({ family: 'claude', session: 'owner' })
    assert.deepEqual(diffInventory(before, sensitiveInventory(f.root, writer.control.checkout)), [])
    assert.deepEqual(diffInventory(beforeV2, sensitiveInventoryV2(f.root, writer.control.checkout)), [])
  } finally { f.dispose() }
})
