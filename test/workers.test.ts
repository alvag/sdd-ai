import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeLaunch, claudeRetry } from '../src/workers/claude.ts'
import { codexLaunch, codexRetry } from '../src/workers/codex.ts'
import type { WorkerTask } from '../src/types.ts'

const t: WorkerTask = {
  cwd: '/r', promptFile: '/r/p.md', resultFile: '/r/out.md', sessionId: 'S', model: 'opus', effort: 'high',
}

test('claude -p aislado, read-only y con stream', () => {
  const l = claudeLaunch(t)
  assert.equal(l.cmd, 'claude')
  assert.equal(l.cwd, '/r')
  assert.equal(l.stdinFile, '/r/p.md')
  assert.deepEqual(l.args, [
    '-p', '--safe-mode', '--tools=Read,Grep,Glob', '--permission-prompts', 'none',
    '--output-format', 'stream-json', '--verbose', '--session-id', 'S', '--model', 'opus', '--effort', 'high',
  ])
})

test('codex exec aislado, read-only y con resultado a archivo', () => {
  const l = codexLaunch({ ...t, model: 'gpt-6-sol' })
  assert.equal(l.cmd, 'codex')
  assert.equal(l.stdinFile, '/r/p.md')
  assert.deepEqual(l.args, [
    'exec', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '-s', 'read-only', '-C', '/r', '--json', '--output-last-message', '/r/out.md',
    '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '-',
  ])
})

test('sin modelo ni esfuerzo no se emiten esas flags', () => {
  const bare: WorkerTask = { cwd: '/r', promptFile: '/r/p.md', resultFile: '/r/out.md', sessionId: 'S' }
  const c = claudeLaunch(bare).args
  const x = codexLaunch(bare).args
  for (const flag of ['--model', '--effort']) assert.equal(c.includes(flag), false)
  for (const flag of ['-m', '-c']) assert.equal(x.includes(flag), false)
})

test('el prompt viaja por stdin, nunca en el argv', () => {
  for (const l of [claudeLaunch(t), codexLaunch(t)]) {
    assert.equal(l.stdinFile, t.promptFile)
    assert.equal(l.args.includes(t.promptFile), false)
  }
})

const bare: WorkerTask = { cwd: '/r', promptFile: '/r/p.md', resultFile: '/r/out.md', sessionId: 'S' }

test('claudeRetry quita el campo rechazado y cambia la sesión', () => {
  const args = claudeLaunch(t).args
  const head = ['-p', '--safe-mode', '--tools=Read,Grep,Glob', '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose']
  assert.deepEqual(claudeRetry(args, 'model', 'S2'), { requested: 'opus', args: [...head, '--session-id', 'S2', '--effort', 'high'] })
  assert.deepEqual(claudeRetry(args, 'effort', 'S2'), { requested: 'high', args: [...head, '--session-id', 'S2', '--model', 'opus'] })
  assert.equal(claudeRetry(claudeLaunch(bare).args, 'model', 'S2'), null)
  assert.equal(claudeRetry(claudeLaunch(bare).args, 'effort', 'S2'), null)
})

test('codexRetry quita -m o el par -c model_reasoning_effort', () => {
  const args = codexLaunch(t).args
  const head = [
    'exec', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '-s', 'read-only', '-C', '/r', '--json', '--output-last-message', '/r/out.md',
  ]
  assert.deepEqual(codexRetry(args, 'model'), { requested: 'opus', args: [...head, '-c', 'model_reasoning_effort=high', '-'] })
  assert.deepEqual(codexRetry(args, 'effort'), { requested: 'high', args: [...head, '-m', 'opus', '-'] })
  assert.equal(codexRetry(codexLaunch(bare).args, 'model'), null)
  assert.equal(codexRetry(codexLaunch(bare).args, 'effort'), null)
})
