import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { F_ROW, approveFlowGates, fakeCalls, runBin, type ChainSetup } from './helpers.ts'
import { DEFECT, implReport, markAll, redFlow, registry, reopenFlow, reopenRun, storeOf, writeDefect } from './chain-cli-fixture.ts'

const wait = (s: ChainSetup, id: string) => runBin(s, ['wait', id, '--max', '30'])
const phasesFile = (s: ChainSetup) => join(s.repo, '.plans', 'f', 'sdd-ai-phases.json')
const tasksFile = (s: ChainSetup) => join(s.repo, '.plans', 'f', 'tasks.md')
const editRegistry = (s: ChainSetup, edit: (r: any) => void) => {
  const r = JSON.parse(readFileSync(phasesFile(s), 'utf8'))
  edit(r)
  writeFileSync(phasesFile(s), JSON.stringify(r))
}
const editHarvest = (s: ChainSetup, run: string, patch: Record<string, unknown>) => {
  const file = join(storeOf(s, run), 'harvest.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }))
}

/** Un retorno rechazado con ese código, sin lanzar al writer y sin tocar el registro de fases. */
function refused(s: ChainSetup, code: string, tasks = 'T5,T7', args?: string[]) {
  const before = [fakeCalls(s).length, readFileSync(phasesFile(s), 'utf8')]
  const r = args ? runBin(s, args) : reopenRun(s, tasks)
  assert.notEqual(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.code, code, JSON.stringify(r.out))
  assert.deepEqual([fakeCalls(s).length, readFileSync(phasesFile(s), 'utf8')], before)
  return r
}

test('retorno: rechaza tasks fuera de alcance, sin acreditar, ajenas al writer o marcadas sin registrar ni lanzar', () => {
  const { s } = reopenFlow()
  writeDefect(s)
  const scope = registry(s).implement.chains[0].entries[0].pending
  assert.equal(scope.length, 11)
  // Una por causa: el mensaje nombra la task y la causa.
  assert.match(refused(s, 'reopen_invalid', 'T12').out.message, /T12.*fuera del alcance congelado/)
  assert.match(refused(s, 'reopen_invalid', 'T10').out.message, /T10.*no la tiene acreditada/)
  const marked = readFileSync(tasksFile(s), 'utf8')
  writeFileSync(tasksFile(s), marked.replace('- [ ] **T5 ', '- [x] **T5 '))
  assert.match(refused(s, 'reopen_invalid', 'T5').out.message, /T5.*marcada en tasks\.md/)
  writeFileSync(tasksFile(s), marked.replace('**T7 — paso 7**  · cubre', '**T7 — paso 7**  · actor: conductor  · cubre'))
  approveFlowGates(s.repo)
  assert.match(refused(s, 'reopen_invalid', 'T7').out.message, /T7.*no es del writer/)
  // Ningún retorno amplió el alcance ni agregó eslabones.
  const entries = registry(s).implement.chains[0].entries
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].pending, scope)
})

