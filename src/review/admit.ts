import type { Candidate } from './candidate.ts'
import type { Answer, RefuteResult, RoundPlan, Target } from './ledger.ts'

export type Axis = 'scope' | 'spec' | 'quality'
export type Severity = 'BLOCKER' | 'CRITICAL' | 'WARNING' | 'SUGGESTION'
export type Causality = 'introduced' | 'worsened' | 'pre-existing'
export type Evidence = 'deterministic' | 'inferential'
export interface Finding { axis: Axis; severity: Severity; location: string; claim: string; causality?: Causality; evidence?: Evidence }
export interface AdmittedReview { candidate_hash: string; inspection: { status: 'completed'; paths: string[] }; findings: Finding[] }
export type Admission<T = AdmittedReview> =
  | { kind: 'admitted'; review: T }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'inadmissible'; error: string }
export interface RoundReview {
  candidate_hash: string
  responses: Array<{ id: string; answer: Answer; evidence?: string; note?: string }>
  findings: Finding[]
}
export interface RefutationReview {
  candidate_hash: string
  results: Array<{ id: string; result: RefuteResult; evidence?: string; note?: string }>
}

const AXES: readonly string[] = ['scope', 'spec', 'quality']
const SEVERITIES: readonly string[] = ['BLOCKER', 'CRITICAL', 'WARNING', 'SUGGESTION']
const CAUSALITIES: readonly string[] = ['introduced', 'worsened', 'pre-existing']
const EVIDENCES: readonly string[] = ['deterministic', 'inferential']
const ANSWERS: Record<Target['kind'], readonly string[]> = { verify: ['resolved', 'unresolved'], respond: ['withdrawn', 'maintained'] }
const ALL_ANSWERS: readonly string[] = [...ANSWERS.verify, ...ANSWERS.respond]
const REFUTE_RESULTS: readonly string[] = ['corroborated', 'refuted', 'inconclusive']
export const GRAVE: ReadonlySet<string> = new Set(['BLOCKER', 'CRITICAL'])

class Rejection extends Error {}

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Fin del objeto que abre en `start`, respetando strings; -1 si nunca se cierra. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}' && --depth === 0) {
      return i
    }
  }
  return -1
}

/**
 * Los objetos JSON de la respuesta que traen `candidate_hash`. La prosa alrededor, un bloque de
 * código o una llave suelta en el texto no cuentan: solo lo que parsea y dice a qué candidato responde.
 */
function extractCandidates(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let from = 0
  while (from < text.length) {
    const start = text.indexOf('{', from)
    if (start < 0) break
    const end = closingBrace(text, start)
    const parsed = end < 0 ? undefined : parseOrUndefined(text.slice(start, end + 1))
    if (isMap(parsed) && 'candidate_hash' in parsed) {
      out.push(parsed)
      from = end + 1
    } else {
      from = start + 1
    }
  }
  return out
}

function onlyKeys(map: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(map)) {
    if (!allowed.includes(k)) throw new Rejection(`campo no admitido ${JSON.stringify(k)} en ${where}; los admitidos son ${allowed.join(', ')}`)
  }
}

function oneOf(v: unknown, allowed: readonly string[], field: string): string {
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new Rejection(`${field} inválido ${JSON.stringify(v)}; usa ${allowed.join(' | ')}`)
  }
  return v
}

/** `ruta`, `ruta:línea` o `ruta:inicio-fin`. */
export function parseLocation(location: string): { path: string; lines?: [number, number] } {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(location)
  if (!m) return { path: location }
  const start = Number(m[2])
  return { path: m[1], lines: [start, m[3] === undefined ? start : Number(m[3])] }
}

