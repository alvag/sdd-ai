import { findingsInstructions } from '../findings.ts'
import { SddError } from '../types.ts'
import { WORKER_POLICY } from '../worker-policy.ts'
import { WRITER_END_MARK } from '../writer.ts'
import { implementReportFormat } from './phase.ts'
import type { TaskActorError, TaskAssignment } from './markdown.ts'
import type { Chain, ChainClass, ChainEntry, ChainTerminal, Classification, ImplementRecord, RunEntry, RunKind } from './phase-state.ts'
import type { VerificationRow } from './verification-contract.ts'
import type { RowResult, VerifyReceipt } from './verify-receipt.ts'
import { parseTap } from './verify.ts'

// La cadena de writers de `implement`: qué clase proponer para una fila roja, qué hacer con cada mezcla de
// clases y cuántas veces falló cada fila. Todo es puro: el disco, los procesos y el registro quedan en la CLI.

export const CHAIN_CLASSES: readonly ChainClass[] = ['implementation', 'contract', 'environment', 'design']

/** Las filas que se clasifican: las rojas. Una fila manual sin acreditar no entra: su salida es acreditarla. */
export function redRows(receipt: Pick<VerifyReceipt, 'rows'>): string[] {
  return receipt.rows.filter((r) => r.outcome === 'failed' || r.outcome === 'unavailable').map((r) => r.row)
}

/** Las filas manuales que el recibo dejó sin acreditar. */
export function unattestedRows(receipt: Pick<VerifyReceipt, 'rows'>): string[] {
  return receipt.rows.filter((r) => r.outcome === 'unrun' && r.execution?.reason === 'manual').map((r) => r.row)
}

/**
 * La clase que el binario propone para una fila roja, o `null` si ninguna regla aplica. En orden: una
 * confirmación refutada dice que la prueba no discrimina (contrato), y una incoherente, que el conjunto de
 * rutas de implementación no carga al revertirse (también contrato); una fila que no se pudo correr es del
 * entorno; una fila de test cuyo TAP trae su test en `not ok` es un defecto de implementación. La propuesta
 * no es la clasificación: la confirma o la cambia el conductor.
 */
export function proposeClass(row: VerificationRow | undefined, result: RowResult, stdout: string | null): ChainClass | null {
  if (result.confirmation?.state === 'refuted' || result.confirmation?.state === 'contract_incoherent') return 'contract'
  if (result.outcome === 'unavailable') return 'environment'
  if (row?.kind === 'test' && result.outcome === 'failed' && stdout !== null) {
    const entries = parseTap(stdout).filter((e) => e.name === row.test_name && !e.suite)
    if (entries.length === 1 && !entries[0].ok) return 'implementation'
  }
  return null
}

export interface ClassifiedRow { row: string; class: ChainClass; reason: string }

const invalid = (why: string) => new SddError('classification_invalid', `la clasificación no sirve: ${why}`, {
  next: 'corrige el archivo de clases: una entrada por fila roja del recibo, con class implementation | contract | environment | design y su razón',
})
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Las filas clasificadas del archivo del conductor. Tiene que ser del recibo, clasificar exactamente todas
 * sus filas rojas, sin repetir, con una clase admitida y una razón que no quede vacía. Una fila que no está
 * en el recibo, o que pasó, se rechaza por su nombre.
 */
export function checkClassification(receipt: Pick<VerifyReceipt, 'id' | 'rows'>, file: unknown): ClassifiedRow[] {
  if (!isMap(file) || file.receipt !== receipt.id || !Array.isArray(file.rows)) {
    throw invalid(`tiene que ser { "receipt": "${receipt.id}", "rows": [...] }`)
  }
  const red = redRows(receipt)
  const seen = new Set<string>()
  const out = file.rows.map((r, i): ClassifiedRow => {
    if (!isMap(r) || typeof r.row !== 'string') throw invalid(`rows[${i}] no nombra su fila`)
    const result = receipt.rows.find((x) => x.row === r.row)
    if (!result) throw invalid(`la fila ${r.row} no está en el recibo ${receipt.id}`)
    if (!red.includes(r.row)) throw invalid(`la fila ${r.row} no está roja en el recibo (${result.outcome})`)
    if (seen.has(r.row)) throw invalid(`la fila ${r.row} está dos veces`)
    seen.add(r.row)
    if (!CHAIN_CLASSES.includes(r.class as ChainClass)) throw invalid(`la fila ${r.row} tiene la clase ${JSON.stringify(r.class)}`)
    if (typeof r.reason !== 'string' || r.reason.trim() === '') throw invalid(`la fila ${r.row} no trae su razón`)
    return { row: r.row, class: r.class as ChainClass, reason: r.reason.trim() }
  })
  const missing = red.filter((row) => !seen.has(row))
  if (missing.length > 0) throw invalid(`faltan las filas rojas ${missing.join(', ')}`)
  return out
}

