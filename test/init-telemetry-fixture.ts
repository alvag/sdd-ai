import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { makeFakeBin, makeRepo } from './helpers.ts'
import { copyModSource } from './mod-fixture.ts'

export function initTelemetryFixture(sharedHome?: string) {
  const root = makeRepo()
  const home = sharedHome ?? realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-init-telemetry-')))
  const source = join(import.meta.dirname, '..')
  copyModSource(root)
  for (const rel of ['agents/worker.md','skills/sdd-ai/SKILL.md']) {
    mkdirSync(dirname(join(root, rel)), { recursive: true }); copyFileSync(join(source, rel), join(root, rel))
  }
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin/sdd-ai'), ''); writeFileSync(join(root, 'bin/sdd-ai-hook'), '')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c','user.name=t','-c','user.email=t@t','commit','-qm','base'], { cwd: root })
  const bin = mkdtempSync(join(home, 'bin-')); symlinkSync(process.execPath, join(bin, 'node'))
  makeFakeBin(bin, 'codex'); makeFakeBin(bin, 'claude')
  const codex = join(home, 'codex'); mkdirSync(codex, { recursive: true })
  writeFileSync(join(codex, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-luna' }] }))
  const env: Record<string, string> = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: codex, FAKE_VERSION: '1.0.0', SDD_AI_TELEMETRY: 'off', SDD_AI_PROJECTION: 'off' }
  const cli = (args: string[], extra: Record<string,string> = {}) => {
    const r = spawnSync(process.execPath, [join(source, 'bin/sdd-ai'), 'init', ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 })
    return { code: r.status, out: JSON.parse(r.stdout || 'null') as Record<string, any>, stderr: r.stderr }
  }
  const path = join(home, '.sdd-ai/config.yml')
  const config = (content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
  return { root, home, path, env, cli, config, dispose: () => { rmSync(root, { recursive: true, force: true }); if (!sharedHome) rmSync(home, { recursive: true, force: true }) } }
}
