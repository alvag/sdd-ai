import { randomUUID } from 'node:crypto'
import { linkSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Proof } from '../approval/proof.ts'
import { archiveQuestion, buildArchiveBinding, type ArchiveBinding, type Question } from '../approval/question.ts'
import { gitDirs } from '../git.ts'
import { tryWithLock } from '../lock.ts'
import { SddError } from '../types.ts'
import { archiveContained, archiveHash, archiveSeparated, archiveStat, ArchiveDifference, isArchiveInjectedCrash,
  readArchiveFile, verifyArchiveTree, type ArchiveFaultInjector, type ArchiveInventory } from './archive-tree.ts'
import { DurableWriteError, createArchiveDirectory, syncArchiveDirectory, writeArchiveExclusive, writeArchiveProgress } from './durable.ts'
import { buildArchiveNode } from './archive-node.ts'
import { archiveStagedReport, commitArchiveVault, inspectVaultGit, type VaultCommitProgress, type VaultGitFile } from './archive-vault-git.ts'

export interface ArchiveLayout { store: string; staging: string; claimed: string; source: string }
export interface ArchiveManifest {
  schema_version: 1; operation_id: string; checkout: string; flow: string
  binding: ArchiveBinding; question: Question; proof: Proof; layout: ArchiveLayout
  node: { bytes: string; sha256: string; date: string } | null
}
export interface ArchiveProgress extends VaultCommitProgress {
  schema_version: 1; manifest_digest: string
  state: 'running' | 'aborting' | 'aborted' | 'stopped' | 'completed'
  phase: string; cause?: string
  actions: Record<string, 'intent' | 'done'>
  staging_created?: boolean; staging_cleanup?: 'intent' | 'done'; claimed?: boolean
  claim_identity?: { dev: number; ino: number }
  staging_identity?: { dev: number; ino: number }
  returned?: boolean
  retired: string[]
}
export interface ArchiveOperation { manifest: ArchiveManifest; progress: ArchiveProgress }

export const archiveStore = (root: string, flow: string) => join(gitDirs(root).gitDir, 'sdd-ai', 'archive', flow)
export function archiveLayout(root: string, flow: string, operation: string, binding: ArchiveBinding): ArchiveLayout {
  return {
    store: join(archiveStore(root, flow), operation), source: join(root, '.plans', flow),
    staging: binding.input.destination.kind === 'vault'
      ? join(binding.input.destination.real_vault_root!, '.sdd-ai-archive-staging', operation)
      : join(root, '.sdd-ai', 'archive-staging', operation),
    claimed: join(root, '.sdd-ai', 'archive-claimed', operation),
  }
}
const PENDING_PREFIX = '.pending-'
const RETIRE = 'retire:'
/** Las acciones que publican en el destino; con el reclamo, son los efectos que impiden abortar. */
const isPublicationKey = (key: string) => key.startsWith('mkdir:') || key.startsWith('link:') || key === 'node-publication'
const isEffectKey = (key: string) => isPublicationKey(key) || key === 'claim'
const retiredPath = (key: string) => key.slice(RETIRE.length)
const encoded = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const invalid = () => new SddError('archive_manifest_invalid', 'el almacén de archivo es ilegible o incompatible; no se reconstruye autoridad')

export function ensureArchiveParents(base: string, path: string): void {
  archiveContained(base, path, true)
  if (path === base) { if (!archiveStat(base, base)?.isDirectory()) throw invalid(); return }
  const st = archiveStat(base, path)
  if (st) { if (!st.isDirectory()) throw invalid(); return }
  ensureArchiveParents(base, dirname(path)); createArchiveDirectory(path)
}

