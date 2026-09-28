import { join } from 'node:path'
import { type Proof, prove } from '../approval/proof.ts'
import { GATE_OPTIONS, gateQuestion } from '../approval/question.ts'
import { withLock } from '../lock.ts'
import { freezeStableWith } from '../review/candidate.ts'
import { writeJsonAtomic } from '../runs.ts'
import { type Family, SddError } from '../types.ts'
import { APPROVALS_FILE, FILE_NAMES, type FlowRead, LOCK_FILE, flowDir, lstatOrNull, pathInvalid, readFlow } from './read.ts'
import { type Approval, type Depth, type FlowStatus, GATE_IDS, GATES, type GateId, missingParts, resolve } from './status.ts'

const APPROVED = new Set(['approved', 'approved_unfingerprinted'])

const rejected = (message: string) =>
  new SddError('approve_rejected', 'no se puede aprobar el gate', { detail: message, next: 'corre sdd status para ver el estado del flujo' })

/**
 * Las precondiciones de una aprobación sobre una lectura del flujo: un gate de su profundidad, el flujo
 * sin bloqueos, los artefactos del gate presentes, alguna task si el gate las cubre y los gates
 * anteriores aprobados. Devuelve la profundidad y el gate ya validados.
 */
function check(read: FlowRead, gate: string): { depth: Depth; gate: GateId } {
  const status = resolve(read.facts)
  if (!(GATE_IDS as readonly string[]).includes(gate)) {
    throw new SddError('gate_invalid', `${gate} no es un gate`, { next: `los gates son ${GATE_IDS.join(', ')}` })
  }
  const { depth } = status
  if (depth === null) {
    throw rejected(status.blocked_reasons.length > 0 ? `el flujo está bloqueado: ${status.blocked_reasons.map((r) => r.code).join(', ')}` : 'el flujo no declaró su profundidad')
  }
  const gates: readonly string[] = GATES[depth]
  if (!gates.includes(gate)) {
    throw new SddError('gate_invalid', `${gate} no es un gate de ${depth}`, { next: `los gates de ${depth} son ${GATES[depth].join(', ')}` })
  }
  const id = gate as GateId
  if (status.blocked_reasons.length > 0) throw rejected(`el flujo está bloqueado: ${status.blocked_reasons.map((r) => r.code).join(', ')}`)
  const missing = missingParts(read.facts, id)
  if (missing.length > 0) throw rejected(`faltan artefactos del gate ${id}: ${missing.map((p) => p.name).join(', ')}`)
  if (id === GATES[depth][GATES[depth].length - 1] && status.tasks.total === 0) throw rejected(`el gate ${id} cubre las tasks y no hay ninguna`)
  const earlier = status.gates.slice(0, gates.indexOf(id)).filter((g) => !APPROVED.has(g.state))
  if (earlier.length > 0) throw rejected(`antes hay que aprobar ${earlier.map((g) => g.gate).join(', ')}`)
  return { depth, gate: id }
}

/**
 * Registra la aprobación de un gate con la huella de sus artefactos y las de los gates anteriores. Se
 * serializa por flujo con un lock de archivo: espera mientras lo tenga otro proceso vivo, y uno huérfano
 * no se recupera solo, porque robarle un lock viejo a otro proceso abriría una carrera entre dos que lo
 * ven a la vez. Con el lock tomado lee el flujo dos veces
 * y registra solo si las dos lecturas coinciden y el usuario respondió `Aprobar` a la pregunta canónica
 * de ese gate con esas huellas, en la sesión del runner. Nunca escribe la spec, el plan, las tasks ni el
 * handoff, y un rechazo deja el directorio como estaba.
 */
export function approve(root: string, id: string, gate: string, now: Date, read: typeof readFlow = readFlow,
  proveFn: typeof prove = prove, env: Record<string, string | undefined> = process.env, conductor?: Family): FlowStatus {
  const observed = read(root, id)
  check(observed, gate)
  const registered = (r: FlowRead) => (r.facts.log.state === 'ok' ? r.facts.log.approvals.filter((a) => a.gate === gate).length : 0)
  const seen = registered(observed)
  const dir = flowDir(root, id)
  const lock = join(dir, LOCK_FILE)
  if (lstatOrNull(lock)?.isSymbolicLink()) throw pathInvalid(`.plans/${id}/${LOCK_FILE}`, 'es un enlace simbólico')

  const busy = () => new SddError('approve_in_progress', `otro sdd approve tiene tomado el flujo ${id}`, {
    next: `si no hay otro sdd approve corriendo, borra .plans/${id}/${LOCK_FILE} y vuelve a correr el comando`,
  })
  return withLock(lock, busy, () => {
    let stable: FlowRead
    try {
      stable = freezeStableWith(root, id, read, (r) => JSON.stringify(r.digests))
    } catch (e) {
      if (e instanceof SddError && e.code === 'candidate_unstable') {
        throw new SddError('artifacts_unstable', 'los artefactos del flujo cambiaron mientras se leían', {
          next: 'vuelve a correr sdd approve cuando nadie esté escribiendo en el flujo',
        })
      }
      throw e
    }
    const approved = check(stable, gate)

    // Justo antes de escribir, ni `.plans/`, ni el flujo, ni sus archivos pueden haberse vuelto enlaces.
    flowDir(root, id)
    for (const [key, name] of Object.entries(FILE_NAMES) as Array<[keyof FlowRead['digests'], string]>) {
      const st = lstatOrNull(join(dir, name))
      if (st?.isSymbolicLink()) throw pathInvalid(`.plans/${id}/${name}`, 'es un enlace simbólico')
      if (st === null && stable.digests[key] !== 'absent') {
        throw new SddError('artifacts_unstable', `.plans/${id}/${name} desapareció mientras se aprobaba`, { next: 'vuelve a correr sdd approve' })
      }
    }

    const fingerprints = stable.facts.fingerprints
    const gates = GATES[approved.depth]
    const previous = Object.fromEntries(gates.slice(0, gates.indexOf(approved.gate)).map((g) => [g, fingerprints[g]]))
    const fingerprint = fingerprints[approved.gate]
    if (fingerprint === undefined || Object.values(previous).some((f) => f === undefined)) {
      throw rejected(`faltan huellas para el gate ${approved.gate} o sus anteriores`)
    }
    const logged = stable.facts.log.state === 'ok' ? stable.facts.log.approvals : []
    if (registered(stable) > seen) {
      throw new SddError('decision_conflict', `otro comando registró el gate ${approved.gate} mientras este esperaba`, {
        next: `corre ./bin/sdd-ai sdd status ${id} para ver el estado nuevo`,
      })
    }
    const consumed = new Set(logged.flatMap((a) => (a.proof ? [a.proof.ref] : [])))
    const q = gateQuestion(id, approved.gate, fingerprint, previous as Partial<Record<GateId, string>>)
    const proof: Proof = proveFn({ env, conductor, q, authorizes: GATE_OPTIONS.approve, consumed })
    const entry: Approval = { gate: approved.gate, depth: approved.depth, fingerprint, previous, at: now.toISOString(), proof }
    const approvals = [...logged, entry]
    writeJsonAtomic(join(dir, APPROVALS_FILE), { schema_version: 1, approvals })
    return resolve({ ...stable.facts, log: { state: 'ok', approvals } })
  })
}
