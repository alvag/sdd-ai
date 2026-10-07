import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { openRuns } from '../src/open-runs.ts'
import { readStatus } from '../src/runs.ts'
import {
  CLIS, type Cli, type Out, assertUnconfirmed, canonical, decision, denial, dispatch, dispatchV2, nativeRun, reservedRun, sddRepo, textKey, typeKey,
} from './hooks-fixture.ts'

// Las citas del prompt_file de una corrida nativa, con cualquier separador.

const launchFile = (repo: string, id: string) => join(repo, '.sdd-ai', 'runs', id, 'launch.json')
const reservedBy = (repo: string, id: string) => (existsSync(launchFile(repo, id)) ? JSON.parse(readFileSync(launchFile(repo, id), 'utf8')).tool_use_id : null)
const withSep = (file: string, sep: '/' | '\\') => file.replace(/[\\/]/g, sep)
const input = (cli: Cli, text: string) => ({ [typeKey(cli)]: 'sdd-ai-explore', [textKey(cli)]: text })

test('con cuatro corridas nativas la cita de su prompt_file nativo despacha esa corrida y reserva su id', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const runs = [nativeRun(repo, cli), nativeRun(repo, cli), nativeRun(repo, cli), nativeRun(repo, cli)]
    const chosen = runs[2]
    // El valor decodificado de la salida JSON de `run`, con backslash simple en Windows.
    const out = dispatch(cli, repo, input(cli, canonical(chosen.prompt_file)))
    assert.equal(decision(out), 'allow', JSON.stringify(out))
    const updated = (out as Out).hookSpecificOutput.updatedInput
    assert.ok(String(updated[textKey(cli)]).includes(chosen.id), JSON.stringify(updated))
    for (const run of runs) assert.equal(reservedBy(repo, run.id), run === chosen ? 'tu-1' : null, run.id)
  }
})

test('una cita con slash, con backslash o mezclada cuenta, y la misma corrida en dos formas es una sola', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const rel = (id: string, a: string, b: string, c: string) => `.sdd-ai${a}runs${b}${id}${c}prompt.md`
    const forms: Array<(r: Out) => string> = [
      (r) => withSep(r.prompt_file, '/'),
      (r) => withSep(r.prompt_file, '\\'),
      (r) => rel(r.id, '/', '\\', '/'),
      (r) => rel(r.id, '\\', '/', '\\'),
      (r) => rel(r.id, '/', '/', '/'),
      (r) => rel(r.id, '\\', '\\', '\\'),
      (r) => `"${r.prompt_file}"`,
      (r) => `\`${withSep(r.prompt_file, '/')}\``,
      ...['/', '\\', 'mixed'].flatMap((sep) => ["'", '"', '`'].map((quote) =>
        (r: Out) => `${quote}${sep === 'mixed' ? rel(r.id, '/', '\\', '/') : withSep(r.prompt_file, sep as '/' | '\\')}${quote}`)),
    ]
    const runs = Array.from({ length: forms.length + 2 }, () => nativeRun(repo, cli))
    forms.forEach((form, i) => {
      const out = dispatch(cli, repo, input(cli, `lee ${form(runs[i])}.`), { tool_use_id: `tu-${i}` })
      assert.equal(decision(out), 'allow', `${i}: ${JSON.stringify(out)}`)
      assert.equal(reservedBy(repo, runs[i].id), `tu-${i}`)
    })
    // La misma corrida en dos formas cuenta una vez.
    const last = runs[forms.length]
    const both = dispatch(cli, repo, input(cli, `${withSep(last.prompt_file, '/')} y ${withSep(last.prompt_file, '\\')}`), { tool_use_id: 'tu-dos' })
    assert.equal(decision(both), 'allow', JSON.stringify(both))
    assert.equal(reservedBy(repo, last.id), 'tu-dos')
    assert.equal(reservedBy(repo, runs[forms.length + 1].id), null)
  }
})

test('las negaciones de citas se mantienen con cualquier separador', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const a = nativeRun(repo, cli)
    const b = nativeRun(repo, cli)
    const other = nativeRun(repo, cli, [], 's2')
    for (const sep of ['/', '\\'] as const) {
      const fa = withSep(a.prompt_file, sep)
      const fb = withSep(b.prompt_file, sep)
      assert.match(denial(dispatch(cli, repo, input(cli, `${fa}.bak`))), /cita el prompt_file/, sep)
      assert.match(denial(dispatch(cli, repo, input(cli, `${fa}${sep}extra`))), /cita el prompt_file/, sep)
      assert.match(denial(dispatch(cli, repo, input(cli, `${fa} y ${fb}`))), /más de una/, sep)
      assert.match(denial(dispatch(cli, repo, input(cli, withSep(other.prompt_file, sep)))), new RegExp(`${other.id} no se puede despachar`), sep)
    }
    for (const run of [a, b, other]) assert.equal(reservedBy(repo, run.id), null)

    // Con una reserva sin confirmar y una pendiente, citar la reservada no se puede despachar.
    const mixed = sddRepo(cli)
    const reserved = reservedRun(mixed, cli, 'tu-r')
    const pending = nativeRun(mixed, cli)
    for (const sep of ['/', '\\'] as const) {
      assert.match(denial(dispatch(cli, mixed, input(cli, withSep(reserved.prompt_file, sep)))), new RegExp(`${reserved.id} no se puede despachar`), sep)
    }
    assert.equal(reservedBy(mixed, pending.id), null)

    // Solo reservas sin confirmar: la cita no habilita un nuevo lanzamiento.
    const only = sddRepo(cli)
    const r = reservedRun(only, cli, 'tu-r')
    for (const sep of ['/', '\\'] as const) assertUnconfirmed(dispatch(cli, only, input(cli, canonical(withSep(r.prompt_file, sep)))), cli, [r.id])
    assert.equal(reservedBy(only, r.id), 'tu-r')
  }
  // En spawn_agent v2 el mensaje va cifrado y no se leen citas.
  const v2 = sddRepo('codex')
  const first = nativeRun(v2, 'codex')
  nativeRun(v2, 'codex')
  for (const sep of ['/', '\\'] as const) {
    assert.match(denial(dispatchV2(v2, { message: withSep(first.prompt_file, sep) })), /hay 2 corridas sin lanzar.*cifrado/, sep)
  }
  assert.equal(reservedBy(v2, first.id), null)
})

