import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidateFingerprint } from '../src/git.ts'
import { withPhaseNext } from '../src/sdd/phase-state.ts'
import { currentAttestation, fileSha256, writeAttestation } from '../src/sdd/verify-receipt.ts'
import { closeRestoreIntent, prepareIntent, restoreIntentOpen, revertPaths, writeRestoreIntent } from '../src/sdd/restore.ts'
import { confirmationOutcome, evaluateRow, executeRows, patternMatches, prepareVerify, runBaseline } from '../src/sdd/verify.ts'
import { type TestRow, admitVerification } from '../src/sdd/verification-contract.ts'
import { acquireReservation, ownReservation, flowWriterRuns, releaseReservation } from '../src/writer-store.ts'
import { createHash } from 'node:crypto'
import { makeRepo } from './helpers.ts'
import {
  realpathTmp, baseRepo, realTap, TAP_FILES, EXEC, TROW, cmd, RED_ROW, BUILD_ROW, approveAll, verifyFlow, statusOf,
  final, asyncCode, fakeHarvest, cli,
} from './sdd-verify-fixture.ts'

test('antes de un verbo se resuelve la restauración que dejó una verificación caída', () => {
  const { repo, base } = verifyFlow()
  const intent = { ...prepareIntent(repo, '20260929-1600-aaaa', base, ['src/a.ts']), owner_pid: spawnSync(process.execPath, ['-e', '']).pid as number, owner_lstart: null }
  writeRestoreIntent(repo, intent)
  revertPaths(repo, intent)
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 1\n')
  const r = cli(repo, {}, 'sdd', 'status', 'f')
  assert.equal(r.code, 0)
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')
  assert.equal(restoreIntentOpen(repo), false)
})

test('una acreditación íntegra de otra fila o de otro flujo no acredita esta', () => {
  const { repo, base } = baseRepo()
  const fp = candidateFingerprint(repo, 'f', base)
  const body = { flow: 'f', observation: 'x', candidate: fp, plan_fingerprint: 'sha256:plan', answered_at: '2026-09-29T10:00:00-05:00' }
  const other = writeAttestation(repo, { ...body, id: '20260929-1000-cccc', row: 'V5', proof_ref: 'toolu_a' })
  const foreign = writeAttestation(repo, { ...body, id: '20260929-1001-dddd', row: 'V4', flow: 'otro', proof_ref: 'toolu_b' })
  // Referencias que dicen V4 pero apuntan a cuerpos de otra fila o de otro flujo.
  const forged = [{ ...other, row: 'V4' }, foreign]
  assert.deepEqual(currentAttestation(repo, forged, 'f', 'V4', fp, 'sha256:plan'), { ref: null, invalid: [foreign.id, other.id] })
})

test('una entrada del TAP con la ruta del archivo de prueba no cuenta aunque se llame como el test', () => {
  const tap = realTap(TAP_FILES)
  const file = tap.match(/^not ok \d+ - (\S*b\.test\.ts)$/m)?.[1] ?? ''
  assert.ok(file.endsWith('b.test.ts'))
  const row: TestRow = { ...TROW, test_name: file, test_paths: [file.slice(file.lastIndexOf('/') + 1)] }
  assert.equal(confirmationOutcome(row, { ...EXEC, exit_code: 1 }, tap), 'not_confirmable')
  assert.equal(evaluateRow(row, { ...EXEC, exit_code: 0 }, { stdout: tap.replace(/^not ok (\d+ - \S*b\.test\.ts)$/m, 'ok $1'), stderr: '' }), 'failed')
})

test('un patrón con retroceso catastrófico no cuelga la evaluación', () => {
  const t = Date.now()
  assert.equal(patternMatches('^(a+)+$', `${'a'.repeat(40)}b`), false)
  assert.ok(Date.now() - t < 10000)
  assert.equal(patternMatches('listo', 'todo listo'), true)
})

