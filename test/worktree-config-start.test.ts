import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createWorktreeFixture, put } from './worktree-config-fixture.ts'

test('start orienta a reuse y permite arrancar después de copiar sin eliminar otros bloqueos', (t) => {
  const f = createWorktreeFixture()
  try {
    assert.equal(existsSync(join(f.linked, 'node_modules')), false)
    const before = f.cli(['sdd', 'start', 'new-flow'])
    const missing = before.out.blockers.find((b: { code: string }) => b.code === 'config_missing')
    assert.ok(missing)
    assert.match(missing.next, /node .*bin[/\\]sdd-ai.* init --reuse-config$/)
    assert.equal(f.cli(['init', '--reuse-config']).code, 0)
    assert.equal(existsSync(join(f.linked, '.plans', 'new-flow')), false)
    const ready = f.cli(['sdd', 'start', 'new-flow'])
    assert.equal(ready.out.config.state, 'ok')
    assert.deepEqual(ready.out.blockers, [])
    const applied = f.cli(['sdd', 'start', 'new-flow', '--apply', '--depth', 'normal', '--risk', 'low', '--change-type', 'fix', '--request', f.request])
    assert.equal(applied.code, 0, JSON.stringify(applied.out))
    assert.ok(existsSync(join(f.linked, '.plans', 'new-flow', 'handoff.md')))
    assert.equal(existsSync(join(f.linked, '.plans', 'new-flow', 'spec.md')), false)
    assert.ok(f.cli(['sdd', 'start', 'new-flow']).out.blockers.some((b: { code: string }) => b.code === 'flow_exists'))
    rmSync(join(f.bin, process.platform === 'win32' ? 'codex.exe' : 'codex'))
    assert.ok(f.cli(['sdd', 'start', 'other-flow']).out.blockers.some((b: { code: string }) => b.code === 'family_cli_missing'))
    rmSync(join(f.main, '.sdd-ai'), { recursive: true })
    const principal = f.cli(['sdd', 'start', 'other-flow'], f.main)
    // Solo el next: las rutas del JSON pueden contener «reuse-config» por el nombre del checkout.
    const principalMissing = principal.out.blockers.find((b: { code: string }) => b.code === 'config_missing')
    assert.ok(principalMissing)
    assert.doesNotMatch(principalMissing.next, /--reuse-config/)
    put(join(f.linked, '.sdd-ai', 'config.yml'), '')
    assert.equal(f.cli(['sdd', 'start', 'invalid-flow']).out.config.state, 'invalid')
    const config = join(f.linked, '.sdd-ai', 'config.yml')
    chmodSync(config, 0)
    let denied = false
    try { readFileSync(config) } catch { denied = true }
    if (denied) {
      const unreadable = f.cli(['sdd', 'start', 'access-flow'])
      assert.equal(unreadable.out.config.state, 'invalid')
      assert.ok(!unreadable.out.blockers.some((b: { next: string }) => /--reuse-config/.test(b.next)))
    } else t.diagnostic('Permisos reales de start no acreditados: el usuario puede leer modo 000.')
    chmodSync(config, 0o600)
    rmSync(join(f.linked, '.sdd-ai'), { recursive: true })
    symlinkSync(f.env.HOME, join(f.linked, '.sdd-ai'), 'dir')
    const linked = f.cli(['sdd', 'start', 'invalid-flow'])
    assert.equal(linked.out.config.state, 'invalid')
    assert.ok(!JSON.stringify(linked.out.blockers).includes('reuse-config'))
  } finally { f.cleanup() }
})
