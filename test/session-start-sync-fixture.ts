import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { syncAgents } from '../src/agents.ts'
import { setBinding } from '../src/backstop.ts'
import { MOD_PATH, modInventory } from '../src/mod-copies.ts'
import { nativeProfiles } from '../src/resolve.ts'
import { createRun, setStatus, writeJsonAtomic } from '../src/runs.ts'
import { readFlow } from '../src/sdd/read.ts'
import { type Family, type ReadOnlyRole, READ_ONLY_ROLES } from '../src/types.ts'
import { makeRepo } from './helpers.ts'
import { copyModSource } from './mod-fixture.ts'

export const PACKAGE_ROOT = join(import.meta.dirname, '..')
export const write = (root: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-session-sync-')))
const remove = (root: string) => rmSync(root, { recursive: true, force: true })
export const agentPath = (family: Family, role: ReadOnlyRole = 'explore') => join(`.${family}`, 'agents', `sdd-ai-${role}.${family === 'claude' ? 'md' : 'toml'}`)
export const skillPath = (family: Family) => family === 'claude' ? '.claude/skills/sdd-ai/SKILL.md' : '.agents/skills/sdd-ai/SKILL.md'

export function isolatedEnv(home: string): Record<string, string | undefined> {
  mkdirSync(home, { recursive: true })
  write(home, 'config.toml', 'model = "fixture-codex"\nmodel_reasoning_effort = "high"\n')
  return { ...process.env, CODEX_HOME: home, SDD_AI_PROJECTION: 'off', SDD_AI_TELEMETRY: 'off' }
}

/** Restaurar las claves al terminar incluso si falla una aserción. */
export function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { return fn() } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export function createSessionSyncFixture() {
  const base = temporary()
  const root = join(base, 'root')
  const pkgDir = join(base, 'package')
  mkdirSync(root)
  for (const path of ['agents/worker.md', 'skills/sdd-ai/SKILL.md']) write(pkgDir, path, readFileSync(join(PACKAGE_ROOT, path)))
  copyModSource(pkgDir)
  const env = isolatedEnv(join(base, 'codex-home'))
  return { root, pkgDir, env, dispose: () => remove(base) }
}

export function installCurrentCopies(root: string, pkgDir: string, env: Record<string, string | undefined>): void {
  syncAgents(root, pkgDir, nativeProfiles(root, env))
}

/** Existencia, tipo, permisos y bytes; no sigue enlaces ni depende de mtimes. */
export function snapshotCopies(root: string): string {
  const entries: unknown[] = []
  const walk = (path: string) => {
    const file = join(root, path)
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) { entries.push([path, 'absent']); return }
    const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
    entries.push([path, kind, stat.mode, kind === 'link' ? readlinkSync(file) : kind === 'file' ? readFileSync(file).toString('base64') : null])
    if (kind === 'directory') for (const name of readdirSync(file).sort()) walk(`${path}/${name}`)
  }
  for (const path of ['.claude', '.codex', '.agents']) walk(path)
  return JSON.stringify(entries)
}

