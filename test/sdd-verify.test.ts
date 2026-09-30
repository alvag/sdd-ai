import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freeze } from '../src/review/candidate.ts'
import { candidateFingerprint, harvestTreeWithout } from '../src/git.ts'
import { PHASES_FILE, appendAttestationRef, appendReceiptRef, latestFinalReceipt, readPhaseRecord, withFlowLock, withPhaseNext } from '../src/sdd/phase-state.ts'
import {
  type Attestation, type VerifyReceipt, currentAttestation, fileSha256, newReceiptId, readAttestation, readVerifyReceipt, receiptDir,
  writeAttestation, writeVerifyReceipt,
} from '../src/sdd/verify-receipt.ts'
import { closeRestoreIntent, prepareIntent, restoreIntentOpen, revertPaths, writeRestoreIntent } from '../src/sdd/restore.ts'
import { proposeClass } from '../src/sdd/chain.ts'
import { attestRow, confirmationOutcome, evaluateRow, excerpt, executeRows, parseTap, patternMatches, prepareVerify, runBaseline, runFinal } from '../src/sdd/verify.ts'
import { type Question, attestQuestion } from '../src/approval/question.ts'
import { prove } from '../src/approval/proof.ts'
import { randomUUID } from 'node:crypto'
import { type CommandRow, type TestRow, admitVerification, renderVerification } from '../src/sdd/verification-contract.ts'
import { readHeader, section } from '../src/sdd/markdown.ts'
import { readFlow } from '../src/sdd/read.ts'
import { resolve } from '../src/sdd/status.ts'
import { flowWriterRuns, readReservation, releaseWriter, reserveWriter } from '../src/writer-store.ts'
import { createHash } from 'node:crypto'
import { SddError } from '../src/types.ts'
import { askPair, makeFakeBin, makeRepo, warmFakeBin, writeClaudeTranscript } from './helpers.ts'
import { realpathSync } from 'node:fs'

const realpathTmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-verify-')))

const gitIn = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

/** Un repo con un commit base: un archivo de código, uno que Git ignora y el directorio del flujo `f`. */
function baseRepo(): { repo: string; base: string } {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  mkdirSync(join(repo, '.plans', 'f'), { recursive: true })
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), '# Plan\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  return { repo, base: gitIn(repo, 'rev-parse', 'HEAD') }
}

test('la huella del candidato cambia con el código y no con el flujo ni con lo ignorado', () => {
  const { repo, base } = baseRepo()
  const index = readFileSync(join(repo, '.git', 'index'))
  const clean = candidateFingerprint(repo, 'f', base)
  assert.equal(clean.base_commit, base)
  assert.equal(clean.tree, clean.base_tree)

  // El flujo escribe su plan y su registro: la huella no se mueve.
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), '# Plan\n\n## Verify\n\nverde\n')
  writeFileSync(join(repo, '.plans', 'f', 'sdd-ai-phases.json'), '{}\n')
  assert.deepEqual(candidateFingerprint(repo, 'f', base), clean)

  // Una salida de build en una ruta ignorada tampoco cuenta.
  mkdirSync(join(repo, 'build'))
  writeFileSync(join(repo, 'build', 'out.js'), 'x\n')
  assert.deepEqual(candidateFingerprint(repo, 'f', base), clean)

  // Un cambio de código y un archivo nuevo fuera del flujo sí la mueven.
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2\n')
  const edited = candidateFingerprint(repo, 'f', base)
  assert.notEqual(edited.tree, clean.tree)
  assert.equal(edited.base_tree, clean.base_tree)
  writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1\n')
  assert.notEqual(candidateFingerprint(repo, 'f', base).tree, edited.tree)

  // Otro flujo no se excluye: solo el propio.
  assert.notEqual(candidateFingerprint(repo, 'otro', base).tree, candidateFingerprint(repo, 'f', base).tree)
  // El índice del usuario queda intacto.
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), index)
})

test('el árbol de una cosecha se reconstruye desde su patch, sin el directorio del flujo', () => {
  const { repo, base } = baseRepo()
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2\n')
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), '# Plan cambiado\n')
  const patch = join(repo, '.git', 'harvest.patch')
  writeFileSync(patch, execFileSync('git', ['diff', '--binary', '--src-prefix=a/', '--dst-prefix=b/', base], { cwd: repo }))
  const now = candidateFingerprint(repo, 'f', base)
  assert.equal(harvestTreeWithout(repo, 'f', base, patch), now.tree)
  // Un retoque posterior fuera del flujo la hace distinta; uno dentro del flujo no.
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), '# Plan con Verify\n')
  assert.equal(harvestTreeWithout(repo, 'f', base, patch), candidateFingerprint(repo, 'f', base).tree)
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 3\n')
  assert.notEqual(harvestTreeWithout(repo, 'f', base, patch), candidateFingerprint(repo, 'f', base).tree)
  // Sin patch no hay cosecha comparable.
  assert.equal(harvestTreeWithout(repo, 'f', base, join(repo, 'no-existe.patch')), null)
  // Un patch vacío es la base.
  const empty = join(repo, '.git', 'empty.patch')
  writeFileSync(empty, '')
  assert.equal(harvestTreeWithout(repo, 'f', base, empty), now.base_tree)
})

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof SddError) return e.code
    throw e
  }
  return 'ok'
}

/** Un recibo final de una fila con sus dos salidas escritas en el directorio del recibo. */
function sampleReceipt(repo: string, base: string): VerifyReceipt {
  const id = newReceiptId()
  const dir = receiptDir(repo, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stdout-V1.log'), 'ok 1 - exporta\n')
  writeFileSync(join(dir, 'stderr-V1.log'), '')
  const fp = candidateFingerprint(repo, 'f', base)
  return {
    id, flow: 'f', mode: 'final', started_at: '2026-09-29T10:00:00-05:00', ended_at: '2026-09-29T10:00:01-05:00',
    before: fp, after: fp, plan_fingerprint: 'sha256:plan', coverage: { 'AC-1': ['V1'] },
    rows: [{
      row: 'V1', outcome: 'passed',
      execution: {
        row: 'V1', started_at: '2026-09-29T10:00:00-05:00', ended_at: '2026-09-29T10:00:01-05:00', argv: ['node', '--test'], exit_code: 0,
        stdout_file: 'stdout-V1.log', stderr_file: 'stderr-V1.log',
        stdout_sha256: fileSha256(join(dir, 'stdout-V1.log')), stderr_sha256: fileSha256(join(dir, 'stderr-V1.log')), excerpt: 'exit 0; ok 1 - exporta',
      },
    }],
    green: true,
  }
}

test('el recibo se publica en el almacén del checkout y se valida por digest al leerlo', () => {
  const { repo, base } = baseRepo()
  const receipt = sampleReceipt(repo, base)
  const ref = writeVerifyReceipt(repo, receipt)
  assert.equal(ref.id, receipt.id)
  assert.equal(ref.mode, 'final')
  assert.match(ref.digest, /^sha256:[0-9a-f]{64}$/)
  assert.ok(receiptDir(repo, ref.id).startsWith(join(repo, '.git')))
  assert.deepEqual(readVerifyReceipt(repo, ref), receipt)

  // Una salida alterada o un cuerpo alterado dejan de ser íntegros.
  writeFileSync(join(receiptDir(repo, ref.id), 'stdout-V1.log'), 'ok 1 - otra cosa\n')
  assert.equal(codeOf(() => readVerifyReceipt(repo, ref)), 'receipt_invalid')
  writeFileSync(join(receiptDir(repo, ref.id), 'stdout-V1.log'), 'ok 1 - exporta\n')
  assert.equal(codeOf(() => readVerifyReceipt(repo, ref)), 'ok')
  const file = join(receiptDir(repo, ref.id), 'receipt.json')
  writeFileSync(file, readFileSync(file, 'utf8').replace('"green": true', '"green": false'))
  assert.equal(codeOf(() => readVerifyReceipt(repo, ref)), 'receipt_invalid')
  assert.equal(codeOf(() => readVerifyReceipt(repo, { ...ref, id: newReceiptId(new Date(0)) })), 'receipt_invalid')
})

test('una acreditación vale mientras coinciden sus dos huellas, y una alterada se salta sin abortar', () => {
  const { repo, base } = baseRepo()
  const fp = candidateFingerprint(repo, 'f', base)
  const attestation = (id: string, over: Partial<Attestation> = {}): Attestation => ({
    id, flow: 'f', row: 'V4', observation: 'abre en una planilla', candidate: fp, plan_fingerprint: 'sha256:plan',
    answered_at: '2026-09-29T10:00:00-05:00', proof_ref: `toolu_${id}`, ...over,
  })
  const older = writeAttestation(repo, attestation('20260929-1000-aaaa'))
  const newer = writeAttestation(repo, attestation('20260929-1001-bbbb'))
  assert.deepEqual(readAttestation(repo, newer).row, 'V4')
  assert.deepEqual(currentAttestation(repo, [older, newer], 'f', 'V4', fp, 'sha256:plan'), { ref: newer, invalid: [] })
  // Otra fila, otro plan u otro árbol no tienen acreditación vigente.
  assert.equal(currentAttestation(repo, [older, newer], 'f', 'V5', fp, 'sha256:plan').ref, null)
  assert.equal(currentAttestation(repo, [older, newer], 'f', 'V4', fp, 'sha256:otro').ref, null)
  assert.equal(currentAttestation(repo, [older, newer], 'f', 'V4', { ...fp, tree: 'f'.repeat(40) }, 'sha256:plan').ref, null)
  // La más reciente alterada se salta y se anota; queda la anterior.
  const file = join(repo, '.git', 'sdd-ai', 'verify', 'attestations', `${newer.id}.json`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('planilla', 'terminal'))
  assert.equal(codeOf(() => readAttestation(repo, newer)), 'attestation_invalid')
  assert.deepEqual(currentAttestation(repo, [older, newer], 'f', 'V4', fp, 'sha256:plan'), { ref: older, invalid: [newer.id] })
})

test('el registro del flujo guarda referencias de verify en orden y rechaza las mal formadas', () => {
  const { repo } = baseRepo()
  const file = join(repo, '.plans', 'f', PHASES_FILE)
  // Un registro anterior, sin verify, se sigue leyendo.
  writeFileSync(file, JSON.stringify({ schema_version: 1, last_run: { id: '20260929-1000-aaaa', step: 'implement' }, phases: {} }))
  assert.equal(readPhaseRecord(repo, 'f').verify, undefined)
  assert.equal(latestFinalReceipt(readPhaseRecord(repo, 'f')), null)

  const digest = `sha256:${'a'.repeat(64)}`
  appendReceiptRef(repo, 'f', { id: '20260929-1001-aaaa', digest, mode: 'final' })
  appendReceiptRef(repo, 'f', { id: '20260929-1002-aaaa', digest, mode: 'final' })
  appendReceiptRef(repo, 'f', { id: '20260929-1003-aaaa', digest, mode: 'baseline' })
  withFlowLock(repo, 'f', () => appendAttestationRef(repo, 'f', { id: '20260929-1004-aaaa', digest, row: 'V4', proof_ref: 'toolu_x' }))
  const r = readPhaseRecord(repo, 'f')
  assert.equal(r.last_run?.id, '20260929-1000-aaaa')
  assert.deepEqual(r.verify?.receipts.map((x) => x.id), ['20260929-1001-aaaa', '20260929-1002-aaaa', '20260929-1003-aaaa'])
  assert.equal(r.verify?.attestations.length, 1)
  // Una baseline posterior no desplaza al último recibo final.
  assert.equal(latestFinalReceipt(r)?.id, '20260929-1002-aaaa')

  for (const verify of [
    { receipts: [{ id: '../x', digest, mode: 'final' }], attestations: [] },
    { receipts: [{ id: '20260929-1001-aaaa', digest: 'md5:x', mode: 'final' }], attestations: [] },
    { receipts: [{ id: '20260929-1001-aaaa', digest, mode: 'otro' }], attestations: [] },
    { receipts: [], attestations: [{ id: '20260929-1004-aaaa', digest, row: 'V4' }] },
    { receipts: [], attestations: [], extra: 1 },
  ]) {
    writeFileSync(file, JSON.stringify({ schema_version: 1, last_run: null, phases: {}, verify }))
    assert.equal(codeOf(() => readPhaseRecord(repo, 'f')), 'phases_invalid', JSON.stringify(verify))
  }
})

/** El TAP real de `node --test` sobre archivos de prueba escritos en un directorio temporal. */
function realTap(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-tap-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  // Dentro de `node --test`, un hijo que hereda NODE_TEST_CONTEXT le reporta al padre en vez de escribir TAP.
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env
  try {
    return execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...Object.keys(files).map((f) => join(dir, f))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env })
  } catch (e) {
    return (e as { stdout: string }).stdout
  }
}

