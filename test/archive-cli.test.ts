import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { applyArchive, prepareArchive, previewArchive, resolveArchiveDestination } from '../src/sdd/archive.ts'
import { ArchiveInjectedCrash, inventoryArchiveTree } from '../src/sdd/archive-tree.ts'
import { loadArchiveOperations } from '../src/sdd/archive-operation.ts'
import { acquireReservation, releaseAll, storeDir } from '../src/writer-store.ts'
import { gitDirs } from '../src/git.ts'
import { readFlow } from '../src/sdd/read.ts'
import { resolve as resolveFlow } from '../src/sdd/status.ts'
import { SddError } from '../src/types.ts'
import { askPair, writeClaudeTranscript } from './helpers.ts'
import { barrierProcess } from './sdd-approve-fixture.ts'
import { answerArchive, archiveGit, archiveJson, archiveWrite, createArchiveSandbox, readArchiveJson, runArchiveCharacterizer,
  runArchiveCli, runArchiveInProcess, snapshotArchiveSandbox } from './archive-fixture.ts'

const summary = 'Resumen exclusivo: summaryneedle PR#12'
const sddCode = (...codes: string[]) => (error: unknown) => error instanceof SddError && codes.includes(error.code)

test('archive selecciona exclusivamente el destino configurado', async (t) => {
  await runArchiveCharacterizer('destination')
  for (const vault of [true, false]) {
    const s = createArchiveSandbox({ vault }); t.after(s.cleanup)
    const d = resolveArchiveDestination(s.checkoutRoot, s.flowId)
    assert.equal(d.kind, vault ? 'vault' : 'local')
    if (vault) {
      archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), 'knowledge-vault:\n  path_vault: ../vault\nvault_archive:\n  mode: local\n')
      assert.equal(resolveArchiveDestination(s.checkoutRoot, s.flowId).real_vault_root, s.vaultRoot)
      archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), `knowledge-vault:\n  path_vault: ${JSON.stringify(`~/${relative(homedir(), s.vaultRoot)}`)}\n`)
      assert.equal(resolveArchiveDestination(s.checkoutRoot, s.flowId).real_vault_root, s.vaultRoot)
    }
    answerArchive(s, summary)
    const before = archiveGit(s.vaultRoot, 'rev-parse', 'HEAD')
    await runArchiveInProcess(s, { summary })
    // Con vault queda un commit nuevo; sin vault el repositorio del vault no se toca.
    const after = archiveGit(s.vaultRoot, 'rev-parse', 'HEAD')
    if (vault) assert.notEqual(after, before)
    else assert.equal(after, before)
    assert.ok(inventoryArchiveTree(d.documents).files.length)
  }
  for (const config of ['knowledge-vault:\n  path_vault: 42\n', 'knowledge-vault:\n  path_vault: ../missing\n']) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), config)
    const before = snapshotArchiveSandbox(s)
    assert.throws(() => resolveArchiveDestination(s.checkoutRoot, s.flowId), sddCode('archive_config_invalid', 'archive_destination_unavailable'))
    assert.deepEqual(snapshotArchiveSandbox(s), before)
  }
  for (const registry of ['', 'wrong\tfields\n', 'p\t\tROOT\tx\nq\t\tROOT\tx\n']) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    archiveWrite(join(s.vaultRoot, '.kv', 'identidades.tsv'), registry.replaceAll('ROOT', archiveGit(s.checkoutRoot, 'rev-list', '--max-parents=0', 'HEAD')))
    assert.throws(() => resolveArchiveDestination(s.checkoutRoot, s.flowId), sddCode('archive_identity_invalid', 'archive_identity_unresolved'))
  }
  if (process.platform !== 'win32' && process.getuid?.() !== 0) for (const target of ['root', 'registry']) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    const path = target === 'root' ? s.vaultRoot : join(s.vaultRoot, '.kv', 'identidades.tsv')
    chmodSync(path, 0)
    try { assert.throws(() => resolveArchiveDestination(s.checkoutRoot, s.flowId)) }
    finally { chmodSync(path, target === 'root' ? 0o700 : 0o600) }
  }
})

