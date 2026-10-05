import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { validateProjection } from '../src/projection-types.ts'
import type { ProjectionJob, ProjectionProgress, ProjectionRun } from '../src/projection-types.ts'
import { TERMINAL } from '../src/types.ts'
import { fixtureJson, latestProjection, projectionBarrier } from './projection-fixture.ts'
import { type Setup, bulky, cli, firstRound, git, grave, runJson, setup } from './rounds-cli-fixture.ts'

/** Tope del sondeo: la publicación corre en un proceso aparte y llega después del cambio. */
const WITHIN_MS = 10_000

/** La corrida `id` en la observación más nueva, cuando cumple `ok`; la proyección siempre es un JSON válido del contrato. */
async function projected(root: string, id: string, ok: (run: ProjectionRun) => boolean, what: string): Promise<ProjectionRun> {
  const until = Date.now() + WITHIN_MS
  let last: ProjectionRun | undefined
  for (;;) {
    const document = latestProjection(root)
    if (document !== null) {
      assert.equal(validateProjection(document).ok, true, JSON.stringify(validateProjection(document)))
      last = document.runs.items.find((run) => run.id === id)
      if (last !== undefined && ok(last)) return last
    }
    if (Date.now() > until) assert.fail(`${what}: la proyección no lo reflejó; última: ${JSON.stringify(last ?? null)}`)
    await sleep(50)
  }
}

const progressOf = (run: ProjectionRun): ProjectionProgress => {
  assert.ok(run.progress.value, `sin avance: ${JSON.stringify(run.progress)}`)
  return run.progress.value
}
const keys = (jobs: ProjectionJob[]) => jobs.map((j) => j.key).sort()
const admitted = (jobs: ProjectionJob[]) => jobs.filter((j) => j.admission.value === 'admitted').map((j) => j.key).sort()
const job = (jobs: ProjectionJob[], key: string) => {
  const found = jobs.find((j) => j.key === key)
  assert.ok(found, `falta ${key}`)
  return found
}

async function terminal(s: Setup, id: string): Promise<void> {
  const until = Date.now() + 60_000
  while (!TERMINAL.has(runJson(s, id, 'status.json').state)) {
    assert.ok(Date.now() < until, 'la ronda no terminó')
    await sleep(100)
  }
}

/**
 * Borra las barreras cuando ya nadie las usa: los procesos que llegaron a alguna (su pid queda en `.arrived`) leen el
 * `.release` hasta que siguen, así que se espera a que terminen, con un tope.
 */
async function removeGates(dir: string): Promise<void> {
  const pids = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.arrived')).map((name) => Number(readFileSync(join(dir, name), 'utf8'))) : []
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
  }
  const until = Date.now() + 30_000
  while (pids.some((pid) => Number.isSafeInteger(pid) && pid > 0 && alive(pid)) && Date.now() < until) await sleep(50)
  rmSync(dir, { recursive: true, force: true })
}

const NONE = firstRound([])
const LENS_KEYS = ['risk', 'resilience', 'reliability', 'readability'].flatMap((r) => [`${r}-b1`, `${r}-b2`])
const ALL = ['base-b1', 'base-b2', ...LENS_KEYS].sort()
const RETRIED = ['risk-b1', 'risk-b2']
const KEPT = ALL.filter((k) => !RETRIED.includes(k))

