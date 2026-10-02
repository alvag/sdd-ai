import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChainSetup, chainFlow, chainSetup, fakeCalls, runBin } from './helpers.ts'
import { storeOf, implReport, fixReport, markAll, classesFile, redFlow } from './chain-cli-fixture.ts'

test('exige completitud explicita y rechaza contratos mal formados', () => {
  // Un contrato sin completion no se admite: la cosecha no es padre de nada.
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'x\n' }], report: `Hecho.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: [{ id: 'T1', change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'V1' }] })}\n\nSTATUS: done\n` }] })
  chainFlow(s)
  const first = runBin(s, ['sdd', 'phase', 'f'])
  const w = runBin(s, ['wait', first.out.id, '--max', '30'])
  assert.ok(w.out.failed.some((f: string) => /contrato de la fase no se admitió: .*completion/.test(f)), JSON.stringify(w.out.failed))
  assert.match(w.out.next, /contrato del writer no se admitió/)
  assert.equal(runBin(s, ['sdd', 'phase', 'f']).out.code, 'chain_closed')
  // Con completion, la prosa no cuenta: pending sigue pendiente aunque el reporte diga que terminó.
  const p = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'x\n' }], report: `Terminé todo.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: [{ id: 'T1', completion: 'pending', change_kind: 'behavior_change', changed: 'casi', deviation: null, check: 'V1' }] })}\n\nSTATUS: done\n` }] })
  chainFlow(p)
  const wp = runBin(p, ['wait', runBin(p, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  assert.deepEqual([wp.out.partial, wp.out.left], [true, ['T1']])
})

test('valida el padre y las huellas antes de lanzar', async () => {
  const { F_ROW, approveFlowGates } = await import('./helpers.ts')
  const git = (s: ChainSetup, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: s.repo, encoding: 'utf8' }).trim()
  // Un árbol editado después de la cosecha: la continuación se niega, nombra la ruta y no toca nada.
  const partial = () => {
    const s = chainSetup({ writers: [{ actions: [{ write: 'src/t1.ts', content: '1\n' }], report: implReport(['T1'], ['T2']) }, { hang: true, report: implReport(['T2']) }, {}] })
    chainFlow(s, { tasks: 2 })
    runBin(s, ['wait', runBin(s, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
    return s
  }
  const a = partial()
  writeFileSync(join(a.repo, 'src', 'mia.ts'), 'mía\n')
  const edited = runBin(a, ['sdd', 'phase', 'f'])
  assert.deepEqual([edited.code, edited.out.code, edited.out.detail], [2, 'tree_not_parent', 'src/mia.ts'], JSON.stringify(edited.out))
  assert.equal(readFileSync(join(a.repo, 'src', 'mia.ts'), 'utf8'), 'mía\n')
  assert.equal(fakeCalls(a).length, 1)

  // HEAD movido: la cadena no sigue.
  const b = partial()
  git(b, 'add', '-A')
  git(b, 'commit', '-qm', 'a mano')
  assert.equal(runBin(b, ['sdd', 'phase', 'f']).out.code, 'head_moved')

  // Dos lanzamientos sobre el mismo padre: el segundo se niega mientras el primero corre.
  const c = partial()
  const first = runBin(c, ['sdd', 'phase', 'f'])
  assert.equal(first.code, 0, JSON.stringify(first.out))
  const second = runBin(c, ['sdd', 'phase', 'f'])
  assert.equal(second.out.code, 'phase_running', JSON.stringify(second.out))
  runBin(c, ['cancel', first.out.id])
  runBin(c, ['wait', first.out.id, '--max', '30'])

  // El recibo tiene que ser el último, íntegro y del candidato de ahora.
  const d = redFlow([F_ROW])
  const receiptFile = join(d.s.repo, '.git', 'sdd-ai', 'verify', d.receipt, 'receipt.json')
  const original = readFileSync(receiptFile, 'utf8')
  writeFileSync(receiptFile, original.replace('"green": false', '"green": false '))
  assert.equal(runBin(d.s, ['sdd', 'phase', 'f', '--classes', classesFile(d.s, d.receipt, [['V1', 'implementation']])]).out.code, 'receipt_not_red')
  writeFileSync(receiptFile, original)
  writeFileSync(join(d.s.repo, 'src', 'otra.ts'), 'x\n')
  assert.equal(runBin(d.s, ['sdd', 'phase', 'f', '--classes', classesFile(d.s, d.receipt, [['V1', 'implementation']])]).out.code, 'receipt_not_red')
  assert.equal(fakeCalls(d.s).length, 1)
  // Un recibo que ya no es el último: verify corrió otra vez sobre el mismo candidato.
  const g = redFlow([F_ROW])
  const newer = runBin(g.s, ['sdd', 'verify', 'f'])
  assert.notEqual(newer.out.receipt, g.receipt)
  const stale = runBin(g.s, ['sdd', 'phase', 'f', '--classes', classesFile(g.s, g.receipt, [['V1', 'implementation']])])
  assert.equal(stale.out.code, 'classification_invalid', JSON.stringify(stale.out))
  assert.equal(fakeCalls(g.s).length, 1)
  // HEAD movido después del recibo: la corrección no se lanza.
  const h = redFlow([F_ROW])
  git(h.s, 'add', '-A')
  git(h.s, 'commit', '-qm', 'a mano')
  const moved = runBin(h.s, ['sdd', 'phase', 'f', '--classes', classesFile(h.s, h.receipt, [['V1', 'implementation']])])
  assert.deepEqual([moved.code, moved.out.code], [2, 'head_moved'], JSON.stringify(moved.out))
  assert.equal(fakeCalls(h.s).length, 1)
  // La huella del plan cambió y se reaprobó: el recibo de antes ya no sirve para corregir.
  const k = redFlow([F_ROW])
  const plan = join(k.s.repo, '.plans', 'f', 'plan.md')
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('Uno.', 'Uno, con otra huella.'))
  approveFlowGates(k.s.repo, Date.parse('2026-09-30T01:00:00.000Z'))
  const replanned = runBin(k.s, ['sdd', 'phase', 'f', '--classes', classesFile(k.s, k.receipt, [['V1', 'implementation']])])
  assert.equal(replanned.out.code, 'receipt_not_red', JSON.stringify(replanned.out))
  assert.equal(fakeCalls(k.s).length, 1)
  // Una familia que no se resuelve no deja una entrada registrada sin control.
  const q = chainSetup({ writers: [{ report: implReport(['T1']) }] })
  chainFlow(q)
  writeFileSync(join(q.repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [nada]\n  selection: full\n')
  const unresolved = runBin(q, ['sdd', 'phase', 'f'])
  assert.equal(unresolved.code, 2, JSON.stringify(unresolved.out))
  const qPhases = join(q.repo, '.plans', 'f', 'sdd-ai-phases.json')
  assert.equal(existsSync(qPhases) ? (JSON.parse(readFileSync(qPhases, 'utf8')).implement?.chains.length ?? 0) : 0, 0)
  assert.equal(fakeCalls(q).length, 0)

  // Un registro alterado durante la corrida invalida la entrega sin perder el vínculo con la fase.
  const e = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'x\n' }, { append: '.plans/f/sdd-ai-phases.json', content: ' ' }], report: implReport(['T1']) }] })
  chainFlow(e)
  const run = runBin(e, ['sdd', 'phase', 'f']).out.id
  const w = runBin(e, ['wait', run, '--max', '30'])
  assert.ok(w.out.failed.some((f: string) => /insumos/.test(f)), JSON.stringify(w.out.failed))
  assert.equal(JSON.parse(readFileSync(join(storeOf(e, run), 'control.json'), 'utf8')).phase.flow, 'f')
  assert.match(w.out.next, /toma/)

  // Una entrada registrada sin control: status orienta a cancel, cancel la marca y la cadena relanza su inicial.
  const o = chainSetup({ writers: [{ report: implReport(['T1']) }] })
  chainFlow(o)
  const phases = join(o.repo, '.plans', 'f', 'sdd-ai-phases.json')
  const ghost = '20260929-2359-dead'
  writeFileSync(phases, JSON.stringify({ schema_version: 1, last_run: null, phases: {}, implement: { schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'implement', run: ghost, parent: null, at: '2026-09-29T23:59:00.000Z', pending: ['T1'] }], terminal: null }], classifications: [], events: [] } }))
  assert.equal(runBin(o, ['sdd', 'status', 'f']).out.next.command, `./bin/sdd-ai cancel ${ghost}`)
  assert.equal(runBin(o, ['cancel', ghost]).out.state, 'launch_failed')
  // Cancelarla otra vez no agrega otro evento: la entrada ya está marcada.
  assert.equal(runBin(o, ['cancel', ghost]).out.state, 'launch_failed')
  assert.equal(JSON.parse(readFileSync(phases, 'utf8')).implement.events.length, 1)
  const relaunch = runBin(o, ['sdd', 'phase', 'f'])
  assert.deepEqual([relaunch.code, relaunch.out.chain, relaunch.out.kind], [0, 'c1', 'implement'], JSON.stringify(relaunch.out))
  // El relanzamiento conserva la base que registró la entrada: con HEAD movido después, se niega.
  const m = chainSetup({ writers: [{ report: implReport(['T1']) }] })
  chainFlow(m)
  const lost = '20260929-2358-beef'
  const at0 = '2026-09-29T23:58:00.000Z'
  writeFileSync(join(m.repo, '.plans', 'f', 'sdd-ai-phases.json'), JSON.stringify({ schema_version: 1, last_run: null, phases: {}, implement: {
    schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'implement', run: lost, parent: null, base: m.base, at: at0, pending: ['T1'] }], terminal: null }],
    classifications: [], events: [{ kind: 'launch_failed', at: at0, chain: 'c1', run: lost, detail: 'no arrancó' }],
  } }))
  git(m, 'commit', '--allow-empty', '-qm', 'otro')
  const rebased = runBin(m, ['sdd', 'phase', 'f'])
  assert.deepEqual([rebased.code, rebased.out.code], [2, 'head_moved'], JSON.stringify(rebased.out))
  assert.equal(fakeCalls(m).length, 0)
})

