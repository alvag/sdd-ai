import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type CandidateFingerprint, candidateFingerprint } from '../git.ts'
import { type HarvestRecord, type WriterControl, flowWriterRuns, isWriterRun, readControl, readHarvest, readTakeoverMap, runEntries } from '../writer-store.ts'
import { type ChainInput, type ChainState, type ReceiptFacts, type RunFacts, chainState, lastLink, proposeClass, redRows, unattestedRows } from './chain.ts'
import { criteriaIds, taskLines } from './markdown.ts'
import { admitFix, admitImplement } from './phase.ts'
import { type Chain, type ChainClass, type ChainEntry, type ImplementRecord, appendEntry, closeChain, implementOf, latestFinalReceipt, readPhaseRecord, receiptAfterTakeover } from './phase-state.ts'
import { type FlowRead, flowDir } from './read.ts'
import { headerData, isDepth } from './status.ts'
import { type VerificationRow, readVerification } from './verification-contract.ts'
import { PLAN_GATE } from './verify-state.ts'
import { type AttestationRef, type VerifyReceipt, type VerifyReceiptRef, currentAttestation, readVerifyReceipt, receiptDir } from './verify-receipt.ts'

// Los hechos de disco que necesita `chainState`: el registro, el control y la cosecha de cada corrida,
// el último recibo final, las aprobaciones y las tasks abiertas. Solo lee.

export interface ChainView {
  state: ChainState
  input: ChainInput
  /** La cadena sintética de un writer anterior a las cadenas, si el registro no tiene ninguna. */
  legacy?: string
  receipt: VerifyReceipt | null
  receiptRef: VerifyReceiptRef | null
}

/** Las tasks que el contrato admitido de una corrida acredita, o `null` si no se admitió. Un writer sin `kind` no acredita nada. */
function completedOf(h: HarvestRecord, c: WriterControl): string[] | null {
  const kind = c.phase?.kind
  if (!kind || !c.phase) return null
  if (kind === 'fix') {
    const rows = (c.phase.fix?.rows ?? []).map((r) => r.id)
    const a = admitFix(h.report ?? '', rows)
    return a.kind === 'admitted' ? a.review.rows.map((r) => r.id) : null
  }
  const a = admitImplement(h.report ?? '', c.phase.pending, { explicit: true })
  return a.kind === 'admitted' ? a.review.tasks.filter((t) => t.completion === 'done').map((t) => t.id) : null
}

/** Lo que sabe la cadena de una corrida; sin su control, nada. */
export function runFacts(root: string, run: string): RunFacts | null {
  let c: WriterControl
  try {
    c = readControl(root, run)
  } catch {
    return null
  }
  const h = readHarvest(root, run)
  return {
    run, kind: c.phase?.kind, pending: c.phase?.pending ?? [], ...(h?.state === 'launch_failed' ? { launchFailed: true } : {}),
    ...(h ? {
      harvest: {
        finished: h.state === 'done', endMark: h.endMark, inputsStable: h.phase_inputs !== 'changed',
        integrity: h.flagged.length === 0 && h.runAltered.length === 0 && !h.headMoved,
        delta: h.delta ?? h.files.map((f) => f.path), files: h.files.length, completed: completedOf(h, c),
      },
    } : {}),
  }
}

/**
 * Un writer de fase anterior a las cadenas, sin `kind`, como una cadena ya cerrada con `legacy`: su cosecha
 * no es padre de nada. Solo si el registro todavía no tiene cadenas.
 */
function legacyChain(root: string, id: string, imp: ImplementRecord): { chain: Chain; run: string } | null {
  if (imp.chains.length > 0) return null
  const last = flowWriterRuns(root, id).at(-1)
  if (!last || last.phase?.kind) return null
  const h = readHarvest(root, last.id)
  const at = h ? new Date(0).toISOString() : new Date().toISOString()
  return {
    run: last.id,
    chain: {
      id: 'legacy', entries: [{ kind: 'implement', run: last.id, parent: null, at, pending: last.phase?.pending ?? [] }],
      terminal: h ? { code: 'legacy', at, detail: 'writer de fase anterior a las cadenas: su completitud la acreditan las tasks marcadas' } : null,
    },
  }
}