/**
 * Qué se hace con un recibo clasificado. Precedencia: un hueco de diseño vuelve al plan o a la spec (y las
 * filas de contrato quedan anotadas para esa enmienda); si no, un defecto del contrato pide enmendar
 * `## Verification` y reaprobar el plan; si solo hay entorno, se repite verify; si hay implementación, sola o
 * con entorno, va un `fix` con solo las filas de implementación.
 */
export type Derivation =
  | { kind: 'design'; rows: string[]; contract: string[] }
  | { kind: 'contract'; rows: string[] }
  | { kind: 'environment'; rows: string[] }
  | { kind: 'fix'; rows: string[]; environment: string[] }

export function derive(rows: readonly Pick<ClassifiedRow, 'row' | 'class'>[]): Derivation {
  const of = (c: ChainClass) => rows.filter((r) => r.class === c).map((r) => r.row)
  if (of('design').length > 0) return { kind: 'design', rows: of('design'), contract: of('contract') }
  if (of('contract').length > 0) return { kind: 'contract', rows: of('contract') }
  if (of('implementation').length === 0) return { kind: 'environment', rows: of('environment') }
  return { kind: 'fix', rows: of('implementation'), environment: of('environment') }
}

/** Los gates que contienen el plan en cada profundidad. */
const PLAN_GATES: readonly string[] = ['plan', 'plan-tasks', 'single']

/**
 * La época del conteo de fallos: la última aprobación registrada del gate que contiene el plan, por la
 * referencia de su prueba (o su fecha, si no la trae). Reaprobar el plan, aunque sea con la misma huella,
 * empieza otra época.
 */
export function planEpoch(approvals: readonly { gate: string; at: string; proof?: { ref: string } }[]): string | null {
  const last = [...approvals].reverse().find((a) => PLAN_GATES.includes(a.gate))
  return last ? (last.proof?.ref ?? `at:${last.at}`) : null
}

/**
 * Cuántas veces falló cada fila por un defecto de implementación dentro de la época: una vez por recibo,
 * a través de todas las cadenas y tomas del flujo.
 */
export function failureCounts(imp: Pick<ImplementRecord, 'classifications'>, epoch: string | null): Map<string, number> {
  const out = new Map<string, number>()
  const seen = new Set<string>()
  for (const c of imp.classifications as readonly Classification[]) {
    if (c.epoch !== epoch) continue
    for (const r of c.rows) {
      const key = `${c.receipt.id}|${r.row}`
      if (r.class !== 'implementation' || seen.has(key)) continue
      seen.add(key)
      out.set(r.row, (out.get(r.row) ?? 0) + 1)
    }
  }
  return out
}

/** El tope del encargo de un `fix`, envoltorio incluido, y el de cada tramo de salida por canal. */
export const FIX_PROMPT_BUDGET = 64 * 1024
export const TAIL_BYTES = 4 * 1024
/** Por debajo de esto por fila, los tramos no aportan: se quitan todos. */
const MIN_TAIL_PER_ROW = 256

/** Una fila roja de implementación con lo que el writer necesita para corregirla. */
export interface FixRowInput {
  id: string; argv: string[]; exit_code: number | null; no_exit?: string; excerpt: string
  class: string; reason: string; confirmation?: string; stdout: string; stderr: string
}
export interface FixPromptInput { flow: string; receipt: string; rows: FixRowInput[]; paths: { spec: string; plan: string; tasks: string } }

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** Los últimos `n` bytes de `s`, sin cortar un carácter UTF-8 por la mitad. */
export function tailBytes(s: string, n: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= n) return s
  let start = buf.length - Math.max(0, n)
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}

/** Una cerca más larga que cualquier racha de backticks del texto. */
const fence = (s: string) => '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)))
const fenced = (label: string, s: string) => (s === '' ? `- ${label}: (vacía)` : `- ${label}:\n${fence(s)}text\n${s}\n${fence(s)}`)

