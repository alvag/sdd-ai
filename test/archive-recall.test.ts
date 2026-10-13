import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { previewArchive, prepareArchive } from '../src/sdd/archive.ts'
import { ArchiveInjectedCrash, inventoryArchiveTree } from '../src/sdd/archive-tree.ts'
import { loadArchiveOperations } from '../src/sdd/archive-operation.ts'
import { nodeMetadata, searchVault } from '../src/recall.ts'
import { answerArchive, archiveWrite, createArchiveSandbox, runArchiveCharacterizer, runArchiveInProcess, snapshotArchiveSandbox } from './archive-fixture.ts'

test('recall encuentra nodo y documentos y archive conserva el resumen autorizado sin índices', async (t) => {
  await runArchiveCharacterizer('recall')
  const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
  prepareArchive(s.checkoutRoot, s.flowId)
  archiveWrite(join(s.vaultRoot, 'projects', 'fixture-project', 'sdd', 'other.md'), '---\nstate: archived\nsummary: otro\n---\n# Otro\n')
  archiveWrite(join(s.vaultRoot, 'projects', 'fixture-project', 'sdd', 'index.md'), '# Índice previo\n')
  const other = inventoryArchiveTree(s.vaultRoot)
  for (const summary of [undefined, '', ' ', 'a\nb', 'a # b', '# inicial', '"quoted"', "'quoted'"]) {
    const before = snapshotArchiveSandbox(s)
    assert.equal(previewArchive(s.checkoutRoot, s.flowId, summary).state, 'blocked')
    assert.deepEqual(snapshotArchiveSandbox(s), before)
  }
  const summary = 'summaryneedle: PR#12'
  answerArchive(s, summary)
  await assert.rejects(runArchiveInProcess(s, { summary, fault: (point) => { if (point === 'after_documents_publication') throw new ArchiveInjectedCrash(point) } }))
  const original = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
  await assert.rejects(runArchiveInProcess(s, { summary: 'different', env: {} }))
  assert.deepEqual(loadArchiveOperations(s.checkoutRoot, s.flowId)[0], original)
  assert.equal((await runArchiveInProcess(s, { env: {} })).state, 'completed')
  const operation = loadArchiveOperations(s.checkoutRoot, s.flowId)[0], destination = operation.manifest.binding.input.destination
  const metadata = nodeMetadata(readFileSync(destination.node!, 'utf8'))
  assert.equal(metadata.summary, summary); assert.equal(metadata.state, 'archived'); assert.equal(metadata.date, operation.manifest.node!.date)
  for (const term of ['summaryneedle', 'docneedle']) {
    const result = searchVault(s.checkoutRoot, [term])
    assert.equal(result.status, 'ok'); assert.equal(result.flows[0].flow, s.flowId)
    assert.equal(result.flows[0].summary, summary)
    assert.ok(result.flows[0].lines.some((line) => line.path.endsWith(term === 'summaryneedle' ? `${s.flowId}.md` : 'spec.md')))
  }
  assert.ok(inventoryArchiveTree(join(destination.documents, 'evidencia')).files.length)
  const after = inventoryArchiveTree(s.vaultRoot)
  for (const file of other.files.filter((f) => !f.path.startsWith('.git/'))) assert.deepEqual(after.files.find((f) => f.path === file.path), file)
  assert.deepEqual(after.files.filter((f) => /(?:^|\/)index\.md$/.test(f.path)), other.files.filter((f) => /(?:^|\/)index\.md$/.test(f.path)))
})
