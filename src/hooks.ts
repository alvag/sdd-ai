import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { type FlowBinding, countTool, markBootstrap, readBinding, setBinding, startTrail } from './backstop.ts'
import { type CommitTarget, bindingCommand, commitTargets, invokesBinding } from './commands.ts'
import { type JiraMode, loadJiraMode } from './config.ts'
import { repoRoot } from './git.ts'
import { confirm, release, reserve } from './native-launch.ts'
import { type OpenRun, type OpenState, describe, openRuns, runKey } from './open-runs.ts'
import { renderBootstrap } from './route.ts'
import { ensureIgnore, readJson, readStatus, writeJsonAtomic } from './runs.ts'
import { requestPublication } from './projection.ts'
import { withPhaseNext } from './sdd/phase-state.ts'
import { type ListEntry, listFlows, lstatOrNull, readFlow } from './sdd/read.ts'
import { restoreIntentOpen } from './sdd/restore.ts'
import { type FlowStatus, type Reason, type Step, headerData, resolve } from './sdd/status.ts'
import { isNotifierOperational } from './notification.ts'
import { shellSegments } from './shell.ts'
import type { NativeProfile } from './types.ts'

export type HookCli = 'claude' | 'codex'

/** Lo que el hook lee del payload; cada CLI manda más campos, que pasan tal cual al contador. */
export interface Payload {
  hook_event_name?: unknown; session_id?: unknown; cwd?: unknown; source?: unknown; stop_hook_active?: unknown
  tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; agent_id?: unknown; transcript_path?: unknown
  [campo: string]: unknown
}

const MAX_PAYLOAD = 1024 * 1024
/** El `session_id` termina en una ruta: nada que pueda salir del directorio de hooks. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Responde un evento de hook de Claude Code o de Codex con el stdout que hay que imprimir; `''` es
 * silencio. Un error nunca niega una herramienta ni reabre un turno: ante cualquier fallo, silencio.
 */
export function runHook(stdin: string, cli: HookCli): string {
  try {
    if (Buffer.byteLength(stdin) > MAX_PAYLOAD) return ''
    const payload = JSON.parse(stdin) as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ''
    const p = payload as Payload
    const validSession = typeof p.session_id === 'string' && SESSION_ID.test(p.session_id)
    // Sin una sesión válida no hay liga posible, pero la regla de Jira vale igual para un commit.
    if (!validSession && !(p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash')) return ''
    if (typeof p.cwd !== 'string') return ''
    const root = repoRoot(p.cwd)
    // `existsSync` y no `runsRoot`, que lo crearía: un repo sin sdd-ai no se toca.
    if (!existsSync(join(root, '.sdd-ai'))) return ''
    if (typeof p.session_id !== 'string' || !validSession) return guardCommit(p, root, null)
    try {
      ensureIgnore(join(root, '.sdd-ai'))
    } catch {
      if (p.hook_event_name === 'PreToolUse') return preToolUse(p, root, p.session_id, cli)
      if (p.hook_event_name === 'PostToolUse' || p.hook_event_name === 'PostToolUseFailure') {
        try {
          postDispatch(p, root, p.hook_event_name === 'PostToolUse' ? 'confirm' : 'release')
        } catch {
          // Confirmar o liberar el despacho no depende del estado del hook.
        }
      }
      return ''
    }
    // El rastro empieza con el primer evento que ve de la sesión, también si abrió antes de los hooks.
    const via = p.hook_event_name === 'SessionStart' ? `SessionStart:${String(p.source)}` : String(p.hook_event_name)
    startTrail(root, p.session_id, via)
    try {
      switch (p.hook_event_name) {
        case 'SessionStart': return sessionStart(p, root, p.session_id)
        case 'Stop': return stop(p, root, p.session_id, cli)
        case 'PreToolUse': return preToolUse(p, root, p.session_id, cli)
        case 'PostToolUse': return postToolUse(p, root, p.session_id, cli)
        case 'PostToolUseFailure': return postToolUseFailure(p, root, p.session_id)
        default: return ''
      }
    } finally {
      // Lo que dejó el evento (ligas, despachos nativos) se publica en otro proceso, sin cambiar la respuesta del hook.
      requestPublication(root, `hook:${String(p.hook_event_name)}`, 'hook')
    }
  } catch {
    return ''
  }
}

const OPEN_LABEL: Record<OpenState, string> = {
  running: 'corriendo',
  undelivered: 'terminada sin entregar',
  native_pending: 'nativa sin lanzar',
  native_unconfirmed: 'nativa con reserva sin confirmar',
  review_pending: 'revisión con hallazgos por decidir',
}

const ownRuns = (runs: OpenRun[]) => ['Corridas de sdd-ai abiertas en esta sesión:', ...runs.map((r) => `- ${describe(r)}`)].join('\n')

function context(event: string, additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })
}