export function loadArchiveOperations(root: string, flow: string): ArchiveOperation[] {
  const base = gitDirs(root).gitDir, store = archiveStore(root, flow)
  if (archiveStat(base, store) === null) return []
  const operations: ArchiveOperation[] = []
  for (const name of readdirSync(store).sort()) {
    // Un registro cortado antes del rename nunca publicó su manifiesto: no consumió la respuesta.
    if (name.startsWith(PENDING_PREFIX)) continue
    if (!/^[0-9a-f-]{36}$/.test(name)) throw invalid()
    const dir = join(store, name)
    if (!archiveStat(base, dir)?.isDirectory()) throw invalid()
    const manifestBytes = readArchiveFile(base, join(dir, 'manifest.json')), progressBytes = readArchiveFile(base, join(dir, 'progress.json'))
    if (!manifestBytes || !progressBytes) throw invalid()
    let manifest: ArchiveManifest, progress: ArchiveProgress
    try { manifest = JSON.parse(manifestBytes.toString()); progress = JSON.parse(progressBytes.toString()) } catch { throw invalid() }
    if (!manifest || !progress || manifest.schema_version !== 1 || progress.schema_version !== 1
      || manifest.operation_id !== name || manifest.checkout !== root || manifest.flow !== flow
      || !manifest.binding || !manifest.proof || typeof manifest.proof.ref !== 'string' || !manifest.proof.ref
      || typeof manifest.proof.session !== 'string' || !manifest.proof.session || typeof manifest.proof.answered_at !== 'string'
      || Number.isNaN(Date.parse(manifest.proof.answered_at))
      || !['claude', 'codex'].includes(manifest.proof.runner)
      || progress.manifest_digest !== archiveHash(manifestBytes)
      || !['running', 'aborting', 'aborted', 'stopped', 'completed'].includes(progress.state)
      || !progress.actions || Array.isArray(progress.actions) || !Array.isArray(progress.retired)
      || !['copy', 'commit', 'retirement', 'completed'].includes(progress.phase)
      || (progress.staging_created !== undefined && typeof progress.staging_created !== 'boolean')
      || (progress.claimed !== undefined && typeof progress.claimed !== 'boolean')
      || (progress.staging_cleanup !== undefined && !['intent', 'done'].includes(progress.staging_cleanup))) throw invalid()
    try {
      const binding = buildArchiveBinding(manifest.binding.input)
      const d = binding.input.destination
      if (binding.input.flow !== flow || !['local', 'vault'].includes(d.kind)
        || manifest.proof.source !== (manifest.proof.runner === 'claude' ? 'ask_user_question' : 'rollout_message')) throw invalid()
      if (d.kind === 'local' && (d.documents !== join(root, '.plans', 'archived', flow) || d.node || manifest.node)) throw invalid()
      if (d.kind === 'vault') {
        const identity = binding.input.identity as { status?: string; project?: string }
        if (identity?.status !== 'ok' || !identity.project || !d.real_vault_root || !d.declared_vault_root
          || d.documents !== join(d.real_vault_root, 'projects', identity.project, 'sdd', flow) || d.node !== `${d.documents}.md` || !manifest.node) throw invalid()
        const node = buildArchiveNode({ flow, project: identity.project, date: manifest.node.date, summary: binding.input.summary! })
        if (!node.bytes.equals(Buffer.from(manifest.node.bytes, 'base64'))) throw invalid()
      }
      if (binding.code !== manifest.binding.code || JSON.stringify(archiveQuestion(binding)) !== JSON.stringify(manifest.question)
        || JSON.stringify(archiveLayout(root, flow, name, binding)) !== JSON.stringify(manifest.layout)) throw invalid()
      const files = new Set<string>(), dirs = new Set<string>()
      for (const file of binding.input.inventory.files) {
        if (archiveContained(manifest.layout.source, join(manifest.layout.source, file.path)) !== file.path) throw invalid()
        if (files.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw invalid()
        files.add(file.path)
      }
      for (const dir of binding.input.inventory.directories) {
        if (archiveContained(manifest.layout.source, join(manifest.layout.source, dir)) !== dir) throw invalid()
        if (dirs.has(dir) || files.has(dir)) throw invalid(); dirs.add(dir)
      }
      if (progress.retired.some((path) => path !== '.' && !files.has(path) && !dirs.has(path))) throw invalid()
      if (new Set(progress.retired).size !== progress.retired.length || progress.retired.some((path) => progress.actions[`retire:${path}`] !== 'done')) throw invalid()
      const allowed = new Set(['staging-create', 'publication-verified', 'node-publication', 'claim', 'return-claim',
        ...['.', ...dirs].map((path) => `mkdir:${path}`)])
      for (const file of files) allowed.add(`link:${file}`)
      for (const path of ['.', ...dirs, ...files]) allowed.add(`retire:${path}`)
      if (Object.keys(progress.actions).some((key) => !allowed.has(key))) throw invalid()
      if (Object.values(progress.actions).some((value) => value !== 'intent' && value !== 'done')) throw invalid()
      if (progress.actions['publication-verified'] && progress.actions['publication-verified'] !== 'done') throw invalid()
      if (progress.staging_created && progress.actions['staging-create'] !== 'done') throw invalid()
      if (progress.actions['staging-create'] === 'done' && (!progress.staging_identity
        || !Number.isSafeInteger(progress.staging_identity.dev) || !Number.isSafeInteger(progress.staging_identity.ino))) throw invalid()
      if (progress.retired.length && !progress.claimed) throw invalid()
      if (progress.actions.claim && (!progress.claim_identity || !Number.isSafeInteger(progress.claim_identity.dev)
        || !Number.isSafeInteger(progress.claim_identity.ino))) throw invalid()
      if (progress.claimed && progress.actions.claim !== 'done') throw invalid()
      if (progress.returned !== undefined && (progress.returned !== true || progress.claimed || progress.actions['return-claim'] !== 'done')) throw invalid()
      if (['aborting', 'aborted'].includes(progress.state) && (progress.staging_intent || progress.commit_intent || progress.claimed
        || Object.keys(progress.actions).some(isEffectKey))) throw invalid()
      if (progress.state === 'stopped' && (typeof progress.cause !== 'string' || !progress.cause)) throw invalid()
      if (progress.staging_intent !== undefined && progress.staging_intent !== true) throw invalid()
      if (progress.staged_entries) {
        const projected = new Set([...files].map((path) => archiveContained(d.real_vault_root!, join(d.documents, path))))
        if (d.node) projected.add(archiveContained(d.real_vault_root!, d.node))
        if (!Array.isArray(progress.staged_entries) || progress.staged_entries.length !== projected.size
          || new Set(progress.staged_entries.map((entry) => entry.path)).size !== projected.size) throw invalid()
        for (const entry of progress.staged_entries) if (!projected.has(entry.path)
          || [entry.previous, entry.written].some((metadata) => metadata !== null && !/^100(?:644|755) [0-9a-f]{40,64} 0$/.test(metadata))) throw invalid()
      }
      if (manifest.node && archiveHash(Buffer.from(manifest.node.bytes, 'base64')) !== manifest.node.sha256) throw invalid()
      if (progress.commit_sha && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(progress.commit_sha) || !progress.commit_intent)) throw invalid()
      if (progress.commit_intent && (typeof progress.commit_intent.tree !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(progress.commit_intent.tree)
        || progress.commit_intent.message !== `chore: archive ${name}` || !(progress.commit_intent.parent === null
          || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(progress.commit_intent.parent)))) throw invalid()
      if (progress.state === 'completed' && (!progress.claimed || progress.staging_cleanup !== 'done'
        || progress.retired.length !== files.size + dirs.size + 1 || progress.actions['publication-verified'] !== 'done'
        || (d.kind === 'vault' && !progress.commit_sha))) throw invalid()
    } catch { throw invalid() }
    operations.push({ manifest, progress })
  }
  if (operations.filter((o) => !['aborted', 'completed'].includes(o.progress.state)).length > 1) throw invalid()
  return operations
}

