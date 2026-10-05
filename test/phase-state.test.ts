import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runHook } from '../src/hooks.ts'
import { writeJsonAtomic } from '../src/runs.ts'
import {
  PHASES_FILE, type PhaseProbe, type PhaseRecord, activeRun, appendClassification, appendEntry, appendEvent, closeChain, implementOf, phaseNext,
  readPhaseRecord, withFlowLock, writePhaseRecord,
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
  const r = spawnSync(BIN, ['sdd', 'status', ...args], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, SDD_AI_PROJECTION: 'off' } })
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
  writeFileSync(join(dir, 'handoff.md'), '---\nbranch: feature/f\nprofundidad: completa\nrisk: low\nchange_type: feat\nspec_approved_at: 2026-09-29T08:59:18-05:00\n---\n')
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

test('registro de cadenas: se lee sin la clave, guarda el orden explícito y no reemplaza un terminal ni una clasificación', () => {
  const repo = makeRepo()
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  // Un registro anterior, sin implement, se lee igual y su vista de cadenas está vacía.
  writeFileSync(join(dir, PHASES_FILE), JSON.stringify({ schema_version: 1, last_run: null, phases: {} }))
  assert.deepEqual(implementOf(readPhaseRecord(repo, 'f')), { schema: 1, chains: [], classifications: [], events: [] })

  const at = '2026-09-29T20:00:00.000Z'
  const digest = `sha256:${'a'.repeat(64)}`
  withFlowLock(repo, 'f', () => {
    const c1 = appendEntry(repo, 'f', null, { kind: 'implement', run: '20260929-2000-aaaa', parent: null, at, pending: ['T1', 'T2'] })
    appendEntry(repo, 'f', c1, { kind: 'continuation', run: '20260929-2001-bbbb', parent: '20260929-2000-aaaa', at, pending: ['T2'] })
    appendEntry(repo, 'f', c1, { kind: 'fix', run: '20260929-2002-cccc', parent: '20260929-2001-bbbb', at, receipt: { id: '20260929-2001-rrrr', digest } })
    appendEntry(repo, 'f', c1, { kind: 'takeover', id: 't1', parent: '20260929-2002-cccc', at, map: { ref: 'takeovers/t1.json', digest }, reason: 'a mano' })
    assert.equal(c1, 'c1')
    assert.deepEqual(closeChain(repo, 'f', c1, { code: 'fix_cap', at, detail: 'dos correcciones' }).code, 'fix_cap')
    // Un terminal ya escrito no se reemplaza.
    assert.deepEqual(closeChain(repo, 'f', c1, { code: 'takeover', at, detail: 'toma' }).code, 'fix_cap')
    const cls = { receipt: { id: '20260929-2001-rrrr', digest }, epoch: 'e1', at, rows: [{ row: 'V1', class: 'implementation' as const, proposed: 'implementation' as const, reason: 'la suma' }] }
    appendClassification(repo, 'f', cls)
    assert.deepEqual(appendClassification(repo, 'f', { ...cls, epoch: 'e2' }).epoch, 'e1')
    appendEvent(repo, 'f', { kind: 'launch_failed', at, chain: c1, run: '20260929-2003-dddd', detail: 'no arrancó' })
    assert.equal(appendEntry(repo, 'f', null, { kind: 'implement', run: '20260929-2004-eeee', parent: 't1', at, pending: ['T3'] }), 'c2')
  })
  const r = readPhaseRecord(repo, 'f')
  const imp = implementOf(r)
  assert.deepEqual(imp.chains.map((c) => [c.id, c.entries.map((e) => e.kind), c.terminal?.code ?? null]),
    [['c1', ['implement', 'continuation', 'fix', 'takeover'], 'fix_cap'], ['c2', ['implement'], null]])
  // El padre de cada eslabón es explícito: el orden no sale de los ids.
  assert.deepEqual(imp.chains[0].entries.map((e) => e.parent), [null, '20260929-2000-aaaa', '20260929-2001-bbbb', '20260929-2002-cccc'])
  assert.equal(imp.classifications.length, 1)
  assert.equal(imp.events[0].kind, 'launch_failed')
  assert.deepEqual(r.last_run, { id: '20260929-2004-eeee', step: 'implement' })

  const broken: unknown[] = [
    { schema: 2, chains: [], classifications: [], events: [] },
    { schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'otra', run: '20260929-2000-aaaa', parent: null, at }], terminal: null }], classifications: [], events: [] },
    { schema: 1, chains: [{ id: 'c1', entries: [], terminal: { code: 'rara', at, detail: '' } }], classifications: [], events: [] },
    { schema: 1, chains: [], classifications: [{ receipt: { id: 'x', digest }, epoch: null, at, rows: [{ row: 'V1', class: 'implementation', proposed: null, reason: '' }] }], events: [] },
    { schema: 1, chains: [], classifications: [], events: [{ kind: 'otro', at, detail: '' }] },
    { schema: 1, chains: [], classifications: [], events: [], extra: 1 },
    // El mapa de una toma se nombra por ref, y el recibo de una clasificación o de un fix, por id.
    { schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'takeover', id: 't1', parent: null, at, map: { id: 'm', digest } }], terminal: null }], classifications: [], events: [] },
    { schema: 1, chains: [], classifications: [{ receipt: { ref: 'x', digest }, epoch: null, at, rows: [] }], events: [] },
    // Un fix nombra su recibo; las demás corridas no traen uno.
    { schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'fix', run: '20260929-2000-aaaa', parent: null, at }], terminal: null }], classifications: [], events: [] },
    { schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'implement', run: '20260929-2000-aaaa', parent: null, at, receipt: { id: 'x', digest } }], terminal: null }], classifications: [], events: [] },
    // Un evento nombra su cadena con texto y su corrida con un id de corrida, sin claves de más.
    { schema: 1, chains: [], classifications: [], events: [{ kind: 'launch_failed', at, chain: 1, detail: '' }] },
    { schema: 1, chains: [], classifications: [], events: [{ kind: 'launch_failed', at, run: '../fuera', detail: '' }] },
    { schema: 1, chains: [], classifications: [], events: [{ kind: 'refused', at, detail: '', extra: true }] },
    { schema: 1, chains: [{ id: 'c1', entries: [{ kind: 'implement', run: '20260929-2000-aaaa', parent: null, base: '', at }], terminal: null }], classifications: [], events: [] },
  ]
  for (const b of broken) {
    writeFileSync(join(dir, PHASES_FILE), JSON.stringify({ schema_version: 1, last_run: null, phases: {}, implement: b }))
    assert.throws(() => readPhaseRecord(repo, 'f'), (e: unknown) => (e as { code?: string }).code === 'phases_invalid', JSON.stringify(b))
  }
})

test('consultas de cadena: status orienta por la cadena sin escribir el registro', async () => {
  const { chainFlow, chainSetup, runBin } = await import('./helpers.ts')
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'x\n' }], report: `Hecho.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: [{ id: 'T1', completion: 'done', change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'V1' }, { id: 'T2', completion: 'pending', change_kind: 'behavior_change', changed: 'no', deviation: null, check: 'V1' }] })}\n\nSTATUS: done\n` }] })
  chainFlow(s, { tasks: 2 })
  runBin(s, ['wait', runBin(s, ['sdd', 'phase', 'f']).out.id, '--max', '30'])
  const file = join(s.repo, '.plans', 'f', 'sdd-ai-phases.json')
  const before = readFileSync(file, 'utf8')
  const next = runBin(s, ['sdd', 'status', 'f']).out.next
  assert.deepEqual([next.step, next.command], ['implement', './bin/sdd-ai sdd phase f'])
  assert.match(next.detail, /sigue con T2/)
  runBin(s, ['sdd', 'status'])
  assert.equal(readFileSync(file, 'utf8'), before)
})
