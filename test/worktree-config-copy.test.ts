import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prepareIntent, writeRestoreIntent } from '../src/sdd/restore.ts'
import { gitDirs } from '../src/git.ts'
import { spawnSync } from 'node:child_process'
import { createWorktreeFixture, FILES, publicationProbe, put, seedCodexRun, snapshot, SOURCE_FILES } from './worktree-config-fixture.ts'

test('reuse copia desde el principal fuera del árbol padre con espacios y Unicode', () => {
  for (const emptyDirectory of [false, true]) {
    const f = createWorktreeFixture()
    try {
      if (emptyDirectory) mkdirSync(join(f.linked, '.sdd-ai'))
      const r = f.cli(['init', '--reuse-config'])
      assert.equal(r.code, 0, r.stderr)
      assert.equal(r.out.state, 'copied')
      // Git informa la ruta con / también en Windows.
      assert.equal(resolve(r.out.source), f.main)
      assert.deepEqual(r.out.copied, ['.gitignore', 'workers.yml', 'config.yml'])
      for (const name of FILES) assert.equal(readFileSync(join(f.linked, '.sdd-ai', name), 'utf8'), SOURCE_FILES[name])
    } finally { f.cleanup() }
  }
})

test('reuse crea exclusivamente los tres archivos con bytes idénticos', () => {
  const f = createWorktreeFixture()
  try {
    for (const name of ['runs/live/status.json', 'projection/state.json', 'hooks/a', 'locks/a', 'tmp/a', 'other']) put(join(f.main, '.sdd-ai', name), 'excluido')
    const user = snapshot(f.env.HOME)
    assert.equal(f.cli(['init', '--reuse-config']).code, 0)
    assert.deepEqual(snapshot(join(f.linked, '.sdd-ai')).filter((e) => e.path).map((e) => e.path).sort(), [...FILES].sort())
    for (const name of FILES) assert.deepEqual(readFileSync(join(f.linked, '.sdd-ai', name)), readFileSync(join(f.main, '.sdd-ai', name)))
    assert.deepEqual(snapshot(f.env.HOME), user)
  } finally { f.cleanup() }
})

test('reuse conserva archivos locales parciales y bloquea workers locales inválidos', () => {
  for (const ignore of [false, true]) for (const workers of [false, true]) {
    const f = createWorktreeFixture()
    try {
      const local = join(f.linked, '.sdd-ai')
      if (ignore) put(join(local, '.gitignore'), '# local\n*\n')
      if (workers) put(join(local, 'workers.yml'), 'schema_version: 1\nroles: {}\n')
      const before = snapshot(local).filter((e) => e.path)
      const r = f.cli(['init', '--reuse-config'])
      assert.equal(r.code, 0)
      assert.deepEqual(r.out.preserved, [...(ignore ? ['.gitignore'] : []), ...(workers ? ['workers.yml'] : [])])
      assert.deepEqual(r.out.pending, [])
      for (const e of before) assert.deepEqual(snapshot(local).find((v) => v.path === e.path), e)
    } finally { f.cleanup() }
  }
  const f = createWorktreeFixture()
  try {
    put(join(f.linked, '.sdd-ai', 'workers.yml'), 'schema_version: 99\nroles: {}\n')
    const before = snapshot(join(f.linked, '.sdd-ai'))
    assert.equal(f.cli(['init', '--reuse-config']).code, 2)
    assert.deepEqual(snapshot(join(f.linked, '.sdd-ai')), before)
  } finally { f.cleanup() }
})