function fixRow(r: FixRowInput, tail: number | null): string {
  const lines = [
    `### ${r.id}`,
    `- Comando: \`${JSON.stringify(r.argv)}\``,
    `- Código de salida: ${r.exit_code === null ? `sin código (${r.no_exit ?? 'no terminó'})` : r.exit_code}`,
    `- Extracto: ${r.excerpt}`,
    `- Clase: ${r.class}. Razón del conductor: ${r.reason}`,
  ]
  if (r.confirmation) lines.push(`- Confirmación: ${r.confirmation}`)
  if (tail !== null) {
    lines.push(fenced(`Final de stdout (hasta ${tail} bytes)`, tailBytes(r.stdout, tail)))
    lines.push(fenced(`Final de stderr (hasta ${tail} bytes)`, tailBytes(r.stderr, tail)))
  }
  return lines.join('\n')
}

function fixText(input: FixPromptInput, tail: number | null): string {
  return [
    WORKER_POLICY,
    `# Corrección del flujo ${input.flow}`,
    `Esta es una corrección de tu trabajo anterior en esta misma sesión. \`sdd verify\` corrió el contrato de verificación sobre el candidato acumulado (recibo ${input.receipt}) y estas filas quedaron rojas por un defecto de implementación. Corrígelas todas en esta corrida, sobre el árbol que dejaste, sin rehacer lo que ya estaba bien.`,
    'No cambies una prueba para que pase: si crees que la prueba o su fila están mal, no la toques y dilo en `deviation`.',
    `Si necesitas releer los insumos: spec en \`${input.paths.spec}\`, plan en \`${input.paths.plan}\`, tasks en \`${input.paths.tasks}\`.`,
    '## Filas rojas',
    ...input.rows.map((r) => fixRow(r, tail)),
    findingsInstructions('phase'),
    '## Formato del reporte',
    `Tu reporte trae un único objeto JSON con la clave \`"phase": "fix"\` y exactamente estas claves, antes de la línea \`${WRITER_END_MARK}\`:`,
    '```json\n{ "phase": "fix", "findings": [], "missing_context": ["<lo que faltó>"], "rows": [{ "id": "V<n>", "changed": "<qué cambiaste>", "deviation": { "what": "<en qué te desviaste>", "why": "<por qué>" } | null }] }\n```',
    `- Una entrada por cada fila de esta lista (${input.rows.map((r) => r.id).join(', ')}), y solo esas.`,
    '- `missing_context` es obligatorio aunque vaya vacío.',
  ].join('\n\n') + '\n'
}

/**
 * El encargo de un `fix`, dentro de `budget` bytes UTF-8 (el tope menos el envoltorio del writer). Cada
 * fila lleva su tramo final de stdout y stderr, de hasta 4 KiB por canal. Si no entra, el tramo se
 * reparte parejo entre filas y canales; por debajo de 256 bytes por fila se quitan todos. Nunca se omite
 * una fila: si ni sin tramos entra, `over_budget`.
 */
export function renderFixPrompt(input: FixPromptInput, budget: number): { prompt: string; trimmed: string[] } | { over_budget: true } {
  const full = fixText(input, TAIL_BYTES)
  if (bytes(full) <= budget) return { prompt: full, trimmed: [] }
  const bare = fixText(input, null)
  if (bytes(bare) > budget) return { over_budget: true }
  const channels = input.rows.length * 2
  // El texto con tramos de n bytes crece a lo sumo n por canal, más las cercas y los títulos de cada tramo.
  const overhead = bytes(fixText(input, 0)) - bytes(bare)
  let per = Math.floor((budget - bytes(bare) - overhead) / channels)
  while (per >= MIN_TAIL_PER_ROW / 2 && bytes(fixText(input, per)) > budget) per = Math.floor(per * 0.9)
  const cut = (r: FixRowInput, n: number) => bytes(r.stdout) > n || bytes(r.stderr) > n
  if (per < MIN_TAIL_PER_ROW / 2) return { prompt: bare, trimmed: input.rows.map((r) => r.id) }
  return { prompt: fixText(input, per), trimmed: input.rows.filter((r) => cut(r, per)).map((r) => r.id) }
}

/** El encargo de una continuación que reanuda la sesión: solo las tasks que siguen, con el formato del reporte. */
export function renderContinuationPrompt(flow: string, left: readonly string[]): string {
  return [
    WORKER_POLICY,
    `# Continuación del flujo ${flow}`,
    `Esta es la continuación de tu trabajo anterior en esta misma sesión, sobre el árbol que dejaste. Sigue con las tasks que quedaron pendientes: ${left.join(', ')}. Lo que ya terminaste no se rehace. Una task que no termines va con \`completion: pending\`; no marques las tasks, eso lo hace el conductor.`,
    implementReportFormat(),
    `Tu reporte trae una entrada por cada una de estas tasks (${left.join(', ')}), y solo esas.`,
  ].join('\n\n') + '\n'
}

