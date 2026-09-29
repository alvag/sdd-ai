import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runHook } from '../src/hooks.ts'
import { writeJsonAtomic } from '../src/runs.ts'
import {
  PHASES_FILE, type PhaseProbe, type PhaseRecord, activeRun, phaseNext, readPhaseRecord, withFlowLock, writePhaseRecord,
} from '../src/sdd/phase-state.ts'
import type { FlowStatus, Step } from '../src/sdd/status.ts'
import { payload } from './hook-contract.ts'
import { makeRepo } from './helpers.ts'

const status = (step: Step, depth: FlowStatus['depth'] = 'completa'): FlowStatus => ({
  id: 'f', depth, gates: [], tasks: { total: 0, done: 0, pending: 0, first_pending: null }, next: { step }, blocked_reasons: [], notes: [], paths: {},
})
const empty = (): PhaseRecord => ({ schema_version: 1, last_run: null, phases: {} })
const probe = (o: Partial<PhaseProbe> = {}): PhaseProbe => ({ active: () => false, dirty: () => [], writerHolds: () => false, ...o })

test('next.command sigue el estado de la fase en el registro', () => {
  assert.deepEqual(phaseNext('/r', 'f', status('specify'), empty(), probe()), { command: './bin/sdd-ai sdd phase f --request <archivo>' })
  assert.deepEqual(phaseNext('/r', 'f', status('plan', 'normal'), empty(), probe()), { command: './bin/sdd-ai sdd phase f' })

  const running: PhaseRecord = { ...empty(), last_run: { id: 'R1', step: 'plan' } }
  assert.deepEqual(phaseNext('/r', 'f', status('plan'), running, probe({ active: (id) => id === 'R1' })), { command: './bin/sdd-ai wait R1' })
  // Una corrida terminada sin artefacto no deja nada pendiente: la fase se vuelve a lanzar.
  assert.deepEqual(phaseNext('/r', 'f', status('plan'), running, probe()), { command: './bin/sdd-ai sdd phase f' })

  const awaiting: PhaseRecord = { ...empty(), last_run: { id: 'R1', step: 'tasks' }, phases: { tasks: { awaiting: { run: 'R1', blocking_questions: ['¿x?'], missing_context: [] } } } }
  assert.deepEqual(phaseNext('/r', 'f', status('tasks'), awaiting, probe()), { command: './bin/sdd-ai sdd phase f --context <archivo>' })
  const awaitingSpec: PhaseRecord = { ...empty(), phases: { specify: { awaiting: { run: 'R1', blocking_questions: [], missing_context: ['el esquema'] } } } }
  assert.deepEqual(phaseNext('/r', 'f', status('specify'), awaitingSpec, probe()), { command: './bin/sdd-ai sdd phase f --context <archivo>' })

  const inline: PhaseRecord = { ...empty(), phases: { plan: { amended: { run: 'R2', consumed: true }, inline: { run: 'R2', at: '2026-09-29T10:00:00.000Z' } } } }
  const closed = phaseNext('/r', 'f', status('plan'), inline, probe())
  assert.equal(closed?.command, undefined)
  assert.match(closed?.detail ?? '', /inline/)

  const writer: PhaseRecord = { ...empty(), last_run: { id: 'W1', step: 'implement' } }
  const byWriter = phaseNext('/r', 'f', status('implement'), writer, probe({ dirty: () => ['src/a.ts'], writerHolds: (id) => id === 'W1' }))
  assert.equal(byWriter?.command, undefined)
  assert.match(byWriter?.detail ?? '', /W1/)
  assert.match(byWriter?.detail ?? '', /revisa el diff/)
  const foreign = phaseNext('/r', 'f', status('implement'), writer, probe({ dirty: () => ['src/a.ts', 'b.md'] }))
  assert.equal(foreign?.command, undefined)
  assert.match(foreign?.detail ?? '', /src\/a\.ts, b\.md/)
  assert.deepEqual(phaseNext('/r', 'f', status('implement'), writer, probe()), { command: './bin/sdd-ai sdd phase f' })
  assert.deepEqual(phaseNext('/r', 'f', status('implement'), writer, probe({ active: () => true, dirty: () => ['x'] })), { command: './bin/sdd-ai wait W1' })

  for (const s of [status('specify', 'corta'), status('gate'), status('verify'), status('implement', 'corta'), status('depth', null)]) {
    assert.equal(phaseNext('/r', 'f', s, empty(), probe()), null, `${s.next.step} ${s.depth}`)
  }
})

