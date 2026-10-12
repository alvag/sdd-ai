import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { sessionFile } from '../src/approval/session.ts'
import { type Ledger } from '../src/review/ledger.ts'
import { bytesHash } from '../src/sdd/read.ts'
import { answer, calls, cleanup, entries, json, makeFixture, prompts, put, questionFrom, record, revise, runFile, saveRecord, settle } from './phase-revision-fixture.ts'

test('el encargo conserva fuentes distingue aceptados decisiones y aporte del conductor y limita el alcance', async () => {
  for (const artifact of ['spec', 'plan', 'tasks'] as const) for (const decisions of [false, true]) {
    const s = makeFixture({ artifact })
    try {
      const l = json<Ledger>(runFile(s, s.review, 'ledger.json'))
      l.entries[0].superseded = [{ action: 'reject', reason: 'Motivo anterior.', from: 'en-disputa', after_round: 1 }]
      l.entries[0].responses = [{ round: 1, answer: 'unresolved', evidence: 'Respuesta de disputa.' }]
      l.entries.push({ ...structuredClone(l.entries[0]), id: 'F-2', state: 'rechazado', claim: 'Contexto rechazado.',
        decision: { action: 'reject', from: 'abierto', after_round: 1, reason: 'El pedido ya lo dice.' }, responses: [] },
      { ...structuredClone(l.entries[0]), id: 'F-3', state: 'informativo', claim: 'Defecto contextual.', of: 'context.md', responses: [], decision: undefined })
      l.next_id = 4; put(runFile(s, s.review, 'ledger.json'), l)
      const contribution = 'Max aclara el resultado sin cambiar el alcance.\n'
      writeFileSync(`${s.repo}/decisions.md`, contribution)
      const historical = 'Ampliación histórica presente.\n'
      const originRecord = record(s)
      writeFileSync(runFile(s, s.origin, 'historical.md'), historical)
      originRecord.documents![artifact === 'spec' ? 'specify' : artifact]!.amendments.push({ path: 'historical.md', copy: `.sdd-ai/runs/${s.origin}/historical.md`, digest: bytesHash(historical), role: 'context' })
      saveRecord(s, originRecord)
      const document = readFileSync(`${s.repo}/${s.selection.artifact}`, 'utf8')
      const start = revise(s, decisions ? ['--decisions', 'decisions.md'] : [])
      assert.equal(start.code, 0, JSON.stringify(start.out)); await settle(s, start.out.id)
      const prompt = prompts(s)[0]
      assert.ok(prompt.includes(document)); assert.ok(prompt.includes('revisión review-run, ronda 1'))
      assert.match(prompt, /No implementes, no cambies otros artefactos y no amplíes el alcance aprobado/)
      assert.match(prompt, /Los hallazgos no sustituyen el pedido ni los insumos aprobados/)
      assert.ok(prompt.includes('Motivo anterior.')); assert.ok(prompt.includes('Respuesta de disputa.')); assert.ok(prompt.includes('El pedido ya lo dice.'))
      const orders = prompt.split('<<<ACEPTADOS\n')[1].split('\nACEPTADOS>>>')[0]
      assert.deepEqual(JSON.parse(orders).map((e: { id: string }) => e.id), ['F-1'])
      const entry = entries(s).at(-1)!
      for (const ref of entry.materials) {
        const copy = readFileSync(`${s.repo}/${ref.copy}`)
        assert.equal(bytesHash(copy), ref.digest)
        assert.ok(prompt.includes(copy.toString('utf8')))
      }
      for (const input of s.selection.inputs) assert.ok(prompt.includes(readFileSync(`${s.repo}/${input.path}`, 'utf8')))
      assert.equal(entry.conductor?.digest, decisions ? bytesHash(contribution) : undefined)
      assert.ok(prompt.includes(historical)); assert.ok(prompt.includes(readFileSync(`${s.repo}/context.md`, 'utf8')))
      assert.ok(prompt.includes('Defecto contextual.')); assert.ok(!orders.includes('Defecto contextual.'))
      if (decisions) {
        assert.match(prompt, /Aporte del conductor; sin autoridad sobre pedido ni insumos aprobados/)
        assert.ok(prompt.split('Aporte del conductor; sin autoridad sobre pedido ni insumos aprobados')[1].includes(contribution))
      } else assert.ok(!prompt.includes('Aporte del conductor; sin autoridad sobre pedido ni insumos aprobados'))
      assert.equal(readFileSync(runFile(s, s.review, 'ledger.json'), 'utf8'), `${JSON.stringify(l, null, 2)}\n`)
    } finally { await cleanup(s) }
  }
  for (const fresh of [false, true]) {
    const s = makeFixture()
    try {
      const r = record(s); const origin = r.documents!.specify!
      origin.amendments.push({ path: 'historical.md', copy: `.sdd-ai/runs/${s.origin}/historical.md`, digest: bytesHash('Ampliación histórica.\n'), role: 'context' })
      saveRecord(s, r)
      if (fresh) {
        rmSync(sessionFile(s.env, { runner: s.family, session: s.session }))
        const refused = revise(s, ['--new-session']); answer(s, questionFrom(refused.out))
        assert.equal(revise(s, ['--new-session']).out.code, 'material_missing'); assert.equal(calls(s).length, 0)
      } else {
        const start = revise(s); assert.equal(start.code, 0, JSON.stringify(start.out)); await settle(s, start.out.id)
        assert.match(prompts(s)[0], /Copia histórica ausente: historical.md/)
      }
    } finally { await cleanup(s) }
  }
})