/**
 * El bootstrap de la ruta directa, seguido de la lista de corridas y la de flujos, en una sola salida.
 * Una sesión bifurcada hereda el contexto de la original y no recibe nada.
 */
function sessionStart(p: Payload, root: string, session: string): string {
  const text = [bootstrap(p, root, session), runList(p, root, session), flowList(p, root, session)].filter(Boolean).join('\n\n')
  return text === '' ? '' : context('SessionStart', text)
}

const bootstrapText = (jira: JiraMode) => renderBootstrap(undefined, undefined, jira.mode, jira.mode === 'invalid' ? jira.detail : undefined)

/**
 * Al empezar, limpiar o compactar, el contexto anterior ya no está y el bootstrap vuelve. Una sesión
 * retomada conserva el contexto de su arranque con el mismo `session_id`, así que lo recibe solo si
 * nunca lo tuvo, como una que abrió antes de estos hooks.
 */
function bootstrap(p: Payload, root: string, session: string): string {
  if (p.source === 'startup' || p.source === 'clear' || p.source === 'compact') {
    markBootstrap(root, session)
    return bootstrapText(loadJiraMode(root))
  }
  if (p.source === 'resume') return markBootstrap(root, session) ? '' : bootstrapText(loadJiraMode(root))
  return ''
}

const FLOW_SOURCES = ['startup', 'clear', 'resume', 'compact']

/** Los bloqueos que dicen que el estado del flujo no se pudo leer, y no que el flujo esté trabado. */
const READ_ERRORS = new Set(['artifact_unreadable', 'approvals_invalid', 'header_invalid'])
const readErrors = (reasons: Reason[]) => reasons.filter((r) => READ_ERRORS.has(r.code))

function flowLine(e: ListEntry, boundId: string | null): string {
  // Sin profundidad y bloqueado es un flujo que no se pudo leer entero: el nombre o el enlace.
  const errors = e.depth === null && e.blocked ? e.blocked_reasons : readErrors(e.blocked_reasons)
  if (errors.length > 0) return `- ${e.id}: no se pudo leer (${errors.map((r) => r.detail).join('; ')})`
  const gate = e.next.gate ? ` ${e.next.gate}` : ''
  const phase = e.next.command ?? e.next.detail
  return `- ${e.id} (${e.depth ?? 'sin profundidad'}): ${e.next.step}${gate}${phase ? ` · ${phase}` : ''}${e.id === boundId ? ' · ligado a esta sesión' : ''}`
}

/** Una línea por flujo activo de `.plans/`, con el ligado marcado. Los directorios sin artefactos no son flujos. */
function flowList(p: Payload, root: string, session: string): string {
  if (!FLOW_SOURCES.includes(String(p.source))) return ''
  let entries: ListEntry[]
  try {
    entries = listFlows(root).filter((e) => e.next.step !== 'no_artifacts').map((e) => ({ ...e, next: withPhaseNext(root, e.id, e) }))
  } catch (e) {
    return `Flujos SDD en .plans/: no se pudieron listar (${errorText(e)})`
  }
  if (entries.length === 0) return ''
  const binding = readBinding(root, session)
  const boundId = binding !== null && binding !== 'unreadable' ? binding.id : null
  return ['Flujos SDD en .plans/:', ...entries.map((e) => flowLine(e, boundId))].join('\n')
}

