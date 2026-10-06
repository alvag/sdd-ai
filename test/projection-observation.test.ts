import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { heartbeat } from '../src/projection.ts'
import { validateProjection } from '../src/projection-types.ts'
import type { Projection } from '../src/projection-types.ts'
import { TERMINAL } from '../src/types.ts'
import { makeFakeBin } from './helpers.ts'
import { fixtureJson, latestProjection, projectionFixture } from './projection-fixture.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
/** Tope del sondeo: la publicación corre en un proceso aparte y llega después del cambio. */
const WITHIN_MS = 10_000

type Conductor = 'claude' | 'codex'
/** `on` publica, `off` apaga la publicación y `denied` publica sobre un directorio de la proyección sin permisos. */
type Mode = 'on' | 'off' | 'denied'

/** La observación más nueva cuando cumple `ok`; toda observación publicada es un JSON válido del contrato. */
async function observed(root: string, ok: (doc: Projection) => boolean, what: string): Promise<Projection> {
  const until = Date.now() + WITHIN_MS
  let last: Projection | null = null
  for (;;) {
    last = latestProjection(root)
    if (last !== null) {
      assert.equal(validateProjection(last).ok, true)
      if (ok(last)) return last
    }
    if (Date.now() > until) assert.fail(`${what}: la proyección no lo reflejó; última: ${JSON.stringify(last)}`)
    await sleep(50)
  }
}

const runIn = (doc: Projection, id: string) => doc.runs.items.find((r) => r.id === id)

/**
 * Espera a que no quede ningún publicador ni supervisor lanzado sobre `root`: mientras alguno corre, puede publicar
 * después de lo que se compruebe.
 */
async function settled(root: string): Promise<void> {
  const until = Date.now() + 30_000
  for (;;) {
    const ps = spawnSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' })
    assert.equal(ps.status, 0, ps.stderr)
    const busy = ps.stdout.split('\n').filter((line) => /\b__(?:publish|supervise)\b/.test(line) && line.includes(root))
    if (busy.length === 0) return
    assert.ok(Date.now() < until, `siguen corriendo sobre el checkout:\n${busy.join('\n')}`)
    await sleep(50)
  }
}

/** Una línea del registro de `SDD_AI_PROJECTION_MEASURE`. */
type Measured = { result: string; id?: string; trigger_at: number }

/** Las líneas del registro de `SDD_AI_PROJECTION_MEASURE`: una por publicador terminado. */
const measured = (file: string): Measured[] =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []

/**
 * La línea del registro de medición que cumple `ok`. Cada publicador la agrega al terminar, después de publicar su
 * observación: se espera con el mismo tope que las observaciones, y un registro con una línea a medio escribir se
 * vuelve a leer.
 */
async function measuredLine(file: string, ok: (line: Measured) => boolean, what: string): Promise<Measured> {
  const until = Date.now() + WITHIN_MS
  for (;;) {
    let lines: Measured[] = []
    try {
      lines = measured(file)
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
    }
    const line = lines.find(ok)
    if (line !== undefined) return line
    if (Date.now() > until) assert.fail(`${what}: no apareció en el registro de medición; registro: ${JSON.stringify(lines)}`)
    await sleep(50)
  }
}

/**
 * El mismo recorrido de operaciones autorizadas en un checkout nuevo: un worker que termina bien, otro que falla,
 * la entrega del primero, un `wait` que falla después de escribir el estado de una corrida ajena, una liga del
 * hook y la vista de un flujo. Devuelve lo funcional de cada operación, sin ids ni rutas, y los registros de
 * dominio que quedaron.
 */
