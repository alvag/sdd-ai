import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createWorktreeFixture, FILES, put, snapshot, SOURCE_FILES } from './worktree-config-fixture.ts'

test('reuse conserva config existente y start distingue ausencia de contenido inválido', () => {
  const f = createWorktreeFixture()
  try {
    rmSync(join(f.main, '.sdd-ai'), { recursive: true })
    for (const text of [SOURCE_FILES['config.yml'], '', '[', 'jira_approval: {mode: off}', 'cross_model: {schema_version: 99, families: [codex]}']) {
      put(join(f.linked, '.sdd-ai', 'config.yml'), text)
      const before = snapshot(join(f.linked, '.sdd-ai'))
      const r = f.cli(['init', '--reuse-config'])
      assert.equal(r.code, text === SOURCE_FILES['config.yml'] ? 0 : 2)
      assert.equal(r.out.source, null)
      assert.deepEqual(r.out.copied, [])
      assert.deepEqual(snapshot(join(f.linked, '.sdd-ai')), before)
      const start = f.cli(['sdd', 'start', 'check'])
      assert.ok(!JSON.stringify(start.out.blockers).includes('reuse-config'))
      assert.equal(start.out.config.state, text === SOURCE_FILES['config.yml'] ? 'ok' : 'invalid')
      assert.ok(!start.out.blockers.some((b: { code: string }) => b.code === 'config_missing'))
    }
  } finally { f.cleanup() }
})

test('reuse diagnostica identificación fallida y fuente incompleta sin escribir', () => {
  const f = createWorktreeFixture()
  try {
    const outside = join(f.scratch, 'sin git')
    mkdirSync(outside)
    const unidentified = f.cli(['init', '--reuse-config'], outside)
    assert.equal(unidentified.code, 2)
    assert.equal(unidentified.out.state, 'blocked')
    assert.equal(unidentified.out.errors[0].code, 'git_identification_failed')
    assert.equal(unidentified.out.errors[0].path, outside)
    assert.equal(existsSync(join(outside, '.sdd-ai')), false)
    const mainBefore = snapshot(join(f.main, '.sdd-ai'))
    const principal = f.cli(['init', '--reuse-config'], f.main)
    assert.equal(principal.code, 2)
    assert.match(principal.out.errors[0].message, /worktree enlazado/)
    assert.deepEqual(snapshot(join(f.main, '.sdd-ai')), mainBefore)
    for (const name of FILES) {
      rmSync(join(f.main, '.sdd-ai', name))
      const r = f.cli(['init', '--reuse-config'])
      assert.equal(r.code, 2)
      assert.equal(r.out.errors[0].path, join(f.main, '.sdd-ai', name))
      assert.deepEqual(r.out.copied, [])
      assert.equal(existsSync(join(f.linked, '.sdd-ai')), false)
      put(join(f.main, '.sdd-ai', name), SOURCE_FILES[name])
    }
    // Principal listado por Git cuyo árbol ya no está disponible.
    rmSync(join(f.main, '.sdd-ai'), { recursive: true })
    const missing = f.cli(['init', '--reuse-config'])
    assert.equal(missing.code, 2)
    assert.equal(missing.out.errors[0].path, join(f.main, '.sdd-ai'))
    assert.equal(existsSync(join(f.linked, '.sdd-ai')), false)
    const bare = join(f.scratch, 'principal bare ü')
    const bareLinked = join(f.scratch, 'linked bare á')
    f.git(['init', '--bare', '-q', bare])
    f.git(['--git-dir', bare, 'fetch', '-q', f.main, 'main'])
    f.git(['--git-dir', bare, 'worktree', 'add', '-q', '-b', 'bare-linked', bareLinked, 'FETCH_HEAD'])
    const unusable = f.cli(['init', '--reuse-config'], bareLinked)
    assert.equal(unusable.code, 2)
    assert.equal(unusable.out.source, bare)
    assert.equal(existsSync(join(bareLinked, '.sdd-ai')), false)
  } finally { f.cleanup() }
})

