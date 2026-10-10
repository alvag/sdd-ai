import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { admitImplement } from '../src/sdd/phase.ts'
import { actorFlow, implementationReport, writer, launch, harvest, controlOf, registry, fakePrompts, tasksPath, mark, approveFlowGates, writeControl, runBin } from './task-actors-fixture.ts'

test('despacha solo writer pendiente en orden y conserva el alcance de la reanudacion', () => {
  const s = actorFlow([
    { id: 'T1', actor: 'user' }, { id: 'T2', actor: 'writer', done: true }, { id: 'T3', actor: 'writer' },
    { id: 'T4', actor: 'conductor' }, { id: 'T5' }, { id: 'T6', actor: 'writer' }, { id: 'T7', actor: 'writer' }, { id: 'T8', actor: 'writer' },
  ], [writer(implementationReport(['T3'], ['T5', 'T6', 'T7', 'T8'])),
    writer(implementationReport(['T5', 'T6', 'T7'], []), 'export const f = () => 3\n'),
    writer(implementationReport(['T8']), 'export const f = () => 4\n')])
  const first = launch(s)
  assert.equal(first.code, 0, JSON.stringify(first.out))
  assert.deepEqual(first.out.pending, ['T3', 'T5', 'T6', 'T7', 'T8'])
  assert.deepEqual(controlOf(s, first.out.id).phase.pending, first.out.pending)
  assert.deepEqual(registry(s).implement.chains[0].entries[0].pending, first.out.pending)
  harvest(s, first.out.id)
  const prompt = fakePrompts(s)[0]
  const input = /<<<INSUMO tasks\n([\s\S]*?)\nINSUMO tasks>>>/.exec(prompt)![1]
  assert.doesNotMatch(input, /\*\*T[124] —/)
  assert.match(input, /\*\*Patrón:\*\* src\/a.ts:1/)
  assert.match(input, /1\. Acción sintética/)
  assert.ok(input.indexOf('T3 —') < input.indexOf('T5 —'))
  mark(s, ['T3'])
  const block = launch(s, '--blocks')
  assert.equal(block.code, 0, JSON.stringify(block.out))
  assert.deepEqual(block.out.pending, ['T5', 'T6', 'T7'])
  harvest(s, block.out.id)
  assert.doesNotMatch(/<<<INSUMO tasks\n([\s\S]*?)\nINSUMO tasks>>>/.exec(fakePrompts(s)[1])![1], /T8 —|T4 —/)
  mark(s, ['T5', 'T6', 'T7'])
  const continuation = launch(s)
  assert.equal(continuation.code, 0, JSON.stringify(continuation.out))
  assert.deepEqual(continuation.out.pending, ['T8'])
  harvest(s, continuation.out.id)
  for (const ids of [['T3', 'T4'], ['T3', 'T2'], ['T3', 'T99'], []]) {
    assert.equal(admitImplement(implementationReport(ids), ['T3'], { explicit: true }).kind, 'inadmissible')
  }

  // El último alcance pendiente se reanuda exactamente; no se sustituye por todos los actores abiertos.
  const resumed = actorFlow([{ id: 'T1', actor: 'writer' }, { id: 'T2', actor: 'writer' }, { id: 'T3', actor: 'user' }], [
    writer(implementationReport(['T1', 'T2']).replace('STATUS: done', 'Interrumpido')),
    writer(implementationReport(['T1', 'T2']), 'export const f = () => 3\n'),
  ])
  const origin = launch(resumed)
  assert.deepEqual(origin.out.pending, ['T1', 'T2'])
  harvest(resumed, origin.out.id)
  // Marcar T2 deja la selección actual del writer en ['T1']: la reanudación conserva igual su alcance congelado.
  mark(resumed, ['T2'])
  const again = launch(resumed)
  assert.equal(again.code, 0, JSON.stringify(again.out))
  assert.equal(controlOf(resumed, again.out.id).phase.resumes, origin.out.id)
  assert.deepEqual(controlOf(resumed, again.out.id).phase.pending, ['T1', 'T2'])
  assert.equal(controlOf(resumed, again.out.id).phase.kind, controlOf(resumed, origin.out.id).phase.kind)
  // La reanudación se admite contra su alcance congelado: marcar T2 antes no cambia sus insumos ni su crédito.
  const received = harvest(resumed, again.out.id)
  assert.equal(received.out.contract.admitted, true, JSON.stringify(received.out))
  assert.deepEqual(received.out.covered, ['T1', 'T2'], JSON.stringify(received.out))
  assert.equal((received.out.failed ?? []).some((f: string) => /insumos/.test(f)), false, JSON.stringify(received.out.failed))
})

test('no amplía silenciosamente una cadena con ids agregados al artefacto vigente', () => {
  const s = actorFlow([{ id: 'T1', actor: 'writer' }, { id: 'T2', actor: 'writer' }], [writer(implementationReport(['T1'], ['T2'])), writer(implementationReport(['T2']), 'export const f = () => 3\n')])
  const first = launch(s)
  harvest(s, first.out.id)
  const file = tasksPath(s)
  writeFileSync(file, readFileSync(file, 'utf8') + '\n- [ ] **T99 — Nueva** · actor: writer · cubre: AC-1\n')
  approveFlowGates(s.repo)
  const continuation = launch(s)
  // Después de cosechar, el artefacto vigente puede cambiar, pero el alcance de la cadena no crece.
  assert.equal(continuation.code, 0, JSON.stringify(continuation.out))
  assert.deepEqual(continuation.out.pending, ['T2'])
  harvest(s, continuation.out.id)
  assert.deepEqual(registry(s).implement.chains[0].entries[1].pending, ['T2'])
  // T99 queda fuera del alcance: status la coordina sin proponer verify ni la toma.
  const status = runBin(s, ['sdd', 'status', 'f']).out.next
  assert.equal(status.command, undefined, JSON.stringify(status))
  assert.match(status.detail, /T99/)
  assert.doesNotMatch(status.detail, /sdd verify|--takeover/)
  assert.ok(readFileSync(join(s.repo, '.plans', 'f', 'tasks.md'), 'utf8').includes('T99'))
})

test('reanuda un control anterior sin añadir marcas de contrato ni sustituir su pending', () => {
  const s = actorFlow([{ id: 'T1' }, { id: 'T2' }], [
    writer(implementationReport(['T1'], ['T2']).replace('STATUS: done', 'Interrumpido')),
    writer(implementationReport(['T1', 'T2']), 'export const f = () => 3\n'),
  ])
  const first = launch(s)
  harvest(s, first.out.id)
  const c = controlOf(s, first.out.id)
  delete c.phase.findings
  writeControl(s, first.out.id, c)
  // Con T2 marcada, una selección recalculada sería ['T1']; el control anterior conserva ['T1', 'T2'].
  mark(s, ['T2'])
  const resumed = launch(s)
  assert.equal(resumed.code, 0, JSON.stringify(resumed.out))
  const next = controlOf(s, resumed.out.id)
  assert.equal(next.phase.resumes, first.out.id)
  assert.deepEqual(next.phase.pending, ['T1', 'T2'])
  assert.equal('findings' in next.phase, false)
  const received = harvest(s, resumed.out.id)
  assert.equal(received.out.contract.admitted, true, JSON.stringify(received.out))
  assert.deepEqual(received.out.covered, ['T1', 'T2'], JSON.stringify(received.out))
  assert.equal((received.out.failed ?? []).some((f: string) => /insumos/.test(f)), false, JSON.stringify(received.out.failed))
})
