import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { applyArchive, prepareArchive, previewArchive } from '../src/sdd/archive.ts'
import { archiveHash, inventoryArchiveTree } from '../src/sdd/archive-tree.ts'
import { type EvidenceProvenance } from '../src/sdd/archive-evidence.ts'
import { archiveJson, archiveWrite, createArchiveSandbox, readArchiveJson, runArchiveCharacterizer, runArchiveCli, runArchiveInProcess,
  answerArchive, snapshotArchiveSandbox } from './archive-fixture.ts'
import { loadArchiveOperations } from '../src/sdd/archive-operation.ts'
import { type VerifyReceipt, verifyBytesDigest } from '../src/sdd/verify-receipt.ts'
import { SddError } from '../src/types.ts'

// Con una respuesta vigente, el rechazo tiene que venir del material y no de la falta de aprobación.
const authorizedRejection = (error: unknown) => error instanceof SddError && error.code !== 'approval_missing'

test('prepare conserva selección literal y rechaza procedencia redirigida sin cambiar archivos ajenos', async (t) => {
  for (const name of ['receipt', 'attestation', 'references'] as const) await runArchiveCharacterizer(name)
  const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
  const vault = inventoryArchiveTree(s.vaultRoot), before = inventoryArchiveTree(s.source)
  assert.throws(() => applyArchive(s.checkoutRoot, s.flowId, { env: s.env, summary: 'Resumen' }))
  assert.deepEqual(inventoryArchiveTree(s.source), before)
  const coverage = prepareArchive(s.checkoutRoot, s.flowId)
  assert.equal(coverage.complete, true)
  assert.equal(coverage.selection.required.length, 4)
  for (const optional of ['baseline-missing', 'superseded-missing', 'unused-missing', 'invalid-missing']) {
    assert.ok(JSON.stringify(coverage.selection.optional).includes(optional))
    assert.ok(!coverage.selection.required.some((body) => body.id === optional))
  }
  assert.deepEqual(inventoryArchiveTree(s.vaultRoot), vault)
  const prepared = inventoryArchiveTree(s.source)
  assert.deepEqual(prepared.files.filter((file) => !file.path.startsWith('evidencia/')), before.files)
  prepareArchive(s.checkoutRoot, s.flowId)
  assert.deepEqual(inventoryArchiveTree(s.source), prepared)
  const provenanceFile = join(s.source, 'evidencia', 'archive-provenance.json')
  const provenance = readArchiveJson<EvidenceProvenance>(provenanceFile)
  for (const entry of provenance.entries) {
    const file = join(s.source, entry.prepared), bytes = readFileSync(file)
    assert.equal(archiveHash(bytes), entry.sha256); assert.equal(bytes.length, entry.size)
    assert.ok(!entry.prepared.includes('stdout') && !entry.prepared.includes('stderr'))
  }
  const ledger = provenance.entries.find((entry) => entry.kind === 'review_ledger')!
  assert.deepEqual(readFileSync(join(s.source, ledger.prepared)), readFileSync(s.sources.ledger))
  assert.match(readFileSync(join(s.source, ledger.prepared), 'utf8'), /human-arbitration/)
  const originalBody = readFileSync(join(s.source, ledger.prepared)), originalProvenance = readFileSync(provenanceFile)
  rmSync(join(s.source, ledger.prepared))
  prepareArchive(s.checkoutRoot, s.flowId)
  assert.deepEqual(readFileSync(provenanceFile), originalProvenance)
  assert.deepEqual(readFileSync(join(s.source, ledger.prepared)), originalBody)
  archiveWrite(join(s.source, ledger.prepared), '{"edited":true}\n')
  const modified = readFileSync(join(s.source, ledger.prepared))
  ledger.sha256 = archiveHash(modified); ledger.size = modified.length; archiveJson(provenanceFile, provenance)
  const preview = previewArchive(s.checkoutRoot, s.flowId, 'Resumen')
  assert.equal(preview.state, 'blocked'); assert.equal(preview.question, undefined)
  assert.match(JSON.stringify(preview.impediments), /discrepancia literal/)
  ledger.source_path = '.sdd-ai/runs/nonexistent/ledger.json'; archiveJson(provenanceFile, provenance)
  assert.match(JSON.stringify(previewArchive(s.checkoutRoot, s.flowId, 'Resumen').impediments), /procedencia incompatible/)
  assert.throws(() => prepareArchive(s.checkoutRoot, s.flowId))
  archiveWrite(join(s.source, ledger.prepared), originalBody); archiveWrite(provenanceFile, originalProvenance)
  for (const file of Object.values(s.sources)) rmSync(file)
  assert.equal(previewArchive(s.checkoutRoot, s.flowId, 'Resumen').state, 'ready')
  archiveWrite(join(s.source, ledger.prepared), '{"edited-again":true}')
  assert.equal(previewArchive(s.checkoutRoot, s.flowId, 'Resumen').state, 'blocked')
  const missing = createArchiveSandbox({ evidence: true }); t.after(missing.cleanup)
  prepareArchive(missing.checkoutRoot, missing.flowId)
  rmSync(join(missing.source, 'evidencia', 'archive-provenance.json'))
  assert.equal(previewArchive(missing.checkoutRoot, missing.flowId, 'Resumen').state, 'blocked')
  const missingSources = createArchiveSandbox({ evidence: true }); t.after(missingSources.cleanup)
  prepareArchive(missingSources.checkoutRoot, missingSources.flowId)
  const frozenInventory = inventoryArchiveTree(missingSources.source)
  for (const file of Object.values(missingSources.sources)) rmSync(file)
  answerArchive(missingSources, 'Resumen')
  assert.equal((await runArchiveInProcess(missingSources, { summary: 'Resumen' })).state, 'completed')
  const archivedWithoutSources = loadArchiveOperations(missingSources.checkoutRoot, missingSources.flowId)[0].manifest.binding.input.destination.documents
  assert.deepEqual(inventoryArchiveTree(archivedWithoutSources), frozenInventory)
  const collision = createArchiveSandbox({ evidence: true }); t.after(collision.cleanup)
  archiveWrite(join(collision.source, 'evidencia/review/review-selected/ledger.json'), '{}')
  const original = inventoryArchiveTree(collision.source)
  assert.throws(() => prepareArchive(collision.checkoutRoot, collision.flowId))
  assert.deepEqual(inventoryArchiveTree(collision.source), original)
  const digest = createArchiveSandbox({ evidence: true }); t.after(digest.cleanup)
  archiveWrite(digest.sources.attestation, '{}')
  assert.throws(() => prepareArchive(digest.checkoutRoot, digest.flowId))
  const notDirectory = createArchiveSandbox({ evidence: true }); t.after(notDirectory.cleanup)
  prepareArchive(notDirectory.checkoutRoot, notDirectory.flowId)
  const reviewDir = join(notDirectory.sources.ledger, '..')
  rmSync(reviewDir, { recursive: true }); archiveWrite(reviewDir, 'una ruta existente que no es directorio')
  const notDirectoryBefore = snapshotArchiveSandbox(notDirectory)
  assert.equal(previewArchive(notDirectory.checkoutRoot, notDirectory.flowId, 'Resumen').state, 'blocked')
  await assert.rejects(runArchiveInProcess(notDirectory, { summary: 'Resumen' }))
  assert.deepEqual(snapshotArchiveSandbox(notDirectory), notDirectoryBefore)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const unreadable = createArchiveSandbox({ evidence: true }); t.after(unreadable.cleanup)
    prepareArchive(unreadable.checkoutRoot, unreadable.flowId)
    chmodSync(unreadable.sources.ledger, 0)
    try { assert.equal(previewArchive(unreadable.checkoutRoot, unreadable.flowId, 'Resumen').state, 'blocked') }
    finally { chmodSync(unreadable.sources.ledger, 0o600) }
  }
  // Un prepare incompleto se representa con cuerpos literales y sin registro: no se fabrica procedencia.
  const partial = createArchiveSandbox({ evidence: true }); t.after(partial.cleanup)
  const partialBody = join(partial.source, 'evidencia/review/review-selected/ledger.json')
  archiveWrite(partialBody, readFileSync(partial.sources.ledger))
  const firstStat = lstatSync(partialBody), firstBytes = readFileSync(partialBody)
  const partialBefore = inventoryArchiveTree(partial.source), vaultBefore = inventoryArchiveTree(partial.vaultRoot)
  assert.equal(prepareArchive(partial.checkoutRoot, partial.flowId).complete, true)
  assert.equal(lstatSync(partialBody).ino, firstStat.ino)
  assert.equal(lstatSync(partialBody).mtimeMs, firstStat.mtimeMs)
  assert.deepEqual(readFileSync(partialBody), firstBytes)
  assert.deepEqual(inventoryArchiveTree(partial.source).files.filter((file) => !file.path.startsWith('evidencia/')),
    partialBefore.files.filter((file) => !file.path.startsWith('evidencia/')))
  assert.deepEqual(inventoryArchiveTree(partial.vaultRoot), vaultBefore)
  const completeProvenance = join(partial.source, 'evidencia/archive-provenance.json')
  const identity = lstatSync(completeProvenance)
  prepareArchive(partial.checkoutRoot, partial.flowId)
  assert.equal(lstatSync(completeProvenance).ino, identity.ino)
  assert.equal(lstatSync(completeProvenance).mtimeMs, identity.mtimeMs)

  for (const kind of ['review_ledger', 'review_verdict', 'verify_receipt', 'attestation'] as const) {
    const absentSource = createArchiveSandbox({ evidence: true }); t.after(absentSource.cleanup)
    const source = kind === 'review_ledger' ? absentSource.sources.ledger : kind === 'review_verdict' ? absentSource.sources.verdict
      : kind === 'verify_receipt' ? absentSource.sources.receipt : absentSource.sources.attestation
    rmSync(source)
    const before = snapshotArchiveSandbox(absentSource)
    assert.throws(() => prepareArchive(absentSource.checkoutRoot, absentSource.flowId), kind)
    assert.deepEqual(snapshotArchiveSandbox(absentSource), before)
    const absentBody = createArchiveSandbox({ evidence: true }); t.after(absentBody.cleanup)
    const prepared = prepareArchive(absentBody.checkoutRoot, absentBody.flowId); answerArchive(absentBody, 'Resumen')
    const entry = prepared.provenance!.entries.find((body) => body.kind === kind)!
    rmSync(join(absentBody.source, entry.prepared))
    const unchanged = snapshotArchiveSandbox(absentBody)
    const trial = previewArchive(absentBody.checkoutRoot, absentBody.flowId, 'Resumen')
    assert.equal(trial.state, 'blocked', kind); assert.equal(trial.question, undefined)
    await assert.rejects(runArchiveInProcess(absentBody, { summary: 'Resumen' }), authorizedRejection)
    assert.deepEqual(snapshotArchiveSandbox(absentBody), unchanged, `${kind}: apply no prepara`)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) for (const target of ['source', 'prepared'] as const) {
      const unreadable = createArchiveSandbox({ evidence: true }); t.after(unreadable.cleanup)
      const prepared = prepareArchive(unreadable.checkoutRoot, unreadable.flowId); answerArchive(unreadable, 'Resumen')
      const body = prepared.provenance!.entries.find((entry) => entry.kind === kind)!
      const path = target === 'prepared' ? join(unreadable.source, body.prepared)
        : kind === 'review_ledger' ? unreadable.sources.ledger : kind === 'review_verdict' ? unreadable.sources.verdict
          : kind === 'verify_receipt' ? unreadable.sources.receipt : unreadable.sources.attestation
      chmodSync(path, 0)
      try {
        assert.equal(previewArchive(unreadable.checkoutRoot, unreadable.flowId, 'Resumen').state, 'blocked', `${target} ${kind}`)
        await assert.rejects(runArchiveInProcess(unreadable, { summary: 'Resumen' }), authorizedRejection)
        assert.deepEqual(loadArchiveOperations(unreadable.checkoutRoot, unreadable.flowId), [])
      } finally { chmodSync(path, 0o600) }
    }
  }
  for (const defect of ['json', 'schema', 'selection', 'sha256', 'size', 'missing-entry', 'source-root', 'prepared-path', 'source-link']) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    prepareArchive(s.checkoutRoot, s.flowId); answerArchive(s, 'Resumen')
    const file = join(s.source, 'evidencia/archive-provenance.json'), value = readArchiveJson<EvidenceProvenance>(file)
    const entry = value.entries.find((entry) => entry.kind === 'review_verdict')!
    if (defect === 'json') archiveWrite(file, '{')
    else if (defect === 'source-link') {
      if (process.platform === 'win32') { t.diagnostic('source-link requiere enlaces POSIX'); continue }
      const literal = readFileSync(s.sources.verdict)
      archiveWrite(join(s.base, 'external-verdict.json'), literal); rmSync(s.sources.verdict)
      symlinkSync(join(s.base, 'external-verdict.json'), s.sources.verdict)
    } else {
      if (defect === 'schema') value.schema_version = 2 as 1
      if (defect === 'selection') value.selection.required.reverse()
      if (defect === 'sha256') entry.sha256 = '0'.repeat(64)
      if (defect === 'size') entry.size += 1
      if (defect === 'missing-entry') value.entries.splice(value.entries.indexOf(entry), 1)
      if (defect === 'source-root') entry.source_root = 'git_dir'
      if (defect === 'prepared-path') entry.prepared = 'evidencia/wrong-verdict.json'
      archiveJson(file, value)
    }
    const sourceBefore = readFileSync(join(s.source, 'spec.md')), vaultBefore = inventoryArchiveTree(s.vaultRoot)
    assert.equal(previewArchive(s.checkoutRoot, s.flowId, 'Resumen').state, 'blocked', defect)
    assert.throws(() => prepareArchive(s.checkoutRoot, s.flowId), defect)
    await assert.rejects(runArchiveInProcess(s, { summary: 'Resumen' }), authorizedRejection)
    assert.deepEqual(readFileSync(join(s.source, 'spec.md')), sourceBefore)
    assert.deepEqual(inventoryArchiveTree(s.vaultRoot), vaultBefore)
    assert.deepEqual(loadArchiveOperations(s.checkoutRoot, s.flowId), [])
  }
  const unreadableProvenance = createArchiveSandbox({ evidence: true }); t.after(unreadableProvenance.cleanup)
  prepareArchive(unreadableProvenance.checkoutRoot, unreadableProvenance.flowId)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const file = join(unreadableProvenance.source, 'evidencia/archive-provenance.json'); chmodSync(file, 0)
    try { assert.equal(previewArchive(unreadableProvenance.checkoutRoot, unreadableProvenance.flowId, 'Resumen').state, 'blocked') }
    finally { chmodSync(file, 0o600) }
  }
  for (const kind of ['receipt', 'attestation'] as const) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    const path = s.sources[kind], bytes = readFileSync(path)
    archiveWrite(path, `${bytes.toString()} `)
    assert.throws(() => prepareArchive(s.checkoutRoot, s.flowId), `${kind}: digest registrado`)
  }
  // El recibo y la acreditación deben pertenecer al id/flujo/fila aun con un digest recalculado.
  for (const field of ['id', 'flow', 'row'] as const) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    const attestation = readArchiveJson<Record<string, unknown>>(s.sources.attestation)
    attestation[field] = 'other'; archiveJson(s.sources.attestation, attestation)
    const phase = readArchiveJson<any>(join(s.source, 'sdd-ai-phases.json'))
    phase.verify.attestations[0].digest = verifyBytesDigest(readFileSync(s.sources.attestation))
    archiveJson(join(s.source, 'sdd-ai-phases.json'), phase)
    assert.throws(() => prepareArchive(s.checkoutRoot, s.flowId), field)
  }
  for (const field of ['id', 'flow'] as const) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    const receipt = readArchiveJson<VerifyReceipt>(s.sources.receipt)
    receipt[field] = 'different'; archiveJson(s.sources.receipt, receipt)
    const phases = readArchiveJson<any>(join(s.source, 'sdd-ai-phases.json'))
    phases.commit.receipt.digest = verifyBytesDigest(readFileSync(s.sources.receipt))
    phases.verify.receipts.find((ref: { id: string }) => ref.id === 'verify-selected').digest = phases.commit.receipt.digest
    archiveJson(join(s.source, 'sdd-ai-phases.json'), phases)
    assert.throws(() => prepareArchive(s.checkoutRoot, s.flowId), `recibo de otro ${field} con digest válido`)
  }
  const optional = createArchiveSandbox({ evidence: true }); t.after(optional.cleanup)
  archiveWrite(join(optional.sources.receipt, '..', 'stdout-Vmanual.log'), 'stdout externo que no se importa')
  archiveWrite(join(optional.sources.receipt, '..', 'stderr-Vmanual.log'), 'stderr externo que no se importa')
  const selectedReceipt = readArchiveJson<VerifyReceipt>(optional.sources.receipt)
  selectedReceipt.rows[0].execution = { row: 'Vmanual', started_at: selectedReceipt.started_at, ended_at: selectedReceipt.ended_at,
    argv: ['node', '-e', 'process.exit(0)'], exit_code: 0, stdout_file: 'stdout-Vmanual.log', stderr_file: 'stderr-Vmanual.log',
    stdout_sha256: verifyBytesDigest(readFileSync(join(optional.sources.receipt, '..', 'stdout-Vmanual.log'))),
    stderr_sha256: verifyBytesDigest(readFileSync(join(optional.sources.receipt, '..', 'stderr-Vmanual.log'))), excerpt: 'salida sintética' }
  archiveJson(optional.sources.receipt, selectedReceipt)
  const selectedPhases = readArchiveJson<any>(join(optional.source, 'sdd-ai-phases.json'))
  selectedPhases.commit.receipt.digest = verifyBytesDigest(readFileSync(optional.sources.receipt))
  selectedPhases.verify.receipts.find((ref: { id: string }) => ref.id === selectedReceipt.id).digest = selectedPhases.commit.receipt.digest
  const digestOfAbsent = verifyBytesDigest('referencia histórica ausente'), artifact = `.plans/${optional.flowId}/spec.md`
  const launch = { cmd: 'codex', args: [], cwd: '.', stdinFile: '.sdd-ai/runs/historical-document/stdin.md' }
  selectedPhases.documents = { specify: { phase: 'specify', artifact, run: 'historical-document', family: 'codex', launch,
    sources: [{ path: 'missing-history/source.md', digest: digestOfAbsent }], amendments: [] } }
  selectedPhases.revisions = { entries: [{ run: 'historical-revision', origin_run: 'historical-document', parent_run: null,
    phase: 'specify', artifact, family: 'codex', session_mode: 'same', session_id: 'synthetic-history', launch,
    review: 'old-missing', round: 1, candidate: digestOfAbsent, ledger_digest: digestOfAbsent,
    accepted: ['F-1'], decisions: [], history: [], materials: [{ path: 'missing-history/ledger.json', digest: digestOfAbsent }],
    at: '2026-01-02T03:04:05Z', state: 'superseded' }], barriers: [] }
  selectedPhases.implement = { schema: 1, chains: [{ id: 'historical-chain', entries: [{ kind: 'takeover', id: 'historical-takeover',
    parent: null, at: '2026-01-02T03:04:05Z', map: { ref: 'missing-history/map.json', digest: digestOfAbsent } }], terminal: null }],
    classifications: [], events: [] }
  archiveJson(join(optional.source, 'sdd-ai-phases.json'), selectedPhases)
  archiveJson(join(optional.sources.ledger, '..', 'receipt.json'), { optional: true })
  const preparedOptional = prepareArchive(optional.checkoutRoot, optional.flowId)
  assert.deepEqual(preparedOptional.selection.required.map((body) => body.kind), ['review_ledger', 'review_verdict', 'verify_receipt', 'attestation'])
  for (const reference of ['historical-document', 'historical-revision', 'historical-takeover', 'missing-history/source.md', 'missing-history/ledger.json']) {
    assert.ok(JSON.stringify(preparedOptional.selection.optional).includes(reference), reference)
  }
  assert.ok(!inventoryArchiveTree(join(optional.source, 'evidencia')).files.some((file) => /stdout|stderr/.test(file.path)))
  rmSync(join(optional.sources.ledger, '..', 'receipt.json'))
  // Las salidas referenciadas tampoco son requisito para archivo; el recibo operativo conserva su contrato aparte.
  rmSync(join(optional.sources.receipt, '..', 'stdout-Vmanual.log')); rmSync(join(optional.sources.receipt, '..', 'stderr-Vmanual.log'))
  answerArchive(optional, 'Resumen')
  assert.equal((await runArchiveInProcess(optional, { summary: 'Resumen' })).state, 'completed')
  const edited = createArchiveSandbox({ evidence: true }); t.after(edited.cleanup)
  prepareArchive(edited.checkoutRoot, edited.flowId); answerArchive(edited, 'Resumen')
  const recorded = join(edited.source, 'evidencia/archive-provenance.json'), ledgerRecord = readArchiveJson<EvidenceProvenance>(recorded)
  const preparedLedger = ledgerRecord.entries.find((entry) => entry.kind === 'review_ledger')!
  archiveWrite(join(edited.source, preparedLedger.prepared), '{"edited":true}')
  const replacement = readFileSync(join(edited.source, preparedLedger.prepared))
  preparedLedger.sha256 = archiveHash(replacement); preparedLedger.size = replacement.length; archiveJson(recorded, ledgerRecord)
  const rejection = await runArchiveCli(edited, ['--apply', '--summary', 'Resumen'])
  assert.notEqual(rejection.code, 0); assert.match(rejection.stdout, /discrepancia literal/)
  assert.ok(!rejection.stdout.includes('approval_missing'))
  assert.deepEqual(loadArchiveOperations(edited.checkoutRoot, edited.flowId), [])
})
