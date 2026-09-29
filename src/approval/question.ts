import { createHash } from 'node:crypto'
import { type Depth, GATES, type GateId } from '../sdd/status.ts'

// La pregunta que el binario le entrega al conductor para cada decisión del usuario. Es pura: con los
// mismos datos sale igual byte a byte, porque la prueba se busca comparando contra este texto.

export interface QuestionOption { label: string; description: string }
export interface Question { header: string; question: string; options: QuestionOption[] }

export const GATE_OPTIONS = { approve: 'Aprobar', decline: 'No aprobar' } as const
export const DISPUTE_OPTIONS = { accept: 'Aceptar el hallazgo', reject: 'Mantener el rechazo' } as const
export const extraOptions = (n: number) => ({ launch: `Lanzar la ronda ${n}`, leave: 'Dejar la revisión como está' })

/** El límite de `AskUserQuestion` para el `header`. */
const HEADER_MAX = 12

const header = (full: string, short: string) => (full.length <= HEADER_MAX ? full : short.slice(0, HEADER_MAX))

/**
 * El código de ligadura: los primeros 16 caracteres hexadecimales del sha256 sobre el flujo, el gate y
 * las huellas. Las claves de `previous` se ordenan, así el orden en que llegaron no cambia el código.
 */
function bindingCode(flow: string, gate: GateId, fingerprint: string, previous: Partial<Record<GateId, string>>): string {
  const sorted = Object.fromEntries(Object.entries(previous).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const json = JSON.stringify({ flow, gate, fingerprint, previous: sorted })
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

export function gateQuestion(flow: string, gate: GateId, fingerprint: string, previous: Partial<Record<GateId, string>>): Question {
  return {
    header: header(`Gate ${gate}`, gate),
    question: `¿Apruebas el gate ${gate} del flujo ${flow}? (código ${bindingCode(flow, gate, fingerprint, previous)})`,
    options: [
      { label: GATE_OPTIONS.approve, description: `Registra la aprobación del gate ${gate} con las huellas de este código` },
      { label: GATE_OPTIONS.decline, description: `El gate ${gate} queda sin aprobar` },
    ],
  }
}

/**
 * La pregunta de un gate con las huellas de un flujo: toma la del gate y las de los gates anteriores de
 * su profundidad, igual que el registro de `sdd approve`. Las huellas de los gates posteriores no la
 * cambian.
 */
export function gateQuestionFor(flow: string, depth: Depth, gate: GateId, fingerprints: Partial<Record<GateId, string>>): Question {
  const gates = GATES[depth]
  const fingerprint = fingerprints[gate]
  if (fingerprint === undefined) throw new Error(`falta la huella del gate ${gate}`)
  const previous: Partial<Record<GateId, string>> = {}
  for (const g of gates.slice(0, gates.indexOf(gate))) {
    const f = fingerprints[g]
    if (f === undefined) throw new Error(`falta la huella del gate ${g}`)
    previous[g] = f
  }
  return gateQuestion(flow, gate, fingerprint, previous)
}

export const ATTEST_OPTIONS = { attest: 'Acreditar', decline: 'No acreditar' } as const

/**
 * La pregunta con que una persona acredita una fila `manual` de verify. El código liga la fila, lo que hay
 * que observar, el candidato y el plan aprobado: un cambio en cualquiera pide otra respuesta.
 */
export function attestQuestion(flow: string, row: string, observation: string, candidate: { base_commit: string; tree: string }, planFingerprint: string): Question {
  const json = JSON.stringify({ flow, row, observation, base_commit: candidate.base_commit, tree: candidate.tree, plan: planFingerprint })
  const code = createHash('sha256').update(json).digest('hex').slice(0, 16)
  return {
    header: header(`Acreditar ${row}`, row),
    question: `¿Observaste la fila ${row} del flujo ${flow}: ${observation}? (código ${code})`,
    options: [
      { label: ATTEST_OPTIONS.attest, description: `Registra que ${row} se observó en este candidato` },
      { label: ATTEST_OPTIONS.decline, description: `${row} queda pendiente` },
    ],
  }
}

export function disputeQuestion(review: string, entry: { id: string; claim: string }, completed: number, reason: string): Question {
  return {
    header: header(`Disputa ${entry.id}`, entry.id),
    question: `¿Qué hacemos con la disputa ${entry.id} de la revisión ${review} (ronda ${completed})?`,
    options: [
      { label: DISPUTE_OPTIONS.accept, description: entry.claim },
      { label: DISPUTE_OPTIONS.reject, description: reason },
    ],
  }
}

export function extraQuestion(review: string, round: number): Question {
  const o = extraOptions(round)
  return {
    header: 'Ronda extra',
    question: `¿Lanzamos la ronda ${round} de la revisión ${review}, más allá del tope?`,
    options: [
      { label: o.launch, description: 'Revisa otra vez, en una ronda más allá del tope de rondas' },
      { label: o.leave, description: 'La revisión queda con las decisiones que ya tiene' },
    ],
  }
}

/** El bloque que el conductor de Codex muestra como único contenido de un mensaje: la pregunta y cada opción numerada. */
export function renderForText(q: Question): string {
  return [q.question, ...q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`)].join('\n')
}
