import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitDirs } from '../src/git.ts'
import { cli, git } from './cli-run-fixture.ts'
import { parallelFixture, release } from './parallel-worktrees-fixture.ts'
import { chainFlow } from './helpers.ts'
import { legacyWriter } from './legacy-reservation-fixture.ts'

test('la cosecha alerta por config hooks HEAD ramas congeladas y archivos no excluidos pero no por cambios de representación y conserva la comparación legacy', async (t) => {
  const f = parallelFixture()
  try {
    // La aserción que distingue el cambio de la base va primero: empaquetar sin mover refs no alerta.
    const clean = await f.writer(f.right, 'pack')
    git(f.main.repo, 'pack-refs', '--all', '--prune')
    release(clean.barrier)
    assert.deepEqual(cli(f.right, ['wait', clean.id, '--max', '15']).out.flagged, [], 'empaquetar sin mover refs conserva su significado')
    const { gitDir, commonDir } = gitDirs(f.right.repo)
    const frozenRef = git(f.right.repo, 'symbolic-ref', 'HEAD')
    /**
     * Cada escenario lanza un writer en el checkout derecho, cambia algo mientras corre y mira la cosecha. Comparten
     * el fixture: el escenario que cambia algo que el siguiente necesita lo deshace en `undo`, que corre aunque falle.
     */
    const scenario = async (name: string, change: () => void, check: (harvest: any) => void, undo?: () => void) => {
      await t.test(name, async () => {
        try {
          const writer = await f.writer(f.right, name)
          change()
          release(writer.barrier)
          check(cli(f.right, ['wait', writer.id, '--max', '15']).out)
        } finally { undo?.() }
      })
    }
    await scenario('desempaquetar la rama congelada sin moverla', () => {
      mkdirSync(dirname(join(commonDir, frozenRef)), { recursive: true })
      writeFileSync(join(commonDir, frozenRef), `${f.right.base}\n`)
    }, (harvest) => assert.deepEqual(harvest.flagged, []))
    const tree = git(f.right.repo, 'rev-parse', `${f.right.base}^{tree}`)
    const changed = git(f.right.repo, 'commit-tree', tree, '-p', f.right.base, '-m', 'another tip')
    await scenario('mover el commit de HEAD', () => git(f.right.repo, 'update-ref', frozenRef, changed), (harvest) => {
      assert.equal(harvest.head_moved, true)
      assert.ok(harvest.flagged.some((item: { kind?: string; ref_before?: string; ref_after?: string }) => item.kind === 'head'
        && item.ref_before?.includes(f.right.base) && item.ref_after?.includes(changed)))
      assert.equal(git(f.right.repo, 'rev-parse', 'HEAD'), changed, 'la cosecha no revierte HEAD')
    }, () => git(f.right.repo, 'update-ref', frozenRef, f.right.base))
    git(f.main.repo, 'branch', 'symbolic-target', f.right.base)
    await scenario('volver simbólica la rama congelada', () => git(f.right.repo, 'symbolic-ref', frozenRef, 'refs/heads/symbolic-target'), (harvest) => {
      assert.ok(harvest.flagged.some((item: { kind?: string; ref?: string; ref_after?: string }) => item.kind === 'ref'
        && item.ref === frozenRef && item.ref_after?.includes('refs/heads/symbolic-target')))
    }, () => {
      git(f.right.repo, 'symbolic-ref', '--delete', frozenRef)
      git(f.right.repo, 'update-ref', frozenRef, f.right.base)
    })
    const link = join(commonDir, 'hooks', 'external-link')
    await scenario('agregar un enlace en hooks', () => symlinkSync(f.scratch, link),
      (harvest) => assert.ok(harvest.flagged.some((item: { path: string }) => item.path.endsWith('/hooks/external-link'))),
      () => unlinkSync(link))
    await scenario('cambiar la config de sdd-ai', () => appendFileSync(join(f.right.repo, '.sdd-ai', 'config.yml'), '\n# configuration changed\n'),
      (harvest) => assert.ok(harvest.flagged.some((item: { path: string }) => item.path.endsWith('.sdd-ai/config.yml'))))
    // Cada recurso vigilado alerta por su propia ruta, no por cualquier otra diferencia.
    for (const [name, path, edit] of [
      ['config', join(commonDir, 'config'), () => appendFileSync(join(commonDir, 'config'), '\n[test]\n value = yes\n')],
      ['hooks', join(commonDir, 'hooks', 'unknown'), () => writeFileSync(join(commonDir, 'hooks', 'unknown'), 'hook\n')],
      ['exclude', join(commonDir, 'info', 'exclude'), () => appendFileSync(join(commonDir, 'info', 'exclude'), '\nother/\n')],
      ['unknown', join(commonDir, 'unknown'), () => writeFileSync(join(commonDir, 'unknown'), 'common\n')],
      ['local', join(gitDir, 'unknown'), () => writeFileSync(join(gitDir, 'unknown'), 'local\n')],
    ] as const) {
      await scenario(`cambiar ${name}`, edit, (harvest) => {
        assert.ok(harvest.flagged.some((item: { path: string }) => item.path === path), `${name}: ${JSON.stringify(harvest.flagged)}`)
        assert.equal(existsSync(path), true, 'la cosecha alerta y no revierte')
      })
    }
    // Cambiar HEAD a otra rama con el mismo commit: solo cambia el destino simbólico, y eso también alerta.
    const headCommit = git(f.right.repo, 'rev-parse', 'HEAD')
    git(f.main.repo, 'branch', 'same-tip', headCommit)
    await scenario('cambiar HEAD a otra rama con el mismo commit', () => git(f.right.repo, 'symbolic-ref', 'HEAD', 'refs/heads/same-tip'), (harvest) => {
      assert.equal(harvest.head_moved, false)
      const head = harvest.flagged.find((item: { kind?: string }) => item.kind === 'head')
      assert.equal(head.path, 'HEAD')
      assert.match(head.ref_after, /same-tip/)
      assert.ok(head.ref_after.includes(headCommit) && head.ref_before.includes(headCommit))
    })
    const watched = git(f.right.repo, 'symbolic-ref', 'HEAD')
    await scenario('borrar la rama vigilada con HEAD separado', () => {
      git(f.right.repo, 'checkout', '--detach', f.main.base)
      git(f.main.repo, 'update-ref', '-d', watched)
    }, (harvest) => {
      assert.ok(harvest.flagged.some((item: { kind?: string; ref?: string; ref_after?: string }) => item.kind === 'ref' && item.ref === watched && item.ref_after === 'absent'))
    })
    await scenario('crear una rama ajena con HEAD separado', () => git(f.main.repo, 'update-ref', 'refs/heads/unwatched', f.main.base),
      (harvest) => assert.deepEqual(harvest.flagged, []))
    await t.test('la rama del handoff de un writer de fase queda congelada', async () => {
      git(f.right.repo, 'switch', '-c', 'phase-head')
      git(f.main.repo, 'branch', 'handoff-watched', f.main.base)
      chainFlow({ ...f.right, calls: '', prompts: '' })
      const handoff = join(f.right.repo, '.plans', 'f', 'handoff.md')
      writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('---\n', '---\nbranch: handoff-watched\n'))
      const phase = await f.writer(f.right, 'phase', [], { phase: true })
      writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('branch: handoff-watched', 'branch: not-frozen'))
      git(f.main.repo, 'branch', 'not-frozen', f.main.base)
      git(f.main.repo, 'update-ref', '-d', 'refs/heads/handoff-watched')
      release(phase.barrier)
      const harvest = cli(f.right, ['wait', phase.id, '--max', '15']).out
      assert.ok(harvest.flagged.some((item: { ref?: string; ref_after?: string }) => item.ref === 'refs/heads/handoff-watched' && item.ref_after === 'absent'))
      assert.equal(harvest.flagged.some((item: { ref?: string }) => item.ref === 'refs/heads/not-frozen'), false)
    })
    await t.test('una rama propia ilegible se publica en su recurso, con el error', async () => {
      const unreadable = await f.writer(f.left, 'unreadable')
      const ownRef = git(f.left.repo, 'symbolic-ref', 'HEAD')
      writeFileSync(join(commonDir, ownRef), 'invalid-ref\n')
      try {
        release(unreadable.barrier)
        const harvest = cli(f.left, ['wait', unreadable.id, '--max', '15']).out
        assert.ok(harvest.flagged.some((item: { ref_after?: string; error?: string }) => item.ref_after === 'unreadable' && item.error), JSON.stringify(harvest.flagged))
      } finally { writeFileSync(join(commonDir, ownRef), `${f.left.base}\n`) }
    })
    await t.test('un writer con control legacy conserva la comparación física', async () => {
      const old = await legacyWriter(f, f.left, 'physical')
      git(f.main.repo, 'update-ref', 'refs/heads/legacy-extra', f.main.base)
      release(old.barrier)
      assert.ok(cli(f.left, ['wait', old.id, '--max', '15']).out.flagged.some((item: { path: string }) => item.path.endsWith('/refs/heads/legacy-extra')))
    })
  } finally { await f.close() }
  const detachedPhase = parallelFixture()
  try {
    const s = detachedPhase.right
    git(s.repo, 'checkout', '--detach', s.base)
    git(detachedPhase.main.repo, 'branch', 'detached-watched', s.base)
    chainFlow({ ...s, calls: '', prompts: '' })
    const handoff = join(s.repo, '.plans', 'f', 'handoff.md')
    writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('---\n', '---\nbranch: detached-watched\n'))
    const writer = await detachedPhase.writer(s, 'watched-with-detached-head', [], { phase: true })
    const tree = git(s.repo, 'rev-parse', `${s.base}^{tree}`)
    const changed = git(s.repo, 'commit-tree', tree, '-p', s.base, '-m', 'move watched branch')
    git(s.repo, 'update-ref', 'refs/heads/detached-watched', changed)
    release(writer.barrier)
    const result = cli(s, ['wait', writer.id, '--max', '15']).out
    assert.equal(result.head_moved, false)
    const difference = result.flagged.find((item: { ref?: string }) => item.ref === 'refs/heads/detached-watched')
    assert.equal(difference.kind, 'ref')
    assert.equal(difference.path, 'refs/heads/detached-watched')
    assert.ok(difference.ref_before.includes(s.base) && difference.ref_after.includes(changed))
    assert.equal(git(s.repo, 'rev-parse', 'HEAD'), s.base)
    assert.equal(git(s.repo, 'rev-parse', 'refs/heads/detached-watched'), changed)
    assert.match(result.next, /[Pp]regunta al usuario/)
    assert.doesNotMatch(result.next, /writer (?:modificó|tocó|alteró)/)
  } finally { await detachedPhase.close() }
})