export function saveArchiveOperation(operation: ArchiveOperation): void {
  writeArchiveProgress(join(operation.manifest.layout.store, 'progress.json'), operation.progress)
}

export function createArchiveOperation(root: string, flow: string, binding: ArchiveBinding, proof: Proof,
  node: ArchiveManifest['node']): ArchiveOperation {
  const operationId = randomUUID(), layout = archiveLayout(root, flow, operationId, binding)
  archiveSeparated([layout.source, binding.input.destination.documents, layout.staging, layout.claimed, layout.store,
    ...(binding.input.destination.node ? [binding.input.destination.node] : [])])
  ensureArchiveParents(gitDirs(root).gitDir, dirname(layout.store))
  // El lock solo protege el registro; termina antes de los puntos de interrupción del motor.
  // Releer bajo él evita registrar dos autoridades a partir del mismo ensayo concurrente.
  const registered = tryWithLock(join(dirname(dirname(layout.store)), `.registration-${flow}.lock`), () => {
    const current = loadArchiveOperations(root, flow)
    if (current.some((operation) => !['aborted', 'completed'].includes(operation.progress.state))) throw new SddError('archive_operation_pending', 'otra invocación registró una operación; reanuda su autoridad')
    if (current.some((operation) => operation.manifest.proof.ref === proof.ref)) throw new SddError('approval_reused', 'esa respuesta ya se usó para registrar una decisión')
    const pending = join(dirname(layout.store), `${PENDING_PREFIX}${operationId}`)
    createArchiveDirectory(pending)
    const manifest: ArchiveManifest = { schema_version: 1, operation_id: operationId, checkout: root, flow, binding,
      question: archiveQuestion(binding), proof, layout, node }
    const bytes = encoded(manifest)
    const operation: ArchiveOperation = { manifest, progress: { schema_version: 1, manifest_digest: archiveHash(bytes),
      state: 'running', phase: 'copy', actions: {}, retired: [] } }
    // Progreso y manifiesto se escriben aparte; solo el rename publica la operación y consume la respuesta.
    writeArchiveExclusive(join(pending, 'progress.json'), encoded(operation.progress))
    writeArchiveExclusive(join(pending, 'manifest.json'), bytes)
    renameSync(pending, layout.store); syncArchiveDirectory(dirname(layout.store))
    return operation
  })
  if (!registered.ok) throw new SddError('archive_busy', 'otra invocación está registrando la operación del flujo')
  return registered.value
}

function action(operation: ArchiveOperation, key: string, effect: () => void): void {
  if (operation.progress.actions[key] === 'done') return
  if (!operation.progress.actions[key]) { operation.progress.actions[key] = 'intent'; saveArchiveOperation(operation) }
  effect()
  operation.progress.actions[key] = 'done'; saveArchiveOperation(operation)
}

