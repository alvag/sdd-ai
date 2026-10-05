import { gateQuestionFor } from '../approval/question.ts'
import type { Question } from '../approval/question.ts'
import { withPhaseNext } from './phase-state.ts'
import { readFlow } from './read.ts'
import type { FlowRead } from './read.ts'
import { resolve } from './status.ts'
import type { FlowStatus, Next } from './status.ts'

export type DetailedNext = Next & { question?: Question }
export type DetailedFlowView = Omit<FlowStatus, 'next'> & { next: DetailedNext }

/**
 * El `next` de `sdd status <id>`: en un gate, la pregunta que el conductor le hace al usuario antes de
 * `sdd approve`; en una fase, el comando que la lanza o por qué no hay comando.
 */
export function nextOf(root: string, status: FlowStatus, facts: FlowRead['facts']): DetailedNext {
  if (status.next.step === 'gate' && status.next.gate !== undefined && status.depth !== null) {
    return { ...status.next, question: gateQuestionFor(status.id, status.depth, status.next.gate, facts.fingerprints) }
  }
  return { ...withPhaseNext(root, status.id, status) }
}

/** Composición de lectura compartida por la CLI y los consumidores informativos. */
export function detailedFlowView(root: string, id: string, read: FlowRead = readFlow(root, id)): DetailedFlowView {
  const status = resolve(read.facts)
  return { ...status, next: nextOf(root, status, read.facts) }
}
