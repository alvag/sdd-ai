// Lo común de las cadenas de writers por el binario, que están partidos por tema en `chain-cli-*.test.ts`.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChainSetup, chainFlow, chainSetup, runBin } from './helpers.ts'

// Las cadenas de writers de `implement`, de punta a punta por el binario, con el CLI falso y sus sesiones
// en directorios temporales.

export const storeOf = (s: ChainSetup, id: string) => join(s.repo, '.git', 'sdd-ai', 'runs', id)

export const controlOf = (s: ChainSetup, id: string) => JSON.parse(readFileSync(join(storeOf(s, id), 'control.json'), 'utf8'))

export const writeControl = (s: ChainSetup, id: string, c: unknown) => writeFileSync(join(storeOf(s, id), 'control.json'), JSON.stringify(c))

export const promptFile = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(file, 'Encargo de prueba.\n')
  return file
}

/** El reporte de una corrida de implement con completitud explícita, antes de la marca de fin. */
export const implReport = (done: string[], pending: string[] = []) => `Hice lo que pude.\n\n${JSON.stringify({
  phase: 'implement', missing_context: [],
  tasks: [...done.map((id) => ({ id, completion: 'done' })), ...pending.map((id) => ({ id, completion: 'pending' }))]
    .map((t) => ({ ...t, change_kind: 'behavior_change', changed: t.completion === 'done' ? 'hecho' : 'no llegué', deviation: null, check: 'V1' })),
})}\n\nSTATUS: done\n`

export const fixReport = (rows: string[]) => `Corregí.\n\n${JSON.stringify({ phase: 'fix', missing_context: [], rows: rows.map((id) => ({ id, changed: 'la suma', deviation: null })) })}\n\nSTATUS: done\n`

export const markAll = (s: ChainSetup) => {
  const file = join(s.repo, '.plans', 'f', 'tasks.md')
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'))
}

export const classesFile = (s: ChainSetup, receipt: string, rows: Array<[string, string]>) => {
  const file = join(s.repo, '.plans', 'f', `classes-${receipt}.json`)
  writeFileSync(file, JSON.stringify({ receipt, rows: rows.map(([row, c]) => ({ row, class: c, reason: 'f devuelve 3' })) }))
  return file
}

export const BUILD_ROW = (id: string, code: number) => ({
  id, acs: ['AC-1'], kind: 'build', obligation: 'none', obligation_reason: 'fixture de cadena',
  argv: [process.execPath, '-e', `process.exit(${code})`], timeout_ms: 30000, expect: { exit_code: 0 },
})

/** Un flujo con el writer inicial ya cosechado, las tasks marcadas y un recibo final rojo. */
export function redFlow(rows: unknown[], writers: object[] = []): { s: ChainSetup; receipt: string; first: string } {
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) }, ...writers] })
  chainFlow(s, { rows })
  const first = runBin(s, ['sdd', 'phase', 'f']).out.id
  runBin(s, ['wait', first, '--max', '30'])
  markAll(s)
  const red = runBin(s, ['sdd', 'verify', 'f'])
  assert.equal(red.out.green, false, JSON.stringify(red.out))
  return { s, receipt: red.out.receipt, first }
}

export const LOUD_ROW = (id: string) => ({
  id, acs: ['AC-1'], kind: 'build', obligation: 'none', obligation_reason: 'fixture de cadena',
  argv: [process.execPath, '-e', `process.stdout.write('${id}-'.repeat(3000)); process.exit(1)`], timeout_ms: 30000, expect: { exit_code: 0 },
})

export const registry = (s: ChainSetup) => JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8'))

/**
 * Un writer de fase como los de antes de las cadenas, activo al adoptar el cambio: mientras corre, su control
 * pierde el kind y el registro la clave implement; al terminar, su cosecha queda sin entries ni delta.
 */
export function legacyFlow(tasks: number, writer: object): { s: ChainSetup; run: string } {
  const go = join(mkdtempSync(join(tmpdir(), 'sdd-ai-go-')), 'seguir')
  const s = chainSetup({ writers: [{ ...writer, waitFor: go }] })
  chainFlow(s, { tasks })
  const run = runBin(s, ['sdd', 'phase', 'f']).out.id
  const control = JSON.parse(readFileSync(join(storeOf(s, run), 'control.json'), 'utf8'))
  const { flow, pending, inputs, handoff_header } = control.phase
  writeControl(s, run, { ...control, phase: { flow, pending, inputs, handoff_header } })
  const phases = join(s.repo, '.plans', 'f', 'sdd-ai-phases.json')
  const { implement: _i, ...rest } = JSON.parse(readFileSync(phases, 'utf8'))
  writeFileSync(phases, JSON.stringify(rest))
  writeFileSync(go, '')
  runBin(s, ['wait', run, '--max', '30'])
  const harvest = join(storeOf(s, run), 'harvest.json')
  const { entries: _e, delta: _d, ...old } = JSON.parse(readFileSync(harvest, 'utf8'))
  writeFileSync(harvest, JSON.stringify(old))
  return { s, run }
}

export const oldReport = (ids: string[]) => `Hice el cambio.\n\n${JSON.stringify({ phase: 'implement', missing_context: [], tasks: ids.map((id) => ({ id, change_kind: 'behavior_change', changed: 'x', deviation: null, check: 'c' })) })}\n\nSTATUS: done\n`