/** El encargo de la reanudación de una corrida que se cortó antes de cerrar: el mismo trabajo, con el mismo contrato. */
export function renderResumePrompt(flow: string, run: string, contract: 'implement' | 'fix', ids: readonly string[]): string {
  const what = contract === 'fix' ? `las filas ${ids.join(', ')}` : `las tasks ${ids.join(', ')}`
  return [
    WORKER_POLICY,
    `# Reanudación del flujo ${flow}`,
    `Tu corrida anterior (${run}) se cortó antes de cerrar su reporte. Retoma el mismo encargo en esta sesión, sobre el árbol que dejaste, sin rehacer lo que ya quedó hecho.`,
    `Cierra con el mismo contrato de \`${contract}\` que pedía ese encargo, con una entrada por cada una de ${what}, antes de la línea \`${WRITER_END_MARK}\`.`,
  ].join('\n\n') + '\n'
}

// ── El estado de una cadena ────────────────────────────────────────────────────────────────────────────

/** Lo que el llamador sabe de una corrida de la cadena, leído de su control y de su cosecha. */
export interface RunFacts {
  run: string
  kind?: RunKind
  /** El supervisor no llegó a lanzarla: no es un eslabón. */
  launchFailed?: boolean
  /** Las tasks congeladas al lanzar. */
  pending: string[]
  /** Sin cosecha: la corrida sigue abierta. */
  harvest?: {
    /** Si terminó en `done`. */
    finished: boolean; endMark: boolean; inputsStable: boolean
    /** Sin rutas sensibles señaladas, sin corrida alterada y sin HEAD movido. */
    integrity: boolean
    /** Las rutas que cambió frente a su padre; en una reanudación, frente al padre de la corrida original. */
    delta: string[] | null
    /** Cuántos archivos trae el candidato acumulado contra la base. */
    files: number
    /** El contrato admitido: las tasks que declaró `done` (implement) o que respondió (fix). `null` si no se admitió. */
    completed: string[] | null
  }
}

/** El último recibo final del flujo, visto por el llamador. */
export interface ReceiptFacts {
  id: string; digest: string; green: boolean
  /** Si su candidato es el árbol de ahora y su plan el aprobado vigente. */
  current: boolean
  red: string[]; unattested: string[]
  /** Las filas manuales del recibo con una acreditación vigente. */
  attested: string[]
  /** Un recibo rojo sin filas rojas: por qué. */
  cause?: 'no_end_mark' | 'tree_mutated' | 'other'
}

export interface ChainInput {
  /** Las responsabilidades del artefacto de tasks vigente. Sin ellas (un llamador anterior), rige `open`. */
  writerPending?: string[]
  externalPending?: TaskAssignment[]
  inlinePending?: string[]
  actorErrors?: TaskActorError[]
  imp: ImplementRecord
  runs: ReadonlyMap<string, RunFacts>
  receipt: ReceiptFacts | null
  approvals: readonly { gate: string; at: string; proof?: { ref: string } }[]
  /** Las tasks abiertas en `tasks.md` ahora. */
  open: string[]
  /** Las corridas con un evento `launch_failed`: no son eslabones. */
  failed: ReadonlySet<string>
}

/** Qué propone la cadena a continuación. */
export type ChainNext =
  | { kind: 'actors_pending'; assignments: TaskAssignment[]; covered: string[] }
  | { kind: 'start' }
  | { kind: 'wait'; run: string }
  | { kind: 'orphan'; run: string }
  | { kind: 'resume'; run: string }
  | { kind: 'continue'; left: string[] }
  | { kind: 'blocks_or_takeover'; left: string[]; why: string }
  | { kind: 'mark_and_verify'; unmarked: string[] }
  | { kind: 'verify' }
  | { kind: 'classify'; receipt: string }
  | { kind: 'fix'; receipt: string; rows: string[] }
  | { kind: 'repeat_verify'; rows: string[] }
  | { kind: 'amend_contract'; rows: string[] }
  | { kind: 'back_to_plan'; rows: string[] }
  | { kind: 'attest'; rows: string[] }
  | { kind: 'review' }
  | { kind: 'conductor'; why: string }
  /** Trabajo que el conductor coordina antes de verificar: no es una toma ni propone `verify`. */
  | { kind: 'coordinate'; why: string }
  | { kind: 'takeover'; why: string }

