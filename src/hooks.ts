import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './git.ts'
import { confirm, release, reserve } from './native-launch.ts'
import { type OpenRun, type OpenState, describe, openRuns, runKey } from './open-runs.ts'
import { readJson, readStatus, writeJsonAtomic } from './runs.ts'
import type { NativeProfile } from './types.ts'

export type HookCli = 'claude' | 'codex'

/** Lo que el hook lee del payload; cada CLI manda más campos y el hook no los necesita. */
export interface Payload {
  hook_event_name?: unknown; session_id?: unknown; cwd?: unknown; source?: unknown; stop_hook_active?: unknown
  tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; agent_id?: unknown
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
    if (typeof p.session_id !== 'string' || !SESSION_ID.test(p.session_id)) return ''
    if (typeof p.cwd !== 'string') return ''
    const root = repoRoot(p.cwd)
    // `existsSync` y no `runsRoot`, que lo crearía: un repo sin sdd-ai no se toca.
    if (!existsSync(join(root, '.sdd-ai'))) return ''
    switch (p.hook_event_name) {
      case 'SessionStart': return sessionStart(p, root, p.session_id)
      case 'Stop': return stop(p, root, p.session_id, cli)
      case 'PreToolUse': return preToolUse(p, root, p.session_id, cli)
      case 'PostToolUse': return postDispatch(p, root, 'confirm')
      case 'PostToolUseFailure': return postDispatch(p, root, 'release')
      default: return ''
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
 * Al retomar o compactar, el conductor recupera las corridas que dejó abiertas. Al empezar o limpiar,
 * ve en una línea las de otras sesiones, solo como dato. Una sesión bifurcada hereda el contexto de la
 * original y no recibe nada.
 */
function sessionStart(p: Payload, root: string, session: string): string {
  const runs = openRuns(root)
  if (p.source === 'resume' || p.source === 'compact') {
    const own = runs.filter((r) => r.session === session)
    return own.length === 0 ? '' : context('SessionStart', ownRuns(own))
  }
  if (p.source === 'startup' || p.source === 'clear') {
    const others = runs.filter((r) => r.session !== session)
    if (others.length === 0) return ''
    const list = others.map((r) => `${r.id} (${OPEN_LABEL[r.open]})`).join(', ')
    return context('SessionStart', `Corridas de sdd-ai abiertas en otras sesiones, solo como dato: ${list}`)
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
 * Reabre el turno una vez por conjunto de corridas abiertas propias. El recordatorio se guarda antes
 * de imprimirlo: si no se puede guardar, calla, porque recordar dos veces lo mismo es peor que perder
 * un recordatorio.
 */
function stop(p: Payload, root: string, session: string, cli: HookCli): string {
  if (p.stop_hook_active === true) return ''
  const own = openRuns(root).filter((r) => r.session === session)
  if (own.length === 0) return ''
  const file = join(root, '.sdd-ai', 'hooks', `${session}.json`)
  const seen = reminded(file)
  const keys = own.map(runKey)
  if (keys.every((k) => seen.has(k))) return ''
  try {
    mkdirSync(join(root, '.sdd-ai', 'hooks'), { recursive: true })
    writeJsonAtomic(file, { reminded: [...new Set([...seen, ...keys])] })
  } catch {
    return ''
  }
  const reason = ownRuns(own)
  return cli === 'claude' ? context('Stop', reason) : JSON.stringify({ decision: 'block', reason })
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
  if (p.tool_name === 'Bash') return guardShell(p)
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
 * Parte un comando de shell en tramos por `&&`, `||`, `;`, `|` y el salto de línea, solo donde el
 * separador está fuera de comillas y sin escapar: `echo "a; sdd-ai run"` es un solo tramo.
 */
function shellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (escaped) {
      current += c
      escaped = false
      continue
    }
    // Entre comillas simples la barra no escapa nada.
    if (c === '\\' && quote !== "'") {
      current += c
      escaped = true
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      segments.push(current)
      current = ''
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += c
  }
  segments.push(current)
  return segments
}

const RUN_COMMANDS = new Set(['run', 'review', 'wait', 'cancel'])

/** Si el tramo invoca `sdd-ai`, una ruta que termina en `bin/sdd-ai` o `node <ruta>/bin/sdd-ai`, con uno de los comandos de corridas. */
function invokesRuns(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/)
  if (tokens[0] === 'node') tokens.shift()
  const [bin, command] = tokens
  return (bin === 'sdd-ai' || (bin ?? '').endsWith('bin/sdd-ai')) && RUN_COMMANDS.has(command ?? '')
}

/**
 * Dentro de un subagente, un comando de shell no lanza ni toca corridas: esas son del conductor. Es
 * una guarda para el caso honesto; una variable o un script intermedio la esquivan.
 */
function guardShell(p: Payload): string {
  if (typeof p.agent_id !== 'string' || p.agent_id === '') return ''
  const command = isRecord(p.tool_input) ? p.tool_input.command : undefined
  if (typeof command !== 'string') return ''
  return shellSegments(command).some(invokesRuns) ? deny('un worker no delega ni toca las corridas del conductor') : ''
}