test('una salida más grande que el tope de evaluación no da verde si hay que leerla, y el extracto sale del final', async () => {
  const root = realpathTmp()
  const [big] = await executeRows(root, join(root, 'run'), [cmd('V1', [process.execPath, '-e', 'process.stdout.write("x".repeat(33 * 1024 * 1024) + "\\nfinal\\n")'])], new AbortController().signal)
  assert.equal(big.excerpt, 'exit 0; final')
  // Sin patrón, una fila que no es test no lee la salida: el tope no la afecta.
  assert.equal(evaluateRow(cmd('V1', ['x']), big, null), 'passed')
  // Con patrón, o en una fila test, una salida que no se lee entera no da verde.
  assert.equal(evaluateRow(cmd('V1', ['x'], { expect: { exit_code: 0, output_pattern: 'final' } }), big, null), 'failed')
  assert.equal(evaluateRow(TROW, big, null), 'failed')
})

test('al cortar una fila, también terminan los procesos que dejó en su grupo', async () => {
  const root = realpathTmp()
  const pidFile = join(root, 'nieto.pid')
  // El nieto ignora SIGTERM: solo lo termina el SIGKILL al grupo, y la fila tiene que esperar a que muera.
  const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 60000)`
  // El corte llega cuando el nieto ya arrancó, sin depender de cuánto tarda en hacerlo.
  const controller = new AbortController()
  const deadline = Date.now() + 20000
  const poll = setInterval(() => (existsSync(pidFile) || Date.now() > deadline) && controller.abort(), 10)
  const [slow] = await executeRows(root, join(root, 'run'), [cmd('V1', [process.execPath, '-e', script], { timeout_ms: 60000 })], controller.signal)
  clearInterval(poll)
  assert.equal(slow.reason, 'interrupted')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  // La fila no se cierra hasta que su grupo terminó: cuando vuelve, el nieto ya no corre. Puede quedar
  // un instante como zombi hasta que lo recoja init, y un zombi ya no escribe nada.
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  assert.ok(stat === '' || stat.startsWith('Z'), `el nieto sigue corriendo: ${stat}`)
})

test('mientras corre una fila, la reserva de la verificación anota su grupo, y lo quita al terminar', async () => {
  const repo = makeRepo()
  const run = join(realpathTmp(), 'run')
  const reserved = acquireReservation(repo, '20260929-1500-aaaa', 'verify')
  assert.ok(reserved.ok)
  const lock = join(repo, '.git', 'sdd-ai', 'checkout.lock')
  // La reserva se anota apenas vuelve el lanzamiento, que puede ser después de que la fila arranca: la fila espera verla.
  const show = 'const read = () => JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).group; const end = Date.now() + 3000; '
    + 'const tick = () => (read() !== undefined || Date.now() > end ? process.stdout.write(JSON.stringify({ group: read(), pid: process.pid })) : setTimeout(tick, 10)); tick()'
  const [e] = await executeRows(repo, run, [cmd('V1', [process.execPath, '-e', show, lock])], new AbortController().signal, '', '20260929-1500-aaaa')
  const seen = JSON.parse(readFileSync(join(run, e.stdout_file), 'utf8')) as { group: number; pid: number }
  assert.equal(seen.group, seen.pid)
  assert.equal(ownReservation(repo)?.group, undefined)
  assert.equal(ownReservation(repo)?.id, '20260929-1500-aaaa')
  for (const handle of reserved.handles) assert.equal(releaseReservation(handle).state, 'released')
})

test('el sha256 de una salida se calcula por partes y coincide con el del contenido entero', () => {
  const file = join(realpathTmp(), 'salida.log')
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 'abc')
  writeFileSync(file, bytes)
  assert.equal(fileSha256(file), `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
})

