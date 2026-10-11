import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { type Ledger } from '../src/review/ledger.ts'
import { cleanup, corrected, entries, flowFile, json, makeFixture, put, revise, runFile, script, settle, snapshotFiles, waitFor } from './phase-revision-fixture.ts'

test('cada material cambiado impide reemplazar el documento', async () => {
  for (const mutation of ['target', 'ledger', 'round', 'decisions', 'source', 'context', 'handoff-header', 'depth', 'step', 'implementation', 'handoff-body']) {
    const s = makeFixture({ artifact: mutation === 'depth' ? 'spec' : 'plan' })
    const barrier = join(s.work, 'release')
    try {
      writeFileSync(`${s.repo}/decisions.md`, 'Max: aclarar.\n')
      script(s, [{ barrier, answer: JSON.stringify(corrected(s.artifact)) }])
      const start = revise(s, ['--decisions', 'decisions.md'])
      assert.equal(start.code, 0, JSON.stringify(start.out)); await waitFor(`${barrier}.ready`)
      const append = (file: string, text: string) => writeFileSync(file, readFileSync(file, 'utf8') + text)
      if (mutation === 'target') append(flowFile(s, 'plan.md'), '\nEdición posterior.\n')
      if (mutation === 'ledger') {
        const l = json<Ledger>(runFile(s, s.review, 'ledger.json'))
        l.entries[0].claim += ' Más detalle.'
        put(runFile(s, s.review, 'ledger.json'), l)
      }
      if (mutation === 'round') {
        // El estado de la corrida acredita la ronda; no se toca el ledger.
        put(runFile(s, s.review, 'status.json'), { state: 'done', round: 2 })
      }
      if (mutation === 'decisions') append(`${s.repo}/decisions.md`, 'Otra respuesta.\n')
      if (mutation === 'source') append(flowFile(s, 'spec.md'), '\nOtra premisa.\n')
      if (mutation === 'context') append(`${s.repo}/context.md`, 'Otra evidencia.\n')
      if (mutation === 'handoff-header') writeFileSync(flowFile(s, 'handoff.md'), readFileSync(flowFile(s, 'handoff.md'), 'utf8').replace('risk: high', 'risk: low'))
      if (mutation === 'depth') writeFileSync(flowFile(s, 'plan.md'), readFileSync(flowFile(s, 'plan.md'), 'utf8').replace('profundidad: normal', 'profundidad: completa'))
      if (mutation === 'step') {
        // Una aprobación vencida cambia next sin editar destino, fuentes ni headers.
        put(flowFile(s, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [{ gate: 'spec', depth: 'normal',
          fingerprint: `sha256:${'0'.repeat(64)}`, previous: {}, at: '2026-10-10T00:00:00Z' }] })
      }
      if (mutation === 'implementation') put(runFile(s, 'implement-run', 'request.json'), { kind: 'phase', flow: 'f', role: 'implement', step: 'implement' })
      if (mutation === 'handoff-body') append(flowFile(s, 'handoff.md'), '\nNota del conductor.\n')
      const afterMutation = snapshotFiles(s)
      const ledger = readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8')
      writeFileSync(barrier, '')
      const finished = await settle(s, start.out.id)
      assert.equal(finished.out.outcome, mutation === 'handoff-body' ? 'published' : 'conflict', JSON.stringify(finished.out))
      if (mutation !== 'handoff-body') {
        assert.equal(finished.out.cause, 'material_changed')
        const details: Record<string, RegExp> = { target: /candidato|documento/, ledger: /ledger/, round: /ronda|entrega completada/,
          decisions: /aporte|decisions/, source: /insumos|fuentes/, context: /insumos|contexto/, 'handoff-header': /header/,
          depth: /normal|completa|profundidad/, step: /paso/, implementation: /implement/ }
        assert.match(finished.out.detail, details[mutation], JSON.stringify(finished.out))
        assert.deepEqual(snapshotFiles(s), afterMutation)
        assert.equal(entries(s).at(-1)!.result!.state, 'conflict')
        assert.equal(entries(s).at(-1)!.result!.digest, undefined)
      } else assert.equal(readFileSync(flowFile(s, 'handoff.md'), 'utf8'), afterMutation['handoff.md'])
      assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), ledger)
    } finally { writeFileSync(barrier, ''); await cleanup(s) }
  }
})
