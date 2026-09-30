import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CandidateFingerprint, gitDirs } from '../git.ts'
import { newRunId, writeJsonAtomic } from '../runs.ts'
import { SddError } from '../types.ts'
import type { Obligation } from './verification-contract.ts'

// Los recibos de `sdd verify` y las acreditaciones de las filas manuales. Viven en el almacén del
// checkout, dentro del directorio de Git, que ningún writer puede escribir; el registro del flujo guarda
// solo su id y su digest. El recibo informa: no aprueba gates ni autoriza commit ni push.

export type RowOutcome = 'passed' | 'failed' | 'unavailable' | 'unrun'
/** `reason` explica una fila sin código de salida. */
export interface RowExecution {
  row: string; started_at: string; ended_at: string; argv: string[]; exit_code: number | null
  reason?: 'timeout' | 'launch_failed' | 'interrupted' | 'manual'; launch_error?: string
  stdout_file: string; stderr_file: string; stdout_sha256: string; stderr_sha256: string; excerpt: string
}
/** `execution` es la corrida con las rutas de implementación en la base; sus salidas llevan el prefijo `confirm-`. */
export interface RowConfirmation {
  row: string; obligation: Obligation; state: 'confirmed' | 'refuted' | 'not_confirmable' | 'not_required' | 'contract_incoherent'
  reason?: string; restored: boolean; execution?: RowExecution
}
export interface RowResult {
  row: string; outcome: RowOutcome; execution?: RowExecution; confirmation?: RowConfirmation
  attestation?: string; invalid_attestations?: string[]; baseline?: 'passed' | 'failed' | 'not_measurable' | 'missing'
}
export interface VerifyReceipt {
  id: string; flow: string; mode: 'final' | 'baseline'; started_at: string; ended_at: string
  before: CandidateFingerprint; after: CandidateFingerprint; plan_fingerprint: string
  coverage: Record<string, string[]>; rows: RowResult[]
  writer?: { run: string; end_mark: boolean; tree_matches: boolean | 'not_comparable'; takeover?: string }
  dirtied_paths?: string[]; green: boolean
}
export interface VerifyReceiptRef { id: string; digest: string; mode: 'final' | 'baseline' }
/** `proof_ref` va también en la referencia: el control de respuestas consumidas lee solo el registro. */
export interface AttestationRef { id: string; digest: string; row: string; proof_ref: string }
/** `proof_ref` y `answered_at` son los de la prueba que devolvió `prove`, como en una aprobación. */
export interface Attestation {
  id: string; flow: string; row: string; observation: string; candidate: CandidateFingerprint
  plan_fingerprint: string; answered_at: string; proof_ref: string
}

const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const SHA_CHUNK = 1024 * 1024

