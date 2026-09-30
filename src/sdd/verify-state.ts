import { execFileSync } from 'node:child_process'
import { candidateFingerprint } from '../git.ts'
import { type HeaderResult, criteriaIds } from './markdown.ts'
import { implementOf, latestFinalReceipt, readPhaseRecord, receiptAfterTakeover } from './phase-state.ts'
import { type Depth, type FlowFacts, type GateId, headerData, isDepth } from './status.ts'
import { type TestRow, readVerification } from './verification-contract.ts'
import { readVerifyReceipt } from './verify-receipt.ts'

// Lo que `readFlow` agrega a los hechos de un flujo sobre su verificación: si el contrato del plan es
// estructurado, sus rutas de reversión ausentes en la base y, solo con el header en `verified`, si el último
// recibo final sigue valiendo.

/** El gate que cubre el plan en cada profundidad. */
export const PLAN_GATE: Record<Depth, GateId> = { corta: 'single', normal: 'plan-tasks', completa: 'plan' }

/**
 * `contract` es `structured` si `## Verification` trae el bloque del contrato, aunque no se admita, y
 * `prose` si no. Con un contrato estructurado y el header en `verified`, `receipt` es `valid` solo si el
 * último recibo final existe, es íntegro y verde, ejecutó el contrato del plan de hoy y su candidato es
 * el árbol de ahora. Sin esas dos condiciones no se calcula la huella del árbol, que lee todos los archivos.
 */
export function verifyFacts(root: string, id: string, planText: string, planHeader: HeaderResult | null,
  fingerprints: FlowFacts['fingerprints'], specText: string): Pick<FlowFacts, 'contract' | 'receipt' | 'revertPathsNotInBase'> {
  let contract: 'structured' | 'prose'
  const header = headerData(planHeader)
  let revertPathsNotInBase: FlowFacts['revertPathsNotInBase']
  try {
    const read = readVerification(planText, criteriaIds(specText))
    contract = read.kind
    if (read.kind === 'structured' && typeof header?.base_commit === 'string') {
      const rows = read.contract.rows.filter((r): r is TestRow => r.kind === 'test' && (r.obligation === 'red_on_revert' || r.obligation === 'green_on_base'))
      const paths = [...new Set(rows.flatMap((r) => r.implementation_paths))]
      if (paths.length > 0) {
        try {
          const present = new Set(execFileSync('git', ['ls-tree', '-z', '--name-only', header.base_commit, '--', ...paths], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean))
          revertPathsNotInBase = rows.flatMap((r) => {
            const absent = r.implementation_paths.filter((p) => !present.has(p))
            return absent.length > 0 ? [{ row: r.id, paths: absent }] : []
          })
        } catch {
          // Una base que no resuelve no permite decidir si la ruta es nueva.
        }
      }
    }
  } catch {
    contract = 'structured'
  }
  const facts = { contract, ...(revertPathsNotInBase ? { revertPathsNotInBase } : {}) }
  if (contract === 'prose' || header?.status !== 'verified') return facts
  return { ...facts, receipt: receiptHolds(root, id, header, fingerprints) ? 'valid' : 'stale' }
}

function receiptHolds(root: string, id: string, header: Record<string, unknown>, fingerprints: FlowFacts['fingerprints']): boolean {
  const depth = header.profundidad
  const base = header.base_commit
  if (!isDepth(depth) || typeof base !== 'string') return false
  try {
    const record = readPhaseRecord(root, id)
    const ref = latestFinalReceipt(record)
    if (ref === null) return false
    const r = readVerifyReceipt(root, ref)
    if (!r.green || r.plan_fingerprint !== fingerprints[PLAN_GATE[depth]]) return false
    // Después de una toma, solo un recibo posterior a ella acredita el árbol, aunque haya otra cadena después.
    if (!receiptAfterTakeover(r, implementOf(record))) return false
    const now = candidateFingerprint(root, id, base)
    return r.after.base_commit === now.base_commit && r.after.tree === now.tree
  } catch {
    return false
  }
}