/**
 * Al retomar o compactar, el conductor recupera las corridas que dejó abiertas. Al empezar o limpiar,
 * ve en una línea las de otras sesiones, solo como dato.
 */
function runList(p: Payload, root: string, session: string): string {
  const runs = openRuns(root)
  if (p.source === 'resume' || p.source === 'compact') {
    const own = runs.filter((r) => r.session === session)
    return own.length === 0 ? '' : ownRuns(own)
  }
  if (p.source === 'startup' || p.source === 'clear') {
    const others = runs.filter((r) => r.session !== session)
    if (others.length === 0) return ''
    const list = others.map((r) => `${r.id} (${OPEN_LABEL[r.open]})`).join(', ')
    return `Corridas de sdd-ai abiertas en otras sesiones, solo como dato: ${list}`
  }
  return ''
}

function reminded(file: string): Set<string> {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { reminded?: unknown }
    return new Set(Array.isArray(saved.reminded) ? saved.reminded.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Reabre el turno con lo que haya que recordar: las corridas abiertas propias y el paso del flujo
 * ligado, en una sola salida. Cada recordatorio se guarda antes de imprimirlo, y si no se puede guardar
 * calla, porque recordar dos veces lo mismo es peor que perder un recordatorio.
 */
function stop(p: Payload, root: string, session: string, cli: HookCli): string {
  if (p.stop_hook_active === true) return ''
  if (cli === 'claude' && isNotifierOperational(root, 'claude', session, Date.now())) return ''
  const reason = [runsReminder(root, session), flowReminder(root, session)].filter(Boolean).join('\n\n')
  if (reason === '') return ''
  return cli === 'claude' ? context('Stop', reason) : JSON.stringify({ decision: 'block', reason })
}

/** Las corridas abiertas propias, una vez por conjunto. */
function runsReminder(root: string, session: string): string {
  const own = openRuns(root).filter((r) => r.session === session)
  if (own.length === 0) return ''
  const file = join(root, '.sdd-ai', 'hooks', `${session}.json`)
  const seen = reminded(file)
  const keys = own.map(runKey)
  if (keys.every((k) => seen.has(k))) return ''
  try {
    ensureIgnore(join(root, '.sdd-ai'))
    mkdirSync(join(root, '.sdd-ai', 'hooks'), { recursive: true })
    writeJsonAtomic(file, { reminded: [...new Set([...seen, ...keys])] })
  } catch {
    return ''
  }
  return ownRuns(own)
}

/**
 * La liga de la sesión con el estado de su flujo. `null` sin liga, o después de soltarla porque el
 * flujo terminó (`status: done` en el plan) o su directorio ya no está; `'unreadable'` si el estado de
 * la sesión no se lee. Lanza si el flujo no se puede leer o si no se pudo soltar la liga.
 */
function boundFlow(root: string, session: string): { binding: FlowBinding; status: FlowStatus } | null | 'unreadable' {
  const binding = readBinding(root, session)
  if (binding === null || binding === 'unreadable') return binding
  const gone = lstatOrNull(join(root, '.plans', binding.id)) === null
  const read = gone ? null : readFlow(root, binding.id)
  if (read === null || headerData(read.facts.planHeader)?.status === 'done') {
    if (!setBinding(root, session, null)) throw new Error(`no se pudo soltar la liga con el flujo ${binding.id}`)
    return null
  }
  return { binding, status: resolve(read.facts) }
}

/**
 * El paso del flujo ligado, una vez por cambio de paso o de gate; otra task no cuenta. La referencia
 * nueva se guarda antes de recordarla, y si no se puede guardar calla: así Codex no reabre el turno
 * por el mismo cambio en cada `Stop`.
 */
function flowReminder(root: string, session: string): string {
  try {
    const flow = boundFlow(root, session)
    if (flow === null || flow === 'unreadable') return ''
    const { binding, status } = flow
    const gate = status.next.gate ?? null
    if (binding.step === status.next.step && binding.gate === gate) return ''
    if (!setBinding(root, session, { id: binding.id, step: status.next.step, gate, at: new Date().toISOString() })) return ''
    return `Flujo ${binding.id}: el paso siguiente es ${status.next.step}${gate ? ` (gate ${gate})` : ''}; ` +
      `corre ./bin/sdd-ai sdd status ${binding.id} para ver qué sigue`
  } catch {
    return ''
  }
}

/**
 * La herramienta con la que cada CLI lanza un subagente: `Agent` en Claude Code y `spawn_agent` en
 * Codex. La v2 de `spawn_agent` vive en el namespace `collaboration` y llega al hook con ese prefijo.
 */
const SPAWN_AGENT_V2 = 'collaborationspawn_agent'
const DISPATCH_TOOLS = new Set(['Agent', 'spawn_agent', SPAWN_AGENT_V2])
const AGENT_PREFIX = 'sdd-ai-'
/**
 * Una cita del encargo de una corrida. `prompt.md.bak` o `prompt.md/otra` no cuentan; un punto que
 * cierra la oración sí, como en el mensaje canónico.
 */
const CITATION = /\.sdd-ai\/runs\/([^/\s"'`]+)\/prompt\.md(?![\w/-]|\.[\w/-])/g

type Input = Record<string, unknown>

const isRecord = (v: unknown): v is Input => typeof v === 'object' && v !== null && !Array.isArray(v)
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function preToolUse(p: Payload, root: string, session: string, cli: HookCli): string {
  if (p.tool_name === 'Bash') return guardCommit(p, root, session) || guardShell(p)
  if (typeof p.tool_name !== 'string' || !DISPATCH_TOOLS.has(p.tool_name) || !isRecord(p.tool_input)) return ''
  const type = p.tool_input.subagent_type ?? p.tool_input.agent_type
  if (typeof type !== 'string' || !type.startsWith(AGENT_PREFIX)) return ''
  return guardDispatch(p, root, session, cli)
}

const deny = (reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `sdd-ai: ${reason}` } })

const allow = (updatedInput: Input) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } })

