import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { prepareArchive, previewArchive } from '../src/sdd/archive.ts'
import { ArchiveInjectedCrash, inventoryArchiveTree } from '../src/sdd/archive-tree.ts'
import { archiveStore, loadArchiveOperations, saveArchiveOperation } from '../src/sdd/archive-operation.ts'
import { gitDirs } from '../src/git.ts'
import { SddError } from '../src/types.ts'
import { acquireReservation, releaseAll, storeDir } from '../src/writer-store.ts'
import { answerArchive, archiveGit, archiveJson, archiveWrite, createArchiveSandbox, runArchiveCli, runArchiveInProcess, snapshotArchiveSandbox } from './archive-fixture.ts'
import { askPair, writeClaudeTranscript } from './helpers.ts'

const summary = 'Resumen exclusivo: summaryneedle PR#12'

test('reanudar copia commit y retiro conserva autoridad y resumen sin otra respuesta', async (t) => {
  for (const point of ['after_copy_entry', 'after_publication_link', 'after_documents_publication', 'after_vault_staging', 'after_vault_commit',
    'before_claim', 'after_claim', 'before_retirement_entry', 'after_retirement_entry', 'after_staging_cleanup_entry'] as const) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    prepareArchive(s.checkoutRoot, s.flowId); answerArchive(s)
    const inventory = inventoryArchiveTree(s.source), before = archiveGit(s.vaultRoot, 'rev-list', '--count', 'HEAD')
    let reached = false
    await assert.rejects(runArchiveInProcess(s, { summary, fault: (at) => {
      if (at === point && !reached) { reached = true; throw new ArchiveInjectedCrash(at) }
    } }), ArchiveInjectedCrash)
    assert.ok(reached, point)
    const original = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
    const result = await runArchiveInProcess(s, { env: {} })
    assert.equal(result.state, 'completed', point)
    const operation = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
    assert.deepEqual(operation.manifest, original.manifest)
    assert.equal(operation.manifest.binding.input.summary, summary)
    assert.equal(Number(archiveGit(s.vaultRoot, 'rev-list', '--count', 'HEAD')), Number(before) + 1)
    assert.deepEqual(inventoryArchiveTree(operation.manifest.binding.input.destination.documents), inventory)
    assert.throws(() => inventoryArchiveTree(operation.manifest.layout.staging))
    assert.throws(() => inventoryArchiveTree(operation.manifest.layout.claimed))
    assert.equal((await runArchiveInProcess(s, { env: {} })).state, 'completed')
    assert.equal(Number(archiveGit(s.vaultRoot, 'rev-list', '--count', 'HEAD')), Number(before) + 1)
  }
})

