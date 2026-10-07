import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { accept, answer, cli, fixture, snapshot, SPEC, logged } from './sdd-approve-fixture.ts'

test('una decision nueva conserva los rechazos humanos de precondiciones y de worker sin mutaciones', () => {
  for (const kind of ['missing', 'negative', 'fingerprint', 'artifact', 'blocked', 'worker', 'reused']) {
    const f = fixture()
    try {
      let gate = 'spec', code = 'approval_missing'
      if (kind === 'negative') { answer(f, gate, 'No aprobar'); code = 'approval_contradicted' }
      if (kind === 'fingerprint') { answer(f, gate); writeFileSync(join(f.dir, 'spec.md'), SPEC + '\nOtra versión.\n') }
      if (kind === 'artifact') { answer(f, gate); rmSync(join(f.dir, 'spec.md')); code = 'approve_rejected' }
      if (kind === 'blocked') { answer(f, gate); writeFileSync(join(f.dir, 'handoff.md'), '---\nprofundidad: [\n---\n'); code = 'approve_rejected' }
      if (kind === 'worker') { answer(f, gate); f.env.SDD_AI_WORKER = '1'; code = 'runner_required' }
      if (kind === 'reused') {
        accept(f, gate)
        writeFileSync(join(f.dir, 'spec.md'), SPEC + '\nOtra versión.\n')
        accept(f, gate)
        writeFileSync(join(f.dir, 'spec.md'), SPEC)
        assert.equal(logged(f).length, 2)
        code = 'approval_reused'
      }
      const before = snapshot(f)
      const r = cli(f, 'approve', 'f', gate)
      assert.equal(r.code, 2, kind)
      assert.equal(r.out.code, code, `${kind}: ${JSON.stringify(r.out)}`)
      assert.deepEqual(snapshot(f), before, kind)
      if (kind === 'worker') assert.match(r.out.next, /pregunta canónica/)
      if (kind === 'artifact') assert.match(r.out.detail, /faltan artefactos/)
    } finally { f.cleanup() }
  }
  // Gate anterior pendiente con los artefactos del gate pedido presentes. Va aparte del loop: con un plan
  // en disco, su header ya acredita la spec, así que la spec tiene que estar registrada y vencida.
  const f = fixture()
  try {
    accept(f, 'spec')
    writeFileSync(join(f.dir, 'spec.md'), readFileSync(join(f.dir, 'spec.md'), 'utf8') + '\nCambio.\n')
    answer(f, 'plan-tasks')
    const before = snapshot(f)
    const r = cli(f, 'approve', 'f', 'plan-tasks')
    assert.equal(r.out.code, 'approve_rejected')
    assert.match(r.out.detail, /antes hay que aprobar spec/)
    assert.deepEqual(snapshot(f), before)
  } finally { f.cleanup() }
})
