import { type Candidate, type CandidateFile, type ReplacedHunk, replacedHunks } from './candidate.ts'
import { addedLines, sections } from './diff.ts'
import type { ChangedRanges } from './ledger.ts'

export type RiskLevel = 'normal' | 'high'
export type RiskSignal = 'path' | 'shell' | 'executable' | 'process'
export interface RiskReason { signal: RiskSignal; path: string; detail: string }
export interface Risk { level: RiskLevel; reasons: RiskReason[] }
/** El nivel congelado en la corrida: el que corre, el que dio el clasificador y si se subió a mano. */
export interface RiskRecord { level: RiskLevel; classified: RiskLevel; reasons: RiskReason[]; forced: boolean }

/** Una corrida anterior a la clasificación no la trae: se lee como `normal`. */
export function readRisk(req: { risk?: RiskRecord }): RiskRecord {
  return req.risk ?? { level: 'normal', classified: 'normal', reasons: [], forced: false }
}

const HOT_SEGMENTS = new Set(['auth', 'security', 'update', 'webhook', 'payments'])
const SHELL = /\.(?:sh|bash|zsh)$/
const NO_MODE = '000000'
// Léxica y conservadora: cuenta en comentarios y strings. Los bordes dejan fuera `regex.exec(` y
// `os.execlpe(`, y dejan dentro `exec(` y `shell_exec(`.
const PROCESS = /^#!|(?<![\p{L}\p{N}_.])(?:child_process|subprocess|execute_process|execFileSync|execFile|execSync|exec|spawnSync|spawn)(?![\p{L}\p{N}_])|getRuntime\(\)\.exec\(|ProcessBuilder|os\.system\(|posix_spawn|proc_open\(|shell_exec\(|passthru\(|popen\(|Process\.Start\(|os\.exec(?:lp|vp|le|ve|l|v)\(/u
const ORDER: readonly RiskSignal[] = ['path', 'shell', 'executable', 'process']

function pathSignal(path: string): RiskReason | undefined {
  const hit = path.toLowerCase().split(/[/._-]/).find((s) => HOT_SEGMENTS.has(s))
  return hit ? { signal: 'path', path, detail: `segmento ${hit}` } : undefined
}

function shellSignal(path: string): RiskReason | undefined {
  const ext = SHELL.exec(path)
  return ext ? { signal: 'shell', path, detail: `script ${ext[0]}` } : undefined
}

const executable = (mode: string) => (Number.parseInt(mode, 8) & 0o111) !== 0

function executableSignal(path: string, before: string, after: string): RiskReason | undefined {
  return !executable(before) && executable(after) ? { signal: 'executable', path, detail: `modo ${before} → ${after}` } : undefined
}

function processSignal(path: string, added: Array<{ line: number; text: string }>): RiskReason | undefined {
  for (const { line, text } of added) {
    const m = PROCESS.exec(text)
    if (m) return { signal: 'process', path, detail: `línea ${line}: ${m[0]}` }
  }
  return undefined
}

/** Un motivo por señal y ruta, con el primer detalle, ordenados por ruta y señal. */
function risk(found: Array<RiskReason | undefined>): Risk {
  const seen = new Set<string>()
  const reasons: RiskReason[] = []
  for (const r of found) {
    if (!r || seen.has(`${r.signal}\0${r.path}`)) continue
    seen.add(`${r.signal}\0${r.path}`)
    reasons.push(r)
  }
  reasons.sort((a, b) => a.path.localeCompare(b.path) || ORDER.indexOf(a.signal) - ORDER.indexOf(b.signal))
  return { level: reasons.length > 0 ? 'high' : 'normal', reasons }
}

const sectionOf = (c: Candidate) => {
  const texts = new Map(sections(c.diff, c.files).map((s) => [s.path, s.text]))
  return (path: string) => texts.get(path) ?? ''
}

/** Un renombre cuenta como script cambiado solo si su sección trae algún hunk. */
function scriptChanged(f: CandidateFile, section: string): boolean {
  if (f.status === 'D') return false
  return f.status !== 'R' || /^@@ /m.test(section)
}

/** El nivel del candidato: `high` con una señal en cualquier archivo, sin mirar el tamaño. */
export function classify(c: Candidate): Risk {
  const section = sectionOf(c)
  return risk(c.files.flatMap((f) => [
    pathSignal(f.path),
    f.from ? pathSignal(f.from) : undefined,
    scriptChanged(f, section(f.path)) ? shellSignal(f.path) : undefined,
    f.status !== 'D' && f.old_mode !== undefined ? executableSignal(f.path, f.old_mode, f.mode) : undefined,
    processSignal(f.path, addedLines(section(f.path))),
  ]))
}

const inRanges = (line: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => line >= a && line <= b)

/**
 * El nivel de lo que cambió de un candidato al siguiente. Toda ruta que cambió pasa por las señales de
 * ruta y de script aunque ya estuviera en el anterior; de los modos y las líneas agregadas cuenta solo
 * lo nuevo, y de los identificadores de proceso, solo los que un bloque reemplazado no traía ya.
 */
export function classifyDelta(prev: Candidate, next: Candidate, changed: ChangedRanges, dir: string): Risk {
  const hunks = replacedHunks(prev, next, dir)
  const before = new Map(prev.files.map((f) => [f.path, f]))
  const after = new Map(next.files.map((f) => [f.path, f]))
  const paths = new Set(Object.keys(changed))
  for (const f of next.files) {
    const p = before.get(f.path)
    if (!p || p.status !== f.status || p.mode !== f.mode) paths.add(f.path)
  }
  for (const f of prev.files) if (!after.has(f.path)) paths.add(f.path)

  const section = sectionOf(next)
  const found: Array<RiskReason | undefined> = []
  for (const path of paths) {
    const f = after.get(path)
    found.push(pathSignal(path), f?.from ? pathSignal(f.from) : undefined)
    if (f && f.status !== 'D') found.push(shellSignal(path))
  }
  for (const f of next.files) {
    if (f.status === 'D') continue
    const was = before.get(f.path)?.mode ?? f.old_mode ?? NO_MODE
    found.push(executableSignal(f.path, was, f.mode))
    const ranges = changed[f.path]
    // Un archivo que solo cambió de ruta no trae líneas nuevas, aunque en su ruta nueva todas figuren cambiadas.
    const moved = prev.files.some((p) => p.status !== 'D' && p.sha256 === f.sha256)
    if (Array.isArray(ranges) && !moved) found.push(newProcessSignal(f.path, addedLines(section(f.path)), hunks[f.path] ?? []))
  }
  return risk(found)
}

/**
 * Primer identificador de proceso que un archivo agrega: en cada bloque reemplazado se descuentan, con
 * su multiplicidad, los que ya estaban en el texto que quitó.
 */
function newProcessSignal(path: string, added: Array<{ line: number; text: string }>, hunks: ReplacedHunk[]): RiskReason | undefined {
  for (const hunk of hunks) {
    if (!hunk.added) continue
    const range = hunk.added
    const seen = new Map<string, number>()
    for (const text of hunk.removed) {
      for (const m of text.matchAll(new RegExp(PROCESS.source, 'gu'))) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1)
    }
    for (const { line, text } of added.filter((a) => inRanges(a.line, [range]))) {
      for (const m of text.matchAll(new RegExp(PROCESS.source, 'gu'))) {
        const left = seen.get(m[0]) ?? 0
        if (left > 0) seen.set(m[0], left - 1)
        else return { signal: 'process', path, detail: `línea ${line}: ${m[0]}` }
      }
    }
  }
  return undefined
}
