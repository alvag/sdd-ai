import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidateFingerprint } from '../src/git.ts'
import { appendReceiptRef, latestFinalReceipt, readPhaseRecord, withPhaseNext } from '../src/sdd/phase-state.ts'
import { fileSha256, receiptDir } from '../src/sdd/verify-receipt.ts'
import { attestRow, prepareVerify, runBaseline } from '../src/sdd/verify.ts'
import { attestQuestion } from '../src/approval/question.ts'
import { prove } from '../src/approval/proof.ts'
import { randomUUID } from 'node:crypto'
import { readHeader, section } from '../src/sdd/markdown.ts'
import { readFlow } from '../src/sdd/read.ts'
import { ownReservation, releaseReservation } from '../src/writer-store.ts'
import {
  realpathTmp, TASKS_MD, RED_ROW, BUILD_ROW, approveAll, verifyFlow, planOf, statusOf, final, asyncCode, fakeHarvest,
  MANUAL_ROW, answered, cli, reviewedFlow, reviewStatus, PLAN,
} from './sdd-verify-fixture.ts'

test('el next de --attest y el de status saltan las filas ya acreditadas', async () => {
  const { repo, base } = verifyFlow({ rows: [RED_ROW, MANUAL_ROW, { ...MANUAL_ROW, id: 'V3' }] })
  fakeHarvest(repo, base, { endMark: true })
  const { receipt } = await final(repo)
  assert.equal(receipt.green, false)
  for (const [row, next] of [['V2', './bin/sdd-ai sdd verify f --attest V3'], ['V3', './bin/sdd-ai sdd verify f']]) {
    const q = attestQuestion('f', row, MANUAL_ROW.observation, candidateFingerprint(repo, 'f', base), receipt.plan_fingerprint)
    const env = { ...answered(q, 'Acreditar'), CODEX_SESSION_ID: '', CODEX_THREAD_ID: '' }
    const attested = cli(repo, env, 'sdd', 'verify', 'f', '--attest', row)
    assert.equal(attested.code, 0, JSON.stringify(attested.out))
    assert.equal(attested.out.next.command, next)
    assert.equal(cli(repo, env, 'sdd', 'status', 'f').out.next.command, next)
  }
})

test('una fila manual queda pendiente hasta acreditarla, y la acreditación vence con el árbol o el plan', async () => {
  const { repo } = verifyFlow({ rows: [RED_ROW, MANUAL_ROW] })
  const pending = await final(repo)
  assert.deepEqual([pending.receipt.rows[1].outcome, pending.receipt.rows[1].execution?.excerpt, pending.receipt.rows[1].baseline], ['unrun', 'exit -; manual', 'missing'])
  assert.ok(pending.receipt.rows[1].execution?.started_at)
  assert.equal(pending.receipt.green, false)

  // Sin respuesta, --attest pide la pregunta canónica; una fila que no es manual o no existe es un error de uso.
  const start = prepareVerify(repo, 'f', 'final')
  assert.equal(releaseReservation(start.reservation).state, 'released')
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
  assert.equal(releaseReservation(start.reservation).state, 'released')
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
  assert.equal(ownReservation(repo), undefined)

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
  releaseReservation(prepareVerify(repo, 'f', 'final').reservation)
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