/** Todo el texto del input, en cualquier campo: el mensaje, el prompt o los textos de `items`. */
function texts(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) texts(x, out)
  else if (isRecord(v)) for (const x of Object.values(v)) texts(x, out)
  return out
}

/** `Agent` de Claude Code solo acepta el alias del modelo: `claude-sonnet-5` viaja como `sonnet`. */
function claudeModel(model: string): string {
  return /^claude-(opus|sonnet|haiku|fable)(-|$)/.exec(model)?.[1] ?? model
}

/**
 * El input del despacho, armado desde cero: ningún campo del original llega al agente. Codex lanza
 * sin el historial del conductor; `spawn_agent` v2 no acepta `fork_context`, y su `message` llega
 * cifrado por la API: no se puede leer ni reemplazar, así que pasa tal cual.
 */
function rewrite(cli: HookCli, v2: boolean, original: Input, native: NativeProfile, id: string, promptFile: string): Input {
  const message = `Tu encargo está en ${promptFile}. Léelo completo y cúmplelo.`
  if (cli === 'claude') {
    const input: Input = { subagent_type: native.agent, description: `sdd-ai ${native.role} ${id}`, prompt: message }
    if (native.model) input.model = claudeModel(native.model)
    if (typeof original.run_in_background === 'boolean') input.run_in_background = original.run_in_background
    return input
  }
  const slug = (v: string) => v.replace(/[^a-z0-9]/g, '_')
  if (v2 && typeof original.message !== 'string') throw new Error('el despacho no trae mensaje')
  const input: Input = v2
    ? { agent_type: native.agent, task_name: `sdd_ai_${slug(native.role)}_${slug(id)}`, message: original.message, fork_turns: 'none' }
    : { agent_type: native.agent, message, fork_context: false }
  if (native.model) input.model = native.model
  if (native.effort) input.reasoning_effort = native.effort
  return input
}

