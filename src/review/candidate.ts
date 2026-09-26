import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SddError } from '../types.ts'
import type { ArtifactKind, ArtifactRole } from './artifact.ts'
import type { ChangedRanges } from './ledger.ts'

export interface Selection { base: string; head?: string; context: string[] }
export interface CandidateFile {
  path: string; status: 'A' | 'M' | 'D' | 'R' | 'T'; from?: string; mode: string
  sha256: string | null; binary: boolean; lines: number; visible: Array<[number, number]>
  /** El modo en la base. Queda fuera del hash; un candidato congelado antes de guardarlo no lo trae. */
  old_mode?: string
}
/** Un archivo de contexto. En un artefacto, los insumos de arriba llevan su rol; los de `--context`, no. */
export interface ContextFile { path: string; sha256: string; lines: number; role?: ArtifactRole }
/** Un diff congelado o, con `subject`, un artefacto: sin diff ni SHAs, con el artefacto como único archivo. */
export interface Candidate {
  subject?: { kind: ArtifactKind }
  base_sha: string | null; head_sha: string | null; files: CandidateFile[]; context: ContextFile[]
  left_out: string[]; diff: string; hash: string
}

/** La base de un diff. Solo se llama en ramas de diff: un artefacto no tiene base. */
export function baseOf(c: Candidate): string {
  if (c.base_sha === null) throw new Error('un artefacto no tiene base')
  return c.base_sha
}

// Fijan la forma del diff aunque la config Git del usuario diga otra cosa: prefijos, color,
// diff externo y textconv cambian el texto y las rutas que el revisor tiene que citar.
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M']

function gitBytes(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
}

function git(root: string, args: string[]): string {
  return gitBytes(root, args).toString('utf8')
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

function resolveCommit(root: string, ref: string): string {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim()
  } catch {
    throw new SddError('usage', `no se puede resolver la ref ${ref}`, { next: 'pasa un commit, rama o tag que exista' })
  }
}

export function countLines(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

interface Change { status: CandidateFile['status']; path: string; from?: string; mode: string; old_mode: string }

/**
 * `--raw -z`: `:modo-viejo modo-nuevo sha-viejo sha-nuevo estado` y la ruta, separados por NUL; un
 * renombre trae la ruta anterior y la nueva. El modo nuevo entra al hash: un `chmod` cambia el diff.
 * El viejo solo lo usa el clasificador de riesgo.
 */
function parseRaw(raw: string): Change[] {
  const parts = raw.split('\0')
  const out: Change[] = []
  for (let i = 0; i < parts.length && parts[i] !== '';) {
    const [oldMode, mode, , , state] = parts[i].slice(1).split(' ')
    const code = state[0] as CandidateFile['status']
    if (code === 'R') {
      out.push({ status: 'R', from: parts[i + 1], path: parts[i + 2], mode, old_mode: oldMode })
      i += 3
    } else {
      out.push({ status: code, path: parts[i + 1], mode, old_mode: oldMode })
      i += 2
    }
  }
  return out
}

/** `--numstat -z` marca un binario con `-\t-`; en un renombre la ruta nueva viene dos campos después. */
function parseBinaries(raw: string): Set<string> {
  const parts = raw.split('\0')
  const out = new Set<string>()
  for (let i = 0; i < parts.length && parts[i] !== '';) {
    const [added, deleted, path] = parts[i].split('\t')
    const binary = added === '-' && deleted === '-'
    if (path === '') {
      if (binary) out.add(parts[i + 2])
      i += 3
    } else {
      if (binary) out.add(path)
      i += 1
    }
  }
  return out
}

/** Rango del lado nuevo de un encabezado `@@ -a,b +c,d @@`; nada si el hunk no deja líneas nuevas. */
function newSide(header: string): [number, number] | undefined {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header)
  if (!m) return undefined
  const start = Number(m[1])
  const count = m[2] === undefined ? 1 : Number(m[2])
  return count > 0 ? [start, start + count - 1] : undefined
}

/** Rangos del lado nuevo de cada hunk, por ruta: lo único que el revisor ve de un archivo modificado. */
function parseVisible(diff: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>()
  let current: Array<[number, number]> | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined
    } else if (line.startsWith('+++ b/')) {
      current = []
      out.set(line.slice('+++ b/'.length), current)
    } else if (current && line.startsWith('@@')) {
      const range = newSide(line)
      if (range) current.push(range)
    }
  }
  return out
}