const TAP_FILES = {
  'a.test.ts': `import { test, describe } from 'node:test'\nimport assert from 'node:assert/strict'\n`
    + `test('aserción', () => { assert.equal(1, 2) })\n`
    + `test('error del código', () => { const f: any = undefined; f() })\n`
    + `test('pasa', () => {})\n`
    + `test('repetido', () => {})\ntest('repetido', () => {})\n`
    + `describe('suite', () => { test('anidado', () => { assert.equal(1, 2) }) })\n`
    + `test('saltado', { skip: true }, () => {})\n`,
  'b.test.ts': `import { nada } from './no-existe.ts'\nimport { test } from 'node:test'\ntest('nunca', () => { nada() })\n`,
}

test('el TAP real se lee por entrada, con su nivel y el failureType de su propio bloque', () => {
  const entries = parseTap(realTap(TAP_FILES))
  const byName = (n: string) => entries.filter((e) => e.name === n)
  assert.deepEqual(byName('aserción'), [{ name: 'aserción', ok: false, depth: 0, failureType: 'testCodeFailure' }])
  assert.equal(byName('error del código')[0].failureType, 'testCodeFailure')
  assert.deepEqual(byName('pasa'), [{ name: 'pasa', ok: true, depth: 0 }])
  assert.equal(byName('repetido').length, 2)
  // El subtest de una suite queda en su nivel y con su propio bloque; la suite falla con otro tipo.
  assert.deepEqual(byName('anidado'), [{ name: 'anidado', ok: false, depth: 1, failureType: 'testCodeFailure' }])
  assert.equal(byName('suite')[0].failureType, 'subtestsFailed')
  assert.equal(byName('suite')[0].suite, true)
  // Lo saltado no se ejecutó y el test de un archivo que no carga no aparece: solo la ruta del archivo.
  assert.equal(byName('saltado').length, 0)
  assert.equal(byName('nunca').length, 0)
  assert.ok(entries.some((e) => e.name.endsWith('b.test.ts') && !e.ok))
})

const EXEC = { row: 'V1', started_at: '', ended_at: '', argv: [], stdout_file: '', stderr_file: '', stdout_sha256: '', stderr_sha256: '', excerpt: '' }
const TROW: TestRow = {
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert', argv: ['node'], timeout_ms: 1000, expect: { exit_code: 0 },
  implementation_paths: ['src/a.ts'], test_paths: ['test/a.test.ts'], test_name: 'pasa', report_format: 'tap',
}

test('una fila test pasa solo con el código esperado y su test nombrado en ok', () => {
  const tap = realTap(TAP_FILES)
  const out = (stdout: string) => ({ stdout, stderr: '' })
  assert.equal(evaluateRow(TROW, { ...EXEC, exit_code: 0 }, out(tap)), 'passed')
  // El código esperado sin el test nombrado en ok no pasa: ausente, fallido, ambiguo o solo el archivo.
  for (const name of ['no-existe', 'aserción', 'repetido', 'nunca']) assert.equal(evaluateRow({ ...TROW, test_name: name }, { ...EXEC, exit_code: 0 }, out(tap)), 'failed', name)
  assert.equal(evaluateRow(TROW, { ...EXEC, exit_code: 1 }, out(tap)), 'failed')
  assert.equal(evaluateRow({ ...TROW, expect: { exit_code: 0, output_pattern: '^# pass 999' } }, { ...EXEC, exit_code: 0 }, out(tap)), 'failed')
  assert.equal(evaluateRow(TROW, { ...EXEC, exit_code: null, reason: 'timeout' }, out(tap)), 'unavailable')
  assert.equal(evaluateRow(TROW, { ...EXEC, exit_code: null, reason: 'launch_failed' }, out(tap)), 'unavailable')
  assert.equal(evaluateRow(TROW, { ...EXEC, exit_code: null, reason: 'interrupted' }, out(tap)), 'unrun')
  // Una fila que no es test no mira el TAP; el patrón se busca en stdout seguido de stderr.
  const BROW: CommandRow = { id: 'V2', acs: ['AC-2'], kind: 'build', obligation: 'none', obligation_reason: 'x', argv: ['x'], timeout_ms: 1, expect: { exit_code: 0, output_pattern: 'listo' } }
  assert.equal(evaluateRow(BROW, { ...EXEC, exit_code: 0 }, { stdout: 'compilando', stderr: 'listo' }), 'passed')
})

test('una suite que se llama como el test no cuenta como el test colectado', () => {
  const tap = realTap({ 's.test.ts': `import { describe, test } from 'node:test'\ndescribe('pasa', () => { test('otro', () => {}) })\n` })
  assert.equal(evaluateRow(TROW, { ...EXEC, exit_code: 0 }, { stdout: tap, stderr: '' }), 'failed')
  assert.equal(confirmationOutcome({ ...TROW, obligation: 'green_on_base' }, { ...EXEC, exit_code: 0 }, tap), 'not_confirmable')
})

test('la confirmación acepta una falla del código dentro del test y rechaza un error de carga', () => {
  const tap = realTap(TAP_FILES)
  const red = (name: string) => confirmationOutcome({ ...TROW, test_name: name }, { ...EXEC, exit_code: 1 }, tap)
  assert.equal(red('aserción'), 'confirmed')
  assert.equal(red('error del código'), 'confirmed')
  assert.equal(red('pasa'), 'refuted')
  assert.equal(red('nunca'), 'not_confirmable')
  assert.equal(red('no-existe'), 'not_confirmable')
  assert.equal(red('repetido'), 'not_confirmable')
  const green = (name: string) => confirmationOutcome({ ...TROW, obligation: 'green_on_base', test_name: name }, { ...EXEC, exit_code: 0 }, tap)
  assert.equal(green('pasa'), 'confirmed')
  assert.equal(green('aserción'), 'refuted')
  assert.equal(confirmationOutcome(TROW, { ...EXEC, exit_code: null, reason: 'timeout' }, tap), 'not_confirmable')
})

test('el extracto toma la última línea, reemplaza controles y se trunca a 200 caracteres', () => {
  assert.equal(excerpt(0, 'uno\ndos\n\n', ''), 'exit 0; dos')
  assert.equal(excerpt(1, 'uno\n', 'error final\n'), 'exit 1; error final')
  assert.equal(excerpt(0, 'a\u202Eb\u0007c\n', ''), 'exit 0; a?b?c')
  assert.equal(excerpt(0, `${'x'.repeat(500)}\n`, '').length, 200)
  assert.equal(excerpt(0, '', ''), 'exit 0; sin salida')
  assert.equal(excerpt(null, 'algo', '', 'timeout'), 'exit -; timeout')
})

const cmd = (id: string, argv: string[], o: Partial<CommandRow> = {}): CommandRow =>
  ({ id, acs: ['AC-1'], kind: 'build', obligation: 'none', obligation_reason: 'x', argv, timeout_ms: 5000, expect: { exit_code: 0 }, ...o })

test('las filas corren en orden con argv literal, tope de tiempo e interrupción', async () => {
  const root = realpathTmp()
  const dir = join(root, 'run')
  const literal = '$(echo x); touch hecho-por-shell && `id` | cat > y'
  const rows = [
    cmd('V1', [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal]),
    cmd('V2', [process.execPath, '-e', 'console.error("roto"); process.exit(3)']),
    cmd('V3', ['sdd-ai-no-existe-este-comando']),
    cmd('V4', [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { timeout_ms: 300 }),
  ]
  const [ok, bad, missing, slow] = await executeRows(root, dir, rows, new AbortController().signal)
  assert.equal(readFileSync(join(dir, ok.stdout_file), 'utf8'), literal)
  assert.equal(existsSync(join(root, 'hecho-por-shell')), false)
  assert.equal(ok.exit_code, 0)
  assert.equal(ok.stdout_sha256, fileSha256(join(dir, 'stdout-V1.log')))
  assert.deepEqual([bad.exit_code, bad.excerpt], [3, 'exit 3; roto'])
  assert.equal(missing.reason, 'launch_failed')
  assert.equal(missing.launch_error, 'ENOENT')
  assert.equal(missing.excerpt, 'exit -; no se pudo lanzar: ENOENT')
  assert.deepEqual([slow.reason, slow.exit_code, slow.excerpt], ['timeout', null, 'exit -; timeout'])
  assert.ok(Date.parse(slow.ended_at) - Date.parse(slow.started_at) < 5000)

  // Una interrupción termina la fila en curso y deja las siguientes sin ejecutar.
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 200)
  const cut = await executeRows(root, join(root, 'cut'), [cmd('V1', [process.execPath, '-e', 'setTimeout(() => {}, 60000)']), cmd('V2', [process.execPath, '-e', ''])], controller.signal)
  assert.deepEqual(cut.map((e) => e.reason), ['interrupted', 'interrupted'])
  assert.equal(cut[1].excerpt, 'exit -; interrumpida')
  // Con prefijo, las salidas de una confirmación no pisan las de la corrida principal.
  const [confirm] = await executeRows(root, dir, [cmd('V1', [process.execPath, '-e', 'process.stdout.write("otra")'])], new AbortController().signal, 'confirm-')
  assert.equal(confirm.stdout_file, 'confirm-stdout-V1.log')
  assert.equal(readFileSync(join(dir, 'stdout-V1.log'), 'utf8'), literal)
})

