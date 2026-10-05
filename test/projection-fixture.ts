import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gitDirs } from '../src/git.ts'
import { ensureIgnore } from '../src/runs.ts'
import { available, known, OBSERVATION_NAME, unknown } from '../src/projection-types.ts'
import type { Projection, ProjectionFlow, ProjectionObservation, ProjectionRun, ProjectionRunState } from '../src/projection-types.ts'
import type { ProjectionStage } from '../src/projection.ts'
import type { WriterControl } from '../src/writer-store.ts'

export const TEST_BOOT = '11111111-1111-1111-1111-111111111111'
export const OTHER_BOOT = '22222222-2222-2222-2222-222222222222'
export const TEST_TIME = 1_759_680_000_000

export function observation(m0 = 100_000_000_000n, boot = TEST_BOOT, suffix = 'a'.repeat(32)): ProjectionObservation {
  const stamp = m0.toString().padStart(20, '0')
  return { id: `obs-${stamp}-${boot}-${process.pid}-${suffix}.json`, m0: stamp, boot,
    publisher: { pid: process.pid, kind: 'unknown' }, observed_at: TEST_TIME, read_finished_at: TEST_TIME }
}

export function projectionDocument(root: string, stamp: ProjectionObservation = observation()): Projection {
  return { schema_version: 1, checkout: { id: createHash('sha256').update(root).digest('hex'), root }, observation: { ...stamp },
    runs: available([]), writer: { availability: 'available', reason: null, item: null }, flows: available([]), bindings: available([]), omissions: [] }
}

export function projectionRun(id: string, overrides: Partial<ProjectionRun> = {}): ProjectionRun {
  return { id, availability: 'available', reason: null, kind: known('worker'), state: known('running'), open: known('running'),
    session: unknown('not_recorded', 'La corrida no registra sesión.'), flow: unknown('not_recorded', 'La corrida no registra flujo.'),
    live: known(true), progress: unknown('not_applicable', 'No es una revisión.'), ...overrides }
}

export function projectionFlow(id: string, overrides: Partial<ProjectionFlow> = {}): ProjectionFlow {
  return { id, availability: 'available', reason: null, observed_at: TEST_TIME, status: known('planned'),
    view: known({ id, depth: 'completa', gates: [{ gate: 'spec', artifacts: ['spec.md'], state: 'pending' }],
      tasks: { total: 1, done: 0, pending: 1, first_pending: 'T1 — tarea' }, next: { step: 'gate', gate: 'spec', artifacts: ['spec.md'] },
      blocked_reasons: [], notes: [], paths: { dir: `.plans/${id}` } }), ...overrides }
}

export function fixtureJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value) + '\n')
}

