import { parse } from 'yaml'
import { sha256 } from '../review/candidate.ts'
import { SddError } from '../types.ts'

/** `firstPending` es el texto de la primera task pendiente tras su checkbox; `firstPendingId`, su `T<n>`, o `null` si no cumple la gramática. */
export interface TaskCount { total: number; done: number; firstPending: string | null; firstPendingId: string | null }
export type HeaderResult = { ok: true; data: Record<string, unknown>; body: string } | { ok: false; detail: string }
export type SectionState = 'absent' | 'empty' | 'present'

/** Una línea con lo que importa de ella: si está en un bloque cercado, la cerca incluida, y si es un heading. */
interface Line { text: string; fenced: boolean; level: number; title: string }

/** Las secciones que `sdd-flow` escribe en el plan después de aprobarlo: no entran en su huella. */
const EXCLUDED = ['Verify', 'Extras (fuera de AC)']
const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/
const TASK = /^(?:[-*+]|\d+[.)])[ \t]+\[( |x|X)\](?=\s|$)[ \t]*(.*)$/
const DONE_MARK = /^((?:[-*+]|\d+[.)])[ \t]+\[)[xX](?=\](?:\s|$))/

const splitLines = (text: string) => text.split(/\r\n|\r|\n/)

/**
 * CR y CRLF pasan a LF, cada línea pierde sus espacios finales y se quita un salto final: que el
 * archivo termine o no con uno no cambia el texto. Una línea vacía agregada sí lo cambia.
 */
export function normalize(text: string): string {
  return splitLines(text).map((l) => l.trimEnd()).join('\n').replace(/\n$/, '')
}

/**
 * Un bloque cercado abre con tres o más `` ` `` o `~` y cierra con el mismo carácter, al menos la misma
 * cantidad y nada más en la línea. Uno que no cierra llega hasta el final, como en CommonMark; `open` es
 * el índice de la línea que lo abrió, o `null` si todas cerraron.
 */
function scanFences(lines: string[]): { lines: Line[]; open: number | null } {
  let fence: { char: string; length: number } | null = null
  let open: number | null = null
  const out = lines.map((text, i) => {
    const marks = FENCE.exec(text)?.[1]
    if (fence) {
      if (marks && marks[0] === fence.char && marks.length >= fence.length && text.trim() === marks) {
        fence = null
        open = null
      }
      return { text, fenced: true, level: 0, title: '' }
    }
    if (marks) {
      fence = { char: marks[0], length: marks.length }
      open = i
      return { text, fenced: true, level: 0, title: '' }
    }
    const h = HEADING.exec(text)
    return { text, fenced: false, level: h ? h[1].length : 0, title: h ? h[2] : '' }
  })
  return { lines: out, open }
}

const scan = (lines: string[]): Line[] => scanFences(lines).lines

/** `[desde, hasta)` de la sección `## <title>`: su heading y lo que sigue hasta el próximo `##` o `#`. */
function sectionRange(lines: Line[], title: string, from = 0): [number, number] | null {
  const start = lines.findIndex((l, i) => i >= from && l.level === 2 && l.title === title)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !(lines[end].level === 1 || lines[end].level === 2)) end++
  return [start, end]
}

export function readHeader(text: string): HeaderResult {
  const lines = splitLines(text)
  if (lines[0]?.trim() !== '---') return { ok: false, detail: 'no tiene header: la primera línea no es ---' }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (close < 0) return { ok: false, detail: 'el header no cierra: falta la línea --- que lo termina' }
  let data: unknown
  try {
    data = parse(lines.slice(1, close).join('\n'), { uniqueKeys: true })
  } catch (e) {
    return { ok: false, detail: `el header no es YAML válido: ${(e as Error).message.split('\n')[0]}` }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, detail: 'el header no es un mapa de claves' }
  }
  return { ok: true, data: data as Record<string, unknown>, body: lines.slice(close + 1).join('\n') }
}

/** El contenido de `## <title>`, sin su heading; `null` si no hay un heading así fuera de las cercas. */
export function section(body: string, title: string): string | null {
  const lines = scan(splitLines(body))
  const r = sectionRange(lines, title)
  return r ? lines.slice(r[0] + 1, r[1]).map((l) => l.text).join('\n') : null
}

/**
 * El texto con la sección `## <title>` reemplazada por `body`, o agregada al final si no está. Lo que hay
 * antes y después de esa sección queda igual.
 */