test('el registro de fases vive en el flujo, bajo el lock de sdd approve, y la corrida activa sale de su estado', () => {
  const repo = makeRepo()
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  assert.deepEqual(readPhaseRecord(repo, 'f'), empty())
  const r: PhaseRecord = { ...empty(), last_run: { id: 'R1', step: 'specify' } }
  withFlowLock(repo, 'f', () => {
    assert.equal(existsSync(join(dir, 'sdd-ai-approvals.lock')), true)
    writePhaseRecord(repo, 'f', r)
  })
  assert.equal(existsSync(join(dir, 'sdd-ai-approvals.lock')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, PHASES_FILE), 'utf8')), r)
  assert.deepEqual(readPhaseRecord(repo, 'f'), r)

  // Sin la corrida en disco no hay nada activo; con su estado, activa hasta que es terminal.
  assert.equal(activeRun(repo, r), null)
  const run = join(repo, '.sdd-ai', 'runs', 'R1')
  mkdirSync(run, { recursive: true })
  writeJsonAtomic(join(run, 'status.json'), { state: 'running' })
  assert.equal(activeRun(repo, r), 'R1')
  writeJsonAtomic(join(run, 'status.json'), { state: 'done' })
  assert.equal(activeRun(repo, r), null)

  // Otro comando con el lock tomado recibe el mensaje genérico, sin robarlo.
  writeFileSync(join(dir, 'sdd-ai-approvals.lock'), '999999\n')
  assert.throws(() => withFlowLock(repo, 'f', () => 1), (e: unknown) => (e as { code?: string }).code === 'flow_busy')
  const broken: unknown[] = [
    { schema_version: 2 },
    { schema_version: 1, last_run: null, phases: { plan: { awaiting: { run: 'R1' } } } },
    { schema_version: 1, last_run: null, phases: { plan: { awaiting: { run: 'R1', blocking_questions: [1], missing_context: [] } } } },
    { schema_version: 1, last_run: null, phases: { plan: { amended: { run: 'R1' } } } },
    { schema_version: 1, last_run: null, phases: { plan: { inline: { at: 'x' } } } },
    { schema_version: 1, last_run: null, phases: { plan: { otra: {} } } },
    { schema_version: 1, last_run: null, phases: { implement: {} } },
  ]
  for (const b of broken) {
    writeFileSync(join(dir, PHASES_FILE), JSON.stringify(b))
    assert.throws(() => readPhaseRecord(repo, 'f'), (e: unknown) => (e as { code?: string }).code === 'phases_invalid', JSON.stringify(b))
  }
})

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const sddStatus = (repo: string, ...args: string[]) => {
  const r = spawnSync(BIN, ['sdd', 'status', ...args], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  return JSON.parse(r.stdout)
}
const sessionLine = (repo: string, id: string): string => {
  const out = JSON.parse(runHook(JSON.stringify(payload('claude', 'session-start', { cwd: repo, session_id: 's1', source: 'startup' })), 'claude'))
  const block = String(out.hookSpecificOutput.additionalContext).split('\n\n').at(-1) ?? ''
  return block.split('\n').find((l) => l.startsWith(`- ${id} `)) ?? ''
}

test('next.command sigue el estado de la fase en sdd status, el listado y la línea de sesión', () => {
  const repo = makeRepo()
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: repo })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\n')
  mkdirSync(join(repo, '.sdd-ai'), { recursive: true })
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'handoff.md'), '---\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: 2026-09-29T08:59:18-05:00\n---\n')
  writeFileSync(join(dir, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** algo. (pedido)\n')
  const seen = () => {
    const one = sddStatus(repo, 'f').next
    const listed = sddStatus(repo).flows.find((e: { id: string }) => e.id === 'f').next
    return { one, listed, line: sessionLine(repo, 'f') }
  }

  let v = seen()
  assert.equal(v.one.command, './bin/sdd-ai sdd phase f')
  assert.deepEqual(v.listed, v.one)
  assert.equal(v.line, '- f (completa): plan · ./bin/sdd-ai sdd phase f')

  const awaiting: PhaseRecord = { ...empty(), last_run: { id: 'R1', step: 'plan' }, phases: { plan: { awaiting: { run: 'R1', blocking_questions: ['¿x?'], missing_context: [] } } } }
  withFlowLock(repo, 'f', () => writePhaseRecord(repo, 'f', awaiting))
  v = seen()
  assert.equal(v.one.command, './bin/sdd-ai sdd phase f --context <archivo>')
  assert.deepEqual(v.listed, v.one)
  assert.equal(v.line, '- f (completa): plan · ./bin/sdd-ai sdd phase f --context <archivo>')

  withFlowLock(repo, 'f', () => writePhaseRecord(repo, 'f', { ...empty(), phases: { plan: { inline: { run: 'R2', at: '2026-09-29T10:00:00.000Z' } } } }))
  v = seen()
  assert.equal(v.one.command, undefined)
  assert.match(v.one.detail, /inline/)
  assert.deepEqual(v.listed, v.one)
  assert.equal(v.line, `- f (completa): plan · ${v.one.detail}`)

  // Un registro ilegible no tumba el listado ni la línea de sesión: lo dicen en su lugar.
  writeFileSync(join(dir, PHASES_FILE), 'no es JSON')
  v = seen()
  assert.equal(v.one.command, undefined)
  assert.match(v.one.detail, /registro de fases/)
  assert.deepEqual(v.listed, v.one)
  assert.match(v.line, /^- f \(completa\): plan · no se pudo leer el registro de fases/)
})
