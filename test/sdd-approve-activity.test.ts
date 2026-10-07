import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { main } from '../src/cli.ts'
import { REAL_DEPS } from '../src/sdd/approve-sync.ts'
import { gitDirs } from '../src/git.ts'
import { storeDir } from '../src/writer-store.ts'
import { accept, answer, barrierProcess, behind, cli, fixture, logged, snapshot, type Fixture } from './sdd-approve-fixture.ts'

const RUN = '20261006-1200-activity'
const phasePath = (f: Fixture) => join(f.dir, 'sdd-ai-phases.json')
/** Una corrida de fase en curso, ligada al proceso `pid` que el test mantiene vivo. */
function phase(f: Fixture, pid: number) {
  const dir = join(f.root, '.sdd-ai', 'runs', RUN)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ state: 'running', supervisor_pid: pid, worker_pid: pid }))
  writeFileSync(phasePath(f), JSON.stringify({ schema_version: 1, last_run: { id: RUN, step: 'specify' }, phases: {} }))
  return dir
}
/** Los insumos de las corridas del flujo: el registro de fases y los archivos regulares de la corrida de fase y del writer. */
function runInputs(f: Fixture): Record<string, { text: string; mtime: number }> {
  const out: Record<string, { text: string; mtime: number }> = {}
  const add = (file: string) => { if (lstatSync(file).isFile()) out[file] = { text: readFileSync(file, 'utf8'), mtime: lstatSync(file).mtimeMs } }
  if (existsSync(phasePath(f))) add(phasePath(f))
  for (const dir of [join(f.root, '.sdd-ai', 'runs', RUN), storeDir(f.root, RUN)]) {
    if (existsSync(dir)) for (const name of readdirSync(dir)) add(join(dir, name))
  }
  return out
}
/** Un writer de fase de `flow` cuyo grupo de procesos es el del proceso `pid`, líder de su grupo. */
function writer(f: Fixture, pid: number, flow = 'f') {
  const dir = storeDir(f.root, RUN)
  mkdirSync(dir, { recursive: true })
  const { gitDir, commonDir } = gitDirs(f.root)
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ id: RUN, base: 'a'.repeat(40), family: 'codex', prompt: 'fixture',
    checkout: { root: f.root, gitDir, commonDir }, request: { role: 'implement', conductor: 'claude', deadline_sec: 30 },
    preLaunch: {}, inventory: {}, runDir: { dev: 1, ino: 1 }, group: { pid, pgid: pid, lstart: null, argvHash: 'fixture' },
    phase: { flow, pending: ['T1'], inputs: {}, handoff_header: 'fixture' } }))
  return dir
}
/** Una cosecha terminal válida: el writer solo sigue abierto si su grupo vive. */
function harvest(dir: string) {
  writeFileSync(join(dir, 'harvest.json'), JSON.stringify({ state: 'done', base: 'a'.repeat(40), tree: 'b'.repeat(40), files: [],
    patchFile: join(dir, 'diff.patch'), flagged: [], runAltered: [], headMoved: false, endMark: true }))
}

const POSIX_ONLY = ['store-inaccessible', 'status-inaccessible', 'special', 'store-link']

/**
 * La corrida sigue viva. Primero cede el event loop: si approve hubiera matado el grupo, Node recoge al hijo
 * en la vuelta siguiente, y sin ceder quedaría zombi y la señal 0 al grupo seguiría teniendo éxito. En
 * win32 no hay grupos de procesos: se consulta el proceso.
 */
async function assertAlive(child: ChildProcess, label: string) {
  await sleep(50)
  assert.equal(child.exitCode, null, label)
  assert.equal(child.signalCode, null, label)
  process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 0)
}

