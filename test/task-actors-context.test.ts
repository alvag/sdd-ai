import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actorFlow, implementationReport, writer, launch, harvest, tasksPath, legacyFlow, documentFlow, documentContract, superviseDocument } from './task-actors-fixture.ts'
import { redFlow, BUILD_ROW, classesFile } from './chain-cli-fixture.ts'

test('missing_context visible no invalida done ni convierte pending en completitud o prueba humana', () => {
  for (const pending of [false, true]) for (const missing of [[], ['El conductor debe aportar la entrada sintética']]) {
    const s = actorFlow([{ id: 'T1', actor: 'writer' }, { id: 'T2', actor: 'conductor' }, { id: 'T3', actor: 'user' }], [
      writer(implementationReport(pending ? [] : ['T1'], pending ? ['T1'] : [], missing)),
    ])
    const before = readFileSync(tasksPath(s), 'utf8')
    const approvals = readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.json'), 'utf8')
    const first = launch(s)
    const h = harvest(s, first.out.id)
    assert.equal(h.out.contract.admitted, true, JSON.stringify(h.out))
    assert.deepEqual(h.out.missing_context, missing)
    assert.deepEqual(h.out.contract.missing_context, missing)
    assert.equal((h.out.failed ?? []).some((f: string) => /faltó contexto/.test(f)), false)
    assert.deepEqual(h.out.covered, pending ? [] : ['T1'])
    assert.deepEqual(h.out.left, pending ? ['T1'] : [])
    // Los faltantes van como datos en su campo: la orientación solo remite a ellos, sin copiar su texto.
    if (missing.length) assert.match(h.out.next, /revisa missing_context/)
    for (const m of missing) assert.equal(h.out.next.includes(m), false)
    assert.deepEqual(h.out.external_pending.map((t: { id: string }) => t.id), ['T2', 'T3'])
    assert.equal(readFileSync(tasksPath(s), 'utf8'), before)
    assert.equal(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.json'), 'utf8'), approvals)
    assert.equal(existsSync(join(s.repo, '.git', 'sdd-ai', 'verify')), false)
    const phase = JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8'))
    assert.equal(phase.verify, undefined)
  }
  const old = legacyFlow(1, writer(implementationReport(['T1'], [], ['Entrada del conductor'], { legacyContract: true })))
  const received = harvest(old.s, old.run)
  assert.equal(received.out.contract.admitted, true)
  assert.deepEqual(received.out.contract.missing_context, ['Entrada del conductor'])
  assert.equal((received.out.failed ?? []).some((f: string) => /faltó contexto/.test(f)), false)
})

test('fix y las fases documentales mantienen el tratamiento de sus faltantes', () => {
  const missing = ['Entrada del conductor']
  const report = JSON.stringify({ phase: 'fix', missing_context: missing, rows: [{ id: 'V1', changed: 'Cambio sintético', deviation: null }] }) + '\nSTATUS: done\n'
  const { s, receipt } = redFlow([BUILD_ROW('V1', 1)], [writer(report, 'export const f = () => 4\n')])
  const classes = classesFile(s, receipt, [['V1', 'implementation']])
  const fix = launch(s, '--classes', classes)
  assert.equal(fix.code, 0, JSON.stringify(fix.out))
  const h = harvest(s, fix.out.id)
  assert.ok(h.out.failed.some((f: string) => /faltó contexto/.test(f)))
  assert.deepEqual(h.out.contract.missing_context, missing)
  const doc = superviseDocument(documentFlow([JSON.stringify(documentContract({ missing }))]))
  assert.equal(doc.result.outcome, 'awaiting_context')
  assert.deepEqual(doc.result.missing_context, missing)
})
