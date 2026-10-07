import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Proof, prove } from '../approval/proof.ts'
import { GATE_OPTIONS, gateQuestion } from '../approval/question.ts'
import { freezeStableWith, sha256 } from '../review/candidate.ts'
import { detectRunner } from '../approval/session.ts'
import { type Family, SddError } from '../types.ts'
import { withFlowLock } from './phase-state.ts'
import { APPROVALS_FILE, FILE_NAMES, type FlowRead, flowDir, lstatOrNull, pathInvalid, readFlow } from './read.ts'
import { type Approval, type Depth, type FlowStatus, GATE_IDS, GATES, type GateId, missingParts, resolve } from './status.ts'
import { type ApproveDeps, ApprovalSyncPending, REAL_DEPS, gateApproved, pendingFields, prepareEdits } from './approve-sync.ts'

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
 * de ese gate con esas huellas, en la sesión del runner. Después sincroniza spec_approved_at y status
 * en los headers existentes, sin tocar los cuerpos. Una aprobación vigente y probada se recupera sin
 * nueva pregunta; un rechazo anterior al registro deja los artefactos como estaban.
 */
export function approve(root: string, id: string, gate: string, now: Date, read: typeof readFlow = readFlow,
  proveFn: typeof prove = prove, env: Record<string, string | undefined> = process.env, conductor?: Family,
  deps: ApproveDeps = REAL_DEPS): FlowStatus {
  const observed = read(root, id)
  check(observed, gate)
  const registered = (r: FlowRead) => (r.facts.log.state === 'ok' ? r.facts.log.approvals.filter((a) => a.gate === gate).length : 0)
  const seen = registered(observed)
  const dir = flowDir(root, id)
  return withFlowLock(root, id, () => {
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
    const last = logged.findLast((a) => a.gate === approved.gate)
    // Una entrada vigente y probada del gate se recupera: no se pregunta de nuevo ni se agrega otra entrada.
    const recovering = last?.proof !== undefined && gateApproved(stable.facts, approved.gate)
    const expected = { ...stable.digests }
    const confirm = () => {
      flowDir(root, id)
      for (const name of Object.values(FILE_NAMES)) {
        const st = lstatOrNull(join(dir, name))
        if (st && !st.isFile()) throw pathInvalid(`.plans/${id}/${name}`, 'no es un archivo regular')
      }
      const current = read(root, id)
      if (JSON.stringify(current.digests) !== JSON.stringify(expected)) {
        throw new SddError('artifacts_unstable', 'los insumos cambiaron mientras se aprobaba', { next: 'vuelve a correr sdd approve' })
      }
      check(current, gate)
      return current
    }
    if (recovering) detectRunner(env, conductor)
    deps.activity(root, id)
    confirm()
    let entry: Approval
    if (recovering) {
      entry = last!
    } else {
      const consumed = new Set(logged.flatMap((a) => (a.proof ? [a.proof.ref] : [])))
      const q = gateQuestion(id, approved.gate, fingerprint, previous as Partial<Record<GateId, string>>)
      const proof: Proof = proveFn({ env, conductor, q, authorizes: GATE_OPTIONS.approve, consumed })
      entry = { gate: approved.gate, depth: approved.depth, fingerprint, previous, at: now.toISOString(), proof }
    }
    const approvals = recovering ? logged : [...logged, entry]
    const projected: FlowRead = { ...stable, facts: { ...stable.facts, log: { state: 'ok', approvals } } }
    const edits = prepareEdits(root, projected, approved.gate)
    deps.activity(root, id)
    confirm()
    // Desde la primera escritura de la operación (el registro en una decisión nueva, el primer header en
    // una recuperación), un fallo ya no es un rechazo: la aprobación existe y faltan headers por completar.
    let pending = false
    try {
      if (!recovering) {
        const file = join(dir, APPROVALS_FILE)
        deps.writeJson(file, { schema_version: 1, approvals })
        pending = true
        // El digest esperado sale de lo escrito, no de repetir el formato del escritor.
        expected.approvals = `present:${sha256(readFileSync(file, 'utf8'))}`
      }
      for (const edit of edits) {
        deps.activity(root, id)
        const current = confirm()
        if (!gateApproved(current.facts, approved.gate)) throw rejected('la aprobación perdió vigencia')
        pending = true
        deps.writeText(join(root, edit.path), edit.text)
        expected[edit.key] = `present:${sha256(edit.text)}`
      }
      deps.activity(root, id)
      return resolve(confirm().facts)
    } catch (e) {
      if (!pending) throw e
      let status: FlowStatus | null = null
      try { status = resolve(read(root, id).facts) } catch { /* Se informa la incertidumbre sin revertir. */ }
      throw new ApprovalSyncPending({ state: 'sync_pending', code: 'approval_sync_pending', approval_registered: true,
        id, gate: approved.gate, at: entry.at, pending_headers: pendingFields(root, edits),
        message: 'la aprobación quedó registrada; falta confirmar o completar la sincronización',
        detail: e instanceof SddError && e.detail ? `${e.message}: ${e.detail}` : e instanceof Error ? e.message : String(e),
        recovery_command: `./bin/sdd-ai sdd approve ${id} ${gate}${conductor ? ` --conductor ${conductor}` : ''}`, status,
      })
    }
  })
}