test('retorno: las combinaciones de flags inválidas son usage sin registrar ni lanzar', () => {
  const { s } = reopenFlow()
  writeDefect(s)
  const base = ['sdd', 'phase', 'f']
  // Cada rechazo lleva el diagnóstico propio de --reopen: en la base, el flag desconocido da otro mensaje.
  const usage = (label: string, cause: RegExp, ...extra: string[]) => {
    const r = refused(s, 'usage', 'T5', [...base, ...extra])
    assert.match(r.out.message, cause, label)
    assert.doesNotMatch(r.out.message, /Unknown option|desconocid/i, label)
  }
  usage('--reopen sin --context', /--reopen requiere --context/, '--reopen', 'T5')
  usage('--context sin --reopen', /--context en implement solo acompaña a --reopen/, '--context', DEFECT)
  usage('--request', /--request no se usa en implement/, '--request', DEFECT, '--reopen', 'T5', '--context', DEFECT)
  const combo = /--reopen no se combina con --blocks, --classes ni --families/
  usage('--blocks', combo, '--reopen', 'T5', '--context', DEFECT, '--blocks')
  usage('--classes', combo, '--reopen', 'T5', '--context', DEFECT, '--classes', DEFECT)
  usage('--families', combo, '--reopen', 'T5', '--context', DEFECT, '--families', 'codex')
  const ids = /--reopen espera una lista de ids T<n>/
  usage('id mal formado', ids, '--reopen', 'x5', '--context', DEFECT)
  usage('id vacío', ids, '--reopen', 'T5,,T7', '--context', DEFECT)
  usage('id repetido', ids, '--reopen', 'T5,T5', '--context', DEFECT)
  usage('--revise', /--revise no se combina con .*--reopen/, '--revise', 'spec', '--reopen', 'T5', '--context', DEFECT)

  // En el paso verify de la cadena tampoco se devuelve nada.
  const v = redFlow([F_ROW])
  writeDefect(v.s)
  const inVerify = refused(v.s, 'usage', 'T1')
  assert.match(inVerify.out.message, /--reopen devuelve tasks al writer: va en el paso implement, no en verify/)
})

test('ayuda de sdd phase: nombra --reopen junto con --context', () => {
  const { s } = reopenFlow()
  const r = runBin(s, ['sdd', 'phase'])
  assert.equal(r.out.code, 'usage')
  assert.ok(r.out.next.includes('--reopen <T-ids> --context <archivo>'), r.out.next)
})