test('las rutas del contrato tienen que venir normalizadas', () => {
  for (const path of ['src/./a.ts', 'src//a.ts', 'src/', 'src\\a.ts']) {
    const raw = { schema_version: 1, rows: [{ ...RED_ROW, implementation_paths: [path] }, BUILD_ROW] }
    assert.throws(() => admitVerification(raw, ['AC-1', 'AC-2']), /sin normalizar|ruta exterior/, path)
  }
})

test('una confirmación green_on_base revierte, corre y restaura de punta a punta', async () => {
  const GREEN_ROW = { ...RED_ROW, obligation: 'green_on_base', test_name: 'f es una función', test_paths: ['test/b.test.ts'], argv: [process.execPath, '--test', '--test-reporter=tap', 'test/b.test.ts'] }
  const { repo } = verifyFlow({ rows: [GREEN_ROW, BUILD_ROW] })
  writeFileSync(join(repo, 'test', 'b.test.ts'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f es una función', () => { assert.equal(typeof f, 'function') })\n")
  const { receipt } = await final(repo)
  assert.deepEqual([receipt.rows[0].outcome, receipt.rows[0].confirmation?.state, receipt.rows[0].confirmation?.restored], ['passed', 'confirmed', true])
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')
  assert.equal(receipt.green, true)
})

test('si la prueba edita una ruta revertida, la restauración no la pisa y deja la intención abierta', async () => {
  const script = "require('node:fs').writeFileSync('src/a.ts', 'export const f = () => 2 // ' + Date.now() + Math.random()); console.log('ok 1 - f da 2')"
  const { repo } = verifyFlow({ rows: [{ ...RED_ROW, argv: [process.execPath, '-e', script] }, BUILD_ROW] })
  assert.equal(await asyncCode(() => final(repo)), 'restore_conflict')
  assert.match(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), /\/\/ \d+/)
  assert.equal(restoreIntentOpen(repo), true)
  assert.equal(ownReservation(repo), undefined)
})

test('la base se mide contra el commit base: un archivo ignorado no la hace medible', async () => {
  const { repo } = verifyFlow({ done: false, implement: false })
  approveAll(repo)
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\ntest/\n')
  writeFileSync(join(repo, 'test', 'a.test.ts'), "import { test } from 'node:test'\ntest('f da 2', () => {})\n")
  const { receipt } = await runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)
  assert.equal(receipt.rows[0].baseline, 'not_measurable')
})

test('una medición que escribe en otro flujo lo lista para limpiar', async () => {
  const { repo } = verifyFlow({ done: false, implement: false, rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', 'require("node:fs").mkdirSync(".plans/otro", { recursive: true }); require("node:fs").writeFileSync(".plans/otro/x.md", "x")'] }] })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.sdd-ai/\n')
  approveAll(repo)
  const { receipt } = await runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)
  assert.deepEqual(receipt.dirtied_paths, ['.plans/otro/x.md'])
})

test('los writers del flujo se ordenan por su arranque dentro del mismo minuto', () => {
  const { repo } = baseRepo()
  const write = (id: string, spawning: string) => {
    const store = join(repo, '.git', 'sdd-ai', 'runs', id)
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'control.json'), JSON.stringify({ id, spawning, phase: { flow: 'f', pending: [], inputs: {}, handoff_header: '' } }))
  }
  write('20260929-1500-ffff', '2026-09-29T20:00:01.000Z')
  write('20260929-1500-0000', '2026-09-29T20:00:30.000Z')
  write('20260929-1459-9999', '2026-09-29T19:59:59.000Z')
  assert.deepEqual(flowWriterRuns(repo, 'f').map((c) => c.id), ['20260929-1459-9999', '20260929-1500-ffff', '20260929-1500-0000'])
})