test('el ensayo informa inventario e impedimentos sin escrituras ni contenido testigo', async (t) => {
  for (const prepared of [false, true]) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    archiveWrite(join(s.source, 'witness.bin'), 'exclusive-body-witness-4711')
    if (prepared) prepareArchive(s.checkoutRoot, s.flowId)
    const before = snapshotArchiveSandbox(s)
    const result = await runArchiveCli(s, ['--summary', summary])
    assert.deepEqual(snapshotArchiveSandbox(s), before)
    assert.ok(!`${result.stdout}${result.stderr}`.includes('exclusive-body-witness-4711'))
    assert.equal(result.out.state, prepared ? 'ready' : 'blocked')
    assert.deepEqual(result.out.inventory, inventoryArchiveTree(s.source))
  }
  for (const invalid of [undefined, '', '   ', 'a\nb', 'a # b', '# inicial', '"quoted"', "'quoted'"]) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    archiveWrite(join(s.source, 'witness.bin'), 'exclusive-body-witness-4711')
    const before = snapshotArchiveSandbox(s), p = previewArchive(s.checkoutRoot, s.flowId, invalid)
    assert.equal(p.state, 'blocked'); assert.equal(p.question, undefined)
    assert.deepEqual(snapshotArchiveSandbox(s), before)
    const cli = await runArchiveCli(s, invalid === undefined ? [] : ['--summary', invalid])
    assert.ok(!`${cli.stdout}${cli.stderr}`.includes('exclusive-body-witness-4711'))
    assert.deepEqual(snapshotArchiveSandbox(s), before)
  }
  for (const condition of ['staged', 'ignored', 'no-git', 'nested']) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    archiveWrite(join(s.source, 'witness.bin'), 'exclusive-body-witness-4711')
    if (condition === 'staged') { archiveWrite(join(s.vaultRoot, 'foreign.txt'), 'foreign'); archiveGit(s.vaultRoot, 'add', 'foreign.txt') }
    if (condition === 'ignored') archiveWrite(join(s.vaultRoot, '.gitignore'), 'projects/\n')
    if (condition === 'no-git') rmSync(join(s.vaultRoot, '.git'), { recursive: true })
    if (condition === 'nested') {
      archiveWrite(join(s.vaultRoot, 'nested', '.kv', 'identidades.tsv'), readFileSync(join(s.vaultRoot, '.kv', 'identidades.tsv')))
      archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), 'knowledge-vault:\n  path_vault: ../vault/nested\n')
    }
    const before = snapshotArchiveSandbox(s)
    assert.equal(previewArchive(s.checkoutRoot, s.flowId, summary).state, 'blocked')
    assert.deepEqual(snapshotArchiveSandbox(s), before)
    const cli = await runArchiveCli(s, ['--summary', summary])
    assert.ok(!`${cli.stdout}${cli.stderr}`.includes('exclusive-body-witness-4711'))
    assert.deepEqual(snapshotArchiveSandbox(s), before)
  }
  const unreadableJson = createArchiveSandbox({ evidence: true }); t.after(unreadableJson.cleanup)
  archiveWrite(unreadableJson.sources.receipt, '{exclusive-body-witness-4711')
  const unchanged = snapshotArchiveSandbox(unreadableJson)
  const error = await runArchiveCli(unreadableJson, ['--summary', summary])
  assert.equal(error.out.state, 'blocked'); assert.equal(error.out.question, undefined)
  assert.ok(!`${error.stdout}${error.stderr}`.includes('exclusive-body-witness-4711'))
  assert.deepEqual(snapshotArchiveSandbox(unreadableJson), unchanged)
})