/**
 * Liga un despacho de `sdd-ai-<rol>` a su corrida: la nativa sin lanzar de esta sesión, de ese rol y
 * de la familia de este CLI, citada por su `prompt_file` o, si no hay cita, la única que haya. Reserva
 * la corrida para este `tool_use_id` y reescribe el input. A diferencia del resto de los hooks, acá un
 * error niega: dejar pasar el despacho lanzaría un agente sin corrida. `beforeReserve` corre entre la
 * elección y la reserva, donde una cancelación concurrente puede caer.
 */
export function guardDispatch(p: Payload, root: string, session: string, cli: HookCli, beforeReserve: (dir: string) => void = () => {}): string {
  const input = isRecord(p.tool_input) ? p.tool_input : {}
  const type = String(input.subagent_type ?? input.agent_type)
  if (typeof p.agent_id === 'string' && p.agent_id !== '') {
    return deny('un subagente no despacha agentes sdd-ai-*: responde tu encargo sin delegar')
  }
  let runs: OpenRun[]
  try {
    runs = openRuns(root)
  } catch (e) {
    return deny(`no se pudieron listar las corridas: ${errorText(e)}`)
  }
  try {
    const runsDir = join(root, '.sdd-ai', 'runs')
    const eligible = runs
      .filter((r) => r.kind === 'native' && r.open === 'native_pending' && r.session === session)
      .map((r) => ({ id: r.id, native: readJson<NativeProfile>(join(runsDir, r.id, 'native.json')) }))
      .filter((r) => r.native.family === cli && r.native.agent === type)
    // En v2 el mensaje va cifrado: no hay citas que leer.
    const v2 = p.tool_name === SPAWN_AGENT_V2 || 'task_name' in input
    const cited = v2 ? [] : [...new Set(texts(input).flatMap((t) => [...t.matchAll(CITATION)].map((m) => m[1])))]
    const role = type.slice(AGENT_PREFIX.length)
    if (eligible.length === 0) {
      const reserved = unconfirmed(runs, runsDir, session, cli, type)
      if (reserved.length > 0) return deny(unconfirmedReason(reserved, cited[0], type))
    }
    if (cited.length > 1) return deny(`el mensaje cita más de una corrida (${cited.join(', ')}): cita solo el prompt_file de la que despachas`)
    let chosen = eligible[0]
    if (cited.length === 1) {
      const match = eligible.find((r) => r.id === cited[0])
      if (!match) return deny(`la corrida ${cited[0]} no se puede despachar: no es una nativa sin lanzar ni reservar de esta sesión para ${type}`)
      chosen = match
    } else if (eligible.length !== 1) {
      if (eligible.length === 0) {
        return deny(`no hay una corrida nativa sin lanzar de esta sesión para ${type}: corre ./bin/sdd-ai run --role ${role} --prompt-file <encargo> y despacha lo que devuelva`)
      }
      if (v2) {
        const ids = eligible.map((r) => r.id).join(', ')
        return deny(`hay ${eligible.length} corridas sin lanzar para ${type} (${ids}) y en spawn_agent v2 el mensaje va cifrado, así que no se puede citar una: cancela las que no vas a despachar con ./bin/sdd-ai cancel <id> y vuelve a despachar`)
      }
      const files = eligible.map((r) => join(runsDir, r.id, 'prompt.md')).join(', ')
      return deny(`hay ${eligible.length} corridas sin lanzar para ${type}; cita el prompt_file de la que despachas: ${files}`)
    }
    const dir = join(runsDir, chosen.id)
    const updatedInput = rewrite(cli, v2, input, chosen.native, chosen.id, join(dir, 'prompt.md'))
    if (typeof p.tool_use_id !== 'string' || p.tool_use_id === '') return deny('el despacho no trae tool_use_id y no se puede reservar la corrida')
    beforeReserve(dir)
    if (!reserve(dir, p.tool_use_id)) return deny(`la corrida ${chosen.id} ya tiene un despacho reservado`)
    if (readStatus(dir).state === 'cancelled') {
      release(dir, p.tool_use_id)
      return deny(`la corrida ${chosen.id} se canceló`)
    }
    return allow(updatedInput)
  } catch (e) {
    return deny(`no se pudo preparar el despacho: ${errorText(e)}`)
  }
}