// ── Corridas de verify sobre un flujo de muestra ──────────────────────────────────────────────────────────

const SPEC_MD = '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** f da 2. (pedido)\n- **AC-2:** compila. (pedido)\n'
const HANDOFF_MD = '---\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: 2026-09-29T09:00:00-05:00\n---\n\n# Handoff\n'
const TASKS_MD = (done: boolean) => `# Tasks\n\n- [${done ? 'x' : ' '}] **T1 — f da 2**  · cubre: AC-1, AC-2\n`

const RED_ROW = {
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert',
  argv: [process.execPath, '--test', '--test-reporter=tap', 'test/a.test.ts'], timeout_ms: 30000, expect: { exit_code: 0 },
  implementation_paths: ['src/a.ts'], test_paths: ['test/a.test.ts'], test_name: 'f da 2', report_format: 'tap',
}
const BUILD_ROW = {
  id: 'V2', acs: ['AC-2'], kind: 'build', obligation: 'none', obligation_reason: 'no hay seam',
  argv: [process.execPath, '-e', 'process.exit(process.argv[1] === "$(x); touch hecho-por-shell | y" ? 0 : 1)', '$(x); touch hecho-por-shell | y'], timeout_ms: 30000, expect: { exit_code: 0 },
}

const planMd = (base: string, status: string, rows: unknown[]) => `---\nid: f\nbranch: feature/f\nbase_commit: ${base}\nchange_type: feat\n`
  + `profundidad: completa\nrisk: low\nstatus: ${status}\ncreated_at: 2026-09-29T09:00:00-05:00\n---\n\n# Plan\n\n## Enfoque\n\nUno.\n\n`
  + `## Verification\n\n${renderVerification(admitVerification({ schema_version: 1, rows }, ['AC-1', 'AC-2']))}\n`

/** Registra los tres gates con las huellas de hoy, como `sdd approve` pero sin prueba del runner. */
function approveAll(repo: string): void {
  const { facts } = readFlow(repo, 'f')
  const fp = facts.fingerprints
  const approvals = [
    { gate: 'spec', depth: 'completa', fingerprint: fp.spec, previous: {}, at: '2026-09-29T14:00:00.000Z' },
    { gate: 'plan', depth: 'completa', fingerprint: fp.plan, previous: { spec: fp.spec }, at: '2026-09-29T14:01:00.000Z' },
    { gate: 'tasks', depth: 'completa', fingerprint: fp.tasks, previous: { spec: fp.spec, plan: fp.plan }, at: '2026-09-29T14:02:00.000Z' },
  ]
  writeFileSync(join(repo, '.plans', 'f', 'sdd-ai-approvals.json'), `${JSON.stringify({ schema_version: 1, approvals }, null, 2)}\n`)
}

/**
 * Un flujo `f` en completa con los tres gates aprobados. La base tiene `f = () => 1`; el candidato, `f = () => 2`
 * y la prueba que lo exige. `.plans/` está excluido de Git, como en un repositorio real.
 */
function verifyFlow(o: { rows?: unknown[]; status?: string; done?: boolean; implement?: boolean; base?: Record<string, string>; candidate?: Record<string, string> } = {}): { repo: string; base: string } {
  const repo = makeRepo()
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\n')
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, 'test'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 1\n')
  for (const [path, text] of Object.entries(o.base ?? {})) writeFileSync(join(repo, path), text)
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'spec.md'), SPEC_MD)
  writeFileSync(join(dir, 'handoff.md'), HANDOFF_MD)
  writeFileSync(join(dir, 'tasks.md'), TASKS_MD(o.done ?? true))
  writeFileSync(join(dir, 'plan.md'), planMd(base, o.status ?? 'implementing', o.rows ?? [RED_ROW, BUILD_ROW]))
  approveAll(repo)
  if (o.implement ?? true) {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 2\n')
    writeFileSync(join(repo, 'test', 'a.test.ts'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n")
    for (const [path, text] of Object.entries(o.candidate ?? {})) writeFileSync(join(repo, path), text)
  }
  return { repo, base }
}

const planOf = (repo: string) => readFileSync(join(repo, '.plans', 'f', 'plan.md'), 'utf8')
const statusOf = (repo: string) => resolve(readFlow(repo, 'f').facts)
const final = async (repo: string, signal = new AbortController().signal) => runFinal(prepareVerify(repo, 'f', 'final'), signal)

test('una corrida final verde confirma el revert, proyecta Verify, pasa a verified y deja el commit en manos del usuario', async () => {
  const { repo, base } = verifyFlow()
  const planGate = () => statusOf(repo).gates.find((g) => g.gate === 'plan')?.state
  assert.equal(planGate(), 'approved')
  const { receipt, ref, projection } = await final(repo)
  assert.equal(receipt.green, true, JSON.stringify(receipt.rows))
  assert.equal(projection, 'written')
  assert.ok(ref)
  const [v1, v2] = receipt.rows
  assert.deepEqual([v1.outcome, v1.confirmation?.state, v1.confirmation?.restored], ['passed', 'confirmed', true])
  assert.equal(v1.confirmation?.execution?.stdout_file, 'confirm-stdout-V1.log')
  // Los metacaracteres llegaron como un solo argumento literal.
  assert.equal(v2.outcome, 'passed')
  assert.deepEqual(receipt.coverage, { 'AC-1': ['V1'], 'AC-2': ['V2'] })
  assert.equal(receipt.before.tree, receipt.after.tree)
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')

  const plan = planOf(repo)
  assert.match(plan, /^status: verified$/m)
  const verify = section(readHeader(plan).ok ? (readHeader(plan) as { body: string }).body : plan, 'Verify') ?? ''
  assert.match(verify, /\| AC-1 \| V1 \| ✅ passed \| exit 0; .*revert: confirmed/)
  assert.match(verify, new RegExp(`Recibo \`${receipt.id}\``))
  // La proyección no vence el gate, y el paso siguiente es commitear, que sigue siendo del usuario.
  assert.equal(planGate(), 'approved')
  assert.equal(statusOf(repo).next.step, 'review_and_commit')
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), base)
  assert.deepEqual(readPhaseRecord(repo, 'f').verify?.receipts.map((r) => r.id), [receipt.id])
  // La reserva quedó libre.
  assert.equal(readReservation(repo), undefined)
})

test('con un rojo el header queda en implementing, aunque viniera de verified', async () => {
  const { repo } = verifyFlow()
  await final(repo)
  assert.match(planOf(repo), /^status: verified$/m)
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 3\n')
  const { receipt, projection } = await final(repo)
  assert.equal(receipt.green, false)
  assert.equal(receipt.rows[0].outcome, 'failed')
  assert.equal(receipt.rows[0].confirmation?.state, 'not_confirmable')
  assert.equal(projection, 'written')
  assert.match(planOf(repo), /^status: implementing$/m)
  assert.match(planOf(repo), /\| AC-1 \| V1 \| ❌ failed \|/)
})

test('una fila que escribe en el repo, un timeout o una ruta nueva impiden el verde', async () => {
  const writes = verifyFlow({ rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("src/z.ts", "x")'] }] })
  const w = await final(writes.repo)
  assert.equal(w.receipt.rows[1].outcome, 'passed')
  assert.notEqual(w.receipt.before.tree, w.receipt.after.tree)
  assert.equal(w.receipt.green, false)

  const slow = verifyFlow({ rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeout_ms: 300 }] })
  const s = await final(slow.repo)
  assert.deepEqual([s.receipt.rows[1].outcome, s.receipt.rows[1].execution?.excerpt], ['unavailable', 'exit -; timeout'])
  assert.equal(s.receipt.green, false)

  const fresh = verifyFlow({ rows: [{ ...RED_ROW, implementation_paths: ['src/nueva.ts'] }, BUILD_ROW] })
  writeFileSync(join(fresh.repo, 'src', 'nueva.ts'), 'export const g = 1\n')
  const n = await final(fresh.repo)
  assert.equal(n.receipt.rows[0].confirmation?.state, 'not_confirmable')
  assert.match(n.receipt.rows[0].confirmation?.reason ?? '', /es nueva en el cambio/)
  // La fila pasó su ejecución, pero sin la confirmación que le exige su obligación no es passed.
  assert.equal(n.receipt.rows[0].outcome, 'failed')
  assert.equal(n.receipt.green, false)
})

test('dos corridas vuelven a ejecutar todas las filas y ven una regresión', async () => {
  const { repo } = verifyFlow()
  const first = await final(repo)
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 1\n')
  const second = await final(repo)
  assert.notEqual(first.receipt.id, second.receipt.id)
  assert.notEqual(first.receipt.rows[0].execution?.started_at, second.receipt.rows[0].execution?.started_at)
  assert.deepEqual([first.receipt.rows[0].outcome, second.receipt.rows[0].outcome], ['passed', 'failed'])
  assert.equal(second.receipt.rows[1].outcome, 'passed')
})

test('una corrida interrumpida publica un recibo rojo si el árbol se recuperó', async () => {
  const { repo } = verifyFlow()
  const controller = new AbortController()
  controller.abort()
  const { receipt, ref } = await final(repo, controller.signal)
  assert.ok(ref)
  assert.deepEqual(receipt.rows.map((r) => r.outcome), ['unrun', 'unrun'])
  assert.equal(receipt.rows[0].execution?.excerpt, 'exit -; interrumpida')
  assert.equal(receipt.green, false)
  assert.match(planOf(repo), /^status: implementing$/m)
})

