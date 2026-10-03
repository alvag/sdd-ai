import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Question, gateQuestionFor } from '../src/approval/question.ts'
import { readFlow } from '../src/sdd/read.ts'
import { type GateId, resolve } from '../src/sdd/status.ts'

let fakeBinScript: string | undefined

/** Off por defecto; una clave explícita undefined retira el override del entorno final. */
export function telemetryOff(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries({ SDD_AI_TELEMETRY: 'off', ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/**
 * Enlace `claude` o `codex` en `dir` a un script que comparte todo el proceso. macOS evalúa la primera
 * ejecución de un ejecutable nuevo (unos 0,4 s, a veces más con la suite en paralelo), y un test con un
 * tope de 1 s no puede pagarla dentro del tope. Un enlace nuevo a un script que ya corrió no la paga:
 * el script se crea y se ejecuta una sola vez, en el primer uso. Es de solo lectura, para que un test
 * que escriba sobre el enlace falle en vez de cambiar el bin de los demás escenarios; para reemplazar
 * un bin, primero se borra el enlace.
 */
export function makeFakeBin(dir: string, name: 'claude' | 'codex'): void {
  if (fakeBinScript === undefined) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-fake-bin-')))
    process.on('exit', () => rmSync(base, { recursive: true, force: true }))
    fakeBinScript = join(base, 'fake-cli')
    writeFileSync(fakeBinScript, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, 'fake-cli.ts')}" "$@"\n`, { mode: 0o555 })
    const r = spawnSync(fakeBinScript, [], { env: { PATH: process.env.PATH, FAKE_MODE: 'ok-claude' }, input: '', encoding: 'utf8' })
    if (r.error || r.status !== 0) throw new Error(`el bin falso no arranca: ${r.error?.message ?? r.stderr}`)
  }
  const file = join(dir, name)
  rmSync(file, { force: true })
  symlinkSync(fakeBinScript, file)
}

/** Repo Git vacío en un directorio temporal (ruta real, sin el symlink de /var en macOS). */
export function makeRepo(prefix = 'sdd-ai-repo-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const lines = (items: unknown[]) => items.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'

/**
 * Agrega líneas al transcript de Claude Code de una sesión, en `<configDir>/projects/-repo/<session>.jsonl`.
 * Una línea que ya es texto se escribe tal cual: así se arma una línea ilegible.
 */
export function writeClaudeTranscript(configDir: string, session: string, items: unknown[]): string {
  const file = join(configDir, 'projects', '-repo', `${session}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, lines(items))
  return file
}

/** Agrega líneas al rollout de Codex de una sesión, bajo `<codexHome>/sessions/` y con la forma de nombre real. */
export function writeCodexRollout(codexHome: string, session: string, items: unknown[]): string {
  const file = join(codexHome, 'sessions', '2026', '09', '28', `rollout-2026-09-28T00-00-00-${session}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, lines(items))
  return file
}

const AT = '2026-09-28T12:00:00.000Z'

/**
 * El par de `AskUserQuestion` de un transcript de Claude Code: la línea del asistente con el `tool_use`
 * y la del usuario con su `tool_result`, con las claves que se observaron en archivos reales. `at: null`
 * deja la línea del resultado sin `timestamp`.
 */
export function askPair(session: string, toolUseId: string, q: Question, label: string,
  o: { sidechain?: boolean; isError?: boolean; at?: string | null; multiSelect?: boolean } = {}): [unknown, unknown] {
  const sidechain = o.sidechain ?? false
  const assistant = {
    type: 'assistant', sessionId: session, isSidechain: sidechain, uuid: `a-${toolUseId}`, timestamp: AT,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion',
      input: { questions: [{ ...q, multiSelect: o.multiSelect ?? false }] } }] },
  }
  const user = {
    type: 'user', sessionId: session, isSidechain: sidechain, uuid: `u-${toolUseId}`, sourceToolAssistantUUID: `a-${toolUseId}`,
    ...(o.at === null ? {} : { timestamp: o.at ?? AT }),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `User has answered your questions: "${q.question}"="${label}".`,
      ...(o.isError ? { is_error: true } : {}) }] },
    toolUseResult: { questions: [q], answers: { [q.question]: label }, annotations: {} },
  }
  return [assistant, user]
}