/** Bytes de una ruta del candidato: del commit con head, del árbol sin él. Un symlink vale su enlace. */
function contentOf(root: string, path: string, rev: string | null): Buffer {
  if (rev) return gitBytes(root, ['show', `${rev}:${path}`])
  const abs = resolve(root, path)
  return lstatSync(abs).isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs)
}

const outside = (rel: string) => rel === '' || rel.startsWith('..') || isAbsolute(rel)

export function readContextFile(root: string, p: string, what = 'el contexto'): { path: string; bytes: Buffer } {
  const abs = isAbsolute(p) ? p : resolve(root, p)
  const rel = relative(root, abs)
  // Un symlink dentro del repo puede apuntar afuera: la ruta real también tiene que caer adentro.
  if (outside(rel) || outside(relative(realpathSync(root), realpathSync(abs)))) {
    throw new SddError('usage', `${what} tiene que estar dentro del repo: ${p}`)
  }
  const bytes = readFileSync(abs)
  if (bytes.includes(0)) throw new SddError('usage', `${what} no puede ser binario: ${rel}`)
  return { path: rel, bytes }
}

/**
 * Congela el candidato: el diff contra la base (del árbol, o contra `head`), el contenido de cada ruta
 * con su hash, los rangos que el revisor puede citar y el contexto. El hash sale del manifiesto y no
 * del texto del diff, así que no depende de cómo lo imprima Git.
 */
