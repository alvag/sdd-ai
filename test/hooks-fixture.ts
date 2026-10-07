// Helpers compartidos por los tests de hooks: despachos de agentes, shell, flujos ligados y reservas.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBinding } from '../src/backstop.ts'
import { runHook } from '../src/hooks.ts'
import { reserve } from '../src/native-launch.ts'
import { checkOutput, payload } from './hook-contract.ts'
import { makeRepo } from './helpers.ts'

export const CLIS = ['claude', 'codex'] as const
export type Cli = typeof CLIS[number]

export type Out = Record<string, any>

// Despachos de agentes: las corridas nativas salen de bin/sdd-ai run, como en una sesión real.

export const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
export const DISPATCH = { claude: 'pre-tool-use-agent', codex: 'pre-tool-use-spawn-agent-v1' } as const
export const canonical = (file: string) => `Tu encargo está en ${file}. Léelo completo y cúmplelo.`

export function sdd(repo: string, cli: Cli, args: string[], session = 's1'): Out {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')), SDD_AI_PROJECTION: 'off' }
  if (cli === 'claude') Object.assign(env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session })
  else Object.assign(env, { CODEX_THREAD_ID: 't', CODEX_SESSION_ID: session })
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' })
  return JSON.parse(r.stdout) as Out
}

/** Repo con sdd-ai configurado para una sola familia y sus agentes generados. */
export function sddRepo(cli: Cli): string {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: [${cli}]\n  selection: full\n`)
  sdd(repo, cli, ['agents', 'sync'])
  return repo
}

/** Una corrida nativa creada por `run`; devuelve lo que `run` le mostró al conductor. */
export function nativeRun(repo: string, cli: Cli, args: string[] = [], session = 's1'): Out {
  const prompt = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(prompt, 'Encargo de prueba.\n')
  const out = sdd(repo, cli, ['run', '--prompt-file', prompt, ...args], session)
  assert.equal(out.via, 'native', JSON.stringify(out))
  return out
}

export function dispatch(cli: Cli, repo: string, input: Record<string, unknown>, patch: Record<string, unknown> = {}): Out | '' {
  const base = payload(cli, DISPATCH[cli], {})
  const p = { ...base, cwd: repo, session_id: 's1', tool_use_id: 'tu-1', ...patch, tool_input: { ...(base.tool_input as object), ...input } }
  const out = runHook(JSON.stringify(p), cli)
  return out === '' ? '' : JSON.parse(out) as Out
}

export const CIPHER = (payload('codex', 'pre-tool-use-spawn-agent-v2', {}).tool_input as Record<string, string>).message

/** Un despacho de `spawn_agent` v2, como lo manda Codex: `collaborationspawn_agent` con el mensaje cifrado. */
export function dispatchV2(repo: string, input: Record<string, unknown> = {}, patch: Record<string, unknown> = {}): Out | '' {
  const base = payload('codex', 'pre-tool-use-spawn-agent-v2', {})
  const p = { ...base, cwd: repo, session_id: 's1', tool_use_id: 'tu-1', ...patch, tool_input: { ...(base.tool_input as object), ...input } }
  const out = runHook(JSON.stringify(p), 'codex')
  return out === '' ? '' : JSON.parse(out) as Out
}

export const typeKey = (cli: Cli) => (cli === 'claude' ? 'subagent_type' : 'agent_type')
export const textKey = (cli: Cli) => (cli === 'claude' ? 'prompt' : 'message')
export const decision = (out: Out | '') => (out === '' ? '' : out.hookSpecificOutput.permissionDecision)
export const denial = (out: Out | ''): string => {
  assert.equal(decision(out), 'deny', JSON.stringify(out))
  return (out as Out).hookSpecificOutput.permissionDecisionReason
}

/** Una nativa de `run` con su despacho reservado y sin confirmar, como la deja un lanzamiento que no avisó. */
export function reservedRun(repo: string, cli: Cli, toolUseId: string): Out {
  const run = nativeRun(repo, cli)
  assert.equal(reserve(join(repo, '.sdd-ai', 'runs', run.id), toolUseId), true)
  return run
}

/** La negación de H-30: nombra la corrida, remite a preguntar y advierte que reintentar puede duplicar el agente. */
export function assertUnconfirmed(out: Out | '', cli: Cli, ids: string[]): string {
  const reason = denial(out)
  assert.deepEqual(checkOutput(cli, 'PreToolUse', out), [])
  for (const id of ids) {
    assert.ok(reason.includes(id), `no nombra ${id}: ${reason}`)
    assert.ok(reason.includes(`./bin/sdd-ai cancel ${id}`) && reason.includes(`./bin/sdd-ai run --retry ${id}`), reason)
  }
  assert.match(reason, /preguntarle al usuario/)
  assert.match(reason, /`cancel` solo cambia el registro local/)
  assert.match(reason, /reintentar puede lanzar otro agente/)
  assert.doesNotMatch(reason, /no es una nativa sin lanzar ni reservar/)
  return reason
}

export function shell(cli: Cli, repo: string, command: string, patch: Record<string, unknown> = {}): Out | '' {
  const base = payload(cli, 'pre-tool-use-bash', {})
  const p = { ...base, cwd: repo, session_id: 's1', ...patch, tool_input: { ...(base.tool_input as object), command } }
  const out = runHook(JSON.stringify(p), cli)
  return out === '' ? '' : JSON.parse(out) as Out
}

export const CHILD = { agent_id: 'a1', agent_type: 'general-purpose' }

// La liga con un flujo SDD y la guarda del commit.

export const SPEC_APPROVED = '2026-09-28T12:00:00-05:00'
export type FlowShape = { handoff?: Record<string, unknown> | null; spec?: boolean; plan?: Record<string, unknown>; tasks?: 'pending' | 'done' }

/** Un flujo completo en `.plans/<id>/`: con la spec aprobada salvo que el handoff diga otra cosa. */
export function writeFlow(repo: string, id: string, o: FlowShape = {}): void {
  const dir = join(repo, '.plans', id)
  mkdirSync(dir, { recursive: true })
  const front = (data: Record<string, unknown>, body: string) =>
    `---\n${Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body}\n`
  const handoff = o.handoff === undefined ? { profundidad: 'completa', spec_approved_at: SPEC_APPROVED, branch: 'feature/f' } : o.handoff
  if (handoff !== null) writeFileSync(join(dir, 'handoff.md'), front(handoff, '# Handoff'))
  if (o.spec ?? true) writeFileSync(join(dir, 'spec.md'), '# Spec\n\n- **AC-1** — algo.\n')
  if (o.plan) writeFileSync(join(dir, 'plan.md'), front({ profundidad: 'completa', ...o.plan }, '# Plan'))
  if (o.tasks) writeFileSync(join(dir, 'tasks.md'), `# Tasks\n\n- [x] **T1 — uno**\n- [${o.tasks === 'done' ? 'x' : ' '}] **T2 — dos**\n`)
}

