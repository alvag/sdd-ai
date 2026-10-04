import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyInit, planInit } from '../src/init.ts'
import { MOD_ADOPTION_MESSAGE, MOD_PATH, MOD_RUNTIME_FILES } from '../src/mod-copies.ts'
import { modFixture, snapshot, write } from './mod-fixture.ts'

function prepared() {
  const c = modFixture()
  const answers = { telemetry: 'off' as const, families: ['codex' as const] }
  const dry = () => planInit(c.root, answers, c.env, c.options)
  const apply = (digest: string) => applyInit(c.root, answers, digest, c.env, c.options)
  apply(dry().digest)
  return { ...c, dry, apply }
}

test('init previews and applies a mod-only change without premature writes', () => {
  const c = prepared()
  try {
    rmSync(join(c.root, MOD_PATH), { recursive: true })
    const before = snapshot(c.root)
    const home = snapshot(c.home)
    const plan = c.dry()
    assert.ok(plan.agents.length > 0)
    assert.ok(plan.agents.every((change) => change.path.startsWith(`${MOD_PATH}/`)))
    assert.deepEqual(snapshot(c.root), before)
    assert.deepEqual(snapshot(c.home), home)
    assert.throws(() => c.apply('wrong'), { code: 'digest_mismatch' })
    assert.deepEqual(snapshot(c.root), before)
    assert.deepEqual(snapshot(c.home), home)
    const result = c.apply(plan.digest)
    assert.ok(result.agents?.written.some((path) => path.includes(MOD_PATH)))
    assert.match(result.closing, /sdd-ai-mod/)
    assert.deepEqual(c.dry().agents, [])
  } finally { c.dispose() }
})

test('init rejects changed mod source bytes before every write', () => {
  for (const mode of ['change', 'add', 'remove']) {
    const c = prepared()
    try {
      write(c.root, `${MOD_PATH}/hooks/register.tsx`, 'stale')
      const extra = 'mods/sdd-ai/hooks/extra.ts'
      if (mode === 'remove') write(c.root, extra, 'before')
      const plan = c.dry()
      if (mode === 'change') write(c.root, 'mods/sdd-ai/hooks/register.tsx', `${readFileSync(join(c.root, 'mods/sdd-ai/hooks/register.tsx'), 'utf8')}\n// cambio\n`)
      else if (mode === 'add') write(c.root, extra, 'added')
      else rmSync(join(c.root, extra))
      const before = snapshot(c.root)
      const home = snapshot(c.home)
      assert.throws(() => c.apply(plan.digest), { code: 'digest_mismatch' })
      assert.deepEqual(snapshot(c.root), before)
      assert.deepEqual(snapshot(c.home), home)
    } finally { c.dispose() }
  }
})

test('init skips invalid workers and isolates mod copies between worktrees', () => {
  const c = prepared()
  try {
    execFileSync('git', ['add', '-A'], { cwd: c.root })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { cwd: c.root })
    const otherRoot = join(c.home, 'worktree')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'fixture-copy', otherRoot], { cwd: c.root })
    const answers = { telemetry: 'off' as const, families: ['codex' as const] }
    const otherPlan = planInit(otherRoot, answers, c.env, c.options)
    applyInit(otherRoot, answers, otherPlan.digest, c.env, c.options)
    const otherBefore = snapshot(otherRoot)
    write(c.root, `${MOD_PATH}/hooks/register.tsx`, 'stale')
    c.apply(c.dry().digest)
    assert.deepEqual(snapshot(otherRoot), otherBefore)
    write(c.root, '.sdd-ai/workers.yml', 'schema_version: invalid\n')
    rmSync(join(c.root, MOD_PATH), { recursive: true })
    const plan = c.dry()
    assert.deepEqual(plan.agents, [])
    assert.ok(plan.notes.some((note) => note.code === 'agents_skipped'))
    const result = c.apply(plan.digest)
    assert.equal(result.agents, null)
    assert.equal(result.doctor.mod && 'copies' in result.doctor.mod ? result.doctor.mod.copies[0].state : null, 'missing')
    assert.deepEqual(snapshot(otherRoot), otherBefore)
  } finally { c.dispose() }
})

test('init closing names the mod only when its copy changes', () => {
  const c = prepared()
  try {
    assert.equal(c.apply(c.dry().digest).closing.includes(MOD_ADOPTION_MESSAGE), false)
    write(c.root, '.claude/skills/sdd-ai/SKILL.md', 'stale')
    assert.equal(c.apply(c.dry().digest).closing.includes(MOD_ADOPTION_MESSAGE), false)
    write(c.root, `${MOD_PATH}/hooks/register.tsx`, 'stale')
    const closing = c.apply(c.dry().digest).closing
    assert.equal(closing.includes(MOD_ADOPTION_MESSAGE), true)
    assert.match(closing, /\/reload-plugins/)
    write(c.root, `${MOD_PATH}/hooks/leftover.ts`, 'obsolete')
    assert.equal(c.apply(c.dry().digest).closing.includes(MOD_ADOPTION_MESSAGE), true)
    write(c.root, `${MOD_PATH}/.claude-plugin/types/claude-code/index.d.ts`, 'engine')
    write(c.root, `${MOD_PATH}/tsconfig.json`, 'engine config')
    assert.deepEqual(c.dry().agents, [])
    const digest = c.dry().digest
    write(c.root, `${MOD_PATH}/.claude-plugin/types/claude-code/index.d.ts`, 'changed engine')
    assert.equal(c.dry().digest, digest)
  } finally { c.dispose() }
})

test('init refuses an incomplete mod source before writing', () => {
  for (const path of MOD_RUNTIME_FILES) for (const invalid of [false, true]) {
    const c = prepared()
    try {
      const digest = c.dry().digest
      rmSync(join(c.root, path))
      if (invalid) write(c.root, '.sdd-ai/workers.yml', 'invalid: true\n')
      const before = snapshot(c.root)
      const home = snapshot(c.home)
      assert.throws(() => c.dry(), { code: 'runtime_missing' })
      assert.throws(() => c.apply(digest), { code: 'runtime_missing' })
      assert.deepEqual(snapshot(c.root), before)
      assert.deepEqual(snapshot(c.home), home)
    } finally { c.dispose() }
  }
})

test('init refuses a mod copy that would leave the checkout before writing', () => {
  const c = prepared()
  const elsewhere = mkdtempSync(join(tmpdir(), 'sdd-ai-mod-elsewhere-'))
  try {
    // El digest se calcula antes del enlace, así apply llega hasta la guarda en lugar de detenerse en el digest.
    rmSync(join(c.root, MOD_PATH), { recursive: true })
    const digest = c.dry().digest
    rmSync(join(c.root, '.claude/skills'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(c.root, '.claude/skills'))
    const before = snapshot(c.root)
    const home = snapshot(c.home)
    assert.throws(() => c.dry(), { code: 'mod_copy_outside' })
    assert.throws(() => c.apply(digest), { code: 'mod_copy_outside' })
    assert.deepEqual(snapshot(c.root), before)
    assert.deepEqual(snapshot(c.home), home)
    assert.deepEqual(readdirSync(elsewhere), [])
  } finally {
    rmSync(elsewhere, { recursive: true, force: true })
    c.dispose()
  }
})
