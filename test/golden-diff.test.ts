import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freeze, readContext } from '../src/review/candidate.ts'
import { renderReviewPrompt } from '../src/review/prompt.ts'
import { GOLDEN_DIR, RELAUNCH_ANSWERS, cli, goldenRepo, reviewEnv, roundTwo } from './fixtures/golden-diff/capture.ts'

const golden = (name: string) => readFileSync(join(GOLDEN_DIR, name), 'utf8')

test('el prompt de ronda 1, el de ronda N y el hash de un diff son byte a byte los del golden de 4a95927', () => {
  const { repo, base } = goldenRepo()
  const c = freeze(repo, { base, context: [] })
  assert.equal(`${c.hash}\n`, golden('hash.txt'))
  assert.equal(renderReviewPrompt(c, readContext(repo, c)), golden('prompt-r1.md'))
  assert.equal(roundTwo(repo, base, c.hash), golden('prompt-rN.md'))
})

test('una corrida vieja incompleta relanzada conserva su trabajo admitido con el mismo prompt_sha256 y no lo vuelve a lanzar', () => {
  const old = JSON.parse(golden('run-old.json')) as { id: string; repo: string }
  const { repo } = goldenRepo()
  const env = reviewEnv(repo, RELAUNCH_ANSWERS)
  const dir = join(repo, '.sdd-ai', 'runs', old.id)
  cpSync(join(GOLDEN_DIR, 'run-old'), dir, { recursive: true })
  // El argv guarda rutas del repo en que se capturó la corrida: se llevan al repo de este test.
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const text = readFileSync(join(dir, f), 'utf8')
    if (text.includes(old.repo)) writeFileSync(join(dir, f), text.replaceAll(old.repo, repo))
  }
  const before = JSON.parse(readFileSync(join(dir, 'rounds.json'), 'utf8')) as { rounds: Array<{ jobs?: Array<{ key: string; state: string; prompt_sha256: string }> }> }
  const admitted = new Map((before.rounds.at(-1)?.jobs ?? []).filter((j) => j.state === 'done').map((j) => [j.key, j.prompt_sha256]))
  assert.equal(admitted.size, 4)

  const r = cli(repo, env, ['review', 'round', old.id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.round, r.out.launch, r.out.kept], [1, 2, ['base-b1', 'resilience-b1', 'reliability-b1', 'readability-b1']])
  const argv = JSON.parse(readFileSync(join(dir, 'argv-l2.json'), 'utf8')) as { jobs: Array<{ key: string }>; kept: Array<{ key: string; prompt_sha256: string }> }
  assert.deepEqual(argv.jobs.map((j) => j.key), ['risk-b1'])
  assert.deepEqual(new Map(argv.kept.map((j) => [j.key, j.prompt_sha256])), admitted)
  const w = cli(repo, env, ['wait', old.id, '--max', '20'])
  assert.equal(w.out.state, 'done', JSON.stringify(w.out))
  assert.equal(readFileSync(env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').length, 1)
})
