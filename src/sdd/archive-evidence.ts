import { join, relative } from 'node:path'
import { gitDirs } from '../git.ts'
import { isRunId } from '../runs.ts'
import { SddError } from '../types.ts'
import { archiveHash, archiveStat, readArchiveFile, type ArchiveFaultInjector } from './archive-tree.ts'
import { createArchiveDirectory, writeArchiveExclusive } from './durable.ts'
import { PHASES_FILE, validatePhaseRecord, type PhaseRecord } from './phase-state.ts'
import { attestationFile, receiptDir, verifyBytesDigest, type Attestation, type VerifyReceipt } from './verify-receipt.ts'

export interface EvidenceBody {
  kind: 'review_ledger' | 'review_verdict' | 'verify_receipt' | 'attestation'
  id: string; row?: string; digest?: string; prepared: string
}
export interface EvidenceSelection { required: EvidenceBody[]; optional: unknown[]; requires_receipt: boolean }
export interface EvidenceSource extends EvidenceBody { source_root: 'checkout' | 'git_dir'; source_path: string }
export interface EvidenceProvenance {
  schema_version: 1; selection: EvidenceSelection
  entries: (EvidenceSource & { sha256: string; size: number })[]
}
export interface EvidenceCoverage {
  complete: boolean; selection: EvidenceSelection; provenance: EvidenceProvenance | null
  impediments: { code: string; path: string; reason: string }[]
}
const failure = (reason: string) => new SddError('archive_evidence_invalid', 'la evidencia seleccionada no es íntegra', { detail: reason })
const idOf = (id: string) => { if (!isRunId(id)) throw failure('referencia con id inválido'); return id }
const serialized = (v: unknown) => JSON.stringify(v)
const provenancePath = 'evidencia/archive-provenance.json'

/** Selección sin lecturas. Las acreditaciones inválidas son informativas, nunca obligatorias. */
export function selectArchiveEvidence(record: PhaseRecord | null, selectedReceipt?: VerifyReceipt): EvidenceSelection {
  const selection: EvidenceSelection = { required: [], optional: [], requires_receipt: false }
  if (!record) return selection
  selection.optional.push(...(record.reviews ?? []).map((id) => ({ kind: 'review', id })),
    ...(record.verify?.receipts ?? []).map((ref) => ({ kind: 'verify', ...ref })),
    ...(record.verify?.attestations ?? []).map((ref) => ({ kind: 'attestation', ...ref })))
  if (record.documents) selection.optional.push(...Object.entries(record.documents).flatMap(([phase, origin]) => origin ? [{ kind: 'document', phase,
    run: origin.run, artifact: origin.artifact, sources: origin.sources.map(({ path, digest }) => ({ path, digest })),
    amendments: origin.amendments.map(({ path, digest }) => ({ path, digest })) }] : []))
  if (record.revisions) selection.optional.push(...record.revisions.entries.map((entry) => ({ kind: 'revision', run: entry.run,
    review: entry.review, artifact: entry.artifact, candidate: entry.candidate, ledger_digest: entry.ledger_digest,
    materials: entry.materials.map(({ path, digest }) => ({ path, digest })) })))
  if (record.implement) selection.optional.push(...record.implement.chains.flatMap((chain) => chain.entries.map((entry) =>
    entry.kind === 'takeover' ? { kind: 'takeover', id: entry.id, map: entry.map } : { kind: 'writer', run: entry.run })))
  const commit = record.commit
  if (!commit) return selection
  const review = idOf(commit.review), receipt = idOf(commit.receipt.id)
  selection.optional = selection.optional.filter((value) => {
    const ref = value as { kind?: string; id?: string }
    return !((ref.kind === 'review' && ref.id === review) || (ref.kind === 'verify' && ref.id === receipt))
  })
  selection.required.push(
    { kind: 'review_ledger', id: review, prepared: `evidencia/review/${review}/ledger.json` },
    { kind: 'review_verdict', id: review, prepared: `evidencia/review/${review}/verdict.json` },
    { kind: 'verify_receipt', id: receipt, digest: commit.receipt.digest, prepared: `evidencia/verify/${receipt}/receipt.json` })
  selection.optional.push({ kind: 'review_receipt', id: review })
  if (!selectedReceipt) { selection.requires_receipt = true; return selection }
  if (selectedReceipt.id !== receipt || !Array.isArray(selectedReceipt.rows)) throw failure('el recibo no corresponde a la referencia seleccionada')
  const rows = new Set<string>()
  for (const row of selectedReceipt.rows) {
    if (!row || typeof row.row !== 'string' || rows.has(row.row)) throw failure('filas de recibo inválidas o repetidas')
    rows.add(row.row)
    selection.optional.push(...(row.invalid_attestations ?? []).map((id) => ({ kind: 'invalid_attestation', id })))
    if (!row.attestation) continue
    const refs = (record.verify?.attestations ?? []).filter((ref) => ref.id === row.attestation && ref.row === row.row)
    if (refs.length !== 1) throw failure('la acreditación usada no tiene una referencia única para su fila')
    const ref = refs[0]
    selection.required.push({ kind: 'attestation', id: idOf(ref.id), row: row.row, digest: ref.digest,
      prepared: `evidencia/attestations/${ref.id}.json` })
  }
  const used = new Set(selection.required.filter((body) => body.kind === 'attestation').map((body) => body.id))
  selection.optional = selection.optional.filter((value) => {
    const ref = value as { kind?: string; id?: string }
    return !(ref.kind === 'attestation' && ref.id && used.has(ref.id))
  })
  return selection
}