export interface ChainState {
  chain: Chain | null
  /** El último eslabón válido: una corrida o una toma. */
  last: ChainEntry | null
  /** Las tasks congeladas de la cadena, las acreditadas y las que siguen. */
  scope: string[]; covered: string[]; left: string[]
  /** Las acreditadas que siguen abiertas en tasks.md: las únicas que el conductor todavía tiene que marcar. */
  unmarked: string[]
  fixes: number
  terminal: ChainTerminal | null
  /** Un terminal que el estado ya implica y que todavía no se escribió. */
  derived: ChainTerminal | null
  counts: Map<string, number>
  epoch: string | null
  next: ChainNext
}

const MAX_FIXES = 2
const MAX_FAILURES = 3

const isRun = (e: ChainEntry): e is RunEntry => e.kind !== 'takeover'

/** El último eslabón de una cadena, sin las corridas cuyo lanzamiento falló. */
export function lastLink(chain: Chain, failed: ReadonlySet<string>): ChainEntry | null {
  return [...chain.entries].reverse().find((e) => !isRun(e) || !failed.has(e.run)) ?? null
}

/**
 * Las tasks que una corrida acredita: las que declaró `done`, solo si terminó con su marca final, cambió
 * algo medido frente a su padre, dejó un candidato no vacío y su cosecha es íntegra con insumos estables.
 * Una corrida cortada no acredita nada: lo que declaró lo dice su reanudación.
 */
function credited(f: RunFacts | undefined): string[] {
  const h = f?.harvest
  if (!h || !h.finished || !h.endMark || h.completed === null || f?.kind === 'fix' || !h.delta?.length || h.files === 0 || !h.inputsStable || !h.integrity) return []
  return h.completed
}

/** Si alguna aprobación del plan o de las tasks es posterior a `at`. */
function approvedAfter(approvals: ChainInput['approvals'], at: string): boolean {
  return approvals.some((a) => ['plan', 'tasks', 'plan-tasks', 'single'].includes(a.gate) && Date.parse(a.at) > Date.parse(at))
}

/**
 * El estado de la cadena actual del flujo y qué sigue. Puro: el llamador le pasa el registro, los hechos de
 * cada corrida, el último recibo final, las aprobaciones y las tasks abiertas. No escribe terminales: los
 * devuelve en `derived` para que un verbo con el lock los escriba.
 */