export function freeze(root: string, sel: Selection): Candidate {
  const baseSha = resolveCommit(root, sel.base)
  const headSha = sel.head ? resolveCommit(root, sel.head) : null
  const range = headSha ? [baseSha, headSha] : [baseSha]
  const changes = parseRaw(git(root, ['diff', '--raw', '-z', '-M', ...range]))
  const binaries = parseBinaries(git(root, ['diff', '--numstat', '-z', '-M', ...range]))
  const diff = git(root, ['diff', ...DIFF_FLAGS, '--unified=3', ...range])
  const visible = parseVisible(diff)

  const files: CandidateFile[] = changes.map((ch) => {
    const deleted = ch.status === 'D'
    const bytes = contentOf(root, ch.path, deleted ? baseSha : headSha)
    const binary = binaries.has(ch.path) || bytes.includes(0)
    const lines = binary ? 0 : countLines(bytes.toString('utf8'))
    let ranges: Array<[number, number]> = []
    if (!binary && lines > 0) {
      ranges = ch.status === 'A' || deleted ? [[1, lines]] : visible.get(ch.path) ?? []
    }
    const f: CandidateFile = { path: ch.path, status: ch.status, mode: ch.mode, sha256: sha256(bytes), binary, lines, visible: ranges }
    if (ch.from) f.from = ch.from
    f.old_mode = ch.old_mode
    return f
  })

  const context: ContextFile[] = sel.context.map((p) => {
    const { path, bytes } = readContextFile(root, p)
    return { path, sha256: sha256(bytes), lines: countLines(bytes.toString('utf8')) }
  })

  const leftOut = headSha
    ? []
    : git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((p) => p !== '')

  const manifest = {
    base_sha: baseSha,
    head_sha: headSha,
    files: files.map((f) => ({ path: f.path, status: f.status, from: f.from ?? null, mode: f.mode, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    context: context.map((c) => ({ path: c.path, sha256: c.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
  }
  return { base_sha: baseSha, head_sha: headSha, files, context, left_out: leftOut, diff, hash: `sha256:${sha256(JSON.stringify(manifest))}` }
}

/** Congela dos veces seguidas: si el árbol cambió en el medio, el resultado no representa nada estable. */
export function freezeStableWith<S, R>(root: string, sel: S, fn: (root: string, sel: S) => R, hashOf: (r: R) => string): R {
  const first = fn(root, sel)
  const second = fn(root, sel)
  if (hashOf(first) !== hashOf(second)) {
    throw new SddError('candidate_unstable', 'el árbol cambió mientras se congelaba el candidato', {
      next: 'vuelve a correr review start cuando nadie esté escribiendo en el repo',
    })
  }
  return first
}

export function freezeStable(root: string, sel: Selection, freezeFn: typeof freeze = freeze): Candidate {
  return freezeStableWith(root, sel, freezeFn, (c) => c.hash)
}

/**
 * Guarda en `<dir>/blobs/<sha256>` los bytes de cada archivo del candidato (de un borrado, los de la
 * base) y de cada archivo de contexto: la ronda siguiente los compara, y el supervisor arma el material
 * del refutador con ellos, aunque el árbol ya haya cambiado. Devuelve los blobs que escribió, para
 * poder quitarlos si la ronda no llega a lanzarse.
 */
export function snapshot(root: string, c: Candidate, dir: string, retained?: Map<string, Buffer>): string[] {
  const blobs = join(dir, 'blobs')
  mkdirSync(blobs, { recursive: true })
  const unstable = (what: string, path: string) => new SddError('candidate_unstable', `${what} cambió después de congelarse: ${path}`, {
    next: 'vuelve a lanzar la ronda cuando nadie esté escribiendo en el repo',
  })
  // Un artefacto se guarda con los bytes que se validaron al congelarlo: así el blob es el contenido del
  // hash aunque el árbol haya cambiado después. Sin ellos, se lee como el contexto, siguiendo symlinks.
  const artifactBytes = (path: string) => retained?.get(path) ?? readContextFile(root, path).bytes
  const pending = c.files.map((f) => {
    const b = c.subject ? artifactBytes(f.path) : contentOf(root, f.path, f.status === 'D' ? c.base_sha : c.head_sha)
    if (sha256(b) !== f.sha256) throw unstable('el archivo', f.path)
    return { file: join(blobs, f.sha256), bytes: b }
  })
  for (const ctx of c.context) {
    const b = c.subject ? artifactBytes(ctx.path) : readContextFile(root, ctx.path).bytes
    if (sha256(b) !== ctx.sha256) throw unstable('el contexto', ctx.path)
    pending.push({ file: join(blobs, ctx.sha256), bytes: b })
  }
  const written: string[] = []
  for (const { file, bytes } of pending) {
    if (existsSync(file) || written.includes(file)) continue
    writeFileSync(`${file}.tmp`, bytes)
    renameSync(`${file}.tmp`, file)
    written.push(file)
  }
  return written
}

/** Rangos del lado nuevo que cambiaron; un hunk que solo borra marca la línea anterior al borrado, o la 1. */
function changedSide(diff: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!m) continue
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    out.push(count > 0 ? [start, start + count - 1] : [Math.max(start, 1), Math.max(start, 1)])
  }
  return out
}

/**
 * Qué cambió de un candidato al siguiente, archivo por archivo: las líneas donde una ronda puede
 * encontrar una regresión de la corrección. Compara los blobs que `snapshot` guardó de cada ronda.
 */
export function changedRanges(prev: Candidate, next: Candidate, dir: string): ChangedRanges {
  const out: ChangedRanges = {}
  for (const f of next.files) {
    if (f.status === 'D' || f.sha256 === null) continue
    const before = prev.files.find((p) => p.path === f.path && p.status !== 'D')
    if (before?.sha256 === f.sha256) continue
    if (f.binary) {
      out[f.path] = 'binary'
    } else if (!before || before.sha256 === null) {
      if (f.lines > 0) out[f.path] = [[1, f.lines]]
    } else {
      const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '-U0',
        join(dir, 'blobs', before.sha256), join(dir, 'blobs', f.sha256)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index falló sobre ${f.path}: ${r.stderr}`)
      const ranges = changedSide(r.stdout)
      if (ranges.length > 0) out[f.path] = ranges
    }
  }
  return out
}

/** El texto de cada archivo de contexto desde los blobs de la corrida, sin volver al repo. */
export function readContextBlobs(dir: string, c: Candidate): Map<string, string> {
  return new Map(c.context.map((ctx) => [ctx.path, readFileSync(join(dir, 'blobs', ctx.sha256), 'utf8')]))
}

/** El texto de cada archivo de contexto, comprobado contra el hash con que se congeló. */
export function readContext(root: string, c: Candidate): Map<string, string> {
  const out = new Map<string, string>()
  for (const ctx of c.context) {
    const { bytes } = readContextFile(root, ctx.path)
    if (sha256(bytes) !== ctx.sha256) {
      throw new SddError('candidate_unstable', `el contexto cambió después de congelarse: ${ctx.path}`, {
        next: 'vuelve a correr review start',
      })
    }
    out.set(ctx.path, bytes.toString('utf8'))
  }
  return out
}