test('reuse rechaza entradas no regulares enlaces y contratos inválidos antes de copiar', (t) => {
  const f = createWorktreeFixture()
  try {
    const target = join(f.scratch, 'destino del enlace')
    put(target, 'intacto')
    for (const root of [f.main, f.linked]) {
      for (const name of FILES) for (const kind of ['directory', 'link', 'broken']) {
        const path = join(root, '.sdd-ai', name)
        rmSync(path, { force: true })
        if (kind === 'directory') mkdirSync(path, { recursive: true })
        else { mkdirSync(join(root, '.sdd-ai'), { recursive: true }); symlinkSync(kind === 'link' ? target : `${target}-missing`, path) }
        const before = snapshot(join(root, '.sdd-ai'))
        const r = f.cli(['init', '--reuse-config'])
        assert.equal(r.code, 2, `${root}/${name}/${kind}`)
        assert.deepEqual(r.out.copied, [])
        assert.deepEqual(snapshot(join(root, '.sdd-ai')), before)
        assert.equal(readFileSync(target, 'utf8'), 'intacto')
        rmSync(path, { recursive: true, force: true })
        if (root === f.main) put(path, SOURCE_FILES[name])
      }
    }
    for (const root of [f.main, f.linked]) for (const kind of ['file', 'link', 'broken']) {
      const path = join(root, '.sdd-ai')
      rmSync(path, { recursive: true, force: true })
      if (kind === 'file') put(path, 'entrada local')
      else symlinkSync(kind === 'link' ? f.env.HOME : `${f.env.HOME}-missing`, path, 'dir')
      const home = snapshot(f.env.HOME)
      const r = f.cli(['init', '--reuse-config'])
      assert.equal(r.code, 2)
      // Un destino rechazado se informa una sola vez.
      if (root === f.linked) assert.deepEqual(r.out.errors.map((e: { code: string }) => e.code), ['destination_invalid'])
      assert.deepEqual(snapshot(f.env.HOME), home)
      rmSync(path, { force: true })
      if (root === f.main) for (const name of FILES) put(join(path, name), SOURCE_FILES[name])
    }
    for (const text of ['[', '', 'cross_model: {schema_version: 99}', 'cross_model: {schema_version: 1, families: []}',
      ...['jira_approval: {mode: wrong}', 'branch_format: "{wrong}"', 'branch_prefix: []', 'default_branch: []', 'knowledge-vault: {path_vault: []}'].map((extra) => `cross_model: {schema_version: 1, families: [codex]}\n${extra}\n`)]) {
      put(join(f.main, '.sdd-ai', 'config.yml'), text)
      const r = f.cli(['init', '--reuse-config'])
      assert.equal(r.code, 2)
      assert.equal(r.out.errors[0].path, join(f.main, '.sdd-ai', 'config.yml'))
      assert.equal(existsSync(join(f.linked, '.sdd-ai')), false)
    }
    put(join(f.main, '.sdd-ai', 'config.yml'), SOURCE_FILES['config.yml'])
    for (const text of ['[', 'schema_version: 99\nroles: {}', 'schema_version: 1\nroles: {unknown: {}}']) {
      put(join(f.main, '.sdd-ai', 'workers.yml'), text)
      assert.equal(f.cli(['init', '--reuse-config']).code, 2)
      assert.equal(existsSync(join(f.linked, '.sdd-ai')), false)
    }
    put(join(f.main, '.sdd-ai', 'workers.yml'), SOURCE_FILES['workers.yml'])
    const path = join(f.main, '.sdd-ai', '.gitignore')
    chmodSync(path, 0)
    let denied = false
    try { readFileSync(path) } catch { denied = true }
    if (denied) {
      assert.equal(f.cli(['init', '--reuse-config']).code, 2)
      assert.equal(existsSync(join(f.linked, '.sdd-ai')), false)
    } else t.diagnostic('El usuario puede leer archivos con modo 000; permisos reales no acreditados. V7 induce EACCES.')
    chmodSync(path, 0o600)
  } finally { f.cleanup() }
})
