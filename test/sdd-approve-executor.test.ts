import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { approve } from '../src/sdd/approve.ts'
import { readFlow } from '../src/sdd/read.ts'
import { runHook } from '../src/hooks.ts'
import { SddError } from '../src/types.ts'
import { accept, behind, cli, fixture, logged, snapshot } from './sdd-approve-fixture.ts'

test('la recuperacion omite prove para el conductor y rechaza al worker con runner_required', () => {
  const f = fixture()
  try {
    accept(f, 'spec'); behind(f)
    const original = logged(f)
    const noProof = () => { throw new Error('recuperación no debe llamar prove') }
    const pending = snapshot(f)
    f.env.SDD_AI_WORKER = '1'
    assert.equal(cli(f, 'approve', 'f', 'spec').out.code, 'runner_required')
    assert.deepEqual(snapshot(f), pending)
    delete f.env.SDD_AI_WORKER
    assert.equal(approve(f.root, 'f', 'spec', new Date(), readFlow, noProof, f.env).gates[0].state, 'approved')
    assert.deepEqual(logged(f), original)
    const synced = snapshot(f)
    f.env.SDD_AI_WORKER = '1'
    assert.equal(cli(f, 'approve', 'f', 'spec').out.code, 'runner_required')
    assert.deepEqual(snapshot(f), synced)
    delete f.env.SDD_AI_WORKER
    assert.throws(() => approve(f.root, 'f', 'spec', new Date(), readFlow, noProof, {}), (e: unknown) => e instanceof SddError && e.code === 'runner_required')
    assert.throws(() => approve(f.root, 'f', 'spec', new Date(), readFlow, noProof, { ...f.env, CODEX_THREAD_ID: 'thread', CODEX_SESSION_ID: 'session' }),
      (e: unknown) => e instanceof SddError && e.code === 'conductor_unknown')
    approve(f.root, 'f', 'spec', new Date(), readFlow, noProof, f.env, 'claude')
    assert.deepEqual(snapshot(f), synced)
  } finally { f.cleanup() }
})

test('el hook niega sdd approve desde un subagente nombrando runner_required', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, '.sdd-ai'), { recursive: true })
    for (const family of ['claude', 'codex'] as const) {
      for (const command of ['./bin/sdd-ai sdd approve f spec', 'node /tmp/bin/sdd-ai sdd approve f plan-tasks', 'pwd && ./bin/sdd-ai sdd approve f spec']) {
        const raw = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: f.root,
          session_id: f.env.CLAUDE_CODE_SESSION_ID, agent_id: 'child', tool_name: 'Bash', tool_input: { command } }), family)
        const out = JSON.parse(raw).hookSpecificOutput
        assert.equal(out.hookEventName, 'PreToolUse')
        assert.equal(out.permissionDecision, 'deny')
        assert.match(out.permissionDecisionReason, /runner_required/)
      }
    }
  } finally { f.cleanup() }
})