test('con una verificación en curso, un writer concurrente se niega; y doctor también resuelve una intención caída', () => {
  const { repo, base } = verifyFlow()
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n')
  const encargo = join(realpathTmp(), 'encargo.md')
  writeFileSync(encargo, 'nada\n')
  // Intención abierta con el dueño vivo: el verbo del writer se detiene antes de lanzar.
  const intent = prepareIntent(repo, '20260929-1700-aaaa', base, ['src/a.ts'])
  writeRestoreIntent(repo, intent)
  assert.equal(cli(repo, {}, 'run', '--role', 'implement', '--prompt-file', encargo).out.code, 'verify_in_progress')
  // Sin intención pero con la reserva de la verificación tomada: writer_open.
  closeRestoreIntent(repo)
  const verifying = acquireReservation(repo, '20260929-1700-aaaa', 'verify')
  assert.ok(verifying.ok)
  assert.equal(cli(repo, {}, 'run', '--role', 'implement', '--prompt-file', encargo).out.code, 'writer_open')
  for (const handle of verifying.handles) assert.equal(releaseReservation(handle).state, 'released')
  // Una intención de un dueño muerto la resuelve también doctor.
  writeRestoreIntent(repo, { ...intent, owner_pid: spawnSync(process.execPath, ['-e', '']).pid as number, owner_lstart: null })
  revertPaths(repo, intent)
  cli(repo, {}, 'doctor')
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')
  assert.equal(restoreIntentOpen(repo), false)
})

test('recibo posterior a la toma: después de una toma, solo un recibo que corrió sobre ella acredita el árbol', async () => {
  const { repo, base } = verifyFlow()
  fakeHarvest(repo, base, { endMark: true })
  const first = await final(repo)
  assert.equal(first.receipt.green, true, JSON.stringify(first.receipt.rows))
  assert.equal(statusOf(repo).next.step, 'review_and_commit')
  // Una toma posterior al recibo: el verde anterior ya no acredita el árbol.
  const phases = join(repo, '.plans', 'f', 'sdd-ai-phases.json')
  const rec = JSON.parse(readFileSync(phases, 'utf8'))
  const at = new Date().toISOString()
  rec.implement = {
    schema: 1, classifications: [], events: [],
    chains: [{ id: 'c1', terminal: { code: 'takeover', at, detail: 'toma' }, entries: [{ kind: 'takeover', id: 't-uno', parent: null, at, map: { ref: 'takeovers/t-uno.json', digest: `sha256:${'c'.repeat(64)}` } }] }],
  }
  writeFileSync(phases, JSON.stringify(rec))
  assert.equal(statusOf(repo).next.step, 'verify')
  // La cadena tampoco da por vigente el verde anterior a la toma, aunque el árbol sea el mismo: pide verificar.
  const chained = withPhaseNext(repo, 'f', statusOf(repo))
  assert.equal(chained.command, './bin/sdd-ai sdd verify f', JSON.stringify(chained))
  // Un recibo nuevo lleva la toma y, en verde, vuelve a acreditar el árbol aunque el writer no cierre.
  const second = await final(repo)
  assert.equal(second.receipt.writer?.takeover, 't-uno')
  assert.equal(second.receipt.green, true)
  assert.equal(statusOf(repo).next.step, 'review_and_commit')
  // Una toma posterior y otra cadena después de ella: el verde anterior a esa toma tampoco acredita el árbol.
  const now = JSON.parse(readFileSync(phases, 'utf8'))
  const later = new Date(Date.now() + 1000).toISOString()
  now.implement.chains = [
    { id: 'c1', terminal: { code: 'takeover', at: later, detail: 'toma' }, entries: [{ kind: 'takeover', id: 't-dos', parent: null, at: later, map: { ref: 'takeovers/t-dos.json', digest: `sha256:${'d'.repeat(64)}` } }] },
    { id: 'c2', terminal: null, entries: [{ kind: 'implement', run: '20260929-2359-beef', parent: 't-dos', at: later, pending: ['T1'] }] },
  ]
  writeFileSync(phases, JSON.stringify(now))
  assert.equal(statusOf(repo).next.step, 'verify')
})
