import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Family, SddError } from '../types.ts'
import { type Question, renderForText } from './question.ts'

// La fuente de la prueba: el archivo que el runner escribe para la sesión que corre el comando. Todo lo
// que no sea una respuesta válida a la pregunta canónica falla cerrado.

type Env = Record<string, string | undefined>

/** Un error al listar o leer el archivo de la sesión. `prove` lo convierte en `approval_missing`. */
export class SessionReadError extends Error {}

export interface Runner { runner: Family; session: string }

/** Cuántos bytes del final del archivo se leen: la pregunta y su respuesta se hacen justo antes del comando. */
export const TAIL_BYTES = 16 * 1024 * 1024

const runnerRequired = (detail: string) => new SddError('runner_required', 'el entorno no identifica la sesión de un runner', {
  detail,
  next: 'esta decisión la tiene que tomar el usuario en la sesión del conductor: corre el comando desde la sesión de Claude Code o de Codex donde responde',
})

/**
 * El runner y la sesión de donde se lee la prueba. Con las dos señales a la vez, como en una sesión de
 * Codex abierta desde Claude Code, el flag elige; sin él no se adivina. Un worker por proceso nunca
 * identifica una sesión, aunque herede las señales.
 */
export function detectRunner(env: Env, conductor?: Family): Runner {
  if (env.SDD_AI_WORKER === '1') throw runnerRequired('el comando corre dentro de un worker de sdd-ai')
  const claude = env.CLAUDECODE === '1' && env.CLAUDE_CODE_SESSION_ID ? env.CLAUDE_CODE_SESSION_ID : undefined
  const codex = env.CODEX_THREAD_ID && env.CODEX_SESSION_ID ? env.CODEX_SESSION_ID : undefined
  if (conductor !== undefined) {
    const session = conductor === 'claude' ? claude : codex
    if (session === undefined) throw runnerRequired(`el entorno no trae la señal completa de la sesión de ${conductor}`)
    return { runner: conductor, session }
  }
  if (claude !== undefined && codex !== undefined) {
    throw new SddError('conductor_unknown', 'el entorno tiene la sesión de Claude Code y la de Codex a la vez', {
      next: 'pasa --conductor claude|codex para elegir de qué sesión se lee la respuesta del usuario',
    })
  }
  if (claude !== undefined) return { runner: 'claude', session: claude }
  if (codex !== undefined) return { runner: 'codex', session: codex }
  throw runnerRequired('faltan CLAUDECODE=1 y CLAUDE_CODE_SESSION_ID, o CODEX_THREAD_ID y CODEX_SESSION_ID')
}

const readError = (what: string, e: unknown) => new SessionReadError(`${what}: ${(e as Error).message}`)

/** Las entradas de un directorio; uno que no existe está vacío. */
function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw readError(`no se pudo listar ${dir}`, e)
  }
}

function codexRollouts(dir: string, suffix: string, out: string[]): void {
  for (const d of entries(dir)) {
    const path = join(dir, d.name)
    if (d.isDirectory()) codexRollouts(path, suffix, out)
    else if (d.name.startsWith('rollout-') && d.name.endsWith(suffix)) out.push(path)
  }
}

/**
 * El archivo de la sesión, buscado por su id. En Claude Code, solo en los subdirectorios directos de
 * `projects/`; en Codex, a cualquier profundidad bajo `sessions/`. Cero candidatos o más de uno fallan
 * cerrado: con dos no hay forma de saber cuál es el de esta sesión.
 */
export function sessionFile(env: Env, r: Runner): string {
  const home = env.HOME || homedir()
  const found: string[] = []
  let where: string
  if (r.session === '' || /[/\\]/.test(r.session)) {
    throw new SddError('approval_missing', 'no se encontró el archivo de la sesión', { detail: `el id de sesión ${JSON.stringify(r.session)} no es un nombre de archivo` })
  }
  if (r.runner === 'claude') {
    const projects = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
    where = `${projects}/*/${r.session}.jsonl`
    for (const d of entries(projects)) {
      if (!d.isDirectory()) continue
      const dir = join(projects, d.name)
      if (entries(dir).some((f) => f.name === `${r.session}.jsonl`)) found.push(join(dir, `${r.session}.jsonl`))
    }
  } else {
    const sessions = join(env.CODEX_HOME || join(home, '.codex'), 'sessions')
    where = `${sessions}/**/rollout-*-${r.session}.jsonl`
    codexRollouts(sessions, `-${r.session}.jsonl`, found)
  }
  if (found.length !== 1) {
    throw new SddError('approval_missing', 'no se encontró el archivo de la sesión', {
      detail: found.length === 0 ? `no hay ningún ${where}` : `hay ${found.length} candidatos para ${where}`,
    })
  }
  return found[0]!
}

export interface TailLine { text: string; ok: boolean; value?: unknown }

/**
 * Las líneas del final del archivo, en orden. Comprueba que sea un archivo regular antes de abrirlo, y
 * lo abre sin seguir enlaces ni bloquearse, por si cambió entre las dos cosas. La primera línea de la
 * ventana se descarta solo si la ventana empieza a mitad de una línea.
 */
