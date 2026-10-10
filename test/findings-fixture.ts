import { type FindingReport } from '../src/findings.ts'
import { type SpecifyContract, type PlanContract, type TasksContract } from '../src/sdd/phase.ts'

export const FINDING: FindingReport = {
  problem: 'El lector pierde la última fila', location: 'src/reader.ts:12', expected: 'Conservar todas las filas',
  observed: 'La última fila desaparece', evidence: ['reader("a\\nb") devuelve ["a"]'], impact: 'Pérdida de datos',
  moment: null, stage: null, context: { commit: null, runtime: null, os: null, session: null, run: null, package: null },
}
export const SPECIFY: SpecifyContract = {
  phase: 'specify', known_facts: [], assumptions: [], blocking_questions: [], missing_context: [],
  acceptance_criteria: [{ id: 'AC-1', text: 'Exporta', authority: 'pedido', verification: 'Lectura' }],
  problem: 'Exportación', background: 'Pedido', scope: 'CSV',
}
export const PLAN: PlanContract = {
  phase: 'plan', assumptions: [], blocking_questions: [], missing_context: [], approach: 'Exportar', decisions: 'ninguno', files: 'src/a.ts',
  verification: { schema_version: 1, rows: [{ id: 'V1', acs: ['AC-1'], kind: 'inspection', obligation: 'none', obligation_reason: 'fixture',
    argv: ['node', '-e', 'process.exit(0)'], timeout_ms: 1000, expect: { exit_code: 0 } }] },
}
export const TASKS: TasksContract = {
  phase: 'tasks', assumptions: [], blocking_questions: [], missing_context: [],
  tasks: [{ id: 'T1', title: 'Exportar', actor: 'writer', covers: ['AC-1'], pattern: 'src/a.ts', test: 'V1', files: ['src/a.ts'], steps: ['Exportar'] }],
}
export const IMPLEMENT = { phase: 'implement', missing_context: [], tasks: [{ id: 'T1', completion: 'pending', change_kind: 'behavior_change', changed: 'Sin terminar', deviation: null, check: 'V1' }] }
export const FIX = { phase: 'fix', missing_context: [], rows: [{ id: 'V1', changed: 'Corregido', deviation: null }] }
export const report = (c: unknown): string => `${JSON.stringify(c)}\nSTATUS: done\n`
