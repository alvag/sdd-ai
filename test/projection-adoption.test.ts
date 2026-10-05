import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gitDirs } from '../src/git.ts'
import { systemBootId } from '../src/projection.ts'
import { validateProjection } from '../src/projection-types.ts'
import type { Projection } from '../src/projection-types.ts'
import { readFlow } from '../src/sdd/read.ts'
import { acquireReservation, releaseAndReport } from '../src/writer-store.ts'
import { fixtureJson, latestProjection, projectionFixture } from './projection-fixture.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
/** Tope del sondeo: la publicación corre en un proceso aparte y llega después del cambio. */
const WITHIN_MS = 10_000

/** La observación más nueva cuando cumple `ok`. */
async function observed(root: string, ok: (doc: Projection) => boolean, what: string): Promise<Projection> {
  const until = Date.now() + WITHIN_MS
  let last: Projection | null = null
  for (;;) {
    last = latestProjection(root)
    if (last !== null && last.schema_version === 1 && validateProjection(last).ok && ok(last)) return last
    if (Date.now() > until) assert.fail(`${what}: la proyección no lo reflejó; última: ${JSON.stringify(last)}`)
    await sleep(50)
  }
}

/** Cada archivo bajo `dir`, con el sha256 de su contenido: lo que una adopción no puede cambiar. */
function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) tree(path, base, out)
    else out[relative(base, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return out
}

const runIn = (doc: Projection, id: string) => doc.runs.items.find((r) => r.id === id)

test('normal activity adopts historical state without delivery ownership or authorization changes', async () => {
  const f = projectionFixture()
  let reservation: ReturnType<typeof acquireReservation> | undefined
  try {
    const root = f.root
    // Flujos, ligas y aprobaciones de antes de la proyección.
    f.flow('alpha', 'planned')
    f.flow('beta', 'done')
    const facts = readFlow(root, 'alpha').facts
    fixtureJson(join(root, '.plans', 'alpha', 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [{
      gate: 'spec', depth: 'completa', fingerprint: facts.fingerprints.spec, previous: {}, at: '2026-10-05T00:00:00Z' }] })
    f.binding('session-a', 'alpha')
    f.binding('session-b', null)
    // Corridas históricas: una entregada, una sin entregar, una revisión con hallazgos por decidir en un formato
    // sin trabajos registrados y una nativa sin despachar.
    const conductor = { family: 'claude' }
    const delivered = f.run('20260101-0000-0001', { session: 'session-a', conductor }, 'done')
    fixtureJson(join(delivered, 'delivered.json'), { round: null, launch: null })
    f.run('20260101-0000-0002', { session: 'session-a', conductor }, 'done')
    const review = f.run('20260101-0000-0003', { session: 'session-a', conductor, kind: 'review' }, 'done')
    fixtureJson(join(review, 'status.json'), { state: 'done', round: 1 })
    fixtureJson(join(review, 'delivered.json'), { round: 1, launch: null })
    fixtureJson(join(review, 'ledger.json'), { completed: 1, next_id: 2, entries: [{ id: 'F-1', state: 'abierto' }] })
    fixtureJson(join(review, 'rounds.json'), { rounds: [{ n: 1, state: 'done' }] })
    const native = f.run('20260101-0000-0004', { session: 'session-b', conductor }, 'delegated')
    fixtureJson(join(native, 'native.json'), { agent: 'sdd-ai-explore', family: 'claude', role: 'explore' })
    // Corridas vivas: un worker que supervisa un binario anterior, que escribe su estado sin publicar, y un
    // writer en vuelo con su reserva tomada.
    const legacy = f.run('20260101-0000-0005', { session: 'session-a', conductor }, 'running')
    f.writer('20260101-0000-0006', 'running', 'session-a', 'alpha')
    reservation = acquireReservation(root, '20260101-0000-0006', 'writer')
    assert.equal(reservation.ok, true)

    const store = join(gitDirs(root).gitDir, 'sdd-ai')
    const domain = () => ({ runs: tree(join(root, '.sdd-ai', 'runs')), hooks: tree(join(root, '.sdd-ai', 'hooks')),
      plans: tree(join(root, '.plans')), store: tree(store) })
    const before = domain()
    assert.equal(existsSync(join(root, '.sdd-ai', 'projection')), false, 'el checkout empieza sin proyección')

    const env = { PATH: process.env.PATH ?? '', HOME: f.scratch, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-c' }
    const call = (args: string[], input?: string) => spawnSync(BIN, args, { cwd: root, env, encoding: 'utf8', input, timeout: 60_000 })

    // La primera actividad normal, un verbo de lectura, adopta todo lo que había.
    const status = call(['sdd', 'status', 'alpha'])
    assert.equal(status.status, 0, status.stderr)
    let doc = await observed(root, (d) => d.runs.items.length > 0, 'la adopción')
    assert.deepEqual(doc.runs.items.map((r) => [r.id, r.open.value]), [
      ['20260101-0000-0002', 'undelivered'], ['20260101-0000-0003', 'review_pending'], ['20260101-0000-0004', 'native_pending'],
      ['20260101-0000-0005', 'running'], ['20260101-0000-0006', 'running'],
    ])
    assert.deepEqual([runIn(doc, '20260101-0000-0005')?.state.value, runIn(doc, '20260101-0000-0005')?.live.value], ['running', true])
    // Los datos que un formato anterior no tiene quedan desconocidos.
    assert.equal(runIn(doc, '20260101-0000-0003')?.progress.reason?.code, 'progress_unavailable')
    assert.deepEqual([doc.writer.item?.id, doc.writer.item?.state.value, doc.writer.item?.flow.value], ['20260101-0000-0006', 'running', 'alpha'])
    assert.deepEqual(doc.flows.items.map((x) => [x.id, x.status.value]), [['alpha', 'planned'], ['beta', 'done']])
    assert.deepEqual(doc.flows.items[0].view.value, JSON.parse(status.stdout))
    assert.deepEqual(doc.bindings.items.map((b) => [b.id, b.flow.value?.id ?? null]),
      [['session-a', 'alpha'], ['session-b', null]])
    // Adoptar no cancela, no relanza, no cambia dueños ni marca entregas, ni toca ledger, reservas, aprobaciones o ligas.
    assert.deepEqual(domain(), before)

    // Una corrida que supervisa un binario anterior avanza sin publicar: la actualiza el siguiente hook que publica.
    fixtureJson(join(legacy, 'status.json'), { state: 'done', ended_at: '2026-10-05T00:00:00Z' })
    const changed = domain()
    const hook = call(['hook', 'claude'], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-c', cwd: root,
      tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'ls' } }))
    assert.equal(hook.status, 0, hook.stderr)
    doc = await observed(root, (d) => runIn(d, '20260101-0000-0005')?.state.value === 'done', 'la corrida del binario anterior')
    assert.deepEqual([runIn(doc, '20260101-0000-0005')?.open.value, runIn(doc, '20260101-0000-0005')?.live.value], ['undelivered', false])
    assert.equal(existsSync(join(legacy, 'delivered.json')), false)

    // Una observación más nueva de una versión de contrato mayor no impide publicar ni decide nada.
    const live = join(root, '.sdd-ai', 'projection', 'live')
    const m0 = process.hrtime.bigint().toString().padStart(20, '0')
    const future = `obs-${m0}-${systemBootId()}-${process.pid}-${randomBytes(16).toString('hex')}.json`
    writeFileSync(join(live, future), JSON.stringify({ schema_version: 2, runs: [], note: 'de un binario más nuevo' }))
    assert.equal(latestProjection(root)?.schema_version, 2)
    assert.equal(call(['sdd', 'status']).status, 0)
    doc = await observed(root, (d) => d.observation.id > future, 'la publicación después de la versión mayor')
    assert.equal(runIn(doc, '20260101-0000-0005')?.state.value, 'done')
    assert.equal(doc.writer.item?.id, '20260101-0000-0006')

    // Las publicaciones no cambiaron nada fuera del rastro del hook de la sesión que llamó.
    const after = domain()
    for (const key of Object.keys(after.hooks)) if (key.includes('session-c')) delete after.hooks[key]
    assert.deepEqual(after, changed)
  } finally {
    if (reservation?.ok) for (const handle of reservation.handles) releaseAndReport(handle)
    f.dispose()
  }
})