/** El sha256 de un archivo de salida, con el prefijo que usan los recibos. Se lee por partes: una salida no tiene tope. */
export function fileSha256(file: string): string {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(SHA_CHUNK)
  const fd = openSync(file, 'r')
  try {
    for (let n = readSync(fd, chunk, 0, SHA_CHUNK, null); n > 0; n = readSync(fd, chunk, 0, SHA_CHUNK, null)) hash.update(chunk.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return `sha256:${hash.digest('hex')}`
}

/** El id de un recibo o de una acreditación: la misma forma que un id de corrida. */
export function newReceiptId(now: Date = new Date()): string {
  return newRunId(now)
}

const verifyRoot = (root: string) => join(gitDirs(root).gitDir, 'sdd-ai', 'verify')

/** Si se puede escribir el almacén de verify; dentro del sandbox de un conductor Codex no se puede. */
export function canWriteVerifyStore(root: string): boolean {
  try {
    mkdirSync(verifyRoot(root), { recursive: true })
    const probe = join(verifyRoot(root), `.probe.${process.pid}.${randomBytes(4).toString('hex')}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** El directorio de un recibo en el almacén, donde se vuelcan las salidas durante la ejecución. */
export function receiptDir(root: string, id: string): string {
  return join(verifyRoot(root), id)
}

const attestationFile = (root: string, id: string) => join(verifyRoot(root), 'attestations', `${id}.json`)

/** Publica el cuerpo del recibo de forma atómica y devuelve su referencia, con el digest del cuerpo. */
export function writeVerifyReceipt(root: string, receipt: VerifyReceipt): VerifyReceiptRef {
  const dir = receiptDir(root, receipt.id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'receipt.json')
  writeJsonAtomic(file, receipt)
  return { id: receipt.id, digest: sha256(readFileSync(file)), mode: receipt.mode }
}

const invalid = (what: string, detail: string) => new SddError('receipt_invalid', `el recibo ${what} no es íntegro`, { detail })

/**
 * El recibo de `ref`, validado: el digest del cuerpo y el sha256 de cada salida que cita. Un recibo que
 * no está, o que cambió después de publicarse, es `receipt_invalid`.
 */
export function readVerifyReceipt(root: string, ref: VerifyReceiptRef): VerifyReceipt {
  const dir = receiptDir(root, ref.id)
  const file = join(dir, 'receipt.json')
  if (!existsSync(file)) throw invalid(ref.id, 'el cuerpo ya no está en el almacén')
  const bytes = readFileSync(file)
  if (sha256(bytes) !== ref.digest) throw invalid(ref.id, 'el digest del cuerpo no coincide con el registro del flujo')
  const receipt = JSON.parse(bytes.toString('utf8')) as VerifyReceipt
  const outputs = receipt.rows.flatMap((r) => [r.execution, r.confirmation?.execution].filter((e) => e !== undefined))
  for (const e of outputs) {
    for (const [name, digest] of [[e.stdout_file, e.stdout_sha256], [e.stderr_file, e.stderr_sha256]] as const) {
      const out = join(dir, name)
      if (!existsSync(out) || fileSha256(out) !== digest) throw invalid(ref.id, `la salida ${name} no coincide con su sha256`)
    }
  }
  return receipt
}

/** Publica una acreditación y devuelve su referencia, con `proof_ref` para el control de respuestas consumidas. */
export function writeAttestation(root: string, a: Attestation): AttestationRef {
  const file = attestationFile(root, a.id)
  mkdirSync(join(verifyRoot(root), 'attestations'), { recursive: true })
  writeJsonAtomic(file, a)
  return { id: a.id, digest: sha256(readFileSync(file)), row: a.row, proof_ref: a.proof_ref }
}

/** La acreditación de `ref`, validada por su digest; `attestation_invalid` si no está o cambió. */
export function readAttestation(root: string, ref: AttestationRef): Attestation {
  const file = attestationFile(root, ref.id)
  const bytes = existsSync(file) ? readFileSync(file) : null
  if (!bytes || sha256(bytes) !== ref.digest) {
    throw new SddError('attestation_invalid', `la acreditación ${ref.id} no es íntegra`, { detail: bytes ? 'el digest no coincide' : 'ya no está en el almacén' })
  }
  return JSON.parse(bytes.toString('utf8')) as Attestation
}

const sameCandidate = (a: CandidateFingerprint, b: CandidateFingerprint) => a.base_commit === b.base_commit && a.tree === b.tree

/**
 * La acreditación más reciente de `row` en `flow` cuyas dos huellas, la del candidato y la del plan, son
 * las de ahora. El cuerpo tiene que ser de esa misma fila y ese mismo flujo: una referencia que apunta al
 * cuerpo de otra fila no la acredita. Una acreditación que no valida no aborta nada: se salta y su id va a
 * `invalid`, para que el recibo la anote.
 */
export function currentAttestation(root: string, refs: readonly AttestationRef[], flow: string, row: string,
  candidate: CandidateFingerprint, planFingerprint: string): { ref: AttestationRef | null; invalid: string[] } {
  const bad: string[] = []
  for (const ref of [...refs].reverse()) {
    if (ref.row !== row) continue
    let a: Attestation
    try {
      a = readAttestation(root, ref)
    } catch (e) {
      if (e instanceof SddError && e.code === 'attestation_invalid') {
        bad.push(ref.id)
        continue
      }
      throw e
    }
    if (a.row !== row || a.flow !== flow) {
      bad.push(ref.id)
      continue
    }
    if (sameCandidate(a.candidate, candidate) && a.plan_fingerprint === planFingerprint) return { ref, invalid: bad }
  }
  return { ref: null, invalid: bad }
}