/**
 * Una línea `item_completed` de un rollout de Codex. El contenido de un `AgentMessage` es `Text` y el de
 * un `UserMessage` es `text`, como en los rollouts reales. `id: null` y `at: null` omiten esas claves.
 */
export function codexItem(type: string, text: string, o: { id?: string | null; at?: string | null } = {}): unknown {
  const item: Record<string, unknown> = { type }
  if (o.id !== null) item.id = o.id ?? `${type}-${Math.random().toString(16).slice(2)}`
  if (type === 'UserMessage') item.client_id = 'client-1'
  item.content = [{ type: type === 'AgentMessage' ? 'Text' : 'text', text }]
  return { ...(o.at === null ? {} : { timestamp: o.at ?? AT }), type: 'event_msg', payload: { type: 'item_completed', item } }
}

/**
 * Deja en el transcript de la sesión de fixture de `env` la respuesta del usuario a la pregunta del
 * gate, con las huellas que el flujo tiene ahora. No usa `next.question`: en un fixture cuyo header ya
 * acredita gates, `sdd status` apunta a otro paso.
 */
export function answerGate(repo: string, env: Record<string, string>, id: string, gate: string, label = 'Aprobar'): Question {
  const { facts } = readFlow(repo, id)
  const depth = resolve(facts).depth
  if (depth === null) throw new Error(`el flujo ${id} no tiene profundidad`)
  const q = gateQuestionFor(id, depth, gate as GateId, facts.fingerprints)
  const session = env.CLAUDE_CODE_SESSION_ID!
  writeClaudeTranscript(env.CLAUDE_CONFIG_DIR!, session, askPair(session, `tu-${Math.random().toString(16).slice(2)}`, q, label))
  return q
}

// ── Escenarios de cadenas de writers ──────────────────────────────────────────────────────────────────

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const gitIn = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

export interface ChainSetup { repo: string; env: Record<string, string>; base: string; calls: string; prompts: string }

/**
 * Un repo con un commit base (`src/a.ts` y su prueba), `.plans/` y `.sdd-ai/` excluidos como en un repo
 * real, y el writer falso con un guion por invocación (`writers`). Las sesiones del writer viven en
 * archivos bajo directorios temporales, donde las busca el runner real: nunca en las del usuario.
 */
