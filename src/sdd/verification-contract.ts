import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Rejection } from '../review/admit.ts'
import { readHeader, section } from './markdown.ts'

// El contrato de verificación de un plan: filas tipadas que el binario puede releer y ejecutar. El worker
// de `plan` lo entrega como JSON, la admisión lo valida contra los criterios de la spec y `plan.md` lo
// guarda en un bloque cercado dentro de `## Verification`.

export type RowKind = 'test' | 'build' | 'inspection' | 'manual'
export type Obligation = 'red_on_revert' | 'green_on_base' | 'none'
/** `output_pattern` es el `source` de una RegExp de JavaScript, sin flags. */
export interface Expect { exit_code: number; output_pattern?: string }
export interface RowBase { id: string; acs: string[]; kind: RowKind; obligation: Obligation; obligation_reason?: string }
export interface CommandRow extends RowBase { kind: 'build' | 'inspection'; argv: string[]; timeout_ms: number; expect: Expect }
export interface TestRow extends RowBase {
  kind: 'test'; argv: string[]; timeout_ms: number; expect: Expect
  implementation_paths: string[]; test_paths: string[]; test_name: string; report_format: 'tap'
}
export interface ManualRow extends RowBase { kind: 'manual'; observation: string }
export type VerificationRow = CommandRow | TestRow | ManualRow
export type ExecutableRow = CommandRow | TestRow
export interface VerificationContract { schema_version: 1; rows: VerificationRow[] }

/** La cerca que marca el bloque del contrato en `## Verification`; su versión cambia con el esquema. */
export const VERIFICATION_FENCE = 'sdd-ai-verification-v1'

const ROW_ID = /^V\d+$/
const OPTIONAL = ['obligation_reason', 'output_pattern']

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonempty = (v: unknown, where: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Rejection(`${where} tiene que ser texto no vacío`)
  return v
}
/** Sin claves de más y con todas las obligatorias; las de `OPTIONAL` pueden faltar. */
const keys = (v: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Rejection(`clave no admitida ${JSON.stringify(key)} en ${where}`)
  for (const key of allowed) if (!(key in v) && !OPTIONAL.includes(key)) throw new Rejection(`falta el campo obligatorio ${key} en ${where}`)
}
const strings = (v: unknown, where: string): string[] => {
  if (!Array.isArray(v) || v.length === 0) throw new Rejection(`${where} tiene que ser una lista no vacía`)
  return v.map((x, i) => nonempty(x, `${where}[${i}]`))
}
/**
 * Rutas relativas a la raíz del repo, ni absolutas ni con un segmento `..`, y en su forma normal: sin `./`,
 * `//` ni barra final. Así dos filas no nombran el mismo archivo con dos textos distintos.
 */
const pathList = (v: unknown, where: string): string[] => strings(v, where).map((p) => {
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..')) throw new Rejection(`${where} contiene una ruta exterior: ${JSON.stringify(p)}`)
  if (p.includes('\\') || posix.normalize(p) !== p || p.endsWith('/')) throw new Rejection(`${where} tiene una ruta sin normalizar: ${JSON.stringify(p)}`)
  return p
})
const integer = (v: unknown, where: string, o: { positive?: boolean } = {}): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || (o.positive && v <= 0)) {
    throw new Rejection(`${where} tiene que ser un entero${o.positive ? ' positivo' : ''}`)
  }
  return v
}
/** El tope de un temporizador de Node: por encima, `setTimeout` lo reduce a 1 ms y la fila vencería apenas lanzada. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1
const timeout = (v: unknown, where: string): number => {
  const ms = integer(v, where, { positive: true })
  if (ms > MAX_TIMEOUT_MS) throw new Rejection(`${where} no puede pasar de ${MAX_TIMEOUT_MS}`)
  return ms
}
const expect = (v: unknown, where: string): Expect => {
  if (!isMap(v)) throw new Rejection(`${where} tiene que ser un objeto`)
  keys(v, ['exit_code', 'output_pattern'], where)
  const exit_code = integer(v.exit_code, `${where}.exit_code`)
  if (v.output_pattern === undefined) return { exit_code }
  const output_pattern = nonempty(v.output_pattern, `${where}.output_pattern`)
  try {
    new RegExp(output_pattern)
  } catch {
    throw new Rejection(`${where}.output_pattern no compila como RegExp`)
  }
  return { exit_code, output_pattern }
}

/**
 * El contrato admitido, o un `Rejection` con la primera causa. Cada fila tiene un id `V<n>` único y cita
 * criterios de `acs`, y cada criterio de `acs` tiene al menos una fila. Los campos obligatorios dependen del
 * tipo de fila; la obligación de confirmar solo cabe en una fila `test`. La pertinencia de cada fila, si su
 * esperado discrimina el requisito, no se puede comprobar acá: la revisa una persona en el gate del plan.
 */