/**
 * Las nativas de esta sesión, de este agente y de la familia de este CLI con un despacho reservado sin
 * confirmar. Nadie sabe si su agente llegó a lanzarse, y eso lo decide el usuario, no otro `run`.
 */
function unconfirmed(runs: OpenRun[], runsDir: string, session: string, cli: HookCli, type: string): OpenRun[] {
  return runs.filter((r) => {
    if (r.kind !== 'native' || r.open !== 'native_unconfirmed' || r.session !== session) return false
    const native = readJson<NativeProfile>(join(runsDir, r.id, 'native.json'))
    return native.family === cli && native.agent === type
  })
}

/** Nombra las reservadas, primero la citada, cada una con lo que sigue, y advierte el riesgo de duplicar. */
function unconfirmedReason(reserved: OpenRun[], cited: string | undefined, type: string): string {
  const first = reserved.find((r) => r.id === cited)
  const ordered = first ? [first, ...reserved.filter((r) => r !== first)] : reserved
  const head = ordered.length === 1
    ? `la corrida ${ordered[0].id} de esta sesión para ${type} tiene un despacho reservado sin confirmar`
    : `hay ${ordered.length} corridas de esta sesión para ${type} con un despacho reservado sin confirmar`
  const items = ordered.map((r) => `${r.id}: ${r.next}`).join('; ')
  return `${head}, y no se sabe si su agente llegó a lanzarse. Sigue, para ${items}. ` +
    '`cancel` solo cambia el registro local de sdd-ai: si el agente sí se lanzó, reintentar puede lanzar otro agente con el mismo encargo'
}

/**
 * Primero confirma el despacho, como siempre; después liga la sesión si el comando lo pide, y al final
 * cuenta la herramienta para el recordatorio de sesión larga, que ya ve la liga. Un error de cualquiera
 * de los tres no cambia lo que hicieron los otros.
 */
function postToolUse(p: Payload, root: string, session: string, cli: HookCli): string {
  let out = ''
  try {
    out = postDispatch(p, root, 'confirm')
  } catch {
    // Un despacho que no se pudo confirmar sigue sin confirmar, igual que antes del contador.
  }
  if (out !== '') return out
  const text = [bind(p, root, session), countTool(p, root, session, cli, undefined, undefined, () => loadJiraMode(root))]
    .filter(Boolean).join('\n\n')
  return text === '' ? '' : context('PostToolUse', text)
}

/**
 * Claude Code avisa por acá un despacho o un comando de shell que falló. El despacho se libera; el
 * comando liga igual que uno que terminó bien, y no se cuenta, como hasta ahora.
 */
function postToolUseFailure(p: Payload, root: string, session: string): string {
  try {
    postDispatch(p, root, 'release')
  } catch {
    // Un despacho que no se pudo liberar queda reservado sin confirmar, como antes.
  }
  const warning = bind(p, root, session)
  return warning === '' ? '' : context('PostToolUseFailure', warning)
}

/**
 * Liga la sesión al flujo de un `sdd start <id> --apply`, `sdd branch <id> --apply`, `sdd status <id>`, `sdd approve <id> <gate>` o `sdd phase <id>` del
 * conductor en el primer tramo, con el paso de ese momento como referencia de `Stop`, termine como termine el comando.
 * Un flujo que no se puede leer o sin artefactos no cambia la liga. Devuelve el aviso si no se pudo
 * guardar, o `''`.
 */
function bind(p: Payload, root: string, session: string): string {
  try {
    if (p.tool_name !== 'Bash' || (typeof p.agent_id === 'string' && p.agent_id !== '')) return ''
    const command = isRecord(p.tool_input) ? p.tool_input.command : undefined
    const binding = typeof command === 'string' ? bindingCommand(command) : undefined
    if (!binding) return ''
    const { next } = resolve(readFlow(root, binding.id).facts)
    if (next.step === 'no_artifacts') return ''
    if (setBinding(root, session, { id: binding.id, step: next.step, gate: next.gate ?? null, at: new Date().toISOString() })) return ''
    return `sdd-ai: no se pudo guardar la liga con el flujo ${binding.id}. Hasta que se guarde, Stop no recuerda su paso y la guarda ` +
      `del commit no lo tiene en cuenta. Vuelve a correr ./bin/sdd-ai sdd status ${binding.id}.`
  } catch {
    return ''
  }
}