export function readArchivePhaseRecord(source: string, flow: string, checkoutRoot: string): PhaseRecord | null {
  const bytes = readArchiveFile(source, join(source, PHASES_FILE))
  if (bytes === null) return null
  let data: unknown
  try { data = JSON.parse(bytes.toString()) } catch { throw failure('registro de fases JSON ilegible') }
  // La validación de procedencia usa la ubicación lógica original, también después del reclamo.
  try { return validatePhaseRecord(data, flow, join(checkoutRoot, '.plans', flow, PHASES_FILE)) } catch { throw failure('registro de fases incompatible') }
}

function parseBody(bytes: Buffer, kind: EvidenceBody['kind']): unknown {
  try { return JSON.parse(bytes.toString()) } catch { throw failure(`JSON ilegible en ${kind}`) }
}

function derivedSource(root: string, body: EvidenceBody): EvidenceSource {
  const gitDir = gitDirs(root).gitDir
  if (body.kind === 'review_ledger' || body.kind === 'review_verdict') return { ...body, source_root: 'checkout',
    source_path: `.sdd-ai/runs/${idOf(body.id)}/${body.kind === 'review_ledger' ? 'ledger.json' : 'verdict.json'}` }
  const file = body.kind === 'verify_receipt' ? join(receiptDir(root, idOf(body.id)), 'receipt.json') : attestationFile(root, idOf(body.id))
  return { ...body, source_root: 'git_dir', source_path: relative(gitDir, file) }
}

function sourceBytes(root: string, source: EvidenceSource, fault?: ArchiveFaultInjector, operationId = ''): Buffer | null {
  const base = source.source_root === 'checkout' ? root : gitDirs(root).gitDir
  fault?.('before_source_read', { operation_id: operationId, phase: 'evidence', path: source.source_path })
  return readArchiveFile(base, join(base, source.source_path))
}

function validateBody(bytes: Buffer, source: EvidenceBody, flow: string): void {
  if (source.digest && verifyBytesDigest(bytes) !== source.digest) throw failure(`digest registrado distinto: ${source.prepared}`)
  const value = parseBody(bytes, source.kind)
  if (source.kind === 'verify_receipt') {
    const receipt = value as VerifyReceipt
    if (!receipt || receipt.id !== source.id || receipt.flow !== flow || !Array.isArray(receipt.rows)) throw failure('el recibo pertenece a otro flujo o id')
  }
  if (source.kind === 'attestation') {
    const attestation = value as Attestation
    if (!attestation || attestation.id !== source.id || attestation.flow !== flow || attestation.row !== source.row) throw failure('la acreditación pertenece a otro id, flujo o fila')
  }
}

