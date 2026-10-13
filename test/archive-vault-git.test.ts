import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ArchiveInjectedCrash, archiveHash, inventoryArchiveTree } from '../src/sdd/archive-tree.ts'
import { loadArchiveOperations } from '../src/sdd/archive-operation.ts'
import { SddError } from '../src/types.ts'
import { answerArchive, archiveGit, archiveWrite, createArchiveSandbox, runArchiveInProcess, snapshotArchiveSandbox } from './archive-fixture.ts'

test('el vault commitea archivos y nodo una vez y desactiva todos los hooks sin cambiar configuración', async (t) => {
  for (const configured of [false, true]) {
    const s = createArchiveSandbox(); t.after(s.cleanup)
    const hooks = configured ? join(s.vaultRoot, 'configured-hooks') : join(s.vaultRoot, '.git', 'hooks')
    if (configured) archiveGit(s.vaultRoot, 'config', 'core.hooksPath', hooks)
    const names = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction']
    for (const name of names) {
      const file = join(hooks, name)
      archiveWrite(file, '#!/bin/sh\nprintf witness > "$PWD/hook-witness"\nprintf changed >> "$PWD/base.txt"\n')
      // Los permisos pertenecen al fixture; ningún hook se ejecuta para preparar el caso.
      chmodSync(file, 0o755)
    }
    archiveWrite(join(s.vaultRoot, 'foreign-unstaged.txt'), 'foreign unchanged')
    archiveWrite(join(s.vaultRoot, 'base.txt'), 'modificación ajena sin stage\n')
    const config = readFileSync(join(s.vaultRoot, '.git', 'config')), originalBase = readFileSync(join(s.vaultRoot, 'base.txt'))
    const count = Number(archiveGit(s.vaultRoot, 'rev-list', '--count', 'HEAD'))
    answerArchive(s)
    await assert.rejects(runArchiveInProcess(s, { summary: 'Resumen exclusivo: summaryneedle PR#12', fault: (point) => {
      if (point === 'after_vault_commit') throw new ArchiveInjectedCrash(point)
    } }), ArchiveInjectedCrash)
    const sha = archiveGit(s.vaultRoot, 'rev-parse', 'HEAD')
    assert.equal(Number(archiveGit(s.vaultRoot, 'rev-list', '--count', 'HEAD')), count + 1)
    assert.equal((await runArchiveInProcess(s, { env: {} })).state, 'completed')
    assert.equal(archiveGit(s.vaultRoot, 'rev-parse', 'HEAD'), sha)
    const operation = loadArchiveOperations(s.checkoutRoot, s.flowId)[0], d = operation.manifest.binding.input.destination
    const paths = operation.manifest.binding.input.inventory.files.map((file) => `projects/fixture-project/sdd/${s.flowId}/${file.path}`)
    paths.push(`projects/fixture-project/sdd/${s.flowId}.md`)
    assert.deepEqual(archiveGit(s.vaultRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), paths.sort())
    for (const file of operation.manifest.binding.input.inventory.files) {
      const bytes = readFileSync(join(d.documents, file.path))
      assert.equal(archiveHash(bytes), file.sha256)
      // Estos cuerpos incluyen binarios: la salida de git show se compara en bytes, sin trim ni decodificación.
      assert.deepEqual(execFileSync('git', ['show', `${sha}:projects/fixture-project/sdd/${s.flowId}/${file.path}`], { cwd: s.vaultRoot }), bytes)
    }
    assert.deepEqual(execFileSync('git', ['show', `${sha}:projects/fixture-project/sdd/${s.flowId}.md`], { cwd: s.vaultRoot }), readFileSync(d.node!))
    assert.equal(archiveGit(s.vaultRoot, 'show', `${sha}:base.txt`), 'base')
    assert.deepEqual(readFileSync(join(s.vaultRoot, '.git', 'config')), config)
    assert.deepEqual(readFileSync(join(s.vaultRoot, 'base.txt')), originalBase)
    assert.equal(readFileSync(join(s.vaultRoot, 'foreign-unstaged.txt'), 'utf8'), 'foreign unchanged')
    assert.throws(() => readFileSync(join(s.vaultRoot, 'hook-witness')))
    assert.ok(inventoryArchiveTree(d.documents).directories.includes('empty'))
    assert.equal(paths.some((path) => path.includes('empty')), false)
  }
  const failure = createArchiveSandbox(); t.after(failure.cleanup); answerArchive(failure)
  archiveGit(failure.vaultRoot, 'config', 'user.name', '')
  archiveGit(failure.vaultRoot, 'config', 'user.email', '')
  const original = inventoryArchiveTree(failure.source), head = archiveGit(failure.vaultRoot, 'rev-parse', 'HEAD')
  await assert.rejects(runArchiveInProcess(failure, { summary: 'Resumen exclusivo: summaryneedle PR#12' }))
  assert.deepEqual(inventoryArchiveTree(failure.source), original)
  assert.equal(archiveGit(failure.vaultRoot, 'rev-parse', 'HEAD'), head)
  // Lo que otro proceso stagea durante el commit lo detiene sin commitear; resuelto, la reanudación no lo incluye.
  const racing = createArchiveSandbox(); t.after(racing.cleanup); answerArchive(racing)
  const racingHead = archiveGit(racing.vaultRoot, 'rev-parse', 'HEAD')
  await assert.rejects(runArchiveInProcess(racing, { summary: 'Resumen exclusivo: summaryneedle PR#12', fault: (point) => {
    if (point !== 'after_vault_staging') return
    archiveWrite(join(racing.vaultRoot, 'foreign-race.txt'), 'staged by another process'); archiveGit(racing.vaultRoot, 'add', 'foreign-race.txt')
  } }), (error: unknown) => error instanceof SddError && error.code === 'archive_commit_invalid')
  assert.equal(archiveGit(racing.vaultRoot, 'rev-parse', 'HEAD'), racingHead)
  archiveGit(racing.vaultRoot, 'reset', '-q', '--', 'foreign-race.txt')
  assert.equal((await runArchiveInProcess(racing, { env: {} })).state, 'completed')
  assert.equal(archiveGit(racing.vaultRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').includes('foreign-race.txt'), false)
  const local = createArchiveSandbox({ vault: false }); t.after(local.cleanup); answerArchive(local)
  const localHead = archiveGit(local.vaultRoot, 'rev-parse', 'HEAD')
  assert.equal((await runArchiveInProcess(local)).vault_commit, 'not_required')
  assert.equal(archiveGit(local.vaultRoot, 'rev-parse', 'HEAD'), localHead)
  for (const condition of ['staged', 'ignored', 'no-git', 'nested'] as const) {
    const s = createArchiveSandbox(); t.after(s.cleanup); answerArchive(s)
    if (condition === 'staged') { archiveWrite(join(s.vaultRoot, 'foreign.txt'), 'foreign staged'); archiveGit(s.vaultRoot, 'add', 'foreign.txt') }
    if (condition === 'ignored') archiveWrite(join(s.vaultRoot, '.gitignore'), 'projects/\n')
    if (condition === 'no-git') rmSync(join(s.vaultRoot, '.git'), { recursive: true })
    if (condition === 'nested') {
      archiveWrite(join(s.vaultRoot, 'nested', '.kv', 'identidades.tsv'), readFileSync(join(s.vaultRoot, '.kv', 'identidades.tsv')))
      archiveWrite(join(s.checkoutRoot, '.sdd-ai', 'config.yml'), 'knowledge-vault:\n  path_vault: ../vault/nested\n')
    }
    const before = snapshotArchiveSandbox(s)
    await assert.rejects(runArchiveInProcess(s, { summary: 'Resumen exclusivo: summaryneedle PR#12' }))
    assert.deepEqual(snapshotArchiveSandbox(s), before)
  }
  const damaged = createArchiveSandbox(); t.after(damaged.cleanup); answerArchive(damaged)
  const source = inventoryArchiveTree(damaged.source)
  await assert.rejects(runArchiveInProcess(damaged, { summary: 'Resumen exclusivo: summaryneedle PR#12', fault: (point) => {
    if (point === 'after_vault_commit') throw new ArchiveInjectedCrash(point)
  } }))
  const created = archiveGit(damaged.vaultRoot, 'rev-parse', 'HEAD'), op = loadArchiveOperations(damaged.checkoutRoot, damaged.flowId)[0]
  const target = join(op.manifest.binding.input.destination.documents, 'spec.md')
  archiveWrite(target, 'damaged published bytes')
  assert.equal((await runArchiveInProcess(damaged, { env: {} })).state, 'stopped')
  assert.equal(archiveGit(damaged.vaultRoot, 'rev-parse', 'HEAD'), created)
  assert.equal(readFileSync(target, 'utf8'), 'damaged published bytes')
  assert.deepEqual(inventoryArchiveTree(damaged.source), source)
  const staged = createArchiveSandbox(); t.after(staged.cleanup); answerArchive(staged)
  await assert.rejects(runArchiveInProcess(staged, { summary: 'Resumen exclusivo: summaryneedle PR#12', fault: (point) => {
    if (point === 'after_vault_staging') throw new ArchiveInjectedCrash(point)
  } }))
  const index = archiveGit(staged.vaultRoot, 'ls-files', '--stage')
  archiveWrite(join(staged.source, 'new.txt'), 'added after staging')
  const stopped = await runArchiveInProcess(staged, { env: {} })
  assert.equal(stopped.state, 'stopped'); assert.ok(Array.isArray(stopped.vault_staged_entries))
  assert.equal(archiveGit(staged.vaultRoot, 'ls-files', '--stage'), index)
})
