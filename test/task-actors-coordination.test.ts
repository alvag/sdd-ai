import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainView } from '../src/sdd/chain-facts.ts'
import { readFlow } from '../src/sdd/read.ts'
import { resolve } from '../src/sdd/status.ts'
import { actorFlow, writer, implementationReport, launch, harvest, runBin, fakeCalls, tasksPath, mark, registry, approveFlowGates } from './task-actors-fixture.ts'

test('sin writer pendiente identifica actores restantes y no lanza ni propone verify', () => {
  const s = actorFlow([{ id: 'T1', actor: 'conductor' }, { id: 'T2', actor: 'user' }])
  const before = readFileSync(tasksPath(s), 'utf8')
  const status = runBin(s, ['sdd', 'status', 'f'])
  assert.equal(status.out.tasks.pending, 2)
  assert.deepEqual(status.out.tasks.pending_assignments.map((t: { actor: string }) => t.actor), ['conductor', 'user'])
  // En normal, la cadena lee las abiertas del mismo tasks.md que las responsabilidades.
  assert.deepEqual(chainView(s.repo, 'f', readFlow(s.repo, 'f')).input.open, ['T1', 'T2'])
  assert.equal(status.out.next.command, undefined)
  assert.match(status.out.next.detail, /T1.*conductor.*T2.*user/)
  assert.doesNotMatch(status.out.next.detail, /sdd verify|--takeover/)
  const request = launch(s)
  assert.equal(request.out.state, 'actors_pending', JSON.stringify(request.out))
  // La salida de sdd phase identifica cada pendiente con su responsable.
  assert.deepEqual(request.out.external_pending.map((t: { id: string; actor: string }) => [t.id, t.actor]), [['T1', 'conductor'], ['T2', 'user']])
  assert.match(request.out.next, /T1.*conductor.*T2.*user/)
  assert.equal(fakeCalls(s).length, 0)
  assert.equal(existsSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json')), false)
  assert.equal(readFileSync(tasksPath(s), 'utf8'), before)

  const mixed = actorFlow([{ id: 'T1', actor: 'writer' }, { id: 'T2', actor: 'conductor' }, { id: 'T3', actor: 'user' }], [writer(implementationReport(['T1']))])
  const first = launch(mixed)
  const h = harvest(mixed, first.out.id)
  assert.deepEqual(h.out.covered, ['T1'])
  assert.deepEqual(h.out.external_pending.map((t: { id: string }) => t.id), ['T2', 'T3'])
  assert.match(h.out.next, /coordina.*T2.*conductor.*T3.*user/)
  assert.equal(readFileSync(tasksPath(mixed), 'utf8').includes('[x]'), false)
  mark(mixed, ['T1'])
  const next = launch(mixed)
  assert.equal(next.out.state, 'actors_pending')
  assert.deepEqual(next.out.external_pending.map((t: { id: string; actor: string }) => [t.id, t.actor]), [['T2', 'conductor'], ['T3', 'user']])
  assert.match(next.out.next, /T2.*conductor.*T3.*user/)
  // T1 ya está marcada: no se vuelve a pedir que se marque.
  assert.doesNotMatch(next.out.next, /tasks acreditadas/)
  assert.equal(registry(mixed).implement.chains[0].terminal, null)
  assert.equal(fakeCalls(mixed).length, 1)
  assert.equal(runBin(mixed, ['sdd', 'status', 'f']).out.next.command, undefined)
})

test('cuenta pendientes inline y actores inválidos y lee el candidato de la profundidad vigente', () => {
  const s = actorFlow([{ id: 'T1', actor: 'user' }])
  const file = tasksPath(s)
  writeFileSync(file, readFileSync(file, 'utf8') + '\n- [ ] tarea inline\n')
  approveFlowGates(s.repo)
  assert.equal(runBin(s, ['sdd', 'status', 'f']).out.tasks.pending, 2)
  assert.equal(launch(s).out.code, 'phase_inline')
  const invalid = '- [ ] **T1 — Actor inválido** · actor: other · cubre: AC-1\n'
  // La lectura de un candidato en memoria no toca el artefacto persistido.
  const oldText = readFileSync(file, 'utf8')
  const candidate = resolve(readFlow(s.repo, 'f', undefined, { artifact: 'tasks', text: invalid }).facts)
  assert.equal(candidate.tasks.pending, 1)
  assert.ok(candidate.blocked_reasons.some((r) => r.code === 'task_actor_invalid' && /T1/.test(r.detail)))
  assert.equal(readFileSync(file, 'utf8'), oldText)
  writeFileSync(file, invalid)
  approveFlowGates(s.repo)
  assert.ok(runBin(s, ['sdd', 'status', 'f']).out.blocked_reasons.some((r: { code: string }) => r.code === 'task_actor_invalid'))
  // `sdd phase` tampoco lanza: el actor inválido no se asigna al writer ni registra una cadena.
  const refused = launch(s)
  assert.notEqual(refused.code, 0, JSON.stringify(refused.out))
  // El flujo queda en resolve_blockers: el rechazo remite a status, que nombra task_actor_invalid.
  assert.equal(refused.out.code, 'not_a_phase', JSON.stringify(refused.out))
  assert.match(refused.out.next, /sdd status f/)
  assert.equal(fakeCalls(s).length, 0)
  assert.equal(existsSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json')), false)

  // Un candidato corta se lee desde ## Tasks del candidato, aunque el artefacto previo sea diferente.
  rmSync(file)
  rmSync(join(s.repo, '.plans', 'f', 'spec.md'))
  rmSync(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.json'))
  const plan = join(s.repo, '.plans', 'f', 'plan.md')
  const text = readFileSync(plan, 'utf8').replace('profundidad: completa', 'profundidad: corta') + '\n## Spec\n\nPedido\n\n## Tasks\n\n- [ ] **T1 — Observar** · actor: user · cubre: AC-1\n'
  writeFileSync(plan, text)
  const handoff = join(s.repo, '.plans', 'f', 'handoff.md')
  writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('profundidad: completa', 'profundidad: corta'))
  assert.deepEqual(resolve(readFlow(s.repo, 'f').facts).tasks.pending_assignments?.map((t) => t.actor), ['user'])
  // En corta, la cadena lee las abiertas de la sección Tasks de plan.md, la misma fuente que las responsabilidades,
  // aunque tasks.md ya no exista.
  assert.deepEqual(chainView(s.repo, 'f', readFlow(s.repo, 'f')).input.open, ['T1'])
  assert.deepEqual(resolve(readFlow(s.repo, 'f', undefined, { artifact: 'plan', text: text.replace('actor: user', 'actor: conductor') }).facts).tasks.pending_assignments?.map((t) => t.actor), ['conductor'])
  // Con el gate single aprobado en este repositorio sintético, el paso es implement: la falta de comando viene de la
  // coordinación de la task de user en profundidad corta, no de un gate pendiente.
  const fp = readFlow(s.repo, 'f').facts.fingerprints
  writeFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.json'),
    JSON.stringify({ schema_version: 1, approvals: [{ gate: 'single', depth: 'corta', fingerprint: fp.single, previous: {}, at: '2026-09-29T14:00:00.000Z' }] }))
  const short = runBin(s, ['sdd', 'status', 'f']).out
  assert.equal(short.next.step, 'implement', JSON.stringify(short))
  assert.equal(short.next.command, undefined, JSON.stringify(short.next))
  assert.deepEqual(short.tasks.pending_assignments.map((t: { actor: string }) => t.actor), ['user'])
})