test('actividad activa o incierta impide registrar o recuperar con su codigo y permite reintentar con la misma respuesta', async (t) => {
  for (const recovery of [false, true]) {
    for (const kind of ['phase', 'writer', 'writer-group', 'phases-invalid', 'store-inaccessible', 'status-inaccessible', 'control-invalid', 'membership', 'harvest', 'special', 'store-link', 'control-id']) {
      // Un solo test, sin subtests: con subtests el padre falla como subtestsFailed y verify no puede
      // confirmar la reversión (verify.ts, confirmationOutcome). Por eso los casos POSIX no se omiten con
      // t.skip, que marcaría el test entero: en win32 quedan como diagnóstico visible en el TAP.
      const label = `${recovery ? 'recuperación' : 'registro'} ${kind}`
      if (process.platform === 'win32' && POSIX_ONLY.includes(kind)) {
        t.diagnostic(`${label}: omitido, requiere permisos y rutas POSIX`)
        continue
      }
      const f = fixture()
      let restore = () => {}
      let alive: Awaited<ReturnType<typeof barrierProcess>> | undefined
      try {
        alive = await barrierProcess(f.sessionDir)
        const pid = alive.child.pid!
        if (recovery) { accept(f, 'spec'); behind(f) } else answer(f, 'spec')
        let route: string, code = 'activity_unknown'
        // Lo que vuelve inaccesible una ruta corre después de tomar los insumos, para poder compararlos.
        let lockdown = () => {}
        switch (kind) {
          case 'phase': route = join(phase(f, pid), 'status.json'); code = 'phase_running'; break
          case 'writer': route = join(writer(f, pid), 'control.json'); code = 'writer_open'; break
          case 'writer-group': { const dir = writer(f, pid); harvest(dir); route = join(dir, 'control.json'); code = 'writer_open'; break }
          case 'phases-invalid': route = phasePath(f); writeFileSync(route, '{'); break
          case 'status-inaccessible': {
            assert.notEqual(process.getuid?.(), 0, 'V8 requiere un usuario POSIX sin privilegios root para comprobar EACCES')
            const dir = phase(f, pid); route = join(dir, 'status.json')
            lockdown = () => { chmodSync(dir, 0); restore = () => chmodSync(dir, 0o700) }
            break
          }
          case 'store-inaccessible': {
            assert.notEqual(process.getuid?.(), 0, 'V8 requiere un usuario POSIX sin privilegios root para comprobar EACCES')
            const dir = dirname(writer(f, pid)); route = dir
            lockdown = () => { chmodSync(dir, 0); restore = () => chmodSync(dir, 0o700) }
            break
          }
          case 'special': route = phasePath(f); execFileSync('mkfifo', [route]); break
          case 'control-invalid': route = join(writer(f, pid), 'control.json'); writeFileSync(route, '{'); break
          case 'membership': route = join(writer(f, pid), 'control.json'); writeFileSync(route, JSON.stringify({ id: RUN, phase: {} })); break
          case 'harvest': route = join(writer(f, pid), 'harvest.json'); writeFileSync(route, '{'); break
          case 'store-link': {
            // El almacén del writer es un enlace: no se sigue, y tampoco se toma por ausencia.
            const real = writer(f, pid), moved = `${real}-real`
            renameSync(real, moved); symlinkSync(moved, real); route = real
            break
          }
          case 'control-id': {
            route = join(writer(f, pid), 'control.json')
            writeFileSync(route, readFileSync(route, 'utf8').replace(`"id":"${RUN}"`, '"id":"otra-corrida"'))
            break
          }
          default: throw new Error(`caso desconocido: ${kind}`)
        }
        const before = snapshot(f)
        const inputs = runInputs(f)
        lockdown()
        const r = cli(f, 'approve', 'f', 'spec')
        assert.equal(r.code, 2, `${label}: ${JSON.stringify(r.out)}`)
        assert.equal(r.out.code, code, `${label}: ${JSON.stringify(r.out)}`)
        if (code === 'activity_unknown') {
          assert.ok(r.out.detail.startsWith(`${route}: `), `${label}: ${JSON.stringify(r.out)}`)
          assert.ok(!r.out.detail.startsWith(`${route}: ${route}`), `${label}: la ruta no se repite: ${r.out.detail}`)
          assert.match(r.out.next, /repite sdd approve/)
        } else { assert.equal(r.out.next, `./bin/sdd-ai wait ${RUN}`); assert.match(r.out.message, new RegExp(RUN)) }
        assert.deepEqual(snapshot(f), before, label)
        // La corrida sigue viva: su proceso es el que el status o el grupo del control nombran.
        await assertAlive(alive.child, label)
        restore(); restore = () => {}
        // Ningún rechazo toca la ruta nombrada ni los insumos de la corrida.
        assert.deepEqual(runInputs(f), inputs, label)
        rmSync(phasePath(f), { force: true })
        rmSync(join(f.root, '.sdd-ai', 'runs', RUN), { recursive: true, force: true })
        rmSync(dirname(storeDir(f.root, RUN)), { recursive: true, force: true })
        await alive.release()
        const entries = logged(f)
        assert.equal(cli(f, 'approve', 'f', 'spec').code, 0, `${label}: el reintento acepta la misma respuesta o recupera sin preguntar`)
        assert.equal(logged(f).length, recovery ? entries.length : entries.length + 1, label)
      } finally { restore(); if (alive && alive.child.exitCode === null) await alive.release(); f.cleanup() }
    }
  }
  // Los controles legibles ajenos al flujo no bloquean ni se modifican: el de otro flujo, y uno sin fase
  // ni rol de implement (un writer relanzado o de otro formato).
  for (const shape of ['other-flow', 'no-phase']) {
    const other = fixture()
    try {
      const dir = writer(other, 999999, 'other')
      if (shape === 'no-phase') writeFileSync(join(dir, 'control.json'), JSON.stringify({ id: RUN, family: 'claude', request: { role: 'explore' } }))
      const original = readFileSync(join(dir, 'control.json'), 'utf8')
      harvest(dir)
      accept(other, 'spec')
      assert.equal(readFileSync(join(dir, 'control.json'), 'utf8'), original, shape)
    } finally { other.cleanup() }
  }
  // Una corrida de fase registrada que ya no está en disco (por ejemplo, podada) no está activa.
  const pruned = fixture()
  try {
    writeFileSync(phasePath(pruned), JSON.stringify({ schema_version: 1, last_run: { id: RUN, step: 'specify' }, phases: {} }))
    accept(pruned, 'spec')
  } finally { pruned.cleanup() }
})

