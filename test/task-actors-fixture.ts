import { spawnSync } from 'node:child_process'
import { after } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type TaskActor } from '../src/sdd/markdown.ts'
import { type FrozenLaunch, freezeLaunch } from '../src/sdd/publish.ts'
import { readFlow } from '../src/sdd/read.ts'
import { codexLaunch } from '../src/workers/codex.ts'
import { type ChainSetup, approveFlowGates, chainFlow, chainSetup, runBin } from './helpers.ts'
export { controlOf, registry, writeControl, legacyFlow, oldReport } from './chain-cli-fixture.ts'
export { runBin, fakeCalls, fakePrompts, approveFlowGates } from './helpers.ts'
export type { ChainSetup } from './helpers.ts'
export { verifyFlow, approveAll, answered, asyncCode, final, MANUAL_ROW } from './sdd-verify-fixture.ts'

/** Los directorios temporales del fixture: se borran al terminar el archivo de prueba que lo importa. */
const temps: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
after(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

export interface ActorTask { id: string; actor?: TaskActor; done?: boolean }
export const taskText = (tasks: ActorTask[]) => '# Tasks\n\n' + tasks.map((t) =>
  `- [${t.done ? 'x' : ' '}] **${t.id} — Acción ${t.id}**${t.actor ? `  · actor: ${t.actor}` : ''}  · cubre: AC-1\n`
  + '  - **Patrón:** src/a.ts:1\n  - **Prueba:** V1\n  - **Archivos:** `src/a.ts`\n  - **Pasos:**\n    1. Acción sintética\n').join('\n')
export const tasksPath = (s: ChainSetup) => join(s.repo, '.plans', 'f', 'tasks.md')
export function actorFlow(tasks: ActorTask[], writers: object[] = []): ChainSetup {
  const s = chainSetup({ bins: ['codex'], families: '[codex]', writers })
  chainFlow(s, { tasks: tasks.length })
  writeFileSync(tasksPath(s), taskText(tasks))
  approveFlowGates(s.repo)
  return s
}
/** Un reporte de implement; `legacyContract` lo arma sin `completion`, como los writers anteriores a ese campo. */
export const implementationReport = (done: string[], pending: string[] = [], missing: string[] = [], o: { legacyContract?: boolean } = {}) => JSON.stringify({
  phase: 'implement', missing_context: missing, tasks: [...done.map((id) => ({ id, completion: 'done' })), ...pending.map((id) => ({ id, completion: 'pending' }))]
    .map((t) => ({ id: t.id, ...(!o.legacyContract ? { completion: t.completion } : {}), change_kind: 'behavior_change', changed: 'Terminé según la prosa', deviation: null, check: 'V1' })),
}) + '\nSTATUS: done\n'
export const writer = (report: string, content = 'export const f = () => 2\n') => ({ actions: [{ write: 'src/a.ts', content }], report })
export const launch = (s: ChainSetup, ...args: string[]) => runBin(s, ['sdd', 'phase', 'f', ...args])
export const harvest = (s: ChainSetup, run: string) => runBin(s, ['wait', run, '--max', '30'])
export const mark = (s: ChainSetup, ids: string[]) => {
  const text = readFileSync(tasksPath(s), 'utf8').split('\n').map((line) => ids.some((id) => line.startsWith(`- [ ] **${id} —`)) ? line.replace('[ ]', '[x]') : line).join('\n')
  writeFileSync(tasksPath(s), text)
}
export const signalFile = () => join(tempDir('task-actors-signal-'), 'go')
/** Un contrato de tasks; `actors: false` lo arma como el contrato anterior a task_actors. */
export const documentContract = (o: { actors?: boolean; missing?: string[] } = {}) => ({ phase: 'tasks', findings: [], assumptions: [], blocking_questions: [], missing_context: o.missing ?? [],
  tasks: ['writer', 'conductor', 'user'].map((actor, i) => ({ id: `T${i + 1}`, title: `Acción ${i + 1}`, ...(o.actors !== false ? { actor } : {}), covers: ['AC-1'], pattern: 'src/a.ts:1', test: 'V1', files: ['src/a.ts'], steps: ['Acción sintética'] })) })
/**
 * Un flujo en el paso tasks cuyas corridas documentales responden, en orden, con `answers`: el Codex falso las lee de
 * `FAKE_ANSWERS` en modo `scripted`. No lleva guiones de writer: ninguna corrida documental es un writer.
 */
export function documentFlow(answers: string[]): ChainSetup {
  const s = actorFlow([{ id: 'T1' }])
  const file = join(tempDir('task-actors-doc-'), 'answers.json')
  writeFileSync(file, JSON.stringify(answers))
  Object.assign(s.env, { FAKE_MODE: 'scripted', FAKE_ANSWERS: file })
  rmSync(tasksPath(s))
  const approvals = join(s.repo, '.plans', 'f', 'sdd-ai-approvals.json')
  const log = JSON.parse(readFileSync(approvals, 'utf8'))
  log.approvals = log.approvals.filter((a: { gate: string }) => a.gate !== 'tasks')
  writeFileSync(approvals, JSON.stringify(log))
  const plan = join(s.repo, '.plans', 'f', 'plan.md')
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('status: tasks-ready', 'status: plan-approved'))
  return s
}
/** Lo que deja una corrida documental sintética: el resultado de la fase, el lanzamiento congelado, sus argumentos y métricas. */
export interface SupervisedDocument {
  result: { outcome: string } & Record<string, unknown>
  launch: FrozenLaunch
  argv: { phase: FrozenLaunch & { root: string } } & Record<string, unknown>
  metrics: { attempts: { kind: string }[] } & Record<string, unknown>
}
let supervised = 0
/**
 * Corrida documental sintética con el supervisor real y solo Codex falso. `legacyContract` congela la versión anterior
 * a task_actors. `recover` baja el plazo a 1 s para que venza ante la respuesta `__hang__` del Codex falso y el
 * supervisor reanude la sesión; sin él, el plazo de 10 s alcanza para una respuesta inmediata. Cada llamada usa un id de
 * corrida propio, con la forma `AAAAMMDD-HHMM-xxxx` de las corridas, para poder invocarla varias veces sobre el mismo flujo.
 */
