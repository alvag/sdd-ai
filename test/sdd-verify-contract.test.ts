import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rejection } from '../src/review/admit.ts'
import { section } from '../src/sdd/markdown.ts'
import { admitPlan, renderPlan, type PlanHeader } from '../src/sdd/phase.ts'
import {
  VERIFICATION_FENCE, admitVerification, readVerification, renderVerification, roundTrips, type VerificationContract,
} from '../src/sdd/verification-contract.ts'

const ACS = ['AC-1', 'AC-2', 'AC-3', 'AC-4']
const TEST_ROW = {
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert',
  argv: ['node', '--test', '--test-reporter=tap', 'test/export.test.ts'], timeout_ms: 120000,
  expect: { exit_code: 0, output_pattern: '# pass \\d+' },
  implementation_paths: ['src/export.ts'], test_paths: ['test/export.test.ts'], test_name: 'exporta a CSV', report_format: 'tap',
}
const BUILD_ROW = { id: 'V2', acs: ['AC-2'], kind: 'build', obligation: 'none', obligation_reason: 'no hay seam', argv: ['npm', 'run', 'typecheck'], timeout_ms: 300000, expect: { exit_code: 0 } }
const INSPECTION_ROW = { id: 'V3', acs: ['AC-3'], kind: 'inspección', obligation: 'none', obligation_reason: 'lectura', argv: ['grep', '-c', 'x', 'README.md'], timeout_ms: 1000, expect: { exit_code: 0 } }
const MANUAL_ROW = { id: 'V4', acs: ['AC-4'], kind: 'manual', obligation: 'none', obligation_reason: 'es visual', observation: 'el CSV abre en una planilla' }
const RAW = { schema_version: 1, rows: [TEST_ROW, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }

const rejection = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof Rejection) return e.message
    throw e
  }
  assert.fail('se esperaba un rechazo')
}

test('la admisión conserva los cuatro tipos de fila con sus campos', () => {
  const c = admitVerification(RAW, ACS)
  assert.deepEqual(c, RAW)
})

test('la admisión rechaza cada fila incompleta o incompatible con su tipo', () => {
  const withRow = (row: Record<string, unknown>) => ({ schema_version: 1, rows: [row, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] })
  const { obligation: _o, ...noObligation } = TEST_ROW
  const { obligation_reason: _r, ...noReason } = BUILD_ROW
  const { timeout_ms: _t, ...noTimeout } = BUILD_ROW
  const { test_name: _n, ...noTestName } = TEST_ROW
  const { observation: _obs, ...noObservation } = MANUAL_ROW
  const cases: Array<[string, unknown, RegExp]> = [
    ['sin obligación', withRow(noObligation), /falta el campo obligatorio obligation/],
    ['none sin motivo', { ...RAW, rows: [TEST_ROW, noReason, INSPECTION_ROW, MANUAL_ROW] }, /obligation_reason es obligatorio con none/],
    ['obligación de test en build', { ...RAW, rows: [TEST_ROW, { ...BUILD_ROW, obligation: 'red_on_revert' }, INSPECTION_ROW, MANUAL_ROW] }, /solo cabe en una fila test/],
    ['green_on_base en manual', { ...RAW, rows: [TEST_ROW, BUILD_ROW, INSPECTION_ROW, { ...MANUAL_ROW, obligation: 'green_on_base' }] }, /manual solo admite la obligación none/],
    ['ejecutable sin timeout', { ...RAW, rows: [TEST_ROW, noTimeout, INSPECTION_ROW, MANUAL_ROW] }, /falta el campo obligatorio timeout_ms/],
    ['timeout no positivo', withRow({ ...TEST_ROW, timeout_ms: 0 }), /timeout_ms tiene que ser un entero positivo/],
    // Node reduce a 1 ms un temporizador por encima de 2^31 - 1: la fila vencería apenas lanzada.
    ['timeout mayor que el del temporizador', withRow({ ...TEST_ROW, timeout_ms: 2 ** 31 }), /timeout_ms no puede pasar de 2147483647/],
    ['test sin nombre', withRow(noTestName), /falta el campo obligatorio test_name/],
    ['manual sin observación', { ...RAW, rows: [TEST_ROW, BUILD_ROW, INSPECTION_ROW, noObservation] }, /falta el campo obligatorio observation/],
    ['manual con comando', { ...RAW, rows: [TEST_ROW, BUILD_ROW, INSPECTION_ROW, { ...MANUAL_ROW, argv: ['x'] }] }, /clave no admitida "argv"/],
    ['tipo desconocido', withRow({ ...TEST_ROW, kind: 'lint' }), /kind tiene que ser/],
  ]
  for (const [name, raw, cause] of cases) assert.match(rejection(() => admitVerification(raw, ACS)), cause, name)
})

