import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { type Ledger } from '../src/review/ledger.ts'
import { cleanup, corrected, entries, flowFile, json, makeFixture, put, revise, runFile, script, settle, snapshotFiles, waitFor } from './phase-revision-fixture.ts'

test('cada material cambiado impide reemplazar el documento', async () => {
  for (const mutation of ['target', 'ledger', 'round', 'decisions', 'source', 'context', 'handoff-header', 'depth', 'step', 'implementation', 'handoff-body']) {
    const s = makeFixture({ artifact: 'plan' })
    const barrier = join(s.work, 'release')
    try {
      writeFileSync(`${s.repo}/decisions.md`, 'Max: aclarar.\n')
      script(s, [{ barrier, answer: JSON.stringify(corrected('plan')) }])
      const start = revise(s, ['--decisions', 'decisions.md'])
      assert.equal(start.code, 0, JSON.stringify(start.out)); await waitFor(`${barrier}.ready`)
      const append = (file: string, text: string) => writeFileSync(file, readFileSync(file, 'utf8') + text)
      if (mutation === 'target') append(flowFile(s, 'plan.md'), '\nEdición posterior.\n')
      if (mutation === 'ledger' || mutation === 'round') {
        const l = json<Ledger>(runFile(s, s.review, 'ledger.json'))
        if (mutation === 'round') l.completed++
        else l.entries[0].claim += ' Más detalle.'
        put(runFile(s, s.review, 'ledger.json'), l)
      }
      if (mutation === 'decisions') append(`${s.repo}/decisions.md`, 'Otra respuesta.\n')
      if (mutation === 'source') append(flowFile(s, 'spec.md'), '\nOtra premisa.\n')
      if (mutation === 'context') append(`${s.repo}/context.md`, 'Otra evidencia.\n')
      if (mutation === 'handoff-header') writeFileSync(flowFile(s, 'handoff.md'), readFileSync(flowFile(s, 'handoff.md'), 'utf8').replace('risk: high', 'risk: low'))
      if (mutation === 'depth') writeFileSync(flowFile(s, 'handoff.md'), readFileSync(flowFile(s, 'handoff.md'), 'utf8').replace('profundidad: normal', 'profundidad: completa'))
      if (mutation === 'step') writeFileSync(flowFile(s, 'plan.md'), readFileSync(flowFile(s, 'plan.md'), 'utf8').replace('status: tasks-ready', 'status: planned'))
      if (mutation === 'implementation') put(runFile(s, 'implement-run', 'request.json'), { kind: 'phase', flow: 'f', role: 'implement', step: 'implement' })
      if (mutation === 'handoff-body') append(flowFile(s, 'handoff.md'), '\nNota del conductor.\n')
      const afterMutation = snapshotFiles(s)
      const ledger = readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8')
      writeFileSync(barrier, '')
      const finished = await settle(s, start.out.id)
      assert.equal(finished.out.outcome, mutation === 'handoff-body' ? 'published' : 'conflict', JSON.stringify(finished.out))
      if (mutation !== 'handoff-body') {
        assert.ok(finished.out.cause)
        assert.deepEqual(snapshotFiles(s), afterMutation)
        assert.equal(entries(s).at(-1)!.result!.state, 'conflict')
        assert.equal(entries(s).at(-1)!.result!.digest, undefined)
      } else assert.equal(readFileSync(flowFile(s, 'handoff.md'), 'utf8'), afterMutation['handoff.md'])
      assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), ledger)
    } finally { writeFileSync(barrier, ''); await cleanup(s) }
  }
})