export function chainSetup(o: { families?: string; bins?: Array<'claude' | 'codex'>; writers?: object[] } = {}): ChainSetup {
  const repo = makeRepo()
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\n')
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: ${o.families ?? '[codex]'}\n  selection: full\n`)
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, 'test'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 1\n')
  writeFileSync(join(repo, 'test', 'a.test.ts'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n")
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-bin-')))
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const b of o.bins ?? ['codex']) makeFakeBin(bin, b)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-chain-')))
  const env: Record<string, string> = telemetryOff({
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? '',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 's-claude',
    CLAUDE_CONFIG_DIR: join(scratch, 'claude'),
    CODEX_HOME: join(scratch, 'codex'),
    FAKE_MODE: 'writer',
    FAKE_SESSION_FILES: '1',
    FAKE_CALLS_FILE: join(scratch, 'calls'),
    FAKE_PROMPTS_FILE: join(scratch, 'prompts'),
    FAKE_WRITERS: JSON.stringify(o.writers ?? []),
  })
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true })
  mkdirSync(env.CODEX_HOME!, { recursive: true })
  return { repo, env, base: gitIn(repo, 'rev-parse', 'HEAD'), calls: env.FAKE_CALLS_FILE!, prompts: env.FAKE_PROMPTS_FILE! }
}

/** Corre el binario en el repo del escenario y devuelve su código y su JSON. */
export function runBin(s: ChainSetup, args: string[], extra: Record<string, string> = {}): { code: number | null; out: any; stderr: string } {
  // Con tope: un comando que se cuelga hace fallar la prueba en vez de colgarla.
  const r = spawnSync(BIN, args, { cwd: s.repo, env: { ...s.env, ...extra }, encoding: 'utf8', timeout: 120_000 })
  let out: unknown = null
  try {
    out = JSON.parse(r.stdout || 'null')
  } catch {
    out = { raw: r.stdout }
  }
  return { code: r.status, out, stderr: r.stderr }
}

/** Los argv con que se invocó el CLI falso, en orden. */
export const fakeCalls = (s: ChainSetup): string[][] =>
  (existsSync(s.calls) ? readFileSync(s.calls, 'utf8').trim().split('\n').filter(Boolean) : []).map((l) => JSON.parse(l) as string[])

/** Los encargos que recibió el writer falso, en orden. */
export const fakePrompts = (s: ChainSetup): string[] =>
  (existsSync(s.prompts) ? readFileSync(s.prompts, 'utf8').trim().split('\n').filter(Boolean) : []).map((l) => JSON.parse(l) as string)

/** La fila de prueba por defecto de un flujo de cadena: `f` tiene que dar 2. */
export const F_ROW = {
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'none', obligation_reason: 'fixture de cadena',
  argv: [process.execPath, '--test', '--test-reporter=tap', 'test/a.test.ts'], timeout_ms: 30000, expect: { exit_code: 0 },
  implementation_paths: ['src/a.ts'], test_paths: ['test/a.test.ts'], test_name: 'f da 2', report_format: 'tap',
}

/**
 * Un flujo `f` en completa con los tres gates aprobados (sin prueba del runner) y `n` tasks abiertas que
 * cubren AC-1. El contrato de verificación lo arma el llamador con `rows` (por defecto, `F_ROW`).
 */
export function chainFlow(s: ChainSetup, o: { tasks?: number; rows?: unknown[]; status?: string } = {}): void {
  const dir = join(s.repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** f da 2. (pedido)\n')
  writeFileSync(join(dir, 'handoff.md'), '---\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: 2026-09-29T09:00:00-05:00\n---\n\n# Handoff\n')
  const n = o.tasks ?? 1
  writeFileSync(join(dir, 'tasks.md'), `# Tasks\n\n${Array.from({ length: n }, (_, i) => `- [ ] **T${i + 1} — paso ${i + 1}**  · cubre: AC-1\n`).join('')}`)
  const rows = o.rows ?? [F_ROW]
  writeFileSync(join(dir, 'plan.md'), `---\nid: f\nbranch: feature/f\nbase_commit: ${s.base}\nchange_type: feat\nprofundidad: completa\nrisk: low\n`
    + `status: ${o.status ?? 'tasks-ready'}\ncreated_at: 2026-09-29T09:00:00-05:00\n---\n\n# Plan\n\n## Enfoque\n\nUno.\n\n`
    + `## Verification\n\n\`\`\`sdd-ai-verification-v1\n${JSON.stringify({ rows, schema_version: 1 }, null, 2)}\n\`\`\`\n`)
  approveFlowGates(s.repo)
}

/** Registra los tres gates del flujo `f` con las huellas de hoy, sin prueba del runner. */
export function approveFlowGates(repo: string, at = Date.parse('2026-09-29T14:00:00.000Z')): void {
  const { facts } = readFlow(repo, 'f')
  const fp = facts.fingerprints
  const when = (k: number) => new Date(at + k * 60_000).toISOString()
  const approvals = [
    { gate: 'spec', depth: 'completa', fingerprint: fp.spec, previous: {}, at: when(0) },
    { gate: 'plan', depth: 'completa', fingerprint: fp.plan, previous: { spec: fp.spec }, at: when(1) },
    { gate: 'tasks', depth: 'completa', fingerprint: fp.tasks, previous: { spec: fp.spec, plan: fp.plan }, at: when(2) },
  ]
  writeFileSync(join(repo, '.plans', 'f', 'sdd-ai-approvals.json'), `${JSON.stringify({ schema_version: 1, approvals }, null, 2)}\n`)
}