export function flowRepo(jira?: 'on' | 'off' | 'invalid'): string {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  if (jira) writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `jira_approval:\n  mode: ${jira === 'invalid' ? 'true' : `"${jira}"`}\n`)
  return repo
}

/** El `PostToolUse` de un `Bash` del conductor que terminó; en Claude, `failed` usa `PostToolUseFailure`. */
export function post(cli: Cli, repo: string, command: string, o: { patch?: Record<string, unknown>; failed?: boolean } = {}): Out | '' {
  const name = o.failed && cli === 'claude' ? 'post-tool-use-failure-bash' : 'post-tool-use-bash'
  const base = payload(cli, name, {})
  const p = { ...base, cwd: repo, session_id: 's1', ...o.patch, tool_input: { ...(base.tool_input as object), command } }
  const out = runHook(JSON.stringify(p), cli)
  return out === '' ? '' : JSON.parse(out) as Out
}

export const bound = (repo: string, session = 's1') => {
  const b = readBinding(repo, session)
  return b === null || b === 'unreadable' ? b : { id: b.id, step: b.step, gate: b.gate }
}

/** Cada paso de AC-5 con un flujo en disco que lo produce, y si el commit pasa. */
export const GUARD_STEPS: Array<[string, FlowShape, boolean]> = [
  ['depth', { handoff: null }, false],
  ['specify', { spec: false }, false],
  ['plan', {}, false],
  ['tasks', { plan: { status: 'plan-approved' } }, false],
  ['gate', { handoff: { profundidad: 'completa', spec_approved_at: null } }, false],
  ['external_gate', { handoff: { profundidad: 'completa', spec_approved_at: SPEC_APPROVED, gate_status: 'awaiting' }, plan: { status: 'implementing' }, tasks: 'pending' }, false],
  ['implement', { plan: { status: 'implementing' }, tasks: 'pending' }, false],
  ['verify', { plan: { status: 'implementing' }, tasks: 'done' }, false],
  ['resolve_blockers', { plan: { status: 'bogus' }, tasks: 'done' }, false],
  ['review_and_commit', { plan: { status: 'verified' }, tasks: 'done' }, true],
  ['push', { plan: { status: 'committed' }, tasks: 'done' }, true],
  ['open_pr', { plan: { status: 'pushed' }, tasks: 'done' }, true],
  ['archive', { plan: { status: 'pr-open' }, tasks: 'done' }, true],
]

/** Un repo con remoto, el flujo f1 en ese paso y la sesión s1 ligada a él; el remoto conserva `push` y `open_pr` como pasos de cierre. */
export function boundRepo(cli: Cli, shape: FlowShape = { plan: { status: 'implementing' }, tasks: 'pending' }, jira?: 'on' | 'off' | 'invalid'): string {
  const repo = flowRepo(jira)
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/repo.git'], { cwd: repo })
  writeFlow(repo, 'f1', shape)
  post(cli, repo, './bin/sdd-ai sdd status f1')
  assert.notEqual(bound(repo), null, 'quedó ligada')
  return repo
}

export const USER_COMMITS = /el commit lo hace el usuario/
