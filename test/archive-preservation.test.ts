import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { prepareArchive, previewArchive } from '../src/sdd/archive.ts'
import { ArchiveInjectedCrash, archiveHash, inventoryArchiveTree } from '../src/sdd/archive-tree.ts'
import { loadArchiveOperations } from '../src/sdd/archive-operation.ts'
import { answerArchive, archiveGit, archiveJson, archiveWrite, createArchiveSandbox, readArchiveJson, runArchiveInProcess } from './archive-fixture.ts'
import { type EvidenceProvenance } from '../src/sdd/archive-evidence.ts'

const summary = 'Resumen exclusivo: summaryneedle PR#12'

test('el destino conserva todos los cuerpos sin origen temporales ni corridas externas y los fallos conservan el origen', async (t) => {
  const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
  prepareArchive(s.checkoutRoot, s.flowId)
  const inventory = inventoryArchiveTree(s.source); answerArchive(s)
  const result = await runArchiveInProcess(s, { summary })
  assert.equal(result.retirement, 'complete')
  const op = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
  rmSync(join(s.checkoutRoot, '.sdd-ai', 'runs'), { recursive: true })
  rmSync(join(s.checkoutRoot, '.git', 'sdd-ai', 'verify'), { recursive: true })
  assert.deepEqual(inventoryArchiveTree(op.manifest.binding.input.destination.documents), inventory)
  assert.throws(() => readFileSync(join(s.source, 'spec.md')))
  assert.throws(() => readFileSync(join(op.manifest.layout.staging, 'documents', 'spec.md')))
  for (const fault of ['omit', 'alter', 'unreadable'] as const) {
    const sandbox = createArchiveSandbox(); t.after(sandbox.cleanup); answerArchive(sandbox)
    const before = inventoryArchiveTree(sandbox.source)
    let staging = ''
    await assert.rejects(runArchiveInProcess(sandbox, { summary, fault: (point, context) => {
      if (point !== 'before_staging_verify') return
      staging = context.path!
      const target = join(staging, 'documents', 'spec.md')
      if (fault === 'omit') rmSync(target)
      if (fault === 'alter') archiveWrite(target, 'different')
      if (fault === 'unreadable') throw new Error('lectura de copia fallida')
    } }))
    assert.deepEqual(inventoryArchiveTree(sandbox.source), before)
    assert.throws(() => inventoryArchiveTree(staging))
    const proof = loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0].manifest.proof
    const resumed = await runArchiveInProcess(sandbox, { env: {} })
    assert.equal(resumed.retirement, 'complete')
    assert.deepEqual(loadArchiveOperations(sandbox.checkoutRoot, sandbox.flowId)[0].manifest.proof, proof)
    assert.throws(() => inventoryArchiveTree(staging))
  }
})