test('la admisión exige cobertura exacta, ids V<n> únicos, rutas del repo y TAP', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['id duplicado', { ...RAW, rows: [TEST_ROW, { ...BUILD_ROW, id: 'V1' }, INSPECTION_ROW, MANUAL_ROW] }, /repite V1/],
    ['id sin forma', { ...RAW, rows: [{ ...TEST_ROW, id: 'T1' }, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }, /forma V<n>/],
    ['AC inexistente', { ...RAW, rows: [{ ...TEST_ROW, acs: ['AC-9'] }, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }, /cita AC-9/],
    ['AC sin fila', { ...RAW, rows: [TEST_ROW, BUILD_ROW, INSPECTION_ROW] }, /AC-4 de la spec no lo cubre/],
    ['campo obligatorio ausente', { ...RAW, rows: [{ ...TEST_ROW, argv: [] }, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }, /argv tiene que ser una lista no vacía/],
    ['ruta absoluta', { ...RAW, rows: [{ ...TEST_ROW, implementation_paths: ['/etc/passwd'] }, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }, /ruta exterior/],
    ['ruta con ..', { ...RAW, rows: [{ ...TEST_ROW, test_paths: ['test/../../x.ts'] }, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }, /ruta exterior/],
    ['formato no admitido', { ...RAW, rows: [{ ...TEST_ROW, report_format: 'junit' }, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }, /report_format tiene que ser tap/],
    ['patrón que no compila', { ...RAW, rows: [{ ...TEST_ROW, expect: { exit_code: 0, output_pattern: '(' } }, BUILD_ROW, INSPECTION_ROW, MANUAL_ROW] }, /no compila como RegExp/],
    ['sin filas', { schema_version: 1, rows: [] }, /rows tiene que ser una lista no vacía/],
  ]
  for (const [name, raw, cause] of cases) assert.match(rejection(() => admitVerification(raw, ACS)), cause, name)
})

const HEADER: PlanHeader = {
  id: 'f', branch: 'feature/f', base_commit: 'a'.repeat(40), change_type: 'feat', profundidad: 'completa', risk: 'low',
  status: 'planned', created_at: '2026-09-29T09:00:00-05:00',
}

test('el plan publica el contrato en un bloque que se relee campo por campo', () => {
  const contract = admitVerification(RAW, ACS)
  const plan = renderPlan({
    phase: 'plan', assumptions: [], blocking_questions: [], missing_context: [],
    approach: 'Uno.', decisions: 'ninguno', files: '- `src/export.ts`', verification: contract,
  }, HEADER, ACS)
  assert.match((section(plan, 'Verification') ?? '').trim(), new RegExp(`^\`\`\`${VERIFICATION_FENCE}\\n`))
  const read = readVerification(plan, ACS)
  assert.equal(read.kind, 'structured')
  if (read.kind === 'structured') assert.deepEqual(read.contract, contract)
  assert.ok(roundTrips(plan, contract, ACS))
  // El JSON es canónico: el mismo contrato con otro orden de claves se escribe con los mismos bytes.
  const shuffled = { rows: contract.rows.map((r) => Object.fromEntries(Object.entries(r).reverse())), schema_version: 1 } as VerificationContract
  assert.equal(renderVerification(shuffled), renderVerification(contract))
})

test('un plan sin marcador es prosa y un marcador roto es un error, nunca prosa', () => {
  const prose = '---\nid: f\n---\n\n# Plan\n\n## Verification\n\n| AC-1 | test | `npm test` | verde |\n'
  assert.deepEqual(readVerification(prose, ACS), { kind: 'prose' })
  assert.deepEqual(readVerification('# Plan\n\n## Enfoque\n\nUno.\n', ACS), { kind: 'prose' })
  const broken = `# Plan\n\n## Verification\n\n\`\`\`${VERIFICATION_FENCE}\n{ no es json }\n\`\`\`\n`
  assert.match(rejection(() => readVerification(broken, ACS)), /no es JSON/)
  const unclosed = `# Plan\n\n## Verification\n\nver ${VERIFICATION_FENCE} más abajo\n`
  assert.match(rejection(() => readVerification(unclosed, ACS)), /no abre un bloque cercado válido/)
  // Un bloque que ya no se admite contra los criterios de hoy tampoco es prosa.
  const stale = `# Plan\n\n## Verification\n\n${renderVerification(admitVerification(RAW, ACS))}\n`
  assert.match(rejection(() => readVerification(stale, ['AC-1'])), /cita AC-2/)
  // Dos bloques en la sección son dos contratos aparentes: ninguno se elige en silencio.
  const block = renderVerification(admitVerification(RAW, ACS))
  const twice = `# Plan\n\n## Verification\n\n${block}\n\n${block}\n`
  assert.match(rejection(() => readVerification(twice, ACS)), /más de un bloque/)
  // El marcador dentro del JSON de un bloque no es otro bloque.
  const quoted = admitVerification({ ...RAW, rows: [TEST_ROW, BUILD_ROW, INSPECTION_ROW, { ...MANUAL_ROW, observation: `cita ${VERIFICATION_FENCE}` }] }, ACS)
  const plan = `# Plan\n\n## Verification\n\n${renderVerification(quoted)}\n`
  assert.deepEqual(readVerification(plan, ACS), { kind: 'structured', contract: quoted })
})

test('la admisión de plan valida el contrato contra los criterios congelados de la spec', () => {
  const plan = {
    phase: 'plan', assumptions: [], blocking_questions: [], missing_context: [],
    approach: 'Uno.', decisions: 'ninguno', files: '- `src/export.ts`', verification: RAW,
  }
  assert.equal(admitPlan(JSON.stringify(plan), ACS).kind, 'admitted')
  const a = admitPlan(JSON.stringify(plan), ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'])
  assert.equal(a.kind, 'inadmissible')
  if (a.kind === 'inadmissible') assert.match(a.error, /AC-5 de la spec no lo cubre/)
  const prose = admitPlan(JSON.stringify({ ...plan, verification: '| AC-1 | test | x | y |' }), ACS)
  assert.equal(prose.kind, 'inadmissible')
})