export function replaceSection(text: string, title: string, body: string): string {
  const raw = splitLines(text)
  const r = sectionRange(scan(raw), title)
  const block = [`## ${title}`, '', ...splitLines(body.replace(/\n+$/, ''))]
  if (!r) return `${text.replace(/\n*$/, '')}\n\n${block.join('\n')}\n`
  const after = raw.slice(r[1])
  return [...raw.slice(0, r[0]), ...block, ...(after.length > 0 && after.some((l) => l !== '') ? ['', ...after] : [''])].join('\n')
}

/** El texto con la línea `status` del header reemplazada; sin header o sin esa línea es un error. */
export function setHeaderStatus(text: string, status: string): string {
  const raw = splitLines(text)
  const close = raw[0]?.trim() === '---' ? raw.findIndex((l, i) => i > 0 && l.trim() === '---') : -1
  const at = close < 0 ? -1 : raw.findIndex((l, i) => i > 0 && i < close && /^status:/.test(l))
  if (at < 0) throw new Error('el plan no tiene una línea status en su header')
  raw[at] = `status: ${status}`
  return raw.join('\n')
}

/** Una task es un checkbox de primer nivel, sin sangría y fuera de las cercas; un anidado es texto. */
export function countTasks(text: string): TaskCount {
  let total = 0
  let done = 0
  let firstPending: string | null = null
  for (const l of scan(splitLines(text))) {
    const m = l.fenced ? null : TASK.exec(l.text)
    if (!m) continue
    total++
    if (m[1] === ' ') firstPending ??= m[2].trim()
    else done++
  }
  return { total, done, firstPending, firstPendingId: firstPending === null ? null : (TASK_BODY.exec(firstPending)?.[2] ?? null) }
}

/** Los actores de una task: la única lista, de la que salen el tipo, el lector y la admisión del contrato. */
export const TASK_ACTORS = ['writer', 'conductor', 'user'] as const
export type TaskActor = typeof TASK_ACTORS[number]
/** Lo que se lee de la línea de una task con la gramática de la plantilla de `sdd-flow`. */
export interface TaskLine { done: boolean; id: string; title: string; covers: string[]; actor?: TaskActor }
export interface TaskAssignment { id: string; title: string; actor: TaskActor | null }
export interface TaskActorError { line: number; id: string | null; detail: string }
export interface TaskResponsibilities {
  hasExplicitActors: boolean; pendingAssignments: TaskAssignment[]; writerPending: string[]
  inlinePending: string[]; actorErrors: TaskActorError[]
}

const TASK_BODY = /^(\*\*)?(T\d+) — (.+?)\1(?:[ \t]+·[ \t]+cubre:[ \t]*(.*))?$/
const CRITERION = /^[-*+][ \t]+\*\*(AC-\d+):\*\*/

/**
 * `- [ ] **T<n> — <título>**  · cubre: AC-1, AC-2`, con o sin negrita y con o sin la cobertura. `null`
 * si la línea no es un checkbox de primer nivel o si lo es y no cumple la gramática.
 */
export function parseTaskLine(line: string): TaskLine | null {
  return readTaskLine(line).task
}

/** La línea en negrita con metadatos después del cierre: el título llega hasta el último `**`, como en `TASK_BODY`. */
const BOLD_TASK = /^\*\*(T\d+) — (.+)\*\*(.*)$/
/** Lo que sigue al primer cierre de la negrita: si ahí hay un `· actor:`, la línea declara actor aunque no se lea. */
const AFTER_FIRST_BOLD = /^\*\*(T\d+) — .+?\*\*(.*)$/
const DECLARES_ACTOR = /[ \t]·[ \t]+actor:/
/** El valor de un metadato `<clave>: <valor>`. */
const metaValue = (part: string, key: 'actor' | 'cubre') => part.slice(key.length + 1).trim()

/**
 * Lee una línea de task. El actor solo se declara como metadato de la gramática en negrita, después del cierre del
 * título; sin esa declaración la línea se lee con la gramática anterior, así que una task heredada conserva su lectura.
 * Una declaración repetida, vacía o desconocida no es una task: se diagnostica con su id.
 */
