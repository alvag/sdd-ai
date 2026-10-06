import { test } from 'node:test'
import assert from 'node:assert/strict'

// Estos tests llaman al binario en el mismo proceso y no prueban la publicación de la proyección: se apaga, como hace
// `npm test`, también cuando el archivo corre suelto (las filas de verify). Así ningún publicador en segundo plano
// escribe en el directorio temporal mientras la fixture lo borra.
process.env.SDD_AI_PROJECTION = 'off'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { authorizeTerminalReceipt } from '../src/notification.ts'
import { runOpenness } from '../src/open-runs.ts'
import { notificationFixture } from './notification-fixture.ts'
import { fixtureJson } from './projection-fixture.ts'
import { SIGNAL_TTL_MS } from '../mods/sdd-ai/hooks/notification.ts'

const owner = { family: 'claude' as const, session: 'owner' }
const fallback = { family: 'claude' as const, session: 'fallback' }
const other = { family: 'claude' as const, session: 'other' }

test('terminal worker and review receipts admit the legitimate fallback after successful reads', async () => {
  const f = notificationFixture()
  try {
    f.flow('flow')
    f.binding(fallback.session, 'flow')
    f.binding(other.session, 'other-flow')
    f.signalFor(fallback)
    // La sesión ajena tiene señal vigente: si la recibe, es solo porque está ligada a otro flujo.
    f.signalFor(other)
    for (const state of ['done', 'failed', 'cancelled', 'timeout', 'launch_failed'] as const) {
      const id = `worker-${state}`
      const dir = f.run(id, { session: owner.session, conductor: { family: owner.family }, flow: 'flow' }, state)
      writeFileSync(join(dir, 'result.md'), 'Resultado terminal.\n')
      const alien = await main(['wait', id, '--max', '0'], f.envFor(other), f.root)
      assert.equal(alien.code, state === 'done' ? 0 : 1)
      assert.equal(existsSync(join(dir, 'delivered.json')), false)
      // Cada consulta legítima renueva la señal, como el mod cada segundo: el test no depende del reloj real.
      f.signalFor(fallback)
      const result = await main(['wait', id, '--max', '0'], f.envFor(fallback), f.root)
      assert.equal(result.code, state === 'done' ? 0 : 1)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'delivered.json'), 'utf8')), { round: null, launch: null })
    }
    for (const state of ['done', 'failed'] as const) {
      const id = `review-${state}`
      const dir = f.review(id, state)
      const before = readFileSync(join(dir, 'ledger.json'), 'utf8')
      await main(['review', 'status', id], f.envFor(other), f.root)
      assert.equal(existsSync(join(dir, 'delivered.json')), false)
      f.signalFor(fallback)
      const result = await main(['review', 'status', id], f.envFor(fallback), f.root)
      assert.equal(result.code, state === 'done' ? 0 : 1)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'delivered.json'), 'utf8')), { round: 1, launch: 1 })
      assert.equal(readFileSync(join(dir, 'ledger.json'), 'utf8'), before)
      assert.equal(runOpenness(f.root, id)?.open, 'review_pending')
      fixtureJson(join(dir, 'status.json'), { state, round: 1, launch: 2 })
      assert.equal(runOpenness(f.root, id)?.open, 'undelivered')
      f.signalFor(fallback)
      await main(['wait', id, '--max', '0'], f.envFor(fallback), f.root)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'delivered.json'), 'utf8')), { round: 1, launch: 2 })
    }
  } finally { f.dispose() }
})

