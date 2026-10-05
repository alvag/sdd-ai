import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chainSetup, telemetryOff } from './helpers.ts'
import { setup as runSetup } from './cli-run-fixture.ts'
import { setup as roundsSetup } from './rounds-cli-fixture.ts'
import { reviewedFlowEnv } from './sdd-verify-fixture.ts'

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

test('el preload apaga publicaciones en el archivo común y su hijo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-guard-telemetry-'))
  try {
    const file = join(dir, 'settings.test.ts')
    writeFileSync(file, "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { execFileSync } from 'node:child_process'\n"
      + "test('off', () => { assert.equal(process.env.SDD_AI_TELEMETRY, 'off'); assert.equal(execFileSync(process.execPath, ['-p', 'process.env.SDD_AI_TELEMETRY'], { encoding: 'utf8' }).trim(), 'off') })\n")
    const env: NodeJS.ProcessEnv = { ...process.env, SDD_AI_TELEMETRY: 'on' }
    delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, ['--import', GUARD, '--test', file], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('telemetryOff permite fijar o retirar el override', () => {
  assert.equal(telemetryOff({ HOME: '/tmp/example' }).SDD_AI_TELEMETRY, 'off')
  assert.equal(telemetryOff({ SDD_AI_TELEMETRY: 'on' }).SDD_AI_TELEMETRY, 'on')
  assert.equal(telemetryOff({ SDD_AI_TELEMETRY: 'off' }).SDD_AI_TELEMETRY, 'off')
  assert.equal('SDD_AI_TELEMETRY' in telemetryOff({ SDD_AI_TELEMETRY: undefined }), false)
  assert.equal(telemetryOff({ HOME: '/tmp/example' }).SDD_AI_PROJECTION, 'off')
  assert.equal('SDD_AI_PROJECTION' in telemetryOff({ SDD_AI_PROJECTION: undefined }), false)
})

// Se arman los entornos sin lanzar revisiones: committable usa el de chainSetup, y reviewedFlow, el de reviewedFlowEnv.
test('las fixtures importables de procesos apagan publicaciones por defecto', () => {
  const temporary: string[] = []
  // Todo lo temporal que deja una fixture: su repo, el bin del PATH y los directorios de su entorno.
  const track = (env: Record<string, string>, ...dirs: string[]) => {
    temporary.push(...dirs, env.PATH.split(':')[0])
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) if (env[key]) temporary.push(env[key])
    if (env.FAKE_CALLS_FILE) temporary.push(dirname(env.FAKE_CALLS_FILE))
    return env
  }
  try {
    // Cada fixture se registra apenas se arma: si la siguiente falla, la anterior igual se limpia.
    const chain = chainSetup()
    const envs = [track(chain.env, chain.repo)]
    const run = runSetup()
    envs.push(track(run.env, run.repo, dirname(run.prompt)))
    const rounds = roundsSetup([])
    envs.push(track(rounds.env, rounds.repo))
    const reviewed = reviewedFlowEnv()
    envs.push(track(reviewed.env, ...reviewed.dirs))
    for (const env of envs) {
      assert.equal(env.SDD_AI_TELEMETRY, 'off')
      assert.equal(env.SDD_AI_PROJECTION, 'off')
    }
  } finally {
    const tmp = realpathSync(tmpdir())
    for (const dir of temporary) if (dir.startsWith(tmp) || dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
  }
})
