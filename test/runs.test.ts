import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from '../src/git.ts'
import { createRun, isAlive, newRunId, readStatus, runDir, setStatus } from '../src/runs.ts'
import { SddError } from '../src/types.ts'
import { makeRepo } from './helpers.ts'

const isCode = (code: string) => (e: unknown) => e instanceof SddError && e.code === code

test('newRunId arma AAAAMMDD-HHMM-<4 hex> en hora local', () => {
  assert.equal(newRunId(new Date(2026, 8, 24, 14, 32), () => 'a7f3'), '20260924-1432-a7f3')
  assert.match(newRunId(), /^\d{8}-\d{4}-[0-9a-f]{4}$/)
})

test('createRun vive en .sdd-ai/runs y el directorio se ignora solo', () => {
  const repo = makeRepo()
  const dir = createRun(repo, '20260924-1432-a7f3')
  assert.equal(dir, join(repo, '.sdd-ai', 'runs', '20260924-1432-a7f3'))
  assert.equal(existsSync(dir), true)
  assert.equal(readFileSync(join(repo, '.sdd-ai', '.gitignore'), 'utf8'), '*\n')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '')
})

test('createRun no pisa una corrida existente', () => {
  const repo = makeRepo()
  createRun(repo, 'x')
  assert.throws(() => createRun(repo, 'x'))
})

test('setStatus mezcla campos y escribe de forma atómica', () => {
  const dir = createRun(makeRepo(), 'x')
  setStatus(dir, { state: 'running' })
  setStatus(dir, { worker_pid: 5 })
  assert.deepEqual(readStatus(dir), { state: 'running', worker_pid: 5 })
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
})

test('runDir de una corrida que no existe es run_not_found', () => {
  assert.throws(() => runDir(makeRepo(), 'nope'), isCode('run_not_found'))
})

test('repoRoot fuera de un repo es not_a_repo', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-norepo-')))
  assert.throws(() => repoRoot(outside), isCode('not_a_repo'))
  const repo = makeRepo()
  assert.equal(repoRoot(repo), repo)
})

test('isAlive distingue un proceso vivo de uno inexistente', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(2 ** 22 - 1), false)
})