test('retorno: las guardas de la cadena rechazan con el código de la continuación sin registrar ni lanzar', () => {
  const git = (s: ChainSetup, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: s.repo, encoding: 'utf8' })
  const flow = (writers: object[] = []) => {
    const f = reopenFlow(writers)
    writeDefect(f.s)
    return f
  }

  const head = flow()
  git(head.s, 'commit', '--allow-empty', '-q', '-m', 'se movió HEAD')
  refused(head.s, 'head_moved')

  const tree = flow()
  writeFileSync(join(tree.s.repo, 'src', 'extra.ts'), 'export const extra = 1\n')
  refused(tree.s, 'tree_not_parent')

  const session = flow()
  rmSync(join(session.s.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true })
  refused(session.s, 'resume_unavailable')
  assert.equal(registry(session.s).implement.chains[0].terminal, null)

  // Una corrida activa.
  const go = join(mkdtempSync(join(tmpdir(), 'sdd-ai-go-')), 'seguir')
  const running = flow([{ waitFor: go, actions: [{ write: 'src/t5.ts', content: 'otro\n' }], report: implReport(['T5'], ['T7', 'T10', 'T11']) }])
  const active = reopenRun(running.s)
  assert.equal(active.code, 0, JSON.stringify(active.out))
  refused(running.s, 'phase_running')
  writeFileSync(go, '')
  wait(running.s, active.out.id)

  // El último eslabón no sano es una continuación posterior; T5 sigue acreditada por la corrida inicial, que no se toca.
  const unhealthy = (patch: Record<string, unknown>) => {
    const f = flow([{ actions: [{ write: 'src/t10.ts', content: '10\n' }], report: implReport(['T10'], ['T11']) }])
    const firstHarvest = readFileSync(join(storeOf(f.s, f.first), 'harvest.json'), 'utf8')
    const cont = runBin(f.s, ['sdd', 'phase', 'f'])
    assert.equal(cont.code, 0, JSON.stringify(cont.out))
    const received = wait(f.s, cont.out.id)
    // Dos eslabones, y T5 fuera de left: la acredita la corrida inicial.
    assert.deepEqual(received.out.left, ['T11'], JSON.stringify(received.out))
    assert.equal(registry(f.s).implement.chains[0].entries.length, 2)
    editHarvest(f.s, cont.out.id, patch)
    assert.equal(readFileSync(join(storeOf(f.s, f.first), 'harvest.json'), 'utf8'), firstHarvest)
    return f
  }

  // Último eslabón cortado: se orienta a reanudarlo.
  const cut = unhealthy({ endMark: false })
  assert.match(refused(cut.s, 'reopen_not_apt').out.next, /sdd phase f/)

  const state = (name: string, patch: Record<string, unknown>) => {
    const f = unhealthy(patch)
    refused(f.s, 'chain_closed')
    assert.equal(registry(f.s).implement.chains[0].terminal, null, name)
  }
  state('contrato no admitido', { report: 'sin contrato\nSTATUS: done\n' })
  state('cosecha no íntegra', { flagged: [{ path: '.agents/sintetico.txt' }] })
  state('corrida alterada', { runAltered: [{ path: 'request.json' }] })
  state('HEAD movido en la cosecha', { headMoved: true })
  state('insumos cambiados', { phase_inputs: 'changed' })

  // Tres fallos de la misma fila en la época del plan.
  const capped = flow()
  const plan = JSON.parse(readFileSync(join(capped.s.repo, '.plans', 'f', 'sdd-ai-approvals.json'), 'utf8')).approvals.find((a: { gate: string }) => a.gate === 'plan')
  editRegistry(capped.s, (r) => {
    r.implement.classifications = ['R1', 'R2', 'R3'].map((id) => ({
      receipt: { id, digest: `sha256:${'a'.repeat(64)}` }, epoch: `at:${plan.at}`, at: plan.at,
      rows: [{ row: 'V1', class: 'implementation', proposed: null, reason: 'r' }],
    }))
  })
  refused(capped.s, 'chain_closed')

  // Cadena cerrada por una toma del conductor.
  const taken = flow()
  markAll(taken.s)
  writeFileSync(join(taken.s.repo, 'src', 'mano.ts'), 'export const mano = 1\n')
  runBin(taken.s, ['sdd', 'verify', 'f', '--takeover'])
  assert.equal(registry(taken.s).implement.chains[0].entries.at(-1).kind, 'takeover')
  // Las devueltas siguen abiertas en tasks.md: con todas marcadas el paso es verify y el rechazo sería usage.
  const marked = readFileSync(tasksFile(taken.s), 'utf8')
  writeFileSync(tasksFile(taken.s), marked.replace('- [x] **T5 ', '- [ ] **T5 ').replace('- [x] **T7 ', '- [ ] **T7 '))
  refused(taken.s, 'chain_closed')

  // Cadena con terminal persistido, también con una aprobación posterior del plan y de las tasks.
  const terminal = flow()
  editRegistry(terminal.s, (r) => { r.implement.chains[0].terminal = { code: 'resume_unavailable', at: '2026-09-29T15:00:00.000Z', detail: 'sin sesión' } })
  refused(terminal.s, 'chain_closed')
  approveFlowGates(terminal.s.repo, Date.parse('2026-09-30T01:00:00.000Z'))
  refused(terminal.s, 'chain_closed')

  // Actor inválido y pendientes inline.
  const actor = flow()
  const text = readFileSync(tasksFile(actor.s), 'utf8')
  writeFileSync(tasksFile(actor.s), text.replace('**T11 — paso 11**  · cubre', '**T11 — paso 11**  · actor: otro  · cubre'))
  approveFlowGates(actor.s.repo)
  // sdd phase rechaza con not_a_phase y orienta a sdd status, como la continuación; status diagnostica la causa.
  assert.match(refused(actor.s, 'not_a_phase').out.next, /sdd status f/)
  const status = JSON.stringify(runBin(actor.s, ['sdd', 'status', 'f']).out)
  assert.match(status, /blocked_reasons/)
  assert.match(status, /task_actor_invalid/)
  const inline = flow()
  writeFileSync(tasksFile(inline.s), `${readFileSync(tasksFile(inline.s), 'utf8')}- [ ] algo suelto sin id\n`)
  approveFlowGates(inline.s.repo)
  refused(inline.s, 'coordination_pending')
})