export function chainState(input: ChainInput): ChainState {
  const { imp, runs, receipt, approvals, failed } = input
  const epoch = planEpoch(approvals)
  const counts = failureCounts(imp, epoch)
  const capped = [...counts.values()].some((n) => n >= MAX_FAILURES)
  const chain = imp.chains.at(-1) ?? null
  const base = { chain, counts, epoch, derived: null as ChainTerminal | null }
  const at = new Date(0).toISOString()
  // Lo que el writer no puede tomar: actores inválidos, pendientes fuera de la gramática y, sin trabajo del writer,
  // las tasks de conductor y user. Va después de las guardas de actividad e integridad de cada camino. Una task del
  // writer ya acreditada y sin marcar no es trabajo del writer: solo falta marcarla.
  const coordination = (covered: string[]): ChainNext | null => {
    const writerLeft = input.writerPending?.filter((t) => !covered.includes(t))
    if (input.actorErrors?.length) {
      return { kind: 'coordinate', why: `hay tasks con actor inválido: ${input.actorErrors.map((e) => `línea ${e.line} (${e.id ?? 'sin id'}): ${e.detail}`).join('; ')}` }
    }
    if (input.inlinePending?.length) return { kind: 'coordinate', why: `hay pendientes que requieren atención inline: ${input.inlinePending.join('; ')}` }
    if (input.externalPending?.length && writerLeft?.length === 0) {
      return { kind: 'actors_pending', assignments: input.externalPending, covered: covered.filter((t) => input.open.includes(t)) }
    }
    return null
  }
  // Sin eslabones vivos solo queda lanzar el inicial o, si no hay trabajo del writer, coordinar las tasks de conductor y
  // user. Los actores inválidos y las pendientes inline los diagnostica el propio lanzamiento inicial (`start`).
  const startOrCoordinate = (covered: string[]): ChainNext =>
    (input.actorErrors?.length || input.inlinePending?.length ? null : coordination(covered)) ?? { kind: 'start' }
  if (chain === null) {
    return { ...base, last: null, scope: [], covered: [], left: [], unmarked: [], fixes: 0, terminal: null, next: startOrCoordinate([]) }
  }
  const last = lastLink(chain, failed)
  const runEntries = chain.entries.filter(isRun).filter((e) => !failed.has(e.run))
  const scope = runEntries[0]?.pending ?? []
  const covered = [...new Set(runEntries.flatMap((e) => credited(runs.get(e.run))))].filter((t) => scope.includes(t))
  const left = scope.filter((t) => !covered.includes(t))
  const unmarked = covered.filter((t) => input.open.includes(t))
  // `left` es todo el alcance sin acreditar; `candidates`, lo que de eso sigue siendo del writer en el artefacto
  // vigente. `continue` y `blocks_or_takeover` llevan `candidates`.
  const candidates = input.writerPending === undefined ? left : left.filter((t) => input.writerPending!.includes(t))
  const fixes = runEntries.filter((e) => e.kind === 'fix').length
  const done = { ...base, last, scope, covered, left, unmarked, fixes, terminal: chain.terminal }
  const derive = (code: ChainTerminal['code'], detail: string): ChainTerminal => ({ code, at, detail })

  // Una cadena cerrada: la toma o un terminal. Después, solo el conductor, o una cadena nueva con una aprobación posterior.
  // Con el tope de fallos alcanzado, solo reaprobar el plan (que abre otra época) deja abrir otra cadena.
  const closed = chain.terminal ?? (last && !isRun(last) ? derive('takeover', 'la cadena la tomó el conductor') : null)
  if (closed !== null) {
    const reopen = (input.writerPending ?? input.open).length > 0 && !capped && approvedAfter(approvals, closed.at === at ? (last?.at ?? at) : closed.at)
      && !(closed.code === 'legacy' && (last === null || isRun(last)))
    if (reopen) return { ...done, derived: chain.terminal ? null : closed, next: { kind: 'start' } }
    const next: ChainNext = capped && !(receipt?.current && receipt.green)
      ? { kind: 'conductor', why: 'tres fallos de la misma fila en esta época del plan: vuelve al plan o a la spec' }
      : coordination(covered) ?? afterClose(closed, receipt, last, input.open, imp)
    return { ...done, derived: chain.terminal ? null : closed, next }
  }
  // Sin eslabones vivos se relanza el inicial, salvo que no quede trabajo del writer: misma salida que sin cadena.
  if (last === null) return { ...done, next: startOrCoordinate(covered) }
  const facts = isRun(last) ? runs.get(last.run) : undefined
  const h = facts?.harvest
  if (isRun(last) && !facts) return { ...done, next: { kind: 'orphan', run: last.run } }
  if (isRun(last) && !h) return { ...done, next: { kind: 'wait', run: last.run } }
  if (h && (!h.integrity || !h.inputsStable)) {
    return { ...done, next: { kind: 'takeover', why: !h.integrity ? 'la cosecha tiene rutas señaladas, la corrida alterada o HEAD movido' : 'cambiaron los insumos durante la corrida' } }
  }
  if (capped) return { ...done, derived: derive('failure_cap', 'tres fallos de la misma fila en esta época del plan'), next: { kind: 'takeover', why: 'se alcanzaron tres fallos de la misma fila: vuelve al plan o a la spec' } }
  if (h && (!h.finished || !h.endMark)) {
    const isFix = isRun(last) && last.kind === 'fix'
    if (isFix && fixes >= MAX_FIXES) return { ...done, derived: derive('fix_cap', 'la segunda corrección no terminó'), next: { kind: 'takeover', why: FIX_CAP } }
    return { ...done, next: { kind: 'resume', run: (last as RunEntry).run } }
  }
  const lastRun = last as RunEntry
  if (h && h.completed === null) return { ...done, next: { kind: 'takeover', why: 'el contrato del writer no se admitió: su cosecha no es padre de otra corrida' } }
  // Un candidato acumulado vacío (una corrección que deshizo todo) no se verifica ni es padre de otra corrección. Va
  // antes de la coordinación y del marcado; una continuación con tasks del writer sigue disponible, como antes.
  const continuing = lastRun.kind !== 'fix' && candidates.length > 0
  if (h && h.files === 0 && !continuing) return { ...done, next: { kind: 'takeover', why: 'el candidato acumulado quedó vacío: no hay cambio que verificar' } }
  const remaining = coordination(covered)
  if (remaining) return { ...done, next: remaining }
  if (continuing) {
    const progress = credited(facts).some((t) => !runEntries.slice(0, -1).flatMap((e) => credited(runs.get(e.run))).includes(t))
    const first = runEntries.length === 1
    if (lastRun.kind === 'block' && !progress) return { ...done, derived: derive('no_progress', 'un bloque no completó ninguna task nueva'), next: { kind: 'takeover', why: 'un bloque no completó ninguna task nueva' } }
    if (!first && !progress) return { ...done, next: { kind: 'blocks_or_takeover', left: candidates, why: 'la continuación no completó ninguna task nueva' } }
    return { ...done, next: { kind: 'continue', left: candidates } }
  }
  // Las tasks del writer fuera del alcance congelado van antes que las externas, para que la salida no las oculte.
  const outside = input.writerPending?.filter((t) => !scope.includes(t)) ?? []
  if (outside.length > 0) {
    const external = input.externalPending?.length ? `; quedan además ${input.externalPending.map((t) => `${t.id} (${t.actor})`).join(', ')}` : ''
    return { ...done, next: { kind: 'coordinate', why: `hay tasks del writer fuera del alcance congelado (${outside.join(', ')}): coordina su ejecución sin ampliar esta cadena${external}` } }
  }
  if (input.externalPending?.length) return { ...done, next: { kind: 'actors_pending', assignments: input.externalPending, covered: unmarked } }
  // Las tasks que el writer acreditó y siguen abiertas en tasks.md: primero se marcan, después se verifica. Solo con
  // las responsabilidades del artefacto: un llamador anterior conserva su orientación.
  if (input.writerPending !== undefined && unmarked.length > 0) return { ...done, next: { kind: 'mark_and_verify', unmarked } }
  const next = onCandidate(receipt, imp, lastRun.kind === 'fix', fixes)
  // Una corrección que no cambió nada deja el mismo candidato: el recibo sigue vigente y la cadena vuelve a él.
  if (next.kind === 'takeover' && next.why.startsWith(FIX_CAP)) return { ...done, derived: derive('fix_cap', 'dos correcciones sin llegar al verde'), next }
  return { ...done, next }
}

