import { test } from 'node:test'
import assert from 'node:assert/strict'

// Estos tests llaman al binario en el mismo proceso y no prueban la publicación de la proyección: se apaga, como hace
// `npm test`, también cuando el archivo corre suelto (las filas de verify). Así ningún publicador en segundo plano
// escribe en el directorio temporal mientras la fixture lo borra.
process.env.SDD_AI_PROJECTION = 'off'
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { notificationFixture } from './notification-fixture.ts'
import { fixtureJson } from './projection-fixture.ts'
import { runOpenness } from '../src/open-runs.ts'

const fallback = { family: 'claude' as const, session: 'fallback' }
/** Como root los permisos no impiden escribir, y los casos que simulan un almacén no escribible no aplican. */
const asRoot = process.getuid?.() === 0
const other = { family: 'claude' as const, session: 'other' }
const harvest = (base: string, store: string) => ({ state: 'done', base, tree: base, files: [], patchFile: join(store, 'diff.patch'),
  flagged: [], runAltered: [], headMoved: false, endMark: true })

test('writer fallback receipt preserves protected harvest and delivery path checks', async () => {
  const f = notificationFixture()
  try {
    f.flow('flow'); f.binding(fallback.session, 'flow'); f.signalFor(fallback)
    const writer = f.writer('writer', 'done', 'owner', 'flow')
    fixtureJson(join(writer.store, 'harvest.json'), harvest(f.base, writer.store))
    fixtureJson(join(writer.run, 'request.json'), { session: other.session, conductor: { family: other.family }, flow: 'flow' })
    const frozen = readFileSync(join(writer.store, 'harvest.json'), 'utf8')
    await main(['wait', 'writer', '--max', '0'], f.envFor(other), f.root)
    assert.equal(existsSync(join(writer.store, 'delivered.json')), false)
    // Cada consulta legítima renueva la señal, como el mod cada segundo: el test no depende del reloj real.
    f.signalFor(fallback)
    await main(['wait', 'writer', '--max', '0'], f.envFor(fallback), f.root)
    assert.deepEqual(JSON.parse(readFileSync(join(writer.store, 'delivered.json'), 'utf8')), { round: null, launch: null })
    assert.equal(readFileSync(join(writer.store, 'harvest.json'), 'utf8'), frozen)
    assert.equal(existsSync(join(writer.run, 'delivered.json')), false)
    // La imposibilidad de escribir el almacén conserva el fallback físico de la cosecha congelada. Como root, los
    // permisos no impiden escribir: ese caso no se puede simular así y se omite.
    if (!asRoot) {
      const visible = f.writer('visible', 'done', 'owner', 'flow')
      fixtureJson(join(visible.store, 'harvest.json'), harvest(f.base, visible.store))
      chmodSync(visible.store, 0o555)
      try {
        f.signalFor(fallback)
        await main(['wait', 'visible', '--max', '0'], f.envFor(fallback), f.root)
        assert.deepEqual(JSON.parse(readFileSync(join(visible.run, 'delivered.json'), 'utf8')), { round: null, launch: null })
      } finally { chmodSync(visible.store, 0o755) }
    }
    const broken = f.writer('broken', 'done', 'owner', 'flow')
    fixtureJson(join(broken.store, 'harvest.json'), { ...harvest(f.base, broken.store), files: null })
    f.signalFor(fallback)
    await assert.rejects(main(['wait', 'broken', '--max', '0'], f.envFor(fallback), f.root))
    assert.equal(existsSync(join(broken.store, 'delivered.json')), false)
    assert.equal(existsSync(join(broken.run, 'delivered.json')), false)
    const uncertain = f.writer('uncertain', 'cessation_uncertain', 'owner', 'flow')
    f.signalFor(fallback)
    assert.equal((await main(['wait', 'uncertain', '--max', '0'], f.envFor(fallback), f.root)).code, 1)
    assert.equal(existsSync(join(uncertain.store, 'harvest.json')), false)
    // El cese incierto no se recibe: ni en el almacén ni en la corrida visible, y sigue sin presentarse como entregado.
    assert.equal(existsSync(join(uncertain.store, 'delivered.json')), false)
    assert.equal(existsSync(join(uncertain.run, 'delivered.json')), false)
    assert.notEqual(runOpenness(f.root, 'uncertain')?.open, 'undelivered')
    if (!asRoot) {
      // La corrida visible es un enlace a la de otro writer: el fallback no puede seguirlo ni escribir el recibo ajeno.
      const linked = f.writer('linked', 'done', 'owner', 'flow')
      fixtureJson(join(linked.store, 'harvest.json'), harvest(f.base, linked.store))
      rmSync(linked.run, { recursive: true })
      symlinkSync(writer.run, linked.run)
      chmodSync(linked.store, 0o555)
      try {
        f.signalFor(fallback)
        await main(['wait', 'linked', '--max', '0'], f.envFor(fallback), f.root)
      } finally { chmodSync(linked.store, 0o755) }
      assert.equal(existsSync(join(linked.store, 'delivered.json')), false)
      assert.equal(existsSync(join(writer.run, 'delivered.json')), false)
      assert.equal(existsSync(join(linked.run, 'delivered.json')), false)
      writeFileSync(join(linked.store, 'control.json'), '{')
      await assert.rejects(main(['wait', 'linked', '--max', '0'], f.envFor(fallback), f.root))
    }
  } finally { f.dispose() }
})

test('running writers and planted visible receipts do not invent a protected harvest or reception', async () => {
  const f = notificationFixture()
  try {
    f.flow('flow'); f.binding(fallback.session, 'flow'); f.signalFor(fallback)
    const running = f.writer('running', 'running', 'owner', 'flow')
    fixtureJson(join(running.run, 'delivered.json'), { round: null, launch: null })
    assert.equal((await main(['wait', 'running', '--max', '0'], f.envFor(fallback), f.root)).code, 3)
    assert.equal(existsSync(join(running.store, 'harvest.json')), false)
    assert.equal(existsSync(join(running.store, 'delivered.json')), false)
    assert.equal(runOpenness(f.root, 'running')?.open, 'running')
    const planted = f.writer('planted', 'done', 'owner', 'flow')
    fixtureJson(join(planted.run, 'delivered.json'), { round: null, launch: null })
    fixtureJson(join(planted.store, 'harvest.json'), { ...harvest(f.base, planted.store), runAltered: [{ path: './delivered.json', reason: 'fixture' }] })
    assert.equal(runOpenness(f.root, 'planted')?.open, 'undelivered')
    await main(['wait', 'planted', '--max', '0'], f.envFor(other), f.root)
    assert.equal(existsSync(join(planted.store, 'delivered.json')), false)
    assert.equal(runOpenness(f.root, 'planted')?.open, 'undelivered')
    const frozen = readFileSync(join(planted.store, 'harvest.json'), 'utf8')
    // La dueña Codex puede recibir manualmente sin mod; el request visible no decide su identidad.
    await main(['wait', 'planted', '--max', '0'], f.envFor({ family: 'codex', session: 'owner' }), f.root)
    assert.equal(existsSync(join(planted.store, 'delivered.json')), true)
    assert.equal(readFileSync(join(planted.store, 'harvest.json'), 'utf8'), frozen)
  } finally { f.dispose() }
})