function readTaskLine(line: string): { task: TaskLine | null; explicit: boolean; error?: string; id?: string } {
  const m = TASK.exec(line)
  if (!m) return { task: null, explicit: false }
  const bold = BOLD_TASK.exec(m[2].trim())
  const metadata = bold ? bold[3].split(/[ \t]+·[ \t]+/) : []
  const actors = metadata.slice(1).filter((part) => part.startsWith('actor:'))
  if (bold && actors.length > 0) {
    if (actors.length > 1) return { task: null, explicit: true, id: bold[1], error: 'actor repetido' }
    const actor = metaValue(actors[0], 'actor')
    if (!(TASK_ACTORS as readonly string[]).includes(actor)) return { task: null, explicit: true, id: bold[1], error: 'actor vacío o desconocido' }
    if (metadata[0].trim() !== '' || metadata.slice(1).some((part) => !/^(actor|cubre):/.test(part))) {
      return { task: null, explicit: true, id: bold[1], error: 'metadato fuera de la gramática junto a la declaración de actor' }
    }
    const covers = metadata.slice(1).find((part) => part.startsWith('cubre:'))
    return { explicit: true, task: { done: m[1] !== ' ', id: bold[1], title: bold[2], actor: actor as TaskActor,
      covers: covers === undefined ? [] : metaValue(covers, 'cubre').split(',').map((c) => c.trim()).filter((c) => c !== '') } }
  }
  // Un `**` después de los metadatos hace que el título codicioso se trague la declaración: no se lee como heredada.
  const first = AFTER_FIRST_BOLD.exec(m[2].trim())
  if (first && DECLARES_ACTOR.test(first[2])) return { task: null, explicit: true, id: first[1], error: 'actor fuera de los metadatos de la línea' }
  const b = TASK_BODY.exec(m[2].trim())
  if (!b) return { task: null, explicit: false }
  const covers = b[4] === undefined ? [] : b[4].split(',').map((c) => c.trim()).filter((c) => c !== '')
  return { explicit: false, task: { done: m[1] !== ' ', id: b[2], title: b[3], covers } }
}

/** Las líneas de `taskLines`, con su número (desde 1) y la lectura del actor. */
function taskEntries(text: string): { text: string; done: boolean; task: TaskLine | null; line: number; explicit: boolean; actorError?: TaskActorError }[] {
  return scan(splitLines(text)).flatMap((l, i) => {
    const m = l.fenced ? null : TASK.exec(l.text)
    if (!m) return []
    const read = readTaskLine(l.text)
    return [{ text: l.text, done: m[1] !== ' ', task: read.task, line: i + 1, explicit: read.explicit,
      ...(read.error ? { actorError: { line: i + 1, id: read.id ?? null, detail: read.error } } : {}) }]
  })
}

/** Las líneas que `countTasks` cuenta, en orden, con su marca y lo que la gramática de task lee de cada una. */
export function taskLines(text: string): { text: string; done: boolean; task: TaskLine | null }[] {
  return taskEntries(text).map(({ text, done, task }) => ({ text, done, task }))
}

/**
 * Quién hace cada task pendiente. Una task sin actor declarado lleva `actor: null` y se trata como del writer para
 * seleccionar ejecución; las líneas que no cumplen la gramática quedan para atención inline, y las de actor inválido,
 * como errores con su línea dentro de `text`.
 */
export function readTaskResponsibilities(text: string): TaskResponsibilities {
  const lines = taskEntries(text)
  // Un id repetido no se puede proyectar al encargo del writer: sus pendientes quedan para atención inline.
  const ids = lines.flatMap((l) => (l.task ? [l.task.id] : []))
  const repeated = new Set(ids.filter((id, i) => ids.indexOf(id) !== i))
  const delegable = (l: (typeof lines)[number]) => l.task !== null && !repeated.has(l.task.id)
  const pendingAssignments = lines.flatMap((l) => !l.done && l.task && delegable(l) ? [{ id: l.task.id, title: l.task.title, actor: l.task.actor ?? null }] : [])
  return { hasExplicitActors: lines.some((l) => l.explicit), pendingAssignments,
    writerPending: pendingAssignments.filter((t) => t.actor === null || t.actor === 'writer').map((t) => t.id),
    inlinePending: lines.filter((l) => !l.done && !delegable(l) && !l.actorError).map((l) => l.text),
    actorErrors: lines.flatMap((l) => l.actorError ? [l.actorError] : []) }
}