test('apply exige una respuesta para flujo inventario destino y resumen exactos', async (t) => {
  await runArchiveCharacterizer('question')
  for (const condition of ['missing', 'declined', 'other-flow', 'inventory', 'summary', 'destination', 'valid']) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    if (condition === 'other-flow') {
      const other = createArchiveSandbox({ flowId: 'other-flow' }); t.after(other.cleanup)
      const question = answerArchive(other, summary)
      writeClaudeTranscript(s.env.CLAUDE_CONFIG_DIR!, s.env.CLAUDE_CODE_SESSION_ID!, askPair(s.env.CLAUDE_CODE_SESSION_ID!, 'other-flow-answer', question, 'Archivar'))
    } else if (condition !== 'missing') answerArchive(s, summary, condition === 'declined' ? 'No archivar' : 'Archivar')
    if (condition === 'inventory') archiveWrite(join(s.source, 'new.txt'), 'new')
    if (condition === 'destination') archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), '{}\n')
    const before = snapshotArchiveSandbox(s)
    const result = await runArchiveCli(s, ['--apply', '--summary', condition === 'summary' ? 'otro resumen' : summary])
    if (condition === 'valid') assert.equal(result.out.retirement, 'complete', result.stdout)
    else { assert.notEqual(result.code, 0); assert.deepEqual(snapshotArchiveSandbox(s), before) }
  }
  const s = createArchiveSandbox({ vault: false }); t.after(s.cleanup)
  answerArchive(s); await runArchiveInProcess(s, { summary })
  archiveWrite(join(s.source, 'spec.md'), 'origen recreado')
  // Un origen recreado no hereda la autoridad de la operación completada.
  assert.throws(() => applyArchive(s.checkoutRoot, s.flowId, { env: s.env }), sddCode('archive_blocked', 'approval_missing'))
  assert.equal(readFileSync(join(s.source, 'spec.md'), 'utf8'), 'origen recreado')
  const reused = createArchiveSandbox(); t.after(reused.cleanup); answerArchive(reused, summary)
  const aborted = await runArchiveInProcess(reused, { summary, fault: (point) => {
    if (point === 'after_copy_entry') archiveWrite(join(reused.source, 'after-authorization.txt'), 'nuevo')
  } })
  assert.equal(aborted.state, 'aborted')
  rmSync(join(reused.source, 'after-authorization.txt'))
  const unchanged = snapshotArchiveSandbox(reused)
  await assert.rejects(runArchiveInProcess(reused, { summary }), (error: unknown) => error instanceof SddError && error.code === 'approval_reused')
  assert.deepEqual(snapshotArchiveSandbox(reused), unchanged)
  assert.equal(loadArchiveOperations(reused.checkoutRoot, reused.flowId).length, 1)
})