export function archiveOperationResult(operation: ArchiveOperation): Record<string, unknown> {
  const { manifest: m, progress: p } = operation
  const published = p.actions['publication-verified'] === 'done'
  return {
    flow: m.flow, operation_id: m.operation_id, state: p.state, phase: p.phase, authority: m.proof,
    local_archive: published ? 'verified' : 'pending',
    vault_commit: m.binding.input.destination.kind === 'local' ? 'not_required' : p.commit_sha ? { state: 'verified', sha: p.commit_sha } : { state: 'pending' },
    retirement: p.state === 'completed' ? 'complete' : 'pending', remote_publication: 'not_performed',
    source_location: p.returned ? m.layout.source : p.claimed ? m.layout.claimed : m.layout.source,
    ...(p.actions['return-claim'] === 'intent' ? { source_location_uncertain: true } : {}),
    ...(p.cause ? { cause: p.cause } : {}),
    ...(p.state === 'stopped' ? { preservation: 'pending', vault_staged_entries: m.binding.input.destination.kind === 'vault'
      ? archiveStagedReport(m.binding.input.destination.real_vault_root!, p) : [] } : {}),
  }
}

/** La raíz de contención del destino y del área de copia: el vault real o el checkout. */
function destinationBase(operation: ArchiveOperation): string {
  return operation.manifest.binding.input.destination.real_vault_root ?? operation.manifest.checkout
}

/** Solo el área exclusiva registrada es descartable; nunca alcanza al destino ni al remanente. */
export function cleanupArchiveStaging(operation: ArchiveOperation, fault?: ArchiveFaultInjector): void {
  const { manifest: m, progress: p } = operation, base = destinationBase(operation), area = m.layout.staging
  archiveContained(join(base, m.binding.input.destination.kind === 'vault' ? '.sdd-ai-archive-staging' : '.sdd-ai/archive-staging'), area)
  if (archiveStat(base, area) === null) {
    p.staging_cleanup = 'done'; p.staging_created = false; delete p.staging_identity; delete p.actions['staging-create']; saveArchiveOperation(operation); return
  }
  if (!p.staging_created && p.actions['staging-create'] === 'intent' && archiveStat(base, area)?.isDirectory() && !readdirSync(area).length) {
    rmdirSync(area); syncArchiveDirectory(dirname(area))
    p.staging_cleanup = 'done'; p.staging_created = false; delete p.actions['staging-create']; saveArchiveOperation(operation); return
  }
  if (!p.staging_created && p.actions['staging-create'] !== 'done') throw new SddError('archive_staging_uncertain', 'el área existente no tiene creación propia acreditada; no se adopta ni limpia')
  const identity = archiveStat(base, area)
  if (identity?.dev !== p.staging_identity?.dev || identity?.ino !== p.staging_identity?.ino) throw new SddError('archive_staging_uncertain', 'la raíz del área propia fue sustituida; no se atraviesa ni limpia')
  p.staging_cleanup = 'intent'; saveArchiveOperation(operation)
  const remove = (path: string): void => {
    const stat = archiveStat(base, path)
    if (!stat) return
    if (stat.isDirectory()) { for (const name of readdirSync(path)) remove(join(path, name)); rmdirSync(path) }
    else unlinkSync(path)
    syncArchiveDirectory(dirname(path))
    fault?.('after_staging_cleanup_entry', { operation_id: m.operation_id, phase: p.phase, path })
  }
  remove(area)
  p.staging_cleanup = 'done'; p.staging_created = false; delete p.staging_identity; delete p.actions['staging-create']; saveArchiveOperation(operation)
}

function finalFileBytes(operation: ArchiveOperation, path: string, fault?: ArchiveFaultInjector): Buffer | null {
  fault?.('before_destination_read', { operation_id: operation.manifest.operation_id, phase: 'verify', path })
  return readArchiveFile(destinationBase(operation), path)
}

function verifyPublication(operation: ArchiveOperation, fault?: ArchiveFaultInjector): void {
  const { manifest: m } = operation, destination = m.binding.input.destination
  archiveStat(destinationBase(operation), destination.documents)
  fault?.('before_destination_read', { operation_id: m.operation_id, phase: 'verify', path: destination.documents })
  verifyArchiveTree(destination.documents, m.binding.input.inventory)
  if (m.node) {
    const bytes = finalFileBytes(operation, destination.node!, fault)
    if (!bytes || archiveHash(bytes) !== m.node.sha256) throw new ArchiveDifference(destination.node!, 'el nodo publicado falta o cambió')
  }
}