export function readTail(file: string, cap: number = TAIL_BYTES): TailLine[] {
  let st
  try {
    st = lstatSync(file)
  } catch (e) {
    throw readError(`no se pudo leer ${file}`, e)
  }
  if (!st.isFile()) throw new SessionReadError(`${file} no es un archivo regular`)
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    throw readError(`no se pudo abrir ${file}`, e)
  }
  let buf: Buffer
  let start: number
  try {
    const fst = fstatSync(fd)
    if (!fst.isFile()) throw new SessionReadError(`${file} no es un archivo regular`)
    const size = fst.size
    start = Math.max(0, size - cap)
    // Un byte antes de la ventana dice si empieza en un límite de línea.
    const from = Math.max(0, start - 1)
    buf = Buffer.alloc(size - from)
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read)
      if (n === 0) break
      read += n
    }
    buf = buf.subarray(0, read)
    if (start > 0) {
      const midLine = buf[0] !== 0x0a
      buf = buf.subarray(1)
      if (midLine) {
        const nl = buf.indexOf(0x0a)
        buf = nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1)
      }
    }
  } catch (e) {
    if (e instanceof SessionReadError) throw e
    throw readError(`no se pudo leer ${file}`, e)
  } finally {
    closeSync(fd)
  }
  // Solo se omite el vacío que deja el último salto de línea: una línea con espacios no se puede interpretar.
  return buf.toString('utf8').split('\n').filter((t) => t !== '').map((text) => {
    try {
      return { text, ok: true, value: JSON.parse(text) as unknown }
    } catch {
      return { text, ok: false }
    }
  })
}

export interface Answer { ref: string; label: string | null; answered_at: string | null; index: number }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** La pregunta de un `AskUserQuestion` es la canónica si trae el mismo texto, el mismo header y las mismas opciones, con selección simple. */
function sameQuestion(v: unknown, q: Question): boolean {
  if (!isObj(v) || v.question !== q.question || v.header !== q.header) return false
  if (v.multiSelect !== undefined && v.multiSelect !== false) return false
  const opts = arr(v.options)
  return opts.length === q.options.length
    && q.options.every((o, i) => isObj(opts[i]) && opts[i].label === o.label && opts[i].description === o.description)
}

function claudeAnswers(session: string, lines: TailLine[], q: Question): Answer[] {
  const labels = q.options.map((o) => o.label)
  const qid = createHash('sha256').update(q.question).digest('hex').slice(0, 16)
  const asked = new Set<string>()
  const out: Answer[] = []
  lines.forEach((l, index) => {
    const v = l.value
    if (!isObj(v) || v.sessionId !== session || v.isSidechain === true || !isObj(v.message)) return
    const content = arr(v.message.content)
    if (v.type === 'assistant') {
      for (const b of content) {
        if (isObj(b) && b.type === 'tool_use' && b.name === 'AskUserQuestion' && typeof b.id === 'string'
          && isObj(b.input) && arr(b.input.questions).some((x) => sameQuestion(x, q))) asked.add(b.id)
      }
    } else if (v.type === 'user') {
      const result = content.find((b) => isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && asked.has(b.tool_use_id))
      if (!isObj(result) || result.is_error === true) return
      const answer = isObj(v.toolUseResult) && isObj(v.toolUseResult.answers) ? str(v.toolUseResult.answers[q.question]) : null
      if (answer === null) return
      out.push({ ref: `${result.tool_use_id as string}:${qid}`, label: labels.includes(answer) ? answer : null, answered_at: str(v.timestamp), index })
    }
  })
  return out
}

const itemText = (item: Obj) => arr(item.content).map((c) => (isObj(c) ? str(c.text) ?? '' : '')).join('')

function codexAnswers(lines: TailLine[], q: Question): Answer[] {
  const canonical = renderForText(q).trim()
  const choices = q.options.map((o, i) => ({ label: o.label, keys: [o.label.toLowerCase(), String(i + 1)] }))
  const out: Answer[] = []
  let asked = false
  lines.forEach((l, index) => {
    const v = l.value
    if (!isObj(v) || v.type !== 'event_msg' || !isObj(v.payload) || v.payload.type !== 'item_completed' || !isObj(v.payload.item)) return
    const item = v.payload.item
    if (item.type === 'AgentMessage') {
      asked = itemText(item).trim() === canonical
    } else if (item.type === 'UserMessage' && asked) {
      asked = false
      const reply = itemText(item).trim().toLowerCase()
      const label = choices.find((c) => c.keys.includes(reply))?.label ?? null
      out.push({ ref: str(item.id) ?? '', label, answered_at: str(v.timestamp), index })
    }
  })
  return out
}

/**
 * Las respuestas a la pregunta canónica, en orden. Una línea ilegible después de la última respuesta
 * falla cerrado, porque podría ser una respuesta posterior que no se puede leer.
 */
export function answersFor(r: Runner, lines: TailLine[], q: Question): Answer[] {
  const answers = r.runner === 'claude' ? claudeAnswers(r.session, lines, q) : codexAnswers(lines, q)
  const last = answers.at(-1)?.index ?? -1
  if (lines.some((l, i) => i > last && !l.ok)) {
    throw new SddError('approval_missing', 'hay una línea ilegible en el archivo de la sesión', {
      detail: 'una línea que no se puede interpretar, después de la última respuesta, podría ser una respuesta posterior',
    })
  }
  return answers
}
