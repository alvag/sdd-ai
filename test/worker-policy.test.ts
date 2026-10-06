import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { WORKER_POLICY } from '../src/worker-policy.ts'
import { chainFlow, chainSetup, fakePrompts, runBin } from './helpers.ts'
import { implReport, promptFile } from './chain-cli-fixture.ts'
import { setup as nativeSetup, cli as nativeCli } from './cli-run-fixture.ts'

test('run phase y review despachan la prevención y sync renueva agentes antiguos', () => {
  const s = chainSetup({ writers: [
    { actions: [{ write: 'src/one.ts', content: 'one\n' }], report: implReport(['T1'], ['T2']) },
    { actions: [{ write: 'src/two.ts', content: 'two\n' }], report: implReport(['T2']) },
  ] })
  chainFlow(s, { tasks: 2 })
  const first = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(first.code, 0, JSON.stringify(first.out))
  runBin(s, ['wait', first.out.id, '--max', '30'])
  const continuation = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(continuation.code, 0, JSON.stringify(continuation.out))
  runBin(s, ['wait', continuation.out.id, '--max', '30'])
  for (const prompt of fakePrompts(s)) assert.equal(prompt.split(WORKER_POLICY).length - 1, 1)

  const loose = chainSetup({ writers: [{}, {}] })
  const input = promptFile()
  let launched = runBin(loose, ['run', '--role', 'implement', '--prompt-file', input])
  assert.equal(launched.code, 0, JSON.stringify(launched.out))
  const id = launched.out.id
  runBin(loose, ['wait', id, '--max', '30'])
  launched = runBin(loose, ['run', '--retry', id])
  assert.equal(launched.code, 0, JSON.stringify(launched.out))
  runBin(loose, ['wait', launched.out.id, '--max', '30'])
  for (const prompt of fakePrompts(loose)) assert.equal(prompt.split(WORKER_POLICY).length - 1, 1)

  const review = runBin(s, ['review', 'start', '--base', s.base, '--author', 'claude', '--untracked', '--conductor', 'claude'])
  assert.equal(review.code, 0, JSON.stringify(review.out))
  runBin(s, ['wait', review.out.id, '--max', '30'])
  const dir = join(s.repo, '.sdd-ai/runs', review.out.id)
  const prompts = readdirSync(dir).filter((name) => /^prompt.*\.md$/.test(name))
  assert.ok(prompts.length > 0)
  for (const name of prompts) {
    const prompt = readFileSync(join(dir, name), 'utf8')
    assert.equal(prompt.split(WORKER_POLICY).length - 1, 1)
    assert.match(prompt, /No tienes herramientas/)
  }
  assert.equal(runBin(s, ['agents', 'sync']).code, 0)
  const agent = join(s.repo, '.claude/agents/sdd-ai-explore.md')
  const fresh = readFileSync(agent, 'utf8')
  writeFileSync(agent, fresh.replace(/^- No ejecutes `claude`.*\n/m, ''))
  assert.notEqual(readFileSync(agent, 'utf8'), fresh)
  assert.equal(runBin(s, ['agents', 'sync']).code, 0)
  assert.equal(readFileSync(agent, 'utf8'), fresh)

  const native = nativeSetup({ families: '[claude]' })
  assert.equal(nativeCli(native, ['agents', 'sync']).code, 0)
  const delegated = nativeCli(native, ['run', '--prompt-file', native.prompt, '--role', 'explore'])
  assert.equal(delegated.code, 0, JSON.stringify(delegated.out))
  assert.equal(delegated.out.via, 'native')
  const dispatched = readFileSync(delegated.out.prompt_file, 'utf8')
  assert.equal(dispatched.split(WORKER_POLICY).length - 1, 1)
  assert.ok(dispatched.endsWith(readFileSync(native.prompt, 'utf8')))
  const nativeRetry = nativeSetup({ families: '[codex]' })
  const failed = nativeCli(nativeRetry, ['run', '--prompt-file', nativeRetry.prompt])
  assert.equal(failed.out.reason, 'cli_missing')
  assert.equal(nativeCli(nativeRetry, ['agents', 'sync']).code, 0)
  const retried = nativeCli(nativeRetry, ['run', '--retry', failed.out.id, '--families', 'claude'])
  assert.equal(retried.code, 0, JSON.stringify(retried.out))
  assert.equal(readFileSync(retried.out.prompt_file, 'utf8').split(WORKER_POLICY).length - 1, 1)
})