function verifyAlreadyPublished(operation: ArchiveOperation, fault?: ArchiveFaultInjector): void {
  const { manifest: m, progress: p } = operation, d = m.binding.input.destination
  for (const file of m.binding.input.inventory.files) {
    if (p.actions[`link:${file.path}`] !== 'done') continue
    const bytes = finalFileBytes(operation, join(d.documents, file.path), fault)
    if (!bytes || bytes.length !== file.size || archiveHash(bytes) !== file.sha256) throw new ArchiveDifference(file.path, 'archivo ya publicado ausente o distinto')
  }
  if (p.actions['node-publication'] === 'done' && m.node) {
    const bytes = finalFileBytes(operation, d.node!, fault)
    if (!bytes || archiveHash(bytes) !== m.node.sha256) throw new ArchiveDifference(d.node!, 'nodo ya publicado ausente o distinto')
  }
  for (const path of ['.', ...m.binding.input.inventory.directories]) {
    if (p.actions[`mkdir:${path}`] === 'done' && !archiveStat(destinationBase(operation), path === '.' ? d.documents : join(d.documents, path))?.isDirectory()) {
      throw new ArchiveDifference(path, 'directorio ya publicado ausente o distinto')
    }
  }
}

function copy(operation: ArchiveOperation, fault?: ArchiveFaultInjector): void {
  const { manifest: m, progress: p } = operation, base = destinationBase(operation), area = m.layout.staging
  if (p.staging_cleanup === 'intent') cleanupArchiveStaging(operation, fault)
  if (!p.staging_created) {
    ensureArchiveParents(base, dirname(area))
    const pending = p.actions['staging-create'] === 'intent'
    action(operation, 'staging-create', () => {
      const existing = archiveStat(base, area)
      // Un corte entre crear el área y persistir su identidad deja un directorio propio vacío.
      if (existing !== null) {
        if (!pending || !existing.isDirectory() || readdirSync(area).length) throw new SddError('archive_collision', 'el área de copia ya existe sin creación acreditada')
      } else createArchiveDirectory(area)
      const created = archiveStat(base, area)!
      p.staging_identity = { dev: created.dev, ino: created.ino }
    })
    p.staging_created = true; delete p.staging_cleanup; saveArchiveOperation(operation)
  }
  const identity = archiveStat(base, area)
  if (identity?.dev !== p.staging_identity?.dev || identity?.ino !== p.staging_identity?.ino) throw new SddError('archive_staging_uncertain', 'la raíz del área propia fue sustituida; no se atraviesa')
  const documents = join(area, 'documents')
  const documentsAbsent = archiveStat(area, documents) === null
  ensureArchiveParents(area, documents)
  if (documentsAbsent) fault?.('after_copy_entry', { operation_id: m.operation_id, phase: 'copy', path: '.' })
  for (const dir of m.binding.input.inventory.directories) {
    const target = join(documents, dir), absent = archiveStat(area, target) === null
    ensureArchiveParents(area, target)
    if (absent) fault?.('after_copy_entry', { operation_id: m.operation_id, phase: 'copy', path: dir })
  }
  for (const file of m.binding.input.inventory.files) {
    const target = join(documents, file.path), present = readArchiveFile(area, target)
    if (present) {
      if (present.length !== file.size || archiveHash(present) !== file.sha256) throw new ArchiveDifference(file.path, 'copia temporal distinta')
      continue
    }
    const bytes = readArchiveFile(m.layout.source, join(m.layout.source, file.path))
    if (!bytes || bytes.length !== file.size || archiveHash(bytes) !== file.sha256) throw new ArchiveDifference(file.path, 'origen distinto al copiar')
    writeArchiveExclusive(target, bytes)
    fault?.('after_copy_entry', { operation_id: m.operation_id, phase: 'copy', path: file.path })
  }
  if (m.node) {
    const target = join(area, 'node.md'), existing = readArchiveFile(area, target)
    if (existing && archiveHash(existing) !== m.node.sha256) throw new ArchiveDifference('node.md', 'nodo temporal distinto')
    if (!existing) writeArchiveExclusive(target, Buffer.from(m.node.bytes, 'base64'))
  }
  fault?.('before_staging_verify', { operation_id: m.operation_id, phase: 'copy', path: area })
  verifyArchiveTree(documents, m.binding.input.inventory)
  const allowed = m.node ? ['documents', 'node.md'] : ['documents']
  if (JSON.stringify(readdirSync(area).sort()) !== JSON.stringify(allowed)) throw new ArchiveDifference('.', 'área temporal con entradas distintas')
  if (m.node && archiveHash(readArchiveFile(area, join(area, 'node.md'))!) !== m.node.sha256) throw new ArchiveDifference('node.md', 'nodo temporal distinto')
}

function sameLink(base: string, source: string, target: string): boolean {
  const a = archiveStat(base, source), b = archiveStat(base, target)
  return !!a?.isFile() && !!b?.isFile() && a.dev === b.dev && a.ino === b.ino
}

function publicationLinks(operation: ArchiveOperation): Map<string, string> {
  const { manifest: m } = operation
  const links = new Map(m.binding.input.inventory.files.map((file) =>
    [join(m.binding.input.destination.documents, file.path), join(m.layout.staging, 'documents', file.path)]))
  if (m.node) links.set(m.binding.input.destination.node!, join(m.layout.staging, 'node.md'))
  return links
}