test('la cadena no introduce estados gates ni operaciones git automaticas', () => {
  const s = chainSetup({
    writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) },
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) },
    ],
  })
  chainFlow(s)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: s.repo, encoding: 'utf8' }).trim()
  const dir = join(s.repo, '.plans', 'f')
  const handoff = readFileSync(join(dir, 'handoff.md'), 'utf8')
  const approvals = readFileSync(join(dir, 'sdd-ai-approvals.json'), 'utf8')
  const planHeader = () => { const t = readFileSync(join(dir, 'plan.md'), 'utf8'); return t.slice(0, t.indexOf('\n---\n', 4) + 5) }
  const headerBefore = planHeader()
  const commits = git('rev-list', '--all')
  const steps = new Set<string>()
  const see = () => steps.add(runBin(s, ['sdd', 'status', 'f']).out.next.step)
  const first = runBin(s, ['sdd', 'phase', 'f'])
  runBin(s, ['wait', first.out.id, '--max', '30'])
  see()
  markAll(s)
  see()
  const red = runBin(s, ['sdd', 'verify', 'f'])
  see()
  const fix = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, red.out.receipt, [['V1', 'implementation']])])
  runBin(s, ['wait', fix.out.id, '--max', '30'])
  see()
  runBin(s, ['sdd', 'verify', 'f'])
  see()
  // Los pasos son los del ciclo de siempre, y el header del plan solo pasa por estados conocidos.
  for (const step of steps) assert.ok(['implement', 'verify', 'review_and_commit'].includes(step), step)
  const headerAfter = planHeader()
  const status = /^status: (.*)$/m.exec(headerAfter)![1]
  assert.ok(['planned', 'plan-approved', 'tasks-ready', 'implementing', 'verified', 'committed', 'pushed', 'pr-open', 'done'].includes(status), status)
  // Fuera de status, el header del plan queda byte a byte como estaba.
  assert.equal(headerAfter.replace(/^status: .*$/m, ''), headerBefore.replace(/^status: .*$/m, ''))
  // Nada aprobó un gate, commiteó, stageó ni tocó el handoff.
  assert.equal(readFileSync(join(dir, 'handoff.md'), 'utf8'), handoff)
  assert.equal(readFileSync(join(dir, 'sdd-ai-approvals.json'), 'utf8'), approvals)
  assert.equal(git('rev-list', '--all'), commits)
  assert.equal(git('diff', '--cached', '--name-only'), '')
})