test('archive distingue cambios autorizados summary distinto copia temporal defectuosa y destino publicado defectuoso', async (t) => {
  const early = createArchiveSandbox(); t.after(early.cleanup); answerArchive(early)
  const aborted = await runArchiveInProcess(early, { summary, fault: (point) => {
    if (point === 'after_copy_entry') archiveWrite(join(early.source, 'added.txt'), 'added')
  } })
  assert.equal(aborted.state, 'aborted')
  const earlyOperation = loadArchiveOperations(early.checkoutRoot, early.flowId)[0]
  assert.throws(() => inventoryArchiveTree(earlyOperation.manifest.layout.staging))
  assert.ok(readFileSync(join(early.source, 'added.txt')))
  const argument = createArchiveSandbox(); t.after(argument.cleanup); answerArchive(argument)
  await assert.rejects(runArchiveInProcess(argument, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }))
  const before = loadArchiveOperations(argument.checkoutRoot, argument.flowId)
  await assert.rejects(runArchiveInProcess(argument, { summary: 'otro resumen', env: {} }))
  assert.deepEqual(loadArchiveOperations(argument.checkoutRoot, argument.flowId), before)
  assert.equal((await runArchiveInProcess(argument, { env: {} })).state, 'completed')
  for (const when of ['after_documents_publication', 'after_vault_commit'] as const) {
    for (const damage of ['missing', 'different'] as const) {
      const s = createArchiveSandbox(); t.after(s.cleanup); answerArchive(s)
      const source = inventoryArchiveTree(s.source)
      await assert.rejects(runArchiveInProcess(s, { summary, fault: (point) => { if (point === when) throw new ArchiveInjectedCrash(point) } }))
      const op = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
      const target = join(op.manifest.binding.input.destination.documents, 'spec.md')
      if (damage === 'missing') rmSync(target); else archiveWrite(target, 'damaged published bytes')
      const result = await runArchiveInProcess(s, { env: {} })
      assert.equal(result.state, 'stopped')
      assert.equal(result.preservation, 'pending')
      assert.deepEqual(inventoryArchiveTree(s.source), source)
      if (damage === 'different') assert.equal(readFileSync(target, 'utf8'), 'damaged published bytes')
      else assert.throws(() => readFileSync(target))
      assert.equal((await runArchiveInProcess(s, { env: {} })).state, 'stopped')
    }
    const transient = createArchiveSandbox(); t.after(transient.cleanup); answerArchive(transient)
    await assert.rejects(runArchiveInProcess(transient, { summary, fault: (point) => { if (point === when) throw new ArchiveInjectedCrash(point) } }), ArchiveInjectedCrash)
    const record = loadArchiveOperations(transient.checkoutRoot, transient.flowId)[0], original = inventoryArchiveTree(transient.source)
    const published = inventoryArchiveTree(record.manifest.binding.input.destination.documents), head = archiveGit(transient.vaultRoot, 'rev-parse', 'HEAD')
    let readFailed = false
    await assert.rejects(runArchiveInProcess(transient, { env: {}, fault: (point) => {
      if (point === 'before_destination_read') { readFailed = true; throw Object.assign(new Error('lectura de destino fallida'), { code: 'EIO' }) }
    } }))
    assert.ok(readFailed)
    assert.deepEqual(loadArchiveOperations(transient.checkoutRoot, transient.flowId)[0], record)
    assert.deepEqual(inventoryArchiveTree(transient.source), original)
    assert.deepEqual(inventoryArchiveTree(record.manifest.binding.input.destination.documents), published)
    assert.equal(archiveGit(transient.vaultRoot, 'rev-parse', 'HEAD'), head)
    assert.equal((await runArchiveInProcess(transient, { env: {} })).state, 'completed')
    assert.equal(archiveGit(transient.vaultRoot, 'rev-list', '--count', 'HEAD'), '2')
  }
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const s = createArchiveSandbox(); t.after(s.cleanup); answerArchive(s)
    await assert.rejects(runArchiveInProcess(s, { summary, fault: (point) => { if (point === 'after_documents_publication') throw new ArchiveInjectedCrash(point) } }))
    const op = loadArchiveOperations(s.checkoutRoot, s.flowId)[0], target = join(op.manifest.binding.input.destination.documents, 'spec.md')
    chmodSync(target, 0)
    try {
      await assert.rejects(runArchiveInProcess(s, { env: {} }))
      assert.equal(loadArchiveOperations(s.checkoutRoot, s.flowId)[0].progress.state, 'running')
    } finally { chmodSync(target, 0o600) }
    assert.equal((await runArchiveInProcess(s, { env: {} })).state, 'completed')
  }
  for (const point of ['after_copy_entry', 'after_documents_publication', 'after_vault_commit'] as const) {
    for (const mutation of ['bytes', 'new-file', 'rename', 'references', 'provenance', 'source', 'identity', 'destination', 'realpath']) {
      if (mutation === 'realpath' && process.platform === 'win32') { t.diagnostic('realpath: requiere enlaces POSIX'); continue }
      const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
      const alias = join(s.base, 'declared-vault')
      if (mutation === 'realpath') {
        symlinkSync(s.vaultRoot, alias)
        archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), `knowledge-vault:\n  path_vault: ${JSON.stringify(alias)}\n`)
      }
      prepareArchive(s.checkoutRoot, s.flowId); answerArchive(s)
      await assert.rejects(runArchiveInProcess(s, { summary, fault: (at) => { if (at === point) throw new ArchiveInjectedCrash(at) } }), ArchiveInjectedCrash)
      const op = loadArchiveOperations(s.checkoutRoot, s.flowId)[0], d = op.manifest.binding.input.destination
      const head = archiveGit(s.vaultRoot, 'rev-parse', 'HEAD')
      const published = point === 'after_copy_entry' ? null : inventoryArchiveTree(d.documents)
      const sourceBytes = readFileSync(s.sources.ledger)
      if (mutation === 'bytes') archiveWrite(join(s.source, 'spec.md'), 'origen cambiado')
      if (mutation === 'new-file') archiveWrite(join(s.source, 'unapproved.txt'), 'nuevo')
      if (mutation === 'rename') renameSync(join(s.source, 'spec.md'), join(s.source, 'renamed.md'))
      if (mutation === 'references') {
        const file = join(s.source, 'sdd-ai-phases.json'), record = readArchiveJson<any>(file)
        record.commit.review = 'different-review'; archiveJson(file, record)
      }
      if (mutation === 'provenance') {
        const file = join(s.source, 'evidencia/archive-provenance.json'), provenance = readArchiveJson<EvidenceProvenance>(file)
        provenance.entries[0].size += 1; archiveJson(file, provenance)
      }
      if (mutation === 'source') archiveJson(s.sources.ledger, { changed: 'fuente derivada disponible' })
      if (mutation === 'identity') archiveWrite(join(s.vaultRoot, '.kv', 'identidades.tsv'),
        readFileSync(join(s.vaultRoot, '.kv', 'identidades.tsv'), 'utf8').replace('fixture-project', 'different-project'))
      if (mutation === 'destination') archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), '{}\n')
      if (mutation === 'realpath') {
        const target = join(s.base, 'different-vault'); mkdirSync(target)
        archiveWrite(join(target, '.kv', 'identidades.tsv'), readFileSync(join(s.vaultRoot, '.kv', 'identidades.tsv')))
        archiveWrite(join(target, 'base.txt'), 'base'); archiveGit(target, 'init', '-q'); archiveGit(target, 'add', 'base.txt'); archiveGit(target, 'commit', '-qm', 'base')
        rmSync(alias); symlinkSync(target, alias)
      }
      const remaining = inventoryArchiveTree(s.source)
      const result = await runArchiveInProcess(s, { env: {} })
      const label = `${point}: ${mutation}`
      assert.equal(result.state, point === 'after_copy_entry' ? 'aborted' : 'stopped', label)
      assert.deepEqual(inventoryArchiveTree(s.source), remaining, label)
      assert.equal(archiveGit(s.vaultRoot, 'rev-parse', 'HEAD'), head, `${label}: no hay otro commit`)
      assert.equal(result.remote_publication, 'not_performed')
      assert.deepEqual(loadArchiveOperations(s.checkoutRoot, s.flowId)[0].manifest, op.manifest)
      if (published) {
        assert.deepEqual(inventoryArchiveTree(d.documents), published, `${label}: no se repara el destino`)
        assert.equal((await runArchiveInProcess(s, { env: {} })).state, 'stopped')
      } else {
        assert.throws(() => inventoryArchiveTree(op.manifest.layout.staging))
        assert.throws(() => lstatSync(d.documents))
      }
      if (mutation !== 'source') assert.deepEqual(readFileSync(s.sources.ledger), sourceBytes)
    }
  }
  // Recalcular cuerpo y procedencia después de autorizar tampoco legitima la edición.
  const redacted = createArchiveSandbox({ evidence: true }); t.after(redacted.cleanup)
  const originalLedger = readFileSync(redacted.sources.ledger)
  prepareArchive(redacted.checkoutRoot, redacted.flowId); answerArchive(redacted)
  await assert.rejects(runArchiveInProcess(redacted, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }))
  const file = join(redacted.source, 'evidencia/archive-provenance.json'), provenance = readArchiveJson<EvidenceProvenance>(file)
  const ledger = provenance.entries.find((entry) => entry.kind === 'review_ledger')!
  archiveWrite(join(redacted.source, ledger.prepared), '{"redacted":true}')
  const bytes = readFileSync(join(redacted.source, ledger.prepared))
  ledger.sha256 = archiveHash(bytes); ledger.size = bytes.length; ledger.source_path = '.sdd-ai/runs/absent/ledger.json'
  archiveJson(file, provenance)
  assert.equal((await runArchiveInProcess(redacted, { env: {} })).state, 'aborted')
  assert.deepEqual(readFileSync(redacted.sources.ledger), originalLedger)
  assert.deepEqual(readFileSync(join(redacted.source, ledger.prepared)), bytes, 'el rechazo conserva el origen editado')
  assert.notDeepEqual(bytes, originalLedger, 'una edición no puede presentarse como literal')
})

