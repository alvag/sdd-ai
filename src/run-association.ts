import { listFlows } from './sdd/read.ts'
import type { ListEntry } from './sdd/read.ts'
import { readPhaseRecord } from './sdd/phase-state.ts'

export type RunAssociation = { kind: 'known'; flow: string } | { kind: 'absent' }
  | { kind: 'conflict'; flows: string[] } | { kind: 'unknown'; reason: string }
export type OwnerAssociationSource = { kind: 'known'; flow: string } | { kind: 'absent' }
  | { kind: 'unknown'; reason: string }
export interface RunAssociationIndex { references: Map<string, Set<string>>; complete: boolean }

/**
 * La fuente de la dueña para una corrida: el `flow` de su request o, en un writer protegido, el de su fase. Un valor
 * que no es un flujo (ausente, nulo o vacío) no asocia nada, como antes de extraer la asociación. Es la única
 * interpretación, para la proyección y para la autorización de la recepción.
 */
export function ownerAssociationSource(flow: unknown): OwnerAssociationSource {
  return typeof flow === 'string' && flow !== '' ? { kind: 'known', flow } : { kind: 'absent' }
}

/**
 * Solo reúne referencias del dominio; una fuente ilegible nunca demuestra ausencia. `listed` permite reusar el
 * catálogo que el llamador ya leyó, así las asociaciones y la vista de los flujos salen del mismo recorrido.
 */
export function collectRunAssociations(root: string, listed?: () => ListEntry[]): RunAssociationIndex {
  const index: RunAssociationIndex = { references: new Map(), complete: true }
  const add = (run: string, flow: string) => {
    const values = index.references.get(run) ?? new Set<string>()
    values.add(flow)
    index.references.set(run, values)
  }
  try {
    for (const entry of (listed ?? (() => listFlows(root)))()) {
      try {
        const record = readPhaseRecord(root, entry.id)
        if (record.last_run) add(record.last_run.id, entry.id)
        for (const phase of Object.values(record.phases)) {
          if (phase.awaiting) add(phase.awaiting.run, entry.id)
          if (phase.amended) add(phase.amended.run, entry.id)
          if (phase.inline) add(phase.inline.run, entry.id)
        }
        for (const review of record.reviews ?? []) add(review, entry.id)
        for (const chain of record.implement?.chains ?? []) for (const link of chain.entries) {
          if (link.kind !== 'takeover') add(link.run, entry.id)
        }
      } catch { index.complete = false }
    }
  } catch { index.complete = false }
  return index
}

export function associationFor(index: RunAssociationIndex, runId: string, ownerSource: OwnerAssociationSource): RunAssociation {
  const flows = new Set(index.references.get(runId) ?? [])
  if (ownerSource.kind === 'known') flows.add(ownerSource.flow)
  if (flows.size > 1) return { kind: 'conflict', flows: [...flows].sort() }
  if (!index.complete || ownerSource.kind === 'unknown') return { kind: 'unknown', reason: 'association_unavailable' }
  return flows.size === 1 ? { kind: 'known', flow: [...flows][0] } : { kind: 'absent' }
}