test('actividad sobrevenida deja la decision registrada pendiente y conserva los insumos vivos', async () => {
  for (const afterHandoff of [false, true]) {
    for (const kind of ['phase', 'writer', 'unknown']) {
      const f = fixture()
      let alive: Awaited<ReturnType<typeof barrierProcess>> | undefined
      try {
        alive = await barrierProcess(f.sessionDir)
        const pid = alive.child.pid!
        accept(f, 'spec'); behind(f); answer(f, 'plan-tasks')
        const at = logged(f)[0].at
        const introduce = () => {
          if (kind === 'phase') phase(f, pid)
          else if (kind === 'writer') writer(f, pid)
          else writeFileSync(phasePath(f), '{')
        }
        let introduced = false
        let frozen: ReturnType<typeof snapshot> | undefined
        let inputs: ReturnType<typeof runInputs> | undefined
        const r = await main(['sdd', 'approve', 'f', 'plan-tasks'], f.env, f.root, { approve: { ...REAL_DEPS,
          writeJson: (file, data) => {
            REAL_DEPS.writeJson(file, data)
            if (!afterHandoff) { introduce(); introduced = true; frozen = snapshot(f); inputs = runInputs(f) }
          },
          writeText: (file, text) => {
            REAL_DEPS.writeText(file, text)
            if (afterHandoff && file.endsWith('handoff.md')) { introduce(); introduced = true; frozen = snapshot(f); inputs = runInputs(f) }
          },
        } })
        const out = r.out as any
        assert.ok(introduced)
        assert.equal(r.code, 3)
        assert.equal(out.state, 'sync_pending')
        assert.equal(out.code, 'approval_sync_pending')
        assert.equal(out.approval_registered, true)
        assert.equal(out.at, logged(f).at(-1)!.at)
        assert.equal(out.recovery_command, './bin/sdd-ai sdd approve f plan-tasks')
        assert.ok(out.status)
        const expected = [{ path: '.plans/f/handoff.md', field: 'spec_approved_at', expected: at, current: null },
          { path: '.plans/f/plan.md', field: 'status', expected: 'tasks-ready', current: 'planned' }]
        assert.deepEqual(out.pending_headers, afterHandoff ? expected.slice(1) : expected)
        assert.deepEqual(snapshot(f), frozen)
        // Los insumos congelados de la corrida no cambian: ni bytes ni mtimes.
        assert.ok(Object.keys(inputs!).length > 0, kind)
        assert.deepEqual(runInputs(f), inputs, kind)
        // La corrida sigue viva: su proceso es el que el status o el grupo del control nombran.
        await assertAlive(alive.child, kind)
      } finally { if (alive) await alive.release(); f.cleanup() }
    }
  }
})