test('archive distingue colisiones ajenas y copia registrada y rechaza enlaces interiores', async (t) => {
  for (const interior of ['source', 'vault', 'collision', 'special'] as const) {
    if (interior !== 'collision' && process.platform === 'win32') { t.diagnostic(`${interior}: requiere enlaces POSIX`); continue }
    const s = createArchiveSandbox(); t.after(s.cleanup)
    if (interior === 'source') symlinkSync(join(s.source, 'spec.md'), join(s.source, 'linked.md'))
    if (interior === 'vault') { mkdirSync(join(s.vaultRoot, 'outside')); symlinkSync(join(s.vaultRoot, 'outside'), join(s.vaultRoot, 'projects')) }
    if (interior === 'collision') archiveWrite(join(s.vaultRoot, 'projects', 'fixture-project', 'sdd', s.flowId, 'spec.md'), readFileSync(join(s.source, 'spec.md')))
    if (interior === 'special') symlinkSync('missing', join(s.source, 'dangling'))
    const original = readFileSync(join(s.source, 'spec.md'))
    let blocked = false
    try { blocked = previewArchive(s.checkoutRoot, s.flowId, summary).state === 'blocked' } catch { blocked = true }
    assert.ok(blocked); assert.deepEqual(readFileSync(join(s.source, 'spec.md')), original)
  }
  if (process.platform === 'win32') t.diagnostic('vault-link: requiere enlaces POSIX')
  else {
    const linked = createArchiveSandbox({ evidence: true }); t.after(linked.cleanup)
    const alias = join(linked.base, 'vault-link'); symlinkSync(linked.vaultRoot, alias)
    archiveWrite(join(linked.checkoutRoot, '.sdd-ai', 'config.yml'), `knowledge-vault:\n  path_vault: ${JSON.stringify(alias)}\n`)
    prepareArchive(linked.checkoutRoot, linked.flowId); answerArchive(linked)
    const originals = Object.fromEntries(Object.entries(linked.sources).map(([name, path]) => [name, readFileSync(path)]))
    await assert.rejects(runArchiveInProcess(linked, { summary, fault: (point) => { if (point === 'after_publication_link') throw new ArchiveInjectedCrash(point) } }))
    assert.equal((await runArchiveInProcess(linked, { env: {} })).state, 'completed')
    for (const [name, path] of Object.entries(linked.sources)) assert.deepEqual(readFileSync(path), originals[name])
  }
  if (process.platform !== 'win32') {
    const special = createArchiveSandbox(); t.after(special.cleanup)
    execFileSync('mkfifo', [join(special.source, 'special-entry')])
    const original = readFileSync(join(special.source, 'spec.md'))
    assert.equal(previewArchive(special.checkoutRoot, special.flowId, summary).state, 'blocked')
    await assert.rejects(runArchiveInProcess(special, { summary }))
    assert.deepEqual(readFileSync(join(special.source, 'spec.md')), original)
    assert.ok(lstatSync(join(special.source, 'special-entry')).isFIFO())
  }
  for (const kind of ['foreign-area', 'replaced-area', 'interior-link'] as const) {
    const s = createArchiveSandbox({ evidence: true }); t.after(s.cleanup)
    prepareArchive(s.checkoutRoot, s.flowId); answerArchive(s)
    const witness = join(s.base, 'external-witness.txt'); archiveWrite(witness, 'testigo externo intacto')
    const areaWitness = join(s.vaultRoot, '.sdd-ai-archive-staging', 'other-operation', 'witness.txt')
    archiveWrite(areaWitness, 'otra operación intacta')
    const original = inventoryArchiveTree(s.source)
    let moved = ''
    if (kind === 'foreign-area') {
      let seeded = false
      await assert.rejects(runArchiveInProcess(s, { summary, fault: (point, context) => {
        if (point !== 'before_source_read' || seeded) return
        seeded = true
        const own = loadArchiveOperations(s.checkoutRoot, s.flowId).find((op) => op.manifest.operation_id === context.operation_id)!
        assert.ok(own, 'la lectura de fuente se liga a la operación durable')
        archiveWrite(join(own.manifest.layout.staging, 'foreign.txt'), 'área ajena preexistente')
      } }))
      assert.ok(seeded, 'el punto de lectura permite comprobar una colisión anterior a crear el área')
    } else {
      await assert.rejects(runArchiveInProcess(s, { summary, fault: (point) => { if (point === 'after_copy_entry') throw new ArchiveInjectedCrash(point) } }))
      const own = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
      if (kind === 'replaced-area') {
        moved = `${own.manifest.layout.staging}-original`
        renameSync(own.manifest.layout.staging, moved)
        archiveWrite(join(own.manifest.layout.staging, 'foreign.txt'), 'raíz sustituida')
      } else {
        if (process.platform === 'win32') { t.diagnostic('interior-link requiere enlaces POSIX'); continue }
        symlinkSync(witness, join(own.manifest.layout.staging, 'documents', 'outside-link'))
      }
      await assert.rejects(runArchiveInProcess(s, { env: {} }))
    }
    const own = loadArchiveOperations(s.checkoutRoot, s.flowId)[0]
    assert.deepEqual(inventoryArchiveTree(s.source), original)
    assert.equal(readFileSync(witness, 'utf8'), 'testigo externo intacto')
    assert.equal(readFileSync(areaWitness, 'utf8'), 'otra operación intacta')
    if (kind !== 'interior-link') assert.ok(readFileSync(join(own.manifest.layout.staging, 'foreign.txt')))
    if (moved) assert.ok(lstatSync(moved).isDirectory())
  }
})