export function excludeCopies(root: string): void {
  const gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
  const file = join(root, gitDir, 'info', 'exclude')
  // Las entradas de las copias generadas, por su prefijo y no por su posición en .gitignore.
  const entries = readFileSync(join(PACKAGE_ROOT, '.gitignore'), 'utf8').split('\n').filter((line) => /^\.(claude|codex|agents)\//.test(line))
  // Un cambio de formato de .gitignore no debe dejar las copias sin excluir en silencio.
  if (entries.length === 0) throw new Error('excludeCopies: .gitignore no tiene entradas de .claude/, .codex/ ni .agents/')
  const lines = entries.join('\n')
  writeFileSync(file, readFileSync(file, 'utf8') + '\n' + lines + '\n.sdd-ai/\n.plans/\n')
}

export function createHookSyncFixture() {
  const root = makeRepo('sdd-ai-hook-sync-')
  const home = temporary()
  const env = isolatedEnv(home)
  mkdirSync(join(root, '.sdd-ai'))
  excludeCopies(root)
  installCurrentCopies(root, PACKAGE_ROOT, env)
  return { root, env, dispose: () => { remove(root); remove(home) } }
}

export interface Damage {
  mod?: 'missing' | 'file' | 'link' | 'missing-file' | 'changed' | 'extra' | 'dir-in-file'
  agents?: 'all-missing' | 'one-missing' | 'edited' | 'unreadable'
  role?: ReadOnlyRole
  skill?: 'missing' | 'edited' | 'unreadable'
}
export function damageCopies(root: string, cli: Family, spec: Damage): void {
  if (cli === 'codex' && spec.mod) throw new Error('Codex no inspecciona la copia del mod')
  if (spec.mod) {
    const file = join(root, MOD_PATH)
    const distributed = modInventory(PACKAGE_ROOT)[0].path
    if (['missing', 'file', 'link'].includes(spec.mod)) {
      remove(file)
      if (spec.mod === 'file') write(root, MOD_PATH, 'archivo')
      if (spec.mod === 'link') symlinkSync(join(root, 'missing-mod-target'), file)
    } else if (spec.mod === 'extra') write(root, `${MOD_PATH}/extra.txt`, 'sobrante')
    else {
      const path = `${MOD_PATH}/${distributed}`
      if (spec.mod === 'changed') write(root, path, 'editado')
      else {
        remove(join(root, path))
        if (spec.mod === 'dir-in-file') mkdirSync(join(root, path))
      }
    }
  }
  if (spec.agents === 'all-missing') for (const role of READ_ONLY_ROLES) remove(join(root, agentPath(cli, role)))
  else if (spec.agents) {
    const path = agentPath(cli, spec.role)
    if (spec.agents === 'edited') write(root, path, readFileSync(join(root, path), 'utf8') + '\neditado\n')
    else { remove(join(root, path)); if (spec.agents === 'unreadable') mkdirSync(join(root, path)) }
  }
  if (spec.skill) {
    const path = skillPath(cli)
    if (spec.skill === 'edited') write(root, path, readFileSync(join(root, path), 'utf8') + '\neditado\n')
    else { remove(join(root, path)); if (spec.skill === 'unreadable') mkdirSync(join(root, path)) }
  }
}

export function changeProfile(root: string, family: Family): void {
  write(root, '.sdd-ai/workers.yml', JSON.stringify({ schema_version: 1, roles: { explore: { [family]: { model: 'different-fixture-model', effort: 'medio' } } } }))
}

export function seedHookState(root: string, spec: {
  ownRuns?: number; otherRuns?: number; flows?: string[]; approvedFlows?: string[]; boundFlow?: string; session: string
}): void {
  for (let i = 0; i < (spec.ownRuns ?? 0) + (spec.otherRuns ?? 0); i++) {
    const dir = createRun(root, `20260101-${String(i + 1).padStart(4, '0')}-aaaa`)
    writeJsonAtomic(join(dir, 'request.json'), { conductor: { family: 'claude' }, role: 'explore', session: i < (spec.ownRuns ?? 0) ? spec.session : 'other-session' })
    write(dir, 'prompt.md', 'Encargo.\n')
    setStatus(dir, { state: 'running' })
  }
  for (const id of new Set([...(spec.flows ?? []), ...(spec.approvedFlows ?? [])])) {
    write(root, `.plans/${id}/handoff.md`, '---\nprofundidad: completa\nbranch: feature/f\n---\n# Handoff\n')
    write(root, `.plans/${id}/spec.md`, '# Spec\n\n- **AC-1:** algo. (pedido)\n')
    write(root, `.plans/${id}/plan.md`, '---\nprofundidad: completa\n---\n# Plan\n')
    write(root, `.plans/${id}/tasks.md`, '# Tasks\n\n- [ ] **T1 — uno** · cubre: AC-1\n')
    if (spec.approvedFlows?.includes(id)) {
      const fp = readFlow(root, id).facts.fingerprints
      writeJsonAtomic(join(root, '.plans', id, 'sdd-ai-approvals.json'), { schema_version: 1, approvals: [
        { gate: 'spec', depth: 'completa', fingerprint: fp.spec, previous: {}, at: '2026-10-01T00:00:00Z' },
        { gate: 'plan', depth: 'completa', fingerprint: fp.plan, previous: { spec: fp.spec }, at: '2026-10-01T00:01:00Z' },
        { gate: 'tasks', depth: 'completa', fingerprint: fp.tasks, previous: { spec: fp.spec, plan: fp.plan }, at: '2026-10-01T00:02:00Z' },
      ] })
    }
  }
  if (spec.boundFlow) setBinding(root, spec.session, { id: spec.boundFlow, step: 'plan', gate: null, at: '2026-10-01T00:03:00Z' })
}

export function createPackageFixture(opts: { payloadRepo: boolean }) {
  const base = temporary()
  const pkgDir = join(base, 'package')
  mkdirSync(pkgDir)
  for (const path of ['package.json', 'src', 'bin', 'agents', 'skills']) cpSync(join(PACKAGE_ROOT, path), join(pkgDir, path), { recursive: true })
  copyModSource(pkgDir)
  symlinkSync(join(PACKAGE_ROOT, 'node_modules'), join(pkgDir, 'node_modules'), 'dir')
  const root = opts.payloadRepo ? pkgDir : join(base, 'root')
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, '.sdd-ai'))
  excludeCopies(root)
  const env = isolatedEnv(join(base, 'codex-home'))
  installCurrentCopies(root, pkgDir, env)
  const paths = { mod: 'mods/sdd-ai/.claude-plugin/plugin.json', agents: 'agents/worker.md', skill: 'skills/sdd-ai/SKILL.md' }
  return {
    pkgDir, root, env,
    importRunHook: async () => (await import(pathToFileURL(join(pkgDir, 'src/hooks.ts')).href)).runHook as (raw: string, cli: Family) => string,
    damageSource: (which: 'mod' | 'agents' | 'skill', how: 'missing' | 'dir' | 'invalid' | 'codex-render') => {
      if (which !== 'agents' && (how === 'invalid' || how === 'codex-render')) throw new Error('solo agents admite fuente inválida')
      const path = paths[which]
      // Sin mods/sdd-ai entero el binario no carga (src/notification.ts importa el mod): se quita un archivo fijo.
      if (how === 'missing') remove(join(pkgDir, path))
      else if (how === 'dir') { remove(join(pkgDir, path)); mkdirSync(join(pkgDir, path)) }
      else if (how === 'invalid') write(pkgDir, path, 'sin frontmatter')
      else write(pkgDir, path, readFileSync(join(pkgDir, path), 'utf8') + "\n'''\n")
    },
    writeSource: (which: 'mod' | 'agents' | 'skill', content: string) => { remove(join(pkgDir, paths[which])); write(pkgDir, paths[which], content) },
    dispose: () => remove(base),
  }
}