const FIX_CAP = 'se agotaron las dos correcciones de la cadena'

/**
 * Qué sigue con un candidato completo: verificarlo, resolver su rojo o revisarlo. Un rojo después de la
 * segunda corrección agota la cadena; si no, su clasificación registrada decide.
 */
function onCandidate(receipt: ReceiptFacts | null, imp: ImplementRecord, afterFix: boolean, fixes: number): ChainNext {
  if (receipt === null || !receipt.current) return { kind: 'verify' }
  if (receipt.green) return { kind: 'review' }
  if (receipt.red.length === 0) {
    if (receipt.unattested.length > 0) return { kind: 'attest', rows: receipt.unattested }
    if (receipt.attested.length > 0) return { kind: 'verify' }
    if (receipt.cause === 'tree_mutated') return { kind: 'amend_contract', rows: [] }
    return { kind: 'conductor', why: 'el recibo es rojo sin filas rojas' }
  }
  if (afterFix && fixes >= MAX_FIXES) return { kind: 'takeover', why: FIX_CAP }
  const c = imp.classifications.find((x) => x.receipt.id === receipt.id)
  if (!c) return { kind: 'classify', receipt: receipt.id }
  const d = derive(c.rows)
  if (d.kind === 'design') return { kind: 'back_to_plan', rows: d.rows }
  if (d.kind === 'contract') return { kind: 'amend_contract', rows: d.rows }
  if (d.kind === 'environment') return { kind: 'repeat_verify', rows: d.rows }
  if (fixes >= MAX_FIXES) return { kind: 'takeover', why: FIX_CAP }
  return { kind: 'fix', receipt: receipt.id, rows: d.rows }
}

/**
 * Qué sigue con la cadena cerrada: nada del writer. Recién declarada una toma, o con las tasks de un writer
 * anterior a las cadenas todas marcadas, se verifica ese árbol; un rojo vigente se deriva por clase como
 * con la cadena abierta, y lo que ahí sería un `fix` lo corrige el conductor y lo declara como otra toma.
 */
function afterClose(t: ChainTerminal, receipt: ReceiptFacts | null, last: ChainEntry | null, open: string[], imp: ImplementRecord): ChainNext {
  if (receipt?.current && receipt.green) return { kind: 'review' }
  if (t.code === 'back_to_plan' || t.code === 'failure_cap') return { kind: 'conductor', why: 'vuelve al plan o a la spec; con la aprobación nueva, una cadena nueva toma las tasks que falten' }
  if (receipt?.current) {
    const next = onCandidate(receipt, imp, false, 0)
    return next.kind === 'fix' ? { kind: 'conductor', why: `la cadena del writer está cerrada: corrige a mano ${next.rows.join(', ')}` } : next
  }
  const verifiable = open.length === 0 && (last?.kind === 'takeover' || t.code === 'legacy')
  if (verifiable && !receipt?.current) return { kind: 'verify' }
  if (t.code === 'legacy' && open.length > 0) return { kind: 'conductor', why: `el writer anterior a las cadenas dejó tasks sin marcar (${open.join(', ')}): termínalas a mano` }
  return { kind: 'conductor', why: 'la cadena del writer está cerrada: corrige a mano' }
}

