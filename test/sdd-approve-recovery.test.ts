import assert from 'node:assert/strict'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.ts'
import { approve } from '../src/sdd/approve.ts'
import { type ApproveDeps, ApprovalSyncPending, REAL_DEPS } from '../src/sdd/approve-sync.ts'
import { LOCK_FILE, readFlow } from '../src/sdd/read.ts'
import { SddError } from '../src/types.ts'
import { accept, answer, behind, cli, fixture, logged, snapshot, SPEC } from './sdd-approve-fixture.ts'
import { readHeader } from '../src/sdd/markdown.ts'

const data = (file: string) => { const h = readHeader(readFileSync(file, 'utf8')); assert.ok(h.ok); return h.data }

test('los fallos de cada escritura respetan registro antes de headers y recuperan sin duplicar', async () => {
  const failure = () => { throw new SddError('injected_failure', 'fallo controlado') }
  // Qué escritura de header falla en cada punto; los demás puntos fallan antes o después de los headers.
  const failingHeader: Record<string, string | null> = { activity: null, register: null, 'after-register': null, handoff: 'handoff.md', plan: 'plan.md' }
  for (const point of Object.keys(failingHeader)) {
    const f = fixture()
    try {
      accept(f, 'spec'); behind(f); answer(f, 'plan-tasks')
      const before = snapshot(f), previous = logged(f)
      let registered = false
      const deps: ApproveDeps = { ...REAL_DEPS,
        activity: (root, id) => {
          if (point === 'activity' || (point === 'after-register' && registered)) failure()
          REAL_DEPS.activity(root, id)
        },
        writeJson: (file, data) => {
          if (point === 'register') failure()
          REAL_DEPS.writeJson(file, data); registered = true
        },
        writeText: (file, text) => {
          if (failingHeader[point] !== null && file.endsWith(failingHeader[point]!)) failure()
          REAL_DEPS.writeText(file, text)
        },
      }
      const response = await main(['sdd', 'approve', 'f', 'plan-tasks', '--conductor', 'claude'], f.env, f.root, { approve: deps })
      const out = response.out as any
      if (point === 'activity' || point === 'register') {
        assert.equal(response.code, 2)
        assert.equal(out.code, 'injected_failure')
        assert.deepEqual(snapshot(f), before)
        continue
      }
      assert.equal(response.code, 3, point)
      const entries = logged(f), entry = entries.at(-1)!
      assert.deepEqual(entries.slice(0, previous.length), previous)
      assert.equal(out.state, 'sync_pending')
      assert.equal(out.code, 'approval_sync_pending')
      assert.equal(out.approval_registered, true)
      assert.equal(out.at, entry.at)
      assert.equal(out.recovery_command, './bin/sdd-ai sdd approve f plan-tasks --conductor claude')
      const expected = [{ path: '.plans/f/handoff.md', field: 'spec_approved_at', expected: previous[0].at, current: null },
        { path: '.plans/f/plan.md', field: 'status', expected: 'tasks-ready', current: 'planned' }]
      assert.deepEqual(out.pending_headers, point === 'plan' ? expected.slice(1) : expected)
      assert.ok(out.status)
      const state = cli(f, 'status', 'f').out
      assert.ok(state.gates.every((g: any) => g.state !== 'approved_unfingerprinted'))
      assert.ok(state.notes.some((n: any) => n.code === 'header_behind'))
      assert.equal(readFileSync(join(f.dir, 'plan.md'), 'utf8'), before['plan.md']!.text)
      if (point === 'after-register') {
        const failed = snapshot(f)
        const retry = await main(['sdd', 'approve', 'f', 'plan-tasks'], f.env, f.root, { approve: { ...REAL_DEPS, writeText: failure } })
        assert.equal(retry.code, 3)
        assert.equal((retry.out as any).code, 'approval_sync_pending')
        assert.equal((retry.out as any).recovery_command, './bin/sdd-ai sdd approve f plan-tasks')
        assert.deepEqual((retry.out as any).pending_headers, expected)
        assert.deepEqual(snapshot(f), failed)
      }
      const partial = snapshot(f)
      const noProof = () => { throw new Error('no se debe preguntar en recuperación') }
      const result = approve(f.root, 'f', 'plan-tasks', new Date(), readFlow, noProof, f.env)
      assert.ok(result.gates.every((g) => g.state === 'approved'))
      assert.deepEqual(logged(f), entries)
      if (point === 'plan') assert.deepEqual(snapshot(f)['handoff.md'], partial['handoff.md'])
      const synced = snapshot(f)
      assert.equal(cli(f, 'approve', 'f', 'plan-tasks').code, 0)
      assert.deepEqual(snapshot(f), synced)
      writeFileSync(join(f.dir, 'plan.md'), synced['plan.md']!.text + '\nCambio sustantivo.\n')
      assert.equal(cli(f, 'approve', 'f', 'plan-tasks').out.code, 'approval_missing')
    } finally { f.cleanup() }
  }
  // Fecha anterior que ya acredita spec: la pendiente no depende de header_behind.
  const dated = fixture()
  try {
    accept(dated, 'spec')
    const at = logged(dated)[0].at
    writeFileSync(join(dated.dir, 'spec.md'), SPEC + '\nNueva versión.\n')
    answer(dated, 'spec')
    const r = await main(['sdd', 'approve', 'f', 'spec'], dated.env, dated.root, { approve: { ...REAL_DEPS, writeText: failure } })
    assert.equal(r.code, 3)
    assert.equal((r.out as any).pending_headers[0].current, at)
    assert.ok(!cli(dated, 'status', 'f').out.notes.some((n: any) => n.code === 'header_behind'))
    const entries = logged(dated)
    assert.equal(cli(dated, 'approve', 'f', 'spec').code, 0)
    // La recuperación completa la fecha nueva sin agregar entradas.
    assert.deepEqual(logged(dated), entries)
    assert.equal(data(join(dated.dir, 'handoff.md')).spec_approved_at, entries.at(-1)!.at)
    assert.notEqual(entries.at(-1)!.at, at)
  } finally { dated.cleanup() }
  // Cambio ajeno entre headers detiene el siguiente; no revierte handoff.
  const changed = fixture()
  try {
    accept(changed, 'spec'); behind(changed); answer(changed, 'plan-tasks')
    const r = await main(['sdd', 'approve', 'f', 'plan-tasks'], changed.env, changed.root, { approve: { ...REAL_DEPS,
      writeText: (file, text) => { REAL_DEPS.writeText(file, text); writeFileSync(join(changed.dir, 'tasks.md'), '# Tasks\n\n- [ ] **T1 — cambió** · cubre: AC-1\n') },
    } })
    assert.equal(r.code, 3)
    assert.deepEqual((r.out as any).pending_headers, [{ path: '.plans/f/plan.md', field: 'status', expected: 'tasks-ready', current: 'planned' }])
    assert.equal(cli(changed, 'status', 'f').out.next.gate, 'plan-tasks')
  } finally { changed.cleanup() }
  // Todas las escrituras completas, pero confirmación incierta y sin flujo releíble.
  const gone = fixture()
  try {
    answer(gone, 'spec')
    const moved = `${gone.dir}-moved`
    const r = await main(['sdd', 'approve', 'f', 'spec'], gone.env, gone.root, { approve: { ...REAL_DEPS,
      writeText: (file, text) => { REAL_DEPS.writeText(file, text); renameSync(gone.dir, moved) },
    } })
    assert.equal(r.code, 3)
    assert.equal((r.out as any).status, null)
    assert.deepEqual((r.out as any).pending_headers, [])
    renameSync(moved, gone.dir)
    // El lock viajó con el directorio renombrado: withLock no lo encontró al soltarlo.
    rmSync(join(gone.dir, LOCK_FILE), { force: true })
    const saved = snapshot(gone)
    // La confirmación final es la última lectura, la que sigue a la última comprobación de actividad. En
    // vez de fijar cuántas hay, una corrida sin fallos las cuenta y comprueba que tras la última viene
    // una sola lectura; la corrida con fallo rompe justo esa.
    let checks = 0, reads = 0, readsAfterLast = 0
    const counted = (inject: number | null): { deps: ApproveDeps; read: typeof readFlow } => ({
      deps: { ...REAL_DEPS, activity: (root, id) => { checks++; readsAfterLast = 0; REAL_DEPS.activity(root, id) } },
      read: (root, id) => {
        reads++; readsAfterLast++
        if (inject !== null && checks === inject) throw new SddError('read_failed', 'confirmación final no disponible')
        return readFlow(root, id)
      },
    })
    const clean = counted(null)
    approve(gone.root, 'f', 'spec', new Date(), clean.read, failure, gone.env, undefined, clean.deps)
    const total = checks, totalReads = reads
    assert.ok(total > 0)
    assert.equal(readsAfterLast, 1, 'tras la última comprobación de actividad solo queda la confirmación final')
    assert.deepEqual(snapshot(gone), saved)
    checks = 0; reads = 0
    const faulty = counted(total)
    assert.throws(() => approve(gone.root, 'f', 'spec', new Date(), faulty.read, failure, gone.env, undefined, faulty.deps),
      (e: unknown) => e instanceof SddError && !(e instanceof ApprovalSyncPending) && e.code === 'read_failed')
    // Rompió la misma lectura que en la corrida sin fallos era la última: la confirmación final.
    assert.equal(reads, totalReads)
    assert.deepEqual(snapshot(gone), saved)
  } finally { gone.cleanup() }
  // Todas las escrituras completas, pero la confirmación final ve un cambio ajeno (tasks.md): no queda
  // ningún campo por escribir, así que la pendiente va con la lista vacía y el detalle de la incertidumbre.
  const uncertain = fixture()
  try {
    answer(uncertain, 'spec')
    const r = await main(['sdd', 'approve', 'f', 'spec'], uncertain.env, uncertain.root, { approve: { ...REAL_DEPS,
      writeText: (file, text) => { REAL_DEPS.writeText(file, text); writeFileSync(join(uncertain.dir, 'tasks.md'), '# Tasks\n\n- [ ] **T1 — cambio ajeno** · cubre: AC-1\n') },
    } })
    assert.equal(r.code, 3)
    assert.deepEqual((r.out as any).pending_headers, [])
    assert.match((r.out as any).detail, /cambiaron/)
  } finally { uncertain.cleanup() }
})