async function walk(conductor: Conductor, mode: Mode) {
  const f = projectionFixture()
  const root = f.root
  const worker = conductor === 'claude' ? 'codex' : 'claude'
  const session = `s-${conductor}`
  try {
    const bin = join(f.scratch, 'bin')
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, 'node'))
    for (const b of ['claude', 'codex'] as const) makeFakeBin(bin, b)
    writeFileSync(join(root, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n')
    const prompt = join(f.scratch, 'prompt.md')
    writeFileSync(prompt, 'Encargo de prueba.\n')
    f.flow('f')
    // Una corrida corrupta entre varias válidas: solo ella queda no disponible.
    const corrupt = f.run('20260101-0000-0bad', { session: 'ajena' })
    writeFileSync(join(corrupt, 'status.json'), '{')
    f.run('20260101-0000-0001', { session: 'ajena' }, 'running')
    // Una corrida ajena cuyo supervisor ya no existe: `wait` escribe su fallo y no la entrega.
    const dead = spawnSync(process.execPath, ['-e', '']).pid!
    const lost = f.run('20260101-0000-0002', { session: 'ajena' }, 'running')
    fixtureJson(join(lost, 'status.json'), { state: 'running', supervisor_pid: dead })
    const env: Record<string, string> = {
      PATH: `${bin}:/usr/bin:/bin`, HOME: f.scratch, CODEX_HOME: join(f.scratch, 'codex-home'),
      ...(conductor === 'claude' ? { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session } : { CODEX_THREAD_ID: 't', CODEX_SESSION_ID: session }),
      ...(mode === 'off' ? { SDD_AI_PROJECTION: 'off' } : {}),
    }
    mkdirSync(env.CODEX_HOME)
    const live = join(root, '.sdd-ai', 'projection', 'live')
    // Con el directorio sin permisos, el registro de cada publicador terminado dice cómo terminó.
    const measure = join(f.scratch, 'measure.jsonl')
    if (mode === 'denied') env.SDD_AI_PROJECTION_MEASURE = measure
    if (mode === 'denied') {
      mkdirSync(live, { recursive: true })
      chmodSync(live, 0o500)
      chmodSync(join(root, '.sdd-ai', 'projection'), 0o500)
    }
    const results: Array<{ args: string[]; code: number | null; stdout: string; stderr: string }> = []
    const call = (args: string[], extra: Record<string, string> = {}, input?: string) => {
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', input, timeout: 60_000 })
      results.push({ args, code: r.status, stdout: r.stdout, stderr: r.stderr })
      return { code: r.status, out: r.stdout.trim() === '' ? null : JSON.parse(r.stdout) }
    }
    const terminal = async (id: string) => {
      const until = Date.now() + 30_000
      while (!TERMINAL.has(JSON.parse(readFileSync(join(root, '.sdd-ai', 'runs', id, 'status.json'), 'utf8')).state)) {
        assert.ok(Date.now() < until, `la corrida ${id} no terminó`)
        await sleep(50)
      }
    }

    const ok = call(['run', '--role', 'explore', '--prompt-file', prompt], { FAKE_MODE: `ok-${worker}` }).out.id as string
    const bad = call(['run', '--role', 'explore', '--prompt-file', prompt], { FAKE_MODE: 'roto' }).out.id as string
    await terminal(ok)
    await terminal(bad)
    if (mode === 'on') {
      // Creación, lanzamiento y terminal de cada corrida, también la que falló: se ve lo que quedó.
      const doc = await observed(root, (d) => runIn(d, ok)?.state.value === 'done' && runIn(d, bad)?.state.value !== 'running'
        && runIn(d, bad)?.state.value !== 'launching' && runIn(d, bad)?.state.value !== undefined, 'las dos corridas terminadas')
      assert.deepEqual([runIn(doc, ok)?.open.value, runIn(doc, ok)?.session.value, runIn(doc, ok)?.live.value], ['undelivered', session, false])
      assert.notEqual(runIn(doc, bad)?.state.value, 'done')
      assert.equal(runIn(doc, bad)?.open.value, 'undelivered')
    }
    call(['wait', ok, '--max', '20'])
    call(['wait', '20260101-0000-0002', '--max', '5'])
    const hook = conductor === 'claude' ? 'claude' : 'codex'
    call(['hook', hook], {}, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, cwd: root, tool_name: 'Bash',
      tool_use_id: 'tu-1', tool_input: { command: './bin/sdd-ai sdd status f' } }))
    const status = call(['sdd', 'status', 'f'])

    // Lo que quedó en los registros de dominio, que la publicación nunca escribe.
    const runs = join(root, '.sdd-ai', 'runs')
    const delivered = () => Object.fromEntries(readdirSync(runs).sort().map((id) => [id === ok ? 'ok' : id === bad ? 'bad' : id,
      existsSync(join(runs, id, 'delivered.json'))]))
    const route = join(root, '.sdd-ai', 'hooks', 'route', `${session}.json`)
    const binding = () => {
      const flow = existsSync(route) ? (JSON.parse(readFileSync(route, 'utf8')) as { flow?: { id: string; step: string; gate: string | null } }).flow : undefined
      return flow === undefined ? null : { id: flow.id, step: flow.step, gate: flow.gate }
    }
    const approvals = () => existsSync(join(root, '.plans', 'f', 'sdd-ai-approvals.json'))
    const domain = () => ({ delivered: delivered(), binding: binding(), approvals: approvals(),
      lost: JSON.parse(readFileSync(join(lost, 'status.json'), 'utf8')).reason as string })
    const before = domain()

    if (mode === 'on') {
      const doc = await observed(root, (d) => runIn(d, ok) === undefined && d.bindings.items.some((b) => b.id === session && b.flow.value?.id === 'f')
        && runIn(d, '20260101-0000-0002')?.state.value === 'failed', 'la entrega, la liga y el fallo de wait')
      // La entrega saca a la corrida; la que falló y la ajena siguen sin entregar.
      assert.equal(runIn(doc, bad)?.open.value, 'undelivered')
      assert.deepEqual([runIn(doc, '20260101-0000-0002')?.open.value, runIn(doc, '20260101-0000-0002')?.session.value], ['undelivered', 'ajena'])
      // La entidad corrupta queda no disponible sin borrar a las demás.
      assert.equal(doc.runs.availability, 'partial')
      assert.equal(runIn(doc, '20260101-0000-0bad')?.availability, 'unavailable')
      assert.equal(runIn(doc, '20260101-0000-0001')?.state.value, 'running')
      // El flujo es el de `sdd status`, con la liga que dejó el hook.
      const flow = await observed(root, (d) => d.flows.items.some((x) => x.id === 'f'), 'el flujo')
      assert.deepEqual(flow.flows.items.find((x) => x.id === 'f')?.view.value, status.out)
      // Las publicaciones siguientes no entregan, no sueltan ligas ni aprueban nada.
      const published = latestProjection(root)!.observation.id
      for (let i = 0; i < 3; i++) call(['sdd', 'status'])
      await observed(root, (d) => d.observation.id > published, 'otra publicación')
      results.splice(-3)
      assert.deepEqual(domain(), before)
    } else {
      // Sin publicación, o con su directorio sin permisos, no queda ninguna observación. La comprobación espera a que
      // terminen los publicadores y los supervisores lanzados: uno atrasado no puede publicar después.
      await settled(root)
      assert.equal(latestProjection(root), null)
      if (mode === 'denied') {
        // Cada publicador lanzado terminó sin publicar.
        const denied = measured(measure)
        assert.ok(denied.length > 0, 'ningún publicador terminó')
        assert.deepEqual(denied.filter((line) => line.result !== 'not_published'), [])
        // Con los permisos de vuelta, la siguiente actividad normal recupera el estado desde las fuentes: una
        // observación leída después y publicada por un pedido posterior.
        chmodSync(join(root, '.sdd-ai', 'projection'), 0o700)
        chmodSync(live, 0o700)
        const restored = Date.now()
        call(['sdd', 'status'])
        results.pop()
        const doc = await observed(root, (d) => d.observation.observed_at >= restored && runIn(d, bad) !== undefined
          && d.bindings.items.some((b) => b.flow.value?.id === 'f'), 'la recuperación')
        assert.equal(runIn(doc, ok), undefined)
        const recovery = await measuredLine(measure, (line) => line.result === 'published' && line.id === doc.observation.id, 'la recuperación')
        assert.ok(recovery.trigger_at >= restored, `la recuperación no viene de un pedido posterior: ${JSON.stringify(recovery)}`)
        assert.deepEqual(domain(), before)
      }
    }
    // Lo funcional, sin lo que cambia de un checkout a otro: el temporal, los ids nuevos y el pid del supervisor perdido.
    const normalize = (text: string) => text.replaceAll(f.scratch, '<scratch>').replaceAll(ok, '<ok>').replaceAll(bad, '<bad>')
      .replaceAll(`supervisor ${dead}`, 'supervisor <pid>')
    return { results: results.map((r) => ({ args: r.args.map(normalize), code: r.code, stdout: normalize(r.stdout), stderr: normalize(r.stderr) })), domain: before }
  } finally {
    try { chmodSync(join(root, '.sdd-ai', 'projection'), 0o700) } catch { /* Sin directorio no hay permisos que devolver. */ }
    try { chmodSync(join(root, '.sdd-ai', 'projection', 'live'), 0o700) } catch { /* Ídem. */ }
    f.dispose()
  }
}

