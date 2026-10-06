// Captura el golden de la revisión de diffs: los prompts, el hash y una corrida incompleta tal como los
// produce el código de hoy. Se corre una sola vez, antes de cambiar la revisión, y lo que escribe queda
// fijo: el test compara el código nuevo contra esos bytes.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freeze, readContext } from '../../../src/review/candidate.ts'
import type { Ledger, RoundPlan } from '../../../src/review/ledger.ts'
import { renderMaterial, renderReviewPrompt, renderRoundPrompt } from '../../../src/review/prompt.ts'
import { makeFakeBin, makeRepo, telemetryOff } from '../../helpers.ts'

export const GOLDEN_DIR = import.meta.dirname
const BIN = join(import.meta.dirname, '..', '..', '..', 'bin', 'sdd-ai')

// Autor, commiter y fechas fijos: el SHA de la base entra al hash del candidato y tiene que ser siempre el mismo.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

export const lines = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => `${change[i + 1] ?? `línea ${i + 1}`}\n`).join('')

/** Repo con a.txt de 10 líneas commiteado y la línea 5 cambiada en el árbol. */
export function goldenRepo(): { repo: string; base: string } {
  const repo = makeRepo()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim()
  writeFileSync(join(repo, 'a.txt'), lines(10))
  git('add', 'a.txt')
  git('commit', '-qm', 'base')
  writeFileSync(join(repo, 'a.txt'), lines(10, { 5: 'línea cinco' }))
  return { repo, base: git('rev-parse', 'HEAD') }
}

/** Un ledger con un hallazgo aceptado y otro rechazado, para la ronda 2. */
export const LEDGER: Ledger = {
  completed: 1, next_id: 3,
  entries: [
    {
      id: 'F-1', round: 1, state: 'aceptado', axis: 'quality', severity: 'CRITICAL', location: 'a.txt:5',
      claim: 'la línea 5 no valida', causality: 'introduced', evidence: 'deterministic', responses: [],
      decision: { action: 'accept', from: 'abierto', after_round: 1 },
    },
    {
      id: 'F-2', round: 1, state: 'rechazado', axis: 'scope', severity: 'WARNING', location: 'a.txt:5',
      claim: 'sobra el cambio de nombre', responses: [],
      decision: { action: 'reject', reason: 'el nombre lo pidió el plan', from: 'abierto', after_round: 1 },
    },
  ],
}

/** El prompt de ronda 2 sobre la corrección de la línea 5. */
export function roundTwo(repo: string, base: string, prevHash: string): string {
  writeFileSync(join(repo, 'a.txt'), lines(10, { 5: 'línea cinco validada' }))
  const c = freeze(repo, { base, context: [] })
  const plan: RoundPlan = {
    n: 2, prev_hash: prevHash, identical: false,
    targets: [{ id: 'F-1', kind: 'verify' }, { id: 'F-2', kind: 'respond' }], changed: { 'a.txt': [[5, 5]] },
  }
  return renderRoundPrompt(c, renderMaterial(c, readContext(repo, c)), plan, LEDGER.entries, 3)
}

const said = (who: string) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify([{ axis: 'scope', severity: 'WARNING', location: 'a.txt:5', claim: `lo dice ${who}` }])}}`

/** Config de revisión con Claude como revisor (el autor es Codex) y el CLI falso guionado con `answers`. */
export function reviewEnv(repo: string, answers: string[]): Record<string, string> {
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  writeFileSync(join(repo, '.sdd-ai', '.gitignore'), '*\n')
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex, claude]\n  selection: full\n')
  writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), [
    'schema_version: 1', 'roles:',
    '  code-review:', '    claude:', '      model: opus', '      effort: alto',
    '  refute:', '    claude:', '      model: sonnet', '      effort: medio', '',
  ].join('\n'))
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  makeFakeBin(bin, 'claude')
  const work = mkdtempSync(join(tmpdir(), 'sdd-ai-fake-'))
  writeFileSync(join(work, 'answers.json'), JSON.stringify(answers))
  return telemetryOff({
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1',
    FAKE_MODE: 'scripted', FAKE_ANSWERS: join(work, 'answers.json'), FAKE_CALLS_FILE: join(work, 'calls'),
  })
}

export function cli(repo: string, env: Record<string, string>, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}

/** La respuesta del CLI falso para el trabajo que falta al relanzar la corrida vieja. */
export const RELAUNCH_ANSWERS = [said('risk')]

function capture(): void {
  const { repo, base } = goldenRepo()
  const c = freeze(repo, { base, context: [] })
  writeFileSync(join(GOLDEN_DIR, 'prompt-r1.md'), renderReviewPrompt(c, readContext(repo, c)))
  writeFileSync(join(GOLDEN_DIR, 'hash.txt'), `${c.hash}\n`)
  writeFileSync(join(GOLDEN_DIR, 'prompt-rN.md'), roundTwo(repo, base, c.hash))

  // La corrida vieja: nivel alto, cinco trabajos, y el de la lente de riesgo falla.
  const old = goldenRepo()
  const env = reviewEnv(old.repo, [said('base'), '__fail__', said('resilience'), said('reliability'), said('readability')])
  const start = cli(old.repo, env, ['review', 'start', '--base', old.base, '--author', 'codex', '--risk', 'high'])
  if (start.code !== 0) throw new Error(`review start falló: ${JSON.stringify(start.out)}`)
  const w = cli(old.repo, env, ['wait', start.out.id, '--max', '20'])
  if (w.out.state !== 'unavailable') throw new Error(`la corrida vieja terminó ${w.out.state}, no unavailable`)
  const dest = join(GOLDEN_DIR, 'run-old')
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(old.repo, '.sdd-ai', 'runs', start.out.id), dest, { recursive: true })
  writeFileSync(join(GOLDEN_DIR, 'run-old.json'), `${JSON.stringify({ id: start.out.id, repo: old.repo }, null, 2)}\n`)
}

if (process.argv[1] === import.meta.filename) capture()