/**
 * Confirma o libera la reserva del despacho con este `tool_use_id`. Claude Code avisa el fallo con
 * `PostToolUseFailure`; Codex solo corre `PostToolUse` tras un éxito, así que ahí un fallo deja la
 * reserva sin confirmar.
 */
function postDispatch(p: Payload, root: string, action: 'confirm' | 'release'): string {
  if (typeof p.tool_name !== 'string' || !DISPATCH_TOOLS.has(p.tool_name) || typeof p.tool_use_id !== 'string') return ''
  const runsDir = join(root, '.sdd-ai', 'runs')
  for (const id of readdirSync(runsDir)) {
    try {
      const dir = join(runsDir, id)
      if (action === 'confirm' ? confirm(dir, p.tool_use_id) : release(dir, p.tool_use_id)) break
    } catch {
      // Una corrida ilegible no es la del despacho.
    }
  }
  return ''
}

/**
 * Los comandos del conductor que un subagente no corre: los de corridas, `prune` y `recall`. `sdd start`, `sdd branch`, `sdd approve`,
 * `sdd phase`, `sdd verify` y `sdd commit` se suman aparte, porque `sdd status` sí lo puede correr un worker.
 */
const CONDUCTOR_COMMANDS = new Set(['run', 'review', 'wait', 'cancel', 'prune', 'recall'])
const CONDUCTOR_SDD = new Set(['start', 'branch', 'approve', 'phase', 'verify', 'commit'])

/**
 * Si el tramo invoca `sdd-ai`, una ruta que termina en `bin/sdd-ai` o `node <ruta>/bin/sdd-ai`, con uno
 * de los comandos de corridas, con `prune`, con `recall`, con `sdd start`, con `sdd branch`, con `sdd approve`, con `sdd phase`, con
 * `sdd verify` o con `sdd commit`.
 */
function invokesConductorCommand(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/)
  if (tokens[0] === 'node') tokens.shift()
  const [bin, command, sub] = tokens
  if (bin !== 'sdd-ai' && !(bin ?? '').endsWith('bin/sdd-ai')) return false
  return CONDUCTOR_COMMANDS.has(command ?? '') || (command === 'sdd' && CONDUCTOR_SDD.has(sub ?? ''))
}

/**
 * Dentro de un subagente, un comando de shell no lanza ni toca corridas, ni aprueba un gate, ni lanza
 * una fase, ni verifica: todo eso es del conductor. Es una guarda para el caso honesto; una variable o un script intermedio la
 * esquivan.
 */
function guardShell(p: Payload): string {
  if (typeof p.agent_id !== 'string' || p.agent_id === '') return ''
  const command = isRecord(p.tool_input) ? p.tool_input.command : undefined
  if (typeof command !== 'string') return ''
  return shellSegments(command).some(invokesConductorCommand) ? deny('un worker no delega ni toca las corridas del conductor') : ''
}


/** Desde estos pasos el commit pasa: el flujo está para commitear, o ya commiteó. */
const COMMIT_STEPS: readonly Step[] = ['review_and_commit', 'push', 'open_pr', 'archive']
const USER_COMMITS = 'el commit lo hace el usuario desde su terminal'

/** Si el destino es este repositorio: su raíz Git, por ruta real, es la de este árbol. Sin raíz, no se sabe. */
function isHere(target: CommitTarget, here: string): boolean | 'unknown' {
  if ('unknown' in target) return 'unknown'
  try {
    return realpathSync(repoRoot(target.dir)) === here
  } catch {
    return 'unknown'
  }
}