test('archive admite heredados sin fabricar fases y bloquea solo actividad escritora o incierta', async (t) => {
  await runArchiveCharacterizer('activity')
  for (const record of [null, { schema_version: 1, last_run: null, phases: {} }]) {
    const s = createArchiveSandbox({ vault: false }); t.after(s.cleanup)
    if (record) archiveJson(join(s.source, 'sdd-ai-phases.json'), record)
    answerArchive(s); await runArchiveInProcess(s)
    assert.equal(inventoryArchiveTree(join(s.checkoutRoot, '.plans', 'archived', s.flowId)).files.some((f) => f.path.startsWith('evidencia/')), false)
  }
  const activityCodes: Record<string, string> = { running: 'phase_running', corrupt: 'activity_unknown', lock: 'archive_flow_locked',
    'commit-intent': 'archive_commit_running', 'verify-reservation': 'archive_activity_pending', review: 'archive_review_running',
    'review-lock': 'archive_review_running', publication: 'archive_publication_pending', chain: 'archive_writer_running' }
  for (const state of ['running', 'corrupt', 'lock', 'commit-intent', 'verify-reservation', 'review', 'review-lock', 'publication', 'chain', 'missing-required']) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    prepareArchive(s.checkoutRoot, s.flowId)
    const record = readArchiveJson<any>(join(s.source, 'sdd-ai-phases.json'))
    if (state === 'running' || state === 'corrupt') {
      record.last_run = { id: 'active', step: 'implement' }; archiveJson(join(s.source, 'sdd-ai-phases.json'), record)
      archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'runs', 'active', 'status.json'), state === 'corrupt' ? '{' : '{"state":"running"}')
    }
    if (state === 'lock') archiveWrite(join(s.source, 'sdd-ai-approvals.lock'), '{}')
    if (state === 'commit-intent') { record.commit.state = 'intent'; delete record.commit.sha; archiveJson(join(s.source, 'sdd-ai-phases.json'), record) }
    if (state === 'review') archiveJson(join(s.checkoutRoot, '.sdd-ai', 'runs', 'review-selected', 'status.json'), { state: 'running' })
    if (state === 'review-lock') archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'runs', 'review-selected', 'review.lock'), '{}')
    if (state === 'publication') {
      record.phases.specify = { amended: { run: 'amendment', consumed: false } }
      archiveJson(join(s.source, 'sdd-ai-phases.json'), record)
    }
    if (state === 'chain') {
      record.implement = { schema: 1, chains: [{ id: 'chain', entries: [{ kind: 'implement', run: 'chain-writer', parent: null, at: '2026-01-02T03:04:05Z' }], terminal: null }], classifications: [], events: [] }
      archiveJson(join(s.source, 'sdd-ai-phases.json'), record)
      archiveJson(join(s.checkoutRoot, '.sdd-ai', 'runs', 'chain-writer', 'status.json'), { state: 'running' })
    }
    if (state === 'missing-required') rmSync(s.sources.ledger)
    let reservation
    if (state === 'verify-reservation') { reservation = acquireReservation(s.checkoutRoot, 'verify-live', 'verify'); assert.equal(reservation.ok, true) }
    try {
      // Una preparación íntegra tolera una fuente realmente ausente; el caso antiguo sin prepare se prueba aparte.
      const preview = previewArchive(s.checkoutRoot, s.flowId, summary) as { state: string; impediments: { code: string }[] }
      assert.equal(preview.state, state === 'missing-required' ? 'ready' : 'blocked')
      // El bloqueo tiene que venir de la actividad del caso, no de una discrepancia de evidencia.
      if (state !== 'missing-required') assert.ok(preview.impediments.some((i) => i.code === activityCodes[state]), `${state}: ${JSON.stringify(preview.impediments)}`)
    } finally { if (reservation?.ok) releaseAll(reservation.handles) }
  }
  const old = createArchiveSandbox({ evidence: true }); t.after(old.cleanup)
  rmSync(old.sources.ledger)
  assert.notEqual(previewArchive(old.checkoutRoot, old.flowId, summary).state, 'ready')
  for (const kind of ['writer', 'writer-group', 'control-invalid', 'membership', 'control-id', 'harvest-invalid', 'store-link',
    'store-inaccessible', 'status-inaccessible', 'phase-special', 'reservation-invalid', 'terminal-publication', 'revision-active']) {
    if (process.platform === 'win32' && ['writer-group', 'store-link', 'store-inaccessible', 'status-inaccessible', 'phase-special'].includes(kind)) {
      t.diagnostic(`${kind}: requiere grupos, permisos o rutas POSIX`); continue
    }
    if (process.getuid?.() === 0 && ['store-inaccessible', 'status-inaccessible'].includes(kind)) {
      t.diagnostic(`${kind}: requiere un usuario sin privilegios root`); continue
    }
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    prepareArchive(s.checkoutRoot, s.flowId); answerArchive(s, summary)
    const recordFile = join(s.source, 'sdd-ai-phases.json'), record = readArchiveJson<any>(recordFile)
    const run = 'archive-active-writer', dir = storeDir(s.checkoutRoot, run)
    const control = { id: run, base: archiveGit(s.checkoutRoot, 'rev-parse', 'HEAD'), family: 'codex', prompt: 'fixture',
      checkout: { root: s.checkoutRoot, ...gitDirs(s.checkoutRoot) }, request: { role: 'implement', conductor: 'codex', deadline_sec: 30 },
      preLaunch: {}, inventory: {}, runDir: { dev: 1, ino: 1 }, phase: { flow: s.flowId, pending: ['T1'], inputs: {}, handoff_header: 'fixture' } }
    let restore = () => {}, alive: Awaited<ReturnType<typeof barrierProcess>> | undefined
    try {
      if (['writer', 'writer-group', 'control-invalid', 'membership', 'control-id', 'harvest-invalid', 'store-link', 'store-inaccessible'].includes(kind)) {
        archiveJson(join(dir, 'control.json'), control)
        if (kind === 'writer-group') {
          alive = await barrierProcess(s.base)
          archiveJson(join(dir, 'control.json'), { ...control, group: { pid: alive.child.pid!, pgid: alive.child.pid!, lstart: null, argvHash: 'fixture' } })
          archiveJson(join(dir, 'harvest.json'), { state: 'done', base: control.base, tree: control.base, files: [],
            patchFile: join(dir, 'diff.patch'), flagged: [], runAltered: [], headMoved: false, endMark: true })
        }
        if (kind === 'control-invalid') archiveWrite(join(dir, 'control.json'), '{')
        if (kind === 'membership') archiveJson(join(dir, 'control.json'), { ...control, phase: {} })
        if (kind === 'control-id') archiveJson(join(dir, 'control.json'), { ...control, id: 'different-writer' })
        if (kind === 'harvest-invalid') archiveWrite(join(dir, 'harvest.json'), '{')
        if (kind === 'store-link') { renameSync(dir, `${dir}-real`); symlinkSync(`${dir}-real`, dir) }
        if (kind === 'store-inaccessible') { chmodSync(dir, 0); restore = () => chmodSync(dir, 0o700) }
      }
      if (kind === 'status-inaccessible' || kind === 'terminal-publication') {
        record.last_run = { id: run, step: 'specify' }; archiveJson(recordFile, record)
        const status = join(s.checkoutRoot, '.sdd-ai', 'runs', run, 'status.json')
        archiveJson(status, { state: 'done' })
        if (kind === 'status-inaccessible') { chmodSync(status, 0); restore = () => chmodSync(status, 0o600) }
        else archiveJson(join(s.checkoutRoot, '.sdd-ai', 'runs', run, 'phase.json'), { outcome: 'published', registry_pending: true })
      }
      if (kind === 'phase-special') { rmSync(recordFile); execFileSync('mkfifo', [recordFile]) }
      if (kind === 'reservation-invalid') archiveWrite(join(gitDirs(s.checkoutRoot).gitDir, 'sdd-ai', 'checkout.lock'), '{')
      if (kind === 'revision-active') {
        const artifact = `.plans/${s.flowId}/spec.md`, digest = `sha256:${'a'.repeat(64)}`
        record.revisions = { entries: [{ run, origin_run: run, parent_run: null, phase: 'specify', artifact, family: 'codex',
          session_mode: 'same', session_id: 'synthetic-session', launch: { cmd: 'codex', args: [], cwd: '.', stdinFile: `.sdd-ai/runs/${run}/stdin.md` },
          review: 'review-selected', round: 1, candidate: digest, ledger_digest: digest, accepted: ['F-1'], decisions: [], history: [], materials: [],
          at: '2026-01-02T03:04:05Z', state: 'active' }], active: { run, artifact }, barriers: [] }
        archiveJson(recordFile, record)
      }
      const original = readFileSync(join(s.source, 'spec.md')), head = archiveGit(s.vaultRoot, 'rev-parse', 'HEAD')
      const preview = previewArchive(s.checkoutRoot, s.flowId, summary)
      assert.equal(preview.state, 'blocked', kind)
      assert.ok((preview.impediments as { code: string }[]).some(({ code }) => /activity|writer|phase|revision|publication_pending|read_failed|path_invalid|evidence_invalid/.test(code)), kind)
      const result = await runArchiveCli(s, ['--apply', '--summary', summary])
      assert.notEqual(result.code, 0, kind)
      assert.deepEqual(readFileSync(join(s.source, 'spec.md')), original, kind)
      assert.equal(archiveGit(s.vaultRoot, 'rev-parse', 'HEAD'), head, kind)
      assert.deepEqual(loadArchiveOperations(s.checkoutRoot, s.flowId), [], kind)
      if (alive) { assert.equal(alive.child.exitCode, null); assert.equal(alive.child.signalCode, null) }
    } finally { restore(); if (alive) await alive.release() }
  }
  for (const [status, step] of [['committed', 'push'], ['pushed', 'open_pr']] as const) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    archiveGit(s.checkoutRoot, 'remote', 'add', 'origin', 'https://example.invalid/archive-fixture.git')
    archiveWrite(join(s.source, 'spec.md'), '# Spec\n\n- **AC-1:** resultado observable. (pedido)\n')
    archiveWrite(join(s.source, 'plan.md'), `---\nid: ${s.flowId}\nprofundidad: completa\nstatus: ${status}\n---\n\n# Plan\n\n## Enfoque\n\nCambio acotado.\n`)
    archiveWrite(join(s.source, 'handoff.md'), '---\nprofundidad: completa\nspec_approved_at: 2026-01-02T03:04:05Z\n---\n\n# Handoff\n')
    archiveWrite(join(s.source, 'tasks.md'), '# Tasks\n\n- [x] **T1 — implementar** · actor: writer · cubre: AC-1\n')
    archiveJson(join(s.source, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [] })
    assert.equal(resolveFlow(readFlow(s.checkoutRoot, s.flowId).facts).next.step, step)
    prepareArchive(s.checkoutRoot, s.flowId); answerArchive(s, summary)
    const gates = readFileSync(join(s.source, 'sdd-ai-approvals.json')), original = inventoryArchiveTree(s.source)
    assert.equal((await runArchiveInProcess(s, { summary })).state, 'completed')
    const archived = loadArchiveOperations(s.checkoutRoot, s.flowId)[0].manifest.binding.input.destination.documents
    assert.deepEqual(inventoryArchiveTree(archived), original)
    assert.deepEqual(readFileSync(join(archived, 'sdd-ai-approvals.json')), gates)
    assert.equal(archiveGit(s.checkoutRoot, 'remote', 'get-url', 'origin'), 'https://example.invalid/archive-fixture.git')
  }
})

