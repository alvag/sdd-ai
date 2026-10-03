import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preference, runAttempt, telemetryFixture, telemetryLines } from './telemetry-fixture.ts'

test('repository identity uses the real common Git directory in every layout', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-identity-')))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
  const f = telemetryFixture()
  try {
    preference(f, 'telemetry: on\n')
    const plain = join(base, 'plain'); mkdirSync(plain); git(plain, 'init', '-q')
    const separate = join(base, 'separate'); mkdirSync(separate); git(separate, 'init', '-q', '--separate-git-dir', join(base, 'git-data'))
    const bare = join(base, 'bare'); mkdirSync(bare); git(bare, 'init', '--bare', '-q')
    // El repo ordinario primero se mide sin HEAD: la identidad existe aunque no haya commits.
    const empty = await runAttempt(telemetryFixture(plain, f.home))
    const unborn = telemetryLines(f.home).find((l) => l.run === empty.id)
    assert.equal(unborn?.repository, realpathSync(join(plain, '.git')))
    writeFileSync(join(plain, 'a'), 'base'); git(plain, 'add', 'a'); git(plain, 'commit', '-qm', 'base')
    const w1 = join(base, 'w1'); const w2 = join(base, 'w2')
    git(plain, 'worktree', 'add', '-qb', 'one', w1); git(plain, 'worktree', 'add', '-qb', 'two', w2)
    git(bare, 'fetch', plain, 'HEAD:refs/heads/main')
    const bw = join(base, 'bare-worktree'); git(bare, 'worktree', 'add', '-qb', 'bare-one', bw, 'main')
    const alias = join(base, 'alias'); symlinkSync(w1, alias)
    git(plain, 'remote', 'add', 'origin', 'https://secret:PRIVATE_REMOTE_CREDENTIAL@invalid.example/repo')
    const roots = [plain, separate, bare, w1, w2, bw, alias]
    const identities: string[] = []
    for (const root of roots) {
      const at = telemetryFixture(root, f.home)
      const r = await runAttempt(at)
      const line = telemetryLines(f.home).find((l) => l.run === r.id)!
      const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      assert.equal(line.repository, realpathSync(common))
      identities.push(line.repository)
    }
    assert.equal(identities[0], identities[3]); assert.equal(identities[3], identities[4]); assert.equal(identities[4], identities[6])
    assert.equal(identities[2], identities[5]); assert.notEqual(identities[0], identities[1])
    assert.doesNotMatch(JSON.stringify(telemetryLines(f.home)), /PRIVATE_REMOTE_CREDENTIAL|invalid\.example/)
  } finally { f.dispose(); rmSync(base, { recursive: true, force: true }) }
})
