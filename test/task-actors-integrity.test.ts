import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainView, runFacts } from '../src/sdd/chain-facts.ts'
import { readFlow } from '../src/sdd/read.ts'
import { actorFlow, implementationReport, writer, launch, harvest, alterHarvest, tasksPath, signalFile } from './task-actors-fixture.ts'

test('los faltantes no eluden contrato integridad ni cambio de actor durante la corrida', () => {
  const missing = ['Entrada que debe proporcionar el conductor']
  const s = actorFlow([{ id: 'T1', actor: 'writer' }, { id: 'T2', actor: 'user' }], [writer(implementationReport(['T1'], [], missing))])
  const first = launch(s)
  const good = harvest(s, first.out.id)
  assert.deepEqual(good.out.covered, ['T1'])
  const original = JSON.parse(readFileSync(join(s.repo, '.git', 'sdd-ai', 'runs', first.out.id, 'harvest.json'), 'utf8'))
  // `continues`: sin delta medido o con el candidato vacío el eslabón no acredita, pero la orientación sigue siendo la
  // anterior, una continuación con el mismo alcance y sin crédito. Los demás bloqueos no dejan continuar.
  const cases: Array<{ name: string; patch: Record<string, unknown>; diagnostic: RegExp; continues: boolean }> = [
    { name: 'contrato', patch: { report: implementationReport(['T99'], [], missing) }, diagnostic: /contrato/, continues: false },
    { name: 'insumos', patch: { phase_inputs: 'changed' }, diagnostic: /insumos/, continues: false },
    { name: 'rutas', patch: { flagged: [{ path: '.agents/synthetic.txt' }] }, diagnostic: /rutas señaladas/, continues: false },
    { name: 'corrida', patch: { runAltered: [{ path: 'request.json' }] }, diagnostic: /alteró su corrida/, continues: false },
    { name: 'HEAD', patch: { headMoved: true }, diagnostic: /HEAD/, continues: false },
    { name: 'delta', patch: { delta_unmeasured: true, delta: [] }, diagnostic: /medir el delta/, continues: true },
    { name: 'marca', patch: { endMark: false }, diagnostic: /marca de fin/, continues: false },
    { name: 'candidato', patch: { files: [] }, diagnostic: /vacío/, continues: true },
  ]
  for (const { name, patch, diagnostic, continues } of cases) {
    alterHarvest(s, first.out.id, { ...original, ...patch })
    const h = harvest(s, first.out.id)
    assert.ok((h.out.failed ?? []).some((f: string) => diagnostic.test(f)), `${name}: ${JSON.stringify(h.out)}`)
    const view = chainView(s.repo, 'f', readFlow(s.repo, 'f'))
    assert.deepEqual(view.state.covered, [], name)
    assert.notEqual(view.state.next.kind, 'actors_pending', name)
    assert.notEqual(view.state.next.kind, 'coordinate', name)
    assert.notEqual(view.state.next.kind, 'verify', name)
    if (continues) assert.deepEqual(view.state.next, { kind: 'continue', left: ['T1'] }, name)
    else assert.notEqual(view.state.next.kind, 'continue', name)
    if (name === 'delta') assert.equal(runFacts(s.repo, first.out.id)?.harvest?.delta, null)
  }
  alterHarvest(s, first.out.id, original)
  assert.deepEqual(chainView(s.repo, 'f', readFlow(s.repo, 'f')).state.covered, ['T1'])

  const go = signalFile()
  const active = actorFlow([{ id: 'T1', actor: 'writer' }, { id: 'T2', actor: 'user' }], [{ ...writer(implementationReport(['T1'], [], missing)), waitFor: go }])
  const file = tasksPath(active)
  // La señal se libera en cualquier camino: si el lanzamiento o la edición fallan, el writer falso no queda esperando.
  const run = (() => {
    try {
      const launched = launch(active)
      assert.equal(launched.code, 0, JSON.stringify(launched.out))
      writeFileSync(file, readFileSync(file, 'utf8').replace('actor: writer', 'actor: conductor'))
      return launched
    } finally {
      writeFileSync(go, '')
    }
  })()
  const received = harvest(active, run.out.id)
  assert.ok(received.out.failed.some((f: string) => /insumos/.test(f)), JSON.stringify(received.out))
  assert.deepEqual(received.out.covered, [])
  assert.equal(chainView(active.repo, 'f', readFlow(active.repo, 'f')).state.next.kind, 'takeover')
})
