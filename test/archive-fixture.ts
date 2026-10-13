import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { type Question } from '../src/approval/question.ts'
import { type ArchiveApplyOptions, previewArchive } from '../src/sdd/archive.ts'
import { inventoryArchiveTree } from '../src/sdd/archive-tree.ts'
import { type PhaseRecord } from '../src/sdd/phase-state.ts'
import { type Attestation, type VerifyReceipt, verifyBytesDigest } from '../src/sdd/verify-receipt.ts'
import { askPair, telemetryOff, writeClaudeTranscript } from './helpers.ts'

const execute = promisify(execFile)
// El sandbox no hereda repositorio, índice, identidad ni configuración global del desarrollador. Se aplica
// al proceso del test porque el motor en proceso y los hijos lanzados desde el sandbox leen este entorno.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
process.env.GIT_CONFIG_GLOBAL = devNull
process.env.GIT_CONFIG_NOSYSTEM = '1'
const CHILD_TIMEOUT_MS = 120_000
export const archiveGit = (root: string, ...argv: string[]) => execFileSync('git', ['-c', 'user.name=archive-test', '-c', 'user.email=archive@example.invalid', ...argv],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export const archiveWrite = (path: string, content: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
export const archiveJson = (path: string, value: unknown) => archiveWrite(path, `${JSON.stringify(value, null, 2)}\n`)
export const readArchiveJson = <T = Record<string, unknown>>(path: string): T => JSON.parse(readFileSync(path, 'utf8'))

export interface ArchiveSandbox {
  base: string; checkoutRoot: string; vaultRoot: string; flowId: string; candidateRoot: string; candidateBin: string
  source: string; env: Record<string, string>; sources: { ledger: string; verdict: string; receipt: string; attestation: string }
  sessionMode: 'synthetic' | 'real'
  cleanup(): void
}

/** Solo fabrica repositorios y cuerpos sintéticos; no corre motores, review ni verify. */
export function createArchiveSandbox(options: { flowId?: string; candidateRoot?: string; evidence?: boolean; vault?: boolean; session?: 'synthetic' | 'real' } = {}): ArchiveSandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-archive-')))
  const checkoutRoot = join(base, 'checkout'), vaultRoot = join(base, 'vault'), flowId = options.flowId ?? 'flow-fixture'
  for (const repo of [checkoutRoot, vaultRoot]) {
    mkdirSync(repo); archiveGit(repo, 'init', '-q'); archiveGit(repo, 'config', 'user.name', 'archive-test'); archiveGit(repo, 'config', 'user.email', 'archive@example.invalid')
    archiveWrite(join(repo, 'base.txt'), 'base\n'); archiveGit(repo, 'add', 'base.txt'); archiveGit(repo, 'commit', '-qm', 'base')
  }
  const candidateRoot = resolve(options.candidateRoot ?? join(import.meta.dirname, '..')), source = join(checkoutRoot, '.plans', flowId)
  archiveWrite(join(source, 'spec.md'), '# Spec\nDocumento exclusivo: docneedle\n')
  archiveWrite(join(source, 'revision-final', 'arbitraje.patch'), 'parche literal\n')
  archiveWrite(join(source, 'co-explore', 'synthesis.md'), '# Síntesis\n')
  archiveWrite(join(source, 'cross-review', 'verdict.log'), 'veredicto\n')
  archiveWrite(join(source, 'other.data'), Buffer.from([0, 255, 1]))
  mkdirSync(join(source, 'empty'), { recursive: true })
  archiveWrite(join(vaultRoot, '.kv', 'identidades.tsv'), `fixture-project\t\t${archiveGit(checkoutRoot, 'rev-list', '--max-parents=0', 'HEAD')}\tfixture\n`)
  // vault_archive.mode va invertido a propósito: el destino sale solo de knowledge-vault.path_vault.
  archiveWrite(join(checkoutRoot, '.sdd-ai', 'config.yml'), options.vault === false ? 'vault_archive:\n  mode: vault\n' : `knowledge-vault:\n  path_vault: ${JSON.stringify(vaultRoot)}\nvault_archive:\n  mode: local\n`)
  const review = 'review-selected', receiptId = 'verify-selected', attestationId = 'attestation-used'
  const gitDir = archiveGit(checkoutRoot, 'rev-parse', '--absolute-git-dir')
  const sources = { ledger: join(checkoutRoot, '.sdd-ai', 'runs', review, 'ledger.json'), verdict: join(checkoutRoot, '.sdd-ai', 'runs', review, 'verdict.json'),
    receipt: join(gitDir, 'sdd-ai', 'verify', receiptId, 'receipt.json'), attestation: join(gitDir, 'sdd-ai', 'verify', 'attestations', `${attestationId}.json`) }
  if (options.evidence) {
    const sha = archiveGit(checkoutRoot, 'rev-parse', 'HEAD'), tree = archiveGit(checkoutRoot, 'rev-parse', 'HEAD^{tree}')
    const candidate = { base_commit: sha, base_tree: tree, tree }
    const attestation: Attestation = { id: attestationId, flow: flowId, row: 'Vmanual', observation: 'observación sintética', candidate,
      plan_fingerprint: verifyBytesDigest('plan'), answered_at: '2026-01-02T03:04:05Z', proof_ref: 'synthetic-proof' }
    archiveJson(sources.attestation, attestation)
    const receipt: VerifyReceipt = { id: receiptId, flow: flowId, mode: 'final', started_at: '2026-01-02T03:04:05Z', ended_at: '2026-01-02T03:04:06Z',
      before: candidate, after: candidate, plan_fingerprint: verifyBytesDigest('plan'), coverage: { 'AC-1': ['Vmanual'] },
      rows: [{ row: 'Vmanual', outcome: 'passed', attestation: attestationId, invalid_attestations: ['invalid-missing'] }], green: true }
    archiveJson(sources.receipt, receipt)
    archiveJson(sources.ledger, { review, rounds: [{ decisions: ['original'] }, { decisions: ['superseded', 'human-arbitration'], responses: ['literal-response'] }] })
    archiveJson(sources.verdict, { review, verdict: 'accepted' })
    archiveJson(join(dirname(sources.ledger), 'status.json'), { state: 'done' })
    const record: PhaseRecord = { schema_version: 1, last_run: null, phases: {}, reviews: [review, 'old-missing'],
      verify: { receipts: [{ id: 'baseline-missing', digest: verifyBytesDigest('baseline'), mode: 'baseline' },
        { id: 'superseded-missing', digest: verifyBytesDigest('superseded'), mode: 'final' },
        { id: receiptId, digest: verifyBytesDigest(readFileSync(sources.receipt)), mode: 'final' }],
        attestations: [{ id: attestationId, digest: verifyBytesDigest(readFileSync(sources.attestation)), row: 'Vmanual', proof_ref: 'synthetic-proof' },
          { id: 'unused-missing', digest: verifyBytesDigest('unused'), row: 'Vunused', proof_ref: 'unused-proof' },
          { id: 'invalid-missing', digest: verifyBytesDigest('invalid'), row: 'Vmanual', proof_ref: 'invalid-proof' }] },
      commit: { state: 'done', sha, at: '2026-01-02T03:04:06Z', digest: verifyBytesDigest('commit'), parent: sha, tree, message: 'feat: fixture', paths: ['base.txt'],
        receipt: { id: receiptId, digest: verifyBytesDigest(readFileSync(sources.receipt)) }, review } }
    archiveJson(join(source, 'sdd-ai-phases.json'), record)
  }
  const session = randomUUID()
  const env = options.session === 'real' ? telemetryOff(process.env) : telemetryOff({ ...process.env,
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session, CLAUDE_CONFIG_DIR: join(base, 'synthetic-session'),
    CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, SDD_AI_WORKER: '0' })
  // Un archivo vacío hace observable la respuesta ausente sin recuperar ningún rollout.
  if (options.session !== 'real') writeClaudeTranscript(env.CLAUDE_CONFIG_DIR!, session, [])
  return { base, checkoutRoot, vaultRoot, flowId, candidateRoot, candidateBin: join(candidateRoot, 'bin', 'sdd-ai'), source, env, sources, sessionMode: options.session ?? 'synthetic',
    cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

export async function runArchiveCli(sandbox: ArchiveSandbox, archiveArgs: string[], runnerOptions: { env?: Record<string, string> } = {}) {
  let code: number | string | null = 0, signal: string | null = null, stdout = '', stderr = ''
  try {
    ({ stdout, stderr } = await execute(process.execPath, [sandbox.candidateBin, 'sdd', 'archive', sandbox.flowId, ...archiveArgs],
      { cwd: sandbox.checkoutRoot, env: runnerOptions.env ?? sandbox.env, maxBuffer: 16 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS }))
  } catch (error) {
    const e = error as { code?: number | string; signal?: string | null; stdout?: string; stderr?: string }
    code = e.code ?? null; signal = e.signal ?? null; stdout = e.stdout ?? ''; stderr = e.stderr ?? ''
  }
  // Una muerte por señal o una salida que no es JSON se informa con su causa, no como un rechazo.
  if (signal !== null || typeof code !== 'number') throw new Error(`archive no terminó normalmente (code ${code}, signal ${signal}): ${stderr}`)
  let out: ReturnType<typeof JSON.parse>
  try { out = JSON.parse(stdout) } catch { throw new Error(`archive no devolvió JSON (code ${code}): ${stdout}${stderr}`) }
  return { code, stdout, stderr, out }
}

export async function runArchiveInProcess(sandbox: ArchiveSandbox, options: Partial<ArchiveApplyOptions> = {}) {
  const { applyArchive } = await import(pathToFileURL(join(sandbox.candidateRoot, 'src', 'sdd', 'archive.ts')).href)
  const previous = process.cwd()
  process.chdir(sandbox.checkoutRoot)
  try { return applyArchive(sandbox.checkoutRoot, sandbox.flowId, { env: sandbox.env, ...options }) }
  finally { process.chdir(previous) }
}

export function answerArchive(sandbox: ArchiveSandbox, summary = 'Resumen exclusivo: summaryneedle PR#12', label = 'Archivar'): Question {
  if (sandbox.sessionMode !== 'synthetic') throw new Error('el fixture real no fabrica respuestas ni transcripts: la pregunta la presenta el conductor')
  const preview = previewArchive(sandbox.checkoutRoot, sandbox.flowId, summary)
  assert.equal(preview.state, 'ready', JSON.stringify(preview))
  const question = preview.question as Question
  writeClaudeTranscript(sandbox.env.CLAUDE_CONFIG_DIR!, sandbox.env.CLAUDE_CODE_SESSION_ID!, askPair(sandbox.env.CLAUDE_CODE_SESSION_ID!, randomUUID(), question, label))
  return question
}

export function snapshotArchiveSandbox(sandbox: ArchiveSandbox): unknown {
  return { checkout: inventoryArchiveTree(sandbox.checkoutRoot), vault: inventoryArchiveTree(sandbox.vaultRoot) }
}

export const archiveCharacterizers = {
  destination: ['node', '--import', './test/no-subprocess.ts', '--test', '--test-reporter=tap', '--test-name-pattern=^el vault sale solo de path_vault, queda not_configured sin él, error con raíz o registro ilegibles y unresolved sin un proyecto único$', 'test/recall.test.ts'],
  recall: ['node', '--import', './test/no-subprocess.ts', '--test', '--test-reporter=tap', '--test-name-pattern=^el vault busca solo nodos y documentos de flujo sin evidencia, agrupa por flujo con state, date y summary y ordena por términos y fecha$', 'test/recall.test.ts'],
  receipt: ['node', '--import', './test/no-subprocess.ts', '--test', '--test-reporter=tap', '--test-name-pattern=^el recibo se publica en el almacén del checkout y se valida por digest al leerlo$', 'test/sdd-verify-run.test.ts'],
  attestation: ['node', '--import', './test/no-subprocess.ts', '--test', '--test-reporter=tap', '--test-name-pattern=^una acreditación vale mientras coinciden sus dos huellas, y una alterada se salta sin abortar$', 'test/sdd-verify-run.test.ts'],
  references: ['node', '--import', './test/no-subprocess.ts', '--test', '--test-reporter=tap', '--test-name-pattern=^el registro del flujo guarda referencias de verify en orden y rechaza las mal formadas$', 'test/sdd-verify-run.test.ts'],
  question: ['node', '--import', './test/no-subprocess.ts', '--test', '--test-reporter=tap', '--test-name-pattern=^la pregunta canónica sale igual byte a byte y cambia con la huella de un gate anterior$', 'test/approval.test.ts'],
  activity: ['node', '--import', './test/no-subprocess.ts', '--test', '--test-reporter=tap', '--test-name-pattern=^actividad activa o incierta impide registrar o recuperar con su codigo y permite reintentar con la misma respuesta$', 'test/sdd-approve-activity.test.ts'],
} as const

export async function runArchiveCharacterizer(name: keyof typeof archiveCharacterizers, candidateRoot = join(import.meta.dirname, '..')): Promise<void> {
  const [executable, ...argv] = archiveCharacterizers[name]
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env
  const { stdout } = await execute(executable, argv, { cwd: candidateRoot, env, maxBuffer: 16 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS })
  const expected = argv.find((arg) => arg.startsWith('--test-name-pattern='))!.slice('--test-name-pattern=^'.length, -1)
  const line = stdout.split('\n').find((text) => /^ok \d+ - /.test(text) && text.includes(expected))
  assert.ok(line && !line.includes('# SKIP'), `el caracterizador ${expected} debe ejecutarse y aprobar: ${stdout}`)
}