/** Una cita es válida si apunta a algo que el revisor vio: rangos visibles, el contexto o un binario por su ruta. */
function checkLocation(location: string, c: Candidate): void {
  const { path, lines } = parseLocation(location)
  const file = c.files.find((f) => f.path === path)
  const ctx = c.context.find((x) => x.path === path)
  if (!file && !ctx) throw new Rejection(`la cita ${location} apunta a una ruta que no está en el candidato ni en el contexto`)
  if (file?.binary) {
    if (lines) throw new Rejection(`la cita ${location} pone una línea en un binario; un binario se cita solo con su ruta`)
    return
  }
  if (!lines) throw new Rejection(`la cita ${location} no tiene línea; solo un binario se cita sin línea`)
  const [start, end] = lines
  if (start < 1 || end < start) throw new Rejection(`la cita ${location} no es un rango válido`)
  const visible: Array<[number, number]> = file ? file.visible : [[1, ctx?.lines ?? 0]]
  for (let n = start; n <= end; n++) {
    if (!visible.some(([a, b]) => n >= a && n <= b)) {
      throw new Rejection(`la cita ${location} incluye la línea ${n}, que no se ve en el material de la revisión`)
    }
  }
}

/**
 * Una cita obligatoria: texto no vacío que apunta a algo visible. El error lo recuerda porque el
 * modelo tiende a agregar la explicación después de la cita, y la corrección tiene un solo intento.
 */
function checkEvidence(v: unknown, c: Candidate, where: string): string {
  const hint = 'evidence es solo la cita ruta:línea; la explicación va en note'
  if (typeof v !== 'string' || v.trim() === '') throw new Rejection(`${where} tiene que ser una cita ruta:línea (${hint})`)
  try {
    checkLocation(v, c)
  } catch (e) {
    if (e instanceof Rejection) throw new Rejection(`${where}: ${e.message} (${hint})`)
    throw e
  }
  return v
}

function optionalNote(v: unknown, where: string): { note?: string } {
  if (v === undefined) return {}
  if (typeof v !== 'string') throw new Rejection(`${where} tiene que ser texto`)
  return { note: v }
}

function checkFinding(raw: unknown, i: number, c: Candidate): Finding {
  const where = `findings[${i}]`
  if (!isMap(raw)) throw new Rejection(`${where} tiene que ser un objeto`)
  onlyKeys(raw, ['axis', 'severity', 'location', 'claim', 'causality', 'evidence'], where)
  const axis = oneOf(raw.axis, AXES, `${where}.axis`) as Axis
  const severity = oneOf(raw.severity, SEVERITIES, `${where}.severity`) as Severity
  if (typeof raw.location !== 'string' || raw.location.trim() === '') throw new Rejection(`${where}.location tiene que ser una cita ruta:línea`)
  if (typeof raw.claim !== 'string' || raw.claim.trim() === '') throw new Rejection(`${where}.claim no puede estar vacío`)
  const f: Finding = { axis, severity, location: raw.location, claim: raw.claim }
  if (raw.causality !== undefined) f.causality = oneOf(raw.causality, CAUSALITIES, `${where}.causality`) as Causality
  if (raw.evidence !== undefined) f.evidence = oneOf(raw.evidence, EVIDENCES, `${where}.evidence`) as Evidence
  if (GRAVE.has(severity) && f.causality === undefined) {
    throw new Rejection(`${where} es ${severity} y no declara causality (introduced | worsened | pre-existing)`)
  }
  if (GRAVE.has(severity) && f.evidence === undefined) {
    throw new Rejection(`${where} es ${severity} y no declara evidence (deterministic | inferential)`)
  }
  checkLocation(f.location, c)
  return f
}

function checkHash(raw: Record<string, unknown>, c: Candidate): void {
  if (raw.candidate_hash !== c.hash) throw new Rejection(`candidate_hash no coincide: se esperaba ${c.hash}`)
}

