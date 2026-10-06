import { withWorkerPolicy } from '../src/worker-policy.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { cli, git, storeOf, lockOf, readJsonFile, writerSetup, whenRunning, implement, EDITS } from './cli-run-fixture.ts'

test('wait de un writer trae base, archivos con estado y líneas, binarios, modos, enlaces y renombres', () => {
  const s = writerSetup({ script: { actions: EDITS, report: 'Cambié los archivos.\nSTATUS: done' } })
  const r = implement(s)
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.deepEqual([w.code, w.out.state, w.out.base], [0, 'done', s.base], JSON.stringify(w.out))
  const byPath = new Map<string, { status: string; added: number | null; removed: number | null; binary: boolean; from?: string; modeBefore?: string; modeAfter?: string }>(
    w.out.files.map((f: { path: string }) => [f.path, f]))
  assert.deepEqual([...byPath.keys()].sort(), ['a.txt', 'borrar.txt', 'enlace', 'imagen.bin', 'movido.txt', 'nuevo.txt', 'script.sh'])
  assert.deepEqual([byPath.get('a.txt')?.status, byPath.get('a.txt')?.added, byPath.get('a.txt')?.removed], ['M', 1, 0])
  assert.equal(byPath.get('borrar.txt')?.status, 'D')
  assert.deepEqual([byPath.get('movido.txt')?.status, byPath.get('movido.txt')?.from], ['R', 'mover.txt'])
  assert.deepEqual([byPath.get('nuevo.txt')?.status, byPath.get('nuevo.txt')?.added], ['A', 1])
  assert.deepEqual([byPath.get('imagen.bin')?.binary, byPath.get('imagen.bin')?.added], [true, null])
  assert.deepEqual([byPath.get('script.sh')?.modeBefore, byPath.get('script.sh')?.modeAfter], ['100644', '100755'])
  assert.equal(byPath.get('enlace')?.modeAfter, '120000')
  assert.equal(w.out.diff, join(storeOf(s.repo, r.out.id), 'diff.patch'))
  assert.ok(readFileSync(w.out.diff).length > 0)
  assert.deepEqual([w.out.report, w.out.end_mark, w.out.flagged, w.out.run_altered, w.out.head_moved],
    ['Cambié los archivos.\nSTATUS: done', true, [], [], false])
})

test('next propone review start --harvest con base y autor solo con marca, cambio no vacío, sin señalados y HEAD en la base', () => {
  for (const [families, bins, author] of [['[codex]', ['codex'], 'codex'], ['[claude]', ['claude'], 'claude']] as const) {
    const s = writerSetup({ families, bins: [...bins], script: { actions: [{ write: 'nuevo.txt', content: 'n\n' }] } })
    const r = implement(s)
    const w = cli(s, ['wait', r.out.id, '--max', '20'])
    assert.equal(w.out.failed, undefined, JSON.stringify(w.out))
    assert.match(w.out.next, new RegExp(`\\./bin/sdd-ai review start --harvest ${r.out.id} --base ${s.base} --author ${author}$`))
  }
})

test('sin marca, vacío, con señalados o con HEAD movido, next remite a preguntar o a relanzar', () => {
  const cases: Array<[string, object, RegExp, RegExp]> = [
    ['sin marca', { actions: [{ write: 'n.txt', content: 'n\n' }], report: 'Listo.' }, /marca de fin/, /conserva el cambio o lo revierte/i],
    ['vacío', { actions: [] }, /el cambio está vacío/, /no hay nada que conservar ni revertir .*run --retry/],
    ['señalado', { actions: [{ write: 'n.txt', content: 'n\n' }, { write: '.claude/settings.json', content: '{}' }] }, /rutas señaladas: \.claude/, /conserva el cambio o lo revierte/],
    ['HEAD movido', { actions: [{ write: 'n.txt', content: 'n\n' }, { write: '.git/HEAD', content: 'ref: refs/heads/otra\n' }] }, /HEAD ya no es la base/, /conserva el cambio o lo revierte/],
  ]
  for (const [name, script, failed, next] of cases) {
    const s = writerSetup({ script })
    const r = implement(s)
    const w = cli(s, ['wait', r.out.id, '--max', '20'])
    assert.equal(w.out.state, 'done', name)
    assert.match(w.out.failed.join('; '), failed, name)
    assert.match(w.out.next, next, name)
    assert.doesNotMatch(w.out.next, /review start/, name)
  }
})

