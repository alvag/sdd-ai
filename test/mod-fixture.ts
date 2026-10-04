import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeFakeBin, makeRepo, telemetryOff } from './helpers.ts'
import { type Exec, emittedFlags } from '../src/doctor.ts'
import { DEFAULT_PROFILES, parseWorkers } from '../src/profiles.ts'
import { roleProfiles } from '../src/resolve.ts'
import { ENGINE_PATHS } from '../src/mod-copies.ts'

export const SOURCE_ROOT = join(import.meta.dirname, '..')
export const write = (root: string, path: string, text: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
/**
 * Copia la fuente del mod tal como está, tests incluidos, sin lo que el motor deja al cargar un mod: las rutas de
 * `ENGINE_PATHS`, las mismas que la copia de producción no administra.
 */
export function copyModSource(root: string): void {
  const source = join(SOURCE_ROOT, 'mods/sdd-ai')
  cpSync(source, join(root, 'mods/sdd-ai'), {
    recursive: true,
    filter: (path) => {
      const rel = relative(source, path)
      return ![...ENGINE_PATHS].some((engine) => rel === engine || rel.startsWith(`${engine}/`))
    },
  })
}
export const profiles = () => roleProfiles(parseWorkers(JSON.stringify({ schema_version: 1, roles: DEFAULT_PROFILES }), 'fixture'), {})
export const exec: Exec = (name, args) => ({ status: 0, stdout: args.includes('--version') ? '2.1.289' : emittedFlags(name as 'claude' | 'codex', args.includes('resume') ? 'resume' : 'exec').join('\n') })

export function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) result[relative(root, path)] = `${statSync(path).mtimeMs}:${readFileSync(path).toString('base64')}`
    }
  }
  walk(root)
  return result
}

export function modFixture() {
  const root = makeRepo('sdd-ai-mod-')
  const home = mkdtempSync(join(tmpdir(), 'sdd-ai-mod-home-'))
  for (const rel of ['agents/worker.md', 'skills/sdd-ai/SKILL.md', '.gitignore']) write(root, rel, readFileSync(join(SOURCE_ROOT, rel)))
  for (const rel of ['bin/sdd-ai', 'bin/sdd-ai-hook']) write(root, rel, '')
  copyModSource(root)
  const bin = join(home, 'bin')
  mkdirSync(bin)
  makeFakeBin(bin, 'claude')
  makeFakeBin(bin, 'codex')
  const env = telemetryOff({ PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: join(home, 'codex'), FAKE_MODE: 'ok', FAKE_VERSION: '2.1.289' })
  const options = { exec, command: (digest?: string) => `./bin/sdd-ai init${digest ? ` --apply --digest ${digest}` : ''}` }
  const cli = (args: string[]) => {
    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, 'bin/sdd-ai'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, out: JSON.parse(result.stdout || 'null') as Record<string, any> }
  }
  return { root, home, env, options, cli, dispose: () => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) } }
}
