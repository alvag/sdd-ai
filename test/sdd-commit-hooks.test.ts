import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { git, file, text, put, registry, success, draft, apply, snapshot, committable } from './sdd-commit-fixture.ts'

test('un hook de Git que falla, que altera el contenido o el mensaje, o un HEAD que se movió, dejan HEAD, el índice, el header y el registro como estaban', () => {
  for (const kind of ['failure', 'content', 'message', 'race', 'hook-commit', 'post-commit']) {
    const { s } = committable()
    const d = success(draft(s))
    git(s, 'config', 'core.logAllRefUpdates', 'false')
    let hook: string
    if (kind === 'failure') hook = '#!/bin/sh\necho hook-failed >&2\nexit 1\n'
    else if (kind === 'content') hook = '#!/bin/sh\nprintf "export const f = () => 3\\n" > src/a.ts\ngit add src/a.ts\n'
    else if (kind === 'message') hook = '#!/bin/sh\nprintf "\\nadded by hook\\n" >> "$1"\n'
    else if (kind === 'race') hook = '#!/bin/sh\ntree=$(git write-tree)\nother=$(printf "foreign\\n" | git commit-tree "$tree" -p HEAD)\ngit update-ref refs/heads/foreign "$other"\ngit update-ref HEAD "$other"\nprintf "%s" "$other" > .git/foreign-sha\nexit 1\n'
    // Los hooks heredan GIT_REFLOG_ACTION: su commit lleva la misma marca que el del verbo.
    else if (kind === 'hook-commit') hook = '#!/bin/sh\ngit -c user.name=h -c user.email=h@h commit -q --allow-empty --no-verify -m "del hook"\ngit rev-parse HEAD > .git/foreign-sha\n'
    // post-commit corre también tras el commit del propio hook: la marca evita que se llame sin fin.
    else hook = '#!/bin/sh\n[ -f .git/hook-ran ] && exit 0\ntouch .git/hook-ran\ngit -c user.name=h -c user.email=h@h commit -q --allow-empty --no-verify -m "encima"\ngit rev-parse HEAD > .git/foreign-sha\n'
    const hookPath = `.git/hooks/${kind === 'message' ? 'commit-msg' : kind === 'post-commit' ? 'post-commit' : 'pre-commit'}`
    put(s, hookPath, hook); chmodSync(file(s, hookPath), 0o755)
    const before = snapshot(s)
    const r = apply(s, d.digest)
    assert.equal(r.out.code, ['content', 'message', 'post-commit'].includes(kind) ? 'commit_altered' : 'commit_failed', JSON.stringify(r.out))
    const after = snapshot(s)
    assert.deepEqual(after.index, before.index); assert.equal(after.plan, before.plan); assert.equal(after.registry, before.registry)
    if (kind === 'hook-commit' || kind === 'post-commit') {
      // Lo que hizo un hook dentro del mismo git commit lleva la marca del intento: se deshace con él, y la salida
      // nombra cada commit deshecho.
      assert.equal(after.head, before.head)
      assert.ok(r.out.detail.includes(text(s, '.git/foreign-sha').trim()), r.out.detail)
      if (kind === 'post-commit') {
        // También se nombra el commit del verbo, el de su asunto con la marca del intento.
        const own = /^([0-9a-f]+) sdd-ai commit [0-9a-f]+: feat: agrega el cambio$/m.exec(git(s, 'reflog', 'show', '--format=%H %gs', 'HEAD'))
        assert.ok(own && r.out.detail.includes(own[1]), r.out.detail)
      }
    } else if (kind === 'race') {
      assert.equal(after.head, text(s, '.git/foreign-sha')); assert.notEqual(after.head, before.head)
      assert.ok(r.out.detail.includes(after.head))
    } else assert.equal(after.head, before.head)
    if (kind === 'failure') assert.match(r.out.detail, /hook-failed/)
    if (kind === 'content') { assert.match(r.out.detail, /src\/a.ts/); assert.match(text(s, 'src/a.ts'), /=> 3/) }
    if (kind === 'message') assert.match(r.out.detail, /message/)
  }
})

// A diferencia de los casos de la prueba anterior, cuando un hook cambia de rama deshacer movería otra rama, así que
// el verbo no toca ninguna referencia. La rama del flujo queda como estaba, pero HEAD queda en la del hook.
test('si un hook cambia de rama durante el commit, sdd commit no mueve ninguna referencia y conserva la intención', () => {
  const { s } = committable()
  const d = success(draft(s))
  put(s, '.git/hooks/pre-commit', '#!/bin/sh\ngit checkout -q -b hooked\n'); chmodSync(file(s, '.git/hooks/pre-commit'), 0o755)
  const branch = git(s, 'symbolic-ref', 'HEAD')
  const before = snapshot(s)
  const r = apply(s, d.digest)
  assert.equal(r.out.code, 'commit_altered', JSON.stringify(r.out))
  assert.equal(git(s, 'rev-parse', branch), before.head)
  assert.equal(git(s, 'symbolic-ref', 'HEAD'), 'refs/heads/hooked')
  assert.match(r.out.detail, /hooked/)
  // El commit del verbo quedó en la rama del hook: la intención se conserva para reconocerlo.
  assert.equal(registry(s).commit.state, 'intent')
  assert.deepEqual(snapshot(s).index, before.index); assert.equal(snapshot(s).plan, before.plan)
})
