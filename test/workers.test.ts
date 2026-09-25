import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEWER_SYSTEM_PROMPT, claudeLaunch, claudeResume, claudeRetry, claudeReviewLaunch, withSessionId,
} from '../src/workers/claude.ts'
import { codexLaunch, codexResume, codexRetry, codexReviewLaunch } from '../src/workers/codex.ts'
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

test('claudeResume cambia --session-id por --resume y conserva el resto', () => {
  const args = claudeLaunch(t).args
  assert.deepEqual(claudeResume(args), args.map((a) => (a === '--session-id' ? '--resume' : a)))
  assert.equal(claudeResume(['-p', '--verbose']), null)
})

test('codexResume pasa a exec resume sin -C ni -s y conserva el aislamiento', () => {
  assert.deepEqual(codexResume(codexLaunch(t).args, 'T', '/r/out-resume.md'), [
    'exec', 'resume', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '--json', '--output-last-message', '/r/out-resume.md', '-m', 'opus', '-c', 'model_reasoning_effort=high',
    '-c', 'sandbox_mode="read-only"', 'T', '-',
  ])
  assert.equal(codexResume(['-p'], 'T', '/r/x.md'), null)
})

const review = { ...t, scratch: '/tmp/vacio' }

test('el revisor Claude corre sin herramientas, sin personalizaciones y fuera del repo', () => {
  const l = claudeReviewLaunch(review)
  assert.deepEqual([l.cmd, l.cwd, l.stdinFile], ['claude', '/tmp/vacio', '/r/p.md'])
  assert.deepEqual(l.args, [
    '-p', '--safe-mode', '--tools', '', '--permission-prompts', 'none', '--system-prompt', REVIEWER_SYSTEM_PROMPT,
    '--output-format', 'stream-json', '--verbose', '--session-id', 'S', '--model', 'opus', '--effort', 'high',
  ])
  assert.equal(l.args.includes('--no-session-persistence'), false)
})

test('el revisor Codex corre sin shell ni web, fuera de un repo', () => {
  const l = codexReviewLaunch(review)
  assert.deepEqual([l.cmd, l.cwd], ['codex', '/tmp/vacio'])
  assert.deepEqual(l.args, [
    'exec', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'shell_tool', '-c', 'web_search="disabled"', '--skip-git-repo-check',
    '-s', 'read-only', '-C', '/tmp/vacio', '--json', '--output-last-message', '/r/out.md',
    '-m', 'opus', '-c', 'model_reasoning_effort=high', '-',
  ])
})

test('reanudar al revisor conserva todo su aislamiento', () => {
  const claude = claudeReviewLaunch(review).args
  assert.deepEqual(claudeResume(claude)?.filter((a) => a !== '--resume'), claude.filter((a) => a !== '--session-id'))
  const codex = codexResume(codexReviewLaunch(review).args, 'T', '/r/out-resume.md') ?? []
  for (const flag of ['--ignore-user-config', 'shell_tool', 'web_search="disabled"', '--skip-git-repo-check', 'sandbox_mode="read-only"']) {
    assert.ok(codex.includes(flag), flag)
  }
})

test('withSessionId cambia solo el valor de la sesión', () => {
  const args = claudeLaunch(t).args
  assert.deepEqual(withSessionId(args, 'S2'), args.map((a) => (a === 'S' ? 'S2' : a)))
})