function publicationDirectoryOwn(operation: ArchiveOperation, dir: string): boolean {
  const links = publicationLinks(operation), base = destinationBase(operation), d = operation.manifest.binding.input.destination
  const directories = new Set(['.', ...operation.manifest.binding.input.inventory.directories].map((path) => path === '.' ? d.documents : join(d.documents, path)))
  const walk = (path: string): boolean => readdirSync(path).every((name) => {
    const target = join(path, name), stat = archiveStat(base, target)
    if (stat?.isDirectory()) return directories.has(target) && walk(target)
    const original = links.get(target)
    return !!original && sameLink(base, original, target)
  })
  return walk(dir)
}

/** Atribuye efectos presentes antes de evaluar un aborto; una ruta pendiente ausente sigue sin publicar. */
function reconcilePublication(operation: ArchiveOperation, fault?: ArchiveFaultInjector): void {
  const { manifest: m, progress: p } = operation, d = m.binding.input.destination, base = destinationBase(operation)
  const links = publicationLinks(operation)
  for (const [key, state] of Object.entries(p.actions)) {
    if (state !== 'intent' || !isPublicationKey(key)) continue
    const directory = key.startsWith('mkdir:'), rel = key.slice(key.indexOf(':') + 1)
    const target = key === 'node-publication' ? d.node! : rel === '.' ? d.documents : join(d.documents, rel)
    fault?.('before_destination_read', { operation_id: m.operation_id, phase: 'publication', path: target })
    const stat = archiveStat(base, target)
    if (!stat) { delete p.actions[key]; saveArchiveOperation(operation); continue }
    if (directory ? !stat.isDirectory() || !publicationDirectoryOwn(operation, target)
      : !links.get(target) || !sameLink(base, links.get(target)!, target)) {
      throw new SddError('archive_collision', 'una publicación pendiente encuentra material ajeno; no se adopta')
    }
    p.actions[key] = 'done'; saveArchiveOperation(operation)
  }
}

function publish(operation: ArchiveOperation, fault?: ArchiveFaultInjector): void {
  const { manifest: m, progress: p } = operation, d = m.binding.input.destination, base = destinationBase(operation)
  ensureArchiveParents(base, dirname(d.documents))
  for (const path of ['.', ...m.binding.input.inventory.directories]) {
    const target = path === '.' ? d.documents : join(d.documents, path), key = `mkdir:${path}`
    const wasPending = p.actions[key] === 'intent'
    action(operation, key, () => {
      const st = archiveStat(base, target)
      if (st) {
        if (!wasPending || !st.isDirectory() || !publicationDirectoryOwn(operation, target)) throw new SddError('archive_collision', 'directorio de destino ajeno preexistente')
      } else createArchiveDirectory(target)
    })
  }
  const link = (key: string, source: string, target: string): void => {
    const pending = p.actions[key] === 'intent'
    action(operation, key, () => {
      if (archiveStat(base, target)) {
        if (!pending || !sameLink(base, source, target)) throw new SddError('archive_collision', 'archivo de destino ajeno preexistente')
      } else {
        linkSync(source, target); syncArchiveDirectory(dirname(target))
        fault?.('after_publication_link', { operation_id: m.operation_id, phase: 'publication', path: target })
      }
    })
  }
  for (const file of m.binding.input.inventory.files) link(`link:${file.path}`, join(m.layout.staging, 'documents', file.path), join(d.documents, file.path))
  fault?.('after_documents_publication', { operation_id: m.operation_id, phase: 'publication', path: d.documents })
  if (m.node) link('node-publication', join(m.layout.staging, 'node.md'), d.node!)
  verifyPublication(operation, fault)
  p.actions['publication-verified'] = 'done'; p.phase = 'commit'; saveArchiveOperation(operation)
}

export function remainingInventory(operation: ArchiveOperation, pendingAbsent = false): ArchiveInventory {
  const { manifest: m, progress: p } = operation, removed = new Set(p.retired)
  if (pendingAbsent) for (const [key, state] of Object.entries(p.actions)) {
    if (state === 'intent' && key.startsWith(RETIRE)) {
      const path = retiredPath(key)
      if (archiveStat(m.checkout, path === '.' ? m.layout.claimed : join(m.layout.claimed, path)) === null) removed.add(path)
    }
  }
  return { directories: m.binding.input.inventory.directories.filter((path) => !removed.has(path)),
    files: m.binding.input.inventory.files.filter((file) => !removed.has(file.path)) }
}

/** El conjunto exacto de rutas del vault que se inspeccionan y commitean: documentos más nodo. */
export function projectVaultFiles(d: { real_vault_root?: string; documents: string; node?: string }, inventory: ArchiveInventory,
  node: { sha256: string; size: number }): VaultGitFile[] {
  return [...inventory.files.map((file) => ({ ...file, path: archiveContained(d.real_vault_root!, join(d.documents, file.path)) })),
    { path: archiveContained(d.real_vault_root!, d.node!), sha256: node.sha256, size: node.size }]
}

