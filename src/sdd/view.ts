import { gateQuestionFor } from '../approval/question.ts'
import type { Question } from '../approval/question.ts'
import { activeRun, readPhaseRecord, withPhaseNext, type PhaseRecord } from './phase-state.ts'
import { pendingIntent } from './revision-record.ts'
import { revisionView } from './revision.ts'
import { readFlow } from './read.ts'
import type { FlowRead } from './read.ts'
import { resolve } from './status.ts'
import type { FlowStatus, Next } from './status.ts'

export type DetailedNext = Next & { question?: Question }
export type DetailedFlowView = Omit<FlowStatus, 'next'> & { next: DetailedNext; revisions?: Record<string, unknown>[] }

/**
 * El `next` de `sdd status <id>`: en un gate, la pregunta que el conductor le hace al usuario antes de
 * `sdd approve`; en una fase, el comando que la lanza o por qué no hay comando.
 */
export function nextOf(root: string, status: FlowStatus, facts: FlowRead['facts'], record: PhaseRecord = readPhaseRecord(root, status.id)): DetailedNext {
  const revision = record.revisions?.active ?? pendingIntent(record)
  if (revision && activeRun(root, record) === revision.run) return withPhaseNext(root, status.id, status, record)
  if (status.next.step === 'gate' && status.next.gate !== undefined && status.depth !== null) {
    return { ...status.next, question: gateQuestionFor(status.id, status.depth, status.next.gate, facts.fingerprints) }
  }
  return { ...withPhaseNext(root, status.id, status, record) }
}

/** Composición de lectura compartida por la CLI y los consumidores informativos. */
export function detailedFlowView(root: string, id: string, read: FlowRead = readFlow(root, id)): DetailedFlowView {
  const status = resolve(read.facts)
  const record = readPhaseRecord(root, id)
  return { ...status, next: nextOf(root, status, read.facts, record),
    ...(record.revisions ? { revisions: record.revisions.entries.map((e) => {
      try { return revisionView(root, e) } catch (error) { return { ...e, unreadable: true, detail: (error as Error).message } }
    }) } : {}),
  }
}