export function superviseDocument(s: ChainSetup, o: { legacyContract?: boolean; recover?: boolean } = {}): SupervisedDocument {
  const dir = join(s.repo, '.sdd-ai', 'runs', `20261009-1200-${(supervised++).toString(16).padStart(4, '0')}`)
  mkdirSync(dir, { recursive: true })
  const frozen = freezeLaunch(readFlow(s.repo, 'f'), { step: 'tasks', depth: 'completa', amended: false, criteria: ['AC-1'] })
  if (o.legacyContract) delete frozen.task_actors
  const prompt = join(dir, 'prompt.md')
  writeFileSync(prompt, 'Encargo documental sintético\n')
  // resume_sec y grace_ms son los mínimos que dejan reanudar y cerrar al Codex falso sin alargar la prueba.
  const deadline = o.recover ? 1 : 10
  const resume = 5
  const argv = { family: 'codex', deadline_sec: deadline, resume_sec: resume, grace_ms: 100, kind: 'phase', phase: { ...frozen, root: s.repo },
    launch: codexLaunch({ cwd: s.repo, promptFile: prompt, resultFile: join(dir, 'result.md'), sessionId: 'fixture' }) }
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(frozen))
  writeFileSync(join(dir, 'argv.json'), JSON.stringify(argv))
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ state: 'running' }))
  const module = pathToFileURL(join(import.meta.dirname, '..', 'src', 'supervisor.ts')).href
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { supervise } from ${JSON.stringify(module)}; await supervise(process.argv[1])`, dir],
    // El tope por llamada sigue al plazo de la corrida, para que un supervisor colgado falle con su diagnóstico dentro de la fila.
    { cwd: s.repo, env: s.env, encoding: 'utf8', timeout: (deadline + resume + 10) * 1000 })
  if (r.status !== 0) throw new Error(`supervisor sintético: status ${r.status}, señal ${r.signal}, error ${r.error?.message ?? 'ninguno'}: ${r.stderr}`)
  return { result: JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8')),
    launch: JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8')), argv: JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')),
    metrics: JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8')) }
}
/** Reemplaza la cosecha entera: mezclarla con la vigente arrastraría claves de un caso anterior. */
export function alterHarvest(s: ChainSetup, run: string, record: Record<string, unknown>): void {
  writeFileSync(join(s.repo, '.git', 'sdd-ai', 'runs', run, 'harvest.json'), JSON.stringify(record))
}
