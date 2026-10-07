import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, cli, AS_CODEX, requestOf } from './cli-run-fixture.ts'
import { findingsInstructions, FINDING_REPORT_SCHEMA } from '../src/findings.ts'
import { withWorkerPolicy } from '../src/worker-policy.ts'

const roles = ['explore', 'investigate', 'counter-plan', 'debate', 'design-review']
const promptOf = (repo: string, id: string) => readFileSync(join(repo, '.sdd-ai/runs', id, 'prompt.md'), 'utf8')

test('run congela el reporte de hallazgos para sus cinco roles y no cambia retries ni refute', () => {
  for (const native of [false, true]) {
    const s = setup({ families: '[codex]', bins: ['codex'] })
    const env = native ? AS_CODEX : {}
    if (native) assert.equal(cli(s, ['agents', 'sync'], env).code, 0)
    const original = readFileSync(s.prompt, 'utf8')
    for (const role of roles) {
      const r = cli(s, ['run', '--role', role, '--prompt-file', s.prompt], env)
      assert.equal(r.code, 0, JSON.stringify(r))
      assert.equal(r.out.via, native ? 'native' : 'process')
      assert.equal(promptOf(s.repo, r.out.id), withWorkerPolicy(`${original}\n\n${findingsInstructions('run')}`))
      if (!native) assert.equal(cli(s, ['wait', r.out.id, '--max', '20']).code, 0)
      const retry = cli(s, ['run', '--retry', r.out.id], env)
      assert.equal(retry.code, 0, JSON.stringify(retry))
      assert.equal(promptOf(s.repo, retry.out.id), promptOf(s.repo, r.out.id))
      assert.equal(requestOf(s.repo, retry.out.id).retry_of, r.out.id)
      if (!native) cli(s, ['wait', retry.out.id, '--max', '20'])
    }
    for (const role of ['refute', 'code-review']) {
      const r = cli(s, ['run', '--role', role, '--prompt-file', s.prompt], env)
      assert.equal(promptOf(s.repo, r.out.id), withWorkerPolicy(original))
      if (!native) cli(s, ['wait', r.out.id, '--max', '20'])
    }
    // Un prompt congelado anterior al canal tampoco se reescribe al reintentar.
    const old = cli(s, ['run', '--role', 'explore', '--prompt-file', s.prompt], env)
    if (!native) cli(s, ['wait', old.out.id, '--max', '20'])
    const frozen = withWorkerPolicy('Encargo anterior\n')
    writeFileSync(join(s.repo, '.sdd-ai/runs', old.out.id, 'prompt.md'), frozen)
    const retry = cli(s, ['run', '--retry', old.out.id], env)
    assert.equal(promptOf(s.repo, retry.out.id), frozen)
    if (!native) cli(s, ['wait', retry.out.id, '--max', '20'])
  }
})

test('el reporte de run para un encargo JSON pide findings dentro del objeto', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  assert.equal(cli(s, ['agents', 'sync'], AS_CODEX).code, 0)
  for (const schema of ['{"answer":"texto","findings":[]}', '{"answer":"texto"}']) {
    writeFileSync(s.prompt, `Responde un único objeto JSON con este esquema cerrado: ${schema}`)
    const r = cli(s, ['run', '--role', 'investigate', '--prompt-file', s.prompt], AS_CODEX)
    const p = promptOf(s.repo, r.out.id)
    assert.ok(p.includes(FINDING_REPORT_SCHEMA))
    assert.ok(p.includes('usa findings dentro del objeto'))
    assert.ok(p.includes('Ante un esquema cerrado sin findings, respeta el esquema sin añadir claves ni prosa'))
    assert.equal(p, withWorkerPolicy(`${readFileSync(s.prompt, 'utf8')}\n\n${findingsInstructions('run')}`))
  }
})
