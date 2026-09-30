import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chainFlow, chainSetup, runBin } from './helpers.ts'

// Caracterizadores: lo que ya funcionaba antes de las cadenas de writers tiene que seguir igual. Corren
// verdes sobre la base y sobre la versión nueva.

const promptFile = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(file, 'Encargo de prueba.\n')
  return file
}

test('conserva formatos y operaciones anteriores independientes', () => {
  // Un writer suelto con cambios: la cosecha propone la revisión, como siempre.
  const loose = chainSetup({ writers: [{ actions: [{ write: 'src/b.ts', content: 'export const b = 1\n' }] }] })
  const run = runBin(loose, ['run', '--role', 'implement', '--prompt-file', promptFile()])
  assert.equal(run.code, 0, JSON.stringify(run.out))
  const w = runBin(loose, ['wait', run.out.id, '--max', '30'])
  assert.deepEqual([w.code, w.out.state, w.out.failed ?? []], [0, 'done', []])
  assert.match(w.out.next, new RegExp(`review start --harvest ${run.out.id} --base ${loose.base} --author codex$`))

  // Un writer suelto sin cambios se relanza con run --retry, que crea otra corrida.
  const empty = chainSetup({ writers: [{}, {}] })
  const first = runBin(empty, ['run', '--role', 'implement', '--prompt-file', promptFile()])
  const e = runBin(empty, ['wait', first.out.id, '--max', '30'])
  assert.match(e.out.next, new RegExp(`run --retry ${first.out.id}$`))
  const retry = runBin(empty, ['run', '--retry', first.out.id])
  assert.equal(retry.code, 0, JSON.stringify(retry.out))
  assert.notEqual(retry.out.id, first.out.id)
  assert.equal(runBin(empty, ['wait', retry.out.id, '--max', '30']).out.state, 'done')

  // Un registro de fases sin la clave nueva se lee, y el flujo sigue a implement con el verbo de la fase.
  const flow = chainSetup()
  chainFlow(flow)
  const phases = join(flow.repo, '.plans', 'f', 'sdd-ai-phases.json')
  writeFileSync(phases, `${JSON.stringify({ schema_version: 1, last_run: null, phases: {} })}\n`)
  const planBefore = readFileSync(join(flow.repo, '.plans', 'f', 'plan.md'), 'utf8')
  const st = runBin(flow, ['sdd', 'status', 'f'])
  assert.equal(st.code, 0, JSON.stringify(st.out))
  assert.deepEqual(st.out.gates.map((g: { state: string }) => g.state), ['approved', 'approved', 'approved'])
  assert.deepEqual([st.out.next.step, st.out.next.command], ['implement', './bin/sdd-ai sdd phase f'])
  // Consultar no reescribe el header del plan ni el registro.
  assert.equal(readFileSync(join(flow.repo, '.plans', 'f', 'plan.md'), 'utf8'), planBefore)
  assert.deepEqual(JSON.parse(readFileSync(phases, 'utf8')), { schema_version: 1, last_run: null, phases: {} })

  // Un writer de fase activo al adoptar el cambio, con el control sin kind y el registro sin implement: su
  // contrato sin completion se admite igual, y su cosecha, sin entries ni delta, se sigue consultando.
  const go = join(mkdtempSync(join(tmpdir(), 'sdd-ai-go-')), 'seguir')
  const old = chainSetup({ writers: [{ waitFor: go, actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: OLD_REPORT }] })
  chainFlow(old)
  const phase = runBin(old, ['sdd', 'phase', 'f'])
  assert.equal(phase.code, 0, JSON.stringify(phase.out))
  const store = join(old.repo, '.git', 'sdd-ai', 'runs', phase.out.id)
  const control = JSON.parse(readFileSync(join(store, 'control.json'), 'utf8'))
  const { flow: f, pending, inputs, handoff_header } = control.phase
  writeFileSync(join(store, 'control.json'), JSON.stringify({ ...control, phase: { flow: f, pending, inputs, handoff_header } }))
  const oldPhases = join(old.repo, '.plans', 'f', 'sdd-ai-phases.json')
  const { implement: _implement, ...oldRecord } = JSON.parse(readFileSync(oldPhases, 'utf8'))
  writeFileSync(oldPhases, JSON.stringify(oldRecord))
  writeFileSync(go, '')
  const harvested = runBin(old, ['wait', phase.out.id, '--max', '30'])
  assert.deepEqual([harvested.out.state, harvested.out.contract], ['done', { admitted: true, missing_context: [] }], JSON.stringify(harvested.out))
  // Su control no trae el digest del registro: reescribir el registro no cuenta como un cambio de sus insumos.
  assert.ok(!(harvested.out.failed ?? []).some((x: string) => /insumos/.test(x)), JSON.stringify(harvested.out.failed))
  const harvestFile = join(store, 'harvest.json')
  const { entries: _entries, delta: _delta, ...oldHarvest } = JSON.parse(readFileSync(harvestFile, 'utf8'))
  writeFileSync(harvestFile, JSON.stringify(oldHarvest))
  assert.deepEqual(runBin(old, ['wait', phase.out.id, '--max', '30']).out.contract, { admitted: true, missing_context: [] })
  // Un recibo sin toma: con las tasks marcadas, verify corre sobre ese árbol y su verde deja el flujo listo para revisar.
  const tasks = join(old.repo, '.plans', 'f', 'tasks.md')
  writeFileSync(tasks, readFileSync(tasks, 'utf8').replaceAll('- [ ]', '- [x]'))
  const verified = runBin(old, ['sdd', 'verify', 'f'])
  assert.equal(verified.out.green, true, JSON.stringify(verified.out))
  const receipt = JSON.parse(readFileSync(join(old.repo, '.git', 'sdd-ai', 'verify', verified.out.receipt, 'receipt.json'), 'utf8'))
  assert.equal(receipt.writer?.takeover, undefined)
  assert.equal(runBin(old, ['sdd', 'status', 'f']).out.next.step, 'review_and_commit')
})

/** El contrato de implement de antes de las cadenas: sin completion por task. */
const OLD_REPORT = `Hice el cambio.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: [{ id: 'T1', change_kind: 'behavior_change', changed: 'f devuelve 2', deviation: null, check: 'V1' }] })}\n\nSTATUS: done\n`