/** La cobertura de la inspección: todas las rutas cambiadas, una vez; o el motivo de no haber podido. */
function checkInspection(raw: Record<string, unknown>, c: Candidate): { paths: string[] } | { reason: string } {
  const insp = raw.inspection
  if (!isMap(insp)) throw new Rejection('falta inspection')
  onlyKeys(insp, ['status', 'paths', 'reason'], 'inspection')
  const status = oneOf(insp.status, ['completed', 'unavailable'], 'inspection.status')
  if (status === 'unavailable') {
    if (typeof insp.reason !== 'string' || insp.reason.trim() === '') {
      throw new Rejection('inspection.status es unavailable y falta inspection.reason')
    }
    return { reason: insp.reason }
  }
  if (!Array.isArray(insp.paths) || insp.paths.some((p) => typeof p !== 'string')) {
    throw new Rejection('inspection.paths tiene que ser una lista de rutas')
  }
  const paths = insp.paths as string[]
  const expected = c.files.map((f) => f.path)
  const repeated = paths.filter((p, i) => paths.indexOf(p) !== i)
  if (repeated.length > 0) throw new Rejection(`inspection.paths tiene rutas repetidas: ${[...new Set(repeated)].join(', ')}`)
  const missing = expected.filter((p) => !paths.includes(p))
  if (missing.length > 0) throw new Rejection(`faltan rutas en inspection.paths: ${missing.join(', ')}`)
  const extra = paths.filter((p) => !expected.includes(p))
  if (extra.length > 0) throw new Rejection(`inspection.paths trae rutas que no son del candidato: ${extra.join(', ')}`)
  return { paths }
}

function check(raw: Record<string, unknown>, c: Candidate): Admission {
  onlyKeys(raw, ['candidate_hash', 'inspection', 'findings'], 'la respuesta')
  checkHash(raw, c)
  const insp = checkInspection(raw, c)
  if ('reason' in insp) return { kind: 'unavailable', reason: insp.reason }
  if (!Array.isArray(raw.findings)) throw new Rejection('findings tiene que ser una lista')
  const findings = raw.findings.map((f, i) => checkFinding(f, i, c))
  return { kind: 'admitted', review: { candidate_hash: c.hash, inspection: { status: 'completed', paths: insp.paths }, findings } }
}

/** Una respuesta solo se admite si trae exactamente un objeto con `candidate_hash` y ese objeto pasa `check`. */
function admitWith<T>(text: string, validate: (raw: Record<string, unknown>) => Admission<T>): Admission<T> {
  const found = extractCandidates(text)
  if (found.length !== 1) {
    return { kind: 'inadmissible', error: `se esperaba exactamente un objeto JSON con candidate_hash y hay ${found.length}` }
  }
  try {
    return validate(found[0])
  } catch (e) {
    if (e instanceof Rejection) return { kind: 'inadmissible', error: e.message }
    throw e
  }
}

/** Admite la respuesta del revisor solo si responde a este candidato y cada cita apunta a algo que vio. */
export function admit(text: string, c: Candidate): Admission {
  return admitWith(text, (raw) => check(raw, c))
}

/** Una respuesta por cada hallazgo de la ronda, del tipo que le corresponde. */
function checkResponses(raw: unknown, c: Candidate, plan: RoundPlan): RoundReview['responses'] {
  if (!Array.isArray(raw)) throw new Rejection('responses tiene que ser una lista')
  const seen = new Set<string>()
  const out = raw.map((r, i) => {
    const where = `responses[${i}]`
    if (!isMap(r)) throw new Rejection(`${where} tiene que ser un objeto`)
    onlyKeys(r, ['id', 'answer', 'evidence', 'note'], where)
    const target = plan.targets.find((t) => t.id === r.id)
    if (!target) throw new Rejection(`${where}.id ${JSON.stringify(r.id)} no está en VERIFICAR ni en RESPONDER`)
    if (seen.has(target.id)) throw new Rejection(`${target.id} está repetido en responses`)
    seen.add(target.id)
    const answer = oneOf(r.answer, ALL_ANSWERS, `${where}.answer`) as Answer
    if (!ANSWERS[target.kind].includes(answer)) {
      const block = target.kind === 'verify' ? 'VERIFICAR' : 'RESPONDER'
      throw new Rejection(`${target.id} está en ${block} y se contesta ${ANSWERS[target.kind].join(' | ')}, no ${answer}`)
    }
    if ((answer === 'unresolved' || answer === 'maintained') && r.evidence === undefined) {
      throw new Rejection(`${target.id} es ${answer} y no trae evidence con una cita`)
    }
    return {
      id: target.id, answer,
      ...(r.evidence !== undefined ? { evidence: checkEvidence(r.evidence, c, `${where}.evidence`) } : {}),
      ...optionalNote(r.note, `${where}.note`),
    }
  })
  const missing = plan.targets.filter((t) => !seen.has(t.id)).map((t) => t.id)
  if (missing.length > 0) throw new Rejection(`faltan respuestas para ${missing.join(', ')}`)
  return out
}