function readProvenance(source: string): EvidenceProvenance | null {
  const bytes = readArchiveFile(source, join(source, provenancePath))
  if (bytes === null) return null
  let value: EvidenceProvenance
  try { value = JSON.parse(bytes.toString()) } catch { throw failure('procedencia JSON ilegible') }
  if (!value || value.schema_version !== 1 || !Array.isArray(value.entries) || !value.selection) throw failure('procedencia incompatible')
  if (Object.keys(value).some((key) => !['schema_version', 'selection', 'entries'].includes(key))) throw failure('procedencia con campos incompatibles')
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => !['kind', 'id', 'row', 'digest', 'prepared', 'source_root', 'source_path', 'sha256', 'size'].includes(key))
      || typeof entry.id !== 'string' || typeof entry.prepared !== 'string' || typeof entry.source_path !== 'string'
      || !['checkout', 'git_dir'].includes(entry.source_root) || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw failure('entrada de procedencia incompatible')
  }
  return value
}

export function resolveArchiveEvidence(root: string, flow: string, source: string, fault?: ArchiveFaultInjector, operationId = ''):
  { selection: EvidenceSelection; sources: EvidenceSource[]; record: PhaseRecord | null } {
  const record = readArchivePhaseRecord(source, flow, root)
  let selection = selectArchiveEvidence(record)
  const prior = selection.required.length ? readProvenance(source) : null
  // La ruta registrada se contrasta antes de consultar disponibilidad de cualquier fuente.
  for (const entry of prior?.entries ?? []) {
    let body = selection.required.find((required) => required.id === entry.id && required.kind === entry.kind)
    if (!body && entry.kind === 'attestation') {
      const refs = record?.verify?.attestations.filter((ref) => ref.id === entry.id && ref.row === entry.row) ?? []
      if (refs.length === 1) body = { kind: 'attestation', id: idOf(refs[0].id), row: refs[0].row, digest: refs[0].digest,
        prepared: `evidencia/attestations/${refs[0].id}.json` }
    }
    if (!body || serializedSource(entry) !== serializedSource(derivedSource(root, body))) throw failure(`ruta de procedencia incompatible: ${entry.prepared}`)
  }
  if (selection.requires_receipt) {
    const ref = selection.required.find((body) => body.kind === 'verify_receipt')!
    const derived = derivedSource(root, ref)
    let bytes = sourceBytes(root, derived, fault, operationId)
    if (bytes === null) {
      const provenance = readProvenance(source)
      const entry = provenance?.entries.find((e) => e.kind === ref.kind && e.id === ref.id)
      if (!entry || serializedSource(derived) !== serializedSource(entry)) throw failure('falta el recibo seleccionado con procedencia derivada válida')
      bytes = readArchiveFile(source, join(source, ref.prepared))
      if (!bytes || archiveHash(bytes) !== entry.sha256 || bytes.length !== entry.size) throw failure('el recibo preparado no coincide con su procedencia')
    }
    validateBody(bytes, ref, flow)
    selection = selectArchiveEvidence(record, parseBody(bytes, ref.kind) as VerifyReceipt)
  }
  return { selection, sources: selection.required.map((body) => derivedSource(root, body)), record }
}

function serializedSource(entry: EvidenceSource): string {
  const { kind, id, row, digest, prepared, source_root, source_path } = entry
  return serialized({ kind, id, ...(row === undefined ? {} : { row }), ...(digest === undefined ? {} : { digest }), prepared, source_root, source_path })
}