function jiraDenial(jira: JiraMode): string {
  const rule = 'con jira_approval en on todo cambio del proyecto va por un flujo SDD'
  if (jira.mode === 'invalid') {
    return deny(`la config de Jira no se puede leer (${jira.detail}), y hasta corregirla rige lo mismo que con jira_approval en on: ` +
      `todo cambio del proyecto va por un flujo SDD; ${USER_COMMITS}`)
  }
  return deny(`${rule}: liga la sesión con ./bin/sdd-ai sdd status <id> del flujo, o ${USER_COMMITS}`)
}

/**
 * La guarda de `git commit` en el shell del runner, del conductor o de un subagente. Solo mira un
 * commit a este repositorio o de destino desconocido. Una cadena que también liga se niega. Con liga,
 * el commit pasa desde `review_and_commit`; sin liga, lo decide la regla de Jira. Tiene su propio
 * `try`, porque el de `runHook` calla y dejaría pasar el commit: con liga, o con Jira activo o
 * ilegible, un error niega.
 */
export function guardCommit(p: Payload, root: string, session: string | null): string {
  const command = isRecord(p.tool_input) ? p.tool_input.command : undefined
  if (typeof command !== 'string' || typeof p.cwd !== 'string') return ''
  const targets = commitTargets(command, p.cwd)
  if (targets.length === 0) return ''
  try {
    const here = realpathSync(root)
    const places = targets.map((t) => isHere(t, here))
    if (!places.some((h) => h !== false)) return ''
    // Con una restauración de verify pendiente, el árbol puede tener archivos revertidos a la base.
    if (restoreIntentOpen(root)) {
      return deny('sdd verify dejó una restauración pendiente y el árbol puede tener archivos revertidos: corre ./bin/sdd-ai sdd status para que se resuelva, y después el commit')
    }
    if (invokesBinding(command)) {
      return deny('este comando liga un flujo y hace git commit en la misma cadena: corre sdd status o sdd approve y el commit por separado, ' +
        'porque el commit no se puede decidir con una liga que todavía no existe')
    }
    const flow = session === null ? null : boundFlow(root, session)
    if (flow === 'unreadable') {
      return deny(`el estado de esta sesión no se puede leer y no se sabe si conduce un flujo SDD: ${USER_COMMITS}, o se arregla el estado en .sdd-ai/hooks/route/`)
    }
    if (flow !== null) {
      const { binding, status } = flow
      const where = `la sesión conduce el flujo ${binding.id}, con el paso siguiente en ${status.next.step}`
      if (status.next.step === 'no_artifacts') {
        return deny(`${where}: el flujo ya no tiene artefactos y su estado no se puede leer; ${USER_COMMITS}, o se arregla el flujo`)
      }
      const errors = readErrors(status.blocked_reasons)
      if (errors.length > 0) {
        return deny(`${where}, y su estado no se puede leer (${errors.map((r) => r.detail).join('; ')}): ${USER_COMMITS}, o se arregla el flujo`)
      }
      if (places.includes('unknown')) {
        return deny(`${where}, y no se puede saber a qué repositorio va este git commit (un cd previo, o un -C o --git-dir que no es una ruta literal): ${USER_COMMITS}`)
      }
      if (!COMMIT_STEPS.includes(status.next.step)) {
        return deny(`${where}: el commit va desde review_and_commit, y si hace falta antes, ${USER_COMMITS}`)
      }
      return ''
    }
    const jira = loadJiraMode(root)
    return jira.mode === 'off' ? '' : jiraDenial(jira)
  } catch (e) {
    const binding = session === null ? null : readBinding(root, session)
    if (binding !== null) {
      const which = binding === 'unreadable' ? '' : ` ${binding.id}`
      return deny(`no se pudo leer el estado del flujo ligado${which} (${errorText(e)}): ${USER_COMMITS}, o se arregla el flujo`)
    }
    try {
      const jira = loadJiraMode(root)
      return jira.mode === 'off' ? '' : jiraDenial(jira)
    } catch {
      return deny(`no se pudo comprobar la regla de Jira para este commit (${errorText(e)}): ${USER_COMMITS}`)
    }
  }
}
