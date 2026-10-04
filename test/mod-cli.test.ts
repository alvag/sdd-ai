import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo, telemetryOff } from './helpers.ts'

test('the CLI keeps its JSON and exit codes without a mod', () => {
  const repo = makeRepo()
  try {
    const cases = [
      { args: ['sdd', 'status'], code: 0, stdout: '{"flows":[]}\n' },
      { args: ['wait', '20990101-0000-dead'], code: 1, stdout: '{"state":"error","code":"run_not_found","message":"no existe la corrida 20990101-0000-dead","next":"revisa el id que devolvió sdd-ai run"}\n' },
      { args: ['run', '--not-an-option'], code: 2, stdout: '{"state":"error","code":"usage","message":"Unknown option \'--not-an-option\'"}\n' },
    ]
    for (const c of cases) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, '../bin/sdd-ai'), ...c.args], { cwd: repo, encoding: 'utf8', env: telemetryOff({ ...process.env }), timeout: 30000 })
      assert.equal(r.status, c.code)
      assert.equal(r.stdout, c.stdout)
      assert.equal(r.stderr, '')
    }
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