/** El archivo donde el conductor clasifica un recibo: dentro del flujo, que no cuenta como cambio del árbol. */
export const classesPath = (id: string, receipt: string) => `.plans/${id}/classes-${receipt}.json`

/** Cómo sigue a mano el conductor cuando la cadena del writer no lanza nada más. */
export const takeoverHint = (id: string) => `sigue a mano y declara la toma antes de verificar: ./bin/sdd-ai sdd verify ${id} --takeover`

/** La indicación de marcar en tasks.md lo que acreditó el writer: la cadena no marca tasks. */
export const markHint = (covered: readonly string[]) => `marca en tasks.md las tasks acreditadas (${covered.join(', ') || 'ninguna'})`

/**
 * Si la cosecha antepone `markHint`: no cuando la orientación ya pide marcar ni cuando queda una corrida del writer por
 * esperar, reanudar o cerrar.
 */
export function harvestNeedsMarkHint(next: ChainNext): boolean {
  const own = ['actors_pending', 'mark_and_verify', 'wait', 'resume', 'orphan'] satisfies ChainNext['kind'][]
  return !(own as readonly string[]).includes(next.kind)
}

/** Qué hacer, en palabras, según el estado de la cadena. */
export function orientation(id: string, next: ChainNext): string {
  switch (next.kind) {
    case 'actors_pending': return `coordina las tasks pendientes: ${next.assignments.map((t) => `${t.id} — ${t.title} (${t.actor})`).join('; ')}. Cada responsable ejecuta su acción y el conductor marca la task después; todavía no corresponde verify final${next.covered.length > 0 ? `; ${markHint(next.covered)}` : ''}`
    case 'verify': return `corre ./bin/sdd-ai sdd verify ${id}`
    case 'classify': return `clasifica las filas rojas del recibo ${next.receipt} en ${classesPath(id, next.receipt)} y corre ./bin/sdd-ai sdd phase ${id} --classes ${classesPath(id, next.receipt)}`
    case 'fix': return `lanza el fix: ./bin/sdd-ai sdd phase ${id}`
    case 'repeat_verify': return `las filas ${next.rows.join(', ')} fallaron por el entorno: corre de nuevo ./bin/sdd-ai sdd verify ${id}`
    case 'amend_contract': return next.rows.length > 0
      ? `las filas ${next.rows.join(', ')} son un defecto del contrato: enmienda ## Verification y reaprueba el plan`
      : 'una fila cambió el árbol: es un defecto del contrato. Devuelve el árbol al de la cosecha, enmienda la fila y reaprueba el plan'
    case 'back_to_plan': return 'hueco de diseño: vuelve al plan o a la spec y reaprueba'
    case 'attest': return `acredita las filas manuales: ./bin/sdd-ai sdd verify ${id} --attest <fila>`
    case 'review': return 'el candidato está verde: revisa el diff'
    case 'resume': return `reanuda la corrida ${next.run}: ./bin/sdd-ai sdd phase ${id}; o ${takeoverHint(id)}`
    case 'continue': return `sigue con ${next.left.join(', ')}: ./bin/sdd-ai sdd phase ${id}`
    case 'blocks_or_takeover': return `${next.why}: ./bin/sdd-ai sdd phase ${id} --blocks; o ${takeoverHint(id)}`
    case 'wait': return `./bin/sdd-ai wait ${next.run}`
    case 'orphan': return `la corrida ${next.run} quedó registrada sin control: ciérrala con ./bin/sdd-ai cancel ${next.run}`
    case 'start': return `./bin/sdd-ai sdd phase ${id}`
    case 'mark_and_verify': return `${markHint(next.unmarked)} y corre ./bin/sdd-ai sdd verify ${id}`
    case 'takeover':
    case 'conductor': return `${next.why}; ${takeoverHint(id)}`
    case 'coordinate': return `${next.why}; resuélvelo antes de verificar y vuelve a consultar ./bin/sdd-ai sdd status ${id}`
  }
}
