import { readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { askNext, prove } from '../approval/proof.ts'
import { archiveQuestion, buildArchiveBinding, type ArchiveBinding } from '../approval/question.ts'
import { loadVaultPath } from '../config.ts'
import { gitDirs } from '../git.ts'
import { tryWithLock } from '../lock.ts'
import { resolveVaultIdentity, type VaultIdentity } from '../recall.ts'
import { type Family, SddError, TERMINAL, type RunState } from '../types.ts'
import { inspectReservations } from '../writer-store.ts'
import { assertNoRecordActivity } from './approve-sync.ts'
import { inspectArchiveEvidence, prepareArchiveEvidence, readArchivePhaseRecord, type EvidenceCoverage } from './archive-evidence.ts'
import { buildArchiveNode, type ArchiveNode } from './archive-node.ts'
import { archiveOperationResult, archiveStore, continueArchiveOperation, createArchiveOperation, loadArchiveOperations, projectVaultFiles,
  remainingInventory, type ArchiveOperation } from './archive-operation.ts'
import { archiveContained, archiveHash, archiveSeparated, archiveStat, ArchiveDifference, inventoryArchiveTree,
  readArchiveFile, verifyArchiveTree, type ArchiveFaultInjector, type ArchiveInventory } from './archive-tree.ts'
import { inspectVaultGit, type VaultGitFile } from './archive-vault-git.ts'
import { isFlowId } from './id.ts'
import { PHASES_FILE, runActive, type PhaseRecord } from './phase-state.ts'
import { LOCK_FILE } from './read.ts'

export interface ArchiveDestination {
  kind: 'local' | 'vault'; checkout: string; documents: string; node?: string
  declared_vault_root?: string; real_vault_root?: string; project?: string; identity: VaultIdentity | null
}
export interface ArchiveSnapshot {
  flow: string; destination: ArchiveDestination; inventory: ArchiveInventory | null
  coverage: EvidenceCoverage | null; summary?: string; impediments: { code: string; reason: string }[]
  binding?: ArchiveBinding; node?: ArchiveNode; question?: ReturnType<typeof archiveQuestion>; next?: string
}
export interface ArchiveApplyOptions {
  summary?: string; env: Record<string, string | undefined>; conductor?: Family; fault?: ArchiveFaultInjector
}
const validFlow = (flow: string) => { if (!isFlowId(flow) || flow === 'archived') throw new SddError('usage', 'archive recibe un id de flujo válido'); return flow }

export function resolveArchiveDestination(root: string, flowId: string): ArchiveDestination {
  validFlow(flowId)
  const checkout = realpathSync(root), config = loadVaultPath(checkout)
  if (config.kind === 'none') return { kind: 'local', checkout, documents: join(checkout, '.plans', 'archived', flowId), identity: null }
  if (config.kind === 'invalid') throw new SddError('archive_config_invalid', 'la configuración del vault es inválida')
  let real: string
  try {
    real = realpathSync(config.path)
    if (!archiveStat(real, real)?.isDirectory()) throw new Error('no es directorio')
    readdirSync(real)
  } catch { throw new SddError('archive_destination_unavailable', 'la raíz declarada del vault no es un directorio accesible') }
  // El enlace permitido es solo la raíz declarada, nunca identidades ni componentes interiores.
  const identities = readArchiveFile(real, join(real, '.kv', 'identidades.tsv'))
  if (!identities) throw new SddError('archive_identity_invalid', 'no está disponible el registro de identidades')
  const identity = resolveVaultIdentity(checkout, real)
  if (identity.status !== 'ok') throw new SddError(identity.status === 'unresolved' ? 'archive_identity_unresolved' : 'archive_identity_invalid', 'el vault no resuelve un proyecto único y legible')
  if (!isFlowId(identity.project)) throw new SddError('archive_identity_invalid', 'el proyecto no es un segmento válido de ruta')
  const documents = join(real, 'projects', identity.project, 'sdd', flowId), node = `${documents}.md`
  archiveStat(real, documents); archiveStat(real, node)
  archiveSeparated([join(checkout, '.plans', flowId), documents, node])
  return { kind: 'vault', checkout, documents, node, declared_vault_root: config.path,
    real_vault_root: real, project: identity.project, identity }
}

export function assertArchiveActivity(root: string, flow: string, source: string, record?: PhaseRecord | null): void {
  const current = record === undefined ? readArchivePhaseRecord(source, flow, root) : record
  if (current) {
    assertNoRecordActivity(root, flow, current)
    for (const entry of Object.values(current.phases)) {
      if (entry?.amended && !entry.amended.consumed) throw new SddError('archive_publication_pending', 'una ampliación mantiene publicación de artefactos pendiente')
    }
    if (current.revisions?.entries.some((entry) => entry.result?.registry_pending)) throw new SddError('archive_publication_pending', 'una corrección mantiene publicación del registro pendiente')
    if (current.last_run) {
      const bytes = readArchiveFile(root, join(root, '.sdd-ai', 'runs', current.last_run.id, 'phase.json'))
      if (bytes) {
        let result: { registry_pending?: boolean }
        try { result = JSON.parse(bytes.toString()) } catch { throw new SddError('activity_unknown', 'el terminal de fase no es legible') }
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SddError('activity_unknown', 'el terminal de fase es incompatible')
        if (result.registry_pending) throw new SddError('archive_publication_pending', 'el terminal de fase mantiene publicación del registro pendiente')
      }
    }
    if (current.commit?.state === 'intent') throw new SddError('archive_commit_running', 'el commit del flujo tiene una intención pendiente')
    for (const chain of current.implement?.chains ?? []) for (const entry of chain.entries) {
      if (entry.kind !== 'takeover' && runActive(root, entry.run, true)) throw new SddError('archive_writer_running', 'una corrida de la cadena aún puede escribir')
    }
    for (const review of new Set([...(current.reviews ?? []), ...(current.commit?.review ? [current.commit.review] : [])])) {
      const base = join(root, '.sdd-ai', 'runs', review)
      if (archiveStat(root, join(base, 'review.lock'))) throw new SddError('archive_review_running', 'una revisión mantiene su lock')
      const bytes = readArchiveFile(root, join(base, 'status.json'))
      if (bytes) {
        let status: { state?: string }
        try { status = JSON.parse(bytes.toString()) } catch { throw new SddError('activity_unknown', 'el estado de una revisión es ilegible') }
        if (!status?.state || !TERMINAL.has(status.state as RunState)) throw new SddError('archive_review_running', 'una revisión no tiene estado terminal')
      }
    }
  } else assertNoRecordActivity(root, flow, { schema_version: 1, last_run: null, phases: {} })
  if (archiveStat(root, join(source, LOCK_FILE))) throw new SddError('archive_flow_locked', 'el flujo tiene un lock vigente o indeterminado')
  const reservation = inspectReservations(root, ['checkout'])
  if (reservation) throw new SddError('archive_activity_pending', 'el checkout mantiene una reserva escritora o indeterminada')
}

export function projectedVaultFiles(destination: ArchiveDestination, inventory: ArchiveInventory, node: ArchiveNode): VaultGitFile[] {
  return projectVaultFiles(destination, inventory, { sha256: archiveHash(node.bytes), size: node.bytes.length })
}

function inspect(root: string, flow: string, summary?: string): ArchiveSnapshot {
  const destination = resolveArchiveDestination(root, flow)
  const source = join(root, '.plans', flow), snapshot: ArchiveSnapshot = { flow, destination, inventory: null, coverage: null,
    ...(summary === undefined ? {} : { summary }), impediments: [] }
  const check = (fn: () => void): void => {
    try { fn() } catch (error) {
      snapshot.impediments.push({ code: error instanceof SddError ? error.code : 'archive_read_failed',
        reason: error instanceof SddError ? [error.message, error.detail].filter(Boolean).join(': ') : 'lectura o inspección fallida' })
    }
  }
  check(() => { archiveStat(root, source); snapshot.inventory = inventoryArchiveTree(source) })
  check(() => {
    snapshot.coverage = inspectArchiveEvidence(root, flow, source)
    for (const impediment of snapshot.coverage.impediments) snapshot.impediments.push({ code: impediment.code, reason: `${impediment.path}: ${impediment.reason}` })
  })
  check(() => assertArchiveActivity(root, flow, source))
  check(() => {
    const base = destination.real_vault_root ?? root
    if (archiveStat(base, destination.documents) || (destination.node && archiveStat(base, destination.node))) throw new SddError('archive_collision', 'el destino preexistente no pertenece a una operación nueva')
  })
  if (destination.kind === 'vault') {
    check(() => { snapshot.node = buildArchiveNode({ flow, project: destination.project!, date: new Date().toISOString(), summary: summary! }) })
    if (snapshot.inventory && snapshot.node) check(() => inspectVaultGit(destination.real_vault_root!, projectedVaultFiles(destination, snapshot.inventory!, snapshot.node!)))
  }
  if (!snapshot.impediments.length && snapshot.inventory && snapshot.coverage) {
    snapshot.binding = buildArchiveBinding({ flow, destination, identity: destination.identity, inventory: snapshot.inventory,
      selection: snapshot.coverage.selection, provenance: snapshot.coverage.provenance,
      ...(destination.kind === 'vault' ? { summary } : {}) })
    snapshot.question = archiveQuestion(snapshot.binding); snapshot.next = askNext(snapshot.question)
  }
  return snapshot
}

export function previewArchive(root: string, flow: string, summary?: string): Record<string, unknown> {
  root = realpathSync(root); validFlow(flow)
  const operations = loadArchiveOperations(root, flow), open = operations.find((o) => !['aborted', 'completed'].includes(o.progress.state))
  if (open) {
    const m = open.manifest, p = open.progress
    const claimed = p.claimed || (p.actions.claim === 'intent' && archiveStat(root, m.layout.source) === null)
    const source = claimed ? m.layout.claimed : m.layout.source
    const remaining = remainingInventory(open, true)
    const impediments: { code: string; reason: string }[] = []
    const check = (fn: () => void) => {
      try { fn() } catch (error) { impediments.push({ code: error instanceof SddError ? error.code : 'archive_read_failed',
        reason: error instanceof SddError ? [error.message, error.detail].filter(Boolean).join(': ') : 'lectura fallida' }) }
    }
    if (p.state === 'running') {
      const checks = operationChecks(root, flow, open)
      check(() => checks.activity(source)); check(() => checks.revalidate(source, remaining))
      if (m.binding.input.destination.kind === 'vault') {
        const files = projectVaultFiles(m.binding.input.destination, m.binding.input.inventory,
          { sha256: m.node!.sha256, size: Buffer.from(m.node!.bytes, 'base64').length })
        check(() => inspectVaultGit(m.binding.input.destination.real_vault_root!, files))
      }
    }
    return { ...archiveOperationResult(open), destination: m.binding.input.destination, inventory: m.binding.input.inventory,
      selection: m.binding.input.selection, provenance: m.binding.input.provenance, summary: m.binding.input.summary,
      remaining, impediments }
  }
  if (archiveStat(root, join(root, '.plans', flow)) === null) {
    const completed = operations.findLast((o) => o.progress.state === 'completed')
    return completed ? archiveOperationResult(completed) : { flow, state: 'source_absent', remote_publication: 'not_performed' }
  }
  const snapshot = inspect(root, flow, summary)
  // El nodo se presenta por metadatos, no por su cuerpo. El inventario no contiene extractos.
  const { node: _node, ...output } = snapshot
  return { ...output, state: snapshot.impediments.length ? 'blocked' : 'ready', remote_publication: 'not_performed' }
}

export function prepareArchive(root: string, flow: string): EvidenceCoverage {
  root = realpathSync(root); validFlow(flow)
  if (loadArchiveOperations(root, flow).some((o) => !['aborted', 'completed'].includes(o.progress.state))) throw new SddError('archive_operation_pending', 'no se prepara el inventario de una operación abierta')
  const source = join(root, '.plans', flow)
  assertArchiveActivity(root, flow, source)
  return prepareArchiveEvidence(root, flow, source)
}

function operationChecks(root: string, flow: string, operation: ArchiveOperation, fault?: ArchiveFaultInjector) {
  const m = operation.manifest, inventory = m.binding.input.inventory
  const evidenceSource = (source: string, remaining: ArchiveInventory): string => (remaining.files.some((file) => file.path === PHASES_FILE)
    || !inventory.files.some((file) => file.path === PHASES_FILE)) ? source : m.binding.input.destination.documents
  return {
    revalidate(source: string, remaining: ArchiveInventory): void {
      const destination = resolveArchiveDestination(root, flow)
      if (JSON.stringify(destination) !== JSON.stringify(m.binding.input.destination)) {
        // La ligadura canoniza el orden de claves; comparar por la misma función evita depender de él.
        const actual = buildArchiveBinding({ ...m.binding.input, destination, identity: destination.identity })
        if (actual.code !== m.binding.code) throw new ArchiveDifference('destination', 'identidad o destino cambiaron')
      }
      if (archiveStat(root, source) === null) {
        if (remaining.files.length || remaining.directories.length || !operation.progress.actions['retire:.']) throw new ArchiveDifference('.', 'el remanente falta')
      } else verifyArchiveTree(source, remaining)
      const preparedSource = evidenceSource(source, remaining)
      // Una vez retirada parte de evidencia, el destino verificado conserva el registro completo.
      const coverageSource = remaining.files.filter((file) => file.path.startsWith('evidencia/')).length
        === inventory.files.filter((file) => file.path.startsWith('evidencia/')).length ? preparedSource : m.binding.input.destination.documents
      let coverage: EvidenceCoverage
      try { coverage = inspectArchiveEvidence(root, flow, coverageSource, fault, m.operation_id) } catch (error) {
        if (error instanceof SddError && error.code === 'archive_evidence_invalid') throw new ArchiveDifference('evidencia', error.detail ?? error.message)
        throw error
      }
      const binding = buildArchiveBinding({ ...m.binding.input, selection: coverage.selection, provenance: coverage.provenance })
      if (!coverage.complete || binding.code !== m.binding.code) throw new ArchiveDifference('evidencia', 'selección o procedencia cambiaron')
    },
    activity(source: string): void {
      const recordSource = archiveStat(root, join(source, PHASES_FILE)) ? source : m.binding.input.destination.documents
      const record = readArchivePhaseRecord(recordSource, flow, root)
      assertArchiveActivity(root, flow, source, record)
    },
  }
}

export function applyArchive(root: string, flowId: string, options: ArchiveApplyOptions): Record<string, unknown> {
  root = realpathSync(root); const flow = validFlow(flowId), operations = loadArchiveOperations(root, flow)
  let operation = operations.find((o) => !['aborted', 'completed'].includes(o.progress.state))
  if (operation) {
    if (options.summary !== undefined && options.summary !== operation.manifest.binding.input.summary) throw new SddError('archive_summary_changed', '--summary difiere del resumen autorizado; la operación conserva su autoridad')
    return runExclusive(root, flow, options.fault)
  }
  if (archiveStat(root, join(root, '.plans', flow)) === null) {
    const completed = operations.findLast((o) => o.progress.state === 'completed')
    return completed ? archiveOperationResult(completed) : { flow, state: 'source_absent', remote_publication: 'not_performed' }
  }
  const snapshot = inspect(root, flow, options.summary)
  if (snapshot.impediments.length || !snapshot.binding || !snapshot.question) throw new SddError('archive_blocked', 'el ensayo no es apto para aplicar', {
    detail: snapshot.impediments.map((item) => `${item.code}: ${item.reason}`).join('; '), next: 'resuelve los impedimentos y repite el ensayo; la preparación requiere --prepare',
  })
  const proof = prove({ env: options.env, conductor: options.conductor, q: snapshot.question, authorizes: 'Archivar',
    consumed: new Set(operations.map((o) => o.manifest.proof.ref)) })
  createArchiveOperation(root, flow, snapshot.binding, proof, snapshot.node ? {
    bytes: snapshot.node.bytes.toString('base64'), sha256: archiveHash(snapshot.node.bytes), date: snapshot.node.date,
  } : null)
  return runExclusive(root, flow, options.fault)
}

/** Una sola invocación ejecuta el motor; el progreso se relee bajo el lock para no trabajar con una vista vieja. */
function runExclusive(root: string, flow: string, fault?: ArchiveFaultInjector): Record<string, unknown> {
  const ran = tryWithLock(join(dirname(archiveStore(root, flow)), `.apply-${flow}.lock`), () => {
    const operation = loadArchiveOperations(root, flow).find((o) => !['aborted', 'completed'].includes(o.progress.state))
    if (!operation) {
      const completed = loadArchiveOperations(root, flow).findLast((o) => o.progress.state === 'completed')
      if (!completed) throw new SddError('archive_operation_pending', 'la operación terminó en otra invocación; repite el ensayo')
      return archiveOperationResult(completed)
    }
    return continueArchiveOperation(operation, operationChecks(root, flow, operation, fault), fault)
  })
  if (!ran.ok) throw new SddError('archive_busy', 'otra invocación está aplicando la operación del flujo; espera y reanuda')
  return ran.value
}