test('un writer que reescribe su request, su prompt, su argv o su status no cambia la base ni la cosecha y sale señalado', () => {
  const s = writerSetup({
    script: {
      actions: [
        { write: 'nuevo.txt', content: 'n\n' },
        { runWrite: 'request.json', content: '{"role":"explore","base":"0000000000000000000000000000000000000000"}' },
        { runWrite: 'prompt.md', content: 'otro encargo' },
        { runWrite: 'argv.json', content: '{}' },
        { runWrite: 'status.json', content: '{"state":"done"}' },
      ],
    },
  })
  const r = implement(s)
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.deepEqual([w.out.state, w.out.base], ['done', s.base])
  assert.deepEqual(w.out.files.map((f: { path: string }) => f.path), ['nuevo.txt'])
  assert.deepEqual(w.out.run_altered.map((f: { path: string }) => f.path).sort(), ['./argv.json', './prompt.md', './request.json', './status.json'])
  assert.match(w.out.failed.join('; '), /alteró su corrida/)
})

test('un archivo que el writer agrega o cambia en su corrida sale señalado', () => {
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runWrite: 'result.md', content: 'falso' }] } })
  const r = implement(s)
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  const added = w.out.run_altered.find((f: { path: string }) => f.path === './result.md')
  assert.deepEqual([added?.before, added?.after?.type], [undefined, 'file'])
})

test('un status terminal escrito por el writer no hace volver a wait', async () => {
  const s = writerSetup({ script: { actions: [{ runWrite: 'status.json', content: '{"state":"done"}' }], hang: true } })
  const r = implement(s)
  await whenRunning(s.repo, r.out.id)
  const w = cli(s, ['wait', r.out.id, '--max', '1'])
  assert.deepEqual([w.code, w.out.state], [3, 'running'])
  assert.equal(cli(s, ['cancel', r.out.id]).code, 0)
  assert.equal(cli(s, ['wait', r.out.id, '--max', '20']).out.state, 'cancelled')
})

test('--retry de un writer relanza el encargo, el rol, las familias, el perfil y el plazo del almacén', () => {
  const s = writerSetup({
    families: '[codex, claude]', bins: ['codex', 'claude'],
    script: {
      actions: [
        { runWrite: 'prompt.md', content: 'encargo cambiado' },
        { runWrite: 'request.json', content: '{"role":"explore","overrides":{"families":"claude","deadline_sec":5}}' },
      ],
    },
  })
  const prompts = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompts-')), 'p.jsonl')
  const first = implement(s, ['--families', 'codex', '--model', 'gpt-x', '--effort', 'low', '--deadline', '77'], { FAKE_PROMPTS_FILE: prompts })
  assert.equal(cli(s, ['wait', first.out.id, '--max', '20']).out.state, 'done')
  git(s.repo, 'clean', '-qfd')
  const again = cli(s, ['run', '--retry', first.out.id], { FAKE_PROMPTS_FILE: prompts })
  assert.equal(again.code, 0, JSON.stringify(again.out))
  assert.equal(cli(s, ['wait', again.out.id, '--max', '20']).out.state, 'done')
  const control = readJsonFile(join(storeOf(s.repo, again.out.id), 'control.json'))
  assert.equal(control.prompt, withWorkerPolicy('Encargo de prueba.\n'))
  assert.deepEqual([control.family, control.request.role, control.request.families, control.request.model, control.request.effort, control.request.deadline_sec],
    ['codex', 'implement', 'codex', 'gpt-x', 'low', 77])
  const sent = readFileSync(prompts, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string)
  assert.equal(sent.length, 2)
  for (const p of sent) {
    assert.match(p, /Encargo de prueba\./)
    assert.doesNotMatch(p, /encargo cambiado/)
  }
})