test('reuse no recupera publica adopta ni modifica estado y su repetición no escribe', () => {
  const f = createWorktreeFixture()
  try {
    put(join(f.linked, 'base.txt'), 'candidate\n')
    const intent = prepareIntent(f.linked, '20261006-1200-aaaa', f.git(['rev-parse', 'HEAD']), ['base.txt'])
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    assert.ok(dead)
    writeRestoreIntent(f.linked, { ...intent, owner_pid: dead, owner_lstart: null })
    put(join(f.linked, 'base.txt'), 'base\n')
    for (const root of [f.main, f.linked]) {
      for (const name of ['projection/state.json', 'hooks/a', 'locks/a', 'tmp/a']) put(join(root, '.sdd-ai', name), 'conservar')
      seedCodexRun(f, root)
    }
    const gitState = snapshot(join(gitDirs(f.linked).gitDir, 'sdd-ai'))
    const mainGitState = snapshot(join(gitDirs(f.main).gitDir, 'sdd-ai'))
    const source = snapshot(join(f.main, '.sdd-ai'))
    const local = snapshot(join(f.linked, '.sdd-ai')).filter((e) => e.path)
    const user = snapshot(f.env.HOME)
    const probe = publicationProbe(f)
    const off = probe.env
    assert.equal(f.cli(['init', '--reuse-config'], f.linked, off).code, 0)
    assert.equal(readFileSync(join(f.linked, 'base.txt'), 'utf8'), 'base\n')
    assert.equal(existsSync(probe.marker), false)
    assert.deepEqual(snapshot(join(gitDirs(f.linked).gitDir, 'sdd-ai')), gitState)
    assert.deepEqual(snapshot(join(gitDirs(f.main).gitDir, 'sdd-ai')), mainGitState)
    assert.deepEqual(snapshot(join(f.main, '.sdd-ai')), source)
    for (const e of local) assert.deepEqual(snapshot(join(f.linked, '.sdd-ai')).find((v) => v.path === e.path), e)
    assert.deepEqual(snapshot(f.env.HOME), user)
    const completed = snapshot(join(f.linked, '.sdd-ai'))
    assert.equal(f.cli(['init', '--reuse-config'], f.linked, off).out.state, 'unchanged')
    assert.deepEqual(snapshot(join(f.linked, '.sdd-ai')), completed)
    assert.deepEqual(snapshot(join(gitDirs(f.linked).gitDir, 'sdd-ai')), gitState)
    assert.deepEqual(snapshot(join(gitDirs(f.main).gitDir, 'sdd-ai')), mainGitState)
    for (const flags of [['--apply'], ['--digest', 'x'], ['--families', 'codex'], ['--jira', 'off'], ['--from', f.main], ['--telemetry', 'on'], ['--unknown'], ['positional']]) {
      assert.equal(f.cli(['init', '--reuse-config', ...flags], f.linked, off).code, 2)
      assert.deepEqual(snapshot(join(f.linked, '.sdd-ai')), completed)
      assert.deepEqual(snapshot(join(gitDirs(f.linked).gitDir, 'sdd-ai')), gitState)
      assert.equal(existsSync(probe.marker), false)
      assert.deepEqual(snapshot(join(gitDirs(f.main).gitDir, 'sdd-ai')), mainGitState)
      assert.deepEqual(snapshot(f.env.HOME), user)
    }
    rmSync(join(f.linked, '.sdd-ai', 'config.yml'))
    put(join(f.main, '.sdd-ai', 'config.yml'), 'cross_model: {}')
    const blocked = snapshot(join(f.linked, '.sdd-ai'))
    assert.equal(f.cli(['init', '--reuse-config'], f.linked, off).code, 2)
    assert.deepEqual(snapshot(join(f.linked, '.sdd-ai')), blocked)
    assert.equal(existsSync(join(f.linked, '.sdd-ai', 'config.yml')), false)
    assert.ok(lstatSync(join(f.linked, 'base.txt')).isFile())
    assert.deepEqual(snapshot(join(gitDirs(f.linked).gitDir, 'sdd-ai')), gitState)
    assert.equal(existsSync(probe.marker), false)
    assert.deepEqual(snapshot(f.env.HOME), user)
    assert.deepEqual(snapshot(join(gitDirs(f.main).gitDir, 'sdd-ai')), mainGitState)
    // Control positivo: el despacho común sí recupera y pide publicar en el mismo fixture.
    assert.equal(f.cli(['sdd', 'status'], f.linked, off).code, 0)
    assert.equal(readFileSync(join(f.linked, 'base.txt'), 'utf8'), 'candidate\n')
    assert.ok(existsSync(probe.marker))
  } finally { f.cleanup() }
})
