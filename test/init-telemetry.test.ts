import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { initTelemetryFixture } from './init-telemetry-fixture.ts'

test('init proposes the shared telemetry preference and refuses invalid user configuration', () => {
  const f = initTelemetryFixture()
  try {
    for (const content of [null, '', '# only comments\n', 'other: true\n', 'telemetry: on\n', 'telemetry: off\n']) {
      if (content === null) rmSync(f.path, { force: true }); else f.config(content)
      const p = f.cli([])
      assert.equal(p.code, 0, JSON.stringify(p.out))
      const present = content?.includes('telemetry:') ?? false
      const q = p.out.questions.find((q: Record<string, any>) => q.id === 'telemetry')
      assert.equal(Boolean(q), !present)
      if (q) assert.deepEqual(q.options.map((o: Record<string, any>) => o.value), ['off','on'])
      assert.equal(p.out.user_config.proposed, content === 'telemetry: on\n' ? 'on' : 'off')
      const explicit = f.cli(['--telemetry','on'], { SDD_AI_TELEMETRY: 'off' })
      assert.equal(explicit.out.user_config.proposed, 'on'); assert.equal(explicit.out.questions.some((q: Record<string, any>) => q.id === 'telemetry'), false)
    }
    for (const bad of ['[broken', 'scalar', '- list\n', 'telemetry: invalid\n', 'telemetry: null\n', 'telemetry: on\ntelemetry: off\n']) {
      f.config(bad)
      const r = f.cli([])
      assert.equal(r.out.code, 'user_config_invalid'); assert.ok(r.out.message.includes(f.path))
      assert.equal(readFileSync(f.path, 'utf8'), bad)
    }
    rmSync(f.path); mkdirSync(f.path)
    assert.equal(f.cli([]).out.code, 'user_config_invalid')
    rmSync(f.path, { recursive: true })
    const p = f.cli([]).out
    assert.equal(f.cli(['--apply','--digest',p.digest]).code, 0)
    assert.equal(parse(readFileSync(f.path,'utf8')).telemetry, 'off')
    const other = initTelemetryFixture(f.home)
    try {
      assert.equal(other.cli([]).out.questions.some((q: Record<string,any>) => q.id === 'telemetry'), false)
      assert.equal(other.cli(['--telemetry','on']).out.user_config.action, 'update')
    } finally { other.dispose() }
    assert.equal(f.cli(['--telemetry','invalid']).out.code, 'usage')
  } finally { f.dispose() }
})

test('init completes checkout setup when the user preference cannot be written', () => {
  for (const existing of [false, true]) {
    const f = initTelemetryFixture()
    try {
      if (existing) f.config('telemetry: off\n')
      const flags = ['--telemetry','on']
      const p = f.cli(flags).out
      const r = f.cli(['--apply','--digest',p.digest,...flags], {
        NODE_OPTIONS: `--import ${join(import.meta.dirname,'telemetry-fault-preload.ts')}`,
        SDD_AI_TEST_FAULT_TARGET: join(f.home,'.sdd-ai'), SDD_AI_TEST_FAULT_OPERATION: 'writeFileSync',
        SDD_AI_TEST_FAULT_OBSERVATIONS: join(f.home,'observed'),
      })
      assert.equal(r.code, 0, JSON.stringify(r.out)); assert.equal(r.out.user_config.written, false)
      assert.ok(existsSync(join(f.root,'.sdd-ai/config.yml'))); assert.ok(r.out.agents)
      const note = r.out.notes.find((n: Record<string,any>) => n.code === 'telemetry_preference_unwritten')
      assert.match(note.next, /init --telemetry on/)
      const next = f.cli([]).out
      assert.equal(next.questions.some((q: Record<string,any>) => q.id === 'telemetry'), !existing)
      if (existing) assert.equal(parse(readFileSync(f.path,'utf8')).telemetry, 'off')
      else assert.equal(existsSync(f.path), false)
    } finally { f.dispose() }
  }
})

test('init binds user preference writes to the preview digest and preserves other preferences', () => {
  const f = initTelemetryFixture()
  try {
    f.config('# keep comment\nother: preserved\ntelemetry: off\n')
    chmodSync(f.path, 0o640)
    const bytes = readFileSync(f.path,'utf8')
    const p = f.cli(['--telemetry','on']).out
    assert.equal(readFileSync(f.path,'utf8'), bytes)
    f.config(bytes + '# new bytes\n')
    assert.equal(f.cli(['--apply','--digest',p.digest,'--telemetry','on']).out.code, 'digest_mismatch')
    const p2 = f.cli(['--telemetry','on']).out
    assert.equal(f.cli(['--apply','--digest',p2.digest,'--telemetry','on']).code, 0)
    assert.equal(parse(readFileSync(f.path,'utf8')).other, 'preserved')
    assert.match(readFileSync(f.path,'utf8'), /keep comment/); assert.equal(lstatSync(f.path).mode & 0o777, 0o640)
    const target = join(f.home,'shared-config'); writeFileSync(target, readFileSync(f.path))
    rmSync(f.path); symlinkSync(target,f.path)
    const linked = f.cli(['--telemetry','off']).out
    assert.equal(f.cli(['--apply','--digest',linked.digest,'--telemetry','off']).code, 0)
    assert.equal(lstatSync(f.path).isSymbolicLink(), true); assert.equal(parse(readFileSync(target,'utf8')).telemetry, 'off')
    rmSync(f.path)
    const absent = f.cli([]).out
    f.config('other: new\n')
    assert.equal(f.cli(['--apply','--digest',absent.digest]).out.code, 'digest_mismatch')
    rmSync(f.path)
    const create = f.cli([]).out
    assert.equal(f.cli(['--apply','--digest',create.digest]).code, 0)
    assert.equal(lstatSync(f.path).mode & 0o777, 0o600)
  } finally { f.dispose() }
})
