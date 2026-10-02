import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GUARD = join(import.meta.dirname, 'no-subprocess.ts')

/**
 * Corre con el guard, como `npm test`, un archivo de test con ese nombre que lanza `git`. Si el guard
 * tocara el proceso del runner, este no podría lanzar el archivo y el error nombraría `spawn`.
 */
function runWithGuard(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-guard-')))
  try {
    const file = join(dir, name)
    writeFileSync(file, "import { test } from 'node:test'\nimport { execFileSync } from 'node:child_process'\n"
      + "test('lanza git', () => { execFileSync('git', ['--version']) })\n")
    // Sin el contexto del runner de afuera: el runner de adentro sería un hijo que no informa como tal.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    return spawnSync(process.execPath, ['--import', GUARD, '--test', '--test-reporter=tap', file], { env, encoding: 'utf8', timeout: 60_000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('un *.unit.test.ts que lanza un subproceso falla y nombra la llamada', () => {
  const r = runWithGuard('lanza.unit.test.ts')
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /Un test unitario no puede lanzar subprocesos: execFileSync\(git\)/)
})

test('el guard no toca un *.test.ts común', () => {
  const r = runWithGuard('lanza.test.ts')
  assert.equal(r.status, 0, r.stdout)
})
