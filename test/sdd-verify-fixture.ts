// Lo común de los tests de `sdd verify`, que están partidos por tema en `sdd-verify-*.test.ts`.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidateFingerprint } from '../src/git.ts'
import { type VerifyReceipt, fileSha256, newReceiptId, receiptDir } from '../src/sdd/verify-receipt.ts'
import { prepareVerify, runFinal } from '../src/sdd/verify.ts'
import { type Question } from '../src/approval/question.ts'
import { randomUUID } from 'node:crypto'
import { type CommandRow, type TestRow, admitVerification, renderVerification } from '../src/sdd/verification-contract.ts'
import { readFlow } from '../src/sdd/read.ts'
import { resolve } from '../src/sdd/status.ts'
import { SddError } from '../src/types.ts'
import { askPair, makeFakeBin, makeRepo, telemetryOff, writeClaudeTranscript } from './helpers.ts'
import { realpathSync } from 'node:fs'

export const realpathTmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-verify-')))

export const gitIn = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

/** Un repo con un commit base: un archivo de código, uno que Git ignora y el directorio del flujo `f`. */
export function baseRepo(): { repo: string; base: string } {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  mkdirSync(join(repo, '.plans', 'f'), { recursive: true })
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), '# Plan\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  return { repo, base: gitIn(repo, 'rev-parse', 'HEAD') }
}

export const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof SddError) return e.code
    throw e
  }
  return 'ok'
}

/** Un recibo final de una fila con sus dos salidas escritas en el directorio del recibo. */
export function sampleReceipt(repo: string, base: string): VerifyReceipt {
  const id = newReceiptId()
  const dir = receiptDir(repo, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stdout-V1.log'), 'ok 1 - exporta\n')
  writeFileSync(join(dir, 'stderr-V1.log'), '')
  const fp = candidateFingerprint(repo, 'f', base)
  return {
    id, flow: 'f', mode: 'final', started_at: '2026-09-29T10:00:00-05:00', ended_at: '2026-09-29T10:00:01-05:00',
    before: fp, after: fp, plan_fingerprint: 'sha256:plan', coverage: { 'AC-1': ['V1'] },
    rows: [{
      row: 'V1', outcome: 'passed',
      execution: {
        row: 'V1', started_at: '2026-09-29T10:00:00-05:00', ended_at: '2026-09-29T10:00:01-05:00', argv: ['node', '--test'], exit_code: 0,
        stdout_file: 'stdout-V1.log', stderr_file: 'stderr-V1.log',
        stdout_sha256: fileSha256(join(dir, 'stdout-V1.log')), stderr_sha256: fileSha256(join(dir, 'stderr-V1.log')), excerpt: 'exit 0; ok 1 - exporta',
      },
    }],
    green: true,
  }
}

/** El TAP real de `node --test` sobre archivos de prueba escritos en un directorio temporal. */
export function realTap(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-tap-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  // Dentro de `node --test`, un hijo que hereda NODE_TEST_CONTEXT le reporta al padre en vez de escribir TAP.
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env
  try {
    return execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...Object.keys(files).map((f) => join(dir, f))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env })
  } catch (e) {
    return (e as { stdout: string }).stdout
  }
}

export const TAP_FILES = {
  'a.test.ts': `import { test, describe } from 'node:test'\nimport assert from 'node:assert/strict'\n`
    + `test('aserción', () => { assert.equal(1, 2) })\n`
    + `test('error del código', () => { const f: any = undefined; f() })\n`
    + `test('pasa', () => {})\n`
    + `test('repetido', () => {})\ntest('repetido', () => {})\n`
    + `describe('suite', () => { test('anidado', () => { assert.equal(1, 2) }) })\n`
    + `test('saltado', { skip: true }, () => {})\n`,
  'b.test.ts': `import { nada } from './no-existe.ts'\nimport { test } from 'node:test'\ntest('nunca', () => { nada() })\n`,
}

export const EXEC = { row: 'V1', started_at: '', ended_at: '', argv: [], stdout_file: '', stderr_file: '', stdout_sha256: '', stderr_sha256: '', excerpt: '' }

export const TROW: TestRow = {
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert', argv: ['node'], timeout_ms: 1000, expect: { exit_code: 0 },
  implementation_paths: ['src/a.ts'], test_paths: ['test/a.test.ts'], test_name: 'pasa', report_format: 'tap',
}

export const cmd = (id: string, argv: string[], o: Partial<CommandRow> = {}): CommandRow =>
  ({ id, acs: ['AC-1'], kind: 'build', obligation: 'none', obligation_reason: 'x', argv, timeout_ms: 5000, expect: { exit_code: 0 }, ...o })

// ── Corridas de verify sobre un flujo de muestra ──────────────────────────────────────────────────────────

export const SPEC_MD = '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** f da 2. (pedido)\n- **AC-2:** compila. (pedido)\n'

export const HANDOFF_MD = '---\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: 2026-09-29T09:00:00-05:00\n---\n\n# Handoff\n'

