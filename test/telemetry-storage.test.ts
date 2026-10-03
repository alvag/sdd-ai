import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainSetup, runBin } from './helpers.ts'
import { TEST_DAY, command, controlledClock, metrics, preference, runAttempt, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'

function ownFile(dir: string, day: string, temporary = false): string {
  const path = join(dir, `${temporary ? '.' : ''}${day}.${randomUUID()}.${temporary ? 'tmp' : 'jsonl'}`)
  writeFileSync(path, '{}\n')
  return path
}
function ageTree(path: string, date: Date): void {
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) ageTree(join(path, name), date)
  utimesSync(path, date, date)
}

test('concurrent repositories and writers retain every recent line during cleanup and prune', async () => {
  const writer = chainSetup()
  const f = telemetryFixture(writer.repo)
  const other = telemetryFixture(undefined, f.home)
  try {
    preference(f, 'telemetry: on\n')
    const dir = join(f.home, '.sdd-ai', 'telemetry'); mkdirSync(dir)
    const expired = ownFile(dir, '2000-01-01')
    const launched = runBin(writer, ['run', '--role', 'implement', '--prompt-file', 'src/a.ts'], {
      HOME: f.home, SDD_AI_TELEMETRY: 'on', FAKE_MODE: 'writer', FAKE_WRITERS: '[{}]',
    })
    assert.equal(launched.code, 0, JSON.stringify(launched.out))
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runAttempt(i % 2 ? f : other)))
    assert.equal(runBin(writer, ['wait', launched.out.id, '--max', '30'], { HOME: f.home, SDD_AI_TELEMETRY: 'on' }).code, 0)
    const lines = telemetryLines(f.home)
    assert.equal(lines.length, 7); assert.equal(new Set(lines.map((l) => `${l.run}:${l.attempt}`)).size, 7)
    assert.ok(lines.some((l) => l.run === launched.out.id && l.role === 'implement'))
    assert.equal(existsSync(expired), false)
    const old = results[1]
    ageTree(old.dir, new Date(Date.now() - 40 * 86400_000))
    const draft = command(f, ['prune'])
    assert.equal(draft.code, 0, JSON.stringify(draft.out))
    const applied = command(f, ['prune', '--apply', '--digest', draft.out.digest])
    assert.equal(applied.code, 0, JSON.stringify(applied.out))
    assert.equal(existsSync(old.dir), false)
    assert.deepEqual(telemetryLines(f.home), lines)
  } finally { f.dispose(); other.dispose() }
})

test('closure cleanup respects UTC day boundaries when telemetry is on or off', async () => {
  for (const setting of ['on', 'off']) {
    const f = telemetryFixture()
    try {
      controlledClock(f); preference(f, `telemetry: ${setting}\n`)
      const dir = join(f.home, '.sdd-ai', 'telemetry'); mkdirSync(dir)
      const limit = new Date(`${TEST_DAY}T00:00:00Z`); limit.setUTCDate(limit.getUTCDate() - 30)
      const boundary = limit.toISOString().slice(0,10)
      const previous = new Date(limit.getTime() - 86400_000).toISOString().slice(0,10)
      const next = new Date(limit.getTime() + 86400_000).toISOString().slice(0,10)
      const expired = [ownFile(dir, previous), ownFile(dir, previous, true)]
      const retained = [ownFile(dir, boundary), ownFile(dir, next), ownFile(dir, boundary, true), ownFile(dir, '2030-02-30')]
      const foreign = join(dir, 'notes.jsonl'); writeFileSync(foreign, 'foreign'); retained.push(foreign)
      const sub = join(dir, `${previous}.${randomUUID()}.jsonl`); mkdirSync(sub); retained.push(sub)
      const target = join(f.home, 'link-target'); writeFileSync(target, 'private')
      const link = join(dir, `${previous}.${randomUUID()}.jsonl`); symlinkSync(target, link); retained.push(link)
      const temporaryLink = join(dir, `.${previous}.${randomUUID()}.tmp`); symlinkSync(target,temporaryLink); retained.push(temporaryLink)
      await runAttempt(f)
      for (const path of expired) assert.equal(existsSync(path), false)
      for (const path of retained) assert.equal(existsSync(path), true)
      assert.equal(readFileSync(target, 'utf8'), 'private')
      assert.equal(telemetryLines(f.home).filter((l) => l.schema_version === 1).length, setting === 'on' ? 1 : 0)
    } finally { f.dispose() }
  }
})

test('telemetry excludes content markers and creates private directories and files', async () => {
  const f = telemetryFixture()
  try {
    preference(f, 'telemetry: on\n')
    // Los marcadores tienen que pasar de verdad por el intento: el prompt (prepareAttempt), la respuesta con código
    // y diff (Codex), la salida (Claude) y el diagnóstico (stderr de los dos).
    const script = { FAKE_TELEMETRY_SCRIPT: '[{"usage":{"input_tokens":1},"answer":"PRIVATE_RESPONSE_MARKER PRIVATE_CODE_MARKER PRIVATE_DIFF_MARKER"}]' }
    const raw = (r: { dir: string }) => {
      const m = metrics(r.dir)[0]
      return [readFileSync(join(r.dir, 'prompt.md'), 'utf8'), readFileSync(join(r.dir, m.raw.stdout), 'utf8'), readFileSync(join(r.dir, m.raw.stderr), 'utf8')].join('\n')
    }
    const seen = raw(await runAttempt(f, {}, 'telemetry-script', [], script)) + raw(await runAttempt(f, { family: 'claude' }, 'telemetry-script', [], script))
    for (const marker of ['PROMPT', 'RESPONSE', 'OUTPUT', 'DIAGNOSTIC', 'CODE', 'DIFF']) assert.match(seen, new RegExp(`PRIVATE_${marker}_MARKER`))
    const dir = join(f.home, '.sdd-ai', 'telemetry')
    assert.equal(lstatSync(dir).mode & 0o777, 0o700)
    const names = readdirSync(dir)
    assert.equal(names.length, 2); assert.ok(names.every((n) => n.endsWith('.jsonl')))
    for (const name of names) {
      const path = join(dir, name)
      assert.equal(lstatSync(path).mode & 0o777, 0o600)
      assert.doesNotMatch(readFileSync(path, 'utf8'), /PRIVATE_(PROMPT|RESPONSE|OUTPUT|DIAGNOSTIC|CODE|DIFF)_MARKER/)
    }
    const target = join(f.home, 'outside'); mkdirSync(target)
    rmSync(dir, { recursive: true }); symlinkSync(target, dir)
    await runAttempt(f)
    assert.deepEqual(readdirSync(target), [])
    rmSync(dir); writeFileSync(dir, 'unexpected node')
    await runAttempt(f)
    assert.equal(readFileSync(dir, 'utf8'), 'unexpected node')
    rmSync(dir)
    // ~/.sdd-ai enlazado, como con un gestor de dotfiles, se sigue.
    const parent = join(f.home, '.sdd-ai')
    const dotfiles = join(f.home, 'dotfiles')
    renameSync(parent, dotfiles)
    symlinkSync(dotfiles, parent)
    const r = await runAttempt(f)
    assert.ok(telemetryLines(f.home).some((l) => l.run === r.id))
  } finally { f.dispose() }
})
