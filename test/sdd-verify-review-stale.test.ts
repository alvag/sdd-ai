import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freeze } from '../src/review/candidate.ts'
import { PHASES_FILE, appendReceiptRef, readPhaseRecord } from '../src/sdd/phase-state.ts'
import { newReceiptId, readVerifyReceipt, receiptDir, writeVerifyReceipt } from '../src/sdd/verify-receipt.ts'
import { gitIn, planOf, cli, reviewedFlow, reviewStatus, PLAN } from './sdd-verify-fixture.ts'

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
