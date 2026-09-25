import type { Candidate } from './candidate.ts'

export type Axis = 'scope' | 'spec' | 'quality'
export type Severity = 'BLOCKER' | 'CRITICAL' | 'WARNING' | 'SUGGESTION'
export type Causality = 'introduced' | 'worsened' | 'pre-existing'
export interface Finding { axis: Axis; severity: Severity; location: string; claim: string; causality?: Causality }
export interface AdmittedReview { candidate_hash: string; inspection: { status: 'completed'; paths: string[] }; findings: Finding[] }
export type Admission =
  | { kind: 'admitted'; review: AdmittedReview }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'inadmissible'; error: string }
export interface Verdict {
  scope: 'ok' | 'fail'; spec: 'ok' | 'warn' | 'fail'; quality: 'ok' | 'fail'
  findings: Finding[]; out_of_scope: Finding[]
}

const AXES: readonly string[] = ['scope', 'spec', 'quality']
const SEVERITIES: readonly string[] = ['BLOCKER', 'CRITICAL', 'WARNING', 'SUGGESTION']
const CAUSALITIES: readonly string[] = ['introduced', 'worsened', 'pre-existing']
const GRAVE: ReadonlySet<string> = new Set(['BLOCKER', 'CRITICAL'])

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

/** Una cita es válida si apunta a algo que el revisor vio: rangos visibles, el contexto o un binario por su ruta. */
function checkLocation(location: string, c: Candidate): void {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(location)
  const path = m ? m[1] : location
  const file = c.files.find((f) => f.path === path)
  const ctx = c.context.find((x) => x.path === path)
  if (!file && !ctx) throw new Rejection(`la cita ${location} apunta a una ruta que no está en el candidato ni en el contexto`)
  if (file?.binary) {
    if (m) throw new Rejection(`la cita ${location} pone una línea en un binario; un binario se cita solo con su ruta`)
    return
  }
  if (!m) throw new Rejection(`la cita ${location} no tiene línea; solo un binario se cita sin línea`)
  const start = Number(m[2])
  const end = m[3] === undefined ? start : Number(m[3])
  if (start < 1 || end < start) throw new Rejection(`la cita ${location} no es un rango válido`)
  const visible: Array<[number, number]> = file ? file.visible : [[1, ctx?.lines ?? 0]]
  for (let n = start; n <= end; n++) {
    if (!visible.some(([a, b]) => n >= a && n <= b)) {
      throw new Rejection(`la cita ${location} incluye la línea ${n}, que no se ve en el material de la revisión`)
    }
  }
}

function checkFinding(raw: unknown, i: number, c: Candidate): Finding {
  const where = `findings[${i}]`
  if (!isMap(raw)) throw new Rejection(`${where} tiene que ser un objeto`)
  onlyKeys(raw, ['axis', 'severity', 'location', 'claim', 'causality'], where)
  const axis = oneOf(raw.axis, AXES, `${where}.axis`) as Axis
  const severity = oneOf(raw.severity, SEVERITIES, `${where}.severity`) as Severity
  if (typeof raw.location !== 'string' || raw.location.trim() === '') throw new Rejection(`${where}.location tiene que ser una cita ruta:línea`)
  if (typeof raw.claim !== 'string' || raw.claim.trim() === '') throw new Rejection(`${where}.claim no puede estar vacío`)
  const f: Finding = { axis, severity, location: raw.location, claim: raw.claim }
  if (raw.causality !== undefined) f.causality = oneOf(raw.causality, CAUSALITIES, `${where}.causality`) as Causality
  if (GRAVE.has(severity) && f.causality === undefined) {
    throw new Rejection(`${where} es ${severity} y no declara causality (introduced | worsened | pre-existing)`)
  }
  checkLocation(f.location, c)
  return f
}

function check(raw: Record<string, unknown>, c: Candidate): Admission {
  onlyKeys(raw, ['candidate_hash', 'inspection', 'findings'], 'la respuesta')
  if (raw.candidate_hash !== c.hash) throw new Rejection(`candidate_hash no coincide: se esperaba ${c.hash}`)
  const insp = raw.inspection
  if (!isMap(insp)) throw new Rejection('falta inspection')
  onlyKeys(insp, ['status', 'paths', 'reason'], 'inspection')
  const status = oneOf(insp.status, ['completed', 'unavailable'], 'inspection.status')
  if (status === 'unavailable') {
    if (typeof insp.reason !== 'string' || insp.reason.trim() === '') {
      throw new Rejection('inspection.status es unavailable y falta inspection.reason')
    }
    return { kind: 'unavailable', reason: insp.reason }
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
  if (!Array.isArray(raw.findings)) throw new Rejection('findings tiene que ser una lista')
  const findings = raw.findings.map((f, i) => checkFinding(f, i, c))
  return { kind: 'admitted', review: { candidate_hash: c.hash, inspection: { status: 'completed', paths }, findings } }
}

/** Admite la respuesta del revisor solo si responde a este candidato y cada cita apunta a algo que vio. */
export function admit(text: string, c: Candidate): Admission {
  const found = extractCandidates(text)
  if (found.length !== 1) {
    return { kind: 'inadmissible', error: `se esperaba exactamente un objeto JSON con candidate_hash y hay ${found.length}` }
  }
  try {
    return check(found[0], c)
  } catch (e) {
    if (e instanceof Rejection) return { kind: 'inadmissible', error: e.message }
    throw e
  }
}

/**
 * El resultado de cada eje sale de los hallazgos: falla con un grave que el cambio introdujo o
 * empeoró. Lo que ya estaba antes se informa aparte y no hace fallar nada.
 */
export function verdict(findings: Finding[]): Verdict {
  const outOfScope = findings.filter((f) => GRAVE.has(f.severity) && f.causality === 'pre-existing')
  const kept = findings.filter((f) => !outOfScope.includes(f))
  const fails = (axis: Axis) => kept.some((f) => f.axis === axis && GRAVE.has(f.severity))
  let spec: Verdict['spec'] = 'ok'
  if (fails('spec')) spec = 'fail'
  else if (kept.some((f) => f.axis === 'spec' && f.severity === 'WARNING')) spec = 'warn'
  return {
    scope: fails('scope') ? 'fail' : 'ok',
    spec,
    quality: fails('quality') ? 'fail' : 'ok',
    findings: kept,
    out_of_scope: outOfScope,
  }
}