export function createLinkedWorktreeFixture(pkgDir = PACKAGE_ROOT) {
  const base = temporary()
  const mainRoot = join(base, 'main')
  const worktreeRoot = join(base, 'worktree')
  mkdirSync(mainRoot)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: mainRoot })
  git('init', '-q')
  write(mainRoot, 'tracked.txt', 'base\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'fixture')
  git('worktree', 'add', '-qb', 'fixture-worktree', worktreeRoot)
  const env = isolatedEnv(join(base, 'codex-home'))
  excludeCopies(mainRoot)
  for (const root of [mainRoot, worktreeRoot]) {
    mkdirSync(join(root, '.sdd-ai'))
    changeProfile(root, 'claude')
    installCurrentCopies(root, pkgDir, env)
  }
  return { mainRoot, worktreeRoot, env, dispose: () => { git('worktree', 'remove', '--force', worktreeRoot); remove(base) } }
}

/** Estado durable observado; excluye el rastro y las marcas preexistentes del hook. */
export function snapshotHookState(root: string): string {
  const entries: unknown[] = []
  const walk = (path: string) => {
    const file = join(root, path)
    if (!existsSync(file)) return
    if (lstatSync(file).isDirectory()) for (const name of readdirSync(file).sort()) walk(`${path}/${name}`)
    else entries.push([path, readFileSync(file).toString('base64')])
  }
  walk('.plans')
  walk('.sdd-ai/runs')
  return JSON.stringify(entries)
}
