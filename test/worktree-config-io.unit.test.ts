import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILES, reuseWorktreeConfig, type WorktreeConfigDeps } from '../src/worktree-config.ts'

const CONFIG = 'cross_model: {schema_version: 1, families: [codex]}\n'
const WORKERS = 'schema_version: 1\nroles: {}\n'
function setup() {
  const scratch = mkdtempSync(join(tmpdir(), 'reuse-io-'))
  const root = join(scratch, 'linked')
  const source = join(scratch, 'main')
  mkdirSync(root)
  mkdirSync(join(source, '.sdd-ai'), { recursive: true })
  for (const [name, text] of [['.gitignore', '*\n'], ['workers.yml', WORKERS], ['config.yml', CONFIG]]) writeFileSync(join(source, '.sdd-ai', name), text)
  const deps: Partial<WorktreeConfigDeps> = {
    gitDirs: () => ({ gitDir: 'linked-git-dir', commonDir: 'common-git-dir' }), mainWorktree: () => source,
  }
  return { root, source, scratch, deps, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
}
const denied = () => Object.assign(new Error('EACCES: permiso denegado'), { code: 'EACCES' })

test('reuse informa archivos y directorios ilegibles sin comenzar la copia', () => {
  for (const kind of ['local-dir', 'source-dir', ...CONFIG_FILES, 'local-workers', 'source-root']) {
    const f = setup()
    try {
      let writes = 0
      const path = kind === 'local-dir' ? join(f.root, '.sdd-ai') : kind === 'source-dir' ? join(f.source, '.sdd-ai')
        : kind === 'source-root' ? f.source : kind === 'local-workers' ? join(f.root, '.sdd-ai', 'workers.yml') : join(f.source, '.sdd-ai', kind)
      if (kind === 'local-workers') { mkdirSync(join(f.root, '.sdd-ai')); writeFileSync(path, WORKERS) }
      const r = reuseWorktreeConfig(f.root, { ...f.deps,
        lstat: (p) => { if (p === path && (kind.endsWith('dir') || kind === 'source-root')) throw denied(); return lstatSync(p) },
        readFile: (p) => { if (p === path) throw denied(); return readFileSync(p, 'utf8') },
        mkdir: () => { writes++ }, copyFile: () => { writes++ },
      })
      assert.equal(r.state, 'blocked', kind)
      assert.deepEqual(r.copied, [])
      assert.equal(r.errors[0].path, path)
      assert.match(r.errors[0].message, /EACCES/)
      assert.equal(writes, 0)
    } finally { f.cleanup() }
  }
  for (const principal of [undefined, '/missing-checkout']) {
    const f = setup()
    try {
      const r = reuseWorktreeConfig(f.root, { ...f.deps, mainWorktree: () => principal })
      assert.equal(r.state, 'blocked')
      assert.equal(existsSync(join(f.root, '.sdd-ai')), false)
    } finally { f.cleanup() }
  }
})

test('reuse conserva el destino aparecido inmediatamente antes de la copia exclusiva', () => {
  for (const name of CONFIG_FILES) for (const kind of ['valid', 'invalid', 'directory', 'link', 'broken']) {
    const f = setup()
    try {
      let before: { bytes: Buffer; mtime: number } | undefined
      const target = join(f.scratch, 'link-target')
      writeFileSync(target, 'no modificar')
      let calls = 0
      const r = reuseWorktreeConfig(f.root, { ...f.deps, copyFile: (source, destination, flags) => {
        calls++
        assert.equal(flags, constants.COPYFILE_EXCL)
        if (destination === join(f.root, '.sdd-ai', name)) {
          if (kind === 'directory') mkdirSync(destination)
          else if (kind === 'link' || kind === 'broken') symlinkSync(kind === 'link' ? target : `${target}-missing`, destination)
          else {
            const text = kind === 'invalid' ? '[' : name === 'config.yml' ? `${CONFIG}# local\n` : name === 'workers.yml' ? `${WORKERS}# local\n` : '# local\n*\n'
            writeFileSync(destination, text)
            before = { bytes: readFileSync(destination), mtime: lstatSync(destination).mtimeMs }
          }
        }
        copyFileSync(source, destination, flags)
      } })
      const label = `${name}/${kind}: ${JSON.stringify(r.errors)}`
      assert.ok(!r.copied.includes(name), label)
      assert.ok(r.preserved.includes(name), label)
      const path = join(f.root, '.sdd-ai', name)
      if (before) { assert.deepEqual(readFileSync(path), before.bytes); assert.equal(lstatSync(path).mtimeMs, before.mtime) }
      assert.equal(readFileSync(target, 'utf8'), 'no modificar')
      const valid = kind === 'valid' || kind === 'invalid' && name === '.gitignore'
      assert.equal(r.state, valid ? 'copied' : CONFIG_FILES.indexOf(name) === 0 ? 'blocked' : 'partial', label)
      if (!valid) {
        assert.equal(calls, CONFIG_FILES.indexOf(name) + 1, label)
        assert.equal(r.errors[0].path, path, label)
        assert.equal(r.errors[0].entry_exists, true, label)
      }
    } finally { f.cleanup() }
  }
  const f = setup()
  try {
    const outside = join(f.scratch, 'outside')
    mkdirSync(outside)
    let calls = 0
    const r = reuseWorktreeConfig(f.root, { ...f.deps, copyFile: (source, destination, flags) => {
      calls++
      copyFileSync(source, destination, flags)
      renameSync(join(f.root, '.sdd-ai'), join(f.root, 'saved'))
      symlinkSync(outside, join(f.root, '.sdd-ai'), 'dir')
    } })
    assert.equal(r.state, 'partial')
    assert.equal(calls, 1)
    assert.equal(existsSync(join(outside, 'workers.yml')), false)
  } finally { f.cleanup() }
})

test('reuse reconoce el destino no regular aparecido aunque la copia no responda EEXIST, como en Windows', () => {
  // CopyFileW informa EPERM ante un directorio; la copia nunca crea directorios ni enlaces, así que no son suyos.
  for (const name of CONFIG_FILES) for (const kind of ['directory', 'link']) {
    const f = setup()
    try {
      const path = join(f.root, '.sdd-ai', name)
      const target = join(f.scratch, 'link-target')
      writeFileSync(target, 'no modificar')
      const r = reuseWorktreeConfig(f.root, { ...f.deps, copyFile: (source, destination, flags) => {
        if (destination !== path) return copyFileSync(source, destination, flags)
        if (kind === 'directory') mkdirSync(destination)
        else symlinkSync(target, destination)
        throw Object.assign(new Error('EPERM: operación no permitida'), { code: 'EPERM' })
      } })
      const label = `${name}/${kind}: ${JSON.stringify(r.errors)}`
      assert.ok(!r.copied.includes(name), label)
      assert.ok(r.preserved.includes(name), label)
      assert.equal(r.errors[0].path, path, label)
      assert.match(r.errors[0].message, /archivo regular/, label)
      assert.equal(readFileSync(target, 'utf8'), 'no modificar')
    } finally { f.cleanup() }
  }
})

test('reuse reporta la copia parcial y el reintento conserva lo creado y completa lo ausente', () => {
  for (const failAt of [0, 1, 2]) {
    const f = setup()
    try {
      const attempted: string[] = []
      const r = reuseWorktreeConfig(f.root, { ...f.deps, copyFile: (source, destination, flags) => {
        attempted.push(destination)
        if (attempted.length === failAt + 1) throw denied()
        copyFileSync(source, destination, flags)
      } })
      assert.equal(r.state, failAt === 0 ? 'blocked' : 'partial')
      assert.deepEqual(r.copied, CONFIG_FILES.slice(0, failAt))
      assert.deepEqual(r.pending, CONFIG_FILES.slice(failAt))
      assert.deepEqual(attempted, CONFIG_FILES.slice(0, failAt + 1).map((name) => join(f.root, '.sdd-ai', name)))
      assert.equal(r.errors[0].entry_exists, false)
      const before = r.copied.map((name) => ({ name, bytes: readFileSync(join(f.root, '.sdd-ai', name)), mtime: lstatSync(join(f.root, '.sdd-ai', name)).mtimeMs }))
      const retry = reuseWorktreeConfig(f.root, f.deps)
      assert.equal(retry.state, 'copied')
      assert.deepEqual(retry.copied, CONFIG_FILES.slice(failAt))
      for (const e of before) {
        assert.deepEqual(readFileSync(join(f.root, '.sdd-ai', e.name)), e.bytes)
        assert.equal(lstatSync(join(f.root, '.sdd-ai', e.name)).mtimeMs, e.mtime)
      }
      const repeat = reuseWorktreeConfig(f.root, { ...f.deps, mainWorktree: () => { throw new Error('no debe consultar la fuente') }, copyFile: () => assert.fail('no debe copiar') })
      assert.equal(repeat.state, 'unchanged')
      assert.deepEqual(repeat.copied, [])
    } finally { f.cleanup() }
  }
  for (const name of ['workers.yml', 'config.yml']) {
    const f = setup()
    try {
      const failedPath = join(f.root, '.sdd-ai', name)
      const first = reuseWorktreeConfig(f.root, { ...f.deps, copyFile: (source, destination, flags) => {
        if (destination === failedPath) { writeFileSync(destination, '['); throw denied() }
        copyFileSync(source, destination, flags)
      } })
      assert.equal(first.state, 'partial')
      assert.equal(first.errors[0].entry_exists, true)
      assert.ok(!first.pending.includes(name as 'workers.yml' | 'config.yml'))
      const before = lstatSync(failedPath).mtimeMs
      const retry = reuseWorktreeConfig(f.root, f.deps)
      assert.equal(retry.state, 'blocked')
      assert.deepEqual(retry.copied, [])
      assert.equal(readFileSync(failedPath, 'utf8'), '[')
      assert.equal(lstatSync(failedPath).mtimeMs, before)
    } finally { f.cleanup() }
  }
})