test('apply inicia con prove reconoce solo completadas sin origen y recupera la operación pendiente', async (t) => {
  const s = createArchiveSandbox(); t.after(s.cleanup)
  await assert.rejects(runArchiveInProcess(s, { summary }), (error: unknown) => error instanceof SddError && error.code === 'approval_missing')
  assert.deepEqual(loadArchiveOperations(s.checkoutRoot, s.flowId), [])
  answerArchive(s)
  await assert.rejects(runArchiveInProcess(s, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }))
  const operation = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
  writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR!, s.env.CLAUDE_CODE_SESSION_ID!, askPair(s.env.CLAUDE_CODE_SESSION_ID!, 'new-decline', operation.manifest.question, 'No archivar'))
  archiveWrite(join(s.source, 'new.txt'), 'unautorizado')
  const abort = await runArchiveInProcess(s, { env: {} })
  assert.equal(abort.state, 'aborted')
  assert.throws(() => inventoryArchiveTree(operation.manifest.layout.staging))
  rmSync(join(s.source, 'new.txt'))
  await assert.rejects(runArchiveInProcess(s, { summary }))
  answerArchive(s)
  assert.equal((await runArchiveInProcess(s, { summary })).state, 'completed')
  assert.equal(loadArchiveOperations(s.checkoutRoot, s.flowId).length, 2)
  archiveWrite(join(s.source, 'spec.md'), 'recreated')
  await assert.rejects(runArchiveInProcess(s, { summary }))
  assert.equal(readFileSync(join(s.source, 'spec.md'), 'utf8'), 'recreated')
  // El origen recreado requiere otra decisión y un destino libre; la completada anterior no lo autoriza.
  const newVault = createArchiveSandbox(); t.after(newVault.cleanup)
  const oldVaultTree = inventoryArchiveTree(s.vaultRoot), oldHead = archiveGit(s.vaultRoot, 'rev-parse', 'HEAD')
  archiveWrite(join(newVault.vaultRoot, '.kv', 'identidades.tsv'), `fixture-project\t\t${archiveGit(s.checkoutRoot, 'rev-list', '--max-parents=0', 'HEAD')}\tfixture\n`)
  archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), `knowledge-vault:\n  path_vault: ${JSON.stringify(newVault.vaultRoot)}\n`)
  const priorProofs = loadArchiveOperations(s.checkoutRoot, s.flowId).map((op) => op.manifest.proof.ref)
  answerArchive(s)
  assert.equal((await runArchiveInProcess(s, { summary })).state, 'completed')
  const recreated = loadArchiveOperations(s.checkoutRoot, s.flowId)
  assert.equal(recreated.length, 3)
  assert.ok(recreated.some((op) => !priorProofs.includes(op.manifest.proof.ref)))
  assert.equal(readFileSync(join(newVault.vaultRoot, 'projects', 'fixture-project', 'sdd', s.flowId, 'spec.md'), 'utf8'), 'recreated')
  assert.deepEqual(inventoryArchiveTree(s.vaultRoot), oldVaultTree)
  assert.equal(archiveGit(s.vaultRoot, 'rev-parse', 'HEAD'), oldHead)
  const transient = createArchiveSandbox(); t.after(transient.cleanup); answerArchive(transient)
  await assert.rejects(runArchiveInProcess(transient, { summary, fault: (point) => { if (point === 'after_vault_commit') throw new ArchiveInjectedCrash(point) } }))
  const sha = archiveGit(transient.vaultRoot, 'rev-parse', 'HEAD')
  archiveWrite(join(transient.source, 'sdd-ai-approvals.lock'), '{}')
  await assert.rejects(runArchiveInProcess(transient, { env: {} }))
  assert.equal(loadArchiveOperations(transient.checkoutRoot, transient.flowId)[0].progress.state, 'running')
  rmSync(join(transient.source, 'sdd-ai-approvals.lock'))
  assert.equal((await runArchiveInProcess(transient, { env: {} })).state, 'completed')
  assert.equal(archiveGit(transient.vaultRoot, 'rev-parse', 'HEAD'), sha)
  const staged = createArchiveSandbox(); t.after(staged.cleanup); answerArchive(staged)
  await assert.rejects(runArchiveInProcess(staged, { summary, fault: (point) => { if (point === 'after_vault_staging') throw new ArchiveInjectedCrash(point) } }))
  archiveWrite(join(staged.source, 'spec.md'), 'changed after staging')
  const index = archiveGit(staged.vaultRoot, 'ls-files', '--stage')
  const stopped = await runArchiveInProcess(staged, { env: {} })
  assert.equal(stopped.state, 'stopped'); assert.ok(stopped.cause)
  assert.ok(Array.isArray(stopped.vault_staged_entries))
  assert.equal(archiveGit(staged.vaultRoot, 'ls-files', '--stage'), index)
  const view = await runArchiveCli(staged, [])
  assert.equal(view.out.state, 'stopped'); assert.deepEqual(view.out.vault_staged_entries, stopped.vault_staged_entries)
  assert.equal(stopped.preservation, 'pending'); assert.equal(stopped.retirement, 'pending')
  const stoppedRecord = loadArchiveOperations(staged.checkoutRoot, staged.flowId)[0]
  assert.deepEqual((stopped.vault_staged_entries as { path: string }[]).map((entry) => entry.path).sort(),
    stoppedRecord.progress.staged_entries!.map((entry) => entry.path).sort())
  writeClaudeTranscript(staged.env.CLAUDE_CONFIG_DIR!, staged.env.CLAUDE_CODE_SESSION_ID!,
    askPair(staged.env.CLAUDE_CODE_SESSION_ID!, 'later-archive', stoppedRecord.manifest.question, 'Archivar'))
  const stoppedBefore = snapshotArchiveSandbox(staged)
  assert.equal((await runArchiveInProcess(staged, { summary })).state, 'stopped')
  assert.deepEqual(snapshotArchiveSandbox(staged), stoppedBefore)
  assert.equal(loadArchiveOperations(staged.checkoutRoot, staged.flowId).length, 1)
  const stagedIndex = join(staged.vaultRoot, '.git', 'index'), stagedIndexBytes = readFileSync(stagedIndex)
  archiveWrite(stagedIndex, 'invalid index')
  try {
    const before = snapshotArchiveSandbox(staged), unavailable = await runArchiveCli(staged, [])
    assert.equal(unavailable.out.state, 'stopped')
    assert.match(unavailable.out.vault_staged_entries.limitation, /no se pudo inspeccionar/)
    assert.deepEqual(snapshotArchiveSandbox(staged), before)
  } finally { archiveWrite(stagedIndex, stagedIndexBytes) }
  assert.equal(archiveGit(staged.vaultRoot, 'ls-files', '--stage'), index)
  const corrupted = createArchiveSandbox(); t.after(corrupted.cleanup); answerArchive(corrupted)
  await assert.rejects(runArchiveInProcess(corrupted, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }))
  const corruptedOperation = loadArchiveOperations(corrupted.checkoutRoot, corrupted.flowId)[0]
  archiveWrite(join(corruptedOperation.manifest.layout.store, 'manifest.json'), '{')
  const preserved = inventoryArchiveTree(corrupted.source)
  await assert.rejects(runArchiveInProcess(corrupted, { env: {} }))
  assert.deepEqual(inventoryArchiveTree(corrupted.source), preserved)
  const absent = createArchiveSandbox(); t.after(absent.cleanup)
  rmSync(absent.source, { recursive: true })
  assert.equal((await runArchiveInProcess(absent, { env: {} })).state, 'source_absent')
  for (const discard of ['abort', 'recopy'] as const) {
    const sandbox = createArchiveSandbox(); t.after(sandbox.cleanup); answerArchive(sandbox)
    await assert.rejects(runArchiveInProcess(sandbox, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }))
    const registered = loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0]
    if (discard === 'abort') archiveWrite(join(sandbox.source, 'new.txt'), 'changed material')
    else archiveWrite(join(registered.manifest.layout.staging, 'documents', 'spec.md'), 'defective temporary body')
    await assert.rejects(runArchiveInProcess(sandbox, { env: {}, fault: (point) => { if (point === 'after_staging_cleanup_entry') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
    const interrupted = loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0]
    assert.equal(interrupted.progress.state, discard === 'abort' ? 'aborting' : 'running')
    assert.equal(interrupted.progress.staging_cleanup, 'intent')
    const recovered = await runArchiveInProcess(sandbox, { env: {} })
    assert.equal(recovered.state, discard === 'abort' ? 'aborted' : 'completed')
    assert.deepEqual(loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0].manifest, registered.manifest)
    assert.throws(() => inventoryArchiveTree(registered.manifest.layout.staging))
    assert.equal(loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId).length, 1)
  }
  // La respuesta nueva no sustituye la autoridad de una operación incompleta.
  const originalAuthority = createArchiveSandbox(); t.after(originalAuthority.cleanup); answerArchive(originalAuthority)
  await assert.rejects(runArchiveInProcess(originalAuthority, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
  const frozen = loadArchiveOperations(originalAuthority.checkoutRoot, originalAuthority.flowId)[0].manifest
  writeClaudeTranscript(originalAuthority.env.CLAUDE_CONFIG_DIR!, originalAuthority.env.CLAUDE_CODE_SESSION_ID!,
    askPair(originalAuthority.env.CLAUDE_CODE_SESSION_ID!, 'later-decline', frozen.question, 'No archivar'))
  assert.equal((await runArchiveInProcess(originalAuthority, {})).state, 'completed')
  assert.deepEqual(loadArchiveOperations(originalAuthority.checkoutRoot, originalAuthority.flowId)[0].manifest, frozen)
  assert.equal(loadArchiveOperations(originalAuthority.checkoutRoot, originalAuthority.flowId).length, 1)

  // Un enlace publicado con resultado pendiente ya excluye el aborto, aun antes del nodo o del commit.
  const uncertainPublication = createArchiveSandbox(); t.after(uncertainPublication.cleanup); answerArchive(uncertainPublication)
  await assert.rejects(runArchiveInProcess(uncertainPublication, { summary, fault: (point) => { if (point === 'after_publication_link') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
  const partialPublication = loadArchiveOperations(uncertainPublication.checkoutRoot, uncertainPublication.flowId)[0]
  archiveWrite(join(uncertainPublication.source, 'unapproved.txt'), 'origen distinto')
  const partialBefore = inventoryArchiveTree(partialPublication.manifest.binding.input.destination.documents)
  assert.equal((await runArchiveInProcess(uncertainPublication, { env: {} })).state, 'stopped')
  assert.deepEqual(inventoryArchiveTree(partialPublication.manifest.binding.input.destination.documents), partialBefore)
  assert.equal(readFileSync(join(uncertainPublication.source, 'unapproved.txt'), 'utf8'), 'origen distinto')
  assert.ok(inventoryArchiveTree(partialPublication.manifest.layout.staging).files.length)
  assert.equal(archiveGit(uncertainPublication.vaultRoot, 'rev-list', '--count', 'HEAD'), '1')

  // Corromper registros reales nunca permite reconstruir una autoridad ni continuar retirando.
  for (const corruption of ['progress-json', 'progress-missing', 'manifest-missing', 'digest', 'phase', 'retired'] as const) {
    const sandbox = createArchiveSandbox(); t.after(sandbox.cleanup); answerArchive(sandbox)
    await assert.rejects(runArchiveInProcess(sandbox, { summary, fault: (point) => { if (point === 'after_claim') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
    const record = loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0]
    const progressPath = join(record.manifest.layout.store, 'progress.json')
    if (corruption === 'progress-json') archiveWrite(progressPath, '{')
    if (corruption === 'progress-missing') rmSync(progressPath)
    if (corruption === 'manifest-missing') rmSync(join(record.manifest.layout.store, 'manifest.json'))
    if (corruption === 'digest') archiveJson(progressPath, { ...record.progress, manifest_digest: '0'.repeat(64) })
    if (corruption === 'phase') archiveJson(progressPath, { ...record.progress, phase: 'unknown' })
    if (corruption === 'retired') archiveJson(progressPath, { ...record.progress, retired: ['../outside'] })
    const preserved = snapshotArchiveSandbox(sandbox)
    await assert.rejects(runArchiveInProcess(sandbox, { env: {} }))
    assert.deepEqual(snapshotArchiveSandbox(sandbox), preserved, corruption)
    assert.deepEqual(inventoryArchiveTree(record.manifest.layout.claimed), record.manifest.binding.input.inventory)
  }

  // Replay adversarial de progreso auténtico: dos operaciones abiertas se rechazan sin adoptar ninguna.
  const multiple = createArchiveSandbox(); t.after(multiple.cleanup); answerArchive(multiple)
  await assert.rejects(runArchiveInProcess(multiple, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
  const first = loadArchiveOperations(multiple.checkoutRoot, multiple.flowId)[0]
  const firstProgress = readFileSync(join(first.manifest.layout.store, 'progress.json'))
  archiveWrite(join(multiple.source, 'extra.txt'), 'cambio para aborto')
  assert.equal((await runArchiveInProcess(multiple, { env: {} })).state, 'aborted')
  rmSync(join(multiple.source, 'extra.txt')); answerArchive(multiple)
  await assert.rejects(runArchiveInProcess(multiple, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
  const second = loadArchiveOperations(multiple.checkoutRoot, multiple.flowId).find((op) => op.manifest.operation_id !== first.manifest.operation_id)!
  archiveWrite(join(first.manifest.layout.store, 'progress.json'), firstProgress)
  const multipleBefore = snapshotArchiveSandbox(multiple)
  await assert.rejects(runArchiveInProcess(multiple, { env: {} }))
  assert.deepEqual(snapshotArchiveSandbox(multiple), multipleBefore)
  for (const record of [first, second]) assert.equal(JSON.parse(readFileSync(join(record.manifest.layout.store, 'progress.json'), 'utf8')).state, 'running')

  // Una recopia puede terminar en aborto si cambia el origen; no conserva el área defectuosa ni su Proof.
  const recopyAbort = createArchiveSandbox(); t.after(recopyAbort.cleanup); answerArchive(recopyAbort)
  await assert.rejects(runArchiveInProcess(recopyAbort, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
  const recopyRecord = loadArchiveOperations(recopyAbort.checkoutRoot, recopyAbort.flowId)[0]
  archiveWrite(join(recopyRecord.manifest.layout.staging, 'documents', 'spec.md'), 'temporal defectuoso')
  await assert.rejects(runArchiveInProcess(recopyAbort, { env: {} }))
  assert.equal((await runArchiveInProcess(recopyAbort, { env: {}, fault: (point) => {
    if (point === 'after_copy_entry') archiveWrite(join(recopyAbort.source, 'extra.txt'), 'material cambiado')
  } })).state, 'aborted')
  assert.throws(() => inventoryArchiveTree(recopyRecord.manifest.layout.staging))
  rmSync(join(recopyAbort.source, 'extra.txt'))
  await assert.rejects(runArchiveInProcess(recopyAbort, { summary }), (error: unknown) => error instanceof SddError && error.code === 'approval_reused')
  answerArchive(recopyAbort)
  assert.equal((await runArchiveInProcess(recopyAbort, { summary })).state, 'completed')
  assert.equal(loadArchiveOperations(recopyAbort.checkoutRoot, recopyAbort.flowId).length, 2)

  for (const point of ['after_copy_entry', 'after_vault_commit'] as const) {
    for (const impediment of ['writer', 'verify', 'flow-lock', 'source-read', 'registry-read', 'git-read'] as const) {
      if (impediment === 'source-read' && (process.platform === 'win32' || process.getuid?.() === 0)) {
        t.diagnostic('source-read: requiere permisos POSIX y usuario sin privilegios root'); continue
      }
      const sandbox = createArchiveSandbox({ evidence: true }); t.after(sandbox.cleanup)
      prepareArchive(sandbox.checkoutRoot, sandbox.flowId); answerArchive(sandbox)
      await assert.rejects(runArchiveInProcess(sandbox, { summary, fault: (at) => { if (at === point) throw new ArchiveInjectedCrash(at) } }), ArchiveInjectedCrash)
      const record = loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0]
      const progressBefore = readFileSync(join(record.manifest.layout.store, 'progress.json'))
      const sourceBefore = inventoryArchiveTree(sandbox.source), headBefore = archiveGit(sandbox.vaultRoot, 'rev-parse', 'HEAD')
      let restore = () => {}, reservation: ReturnType<typeof acquireReservation> | undefined
      const run = 'transient-writer', writerDir = storeDir(sandbox.checkoutRoot, run)
      const phasePath = join(sandbox.source, 'sdd-ai-phases.json'), indexPath = join(sandbox.vaultRoot, '.git', 'index')
      if (impediment === 'writer') {
        archiveJson(join(writerDir, 'control.json'), { id: run, base: archiveGit(sandbox.checkoutRoot, 'rev-parse', 'HEAD'), family: 'codex', prompt: 'fixture',
          checkout: { root: sandbox.checkoutRoot, ...gitDirs(sandbox.checkoutRoot) }, request: { role: 'implement', conductor: 'codex', deadline_sec: 30 },
          preLaunch: {}, inventory: {}, runDir: { dev: 1, ino: 1 }, phase: { flow: sandbox.flowId, pending: ['T1'], inputs: {}, handoff_header: 'fixture' } })
        restore = () => rmSync(writerDir, { recursive: true })
      }
      if (impediment === 'verify') { reservation = acquireReservation(sandbox.checkoutRoot, 'transient-verify', 'verify'); assert.equal(reservation.ok, true) }
      if (impediment === 'flow-lock') {
        archiveWrite(join(sandbox.source, 'sdd-ai-approvals.lock'), '{}')
        restore = () => rmSync(join(sandbox.source, 'sdd-ai-approvals.lock'))
      }
      if (impediment === 'registry-read') { const bytes = readFileSync(phasePath); archiveWrite(phasePath, '{'); restore = () => archiveWrite(phasePath, bytes) }
      if (impediment === 'git-read') { const bytes = readFileSync(indexPath); archiveWrite(indexPath, 'invalid index'); restore = () => archiveWrite(indexPath, bytes) }
      if (impediment === 'source-read') { chmodSync(sandbox.sources.ledger, 0); restore = () => chmodSync(sandbox.sources.ledger, 0o600) }
      try {
        await assert.rejects(runArchiveInProcess(sandbox, { env: {} }))
        const pending = loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0]
        assert.equal(pending.progress.state, 'running', `${point}/${impediment}`)
        assert.equal(pending.progress.phase, record.progress.phase)
        assert.deepEqual(pending.manifest, record.manifest)
        assert.deepEqual(readFileSync(join(record.manifest.layout.store, 'progress.json')), progressBefore,
          'un impedimento transitorio no avanza las intenciones')
        if (impediment !== 'git-read') assert.equal(archiveGit(sandbox.vaultRoot, 'rev-parse', 'HEAD'), headBefore)
      } finally { restore(); if (reservation?.ok) releaseAll(reservation.handles) }
      assert.deepEqual(inventoryArchiveTree(sandbox.source), sourceBefore)
      assert.equal((await runArchiveInProcess(sandbox, { env: {} })).state, 'completed')
      assert.deepEqual(loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0].manifest, record.manifest)
      assert.equal(archiveGit(sandbox.vaultRoot, 'rev-list', '--count', 'HEAD'), '2')
    }
  }

  // El reclamo no amplía el retiro a archivos nuevos ni sobrescribe un origen recreado.
  for (const point of ['after_claim', 'after_retirement_entry'] as const) {
    for (const mutation of ['new-file', 'body', 'source', 'recreated'] as const) {
      const sandbox = createArchiveSandbox({ evidence: true }); t.after(sandbox.cleanup)
      prepareArchive(sandbox.checkoutRoot, sandbox.flowId); answerArchive(sandbox)
      await assert.rejects(runArchiveInProcess(sandbox, { summary, fault: (at) => { if (at === point) throw new ArchiveInjectedCrash(at) } }), ArchiveInjectedCrash)
      const record = loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0]
      const head = archiveGit(sandbox.vaultRoot, 'rev-parse', 'HEAD')
      if (mutation === 'new-file' || mutation === 'recreated') archiveWrite(join(record.manifest.layout.claimed, 'new.txt'), 'nuevo no autorizado')
      if (mutation === 'body') archiveWrite(join(record.manifest.layout.claimed, 'spec.md'), 'remanente alterado')
      if (mutation === 'source') archiveWrite(sandbox.sources.ledger, 'fuente externa alterada')
      if (mutation === 'recreated') archiveWrite(join(sandbox.source, 'spec.md'), 'origen recreado independiente')
      const remaining = inventoryArchiveTree(record.manifest.layout.claimed), finalCopy = inventoryArchiveTree(record.manifest.binding.input.destination.documents)
      const result = await runArchiveInProcess(sandbox, { env: {} })
      assert.equal(result.state, 'stopped', `${point}/${mutation}`)
      assert.deepEqual(inventoryArchiveTree(result.source_location as string), remaining)
      assert.deepEqual(inventoryArchiveTree(record.manifest.binding.input.destination.documents), finalCopy)
      assert.equal(archiveGit(sandbox.vaultRoot, 'rev-parse', 'HEAD'), head)
      if (mutation === 'recreated') assert.equal(readFileSync(join(sandbox.source, 'spec.md'), 'utf8'), 'origen recreado independiente')
      const untouched = snapshotArchiveSandbox(sandbox)
      assert.equal((await runArchiveInProcess(sandbox, { env: {} })).state, 'stopped')
      assert.deepEqual(snapshotArchiveSandbox(sandbox), untouched)
    }
  }

  // Un registro cortado antes de publicar su manifiesto no bloquea el flujo ni consume la respuesta.
  const cutRegistration = createArchiveSandbox(); t.after(cutRegistration.cleanup)
  mkdirSync(join(archiveStore(cutRegistration.checkoutRoot, cutRegistration.flowId), `.pending-${randomUUID()}`), { recursive: true })
  answerArchive(cutRegistration)
  assert.equal((await runArchiveInProcess(cutRegistration, { summary })).state, 'completed')

  // Un corte entre crear el área y persistir su identidad deja un directorio vacío propio que se adopta.
  const cutStaging = createArchiveSandbox(); t.after(cutStaging.cleanup); answerArchive(cutStaging)
  await assert.rejects(runArchiveInProcess(cutStaging, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
  const cutOperation = loadArchiveOperations(cutStaging.checkoutRoot, cutStaging.flowId)[0]
  rmSync(cutOperation.manifest.layout.staging, { recursive: true }); mkdirSync(cutOperation.manifest.layout.staging)
  cutOperation.progress.actions['staging-create'] = 'intent'; cutOperation.progress.staging_created = false; delete cutOperation.progress.staging_identity
  saveArchiveOperation(cutOperation)
  assert.equal((await runArchiveInProcess(cutStaging, { env: {} })).state, 'completed')

  // El commit propio se reconoce aunque otro commit del vault compartido haya quedado encima.
  const shared = createArchiveSandbox(); t.after(shared.cleanup); answerArchive(shared)
  await assert.rejects(runArchiveInProcess(shared, { summary, fault: (point) => { if (point === 'after_vault_commit') throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
  const own = archiveGit(shared.vaultRoot, 'rev-parse', 'HEAD')
  archiveWrite(join(shared.vaultRoot, 'other-project.md'), 'otro proyecto\n')
  archiveGit(shared.vaultRoot, 'add', 'other-project.md'); archiveGit(shared.vaultRoot, 'commit', '-qm', 'otro proyecto')
  const resumed = await runArchiveInProcess(shared, { env: {} })
  assert.equal(resumed.state, 'completed')
  assert.deepEqual(resumed.vault_commit, { state: 'verified', sha: own })
})
