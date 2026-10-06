import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gitDirs } from '../src/git.ts'
import { prepareIntent, restoreIntentOpen, writeRestoreIntent } from '../src/sdd/restore.ts'
import { type FsFault, withFsFault } from './fs-fault.ts'
import { makeRepo, telemetryOff } from './helpers.ts'
import { BIN, cli, gitIn, realpathTmp, verifyFlow } from './sdd-verify-fixture.ts'

const FAULT = pathToFileURL(join(import.meta.dirname, 'fs-fault.ts')).href
const CANDIDATE = 'export const f = () => 2\n'

const sessionEnv = () => ({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp(), CODEX_SESSION_ID: '', CODEX_THREAD_ID: '' })

/** `sdd verify f` por el binario, con el inyector cargado con `--import` y el fallo en `SDD_TEST_FS_FAULT`. */
function verifyWith(repo: string, fault: FsFault) {
  const { NODE_TEST_CONTEXT: _ctx, ...base } = process.env
  const env = telemetryOff({ ...base, ...sessionEnv(), SDD_TEST_FS_FAULT: JSON.stringify(fault) })
  const r = spawnSync(process.execPath, ['--import', FAULT, BIN, 'sdd', 'verify', 'f'], { cwd: repo, encoding: 'utf8', timeout: 120000, env })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** El fallo sale como un único JSON con `code` y `next`, sin stack trace y con salida distinta de 0. */
function assertDurableError(r: ReturnType<typeof verifyWith>): Record<string, any> {
  assert.notEqual(r.code, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout) as Record<string, any>
  assert.equal(out.state, 'error', r.stdout)
  assert.equal(out.code, 'durable_write_failed', r.stdout)
  assert.equal(out.next, './bin/sdd-ai sdd verify f')
  assert.match(out.message, /no se pudo .+ .+/)
  assert.equal(r.stderr.includes('\n    at '), false, r.stderr)
  return out
}

function intentRepo() {
  const repo = makeRepo()
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'a\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'src', 'a.ts'), 'a2\n')
  return { repo, base }
}

test('en win32, EPERM, EACCES o EISDIR al sincronizar un directorio no cortan la escritura durable', () => {
  for (const code of ['EPERM', 'EACCES', 'EISDIR']) {
    for (const op of ['open-dir', 'sync-dir'] as const) {
      const { repo, base } = intentRepo()
      withFsFault({ op, code, platform: 'win32' }, () => {
        const intent = prepareIntent(repo, '20260929-1600-aaaa', base, ['src/a.ts'])
        writeRestoreIntent(repo, intent)
      })
      assert.equal(restoreIntentOpen(repo), true, `${op} ${code}`)
    }
  }
})

test('fuera de win32, un EPERM al sincronizar un directorio sale como durable_write_failed', () => {
  const { repo } = verifyFlow()
  const out = assertDurableError(verifyWith(repo, { op: 'sync-dir', code: 'EPERM', platform: 'linux' }))
  assert.match(out.message, /sincronizar el directorio/)
})

test('en win32, un EIO al sincronizar un directorio sale como durable_write_failed', () => {
  const { repo } = verifyFlow()
  const out = assertDurableError(verifyWith(repo, { op: 'sync-dir', code: 'EIO', platform: 'win32' }))
  assert.match(out.message, /sincronizar el directorio/)
})

test('un fallo antes de publicar la intención sale como JSON con code y next, sin stack trace', () => {
  const { repo } = verifyFlow()
  const out = assertDurableError(verifyWith(repo, { op: 'sync-dir', code: 'EIO', suffix: 'blobs' }))
  assert.match(out.message, /blobs/)
  assert.equal(out.message.includes('ya se publicó'), false, out.message)
  assert.equal(restoreIntentOpen(repo), false)
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), CANDIDATE)
})

test('un fallo después de publicar la intención lo dice en el mensaje y el comando siguiente restaura', () => {
  const { repo } = verifyFlow()
  const out = assertDurableError(verifyWith(repo, { op: 'rename', code: 'EIO', suffix: 'src/a.ts' }))
  assert.match(out.message, /ya se publicó/)
  assert.equal(restoreIntentOpen(repo), true)
  assert.deepEqual(readdirSync(join(repo, 'src')).filter((name) => name.endsWith('.tmp')), [])
  // El binario resuelve la restauración al arrancar el comando siguiente, sin el inyector.
  const status = cli(repo, sessionEnv(), 'sdd', 'status', 'f')
  assert.equal(status.code, 0, JSON.stringify(status.out))
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), CANDIDATE)
  assert.equal(restoreIntentOpen(repo), false)
})

test('un fallo al publicar el recibo sale como durable_write_failed', () => {
  const { repo } = verifyFlow()
  const out = assertDurableError(verifyWith(repo, { op: 'rename', code: 'EIO', suffix: 'receipt.json' }))
  assert.match(out.message, /publicar el recibo/)
  assert.match(out.message, /receipt\.json/)
})

test('un fsync de archivo que falla no deja el temporal junto al destino', () => {
  const { repo } = verifyFlow()
  const out = assertDurableError(verifyWith(repo, { op: 'sync-file', code: 'EIO', suffix: '.tmp' }))
  assert.match(out.message, /no se pudo escribir/)
  const root = join(gitDirs(repo).gitDir, 'sdd-ai', 'verify')
  const leftovers = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  assert.deepEqual(readdirSync(join(repo, 'src')).filter((name) => name.endsWith('.tmp')), [])
})

test('en win32, los directorios de un recibo sin intención no impiden el verify siguiente', () => {
  const { repo } = verifyFlow()
  const first = assertDurableError(verifyWith(repo, { op: 'sync-dir', code: 'EIO', suffix: 'blobs', platform: 'win32' }))
  assert.equal(first.message.includes('ya se publicó'), false, first.message)
  const root = join(gitDirs(repo).gitDir, 'sdd-ai', 'verify')
  const receipts = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'attestations')
  assert.equal(receipts.length, 1)
  assert.equal(existsSync(join(root, receipts[0].name, 'blobs')), true)
  assert.equal(restoreIntentOpen(repo), false)

  const second = verifyWith(repo, { op: 'sync-dir', code: 'EPERM', platform: 'win32' })
  assert.equal(second.code, 0, second.stdout + second.stderr)
  const out = JSON.parse(second.stdout) as Record<string, any>
  assert.equal(out.code, undefined, second.stdout)
  assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), CANDIDATE)
})