test('review publishes completed logical jobs across failure reuse relaunch and refutation', async () => {
  // Las barreras van en un directorio con un espacio en su nombre: la respuesta guionada lleva la ruta entera.
  const gates = mkdtempSync(join(tmpdir(), 'sdd-ai progress-'))
  const barrier = (name: string) => projectionBarrier(join(gates, name))
  const during = barrier('launch-1'); const relaunch = barrier('launch-2'); const firstRefute = barrier('refute-1'); const secondRefute = barrier('refute-2')
  const held = (b: ReturnType<typeof barrier>, answer: string) => `__barrier__ ${b.path}\n${answer}`
  const inferential = (location: string, axis = 'quality') => ({ ...grave, axis, location, evidence: 'inferential' })
  // Lanzamiento 1, en el orden de sus trabajos: base y lentes en dos lotes; risk-b1 falla y risk-b2 responde
  // dos veces algo inadmisible. Lanzamiento 2: solo esos dos. Después, la refutación en dos sub-tandas.
  const s = setup([
    firstRound([inferential('x/uno.txt:5')]), firstRound([inferential('y/dos.txt:5', 'spec')]),
    '__fail__', 'no es un JSON', 'tampoco es un JSON',
    held(during, NONE), NONE, NONE, NONE, NONE, NONE,
    held(relaunch, NONE), NONE,
    held(firstRefute, '{"candidate_hash":"$HASH","results":[{"id":"F-1","result":"inconclusive","evidence":"x/uno.txt:5"}]}'),
    held(secondRefute, '{"candidate_hash":"$HASH","results":[{"id":"F-2","result":"refuted","evidence":"y/dos.txt:5"}]}'),
  ])
  // La proyección se publica en estas pruebas: el entorno de la fixture la trae apagada.
  delete s.env.SDD_AI_PROJECTION
  const releaseAll = () => { for (const b of [during, relaunch, firstRefute, secondRefute]) b.release() }
  try {
    mkdirSync(join(s.repo, 'x'))
    mkdirSync(join(s.repo, 'y'))
    writeFileSync(join(s.repo, 'x', 'uno.txt'), bulky())
    writeFileSync(join(s.repo, 'y', 'dos.txt'), bulky())
    git(s.repo, 'add', '-N', 'x/uno.txt', 'y/dos.txt')

    // Dos revisiones de un binario anterior: sin resumen de avance, sus conteos quedan desconocidos.
    const legacyRunning = join(s.repo, '.sdd-ai', 'runs', '20260101-0000-0001')
    fixtureJson(join(legacyRunning, 'request.json'), { kind: 'review', session: 'legacy' })
    fixtureJson(join(legacyRunning, 'status.json'), { state: 'running', round: 1, launch: 1,
      job: { phase: 'review', key: 'base-b1', reviewer: 'base', batch: 1, index: 3, total: 5 } })
    const legacyDone = join(s.repo, '.sdd-ai', 'runs', '20260101-0000-0002')
    fixtureJson(join(legacyDone, 'request.json'), { kind: 'review', session: 'legacy' })
    fixtureJson(join(legacyDone, 'status.json'), { state: 'unavailable', round: 1 })
    fixtureJson(join(legacyDone, 'rounds.json'), { rounds: [{ n: 1, state: 'unavailable' }] })

    const started = cli(s, ['review', 'start', '--base', s.base, '--author', 'codex', '--risk', 'high'])
    assert.equal(started.code, 0, JSON.stringify(started.out))
    const id: string = started.out.id
    assert.deepEqual(started.out.batches, [{ n: 1, paths: ['x/uno.txt'] }, { n: 2, paths: ['y/dos.txt'] }])

    // Durante el lanzamiento 1: cuatro terminados, de los que solo dos quedaron admitidos.
    await during.arrived(30_000)
    let run = await projected(s.repo, id, (r) => r.progress.value?.active.value?.key === 'resilience-b1', 'el trabajo activo del lanzamiento 1')
    let p = progressOf(run)
    assert.deepEqual([run.kind.value, run.state.value, run.open.value, run.live.value], ['review', 'running', 'running', true])
    assert.deepEqual([p.phase, p.round, p.launch, p.total], ['review', 1, 1, 10])
    assert.deepEqual([...p.planned].sort(), ALL)
    assert.deepEqual(p.retained, [])
    assert.deepEqual(keys(p.completed), ['base-b1', 'base-b2', 'risk-b1', 'risk-b2'])
    assert.deepEqual(admitted(p.completed), ['base-b1', 'base-b2'], 'terminado no significa admitido')
    assert.equal(job(p.completed, 'risk-b1').state, 'launch_failed')
    assert.equal(job(p.completed, 'risk-b1').admission.value, null)
    assert.equal(job(p.completed, 'risk-b1').admission.reason?.code, 'not_admitted')
    assert.deepEqual([job(p.completed, 'risk-b2').state, job(p.completed, 'risk-b2').admission.value], ['unavailable', 'inadmissible'])
    assert.deepEqual([job(p.completed, 'base-b1').state, job(p.completed, 'base-b1').launch], ['done', 1])
    assert.deepEqual([p.active.value?.reviewer.value, p.active.value?.batch.value], ['resilience', 1])
    // Un formato anterior no recibe conteos, ni los que sugiere el índice del trabajo activo.
    const document = latestProjection(s.repo)!
    for (const legacy of ['20260101-0000-0001', '20260101-0000-0002']) {
      const old = document.runs.items.find((r) => r.id === legacy)
      assert.ok(old, `falta la corrida anterior ${legacy}`)
      assert.deepEqual([old.progress.value, old.progress.reason?.code], [null, 'progress_unavailable'])
    }
    during.release()

    // Terminado el lanzamiento 1: el registro de la ronda da los diez terminados, con su admisión.
    await terminal(s, id)
    run = await projected(s.repo, id, (r) => r.state.value === 'unavailable', 'el final del lanzamiento 1')
    p = progressOf(run)
    assert.deepEqual([run.open.value, run.live.value, p.phase, p.launch, p.total, p.active.value], ['undelivered', false, 'review', 1, 10, null])
    assert.deepEqual(keys(p.completed), ALL)
    assert.deepEqual(admitted(p.completed), KEPT)
    assert.deepEqual([job(p.completed, 'risk-b1').admission.value, job(p.completed, 'risk-b2').admission.value], [null, 'inadmissible'])

    // Durante el lanzamiento 2: lo admitido se conserva del lanzamiento 1 y los dos que no quedaron vuelven a pendientes.
    const round = cli(s, ['review', 'round', id])
    assert.equal(round.code, 0, JSON.stringify(round.out))
    assert.deepEqual([round.out.round, round.out.launch, [...round.out.kept].sort()], [1, 2, KEPT])
    await relaunch.arrived(30_000)
    run = await projected(s.repo, id, (r) => r.progress.value?.launch === 2 && r.progress.value.active.value?.key === 'risk-b1', 'el lanzamiento 2')
    p = progressOf(run)
    assert.deepEqual([p.phase, p.round, p.launch, p.total], ['review', 1, 2, 10])
    assert.deepEqual([...p.planned].sort(), RETRIED)
    assert.deepEqual(keys(p.retained), KEPT)
    assert.ok(p.retained.every((j) => j.launch === 1 && j.state === 'done' && j.admission.value === 'admitted'))
    assert.deepEqual(p.completed, [], 'un reintento no suma al total ni cuenta como terminado antes de terminar')
    relaunch.release()

    // La refutación es otra fase, con su propio conjunto previsto: no se suma al progreso de la revisión.
    await firstRefute.arrived(30_000)
    run = await projected(s.repo, id, (r) => r.progress.value?.phase === 'refutation', 'la refutación')
    p = progressOf(run)
    assert.deepEqual([p.phase, p.round, p.launch, p.total, p.planned, p.retained, p.completed], ['refutation', 1, 2, 2, ['refute-s1', 'refute-s2'], [], []])
    assert.equal(p.active.value?.key, 'refute-s1')
    assert.equal(p.active.value?.reviewer.value, null)
    firstRefute.release()
    await secondRefute.arrived(30_000)
    run = await projected(s.repo, id, (r) => r.progress.value?.active.value?.key === 'refute-s2', 'la segunda sub-tanda')
    p = progressOf(run)
    assert.deepEqual(p.completed.map((j) => [j.key, j.launch, j.state, j.admission.value]), [['refute-s1', 2, 'done', 'admitted']])
    secondRefute.release()

    // Terminada la ronda: el registro del lanzamiento 2 y su plan, sin la refutación.
    await terminal(s, id)
    run = await projected(s.repo, id, (r) => r.state.value === 'done', 'el final del lanzamiento 2')
    p = progressOf(run)
    assert.deepEqual([p.phase, p.launch, p.total, p.active.value], ['review', 2, 10, null])
    assert.deepEqual(keys(p.retained), KEPT)
    assert.deepEqual(p.completed.map((j) => [j.key, j.launch, j.state, j.admission.value]).sort(), [['risk-b1', 2, 'done', 'admitted'], ['risk-b2', 2, 'done', 'admitted']])
    // El resumen del lanzamiento no queda en el estado terminal: el avance terminado sale del registro.
    assert.equal(runJson(s, id, 'status.json').progress, undefined)
    assert.equal(runJson(s, id, 'rounds.json').rounds.length, 2)
  } finally {
    releaseAll()
    await removeGates(gates)
  }
})
