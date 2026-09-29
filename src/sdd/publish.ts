import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadJiraMode } from '../config.ts'
import { currentBranch, headCommit } from '../git.ts'
import { freezeStableWith } from '../review/candidate.ts'
import { SddError } from '../types.ts'
import { type DocumentContract, type DocumentStep, type PlanHeader, localIso, renderPlan, renderSpec, renderTasks } from './phase.ts'
import { withFlowLock } from './phase-state.ts'
import { FILE_NAMES, type FlowRead, artifactHash, bytesHash, flowDir, headerHash, lstatOrNull, readFlow } from './read.ts'
import { type Step, resolve } from './status.ts'

/**
 * Lo que una corrida de fase congeló al lanzarse y la publicación vuelve a comparar: el paso y la
 * profundidad, la huella de cada insumo, la del header del handoff y, en `plan`, los valores del header
 * de `plan.md`. `created_at` se fija al escribir.
 */
export interface FrozenLaunch {
  flow: string; step: DocumentStep; depth: 'normal' | 'completa'
  /** `sha256:` de los bytes de cada insumo congelado: el pedido, la spec, el plan y el contexto. */
  inputs: Record<string, string>
  handoff_header: string
  plan_header?: Omit<PlanHeader, 'created_at'>
  /** Las rutas originales de `--request` y `--context`, para releerlas al publicar. */
  request_path?: string; context_path?: string
  /** Una ampliación: en `specify`, el pedido es la copia que guardó la primera corrida y no se relee. */
  amended: boolean
}

export type PublishCause = 'artifact_exists' | 'inputs_changed' | 'step_changed' | 'candidate_blocked' | 'write_failed'
export type PublishOutcome = { kind: 'published'; artifact: string } | { kind: 'not_published'; cause: PublishCause; detail: string }

const ARTIFACT_OF: Record<DocumentStep, 'spec' | 'plan' | 'tasks'> = { specify: 'spec', plan: 'plan', tasks: 'tasks' }
const PHASE_ORDER: readonly Step[] = ['specify', 'plan', 'tasks', 'implement']

/** La huella de los bytes de un archivo, o `unreadable` si no se puede leer. */
export function fileHash(path: string): string {
  try {
    return bytesHash(readFileSync(path))
  } catch {
    return 'unreadable'
  }
}

/**
 * Lo que una corrida congela al lanzarse, sobre la lectura del flujo que hizo: las huellas de la spec y
 * el plan que la fase usa, las de los bytes de `--request` y `--context` ya leídos y la del header del
 * handoff.
 */
export function freezeLaunch(read: FlowRead, o: {
  step: DocumentStep; depth: 'normal' | 'completa'; amended: boolean
  request?: { path: string; bytes: Buffer }; context?: { path: string; bytes: Buffer }; plan_header?: Omit<PlanHeader, 'created_at'>
}): FrozenLaunch {
  const inputs: Record<string, string> = {}
  if (o.step !== 'specify') inputs.spec = artifactHash(read, 'spec')
  if (o.step === 'tasks') inputs.plan = artifactHash(read, 'plan')
  if (o.request) inputs.request = bytesHash(o.request.bytes)
  if (o.context) inputs.context = bytesHash(o.context.bytes)
  return {
    flow: read.facts.id, step: o.step, depth: o.depth, inputs, handoff_header: headerHash(read.facts.handoffHeader),
    ...(o.plan_header ? { plan_header: o.plan_header } : {}),
    ...(o.request ? { request_path: o.request.path } : {}), ...(o.context ? { context_path: o.context.path } : {}), amended: o.amended,
  }
}

const notPublished = (cause: PublishCause, detail: string): PublishOutcome => ({ kind: 'not_published', cause, detail })

/** El primer insumo que ya no es el que se congeló, o `null` si todos siguen iguales. */
function changedInput(root: string, launch: FrozenLaunch, read: FlowRead): string | null {
  const now: Record<string, string> = {}
  if (launch.step !== 'specify') now.spec = artifactHash(read, 'spec')
  if (launch.step === 'tasks') now.plan = artifactHash(read, 'plan')
  if (launch.step === 'specify' && !launch.amended && launch.request_path !== undefined) now.request = fileHash(launch.request_path)
  if (launch.context_path !== undefined) now.context = fileHash(launch.context_path)
  for (const [name, hash] of Object.entries(now)) {
    if (launch.inputs[name] !== hash) return `cambió el insumo ${name} desde que se lanzó la fase`
  }
  if (headerHash(read.facts.handoffHeader) !== launch.handoff_header) return 'cambió el header de handoff.md desde que se lanzó la fase'
  if (launch.plan_header) {
    const branch = currentBranch(root)
    if (branch !== launch.plan_header.branch) return `la rama cambió: era ${launch.plan_header.branch} y es ${branch ?? 'un HEAD separado'}`
    const head = headCommit(root)
    if (head !== launch.plan_header.base_commit) return `HEAD cambió: era ${launch.plan_header.base_commit} y es ${head ?? 'ninguno'}`
  }
  return null
}