test('después de lanzar, sdd-ai no escribe nada en .sdd-ai/runs/<id>: enlaces plantados en diff.patch, en los logs de la reanudación, en result.md, en las métricas o en el propio directorio no se siguen', () => {
  const outside = mkdtempSync(join(tmpdir(), 'sdd-ai-afuera-'))
  const witness = (name: string) => join(outside, name)
  for (const n of ['patch', 'log', 'result', 'metrics']) writeFileSync(witness(n), `testigo ${n}\n`)
  const plant = [['diff.patch', 'patch'], ['stdout-resume.log', 'log'], ['result.md', 'result'], ['metrics.json', 'metrics']]
    .map(([name, w]) => ({ runLink: [name, witness(w)] }))
  const s = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, ...plant], hangUnlessResume: true } })
  const r = implement(s, ['--deadline', '2'])
  const w = cli(s, ['wait', r.out.id, '--max', '40'])
  assert.equal(w.out.state, 'done', JSON.stringify(w.out))
  for (const n of ['patch', 'log', 'result', 'metrics']) assert.equal(readFileSync(witness(n), 'utf8'), `testigo ${n}\n`, n)
  assert.deepEqual(w.out.run_altered.map((f: { path: string }) => f.path).sort(), ['./diff.patch', './metrics.json', './result.md', './stdout-resume.log'])
  assert.equal(readdirSync(outside).length, 4)

  // El directorio entero, reemplazado por un enlace a otro lado.
  const target = mkdtempSync(join(tmpdir(), 'sdd-ai-destino-'))
  const s2 = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'n\n' }, { runSwap: target }] } })
  const r2 = implement(s2)
  const w2 = cli(s2, ['wait', r2.out.id, '--max', '20'])
  assert.equal(w2.out.state, 'done')
  assert.deepEqual(readdirSync(target), [])
  assert.ok(w2.out.run_altered.some((f: { path: string; after?: { type: string } }) => f.path === '.' && f.after?.type === 'link'))
})

test('un writer que falla, vence o se cancela entrega la cosecha tras el cese y next remite a preguntar', async () => {
  const edit = { write: 'nuevo.txt', content: 'n\n' }
  const failed = writerSetup({ script: { actions: [edit], exit: 1, report: '' } })
  const f = cli(failed, ['wait', implement(failed).out.id, '--max', '20'])
  assert.equal(f.out.state, 'failed')

  const late = writerSetup({ script: { actions: [edit], hang: true, resumeFail: true } })
  const t = cli(late, ['wait', implement(late, ['--deadline', '1']).out.id, '--max', '40'])
  assert.equal(t.out.state, 'timeout')

  const stopped = writerSetup({ script: { actions: [edit], hang: true } })
  const id = implement(stopped).out.id
  await whenRunning(stopped.repo, id)
  await sleep(300)
  assert.equal(cli(stopped, ['cancel', id]).code, 0)
  const c = cli(stopped, ['wait', id, '--max', '20'])
  assert.equal(c.out.state, 'cancelled')

  for (const w of [f, t, c]) {
    assert.deepEqual(w.out.files.map((x: { path: string }) => x.path), ['nuevo.txt'], w.out.state)
    assert.match(w.out.next, /pregunta al usuario si conserva el cambio o lo revierte; sdd-ai no revierte nada/i, w.out.state)
    assert.equal(w.code, 1)
  }
  for (const s of [failed, late, stopped]) assert.equal(existsSync(lockOf(s.repo)), false)
})

test('sin cambios, next dice que no hay nada que conservar y ofrece relanzar', () => {
  for (const [script, why] of [[{ actions: [] }, /terminó sin cambios/], [{ actions: [], exit: 1, report: '' }, /terminó en failed/]] as const) {
    const s = writerSetup({ script })
    const r = implement(s)
    const w = cli(s, ['wait', r.out.id, '--max', '20'])
    assert.match(w.out.next, /no hay nada que conservar ni revertir/)
    assert.match(w.out.next, why)
    assert.match(w.out.next, new RegExp(`run --retry ${r.out.id}`))
  }
})