test('receipt authorization preserves owners and admits only unique live or degraded flow recipients', () => {
  const f = notificationFixture()
  const authorize = (env = f.envFor(fallback)) => authorizeTerminalReceipt(f.root, 'run', owner, env)
  try {
    f.flow('flow')
    f.run('run', { session: owner.session, conductor: { family: owner.family }, flow: 'flow' }, 'done')
    // La dueña siempre recibe, con mod o sin él.
    assert.equal(authorize(f.envFor(owner)), true)
    // Caso (a), selección: la única operativa ligada al flujo, con la dueña sin señal.
    f.binding(fallback.session, 'flow')
    f.signalFor(fallback)
    assert.equal(authorize(), true)
    assert.equal(authorize({ ...f.envFor(fallback), SDD_AI_WORKER: '1' }), false)
    assert.equal(authorize({ ...f.envFor(fallback), CODEX_THREAD_ID: 'thread', CODEX_SESSION_ID: 'codex' }), false)
    // La dueña operativa conserva la prioridad: el relevo no recibe.
    f.signalFor(owner)
    assert.equal(authorize(), false)
    // Dueña degradada: vuelve el caso (a).
    f.signalFor(owner, { operational: false })
    assert.equal(authorize(), true)
    // Caso (a) con otra ligada degradada: la operativa sigue siendo la única seleccionada.
    f.binding(other.session, 'flow')
    const third = f.signalFor(other, { operational: false })
    assert.equal(authorize(), true)
    // Dos operativas ligadas: ambigüedad, nadie recibe como relevo.
    f.signalFor(other)
    assert.equal(authorize(), false)
    rmSync(third)
    // Caso (b), recuperación: ninguna operativa y una sola ligada con señal vigente, degradada.
    f.signalFor(fallback, { operational: false })
    assert.equal(authorize(), true)
    // Caso (b) con dos ligadas degradadas: no hay una sola.
    f.signalFor(other, { operational: false })
    assert.equal(authorize(), false)
    rmSync(third)
    // Sin señal vigente no hay relevo.
    f.signalFor(fallback, { updated_at: Date.now() - SIGNAL_TTL_MS - 1000 })
    assert.equal(authorize(), false)
    f.signalFor(fallback)
    writeFileSync(join(f.root, '.sdd-ai', 'hooks', 'route', 'other.json'), '{')
    assert.equal(authorize(), false)
    rmSync(join(f.root, '.sdd-ai', 'hooks', 'route', 'other.json'))
    f.flow('broken')
    writeFileSync(join(f.root, '.plans', 'broken', 'sdd-ai-phases.json'), '{')
    assert.equal(authorize(), false)
    assert.equal(authorize(f.envFor(owner)), true)
  } finally { f.dispose() }
})

test('nonterminal and unreadable responses never close a receipt', async () => {
  const f = notificationFixture()
  try {
    f.flow('flow'); f.binding(fallback.session, 'flow'); f.signalFor(fallback)
    const running = f.run('running', { session: owner.session, conductor: { family: owner.family }, flow: 'flow' })
    assert.equal((await main(['wait', 'running', '--max', '0'], f.envFor(fallback), f.root)).code, 3)
    assert.equal(existsSync(join(running, 'delivered.json')), false)
    const broken = f.run('broken', { session: owner.session, conductor: { family: owner.family }, flow: 'flow' }, 'done')
    await assert.rejects(main(['wait', 'broken', '--max', '0'], f.envFor(fallback), f.root))
    assert.equal(existsSync(join(broken, 'delivered.json')), false)
    const review = f.review('review', 'running')
    await main(['review', 'status', 'review'], f.envFor(fallback), f.root)
    assert.equal(existsSync(join(review, 'delivered.json')), false)
    fixtureJson(join(review, 'status.json'), { state: 'done', round: 1, launch: 1 })
    writeFileSync(join(review, 'candidate.json'), '{')
    await assert.rejects(main(['review', 'status', 'review'], f.envFor(fallback), f.root))
    assert.equal(existsSync(join(review, 'delivered.json')), false)
  } finally { f.dispose() }
})

test('a request larger than a signal still authorizes the legitimate fallback', () => {
  const f = notificationFixture()
  try {
    f.flow('flow'); f.binding(fallback.session, 'flow'); f.signalFor(fallback)
    // El request de una corrida puede traer su encargo: el límite de una señal (64 KiB) no aplica.
    const dir = f.run('large', { session: owner.session, conductor: { family: owner.family }, flow: 'flow', prompt: 'x'.repeat(200 * 1024) }, 'done')
    assert.ok(readFileSync(join(dir, 'request.json')).length > 64 * 1024)
    assert.equal(authorizeTerminalReceipt(f.root, 'large', owner, f.envFor(fallback)), true)
  } finally { f.dispose() }
})
