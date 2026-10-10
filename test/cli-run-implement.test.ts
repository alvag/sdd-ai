import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPhaseRecord } from '../src/sdd/phase-state.ts'
import {
  BIN, cli, runsIn, git, storeOf, lockOf, readJsonFile, writerSetup, whenRunning, implement, implementFlow,
  implementReport,
} from './cli-run-fixture.ts'

test('implement sale por proceso con la familia resuelta y registra la base, también con la familia del conductor', () => {
  for (const [families, bins, expected] of [['[codex, claude]', ['codex', 'claude'], 'codex'], ['[claude]', ['claude'], 'claude']] as const) {
    const s = writerSetup({ families, bins: [...bins] })
    const r = implement(s)
    assert.equal(r.code, 0, JSON.stringify(r.out))
    assert.deepEqual([r.out.via, r.out.family, r.out.base], ['process', expected, s.base])
    assert.equal(readJsonFile(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'request.json')).base, s.base)
    assert.equal(readJsonFile(join(storeOf(s.repo, r.out.id), 'control.json')).base, s.base)
    assert.equal(existsSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'native.json')), false)
    assert.equal(cli(s, ['wait', r.out.id, '--max', '20']).out.state, 'done')
  }
})

test('implement sin commit en HEAD se rechaza sin crear corrida', () => {
  const s = writerSetup({ empty: true })
  const r = implement(s)
  assert.deepEqual([r.code, r.out.code], [2, 'no_head'])
  assert.deepEqual(runsIn(s.repo), [])
  assert.equal(existsSync(lockOf(s.repo)), false)
})

test('sin poder escribir el almacén, implement falla con control_unavailable y un next que pide escalar, sin tocar el árbol', () => {
  const s = writerSetup()
  chmodSync(join(s.repo, '.git'), 0o500)
  let r
  try {
    r = implement(s)
  } finally {
    chmodSync(join(s.repo, '.git'), 0o755)
  }
  assert.deepEqual([r.code, r.out.code], [2, 'control_unavailable'])
  assert.match(r.out.next, /salir del sandbox \(escalada\)/)
  assert.deepEqual(runsIn(s.repo), [])
  assert.equal(git(s.repo, 'status', '--porcelain'), '')
})

test('implement con el árbol sucio se rechaza, también con --retry y la caída, nombra los archivos y remite a preguntar', () => {
  const s = writerSetup({ families: '[codex, claude]', bins: ['codex', 'claude'] })
  const first = implement(s)
  assert.equal(cli(s, ['wait', first.out.id, '--max', '20']).out.state, 'done')
  git(s.repo, 'checkout', '-q', '--', '.')
  git(s.repo, 'clean', '-qfd')
  writeFileSync(join(s.repo, 'a.txt'), 'sucio\n')
  writeFileSync(join(s.repo, 'suelto.txt'), 'x\n')
  const runsBefore = runsIn(s.repo)
  for (const extra of [[], ['--retry', first.out.id], ['--families', 'claude', '--conductor', 'claude']]) {
    const r = extra[0] === '--retry' ? cli(s, ['run', ...extra]) : implement(s, extra)
    assert.deepEqual([r.code, r.out.code], [2, 'tree_dirty'], JSON.stringify(extra))
    assert.match(r.out.message, /a\.txt/)
    assert.match(r.out.message, /suelto\.txt/)
    assert.match(r.out.next, /pregunta al usuario si conserva el cambio o lo revierte/)
    assert.match(r.out.next, /sdd-ai no hace stash, commit ni revert/)
  }
  assert.deepEqual(runsIn(s.repo), runsBefore)
  assert.equal(existsSync(lockOf(s.repo)), false)
  assert.equal(readFileSync(join(s.repo, 'a.txt'), 'utf8'), 'sucio\n')
})

test('con un writer abierto y el árbol sucio prevalece el rechazo por writer abierto', async () => {
  const s = writerSetup({ script: { hang: true } })
  const open = implement(s)
  assert.equal(open.code, 0)
  await whenRunning(s.repo, open.out.id)
  writeFileSync(join(s.repo, 'a.txt'), 'sucio\n')
  const r = implement(s)
  assert.deepEqual([r.code, r.out.code], [2, 'writer_open'])
  assert.match(r.out.message, new RegExp(open.out.id))
  assert.equal(cli(s, ['cancel', open.out.id]).code, 0)
  assert.equal(cli(s, ['wait', open.out.id, '--max', '20']).out.state, 'cancelled')
})