/** El código del error de una promesa o de una llamada. */
const asyncCode = async (fn: () => Promise<unknown> | unknown): Promise<string> => {
  try {
    await fn()
  } catch (e) {
    if (e instanceof SddError) return e.code
    throw e
  }
  return 'ok'
}

test('verify no arranca sin el gate del plan vigente, con bloqueos, con un writer abierto, sin almacén ni en otro paso', async () => {
  // Gate pendiente: sin aprobaciones registradas.
  const pending = verifyFlow()
  writeFileSync(join(pending.repo, '.plans', 'f', 'sdd-ai-approvals.json'), '{"schema_version":1,"approvals":[]}\n')
  assert.equal(await asyncCode(() => prepareVerify(pending.repo, 'f', 'final')), 'plan_not_approved')
  // Gate vencido: el contrato cambió después de aprobarlo, y el paso vuelve al gate del plan.
  const stale = verifyFlow()
  writeFileSync(join(stale.repo, '.plans', 'f', 'plan.md'), planOf(stale.repo).replace('"timeout_ms": 30000', '"timeout_ms": 31000'))
  assert.equal(statusOf(stale.repo).next.step, 'gate')
  assert.equal(await asyncCode(() => prepareVerify(stale.repo, 'f', 'final')), 'verify_not_now')
  // Bloqueos: un header que no se lee.
  const blocked = verifyFlow()
  writeFileSync(join(blocked.repo, '.plans', 'f', 'plan.md'), planOf(blocked.repo).replace('status: implementing', 'status: [roto'))
  assert.equal(await asyncCode(() => prepareVerify(blocked.repo, 'f', 'final')), 'flow_blocked')
  // Un paso que no admite el modo: con tasks pendientes, la corrida final no va; la base sí.
  const early = verifyFlow({ done: false, implement: false })
  approveAll(early.repo)
  assert.equal(await asyncCode(() => prepareVerify(early.repo, 'f', 'final')), 'verify_not_now')
  const done = verifyFlow()
  assert.equal(await asyncCode(() => prepareVerify(done.repo, 'f', 'baseline')), 'verify_not_now')
  // Un writer del flujo sin cosecha congelada.
  const open = verifyFlow()
  const store = join(open.repo, '.git', 'sdd-ai', 'runs', '20260929-1500-aaaa')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'control.json'), JSON.stringify({ id: '20260929-1500-aaaa', phase: { flow: 'f', pending: ['T1'], inputs: {}, handoff_header: '' } }))
  assert.equal(await asyncCode(() => prepareVerify(open.repo, 'f', 'final')), 'writer_open')
  // Un almacén que no se puede escribir.
  const locked = verifyFlow()
  mkdirSync(join(locked.repo, '.git', 'sdd-ai'), { recursive: true })
  writeFileSync(join(locked.repo, '.git', 'sdd-ai', 'verify'), 'no es un directorio')
  assert.equal(await asyncCode(() => prepareVerify(locked.repo, 'f', 'final')), 'control_unavailable')
  // Un contrato en prosa se niega y pide republicar.
  const prose = verifyFlow()
  writeFileSync(join(prose.repo, '.plans', 'f', 'plan.md'), planOf(prose.repo).replace(/## Verification[\s\S]*$/, '## Verification\n\n| AC-1 | test | x | y |\n'))
  approveAll(prose.repo)
  assert.equal(await asyncCode(() => prepareVerify(prose.repo, 'f', 'final')), 'contract_prose')
  // Ninguna negativa dejó la reserva tomada.
  for (const r of [pending, stale, blocked, early, done, open, prose]) assert.equal(readReservation(r.repo), undefined)
})

/** Deja un writer de fase del flujo con su cosecha, sacada del árbol de ahora. */
function fakeHarvest(repo: string, base: string, o: { endMark: boolean }): void {
  const id = '20260929-1500-bbbb'
  const store = join(repo, '.git', 'sdd-ai', 'runs', id)
  mkdirSync(store, { recursive: true })
  const patchFile = join(store, 'diff.patch')
  gitIn(repo, 'add', '-N', '.')
  writeFileSync(patchFile, execFileSync('git', ['diff', '--binary', '--src-prefix=a/', '--dst-prefix=b/', base], { cwd: repo }))
  gitIn(repo, 'reset', '-q')
  writeFileSync(join(store, 'control.json'), JSON.stringify({ id, phase: { flow: 'f', pending: ['T1'], inputs: {}, handoff_header: '' } }))
  writeFileSync(join(store, 'harvest.json'), JSON.stringify({ state: 'done', base, tree: 'x', files: [], patchFile, flagged: [], runAltered: [], headMoved: false, endMark: o.endMark }))
}

test('la última cosecha del flujo tiene que cerrar con STATUS: done, y el recibo dice si su árbol es el candidato', async () => {
  const done = verifyFlow()
  fakeHarvest(done.repo, done.base, { endMark: true })
  const a = await final(done.repo)
  assert.deepEqual(a.receipt.writer, { run: '20260929-1500-bbbb', end_mark: true, tree_matches: true })
  assert.equal(a.receipt.green, true)
  // Un retoque del conductor fuera del flujo se declara, sin quitar el verde.
  writeFileSync(join(done.repo, 'src', 'extra.ts'), 'export const x = 1\n')
  const b = await final(done.repo)
  assert.equal(b.receipt.writer?.tree_matches, false)

  const partial = verifyFlow()
  fakeHarvest(partial.repo, partial.base, { endMark: false })
  const c = await final(partial.repo)
  assert.equal(c.receipt.writer?.end_mark, false)
  assert.equal(c.receipt.green, false)
  // Un flujo sin writer se verifica igual.
  const inline = await final(verifyFlow().repo)
  assert.equal(inline.receipt.writer, undefined)
  assert.equal(inline.receipt.green, true)
})

const MANUAL_ROW = { id: 'V2', acs: ['AC-2'], kind: 'manual', obligation: 'none', obligation_reason: 'es visual', observation: 'el CSV abre en una planilla' }

/** El entorno de una sesión de Claude Code de fixture, con la respuesta del usuario a `q` en su transcript. */
function answered(q: Question, label: string, env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp() }) {
  writeClaudeTranscript(env.CLAUDE_CONFIG_DIR, env.CLAUDE_CODE_SESSION_ID, askPair(env.CLAUDE_CODE_SESSION_ID, `tu-${randomUUID()}`, q, label))
  return env
}

test('una fila manual queda pendiente hasta acreditarla, y la acreditación vence con el árbol o el plan', async () => {
  const { repo } = verifyFlow({ rows: [RED_ROW, MANUAL_ROW] })
  const pending = await final(repo)
  assert.deepEqual([pending.receipt.rows[1].outcome, pending.receipt.rows[1].execution?.excerpt, pending.receipt.rows[1].baseline], ['unrun', 'exit -; manual', 'missing'])
  assert.ok(pending.receipt.rows[1].execution?.started_at)
  assert.equal(pending.receipt.green, false)

  // Sin respuesta, --attest pide la pregunta canónica; una fila que no es manual o no existe es un error de uso.
  const start = prepareVerify(repo, 'f', 'final')
  releaseWriter(repo, start.receiptId)
  const q = attestQuestion('f', 'V2', MANUAL_ROW.observation, candidateFingerprint(repo, 'f', start.baseCommit), start.planFingerprint)
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp() })), 'approval_missing')
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V1', answered(q, 'Acreditar'))), 'usage')
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V9', answered(q, 'Acreditar'))), 'usage')

  const env = answered(q, 'Acreditar')
  const ref = attestRow(repo, 'f', 'V2', env)
  assert.equal(ref.row, 'V2')
  // La misma respuesta no sirve dos veces.
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', env)), 'approval_reused')
  const attested = await final(repo)
  assert.equal(attested.receipt.rows[1].attestation, ref.id)
  assert.equal(attested.receipt.green, true)
  assert.match(planOf(repo), /\| AC-2 \| V2 \| ✅ passed \| acreditada/)

  // Reaprobar el plan con esa fila cambiada vence la acreditación aunque el árbol sea el mismo.
  const changed = planOf(repo).replace('el CSV abre en una planilla', 'el CSV abre en otra planilla')
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), changed)
  approveAll(repo)
  const replanned = await final(repo)
  assert.equal(replanned.receipt.rows[1].outcome, 'unrun')
  // Un cambio del árbol también la vence.
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), changed.replace('el CSV abre en otra planilla', 'el CSV abre en una planilla'))
  approveAll(repo)
  assert.equal((await final(repo)).receipt.rows[1].outcome, 'passed')
  writeFileSync(join(repo, 'src', 'otro.ts'), 'export const o = 1\n')
  const moved = await final(repo)
  assert.equal(moved.receipt.rows[1].outcome, 'unrun')
})

