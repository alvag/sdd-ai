import type { CandidateFile } from './candidate.ts'

/** La parte del diff de un archivo: su encabezado `diff --git`, sus metadatos y sus hunks. */
export interface Section { path: string; text: string }

const ESCAPES: Record<string, string> = {
  '\x07': 'a', '\b': 'b', '\t': 't', '\n': 'n', '\v': 'v', '\f': 'f', '\r': 'r', '"': '"', '\\': '\\',
}

/**
 * Cita una ruta como la cita Git con `core.quotePath=false`: entre comillas si tiene `"`, `\` o un
 * carácter de control, con sus escapes; lo que no es ASCII queda tal cual.
 */
function quote(path: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(path)) return path
  let out = ''
  for (const ch of path) {
    const code = ch.charCodeAt(0)
    if (ESCAPES[ch]) out += `\\${ESCAPES[ch]}`
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`
    else out += ch
  }
  return `"${out}"`
}

// El encabezado identifica el archivo aunque la sección no traiga `+++`: un cambio solo de modo, un
// renombre puro o un binario.
const header = (f: CandidateFile) => `diff --git ${quote(`a/${f.from ?? f.path}`)} ${quote(`b/${f.path}`)}`

/**
 * Parte el diff en una sección por archivo, en el orden del diff. Un cambio de tipo trae dos secciones
 * seguidas de la misma ruta (el borrado y el alta) y se unen. Unidas, reconstruyen el diff byte a byte.
 */
export function sections(diff: string, files: CandidateFile[]): Section[] {
  const byHeader = new Map(files.map((f) => [header(f), f.path]))
  const out: Section[] = []
  for (const text of diff.split(/(?=^diff --git )/m)) {
    if (text === '') continue
    const end = text.indexOf('\n')
    const first = end === -1 ? text : text.slice(0, end)
    const path = byHeader.get(first)
    const last = out.at(-1)
    if (path !== undefined && last?.path === path) {
      last.text += text
    } else if (path === undefined || out.some((s) => s.path === path)) {
      throw new Error(`el diff no tiene una sección por archivo: ${first}`)
    } else {
      out.push({ path, text })
    }
  }
  const missing = files.find((f) => !out.some((s) => s.path === f.path))
  if (missing) throw new Error(`el diff no tiene una sección por archivo: ${missing.path}`)
  return out
}

interface Line { text: string; kind: 'meta' | 'context' | 'added' | 'removed'; old: number; new: number }

/** Las líneas de una sección con su número de cada lado, según los contadores de cada `@@`. */
function* walk(section: string): Generator<Line> {
  let oldN = 0
  let newN = 0
  let oldLeft = 0
  let newLeft = 0
  const all = section.split('\n')
  if (all.at(-1) === '') all.pop()
  for (const text of all) {
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith('+')) {
        newLeft--
        yield { text, kind: 'added', old: 0, new: newN++ }
        continue
      }
      if (text.startsWith('-')) {
        oldLeft--
        yield { text, kind: 'removed', old: oldN++, new: 0 }
        continue
      }
      if (text.startsWith(' ')) {
        oldLeft--
        newLeft--
        yield { text, kind: 'context', old: oldN++, new: newN++ }
        continue
      }
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (m) {
      oldN = Number(m[1])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newN = Number(m[3])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
    }
    yield { text, kind: 'meta', old: 0, new: 0 }
  }
}

/**
 * La sección con su número de línea a la izquierda de `│`, en una columna de ancho fijo. Contexto y
 * agregadas llevan el del lado nuevo; en un archivo borrado, solo las quitadas, con el del lado viejo.
 */
export function numbered(section: string, deleted: boolean): string {
  const all = [...walk(section)]
  const number = (l: Line): number | undefined => {
    if (deleted) return l.kind === 'removed' ? l.old : undefined
    return l.kind === 'context' || l.kind === 'added' ? l.new : undefined
  }
  const width = String(all.reduce((max, l) => Math.max(max, number(l) ?? 0), 0)).length
  const out = all.map((l) => `${String(number(l) ?? '').padStart(width)}│${l.text}`).join('\n')
  return section.endsWith('\n') ? `${out}\n` : out
}

/** Las líneas agregadas de la sección, con su número del lado nuevo y sin el `+`. */
export function addedLines(section: string): Array<{ line: number; text: string }> {
  return [...walk(section)].filter((l) => l.kind === 'added').map((l) => ({ line: l.new, text: l.text.slice(1) }))
}