test('authorized operations publish actual changes and retain functional results under publication faults', async () => {
  for (const conductor of ['claude', 'codex'] as const) {
    const on = await walk(conductor, 'on')
    const off = await walk(conductor, 'off')
    const denied = await walk(conductor, 'denied')
    // La publicación, y su fallo, no cambian stdout, stderr, códigos, entregas, ligas ni aprobaciones.
    assert.deepEqual(on, off, conductor)
    assert.deepEqual(denied, off, conductor)
    assert.deepEqual(off.domain.delivered, { '20260101-0000-0001': false, '20260101-0000-0002': false, '20260101-0000-0bad': false, bad: false, ok: true })
    assert.deepEqual([off.domain.binding?.id, off.domain.approvals, off.domain.lost], ['f', false, 'supervisor_lost'])
  }

  // El publicador solo lee el dominio: no importa nada que entregue, coseche, ligue, apruebe ni libere.
  for (const file of ['src/projection.ts', 'src/review/progress.ts']) {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
    const imported = [...source.matchAll(/^import (?:type )?\{([^}]*)\} from '\.{1,2}\/[^']+'/gm)].flatMap((m) => m[1].split(',').map((n) => n.trim()))
    for (const name of imported) assert.doesNotMatch(name, /deliver|harvest|setBinding|clearBinding|release|approve|appendEntry|closeChain|writeJson|setStatus/i, `${file}: ${name}`)
  }
})

test('supervisor heartbeat renews publication until stopped without holding its process', async () => {
  let beats = 0
  const stop = heartbeat(() => { beats++ }, 20)
  await sleep(150)
  stop()
  const counted = beats
  assert.ok(counted >= 3, `latidos: ${counted}`)
  await sleep(80)
  assert.equal(beats, counted, 'el latido se detiene al cancelarlo')
  // Un proceso que solo tiene el latido termina enseguida: el temporizador no lo retiene.
  const projection = new URL('../src/projection.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { heartbeat } from ${JSON.stringify(projection)}; heartbeat(() => {}, 60000)`], { stdio: 'ignore' })
  const code = await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10_000, 'vivo', { ref: false })])
  if (code === 'vivo') child.kill('SIGKILL')
  assert.equal(code, 0)
})