test('la acreditación no se registra fuera de verify, con un contrato en prosa ni con una respuesta de approve', async () => {
  const early = verifyFlow({ rows: [RED_ROW, MANUAL_ROW], done: false })
  approveAll(early.repo)
  assert.equal(await asyncCode(() => attestRow(early.repo, 'f', 'V2', {})), 'verify_not_now')
  const prose = verifyFlow({ rows: [RED_ROW, MANUAL_ROW] })
  writeFileSync(join(prose.repo, '.plans', 'f', 'plan.md'), planOf(prose.repo).replace(/## Verification[\s\S]*$/, '## Verification\n\n| AC-1 | test | x | y |\n'))
  approveAll(prose.repo)
  assert.equal(await asyncCode(() => attestRow(prose.repo, 'f', 'V2', {})), 'contract_prose')

  // Una respuesta que ya consumió una aprobación no acredita una fila.
  const { repo } = verifyFlow({ rows: [RED_ROW, MANUAL_ROW] })
  const start = prepareVerify(repo, 'f', 'final')
  releaseWriter(repo, start.receiptId)
  const q = attestQuestion('f', 'V2', MANUAL_ROW.observation, candidateFingerprint(repo, 'f', start.baseCommit), start.planFingerprint)
  const env = answered(q, 'Acreditar')
  const file = join(repo, '.plans', 'f', 'sdd-ai-approvals.json')
  const log = JSON.parse(readFileSync(file, 'utf8'))
  // La prueba que registraría approve con esa misma respuesta.
  log.approvals[2].proof = prove({ env, q, authorizes: 'Acreditar', consumed: new Set() })
  writeFileSync(file, JSON.stringify(log))
  assert.equal(await asyncCode(() => attestRow(repo, 'f', 'V2', env)), 'approval_reused')
})

test('la base se mide antes del writer sin tocar el plan, y la corrida final muestra su observación', async () => {
  const { repo } = verifyFlow({ done: false, implement: false })
  approveAll(repo)
  const before = planOf(repo)
  const { receipt } = await runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)
  assert.equal(receipt.mode, 'baseline')
  assert.equal(receipt.green, false)
  // El test todavía no existe: no se mide. La fila de build sí, y ya pasa en la base.
  assert.deepEqual(receipt.rows.map((r) => r.baseline), ['not_measurable', 'passed'])
  assert.equal(planOf(repo), before)
  assert.equal(statusOf(repo).next.step, 'implement')
  assert.equal(readReservation(repo), undefined)

  // Después de implementar, la corrida final trae la observación de base; la baseline nunca valida verified.
  writeFileSync(join(repo, '.plans', 'f', 'tasks.md'), TASKS_MD(true))
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 2\n')
  writeFileSync(join(repo, 'test', 'a.test.ts'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n")
  const { receipt: fin } = await final(repo)
  assert.deepEqual(fin.rows.map((r) => r.baseline), ['not_measurable', 'passed'])
  assert.equal(latestFinalReceipt(readPhaseRecord(repo, 'f'))?.id, fin.id)
})

test('una medición que escribe en el árbol lo dice, y sin medición previa la corrida final dice que falta', async () => {
  const { repo } = verifyFlow({ done: false, implement: false, rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("src/z.ts", "x")'] }] })
  approveAll(repo)
  const { receipt } = await runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)
  assert.deepEqual(receipt.dirtied_paths, ['src/z.ts'])
  // Con el árbol distinto de la base, otra medición no arranca.
  assert.equal(await asyncCode(async () => runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)), 'baseline_not_clean')
  const { receipt: fin } = await final(verifyFlow().repo)
  assert.deepEqual(fin.rows.map((r) => r.baseline), ['missing', 'missing'])
})

test('en la base, una fila que vence su tope no se pudo medir: no es un fallo', async () => {
  const { repo } = verifyFlow({ done: false, implement: false, rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeout_ms: 200 }] })
  approveAll(repo)
  const { receipt } = await runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)
  assert.deepEqual(receipt.rows.map((r) => [r.outcome, r.baseline]), [['unrun', 'not_measurable'], ['unavailable', 'not_measurable']])
})

test('el paso siguiente sale del último recibo final: vence con el árbol, un recibo alterado, un rojo o un plan reaprobado', async () => {
  const facts = (repo: string) => readFlow(repo, 'f').facts
  const { repo } = verifyFlow()
  // Sin recibo, un header verified editado a mano no abre el commit.
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), planOf(repo).replace('status: implementing', 'status: verified'))
  assert.deepEqual([facts(repo).contract, facts(repo).receipt, statusOf(repo).next.step], ['structured', 'stale', 'verify'])

  const green = await final(repo)
  assert.deepEqual([facts(repo).receipt, statusOf(repo).next.step], ['valid', 'review_and_commit'])
  // Una medición de base posterior no desplaza al recibo final.
  appendReceiptRef(repo, 'f', { id: '20260929-2359-zzzz', digest: `sha256:${'b'.repeat(64)}`, mode: 'baseline' })
  assert.equal(statusOf(repo).next.step, 'review_and_commit')

  // Un cambio del árbol lo vence, y volver al árbol verificado lo recupera.
  writeFileSync(join(repo, 'src', 'extra.ts'), 'export const x = 1\n')
  assert.equal(statusOf(repo).next.step, 'verify')
  assert.ok(statusOf(repo).notes.some((n) => n.code === 'verified_stale'))
  rmSync(join(repo, 'src', 'extra.ts'))
  assert.equal(statusOf(repo).next.step, 'review_and_commit')

  // Un recibo alterado no vale.
  const body = join(receiptDir(repo, green.receipt.id), 'receipt.json')
  const original = readFileSync(body, 'utf8')
  writeFileSync(body, original.replace('"exit_code": 0', '"exit_code": 1'))
  assert.equal(statusOf(repo).next.step, 'verify')
  writeFileSync(body, original)
  assert.equal(statusOf(repo).next.step, 'review_and_commit')

  // Un plan reaprobado con otro contrato, con el mismo árbol, pide volver a verificar.
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), planOf(repo).replace('"timeout_ms": 30000', '"timeout_ms": 31000'))
  approveAll(repo)
  assert.equal(statusOf(repo).next.step, 'verify')
})

test('un recibo verde seguido de uno rojo sobre el mismo árbol y el mismo contrato deja el flujo en verify', async () => {
  // La fila de build falla si hay una marca dentro del flujo, que no cambia ni el árbol ni el contrato.
  const flag = join('.plans', 'f', 'rojo')
  const { repo } = verifyFlow({ rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', 'process.exit(require("node:fs").existsSync(process.argv[1]) ? 1 : 0)', flag] }] })
  const green = await final(repo)
  assert.equal(green.receipt.green, true)
  assert.equal(statusOf(repo).next.step, 'review_and_commit')
  writeFileSync(join(repo, flag), '')
  const red = await final(repo)
  assert.equal(red.receipt.green, false)
  assert.deepEqual([red.receipt.plan_fingerprint, red.receipt.after.tree], [green.receipt.plan_fingerprint, green.receipt.after.tree])
  // Aunque alguien vuelva a poner el header en verified a mano.
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), planOf(repo).replace('status: implementing', 'status: verified'))
  assert.equal(statusOf(repo).next.step, 'verify')
})

test('una edición de plan.md durante la corrida omite la proyección y no se pisa', async () => {
  const edit = 'const fs = require("node:fs"); const f = process.argv[1]; fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("Uno.", "Uno, editado durante la corrida."))'
  const { repo } = verifyFlow({ rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', edit, join('.plans', 'f', 'plan.md')] }] })
  const { receipt, ref, projection } = await final(repo)
  assert.equal(projection, 'plan_changed')
  assert.ok(ref)
  assert.deepEqual(readPhaseRecord(repo, 'f').verify?.receipts.map((r) => r.id), [receipt.id])
  const plan = planOf(repo)
  assert.match(plan, /Uno, editado durante la corrida\./)
  assert.match(plan, /^status: implementing$/m)
  assert.equal(section(plan, 'Verify'), null)
})

test('un writer del flujo con la cosecha congelada pero procesos vivos sigue abierto', async () => {
  const { repo, base } = verifyFlow()
  fakeHarvest(repo, base, { endMark: true })
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  const pgid = child.pid as number
  const control = join(repo, '.git', 'sdd-ai', 'runs', '20260929-1500-bbbb', 'control.json')
  writeFileSync(control, JSON.stringify({ ...JSON.parse(readFileSync(control, 'utf8')), group: { pid: pgid, pgid, lstart: null, argvHash: 'x' } }))
  try {
    assert.equal(await asyncCode(() => prepareVerify(repo, 'f', 'final')), 'writer_open')
  } finally {
    process.kill(-pgid, 'SIGKILL')
    await exited
  }
  // Con el grupo terminado, la cosecha cerrada ya no lo deja abierto.
  releaseWriter(repo, prepareVerify(repo, 'f', 'final').receiptId)
})

test('varias filas que comparten un AC quedan todas en el recibo, en su cobertura y en la proyección', async () => {
  const { repo } = verifyFlow({ rows: [RED_ROW, BUILD_ROW, { ...BUILD_ROW, id: 'V3', acs: ['AC-1'] }] })
  const { receipt } = await final(repo)
  assert.equal(receipt.green, true, JSON.stringify(receipt.rows))
  assert.deepEqual(receipt.coverage, { 'AC-1': ['V1', 'V3'], 'AC-2': ['V2'] })
  assert.deepEqual(receipt.rows.map((r) => [r.row, r.outcome]), [['V1', 'passed'], ['V2', 'passed'], ['V3', 'passed']])
  for (const r of receipt.rows) {
    const e = r.execution
    assert.ok(e, r.row)
    if (e) assert.equal(e.stdout_sha256, fileSha256(join(receiptDir(repo, receipt.id), e.stdout_file)), r.row)
  }
  const plan = planOf(repo)
  const verify = section(readHeader(plan).ok ? (readHeader(plan) as { body: string }).body : plan, 'Verify') ?? ''
  assert.match(verify, /\| AC-1 \| V1 \|/)
  assert.match(verify, /\| AC-1 \| V3 \|/)
})

test('en el paso verify, sdd status y el next de wait traen el comando del verbo', () => {
  const { repo } = verifyFlow()
  const status = statusOf(repo)
  assert.equal(status.next.step, 'verify')
  assert.deepEqual(withPhaseNext(repo, 'f', status), { step: 'verify', command: './bin/sdd-ai sdd verify f' })
})

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

/** Corre el binario con un tope amplio: una corrida final ejecuta las filas y confirma con revert. */
function cli(repo: string, env: Record<string, string>, ...args: string[]): { code: number | null; out: Record<string, any> } {
  const { NODE_TEST_CONTEXT: _ctx, ...base } = process.env
  const r = spawnSync(BIN, args, { cwd: repo, encoding: 'utf8', timeout: 120000, env: { ...base, ...env } as NodeJS.ProcessEnv })
  return { code: r.status, out: JSON.parse(r.stdout) }
}

test('sdd verify por la CLI: la corrida final, el error de uso y la acreditación que pide su pregunta', () => {
  const { repo } = verifyFlow({ rows: [RED_ROW, BUILD_ROW] })
  // Las cadenas vacías quitan del hijo la sesión Codex heredada: el fixture simula solo a Claude.
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp(), CODEX_SESSION_ID: '', CODEX_THREAD_ID: '' }
  assert.equal(cli(repo, env, 'sdd', 'status', 'f').out.next.command, './bin/sdd-ai sdd verify f')
  const usage = cli(repo, env, 'sdd', 'verify', 'f', '--baseline', '--attest', 'V1')
  assert.deepEqual([usage.code, usage.out.code], [2, 'usage'])

  const run = cli(repo, env, 'sdd', 'verify', 'f')
  assert.equal(run.code, 0, JSON.stringify(run.out))
  assert.equal(run.out.green, true)
  assert.equal(run.out.projection, 'written')
  assert.deepEqual(run.out.rows.map((r: { row: string; outcome: string }) => [r.row, r.outcome]), [['V1', 'passed'], ['V2', 'passed']])
  assert.equal(run.out.rows[0].confirmation, 'confirmed')
  assert.equal(run.out.next.step, 'review_and_commit')

  const manual = verifyFlow({ rows: [RED_ROW, MANUAL_ROW] })
  const pending = cli(manual.repo, env, 'sdd', 'verify', 'f')
  assert.equal(pending.out.green, false)
  assert.equal(pending.out.questions[0].row, 'V2')
  const attest = cli(manual.repo, env, 'sdd', 'verify', 'f', '--attest', 'V2')
  assert.equal(attest.out.code, 'approval_missing')
  assert.ok(attest.out.next.includes(pending.out.questions[0].question.question))
})

/** La respuesta del revisor falso a una ronda 1 sin hallazgos. */
const CLEAN_ROUND = '{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":[]}'

/**
 * Un flujo verificable con una revisión de diff ya convergida sobre su código, con `plan.md` (y, si se pide,
 * `spec.md`) como contexto. Devuelve el repositorio, el entorno de un conductor Claude y el id de la revisión.
 */
function reviewedFlow(contexts: string[], planAsDiff = false, frozenHead = false): { repo: string; env: Record<string, string>; id: string; base: string } {
  const { repo, base } = verifyFlow()
  if (planAsDiff) writeFileSync(join(repo, '.git/info/exclude'), '.plans/*\n!.plans/f/\n.plans/f/*\n!.plans/f/plan.md\n.sdd-ai/\n')
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n')
  writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), [
    'schema_version: 1', 'roles:',
    '  code-review:', '    claude:', '      model: opus', '      effort: alto',
    '  refute:', '    claude:', '      model: sonnet', '      effort: medio', '',
  ].join('\n'))
  const bin = realpathTmp()
  symlinkSync(process.execPath, join(bin, 'node'))
  makeFakeBin(bin, 'claude')
  warmFakeBin(bin, 'claude')
  const work = realpathTmp()
  writeFileSync(join(work, 'answers.json'), JSON.stringify([CLEAN_ROUND]))
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp(),
    CODEX_SESSION_ID: '', CODEX_THREAD_ID: '', FAKE_MODE: 'scripted', FAKE_ANSWERS: join(work, 'answers.json'), FAKE_CALLS_FILE: join(work, 'calls'),
  }
  const context = contexts.flatMap((c) => ['--context', c])
  if (frozenHead) {
    gitIn(repo, 'add', 'src', 'test')
    gitIn(repo, 'commit', '-qm', 'candidate')
  }
  const started = cli(repo, env, 'review', 'start', '--base', base, '--author', 'codex', ...context,
    ...(frozenHead ? ['--head', 'HEAD'] : ['--untracked']))
  assert.equal(started.code, 0, JSON.stringify(started.out))
  const id = started.out.id as string
  assert.notEqual(cli(repo, env, 'wait', id, '--max', '20').code, 3, 'la ronda 1 no terminó')
  const status = cli(repo, env, 'review', 'status', id).out
  assert.equal(status.stale, false, JSON.stringify(status))
  return { repo, env, id, base }
}

