import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gitDirs } from '../src/git.ts'

export const SOURCE_FILES = {
  '.gitignore': '# ignore propio\r\n*\r\n',
  'workers.yml': '# perfiles propios\r\nschema_version: 1\r\nroles:\r\n  implement:\r\n    codex: {model: modelo-personal, effort: alto}\r\n',
  'config.yml': '# configuración literal\r\ncross_model:\r\n  schema_version: 1\r\n  families: [codex]\r\n  selection: full\r\njira_approval: {mode: off}\r\ncustom_key: conservar\r\nknowledge-vault: {path_vault: ../vault-local}\r\n',
}
export const FILES = Object.keys(SOURCE_FILES) as Array<keyof typeof SOURCE_FILES>
const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
export function put(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}
export function snapshot(root: string): Array<{ path: string; mode: number; bytes?: string; link?: string; mtime: number }> {
  if (!existsSync(root)) return []
  const entries: ReturnType<typeof snapshot> = []
  const walk = (path: string) => {
    const st = lstatSync(path)
    entries.push({ path: relative(root, path), mode: st.mode, mtime: st.mtimeMs,
      ...(st.isFile() ? { bytes: readFileSync(path).toString('base64') } : {}),
      ...(st.isSymbolicLink() ? { link: readlinkSync(path) } : {}) })
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
  }
  walk(root)
  return entries
}
export interface WorktreeFixture {
  scratch: string; main: string; linked: string; env: Record<string, string>; request: string; bin: string
  git(args: string[], cwd?: string): string
  cli(args: string[], cwd?: string, overrides?: Record<string, string | undefined>): { code: number | null; out: any; stderr: string }
  cleanup(): void
}
export function createWorktreeFixture(): WorktreeFixture {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-reuse-')))
  const main = join(scratch, 'principal á', 'repo fuente')
  const linked = join(scratch, 'otro árbol ü', 'worktree enlazado')
  const bin = join(scratch, 'bin')
  const executable = (name: string) => {
    const file = (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, process.platform === 'win32' ? `${name}.exe` : name)).find(existsSync)
    assert.ok(file, `${name} debe estar disponible para el fixture`)
    return realpathSync(file)
  }
  const realGit = executable('git')
  // En Windows Git no arranca desde un symlink: busca sus DLL junto a la ruta lanzada (0xC0000135). Va su directorio real.
  const searchPath = process.platform === 'win32' ? [bin, dirname(realGit)].join(delimiter) : bin
  const env: Record<string, string> = {
    PATH: searchPath, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'codex-home'),
    XDG_CONFIG_HOME: join(scratch, 'xdg-config'), XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    SDD_AI_PROJECTION: 'off',
    SDD_AI_TELEMETRY: 'off', NODE_COMPILE_CACHE: join(scratch, 'node-cache'),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  }
  for (const path of [main, dirname(linked), bin, env.HOME, env.CODEX_HOME, join(scratch, 'vault-local')]) mkdirSync(path, { recursive: true })
  writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  if (process.platform !== 'win32') symlinkSync(realGit, join(bin, 'git'))
  symlinkSync(process.execPath, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'))
  // Solo Codex. Engram y Claude no están en el PATH aislado.
  if (process.platform === 'win32') symlinkSync(process.execPath, join(bin, 'codex.exe'))
  else {
    put(join(bin, 'codex'), `#!${process.execPath}\nprocess.exit(0)\n`)
    chmodSync(join(bin, 'codex'), 0o755)
  }
  const git = (args: string[], cwd = main) => execFileSync(realGit, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const cli: WorktreeFixture['cli'] = (args, cwd = linked, overrides = {}) => {
    const childEnv: Record<string, string | undefined> = { ...env, ...overrides }
    for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key]
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: childEnv, encoding: 'utf8', timeout: 20000 })
    assert.equal(r.error, undefined, r.stderr)
    return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
  }
  git(['init', '-q', '-b', 'main'])
  put(join(main, 'base.txt'), 'base\n')
  git(['add', 'base.txt'])
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'])
  git(['worktree', 'add', '-q', '-b', 'linked', linked])
  for (const name of FILES) put(join(main, '.sdd-ai', name), SOURCE_FILES[name])
  const request = join(scratch, 'pedido.md')
  put(request, 'Pedido aislado de prueba.\n')
  return { scratch, main, linked, env, request, bin, git, cli, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
}

/** Registros de un writer vivo; no lanza ningún worker. */
export function seedCodexRun(f: WorktreeFixture, root: string): void {
  const id = '20261006-1200-bbbb'
  const run = join(root, '.sdd-ai', 'runs', id)
  const dirs = gitDirs(root)
  const request = { kind: 'worker', role: 'implement', conductor: { family: 'codex' }, deadline_sec: 30 }
  const status = { state: 'running', supervisor_pid: process.pid, worker_pid: process.pid }
  put(join(run, 'request.json'), JSON.stringify(request))
  put(join(run, 'status.json'), JSON.stringify(status))
  const stat = lstatSync(run)
  const store = join(dirs.gitDir, 'sdd-ai', 'runs', id)
  put(join(store, 'control.json'), JSON.stringify({
    id, base: f.git(['rev-parse', 'HEAD'], root), family: 'codex', prompt: 'Pedido aislado.',
    checkout: { root, ...dirs }, request, preLaunch: {}, inventory: {}, runDir: { dev: stat.dev, ino: stat.ino },
  }))
  put(join(store, 'status.json'), JSON.stringify(status))
}

/** Registra solicitudes síncronamente, incluso si el publicador queda desligado de la CLI. */
export function publicationProbe(f: WorktreeFixture): { marker: string; env: Record<string, string | undefined> } {
  const preload = join(f.scratch, 'publication-probe.mjs')
  const marker = join(f.scratch, 'publication-request.jsonl')
  put(preload, `import {createRequire,syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
const cp=createRequire(import.meta.url)('node:child_process');
const original=cp.spawn;
cp.spawn=function(file,args,options){
  if(args?.includes('__publish')) {
    appendFileSync(${JSON.stringify(marker)},JSON.stringify(args)+'\\n');
    // El pedido es lo que se observa; un hijo inocuo evita dejar un publicador detrás del fixture.
    return original.call(this,file,['-e',''],options);
  }
  return original.call(this,file,args,options);
};
syncBuiltinESMExports();\n`)
  return { marker, env: { SDD_AI_PROJECTION: undefined, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }
}
