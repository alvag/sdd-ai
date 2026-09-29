import { parse } from 'yaml'
import { sha256 } from '../review/candidate.ts'

export interface TaskCount { total: number; done: number; firstPending: string | null }
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
  return { total, done, firstPending }
}

/** Lo que se lee de la línea de una task con la gramática de la plantilla de `sdd-flow`. */
export interface TaskLine { done: boolean; id: string; title: string; covers: string[] }

const TASK_BODY = /^(\*\*)?(T\d+) — (.+?)\1(?:[ \t]+·[ \t]+cubre:[ \t]*(.*))?$/
const CRITERION = /^[-*+][ \t]+\*\*(AC-\d+):\*\*/

/**
 * `- [ ] **T<n> — <título>**  · cubre: AC-1, AC-2`, con o sin negrita y con o sin la cobertura. `null`
 * si la línea no es un checkbox de primer nivel o si lo es y no cumple la gramática.
 */
export function parseTaskLine(line: string): TaskLine | null {
  const m = TASK.exec(line)
  const b = m ? TASK_BODY.exec(m[2].trim()) : null
  if (!m || !b) return null
  const covers = b[4] === undefined ? [] : b[4].split(',').map((c) => c.trim()).filter((c) => c !== '')
  return { done: m[1] !== ' ', id: b[2], title: b[3], covers }
}

/** Las líneas que `countTasks` cuenta, en orden, con su marca y lo que la gramática de task lee de cada una. */
export function taskLines(text: string): { text: string; done: boolean; task: TaskLine | null }[] {
  return scan(splitLines(text)).flatMap((l) => {
    const m = l.fenced ? null : TASK.exec(l.text)
    return m ? [{ text: l.text, done: m[1] !== ' ', task: parseTaskLine(l.text) }] : []
  })
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