export const TASKS_MD = (done: boolean) => `# Tasks\n\n- [${done ? 'x' : ' '}] **T1 — f da 2**  · cubre: AC-1, AC-2\n`

export const RED_ROW = {
  id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert',
  argv: [process.execPath, '--test', '--test-reporter=tap', 'test/a.test.ts'], timeout_ms: 30000, expect: { exit_code: 0 },
  implementation_paths: ['src/a.ts'], test_paths: ['test/a.test.ts'], test_name: 'f da 2', report_format: 'tap',
}

export const BUILD_ROW = {
  id: 'V2', acs: ['AC-2'], kind: 'build', obligation: 'none', obligation_reason: 'no hay seam',
  argv: [process.execPath, '-e', 'process.exit(process.argv[1] === "$(x); touch hecho-por-shell | y" ? 0 : 1)', '$(x); touch hecho-por-shell | y'], timeout_ms: 30000, expect: { exit_code: 0 },
}

export const planMd = (base: string, status: string, rows: unknown[]) => `---\nid: f\nbranch: feature/f\nbase_commit: ${base}\nchange_type: feat\n`
  + `profundidad: completa\nrisk: low\nstatus: ${status}\ncreated_at: 2026-09-29T09:00:00-05:00\n---\n\n# Plan\n\n## Enfoque\n\nUno.\n\n`
  + `## Verification\n\n${renderVerification(admitVerification({ schema_version: 1, rows }, ['AC-1', 'AC-2']))}\n`

/** Registra los tres gates con las huellas de hoy, como `sdd approve` pero sin prueba del runner. */
export function approveAll(repo: string): void {
  const { facts } = readFlow(repo, 'f')
  const fp = facts.fingerprints
  const approvals = [
    { gate: 'spec', depth: 'completa', fingerprint: fp.spec, previous: {}, at: '2026-09-29T14:00:00.000Z' },
    { gate: 'plan', depth: 'completa', fingerprint: fp.plan, previous: { spec: fp.spec }, at: '2026-09-29T14:01:00.000Z' },
    { gate: 'tasks', depth: 'completa', fingerprint: fp.tasks, previous: { spec: fp.spec, plan: fp.plan }, at: '2026-09-29T14:02:00.000Z' },
  ]
  writeFileSync(join(repo, '.plans', 'f', 'sdd-ai-approvals.json'), `${JSON.stringify({ schema_version: 1, approvals }, null, 2)}\n`)
}

/**
 * Un flujo `f` en completa con los tres gates aprobados. La base tiene `f = () => 1`; el candidato, `f = () => 2`
 * y la prueba que lo exige. `.plans/` está excluido de Git, como en un repositorio real.
 */
export function verifyFlow(o: { prefix?: string; rows?: unknown[]; status?: string; done?: boolean; implement?: boolean; base?: Record<string, string>; candidate?: Record<string, string> } = {}): { repo: string; base: string } {
  const repo = makeRepo(o.prefix)
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\n')
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, 'test'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 1\n')
  for (const [path, text] of Object.entries(o.base ?? {})) writeFileSync(join(repo, path), text)
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'spec.md'), SPEC_MD)
  writeFileSync(join(dir, 'handoff.md'), HANDOFF_MD)
  writeFileSync(join(dir, 'tasks.md'), TASKS_MD(o.done ?? true))
  writeFileSync(join(dir, 'plan.md'), planMd(base, o.status ?? 'implementing', o.rows ?? [RED_ROW, BUILD_ROW]))
  approveAll(repo)
  if (o.implement ?? true) {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const f = () => 2\n')
    writeFileSync(join(repo, 'test', 'a.test.ts'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n")
    for (const [path, text] of Object.entries(o.candidate ?? {})) writeFileSync(join(repo, path), text)
  }
  return { repo, base }
}

export const planOf = (repo: string) => readFileSync(join(repo, '.plans', 'f', 'plan.md'), 'utf8')

export const statusOf = (repo: string) => resolve(readFlow(repo, 'f').facts)

export const final = async (repo: string, signal = new AbortController().signal) => runFinal(prepareVerify(repo, 'f', 'final'), signal)

/** El código del error de una promesa o de una llamada. */
export const asyncCode = async (fn: () => Promise<unknown> | unknown): Promise<string> => {
  try {
    await fn()
  } catch (e) {
    if (e instanceof SddError) return e.code
    throw e
  }
  return 'ok'
}

/** Deja un writer de fase del flujo con su cosecha, sacada del árbol de ahora. */
export function fakeHarvest(repo: string, base: string, o: { endMark: boolean }): void {
  const id = '20260929-1500-bbbb'
  const store = join(repo, '.git', 'sdd-ai', 'runs', id)
  mkdirSync(store, { recursive: true })
  const patchFile = join(store, 'diff.patch')
  gitIn(repo, 'add', '-N', '.')
  writeFileSync(patchFile, execFileSync('git', ['diff', '--binary', '--src-prefix=a/', '--dst-prefix=b/', base], { cwd: repo }))
  gitIn(repo, 'reset', '-q')
  writeFileSync(join(store, 'control.json'), JSON.stringify({ id, phase: { flow: 'f', pending: ['T1'], inputs: {}, handoff_header: '' } }))
  writeFileSync(join(store, 'harvest.json'), JSON.stringify({ state: 'done', base, tree: 'x', files: [], patchFile, flagged: [], runAltered: [], headMoved: false, endMark: o.endMark }))
}

export const MANUAL_ROW = { id: 'V2', acs: ['AC-2'], kind: 'manual', obligation: 'none', obligation_reason: 'es visual', observation: 'el CSV abre en una planilla' }

/** El entorno de una sesión de Claude Code de fixture, con la respuesta del usuario a `q` en su transcript. */
export function answered(q: Question, label: string, env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp() }) {
  writeClaudeTranscript(env.CLAUDE_CONFIG_DIR, env.CLAUDE_CODE_SESSION_ID, askPair(env.CLAUDE_CODE_SESSION_ID, `tu-${randomUUID()}`, q, label))
  return env
}