export function admitVerification(raw: unknown, acs: readonly string[]): VerificationContract {
  if (!isMap(raw)) throw new Rejection('verification tiene que ser un objeto')
  keys(raw, ['schema_version', 'rows'], 'verification')
  if (raw.schema_version !== 1) throw new Rejection('verification.schema_version tiene que ser 1')
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) throw new Rejection('verification.rows tiene que ser una lista no vacía')
  const seen = new Set<string>()
  const covered = new Set<string>()
  const rows = raw.rows.map((rawRow, index): VerificationRow => {
    const where = `verification.rows[${index}]`
    if (!isMap(rawRow)) throw new Rejection(`${where} tiene que ser un objeto`)
    const kind = rawRow.kind
    if (kind === 'inspección') throw new Rejection(`${where}.kind: «inspección» se llama ahora «inspection»`)
    const common = ['id', 'acs', 'kind', 'obligation', 'obligation_reason']
    const permitted = kind === 'test' ? [...common, 'argv', 'timeout_ms', 'expect', 'implementation_paths', 'test_paths', 'test_name', 'report_format']
      : kind === 'build' || kind === 'inspection' ? [...common, 'argv', 'timeout_ms', 'expect']
        : kind === 'manual' ? [...common, 'observation'] : null
    if (!permitted) throw new Rejection(`${where}.kind tiene que ser test, build, inspection o manual`)
    keys(rawRow, permitted, where)
    const id = nonempty(rawRow.id, `${where}.id`)
    if (!ROW_ID.test(id)) throw new Rejection(`${where}.id tiene que tener la forma V<n>: ${JSON.stringify(id)}`)
    if (seen.has(id)) throw new Rejection(`${where}.id repite ${id}`)
    seen.add(id)
    const rowAcs = strings(rawRow.acs, `${where}.acs`)
    for (const ac of rowAcs) {
      if (!acs.includes(ac)) throw new Rejection(`${where}.acs cita ${ac}, que no es un criterio de la spec`)
      covered.add(ac)
    }
    const obligation = rawRow.obligation
    if (obligation !== 'red_on_revert' && obligation !== 'green_on_base' && obligation !== 'none') {
      throw new Rejection(`${where}.obligation tiene que ser red_on_revert, green_on_base o none`)
    }
    const reason = rawRow.obligation_reason === undefined ? undefined : nonempty(rawRow.obligation_reason, `${where}.obligation_reason`)
    if (obligation === 'none' && reason === undefined) throw new Rejection(`${where}.obligation_reason es obligatorio con none`)
    const head: Omit<RowBase, 'kind'> = { id, acs: rowAcs, obligation, ...(reason === undefined ? {} : { obligation_reason: reason }) }
    if (kind === 'manual') {
      if (obligation !== 'none') throw new Rejection(`${where}: una fila manual solo admite la obligación none`)
      return { ...head, kind, observation: nonempty(rawRow.observation, `${where}.observation`) }
    }
    if (obligation !== 'none' && kind !== 'test') throw new Rejection(`${where}: ${obligation} solo cabe en una fila test`)
    const run = {
      argv: strings(rawRow.argv, `${where}.argv`),
      timeout_ms: timeout(rawRow.timeout_ms, `${where}.timeout_ms`),
      expect: expect(rawRow.expect, `${where}.expect`),
    }
    if (kind !== 'test') return { ...head, kind: kind as CommandRow['kind'], ...run }
    if (rawRow.report_format !== 'tap') throw new Rejection(`${where}.report_format tiene que ser tap: es el único formato admitido`)
    return {
      ...head, kind, ...run,
      implementation_paths: pathList(rawRow.implementation_paths, `${where}.implementation_paths`),
      test_paths: pathList(rawRow.test_paths, `${where}.test_paths`),
      test_name: nonempty(rawRow.test_name, `${where}.test_name`),
      report_format: 'tap',
    }
  })
  for (const ac of acs) if (!covered.has(ac)) throw new Rejection(`el criterio ${ac} de la spec no lo cubre ninguna fila`)
  return { schema_version: 1, rows }
}

/** Claves ordenadas en todos los niveles: el mismo contrato se escribe siempre con los mismos bytes. */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : isMap(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value

/** El bloque cercado que va en `## Verification`, con JSON canónico. */
export function renderVerification(contract: VerificationContract): string {
  return `\`\`\`${VERIFICATION_FENCE}\n${JSON.stringify(canonical(contract), null, 2)}\n\`\`\``
}

const BLOCK = new RegExp(`^\`\`\`${VERIFICATION_FENCE}[ \\t]*\\n([\\s\\S]*?)\\n\`\`\`[ \\t]*$`, 'm')
/** Las aperturas del bloque: el marcador dentro del JSON, por ejemplo en una observación, no abre otro. */
const OPENING = new RegExp(`^\`\`\`${VERIFICATION_FENCE}[ \\t]*$`, 'gm')

/**
 * El contrato de `## Verification` de un plan, admitido de nuevo contra `acs`, o `prose` si la sección no
 * trae el marcador: un plan anterior o uno que escribió `sdd-flow`. Un marcador presente con un bloque que no
 * se lee, repetido o con un contrato que no se admite es un `Rejection`, nunca prosa.
 */
export function readVerification(planText: string, acs: readonly string[]):
  { kind: 'structured'; contract: VerificationContract } | { kind: 'prose' } {
  const header = readHeader(planText)
  const content = section(header.ok ? header.body : planText, 'Verification')
  if (content === null || !content.includes(VERIFICATION_FENCE)) return { kind: 'prose' }
  if ((content.match(OPENING) ?? []).length > 1) throw new Rejection(`la sección trae más de un bloque ${VERIFICATION_FENCE}: el contrato es uno solo`)
  const match = BLOCK.exec(content)
  if (!match) throw new Rejection(`el marcador ${VERIFICATION_FENCE} no abre un bloque cercado válido`)
  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch (e) {
    throw new Rejection(`el bloque ${VERIFICATION_FENCE} no es JSON: ${(e as Error).message}`)
  }
  return { kind: 'structured', contract: admitVerification(raw, acs) }
}

/** Si el plan armado relee exactamente el contrato que se publicó. */
export function roundTrips(plan: string, contract: VerificationContract, acs: readonly string[]): boolean {
  const read = readVerification(plan, acs)
  return read.kind === 'structured' && isDeepStrictEqual(read.contract, contract)
}