function render(launch: FrozenLaunch, c: DocumentContract, now: Date): string {
  if (c.phase === 'specify') return renderSpec(c)
  if (c.phase === 'tasks') return renderTasks(c)
  if (!launch.plan_header) throw new Error('una publicación de plan necesita su header congelado')
  return renderPlan(c, { ...launch.plan_header, created_at: localIso(now) })
}

/**
 * Escribe el artefacto de una fase solo si nada cambió desde que se lanzó: el mismo paso y la misma
 * profundidad, los mismos insumos y un candidato con el que el flujo avanza sin bloqueos. Con el lock del
 * flujo tomado, lo escribe en un temporal del mismo directorio y lo enlaza al nombre final, que falla si
 * ya existe: el archivo aparece entero o no aparece, y nunca pisa ni sigue un enlace. `then` corre dentro
 * del mismo lock con el resultado, para registrarlo sin que otro comando se meta en el medio.
 */
export function publishPhase(root: string, launch: FrozenLaunch, contract: DocumentContract, now: Date = new Date(),
  then?: (outcome: PublishOutcome) => void): PublishOutcome {
  const artifact = ARTIFACT_OF[launch.step]
  const name = FILE_NAMES[artifact]
  const decide = (): PublishOutcome => {
    const jira = loadJiraMode(root)
    let read: FlowRead
    try {
      read = freezeStableWith(root, launch.flow, (r, id) => readFlow(r, id, jira), (r) => JSON.stringify(r.digests))
    } catch (e) {
      if (e instanceof SddError) return notPublished('inputs_changed', e.message)
      throw e
    }
    const status = resolve(read.facts)
    if (status.depth !== launch.depth || status.next.step !== launch.step) {
      return notPublished('step_changed', `se lanzó ${launch.step} en ${launch.depth} y ahora el flujo está en ${status.next.step} en ${status.depth ?? 'ninguna profundidad'}`)
    }
    const changed = changedInput(root, launch, read)
    if (changed !== null) return notPublished('inputs_changed', changed)

    const text = render(launch, contract, now)
    const after = resolve(readFlow(root, launch.flow, jira, { artifact, text }).facts)
    const advanced = after.next.step === 'gate' || PHASE_ORDER.indexOf(after.next.step) > PHASE_ORDER.indexOf(launch.step)
    if (after.blocked_reasons.length > 0 || !advanced) {
      const why = after.blocked_reasons.length > 0 ? after.blocked_reasons.map((r) => `${r.code}: ${r.detail}`).join('; ') : `el flujo quedaría en ${after.next.step}`
      return notPublished('candidate_blocked', `con el ${name} armado el flujo no avanza sin bloqueos: ${why}`)
    }

    // Justo antes de escribir, ni `.plans/` ni el flujo pueden haberse vuelto enlaces.
    const dir = flowDir(root, launch.flow)
    const dest = join(dir, name)
    if (lstatOrNull(dest) !== null) return notPublished('artifact_exists', `${name} apareció mientras corría la fase`)
    const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      writeFileSync(tmp, text, { flag: 'wx' })
      linkSync(tmp, dest)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && lstatOrNull(dest) !== null) {
        return notPublished('artifact_exists', `${name} apareció mientras corría la fase`)
      }
      return notPublished('write_failed', `no se pudo escribir ${name}: ${(e as Error).message}`)
    } finally {
      rmSync(tmp, { force: true })
    }
    return { kind: 'published', artifact: `.plans/${launch.flow}/${name}` }
  }
  // Un error al tomar el lock no escribió nada; uno de `then` sí puede venir después de publicar, y sube.
  let locked = false
  try {
    return withFlowLock(root, launch.flow, () => {
      locked = true
      let outcome: PublishOutcome
      try {
        outcome = decide()
      } catch (e) {
        // El flujo desapareció o dejó de ser legible: ya no está en el paso que se lanzó.
        if (!(e instanceof SddError)) throw e
        outcome = notPublished('step_changed', e.message)
      }
      then?.(outcome)
      return outcome
    })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (!locked && (e instanceof SddError || code === 'EACCES' || code === 'EPERM' || code === 'EROFS')) {
      return notPublished('write_failed', `no se pudo tomar el flujo para escribir ${name}: ${(e as Error).message}`)
    }
    throw e
  }
}