/** Constructor de un checkout real y sus worktrees; nunca usa el checkout que ejecuta la suite. */
export function projectionFixture() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-projection-')))
  const root = join(scratch, 'checkout')
  mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()
  git('init', '-q')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture')
  mkdirSync(join(root, '.sdd-ai'))
  const base = git('rev-parse', 'HEAD')
  const children = new Set<ReturnType<typeof spawn>>()
  return {
    root, scratch, base,
    worktree(name = 'linked') {
      const path = join(scratch, name)
      git('worktree', 'add', '--detach', path, 'HEAD')
      mkdirSync(join(path, '.sdd-ai'))
      return path
    },
    run(id: string, request: object = {}, state: ProjectionRunState = 'running', checkout = root) {
      const dir = join(checkout, '.sdd-ai', 'runs', id)
      fixtureJson(join(dir, 'request.json'), { role: 'explore', kind: 'worker', ...request })
      fixtureJson(join(dir, 'status.json'), { state })
      return dir
    },
    writer(id: string, state: ProjectionRunState = 'running', session?: string, flow?: string, checkout = root) {
      const dirs = gitDirs(checkout)
      const run = join(checkout, '.sdd-ai', 'runs', id)
      mkdirSync(run, { recursive: true })
      // Como `createRun` al lanzar al writer: el almacén ya está ignorado cuando se toma su inventario.
      ensureIgnore(join(checkout, '.sdd-ai'))
      const st = statSync(run)
      const control: WriterControl = { id, base, family: 'codex', prompt: 'Contenido privado del encargo.',
        ...(session ? { session } : {}), checkout: { root: checkout, ...dirs },
        request: { role: 'implement', conductor: { family: 'codex' }, deadline_sec: 30 }, preLaunch: {}, inventory: {}, runDir: { dev: st.dev, ino: st.ino },
        ...(flow ? { phase: { flow, pending: ['T1'], inputs: {}, handoff_header: 'sha256:' + 'a'.repeat(64) } } : {}) }
      const store = join(dirs.gitDir, 'sdd-ai', 'runs', id)
      fixtureJson(join(store, 'control.json'), control)
      fixtureJson(join(store, 'status.json'), { state })
      return { store, run, control }
    },
    binding(session: string, flow: string | null, checkout = root) {
      fixtureJson(join(checkout, '.sdd-ai', 'hooks', 'route', `${session}.json`), {
        calls: 0, reads: 0, edits: 0, seen: [], snapshot_pending: [],
        ...(flow === null ? {} : { flow: { id: flow, step: 'implement', gate: null, at: new Date(TEST_TIME).toISOString() } }),
      })
    },
    flow(id: string, status = 'planned', checkout = root) {
      const dir = join(checkout, '.plans', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** Caso de prueba. (pedido)\n')
      writeFileSync(join(dir, 'tasks.md'), '# Tasks\n\n- [ ] **T1 — tarea** · cubre: AC-1\n')
      writeFileSync(join(dir, 'handoff.md'), '---\nprofundidad: completa\nbranch: feature/fixture\n---\n\n# Handoff\n')
      writeFileSync(join(dir, 'plan.md'), `---\nid: ${id}\nbranch: feature/fixture\nbase_commit: ${base}\nchange_type: feat\nprofundidad: completa\nrisk: low\nstatus: ${status}\ncreated_at: 2026-10-05T00:00:00Z\n---\n\n# Plan\n\n## Enfoque\n\nCaso de prueba.\n\n## Verification\n\nInspección.\n`)
      return dir
    },
    barrier(name: string) { return projectionBarrier(join(scratch, name)) },
    start(script: string) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      let stdout = ''; let stderr = ''
      child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
      const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve) => {
        child.once('error', (e) => { clearTimeout(timeout); children.delete(child); resolve({ code: null, signal: null, stdout, stderr: stderr + e.message }) })
        child.once('close', (code, signal) => { clearTimeout(timeout); children.delete(child); resolve({ code, signal, stdout, stderr }) })
      })
      return { child, done }
    },
    dispose() {
      for (const child of children) child.kill('SIGKILL')
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

export function projectionBarrier(path: string) {
  return {
    path,
    async arrived(timeout = 10000) {
      const until = Date.now() + timeout
      while (!existsSync(`${path}.arrived`)) {
        if (Date.now() >= until) throw new Error(`no llegó a la barrera ${path}`)
        await sleep(10)
      }
    },
    release() { writeFileSync(`${path}.release`, '') },
  }
}

/**
 * Script de un publicador que el padre puede detener y reanudar sin modificar el código del producto. Con `requested`
 * atiende un pedido con ese reloj, como `__publish`: reserva o cede. Con `systemBoot`, usa el arranque real de la
 * máquina, el mismo que un `__publish` lanzado aparte.
 */
export function publicationScript(root: string, source: string, options: { barrier?: string; stage?: ProjectionStage; offset?: string; m0?: string; requested?: bigint; systemBoot?: boolean } = {}): string {
  return `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { publishProjection } from ${JSON.stringify(new URL('../src/projection.ts', import.meta.url).href)};
    import { projectionDocument, projectionRun, TEST_BOOT } from ${JSON.stringify(import.meta.url)};
    const root = ${JSON.stringify(root)}, source = ${JSON.stringify(source)};
    const barrier = ${JSON.stringify(options.barrier ?? null)}, offset = ${JSON.stringify(options.offset ?? null)};
    const fixed = ${JSON.stringify(options.m0 ?? null)};
    const requested = ${JSON.stringify(options.requested?.toString() ?? null)};
    let tick = fixed === null ? 0n : BigInt(fixed) - 2n;
    const result = publishProjection(root, (root, observation) => {
      const document = projectionDocument(root, observation);
      document.runs.items = JSON.parse(readFileSync(source, 'utf8')).map(id => projectionRun(id));
      return document;
    }, { ...(${options.systemBoot === true} ? {} : { boot: () => TEST_BOOT }), ...(requested === null ? {} : { requested: BigInt(requested) }),
      monotonic: () => fixed === null ? process.hrtime.bigint() + (offset ? BigInt(readFileSync(offset, 'utf8')) : 0n) : ++tick,
      stage: (stage, context) => {
        if (barrier && context.attempt === 1 && stage === ${JSON.stringify(options.stage ?? 'observed')}) {
          writeFileSync(barrier + '.arrived', String(process.pid));
          const until = Date.now() + 30000;
          while (!existsSync(barrier + '.release')) {
            if (Date.now() > until) throw new Error('barrera vencida');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
      }
    });
    console.log(JSON.stringify(result));
    if (result.kind !== 'published') process.exitCode = 1;`
}

/** Lector del contrato para las pruebas: no consulta request, status, ledger ni control. */
export function latestProjection(root: string): Projection | null {
  const live = join(root, '.sdd-ai', 'projection', 'live')
  if (!existsSync(live)) return null
  const names = readdirSync(live)
  if (names.length > 256) return null
  for (const name of names.filter((name) => OBSERVATION_NAME.test(name)).sort().reverse()) {
    const path = join(live, name)
    try {
      const st = lstatSync(path)
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('observación irregular')
      return JSON.parse(readFileSync(path, 'utf8')) as Projection
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  return null
}