test('la ruta copiada de la negación por varias corridas o del next de open-runs vale como cita', () => {
  for (const cli of CLIS) {
    // La negación por varias corridas lista los prompt_file separados por coma.
    const repo = sddRepo(cli)
    const runs = [nativeRun(repo, cli), nativeRun(repo, cli)]
    const reason = denial(dispatch(cli, repo, { [typeKey(cli)]: 'sdd-ai-explore' }))
    const listed = reason.slice(reason.indexOf('despachas: ') + 'despachas: '.length).split(', ')
    assert.equal(listed.length, 2, reason)
    const copied = listed[1]
    const target = runs.find((r) => copied.includes(r.id))
    assert.ok(target, copied)
    assert.equal(decision(dispatch(cli, repo, input(cli, copied))), 'allow')
    assert.equal(reservedBy(repo, target.id), 'tu-1')
    assert.equal(reservedBy(repo, runs.find((r) => r !== target)!.id), null)

    // El next de una corrida pendiente abierta lleva la ruta tras `citando`.
    const second = sddRepo(cli)
    const pair = [nativeRun(second, cli), nativeRun(second, cli)]
    const open = openRuns(second).find((r) => r.id === pair[1].id)
    assert.ok(open, 'la corrida está abierta')
    const next = /citando (.*), o \.\/bin\/sdd-ai cancel/.exec(open.next)
    assert.ok(next, open.next)
    assert.equal(decision(dispatch(cli, second, input(cli, next[1]))), 'allow')
    assert.equal(reservedBy(second, pair[1].id), 'tu-1')
    assert.equal(reservedBy(second, pair[0].id), null)
  }
})

test('una corrida pendiente previa se despacha citando su ruta nativa y una reserva previa conserva su negación y su estado', () => {
  for (const cli of CLIS) {
    // Una corrida pendiente que ya existía se despacha citando su ruta, sin recrearla.
    const repo = sddRepo(cli)
    const old = nativeRun(repo, cli)
    nativeRun(repo, cli)
    assert.equal(decision(dispatch(cli, repo, input(cli, canonical(old.prompt_file)))), 'allow')
    assert.equal(reservedBy(repo, old.id), 'tu-1')

    // Una reserva previa sigue sin ser elegible: se conserva su negación, su launch.json y su estado.
    const held = sddRepo(cli)
    const reserved = reservedRun(held, cli, 'tu-r')
    const dir = join(held, '.sdd-ai', 'runs', reserved.id)
    const before = { launch: readFileSync(launchFile(held, reserved.id)), status: readStatus(dir) }
    for (const sep of ['/', '\\'] as const) {
      assertUnconfirmed(dispatch(cli, held, input(cli, canonical(withSep(reserved.prompt_file, sep))), { tool_use_id: 'tu-2' }), cli, [reserved.id])
    }
    assert.deepEqual(readFileSync(launchFile(held, reserved.id)), before.launch)
    assert.deepEqual(readStatus(dir), before.status)
  }
})

test('run nativo conserva sus campos y un prompt_file nativo legible con las dos familias', () => {
  const allowed = new Set(['id', 'via', 'family', 'agent', 'prompt_file', 'model', 'effort', 'warnings'])
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const out = nativeRun(repo, cli)
    for (const key of ['id', 'via', 'family', 'agent', 'prompt_file']) assert.ok(key in out, `${cli}: falta ${key}`)
    for (const key of Object.keys(out)) assert.ok(allowed.has(key), `${cli}: campo inesperado ${key}`)
    assert.equal(out.via, 'native')
    assert.equal(out.family, cli)
    const expected = [join(repo, '.sdd-ai', 'runs', out.id, 'prompt.md'), join(realpathSync(repo), '.sdd-ai', 'runs', out.id, 'prompt.md')]
    assert.ok(expected.includes(out.prompt_file), `${out.prompt_file} no es ${expected[0]}`)
    assert.equal(existsSync(out.prompt_file), true)
    assert.match(readFileSync(out.prompt_file, 'utf8'), /Encargo de prueba/)
  }
})