/**
 * Los hechos del último recibo final del flujo: si sigue vigente para el árbol y el plan de ahora, y sus filas
 * rojas. Después de una toma, solo un recibo posterior a ella está vigente, aunque el árbol sea el mismo.
 */
function receiptFacts(root: string, id: string, r: VerifyReceipt, ref: VerifyReceiptRef, planFingerprint: string | undefined, imp: ImplementRecord, refs: readonly AttestationRef[]): ReceiptFacts {
  let current = false
  let now: CandidateFingerprint | null = null
  try {
    now = candidateFingerprint(root, id, r.after.base_commit)
    current = r.plan_fingerprint === planFingerprint && r.after.tree === now.tree && r.after.base_commit === now.base_commit
      && receiptAfterTakeover(r, imp)
  } catch {
    current = false
  }
  const manual = unattestedRows(r)
  // Una acreditación que no se puede leer deja su fila pendiente, sin cambiar la vigencia del recibo.
  const attested = now === null || !planFingerprint ? [] : manual.filter((row) => {
    try {
      return currentAttestation(root, refs, id, row, now, planFingerprint).ref !== null
    } catch {
      return false
    }
  })
  const red = redRows(r)
  const cause = r.green || red.length > 0 ? undefined
    : r.writer && !r.writer.end_mark ? 'no_end_mark' : r.after.tree !== r.before.tree ? 'tree_mutated' : 'other'
  return { id: ref.id, digest: ref.digest, green: r.green, current, red, attested, unattested: manual.filter((row) => !attested.includes(row)), ...(cause ? { cause } : {}) }
}

/** El estado de la cadena del flujo con los hechos de disco de ahora. */
export function chainView(root: string, id: string, read: FlowRead): ChainView {
  const record = readPhaseRecord(root, id)
  let imp = implementOf(record)
  const legacy = legacyChain(root, id, imp)
  if (legacy) imp = { ...imp, chains: [legacy.chain] }
  const runs = new Map<string, RunFacts>()
  for (const chain of imp.chains) {
    for (const e of chain.entries) {
      if (e.kind === 'takeover') continue
      const f = runFacts(root, e.run)
      if (f) runs.set(e.run, f)
    }
  }
  const ref = latestFinalReceipt(record)
  let receipt: VerifyReceipt | null = null
  try {
    receipt = ref ? readVerifyReceipt(root, ref) : null
  } catch {
    receipt = null
  }
  const header = headerData(read.facts.planHeader)
  const depth = header?.profundidad
  const planFingerprint = isDepth(depth) ? read.facts.fingerprints[PLAN_GATE[depth]] : undefined
  const tasksFile = join(flowDir(root, id), 'tasks.md')
  const open = existsSync(tasksFile) ? taskLines(readFileSync(tasksFile, 'utf8')).filter((l) => !l.done && l.task).map((l) => l.task!.id) : []
  const input: ChainInput = {
    imp, runs, receipt: receipt && ref ? receiptFacts(root, id, receipt, ref, planFingerprint, imp, record.verify?.attestations ?? []) : null,
    approvals: read.facts.log.state === 'ok' ? read.facts.log.approvals : [], open,
    failed: new Set([
      ...imp.events.filter((e) => e.kind === 'launch_failed' && e.run).map((e) => e.run!),
      // Una corrida que el supervisor no llegó a lanzar tampoco es un eslabón: no tiene sesión que reanudar.
      ...[...runs.values()].filter((f) => f.launchFailed).map((f) => f.run),
    ]),
  }
  return { state: chainState(input), input, ...(legacy ? { legacy: legacy.run } : {}), receipt, receiptRef: ref }
}

/** El último eslabón de la cadena del flujo y el mapa de su árbol, o `null` si el flujo no tiene writers de fase. */
export interface CurrentLink { chain: Chain; link: ChainEntry; map: Map<string, string> | null; legacy?: string }