/** Proyecta bloques completos sin cambiar el artefacto que se usa para las huellas. */
export function projectTaskBlocks(text: string, ids: readonly string[]): string {
  const lines = scan(splitLines(text))
  const blocks = new Map<string, string[]>()
  for (let start = 0; start < lines.length; start++) {
    const l = lines[start]
    const task = l.fenced ? null : parseTaskLine(l.text)
    if (!task) continue
    let end = start + 1
    while (end < lines.length && (lines[end].fenced || (!TASK.test(lines[end].text) && lines[end].level === 0))) end++
    const block = lines.slice(start, end).map((line) => line.text).join('\n').trimEnd()
    blocks.set(task.id, [...(blocks.get(task.id) ?? []), block])
  }
  for (const id of ids) {
    if (blocks.get(id)?.length !== 1) {
      throw new SddError('task_projection_invalid', `la task ${id} está ausente o repetida en tasks.md: no se puede armar el encargo del writer`,
        { next: 'corrige tasks.md, vuelve a aprobar el gate de las tasks y consulta ./bin/sdd-ai sdd status' })
    }
  }
  return `# Tasks\n\n${[...blocks].filter(([id]) => ids.includes(id)).map(([, found]) => found[0]).join('\n\n')}\n`
}

/** Los `AC-<n>` de los ítems `- **AC-<n>:**` de primer nivel dentro de `## Criterios de aceptación`, en orden. */
export function criteriaIds(spec: string): string[] {
  const lines = scan(splitLines(spec))
  const r = sectionRange(lines, 'Criterios de aceptación')
  if (!r) return []
  return lines.slice(r[0] + 1, r[1]).filter((l) => !l.fenced).map((l) => CRITERION.exec(l.text)?.[1]).filter((id) => id !== undefined)
}

/**
 * Lo que impide admitir una prosa: un heading de cualquier nivel, fuera de las cercas, cuyo título es
 * uno de `reserved`, y una cerca que no cierra, que se tragaría lo que el binario escribe después.
 */
export function proseProblems(text: string, reserved: readonly string[]): string[] {
  const { lines, open } = scanFences(splitLines(text))
  const problems = lines
    .filter((l) => !l.fenced && l.level > 0 && reserved.includes(l.title.replace(/(?:^|[ \t]+)#+$/, '').trimEnd()))
    .map((l) => `la prosa trae el título reservado ${JSON.stringify(l.text.trim())}`)
  if (open !== null) problems.push(`la prosa deja una cerca sin cerrar en su línea ${open + 1}`)
  return problems
}

const unmark = (l: Line): Line => (l.fenced ? l : { ...l, text: l.text.replace(DONE_MARK, '$1 ') })

const fingerprint = (text: string) => `sha256:${sha256(normalize(text))}`

/** El cuerpo del plan: sin el header, que `sdd-flow` reescribe en cada paso. */
function planLines(plan: string): Line[] {
  const h = readHeader(plan)
  return scan(splitLines(normalize(h.ok ? h.body : plan)))
}

/**
 * Quita las secciones excluidas. Si quedan al final, se llevan las líneas vacías que las separaban
 * del resto; en el medio, el separador queda. Así, agregar `## Verify` al final no cambia la huella.
 */
function withoutExcluded(lines: Line[]): string {
  const drop = lines.map(() => false)
  for (const title of EXCLUDED) {
    for (let r = sectionRange(lines, title); r; r = sectionRange(lines, title, r[1])) {
      for (let i = r[0]; i < r[1]; i++) drop[i] = true
    }
  }
  let end = lines.length
  while (end > 0 && drop[end - 1]) end--
  if (end < lines.length) {
    while (end > 0 && lines[end - 1].text === '') drop[--end] = true
  }
  return lines.filter((_, i) => !drop[i]).map((l) => l.text).join('\n')
}

export function specFingerprint(spec: string): string {
  return fingerprint(spec)
}

export function planFingerprint(plan: string): string {
  return fingerprint(withoutExcluded(planLines(plan)))
}

/** Las marcas de las tasks cambian al implementar: se neutralizan para que marcarlas no venza el gate. */
export function tasksFingerprint(tasks: string): string {
  return fingerprint(scan(splitLines(tasks)).map((l) => unmark(l).text).join('\n'))
}

/** El documento único de `corta`: como el plan, y con las marcas de su `## Tasks` neutralizadas. */
export function singleFingerprint(plan: string): string {
  const lines = planLines(plan)
  const r = sectionRange(lines, 'Tasks')
  return fingerprint(withoutExcluded(r ? lines.map((l, i) => (i > r[0] && i < r[1] ? unmark(l) : l)) : lines))
}

/** Compone huellas ya calculadas, nunca texto: cambiar cualquiera de las partes cambia la compuesta. */
export function combinedFingerprint(parts: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.keys(parts).sort().map((k) => [k, parts[k]]))
  return `sha256:${sha256(JSON.stringify(sorted))}`
}