test('de dos run implement simultáneos queda una sola corrida', async () => {
  for (let round = 0; round < 5; round++) {
    const s = writerSetup()
    const launch = () => new Promise<{ code: number | null; out: { id?: string; code?: string } }>((res) => {
      const child = spawn(process.execPath, [BIN, 'run', '--role', 'implement', '--prompt-file', s.prompt], { cwd: s.repo, env: s.env })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('close', (code) => res({ code, out: JSON.parse(out || 'null') }))
    })
    const results = await Promise.all([launch(), launch()])
    const ok = results.filter((r) => r.code === 0)
    assert.equal(ok.length, 1, `vuelta ${round}: ${JSON.stringify(results)}`)
    assert.equal(results.find((r) => r.code !== 0)?.out.code, 'writer_open', `vuelta ${round}`)
    assert.deepEqual(runsIn(s.repo), [ok[0].out.id])
    assert.equal(cli(s, ['wait', ok[0].out.id ?? '', '--max', '20']).out.state, 'done')
  }
})

test('sdd phase en implement lanza un writer con las tasks congeladas y la cosecha cuenta el contrato', () => {
  const s = writerSetup({ script: { actions: [{ write: 'nuevo.txt', content: 'x\n' }], report: implementReport() } })
  implementFlow(s.repo)
  const prompts = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompts-')), 'p.jsonl')
  const r = cli(s, ['sdd', 'phase', 'f'], { FAKE_PROMPTS_FILE: prompts })
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.via, r.out.flow, r.out.step, r.out.pending], ['process', 'f', 'implement', ['T2', 'T3']])
  const control = readJsonFile(join(storeOf(s.repo, r.out.id), 'control.json'))
  assert.deepEqual([control.phase.flow, control.phase.pending], ['f', ['T2', 'T3']])
  const w = cli(s, ['wait', r.out.id, '--max', '30'])
  assert.equal(w.code, 0, JSON.stringify(w.out))
  // El writer nuevo lleva la marca findings y su reporte no trae la clave: se admite igual y se señala la ausencia.
  assert.deepEqual(w.out.contract, { admitted: true, missing_context: [], findings_missing: true })
  // Con todas las tasks hechas, la cadena va a verify: la revisión viene después, con el verde.
  assert.match(w.out.next, /sdd verify f/)
  assert.doesNotMatch(w.out.next, /review start/)
  assert.deepEqual(w.out.flow_next, cli(s, ['sdd', 'status', 'f']).out.next)
  const prompt = JSON.parse(readFileSync(prompts, 'utf8').trim().split('\n')[0]) as string
  assert.match(prompt, /T2, T3/)
  assert.match(prompt, /<<<INSUMO tasks/)
  assert.deepEqual(readPhaseRecord(s.repo, 'f').last_run, { id: r.out.id, step: 'implement' })
  // El último eslabón está completo: no hay otra corrida que lanzar hasta marcar las tasks y verificar.
  const again = cli(s, ['sdd', 'phase', 'f'])
  assert.deepEqual([again.code, again.out.code], [2, 'chain_complete'])

  const failures: Array<[string, object, RegExp]> = [
    ['contrato no admitido', { actions: [{ write: 'n.txt', content: 'x\n' }], report: 'Hice el cambio.\nSTATUS: done\n' }, /contrato/],
    ['tasks cambiadas', { actions: [{ write: 'n.txt', content: 'x\n' }, { append: '.plans/f/tasks.md', content: '- [ ] **T4 — otra**  · cubre: AC-1\n' }], report: implementReport() }, /insumos/],
  ]
  for (const [name, script, cause] of failures) {
    const x = writerSetup({ script })
    implementFlow(x.repo)
    const run = cli(x, ['sdd', 'phase', 'f'])
    assert.equal(run.code, 0, `${name}: ${JSON.stringify(run.out)}`)
    const h = cli(x, ['wait', run.out.id, '--max', '30'])
    assert.ok(h.out.failed.some((f: string) => cause.test(f)), `${name}: ${JSON.stringify(h.out.failed)}`)
    assert.doesNotMatch(h.out.next, /review start/, name)
  }

  // Un faltante de implement queda visible para el conductor sin hacer fallar la cosecha: el contrato se admite, la
  // completitud la dicen las tasks y la orientación sigue la cadena, sin copiar el texto del writer.
  const context = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'x\n' }], report: implementReport({ missing_context: ['el esquema'] }) } })
  implementFlow(context.repo)
  const c = cli(context, ['wait', cli(context, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  assert.equal(c.code, 0, JSON.stringify(c.out))
  assert.equal(c.out.failed, undefined, JSON.stringify(c.out.failed))
  assert.deepEqual([c.out.contract.admitted, c.out.contract.missing_context, c.out.missing_context], [true, ['el esquema'], ['el esquema']])
  assert.deepEqual([c.out.covered, c.out.left], [['T2', 'T3'], []])
  assert.match(c.out.next, /sdd verify f/)
  assert.match(c.out.next, /revisa missing_context/)
  assert.equal(c.out.next.includes('el esquema'), false)
  assert.doesNotMatch(c.out.next, /review start/)
  // Con una task sin terminar, el faltante tampoco la completa: queda pendiente y la cosecha es parcial por eso.
  const partial = writerSetup({ script: { actions: [{ write: 'n.txt', content: 'x\n' }], report: implementReport({ missing_context: ['el esquema'],
    tasks: [{ id: 'T2', completion: 'done', change_kind: 'behavior_change', changed: 'exporta', deviation: null, check: 'V1' },
      { id: 'T3', completion: 'pending', change_kind: 'refactor', changed: 'sin terminar', deviation: null, check: 'V1' }] }) } })
  implementFlow(partial.repo)
  const p = cli(partial, ['wait', cli(partial, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  assert.deepEqual([p.out.contract.admitted, p.out.missing_context, p.out.covered, p.out.left], [true, ['el esquema'], ['T2'], ['T3']])
  assert.deepEqual(p.out.failed, ['cosecha parcial: quedan T3'])

  // Un writer de fase que no dejó ningún cambio no acredita nada: la cadena sigue con las mismas tasks.
  const empty = writerSetup({ script: { report: implementReport() } })
  implementFlow(empty.repo)
  const e = cli(empty, ['wait', cli(empty, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  assert.match(e.out.next, /sigue con T2, T3: \.\/bin\/sdd-ai sdd phase f$/)

  const grammar = writerSetup()
  implementFlow(grammar.repo, '# Tasks\n\n- [ ] hacer algo sin id\n')
  const g = cli(grammar, ['sdd', 'phase', 'f'])
  assert.deepEqual([g.code, g.out.code], [2, 'phase_inline'])
  assert.match(g.out.message, /gramática/)

  const missing = writerSetup({ families: '[codex, claude]', bins: [] })
  implementFlow(missing.repo)
  const m = cli(missing, ['sdd', 'phase', 'f'])
  assert.deepEqual([m.code, m.out.code], [2, 'cli_missing'])
  assert.equal(m.out.next, 'pregunta al usuario si cae a claude; solo con un sí: ./bin/sdd-ai sdd phase f --families claude --conductor claude')
})

test('lanzamiento encadenado: la continuación reanuda la sesión de la corrida de origen con su familia, y sin sesión se niega', async () => {
  const { chainFlow, chainSetup, fakeCalls, runBin } = await import('./helpers.ts')
  const report = (done: string[], pending: string[]) => `Hecho.\n\n${JSON.stringify({ phase: 'implement', missing_context: [],
    tasks: [...done.map((id) => ({ id, completion: 'done' })), ...pending.map((id) => ({ id, completion: 'pending' }))].map((t) => ({ ...t, change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'V1' })) })}\n\nSTATUS: done\n`
  const s = chainSetup({ families: '[claude]', bins: ['claude'], writers: [
    { actions: [{ write: 'src/t1.ts', content: '1\n' }], report: report(['T1'], ['T2']) },
    { actions: [{ write: 'src/t2.ts', content: '2\n' }], report: report(['T2'], []) },
  ] })
  chainFlow(s, { tasks: 2 })
  const first = runBin(s, ['sdd', 'phase', 'f'])
  runBin(s, ['wait', first.out.id, '--max', '30'])
  const second = runBin(s, ['sdd', 'phase', 'f'])
  assert.deepEqual([second.code, second.out.family, second.out.kind], [0, 'claude', 'continuation'], JSON.stringify(second.out))
  runBin(s, ['wait', second.out.id, '--max', '30'])
  const [a, b] = fakeCalls(s)
  const sid = a[a.indexOf('--session-id') + 1]
  // El argv del hijo es el del padre con --resume en lugar de --session-id: mismo aislamiento, misma sesión.
  assert.deepEqual(b, a.map((x) => (x === '--session-id' ? '--resume' : x)))
  assert.equal(b[b.indexOf('--resume') + 1], sid)
  const control = JSON.parse(readFileSync(join(storeOf(s.repo, second.out.id), 'control.json'), 'utf8'))
  assert.deepEqual([control.phase.session_origin, control.phase.launch_from], [first.out.id, { run: first.out.id }])

  // Sin el archivo de la sesión no hay reanudación, ni otra familia ni una sesión nueva en silencio.
  const t = chainSetup({ families: '[claude]', bins: ['claude'], writers: [
    { actions: [{ write: 'src/t1.ts', content: '1\n' }], report: report(['T1'], ['T2']) },
    { actions: [{ write: 'src/t2.ts', content: '2\n' }], report: report(['T2'], []) },
  ] })
  chainFlow(t, { tasks: 2 })
  const r = runBin(t, ['sdd', 'phase', 'f'])
  runBin(t, ['wait', r.out.id, '--max', '30'])
  const sid2 = fakeCalls(t)[0][fakeCalls(t)[0].indexOf('--session-id') + 1]
  execFileSync('rm', ['-f', join(t.env.CLAUDE_CONFIG_DIR!, 'projects', '-repo', `${sid2}.jsonl`)])
  const refused = runBin(t, ['sdd', 'phase', 'f'])
  assert.deepEqual([refused.code, refused.out.code], [2, 'resume_unavailable'], JSON.stringify(refused.out))
  assert.match(refused.out.next, /--blocks/)
  assert.equal(fakeCalls(t).length, 1)
  // El bloque que propone abre una sesión nueva con la familia y el perfil del writer: no necesita la sesión perdida.
  const block = runBin(t, ['sdd', 'phase', 'f', '--blocks'])
  assert.deepEqual([block.code, block.out.kind, block.out.family], [0, 'block', 'claude'], JSON.stringify(block.out))
  runBin(t, ['wait', block.out.id, '--max', '30'])
  const [origin, blockCall] = fakeCalls(t)
  assert.ok(!blockCall.includes('--resume'))
  assert.notEqual(blockCall[blockCall.indexOf('--session-id') + 1], origin[origin.indexOf('--session-id') + 1])

  // Sin el id de la sesión de origen (Codex lo guarda en el estado), el bloque se lanza igual con el argv.
  const u = chainSetup({ writers: [
    { actions: [{ write: 'src/t1.ts', content: '1\n' }], report: report(['T1'], ['T2']) },
    { actions: [{ write: 'src/t2.ts', content: '2\n' }], report: report(['T2'], []) },
  ] })
  chainFlow(u, { tasks: 2 })
  const r0 = runBin(u, ['sdd', 'phase', 'f'])
  runBin(u, ['wait', r0.out.id, '--max', '30'])
  const statusFile = join(storeOf(u.repo, r0.out.id), 'status.json')
  const { session_id: _session, ...withoutSession } = JSON.parse(readFileSync(statusFile, 'utf8'))
  writeFileSync(statusFile, JSON.stringify(withoutSession))
  const codexBlock = runBin(u, ['sdd', 'phase', 'f', '--blocks'])
  assert.deepEqual([codexBlock.code, codexBlock.out.kind, codexBlock.out.family], [0, 'block', 'codex'], JSON.stringify(codexBlock.out))
  runBin(u, ['wait', codexBlock.out.id, '--max', '30'])
  assert.ok(!fakeCalls(u)[1].includes('resume'))
})