export function currentLink(root: string, id: string): CurrentLink | null {
  let imp = implementOf(readPhaseRecord(root, id))
  const legacy = legacyChain(root, id, imp)
  if (legacy) imp = { ...imp, chains: [legacy.chain] }
  const chain = imp.chains.at(-1)
  if (!chain) return null
  const failed = new Set(imp.events.filter((e) => e.kind === 'launch_failed' && e.run).map((e) => e.run!))
  for (const e of chain.entries) if (e.kind !== 'takeover' && readHarvest(root, e.run)?.state === 'launch_failed') failed.add(e.run)
  const link = lastLink(chain, failed)
  if (!link) return null
  const map = link.kind === 'takeover' ? readTakeoverMap(root, link.map) : runEntries(root, link.run)
  return { chain, link, map, ...(legacy ? { legacy: legacy.run } : {}) }
}

/**
 * Deja en el registro la cadena sintética de un writer anterior a las cadenas, cerrada con `legacy`, y
 * devuelve su id. Va dentro de `withFlowLock`.
 */
export function persistLegacy(root: string, id: string, cur: CurrentLink): string {
  if (cur.legacy === undefined) return cur.chain.id
  const [entry] = cur.chain.entries
  const chain = appendEntry(root, id, null, entry)
  closeChain(root, id, chain, { code: 'legacy', at: new Date().toISOString(), detail: 'writer de fase anterior a las cadenas: su completitud la acreditan las tasks marcadas' })
  return chain
}

/** Las filas del contrato de verificación del plan de hoy. */
export function contractRows(root: string, id: string): VerificationRow[] {
  const dir = flowDir(root, id)
  const read = readVerification(readFileSync(join(dir, 'plan.md'), 'utf8'), criteriaIds(readFileSync(join(dir, 'spec.md'), 'utf8')))
  return read.kind === 'structured' ? read.contract.rows : []
}

/** Los últimos `n` bytes de un archivo, sin leer el resto. */
export function fileTail(file: string, n: number): string {
  const size = statSync(file).size
  if (size <= n) return readFileSync(file, 'utf8')
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * La propuesta del binario para cada fila roja del recibo, con la salida que leyó. Una salida o un contrato
 * que no se leen dejan la propuesta sin ese dato: la clasificación la decide el conductor igual.
 */
export function redProposals(root: string, id: string, receipt: VerifyReceipt): Map<string, ChainClass | null> {
  let contract: VerificationRow[] = []
  try {
    contract = contractRows(root, id)
  } catch {
    contract = []
  }
  const out = new Map<string, ChainClass | null>()
  for (const row of redRows(receipt)) {
    const result = receipt.rows.find((r) => r.row === row)!
    const file = result.execution ? join(receiptDir(root, receipt.id), result.execution.stdout_file) : null
    let stdout: string | null = null
    try {
      stdout = file && existsSync(file) ? fileTail(file, 1024 * 1024) : null
    } catch {
      stdout = null
    }
    out.set(row, proposeClass(contract.find((c) => c.id === row), result, stdout))
  }
  return out
}

/** Las propuestas de cada fila roja y la plantilla del archivo de clases, en texto. */
export function classificationDetail(receipt: VerifyReceipt, proposed: ReadonlyMap<string, ChainClass | null>): string {
  const template = { receipt: receipt.id, rows: redRows(receipt).map((row) => ({ row, class: proposed.get(row) ?? '<implementation | contract | environment | design>', reason: '<por qué>' })) }
  return [...[...proposed].map(([row, c]) => `${row}: ${c ?? 'sin propuesta'}`), `plantilla: ${JSON.stringify(template)}`].join('\n')
}

/**
 * La base de una cadena: la que su primera entrada registró o, en un registro que no la guarda, la de su
 * primera corrida lanzada; si no hay ninguna, la de la cadena anterior más cercana que tenga una. `null` si el
 * flujo no tiene ninguna. Un control que existe y no se lee hace fallar la consulta: la base no se reemplaza
 * en silencio.
 */
export function chainBaseOf(root: string, imp: ImplementRecord, chain: Chain): string | null {
  const i = imp.chains.findIndex((c) => c.id === chain.id)
  const earlier = imp.chains.slice(0, i < 0 ? imp.chains.length : i).reverse()
  for (const c of [chain, ...earlier]) {
    for (const e of c.entries) {
      if (e.kind === 'takeover') continue
      if (e.base !== undefined) return e.base
      // Una corrida sin control nunca se lanzó: sin base registrada, no la fija.
      if (!isWriterRun(root, e.run)) continue
      return readControl(root, e.run).base
    }
  }
  return null
}