export function inspectArchiveEvidence(root: string, flow: string, source: string, fault?: ArchiveFaultInjector, operationId = ''): EvidenceCoverage {
  const resolved = resolveArchiveEvidence(root, flow, source, fault, operationId)
  const provenance = resolved.sources.length ? readProvenance(source) : null
  const coverage: EvidenceCoverage = { complete: false, selection: resolved.selection, provenance, impediments: [] }
  if (!resolved.sources.length) {
    if (provenance) throw failure('procedencia ajena a una selección sin cuerpos obligatorios')
    coverage.complete = true; return coverage
  }
  if (!provenance) {
    coverage.impediments.push({ code: 'archive_prepare_required', path: provenancePath, reason: 'falta --prepare' })
    return coverage
  }
  if (serialized(provenance.selection) !== serialized(resolved.selection) || provenance.entries.length !== resolved.sources.length) throw failure('selección preparada distinta')
  for (const required of resolved.sources) {
    const matches = provenance.entries.filter((entry) => entry.kind === required.kind && entry.id === required.id)
    if (matches.length !== 1 || serializedSource(matches[0]) !== serializedSource(required)) throw failure(`ruta de procedencia incompatible: ${required.prepared}`)
    const entry = matches[0], bytes = readArchiveFile(source, join(source, required.prepared))
    if (bytes === null) { coverage.impediments.push({ code: 'archive_prepare_required', path: required.prepared, reason: 'falta el cuerpo preparado; ejecuta --prepare' }); continue }
    if (archiveHash(bytes) !== entry.sha256 || bytes.length !== entry.size) throw failure(`cuerpo y procedencia distintos: ${required.prepared}`)
    validateBody(bytes, required, flow)
    const original = sourceBytes(root, required, fault, operationId)
    if (original !== null && !original.equals(bytes)) throw failure(`discrepancia literal con la fuente derivada: ${required.source_path}`)
  }
  coverage.complete = coverage.impediments.length === 0
  return coverage
}

/** Prevalida todas las entradas antes de escribir; nunca regenera procedencia incompatible. */
export function prepareArchiveEvidence(root: string, flow: string, source: string, fault?: ArchiveFaultInjector): EvidenceCoverage {
  const { selection, sources } = resolveArchiveEvidence(root, flow, source, fault)
  if (!sources.length) return inspectArchiveEvidence(root, flow, source, fault)
  const prior = readProvenance(source)
  const entries: EvidenceProvenance['entries'] = [], bodies: { path: string; bytes: Buffer }[] = []
  for (const required of sources) {
    const bytes = sourceBytes(root, required, fault)
    if (bytes === null) throw failure(`la preparación necesita la fuente: ${required.source_path}`)
    validateBody(bytes, required, flow)
    const entry = { ...required, sha256: archiveHash(bytes), size: bytes.length }
    const existing = readArchiveFile(source, join(source, required.prepared))
    if (existing !== null && !existing.equals(bytes)) throw failure(`colisión de preparación: ${required.prepared}`)
    entries.push(entry)
    if (existing === null) bodies.push({ path: required.prepared, bytes })
  }
  const provenance: EvidenceProvenance = { schema_version: 1, selection, entries }
  if (prior && serialized(prior) !== serialized(provenance)) throw failure('la preparación preexistente es incompatible')
  const ensure = (dir: string): void => {
    if (dir === source) return
    const st = archiveStat(source, dir)
    if (st) { if (!st.isDirectory()) throw failure('colisión en un directorio de evidencia'); return }
    const parent = join(dir, '..'); ensure(parent); createArchiveDirectory(dir)
  }
  // Prevalida también todos los componentes que se crearán.
  for (const path of [...sources.map((s) => s.prepared), provenancePath]) archiveStat(source, join(source, path))
  for (const body of bodies) {
    const file = join(source, body.path); ensure(join(file, '..')); writeArchiveExclusive(file, body.bytes)
  }
  if (!prior) { const file = join(source, provenancePath); ensure(join(file, '..')); writeArchiveExclusive(file, `${JSON.stringify(provenance, null, 2)}\n`) }
  return inspectArchiveEvidence(root, flow, source, fault)
}