test('el resultado separa archivo commit retiro y publicación sin cambiar gates', async (t) => {
  for (const point of [null, 'after_copy_entry', 'after_vault_commit', 'after_retirement_entry'] as const) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    archiveJson(join(s.source, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [] })
    const gates = readFileSync(join(s.source, 'sdd-ai-approvals.json'))
    answerArchive(s)
    if (point) await assert.rejects(runArchiveInProcess(s, { summary, fault: (at) => { if (at === point) throw new ArchiveInjectedCrash(at) } }), ArchiveInjectedCrash)
    else await runArchiveInProcess(s, { summary })
    const view = await runArchiveCli(s, [])
    assert.equal(view.out.remote_publication, 'not_performed')
    assert.equal(view.out.retirement, point ? 'pending' : 'complete')
    const operations = loadArchiveOperations(s.checkoutRoot, s.flowId)
    assert.equal(operations.length, 1)
    const preserved = point === 'after_copy_entry' ? s.source : operations[0].manifest.binding.input.destination.documents
    assert.deepEqual(readFileSync(join(preserved, 'sdd-ai-approvals.json')), gates)
    if (point === 'after_copy_entry') assert.equal(view.out.local_archive, 'pending')
    if (point === 'after_retirement_entry') assert.equal(view.out.vault_commit.state, 'verified')
    assert.equal(archiveGit(s.vaultRoot, 'remote'), '')
  }
  const failure = createArchiveSandbox(); t.after(failure.cleanup)
  archiveJson(join(failure.source, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [] }); answerArchive(failure)
  const original = inventoryArchiveTree(failure.source)
  archiveGit(failure.vaultRoot, 'config', 'user.name', ''); archiveGit(failure.vaultRoot, 'config', 'user.email', '')
  await assert.rejects(runArchiveInProcess(failure, { summary }))
  const view = await runArchiveCli(failure, [])
  assert.equal(view.out.local_archive, 'verified'); assert.equal(view.out.vault_commit.state, 'pending')
  assert.equal(view.out.retirement, 'pending'); assert.equal(view.out.remote_publication, 'not_performed')
  assert.deepEqual(inventoryArchiveTree(failure.source), original)
  assert.equal(archiveGit(failure.vaultRoot, 'remote'), '')
})
