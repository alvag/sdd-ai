import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidateFingerprint, harvestTreeWithout } from '../src/git.ts'
import {
  PHASES_FILE, appendAttestationRef, appendReceiptRef, latestFinalReceipt, readPhaseRecord, withFlowLock,
} from '../src/sdd/phase-state.ts'
import {
  type Attestation, currentAttestation, fileSha256, newReceiptId, readAttestation, readVerifyReceipt, receiptDir,
  writeAttestation, writeVerifyReceipt,
} from '../src/sdd/verify-receipt.ts'
import { confirmationOutcome, evaluateRow, excerpt, executeRows, parseTap, prepareVerify } from '../src/sdd/verify.ts'
import { type CommandRow } from '../src/sdd/verification-contract.ts'
import { readHeader, section } from '../src/sdd/markdown.ts'
import { readReservation } from '../src/writer-store.ts'
import {
  realpathTmp, gitIn, baseRepo, codeOf, sampleReceipt, realTap, TAP_FILES, EXEC, TROW, cmd, RED_ROW, BUILD_ROW, planMd,
  approveAll, verifyFlow, planOf, statusOf, final, asyncCode, fakeHarvest, cli,
} from './sdd-verify-fixture.ts'

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
  // Una ruta nueva no tiene una base que revertir: el flujo se bloquea antes de ejecutar la fila.
  assert.equal(codeOf(() => prepareVerify(fresh.repo, 'f', 'final')), 'flow_blocked')
})

test('una fila que revierte un archivo nuevo en el cambio bloquea el flujo y approve se niega', () => {
  const rows = [{ ...RED_ROW, implementation_paths: ['src/nueva.ts'] }, BUILD_ROW]
  const { repo, base } = verifyFlow({ rows })
  const status = cli(repo, {}, 'sdd', 'status', 'f')
  assert.equal(status.code, 0)
  const reason = status.out.blocked_reasons.find((r: { code: string }) => r.code === 'revert_path_not_in_base')
  assert.ok(reason)
  assert.match(reason.detail, /V1/)
  assert.match(reason.detail, /src\/nueva\.ts/)
  const refused = cli(repo, {}, 'sdd', 'approve', 'f', 'plan')
  assert.notEqual(refused.code, 0)
  assert.equal(refused.out.code, 'approve_rejected')
  assert.match(refused.out.detail, /revert_path_not_in_base/)

  const noRevert = verifyFlow({ rows: [{ ...rows[0], obligation: 'none', obligation_reason: 'sin seam' }, BUILD_ROW] })
  assert.equal(cli(noRevert.repo, {}, 'sdd', 'status', 'f').out.blocked_reasons.some((r: { code: string }) => r.code === 'revert_path_not_in_base'), false)

  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), planMd(base, 'implementing', [{ ...RED_ROW, implementation_paths: ['src/a.ts'] }, BUILD_ROW]))
  assert.equal(cli(repo, {}, 'sdd', 'status', 'f').out.blocked_reasons.some((r: { code: string }) => r.code === 'revert_path_not_in_base'), false)
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