const reviewStatus = (r: { repo: string; env: Record<string, string>; id: string }) => cli(r.repo, r.env, 'review', 'status', r.id).out
const PLAN = '.plans/f/plan.md'

test('una revisión convergida sigue vigente tras la proyección de verify en su plan de contexto', () => {
  const r = reviewedFlow([PLAN])
  const run = cli(r.repo, r.env, 'sdd', 'verify', 'f')
  assert.equal(run.code, 0, JSON.stringify(run.out))
  assert.equal(run.out.projection, 'written')
  const receipt = readPhaseRecord(r.repo, 'f').verify?.receipts.at(-1)?.id
  const status = reviewStatus(r)
  assert.equal(status.stale, false, JSON.stringify(status))
  assert.deepEqual(status.verify_projection, [{ path: PLAN, receipt }])
  assert.match(status.next, /la revisión está vigente/)
  assert.doesNotMatch(status.next, /review start/)
})

test('una revisión vence con cambios de código, del plan, de otra clave del header o de otro contexto aunque verify haya proyectado', () => {
  const SPEC = '.plans/f/spec.md'
  const cases: Array<[string, (repo: string) => void]> = [
    ['el código', (repo) => writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 2 // otro\n')],
    ['otra sección del plan', (repo) => writeFileSync(join(repo, PLAN), planOf(repo).replace('Uno.', 'Dos.'))],
    ['otra clave del header', (repo) => writeFileSync(join(repo, PLAN), planOf(repo).replace('risk: low', 'risk: high'))],
    ['otro archivo de contexto', (repo) => writeFileSync(join(repo, SPEC), `${readFileSync(join(repo, SPEC), 'utf8')}\n- AC-3: algo más.\n`)],
    ['una edición a mano de Verify', (repo) => writeFileSync(join(repo, PLAN), planOf(repo).replace('✅ passed', '✅ passed (a mano)'))],
    ['un recibo que ya no está', (repo) => rmSync(receiptDir(repo, readPhaseRecord(repo, 'f').verify?.receipts.at(-1)?.id ?? ''), { recursive: true, force: true })],
    ['la salida del recibo alterada', (repo) => {
      const ref = readPhaseRecord(repo, 'f').verify!.receipts.at(-1)!
      const receipt = readVerifyReceipt(repo, ref)
      writeFileSync(join(receiptDir(repo, ref.id), receipt.rows[0].execution!.stdout_file), 'otra salida\n')
    }],
    ['una referencia reciente inválida con un recibo anterior válido', (repo) => {
      appendReceiptRef(repo, 'f', { id: newReceiptId(), mode: 'final', digest: `sha256:${'f'.repeat(64)}` })
    }],
    ['un recibo íntegro de otro flujo', (repo) => {
      const record = readPhaseRecord(repo, 'f')
      const receipt = readVerifyReceipt(repo, record.verify!.receipts.at(-1)!)
      const foreign = writeVerifyReceipt(repo, { ...receipt, flow: 'other' })
      writeFileSync(join(repo, '.plans/f', PHASES_FILE), JSON.stringify({ ...record, verify: { ...record.verify, receipts: [foreign] } }))
    }],
    ['un recibo alterado', (repo) => {
      const file = join(receiptDir(repo, readPhaseRecord(repo, 'f').verify?.receipts.at(-1)?.id ?? ''), 'receipt.json')
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n`)
    }],
  ]
  for (const [what, change] of cases) {
    const r = reviewedFlow([PLAN, SPEC])
    assert.equal(cli(r.repo, r.env, 'sdd', 'verify', 'f').out.projection, 'written', what)
    change(r.repo)
    const status = reviewStatus(r)
    assert.equal(status.stale, true, what)
    assert.equal(status.verify_projection, undefined, what)
    assert.match(status.next, /review start/, what)
  }

  // Un plan revisado como archivo del diff no recibe la excepción reservada al contexto.
  const asDiff = reviewedFlow([], true)
  assert.ok(freeze(asDiff.repo, { base: asDiff.base, context: [], untracked: true }).files.some((f) => f.path === PLAN))
  assert.equal(cli(asDiff.repo, asDiff.env, 'sdd', 'verify', 'f').out.projection, 'written')
  const status = reviewStatus(asDiff)
  assert.equal(status.stale, true)
  assert.equal(status.verify_projection, undefined)
  assert.match(status.next, /review start/)

  // El movimiento del ref sigue siendo observable aunque no se pueda leer la proyección del contexto.
  const atHead = reviewedFlow([PLAN], false, true)
  const frozen = freeze(atHead.repo, { base: atHead.base, head: 'HEAD', context: [PLAN] })
  gitIn(atHead.repo, 'commit', '--allow-empty', '-qm', 'move ref')
  writeFileSync(join(atHead.repo, PLAN), `${planOf(atHead.repo)}\nAnother context section.\n`)
  rmSync(join(atHead.repo, '.sdd-ai', 'runs', atHead.id, 'blobs', frozen.context[0].sha256))
  const unreadable = reviewStatus(atHead)
  assert.equal(unreadable.stale, true)
  assert.equal(unreadable.ref_moved, true)
  assert.equal(unreadable.verify_projection, undefined)
})

/** Una fila `red_on_revert` sobre `src/b.ts`, cuyo candidato agrega `g` y lo usa desde `src/a.ts`. */
const B_ROW = { ...RED_ROW, implementation_paths: ['src/b.ts'] }
const B_BASE = { 'src/b.ts': 'export const h = () => 0\n' }
const B_CANDIDATE = {
  'src/b.ts': 'export const g = () => 2\nexport const h = () => 0\n',
  'src/a.ts': "import { g } from './b.ts'\nexport const f = () => g()\n",
}

test('una confirmación que no carga al revertir es un defecto de contrato con su módulo y la ruta que falta', () => {
  const { repo } = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: B_CANDIDATE })
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp(), CODEX_SESSION_ID: '', CODEX_THREAD_ID: '' }
  const run = cli(repo, env, 'sdd', 'verify', 'f')
  assert.equal(run.out.green, false, JSON.stringify(run.out))
  const [v1] = run.out.rows
  assert.equal(v1.outcome, 'failed')
  assert.equal(v1.confirmation, 'contract_incoherent')
  for (const text of ['src/a.ts', '«g»', 'src/b.ts', 'contract']) assert.ok(v1.reason.includes(text), `${text}: ${v1.reason}`)
  assert.match(v1.reason, /falta src\/a\.ts en implementation_paths/)

  const receipt = readVerifyReceipt(repo, readPhaseRecord(repo, 'f').verify!.receipts.at(-1)!)
  assert.equal(receipt.green, false)
  assert.equal(receipt.rows[0].confirmation?.state, 'contract_incoherent')
  assert.match(receipt.rows[0].confirmation?.reason ?? '', /src\/a\.ts/)
  assert.match(planOf(repo), /revert: contract_incoherent \(/)
  assert.match(planOf(repo), /\| AC-1 \| V1 \| ❌ failed \|/)
  assert.equal(readFileSync(join(repo, 'src', 'b.ts'), 'utf8'), B_CANDIDATE['src/b.ts'])

  // Contraste: si el test sigue pasando con las rutas revertidas, es una refutación del comportamiento.
  const refuted = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: { 'src/b.ts': 'export const h = () => 0 // cambia\n' } })
  const other = cli(refuted.repo, env, 'sdd', 'verify', 'f')
  assert.equal(other.out.rows[0].confirmation, 'refuted')
})

test('una confirmación con el contrato incoherente propone la clase contract', () => {
  const tap = 'TAP version 13\nok 1 - pasa\n'
  const result = (state: 'contract_incoherent' | 'not_confirmable') => ({
    row: 'V1', outcome: 'failed' as const, execution: { ...EXEC, exit_code: 0 },
    confirmation: { row: 'V1', obligation: 'red_on_revert' as const, state, restored: true },
  })
  assert.equal(proposeClass(TROW, result('contract_incoherent'), tap), 'contract')
  assert.equal(proposeClass(TROW, result('not_confirmable'), tap), null)
})

test('el diagnóstico de carga nombra la ruta solo si la evidencia la identifica y no atribuye una aserción opaca', async () => {
  // La evidencia identifica al importador que no está en implementation_paths.
  const named = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: B_CANDIDATE })
  const a = (await final(named.repo)).receipt.rows[0].confirmation
  assert.equal(a?.state, 'contract_incoherent')
  assert.match(a?.reason ?? '', /falta src\/a\.ts en implementation_paths/)

  // Si quien importa es la prueba, la ruta que falta no se puede determinar y no se propone una.
  const direct = verifyFlow({
    rows: [B_ROW, BUILD_ROW], base: B_BASE,
    candidate: {
      'src/b.ts': 'export const g = () => 2\nexport const h = () => 0\n',
      'test/a.test.ts': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { g } from '../src/b.ts'\ntest('f da 2', () => { assert.equal(g(), 2) })\n",
    },
  })
  const b = (await final(direct.repo)).receipt.rows[0].confirmation
  assert.equal(b?.state, 'contract_incoherent')
  assert.match(b?.reason ?? '', /test\/a\.test\.ts es una prueba/)
  assert.match(b?.reason ?? '', /no se puede determinar la ruta que falta/)
  assert.doesNotMatch(b?.reason ?? '', /falta \S+ en implementation_paths/)

  // Una aserción que falla sin diagnóstico de carga conserva su tratamiento: confirmada.
  const opaque = verifyFlow()
  const c = (await final(opaque.repo)).receipt.rows[0].confirmation
  assert.equal(c?.state, 'confirmed')

  // Un subprocess con un fallo de enlace propaga el diagnóstico en el error del test nombrado.
  const subprocessTest = (paths: string[]) => `import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
test('f da 2', () => {
  const errors = []
  for (const path of ${JSON.stringify(paths)}) {
    try { execFileSync(process.execPath, [path], { stdio: 'pipe' }) }
    catch (error) { errors.push(error.message) }
  }
  if (errors.length) throw new Error(errors.join('\\n'))
})\n`
  const propagated = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: {
    ...B_CANDIDATE, 'test/a.test.ts': subprocessTest(['src/a.ts']),
  } })
  const d = (await final(propagated.repo)).receipt.rows[0].confirmation
  assert.equal(d?.state, 'contract_incoherent')
  assert.match(d?.reason ?? '', /falta src\/a\.ts en implementation_paths/)

  // Un diagnóstico sin marcador propio no hereda el importador de otro fallo de carga.
  const unlocated = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: {
    ...B_BASE, 'src/c.ts': 'export const c = 1\n', 'src/d.ts': 'export const d = 1\n',
    'src/e.ts': 'export const e = 1\n',
  }, candidate: {
    ...B_CANDIDATE, 'src/b.ts': 'export const g = () => 2\nexport const h = () => 2\n',
    'src/c.ts': "import { z } from './d.ts'\nexport const c = z\n",
    'src/e.ts': "import { g } from './b.ts'\nexport const e = g()\n",
    'src/unlocated.ts': "import('./e.ts').catch(error => { console.error(error.toString()); process.exitCode = 1 })\n",
    'test/a.test.ts': "import { h } from '../src/b.ts'\n" + subprocessTest(['src/c.ts', 'src/unlocated.ts'])
      .replace('  const errors = []', '  if (h() !== 0) return\n  const errors = []'),
  } })
  const withoutImporter = (await final(unlocated.repo)).receipt.rows[0].confirmation
  assert.equal(withoutImporter?.state, 'confirmed', withoutImporter?.reason ?? '')

  // Los helpers bajo el directorio de pruebas tampoco se proponen como implementación.
  const helper = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: {
    ...B_BASE, 'test/helpers.ts': 'export const f = () => 1\n',
  }, candidate: {
    ...B_CANDIDATE,
    'test/helpers.ts': "import { g } from '../src/b.ts'\nexport const f = () => g()\n",
    'test/a.test.ts': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from './helpers.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n",
  } })
  const helperFailure = (await final(helper.repo)).receipt.rows[0].confirmation
  assert.equal(helperFailure?.state, 'contract_incoherent')
  assert.match(helperFailure?.reason ?? '', /test\/helpers\.ts es una prueba/)
  assert.match(helperFailure?.reason ?? '', /no se puede determinar la ruta que falta/)
  assert.doesNotMatch(helperFailure?.reason ?? '', /falta \S+ en implementation_paths/)

  // Citar un diagnóstico mientras falla una aserción no demuestra que el módulo no cargó.
  const incidental = verifyFlow({ base: { 'src/b.ts': 'export const b = 1\n' }, candidate: { 'src/b.ts': 'export const b = 2\n' } })
  writeFileSync(join(incidental.repo, 'test/a.test.ts'), `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { f } from '../src/a.ts'
test('f da 2', () => {
  if (f() === 1) console.error(${JSON.stringify("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '" + join(incidental.repo, 'src/a.ts') + "' imported from " + join(incidental.repo, 'src/b.ts'))})
  assert.equal(f(), 2)
})\n`)
  const e = (await final(incidental.repo)).receipt.rows[0].confirmation
  assert.equal(e?.state, 'confirmed')

  // Una dependencia externa observable no es una ruta que se pueda agregar al conjunto de revert.
  const external = join(realpathTmp(), 'outside.mjs')
  writeFileSync(external, 'export const h = 1\n')
  const outside = verifyFlow({ rows: [RED_ROW, BUILD_ROW], base: {
    'src/a.ts': `import { g } from ${JSON.stringify(external)}\nexport const f = () => g\n`,
  }, candidate: { 'test/a.test.ts': subprocessTest(['src/a.ts']) } })
  const g = (await final(outside.repo)).receipt.rows[0].confirmation
  assert.equal(g?.state, 'contract_incoherent')
  assert.match(g?.reason ?? '', /outside\.mjs/)
  assert.match(g?.reason ?? '', /no se puede determinar la ruta que falta/)
  assert.doesNotMatch(g?.reason ?? '', /falta \S+ en implementation_paths/)

  // Dos importadores modificados observables no permiten escoger una única ruta que falta.
  const multiple = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: {
    ...B_BASE, 'src/c.ts': 'export const c = 1\n',
  }, candidate: {
    ...B_CANDIDATE, 'src/c.ts': "import { g } from './b.ts'\nexport const c = g()\n",
    'test/a.test.ts': subprocessTest(['src/a.ts', 'src/c.ts']),
  } })
  const h = (await final(multiple.repo)).receipt.rows[0].confirmation
  assert.equal(h?.state, 'contract_incoherent')
  assert.match(h?.reason ?? '', /no hay una única ruta candidata/)
  assert.doesNotMatch(h?.reason ?? '', /falta \S+ en implementation_paths/)
})

test('antes de un verbo se resuelve la restauración que dejó una verificación caída', () => {
  const { repo, base } = verifyFlow()
  const intent = { ...prepareIntent(repo, '20260929-1600-aaaa', base, ['src/a.ts']), owner_pid: spawnSync(process.execPath, ['-e', '']).pid as number, owner_lstart: null }
  writeRestoreIntent(repo, intent)
  revertPaths(repo, intent)
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 1\n')
  const r = cli(repo, {}, 'sdd', 'status', 'f')
  assert.equal(r.code, 0)
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')
  assert.equal(restoreIntentOpen(repo), false)
})

test('una acreditación íntegra de otra fila o de otro flujo no acredita esta', () => {
  const { repo, base } = baseRepo()
  const fp = candidateFingerprint(repo, 'f', base)
  const body = { flow: 'f', observation: 'x', candidate: fp, plan_fingerprint: 'sha256:plan', answered_at: '2026-09-29T10:00:00-05:00' }
  const other = writeAttestation(repo, { ...body, id: '20260929-1000-cccc', row: 'V5', proof_ref: 'toolu_a' })
  const foreign = writeAttestation(repo, { ...body, id: '20260929-1001-dddd', row: 'V4', flow: 'otro', proof_ref: 'toolu_b' })
  // Referencias que dicen V4 pero apuntan a cuerpos de otra fila o de otro flujo.
  const forged = [{ ...other, row: 'V4' }, foreign]
  assert.deepEqual(currentAttestation(repo, forged, 'f', 'V4', fp, 'sha256:plan'), { ref: null, invalid: [foreign.id, other.id] })
})

test('una entrada del TAP con la ruta del archivo de prueba no cuenta aunque se llame como el test', () => {
  const tap = realTap(TAP_FILES)
  const file = tap.match(/^not ok \d+ - (\S*b\.test\.ts)$/m)?.[1] ?? ''
  assert.ok(file.endsWith('b.test.ts'))
  const row: TestRow = { ...TROW, test_name: file, test_paths: [file.slice(file.lastIndexOf('/') + 1)] }
  assert.equal(confirmationOutcome(row, { ...EXEC, exit_code: 1 }, tap), 'not_confirmable')
  assert.equal(evaluateRow(row, { ...EXEC, exit_code: 0 }, { stdout: tap.replace(/^not ok (\d+ - \S*b\.test\.ts)$/m, 'ok $1'), stderr: '' }), 'failed')
})

test('un patrón con retroceso catastrófico no cuelga la evaluación', () => {
  const t = Date.now()
  assert.equal(patternMatches('^(a+)+$', `${'a'.repeat(40)}b`), false)
  assert.ok(Date.now() - t < 10000)
  assert.equal(patternMatches('listo', 'todo listo'), true)
})

test('una salida más grande que el tope de evaluación no da verde si hay que leerla, y el extracto sale del final', async () => {
  const root = realpathTmp()
  const [big] = await executeRows(root, join(root, 'run'), [cmd('V1', [process.execPath, '-e', 'process.stdout.write("x".repeat(33 * 1024 * 1024) + "\\nfinal\\n")'])], new AbortController().signal)
  assert.equal(big.excerpt, 'exit 0; final')
  // Sin patrón, una fila que no es test no lee la salida: el tope no la afecta.
  assert.equal(evaluateRow(cmd('V1', ['x']), big, null), 'passed')
  // Con patrón, o en una fila test, una salida que no se lee entera no da verde.
  assert.equal(evaluateRow(cmd('V1', ['x'], { expect: { exit_code: 0, output_pattern: 'final' } }), big, null), 'failed')
  assert.equal(evaluateRow(TROW, big, null), 'failed')
})

test('al cortar una fila, también terminan los procesos que dejó en su grupo', async () => {
  const root = realpathTmp()
  const pidFile = join(root, 'nieto.pid')
  // El nieto ignora SIGTERM: solo lo termina el SIGKILL al grupo, y la fila tiene que esperar a que muera.
  const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 60000)`
  // El corte llega cuando el nieto ya arrancó, sin depender de cuánto tarda en hacerlo.
  const controller = new AbortController()
  const deadline = Date.now() + 20000
  const poll = setInterval(() => (existsSync(pidFile) || Date.now() > deadline) && controller.abort(), 10)
  const [slow] = await executeRows(root, join(root, 'run'), [cmd('V1', [process.execPath, '-e', script], { timeout_ms: 60000 })], controller.signal)
  clearInterval(poll)
  assert.equal(slow.reason, 'interrupted')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  // La fila no se cierra hasta que su grupo terminó: cuando vuelve, el nieto ya no corre. Puede quedar
  // un instante como zombi hasta que lo recoja init, y un zombi ya no escribe nada.
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  assert.ok(stat === '' || stat.startsWith('Z'), `el nieto sigue corriendo: ${stat}`)
})

test('mientras corre una fila, la reserva de la verificación anota su grupo, y lo quita al terminar', async () => {
  const repo = makeRepo()
  const run = join(realpathTmp(), 'run')
  assert.deepEqual(reserveWriter(repo, '20260929-1500-aaaa', 'verify'), { ok: true })
  const lock = join(repo, '.git', 'sdd-ai', 'writer.lock')
  // La reserva se anota apenas vuelve el lanzamiento, que puede ser después de que la fila arranca: la fila espera verla.
  const show = 'const read = () => JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).group; const end = Date.now() + 3000; '
    + 'const tick = () => (read() !== undefined || Date.now() > end ? process.stdout.write(JSON.stringify({ group: read(), pid: process.pid })) : setTimeout(tick, 10)); tick()'
  const [e] = await executeRows(repo, run, [cmd('V1', [process.execPath, '-e', show, lock])], new AbortController().signal, '', '20260929-1500-aaaa')
  const seen = JSON.parse(readFileSync(join(run, e.stdout_file), 'utf8')) as { group: number; pid: number }
  assert.equal(seen.group, seen.pid)
  assert.equal(readReservation(repo)?.group, undefined)
  assert.equal(readReservation(repo)?.id, '20260929-1500-aaaa')
  releaseWriter(repo, '20260929-1500-aaaa')
})

test('el sha256 de una salida se calcula por partes y coincide con el del contenido entero', () => {
  const file = join(realpathTmp(), 'salida.log')
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 'abc')
  writeFileSync(file, bytes)
  assert.equal(fileSha256(file), `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
})

test('las rutas del contrato tienen que venir normalizadas', () => {
  for (const path of ['src/./a.ts', 'src//a.ts', 'src/', 'src\\a.ts']) {
    const raw = { schema_version: 1, rows: [{ ...RED_ROW, implementation_paths: [path] }, BUILD_ROW] }
    assert.throws(() => admitVerification(raw, ['AC-1', 'AC-2']), /sin normalizar|ruta exterior/, path)
  }
})

test('una confirmación green_on_base revierte, corre y restaura de punta a punta', async () => {
  const GREEN_ROW = { ...RED_ROW, obligation: 'green_on_base', test_name: 'f es una función', test_paths: ['test/b.test.ts'], argv: [process.execPath, '--test', '--test-reporter=tap', 'test/b.test.ts'] }
  const { repo } = verifyFlow({ rows: [GREEN_ROW, BUILD_ROW] })
  writeFileSync(join(repo, 'test', 'b.test.ts'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f es una función', () => { assert.equal(typeof f, 'function') })\n")
  const { receipt } = await final(repo)
  assert.deepEqual([receipt.rows[0].outcome, receipt.rows[0].confirmation?.state, receipt.rows[0].confirmation?.restored], ['passed', 'confirmed', true])
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')
  assert.equal(receipt.green, true)
})

test('si la prueba edita una ruta revertida, la restauración no la pisa y deja la intención abierta', async () => {
  const script = "require('node:fs').writeFileSync('src/a.ts', 'export const f = () => 2 // ' + Date.now() + Math.random()); console.log('ok 1 - f da 2')"
  const { repo } = verifyFlow({ rows: [{ ...RED_ROW, argv: [process.execPath, '-e', script] }, BUILD_ROW] })
  assert.equal(await asyncCode(() => final(repo)), 'restore_conflict')
  assert.match(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), /\/\/ \d+/)
  assert.equal(restoreIntentOpen(repo), true)
  assert.equal(readReservation(repo), undefined)
})

test('la base se mide contra el commit base: un archivo ignorado no la hace medible', async () => {
  const { repo } = verifyFlow({ done: false, implement: false })
  approveAll(repo)
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\ntest/\n')
  writeFileSync(join(repo, 'test', 'a.test.ts'), "import { test } from 'node:test'\ntest('f da 2', () => {})\n")
  const { receipt } = await runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)
  assert.equal(receipt.rows[0].baseline, 'not_measurable')
})

test('una medición que escribe en otro flujo lo lista para limpiar', async () => {
  const { repo } = verifyFlow({ done: false, implement: false, rows: [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', 'require("node:fs").mkdirSync(".plans/otro", { recursive: true }); require("node:fs").writeFileSync(".plans/otro/x.md", "x")'] }] })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.sdd-ai/\n')
  approveAll(repo)
  const { receipt } = await runBaseline(prepareVerify(repo, 'f', 'baseline'), new AbortController().signal)
  assert.deepEqual(receipt.dirtied_paths, ['.plans/otro/x.md'])
})

test('los writers del flujo se ordenan por su arranque dentro del mismo minuto', () => {
  const { repo } = baseRepo()
  const write = (id: string, spawning: string) => {
    const store = join(repo, '.git', 'sdd-ai', 'runs', id)
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'control.json'), JSON.stringify({ id, spawning, phase: { flow: 'f', pending: [], inputs: {}, handoff_header: '' } }))
  }
  write('20260929-1500-ffff', '2026-09-29T20:00:01.000Z')
  write('20260929-1500-0000', '2026-09-29T20:00:30.000Z')
  write('20260929-1459-9999', '2026-09-29T19:59:59.000Z')
  assert.deepEqual(flowWriterRuns(repo, 'f').map((c) => c.id), ['20260929-1459-9999', '20260929-1500-ffff', '20260929-1500-0000'])
})

test('con una verificación en curso, un writer concurrente se niega; y doctor también resuelve una intención caída', () => {
  const { repo, base } = verifyFlow()
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n')
  const encargo = join(realpathTmp(), 'encargo.md')
  writeFileSync(encargo, 'nada\n')
  // Intención abierta con el dueño vivo: el verbo del writer se detiene antes de lanzar.
  const intent = prepareIntent(repo, '20260929-1700-aaaa', base, ['src/a.ts'])
  writeRestoreIntent(repo, intent)
  assert.equal(cli(repo, {}, 'run', '--role', 'implement', '--prompt-file', encargo).out.code, 'verify_in_progress')
  // Sin intención pero con la reserva de la verificación tomada: writer_open.
  closeRestoreIntent(repo)
  reserveWriter(repo, '20260929-1700-aaaa', 'verify')
  assert.equal(cli(repo, {}, 'run', '--role', 'implement', '--prompt-file', encargo).out.code, 'writer_open')
  releaseWriter(repo, '20260929-1700-aaaa')
  // Una intención de un dueño muerto la resuelve también doctor.
  writeRestoreIntent(repo, { ...intent, owner_pid: spawnSync(process.execPath, ['-e', '']).pid as number, owner_lstart: null })
  revertPaths(repo, intent)
  cli(repo, {}, 'doctor')
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const f = () => 2\n')
  assert.equal(restoreIntentOpen(repo), false)
})

test('recibo posterior a la toma: después de una toma, solo un recibo que corrió sobre ella acredita el árbol', async () => {
  const { repo, base } = verifyFlow()
  fakeHarvest(repo, base, { endMark: true })
  const first = await final(repo)
  assert.equal(first.receipt.green, true, JSON.stringify(first.receipt.rows))
  assert.equal(statusOf(repo).next.step, 'review_and_commit')
  // Una toma posterior al recibo: el verde anterior ya no acredita el árbol.
  const phases = join(repo, '.plans', 'f', 'sdd-ai-phases.json')
  const rec = JSON.parse(readFileSync(phases, 'utf8'))
  const at = new Date().toISOString()
  rec.implement = {
    schema: 1, classifications: [], events: [],
    chains: [{ id: 'c1', terminal: { code: 'takeover', at, detail: 'toma' }, entries: [{ kind: 'takeover', id: 't-uno', parent: null, at, map: { ref: 'takeovers/t-uno.json', digest: `sha256:${'c'.repeat(64)}` } }] }],
  }
  writeFileSync(phases, JSON.stringify(rec))
  assert.equal(statusOf(repo).next.step, 'verify')
  // La cadena tampoco da por vigente el verde anterior a la toma, aunque el árbol sea el mismo: pide verificar.
  const chained = withPhaseNext(repo, 'f', statusOf(repo))
  assert.equal(chained.command, './bin/sdd-ai sdd verify f', JSON.stringify(chained))
  // Un recibo nuevo lleva la toma y, en verde, vuelve a acreditar el árbol aunque el writer no cierre.
  const second = await final(repo)
  assert.equal(second.receipt.writer?.takeover, 't-uno')
  assert.equal(second.receipt.green, true)
  assert.equal(statusOf(repo).next.step, 'review_and_commit')
  // Una toma posterior y otra cadena después de ella: el verde anterior a esa toma tampoco acredita el árbol.
  const now = JSON.parse(readFileSync(phases, 'utf8'))
  const later = new Date(Date.now() + 1000).toISOString()
  now.implement.chains = [
    { id: 'c1', terminal: { code: 'takeover', at: later, detail: 'toma' }, entries: [{ kind: 'takeover', id: 't-dos', parent: null, at: later, map: { ref: 'takeovers/t-dos.json', digest: `sha256:${'d'.repeat(64)}` } }] },
    { id: 'c2', terminal: null, entries: [{ kind: 'implement', run: '20260929-2359-beef', parent: 't-dos', at: later, pending: ['T1'] }] },
  ]
  writeFileSync(phases, JSON.stringify(now))
  assert.equal(statusOf(repo).next.step, 'verify')
})
