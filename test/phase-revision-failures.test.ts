import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { calls, cleanup, cli, corrected, entries, flowFile, makeFixture, record, revise, script, settle, snapshotFiles, waitFor } from './phase-revision-fixture.ts'

test('los fallos conservan el documento y el contexto permite continuar con el productor', async (t) => {
  for (const mode of ['startup', 'execution', 'contract', 'cancel', 'timeout']) {
    const s = makeFixture()
    const barrier = join(s.work, 'release')
    try {
      script(s, mode === 'startup' ? [{ startup_failure: true }] : mode === 'execution' ? [{ execution_failure: true }]
        : mode === 'contract' ? [{ answer: 'inadmisible' }, { answer: 'inadmisible' }]
          : [{ ...(mode === 'cancel' ? { barrier } : { hang: true }), answer: JSON.stringify(corrected('spec')) }, { hang: true }])
      const before = snapshotFiles(s)
      const start = revise(s, mode === 'timeout' ? ['--deadline', '1'] : [])
      assert.equal(start.code, 0, JSON.stringify(start.out))
      if (mode === 'cancel') { await waitFor(`${barrier}.ready`); cli(s, ['cancel', start.out.id]); writeFileSync(barrier, '') }
      // El cierre de timeout usa el límite real del supervisor; no crea otra sesión.
      const result = mode === 'timeout' ? cli(s, ['wait', start.out.id, '--max', '15']) : await settle(s, start.out.id)
      assert.equal(result.out.outcome, mode === 'startup' ? 'launch_failed' : mode === 'execution' ? 'failed' : mode === 'contract' ? 'not_admitted' : mode === 'cancel' ? 'cancelled' : 'timeout', JSON.stringify(result.out))
      assert.deepEqual(snapshotFiles(s), before)
      assert.equal(record(s).revisions!.barriers.length, 0)
      assert.ok(calls(s).every((args) => args[args.length - 2] === s.session))
    } finally { writeFileSync(barrier, ''); await cleanup(s) }
  }
  // Impedimento real al escribir el destino, después de tomar los locks y admitir el contrato.
  const unwritable = makeFixture()
  const barrier = join(unwritable.work, 'write-release')
  const target = flowFile(unwritable, 'spec.md')
  const flag = (on: boolean) => spawnSync(process.platform === 'darwin' ? 'chflags' : 'chattr',
    [process.platform === 'darwin' ? on ? 'uchg' : 'nouchg' : on ? '+i' : '-i', target], { encoding: 'utf8' })
  let marked = false
  try {
    const before = snapshotFiles(unwritable)
    script(unwritable, [{ barrier, answer: JSON.stringify(corrected('spec')) }])
    const start = revise(unwritable); assert.equal(start.code, 0, JSON.stringify(start.out))
    await waitFor(`${barrier}.ready`)
    const mark = flag(true); marked = mark.status === 0
    if (!marked) {
      assert.notEqual(process.platform, 'darwin', `chflags obligatorio en macOS: ${mark.stderr}`)
      t.diagnostic('omitido: impedimento de escritura con marca inmutable sin permiso o soporte')
    } else {
      writeFileSync(barrier, '')
      const failed = await settle(unwritable, start.out.id)
      assert.equal(failed.out.outcome, 'not_published'); assert.equal(failed.out.cause, 'publish_interrupted')
      assert.deepEqual(snapshotFiles(unwritable), before)
      assert.equal(record(unwritable).revisions!.barriers.length, 0)
      assert.equal(record(unwritable).revisions!.active, undefined)
      assert.equal(record(unwritable).revisions!.intent!.resolved, true)
    }
  } finally {
    if (marked) assert.equal(flag(false).status, 0)
    writeFileSync(barrier, ''); await cleanup(unwritable)
  }
  const s = makeFixture()
  try {
    const initial = snapshotFiles(s)
    const creation = structuredClone(record(s).phases)
    const c = corrected('spec'); c.blocking_questions = ['¿Qué resultado?']; c.missing_context = ['Fuente que lo observa.']
    script(s, [{ answer: JSON.stringify(c) }])
    const first = revise(s); await settle(s, first.out.id)
    assert.equal(entries(s).at(-1)!.state, 'awaiting_context'); assert.equal(record(s).revisions!.active, undefined)
    assert.deepEqual(snapshotFiles(s), initial)
    writeFileSync(`${s.repo}/context-one.md`, 'Max: resultado público. Fuente: src/a.ts.\n')
    assert.equal(cli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--context', 'context-one.md', '--review', 'other-review']).out.code, 'review_mismatch')
    assert.equal(revise(s, ['--new-session']).out.code, 'session_recoverable')
    assert.equal(entries(s).at(-1)!.state, 'awaiting_context')
    script(s, [{ answer: JSON.stringify(c) }])
    const second = cli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--context', 'context-one.md'])
    assert.equal(second.code, 0, JSON.stringify(second.out)); await settle(s, second.out.id)
    assert.equal(entries(s).at(-1)!.parent_run, first.out.id)
    writeFileSync(`${s.repo}/context-two.md`, 'Max confirma el resultado.\n')
    script(s, [{ answer: JSON.stringify(corrected('spec')) }])
    const third = cli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--context', 'context-two.md'])
    assert.equal(third.code, 0, JSON.stringify(third.out)); assert.equal((await settle(s, third.out.id)).out.outcome, 'published')
    const prompt = readFileSync(`${s.repo}/.sdd-ai/runs/${third.out.id}/prompt.md`, 'utf8')
    assert.ok(prompt.includes('Max: resultado público.')); assert.ok(prompt.includes('Max confirma'))
    assert.deepEqual(record(s).phases, creation)
    assert.equal(cli(s, ['sdd', 'phase', 'f', '--revise', 'spec', '--context', 'context-two.md']).out.code, 'context_not_expected')
    assert.ok(entries(s).every((e) => e.session_id === s.session))
  } finally { await cleanup(s) }
  const superseded = makeFixture()
  try {
    const c = corrected('spec'); c.blocking_questions = ['¿Qué resultado?']
    script(superseded, [{ answer: JSON.stringify(c) }]); const first = revise(superseded); await settle(superseded, first.out.id)
    script(superseded, [{ answer: JSON.stringify(corrected('spec')) }]); const second = revise(superseded); await settle(superseded, second.out.id)
    assert.equal(entries(superseded)[0].state, 'superseded')
    assert.equal(cli(superseded, ['sdd', 'phase', 'f', '--revise', 'spec', '--context', 'context.md']).out.code, 'context_not_expected')
  } finally { await cleanup(superseded) }
})