export interface ArchiveOperationChecks { revalidate(source: string, remaining: ArchiveInventory): void; activity(source: string): void }

/** Ordena efectos e intenciones. Las interrupciones inyectadas atraviesan sin escrituras posteriores. */
export function continueArchiveOperation(operation: ArchiveOperation, checks: ArchiveOperationChecks, fault?: ArchiveFaultInjector): Record<string, unknown> {
  const { manifest: m, progress: p } = operation
  if (p.state === 'stopped' || p.state === 'completed' || p.state === 'aborted') return archiveOperationResult(operation)
  if (p.state === 'aborting') {
    cleanupArchiveStaging(operation, fault); p.state = 'aborted'; saveArchiveOperation(operation); return archiveOperationResult(operation)
  }
  const afterPublication = () => Object.entries(p.actions).some(([key, state]) => isEffectKey(key) && state === 'done') || !!p.staging_intent || !!p.commit_intent || !!p.claimed
  const d = m.binding.input.destination
  const vaultFiles = d.kind !== 'vault' ? null : projectVaultFiles(d, m.binding.input.inventory, { sha256: m.node!.sha256, size: Buffer.from(m.node!.bytes, 'base64').length })
  let sourceDifference = false
  const revalidate = (source: string, remaining: ArchiveInventory): void => {
    try { checks.revalidate(source, remaining) } catch (error) {
      if (error instanceof ArchiveDifference) sourceDifference = true
      throw error
    }
  }
  try {
    reconcilePublication(operation, fault)
    verifyAlreadyPublished(operation, fault)
    // Reconciliar primero un rename realizado antes de persistir su resultado.
    if (p.actions.claim === 'intent') {
      const source = archiveStat(m.checkout, m.layout.source), claimed = archiveStat(m.checkout, m.layout.claimed)
      if (claimed?.isDirectory() && claimed.dev === p.claim_identity?.dev && claimed.ino === p.claim_identity?.ino) {
        p.claimed = true; p.actions.claim = 'done'; saveArchiveOperation(operation)
      }
      else if (source && !claimed) { /* todavía no ocurrió */ }
      else throw new SddError('archive_claim_uncertain', 'el reclamo pendiente no puede atribuirse con certeza')
    }
    const source = p.claimed ? m.layout.claimed : m.layout.source
    if (p.claimed) {
      const claimed = archiveStat(m.checkout, source)
      if (claimed && (claimed.dev !== p.claim_identity?.dev || claimed.ino !== p.claim_identity?.ino)) throw new ArchiveDifference('.', 'el remanente fue reemplazado')
    }
    checks.activity(source)
    revalidate(source, p.claimed ? remainingInventory(operation, true) : m.binding.input.inventory)
    // Las precondiciones Git del vault se comprueban antes de copiar o publicar, no recién al commitear.
    if (vaultFiles && !p.commit_sha) inspectVaultGit(m.binding.input.destination.real_vault_root!, vaultFiles)
    if (!p.actions['publication-verified']) {
      try { copy(operation, fault) } catch (error) {
        if (isArchiveInjectedCrash(error) || error instanceof DurableWriteError) throw error
        // Revalidar evita tratar un cambio del origen como defecto descartable del área.
        checks.activity(m.layout.source); revalidate(m.layout.source, m.binding.input.inventory)
        if (Object.keys(p.actions).some((key) => key.startsWith('mkdir:') || key.startsWith('link:'))) throw error
        cleanupArchiveStaging(operation, fault)
        throw new SddError('archive_preservation_pending', 'se descartó el área de copia defectuosa; reanuda con la misma autoridad')
      }
      checks.activity(m.layout.source); revalidate(m.layout.source, m.binding.input.inventory)
      publish(operation, fault)
    }
    verifyPublication(operation, fault)
    // La publicación conserva sus enlaces; el área propia se termina antes del commit y del reclamo.
    cleanupArchiveStaging(operation, fault)
    if (vaultFiles) commitArchiveVault(m.binding.input.destination.real_vault_root!, vaultFiles, m.operation_id, m.layout.store, p, () => saveArchiveOperation(operation), fault)
    p.phase = 'retirement'; saveArchiveOperation(operation)
    if (!p.claimed) {
      checks.activity(m.layout.source); revalidate(m.layout.source, m.binding.input.inventory); verifyPublication(operation, fault)
      ensureArchiveParents(m.checkout, dirname(m.layout.claimed))
      if (!p.actions.claim) {
        const original = archiveStat(m.checkout, m.layout.source)
        if (!original?.isDirectory()) throw new ArchiveDifference('.', 'el origen dejó de ser un directorio')
        p.claim_identity = { dev: original.dev, ino: original.ino }
      }
      action(operation, 'claim', () => {
        fault?.('before_claim', { operation_id: m.operation_id, phase: p.phase, path: m.layout.source })
        checks.activity(m.layout.source); revalidate(m.layout.source, m.binding.input.inventory); verifyPublication(operation, fault)
        const original = archiveStat(m.checkout, m.layout.source)
        if (!original || original.dev !== p.claim_identity?.dev || original.ino !== p.claim_identity?.ino) throw new ArchiveDifference('.', 'el origen fue reemplazado durante el reclamo')
        if (archiveStat(m.checkout, m.layout.claimed)) throw new SddError('archive_collision', 'el remanente ya existe')
        renameSync(m.layout.source, m.layout.claimed)
        syncArchiveDirectory(dirname(m.layout.source)); syncArchiveDirectory(dirname(m.layout.claimed))
        fault?.('after_claim', { operation_id: m.operation_id, phase: p.phase, path: m.layout.claimed })
      })
      p.claimed = true; saveArchiveOperation(operation)
    }
    const directories = [...m.binding.input.inventory.directories].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1))
    for (const path of [...m.binding.input.inventory.files.map((file) => file.path), ...directories, '.']) {
      if (p.retired.includes(path)) continue
      const target = path === '.' ? m.layout.claimed : join(m.layout.claimed, path), key = `retire:${path}`
      const pendingMissing = p.actions[key] === 'intent' && archiveStat(m.checkout, target) === null
      verifyPublication(operation, fault)
      const claimed = archiveStat(m.checkout, m.layout.claimed)
      if (claimed && (claimed.dev !== p.claim_identity?.dev || claimed.ino !== p.claim_identity?.ino)) throw new ArchiveDifference('.', 'el remanente fue reemplazado')
      checks.activity(m.layout.claimed); revalidate(m.layout.claimed, remainingInventory(operation, true))
      action(operation, key, () => {
        if (pendingMissing) return
        fault?.('before_retirement_entry', { operation_id: m.operation_id, phase: p.phase, path: target })
        verifyPublication(operation, fault); checks.activity(m.layout.claimed); revalidate(m.layout.claimed, remainingInventory(operation))
        const stat = archiveStat(m.checkout, target)
        if (!stat) throw new ArchiveDifference(path, 'entrada retirada sin intención anterior')
        if (stat.isDirectory()) rmdirSync(target); else unlinkSync(target)
        syncArchiveDirectory(dirname(target))
        fault?.('after_retirement_entry', { operation_id: m.operation_id, phase: p.phase, path: target })
      })
      p.retired.push(path); saveArchiveOperation(operation)
    }
    cleanupArchiveStaging(operation, fault)
    p.state = 'completed'; p.phase = 'completed'; saveArchiveOperation(operation)
    return archiveOperationResult(operation)
  } catch (error) {
    if (isArchiveInjectedCrash(error)) throw error
    if (error instanceof ArchiveDifference) {
      // Las intenciones inciertas no permiten limpiar un destino que pudo haberse publicado.
      const uncertain = Object.entries(p.actions).some(([key, state]) => state === 'intent'
        && isEffectKey(key))
      if (uncertain && !afterPublication()) throw new SddError('archive_effect_uncertain', 'debe reconciliarse la publicación antes de clasificar la discrepancia')
      p.cause = [error.message, error.detail].filter(Boolean).join(': ')
      if (afterPublication()) {
        p.state = 'stopped'; saveArchiveOperation(operation)
        const removalOccurred = p.retired.length > 0 || Object.entries(p.actions).some(([key, state]) => key.startsWith(RETIRE)
          && (state === 'done' || archiveStat(m.checkout, retiredPath(key) === '.' ? m.layout.claimed : join(m.layout.claimed, retiredPath(key))) === null))
        if (sourceDifference && p.claimed && !removalOccurred && archiveStat(m.checkout, m.layout.source) === null) {
          const claimed = archiveStat(m.checkout, m.layout.claimed)
          if (claimed?.isDirectory() && claimed.dev === p.claim_identity?.dev && claimed.ino === p.claim_identity?.ino) {
            action(operation, 'return-claim', () => {
              if (archiveStat(m.checkout, m.layout.source)) throw new SddError('archive_collision', 'no se devuelve el remanente sobre un origen recreado')
              renameSync(m.layout.claimed, m.layout.source)
              syncArchiveDirectory(dirname(m.layout.claimed)); syncArchiveDirectory(dirname(m.layout.source))
            })
            p.claimed = false; p.returned = true; saveArchiveOperation(operation)
          }
        }
      }
      else {
        p.state = 'aborting'; saveArchiveOperation(operation); cleanupArchiveStaging(operation, fault)
        p.state = 'aborted'; saveArchiveOperation(operation)
      }
      return archiveOperationResult(operation)
    }
    throw error
  }
}