export const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')

/** Corre el binario con un tope amplio: una corrida final ejecuta las filas y confirma con revert. */
export function cli(repo: string, env: Record<string, string>, ...args: string[]): { code: number | null; out: Record<string, any> } {
  const { NODE_TEST_CONTEXT: _ctx, ...base } = process.env
  const r = spawnSync(BIN, args, { cwd: repo, encoding: 'utf8', timeout: 120000, env: telemetryOff({ ...base, ...env }) })
  return { code: r.status, out: JSON.parse(r.stdout) }
}

/** La respuesta del revisor falso a una ronda 1 sin hallazgos. */
export const CLEAN_ROUND = '{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":[]}'

/**
 * Un flujo verificable con una revisión de diff ya convergida sobre su código, con `plan.md` (y, si se pide,
 * `spec.md`) como contexto. Devuelve el repositorio, el entorno de un conductor Claude y el id de la revisión.
 */
/** El entorno con que reviewedFlow lanza su revisión: un Claude falso con una ronda limpia, sin publicar telemetría. */
export function reviewedFlowEnv(): { env: Record<string, string>; dirs: string[] } {
  const bin = realpathTmp()
  symlinkSync(process.execPath, join(bin, 'node'))
  makeFakeBin(bin, 'claude')
  const work = realpathTmp()
  writeFileSync(join(work, 'answers.json'), JSON.stringify([CLEAN_ROUND]))
  const claudeConfig = realpathTmp()
  const env: Record<string, string> = telemetryOff({
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_SESSION_ID: '', CODEX_THREAD_ID: '', FAKE_MODE: 'scripted', FAKE_ANSWERS: join(work, 'answers.json'), FAKE_CALLS_FILE: join(work, 'calls'),
  })
  return { env, dirs: [bin, work, claudeConfig] }
}

export function reviewedFlow(contexts: string[], planAsDiff = false, frozenHead = false): { repo: string; env: Record<string, string>; id: string; base: string } {
  const { repo, base } = verifyFlow()
  if (planAsDiff) writeFileSync(join(repo, '.git/info/exclude'), '.plans/*\n!.plans/f/\n.plans/f/*\n!.plans/f/plan.md\n.sdd-ai/\n')
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n')
  writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), [
    'schema_version: 1', 'roles:',
    '  code-review:', '    claude:', '      model: opus', '      effort: alto',
    '  refute:', '    claude:', '      model: sonnet', '      effort: medio', '',
  ].join('\n'))
  const { env } = reviewedFlowEnv()
  const context = contexts.flatMap((c) => ['--context', c])
  if (frozenHead) {
    gitIn(repo, 'add', 'src', 'test')
    gitIn(repo, 'commit', '-qm', 'candidate')
  }
  const started = cli(repo, env, 'review', 'start', '--base', base, '--author', 'codex', ...context,
    ...(frozenHead ? ['--head', 'HEAD'] : ['--untracked']))
  assert.equal(started.code, 0, JSON.stringify(started.out))
  const id = started.out.id as string
  assert.notEqual(cli(repo, env, 'wait', id, '--max', '20').code, 3, 'la ronda 1 no terminó')
  const status = cli(repo, env, 'review', 'status', id).out
  assert.equal(status.stale, false, JSON.stringify(status))
  return { repo, env, id, base }
}

export const reviewStatus = (r: { repo: string; env: Record<string, string>; id: string }) => cli(r.repo, r.env, 'review', 'status', r.id).out

export const PLAN = '.plans/f/plan.md'

/** Una fila `red_on_revert` sobre `src/b.ts`, cuyo candidato agrega `g` y lo usa desde `src/a.ts`. */
export const B_ROW = { ...RED_ROW, implementation_paths: ['src/b.ts'] }

export const B_BASE = { 'src/b.ts': 'export const h = () => 0\n' }

export const B_CANDIDATE = {
  'src/b.ts': 'export const g = () => 2\nexport const h = () => 0\n',
  'src/a.ts': "import { g } from './b.ts'\nexport const f = () => g()\n",
}