/** Un hallazgo nuevo de la ronda N solo puede ser una regresión: tiene que caer en lo que cambió. */
function checkRegression(f: Finding, plan: RoundPlan): void {
  if (plan.identical) {
    throw new Rejection(`el candidato es idéntico al de la ronda anterior y no admite hallazgos nuevos: ${f.location}`)
  }
  const { path, lines } = parseLocation(f.location)
  const changed = Object.hasOwn(plan.changed, path) ? plan.changed[path] : undefined
  if (!changed) throw new Rejection(`la cita ${f.location} está en una ruta que no cambió desde la ronda anterior`)
  if (changed === 'binary' || !lines) return
  for (let n = lines[0]; n <= lines[1]; n++) {
    if (!changed.some(([a, b]) => n >= a && n <= b)) {
      throw new Rejection(`la cita ${f.location} incluye la línea ${n}, que no cambió desde la ronda anterior`)
    }
  }
}

/** Admite la ronda N: respuestas por ID y, como hallazgos nuevos, solo regresiones de la corrección. */
export function admitRound(text: string, c: Candidate, plan: RoundPlan): Admission<RoundReview> {
  return admitWith(text, (raw) => {
    onlyKeys(raw, ['candidate_hash', 'inspection', 'responses', 'findings'], 'la respuesta')
    checkHash(raw, c)
    const insp = checkInspection(raw, c)
    if ('reason' in insp) return { kind: 'unavailable', reason: insp.reason }
    const responses = checkResponses(raw.responses, c, plan)
    if (!Array.isArray(raw.findings)) throw new Rejection('findings tiene que ser una lista')
    const findings = raw.findings.map((f, i) => {
      const finding = checkFinding(f, i, c)
      checkRegression(finding, plan)
      return finding
    })
    return { kind: 'admitted', review: { candidate_hash: c.hash, responses, findings } }
  })
}

/** Admite al refutador: un resultado por ID de la tanda, cada uno con su cita. */
export function admitRefutation(text: string, c: Candidate, ids: string[]): Admission<RefutationReview> {
  return admitWith(text, (raw) => {
    onlyKeys(raw, ['candidate_hash', 'results'], 'la respuesta')
    checkHash(raw, c)
    if (!Array.isArray(raw.results)) throw new Rejection('results tiene que ser una lista')
    const seen = new Set<string>()
    const results = raw.results.map((r, i) => {
      const where = `results[${i}]`
      if (!isMap(r)) throw new Rejection(`${where} tiene que ser un objeto`)
      onlyKeys(r, ['id', 'result', 'evidence', 'note'], where)
      if (typeof r.id !== 'string' || !ids.includes(r.id)) throw new Rejection(`${where}.id ${JSON.stringify(r.id)} no está en la TANDA`)
      if (seen.has(r.id)) throw new Rejection(`${r.id} está repetido en results`)
      seen.add(r.id)
      const result = oneOf(r.result, REFUTE_RESULTS, `${where}.result`) as RefuteResult
      if (r.evidence === undefined) throw new Rejection(`${r.id} no trae evidence con una cita`)
      return { id: r.id, result, evidence: checkEvidence(r.evidence, c, `${where}.evidence`), ...optionalNote(r.note, `${where}.note`) }
    })
    const missing = ids.filter((id) => !seen.has(id))
    if (missing.length > 0) throw new Rejection(`faltan resultados para ${missing.join(', ')}`)
    return { kind: 'admitted', review: { candidate_hash: c.hash, results } }
  })
}
