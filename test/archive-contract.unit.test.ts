import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archiveQuestion, buildArchiveBinding, type ArchiveBindingInput } from '../src/approval/question.ts'
import { nodeMetadata } from '../src/recall.ts'
import { selectArchiveEvidence } from '../src/sdd/archive-evidence.ts'
import { buildArchiveNode } from '../src/sdd/archive-node.ts'
import { type PhaseRecord } from '../src/sdd/phase-state.ts'
import { type VerifyReceipt } from '../src/sdd/verify-receipt.ts'

test('los contratos puros conservan selección ligadura y resumen sin normalización', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const record: PhaseRecord = { schema_version: 1, last_run: null, phases: {},
    verify: { receipts: [], attestations: [{ id: 'a', row: 'V1', digest, proof_ref: 'p' }] },
    commit: { state: 'done', sha: 'a'.repeat(40), parent: 'b'.repeat(40), tree: 'c'.repeat(40), at: '2026-01-02T03:04:05Z',
      message: 'feat: fixture', paths: ['src/a.ts'], digest, review: 'r', receipt: { id: 'v', digest } } }
  assert.deepEqual(selectArchiveEvidence(null).required, [])
  assert.deepEqual(selectArchiveEvidence({ ...record, commit: undefined }).required, [])
  const initial = selectArchiveEvidence(record)
  assert.equal(initial.requires_receipt, true)
  assert.deepEqual(initial.required.map((body) => body.kind), ['review_ledger', 'review_verdict', 'verify_receipt'])
  const receipt = { id: 'v', flow: 'f', rows: [{ row: 'V1', outcome: 'passed', attestation: 'a', invalid_attestations: ['gone'] }] } as VerifyReceipt
  const selected = selectArchiveEvidence(record, receipt)
  assert.equal(selected.requires_receipt, false)
  assert.equal(selected.required.at(-1)?.id, 'a')
  assert.ok(!selected.required.some((body) => body.id === 'gone'))
  assert.throws(() => selectArchiveEvidence(record, { ...receipt, id: 'other' }))
  assert.throws(() => selectArchiveEvidence(record, { ...receipt, rows: [{ row: 'V2', outcome: 'passed', attestation: 'a' }] }))
  const input: ArchiveBindingInput = { flow: 'f', identity: { project: 'p' }, destination: { kind: 'vault', documents: '/vault/projects/p/sdd/f' },
    inventory: { directories: ['z', 'a'], files: [{ path: 'x', size: 1, sha256: 'a'.repeat(64) }] }, selection: selected,
    provenance: { source_path: 'derived' }, summary: 'Resumen: PR#12' }
  const binding = buildArchiveBinding(input)
  assert.equal(binding.code, buildArchiveBinding({ ...input, inventory: { ...input.inventory, directories: ['a', 'z'] } }).code)
  for (const changed of [{ flow: 'other' }, { summary: 'otro' }, { identity: { project: 'q' } }, { provenance: { source_path: 'redirected' } },
    { destination: { kind: 'local' as const, documents: '/other' } }, { selection: initial },
    { inventory: { directories: [], files: [] } }]) assert.notEqual(binding.code, buildArchiveBinding({ ...input, ...changed }).code)
  assert.deepEqual(archiveQuestion(binding).options.map((option) => option.label), ['Archivar', 'No archivar'])
  assert.match(archiveQuestion(binding).question, /único commit local/)
  const base = { flow: 'f', project: 'p', date: '2026-01-02T03:04:05-05:00' }
  for (const summary of ['', '   ', 'a\nb', 'a\rb', 'a # b', '# inicial', '"entre comillas"', "'entre comillas'", ' borde', 'borde ']) {
    assert.throws(() => buildArchiveNode({ ...base, summary }), summary)
  }
  for (const summary of ['Resumen: PR#12', 'literal', 'comilla " interior']) {
    const node = buildArchiveNode({ ...base, summary })
    assert.deepEqual(nodeMetadata(node.bytes.toString()), { state: 'archived', date: base.date, summary })
  }
})
