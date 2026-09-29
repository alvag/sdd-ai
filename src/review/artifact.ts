import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { SddError } from '../types.ts'
import { type Candidate, type ContextFile, type Selection, countLines, readContextFile, sha256 } from './candidate.ts'

export type ArtifactKind = 'spec' | 'plan' | 'tasks'
export type ArtifactRole = 'request' | 'spec' | 'plan'
export interface ArtifactInput { role: ArtifactRole; path: string }
/** Un artefacto de un flujo SDD: se revisa contra sus insumos de arriba, cada uno con su rol. */
export interface ArtifactSelection { artifact: string; kind: ArtifactKind; inputs: ArtifactInput[]; context: string[] }

const KINDS: readonly ArtifactKind[] = ['spec', 'plan', 'tasks']
/** El orden en que viajan los insumos: el que está más arriba, primero. */
const ROLES: readonly ArtifactRole[] = ['request', 'spec', 'plan']
export const REQUIRED_ROLES: Record<ArtifactKind, readonly ArtifactRole[]> = { spec: ['request'], plan: ['spec'], tasks: ['spec', 'plan'] }
const HINT: Record<ArtifactRole, string> = {
  request: '--request <ruta al pedido>', spec: '--spec <ruta a la spec>', plan: '--plan <ruta al plan>',
}

export function isArtifact(sel: Selection | ArtifactSelection): sel is ArtifactSelection {
  return 'artifact' in sel
}

/**
 * Valida los argumentos de una revisión de artefacto antes de tocar nada: el tipo, que no se mezcle con
 * un diff, y que estén exactamente los insumos que el tipo usa.
 */
export function validateArtifactArgs(v: {
  kind?: string; request?: string; spec?: string; plan?: string; base?: string; head?: string; risk?: string
}): { kind: ArtifactKind; inputs: ArtifactInput[] } {
  const kind = v.kind as ArtifactKind
  if (!KINDS.includes(kind)) {
    throw new SddError('usage', `tipo de artefacto desconocido: ${v.kind ?? '(falta --kind)'}`, { next: 'usa --kind spec, plan o tasks' })
  }
  for (const flag of ['base', 'head', 'risk'] as const) {
    if (v[flag] !== undefined) {
      throw new SddError('usage', `--${flag} no se usa con --artifact: un artefacto se revisa desde el árbol y no tiene riesgo`)
    }
  }
  const required = REQUIRED_ROLES[kind]
  for (const role of ROLES) {
    if (v[role] !== undefined && !required.includes(role)) {
      throw new SddError('usage', `--${role} no se usa con --kind ${kind}`, { next: `pasa ${required.map((r) => HINT[r]).join(' y ')}` })
    }
  }
  const inputs: ArtifactInput[] = []
  for (const role of required) {
    const path = v[role]
    if (path === undefined) throw new SddError('usage', `falta --${role} para revisar ${kind}`, { next: `pasa ${HINT[role]}` })
    inputs.push({ role, path })
  }
  return { kind, inputs }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Lee un archivo del material y lo valida: existe, está en el repo, es texto UTF-8 y, si hace falta, no está vacío. */
export function readMaterial(root: string, p: string, what: string, requireContent: boolean): { path: string; bytes: Buffer; real: string } {
  const abs = isAbsolute(p) ? p : resolve(root, p)
  // readContextFile no comprueba que sea un archivo regular, y statSync necesita una ruta que exista: el
  // material lo comprueba antes, así que acá una ruta externa inexistente da "no existe".
  if (!existsSync(abs)) throw new SddError('usage', `${what} no existe: ${p}`)
  if (!statSync(abs).isFile()) throw new SddError('usage', `${what} no es un archivo: ${p}`)
  const { path, bytes } = readContextFile(root, abs, what)
  try {
    UTF8.decode(bytes)
  } catch {
    throw new SddError('usage', `${what} no es texto UTF-8: ${path}`)
  }
  if (requireContent && bytes.toString('utf8').trim() === '') throw new SddError('usage', `${what} está vacío: ${path}`)
  return { path, bytes, real: realpathSync(abs) }
}

/**
 * Si los insumos y el contexto de un candidato siguen siendo los que se congelaron: existen, son texto
 * válido, un insumo no quedó vacío y los bytes son los mismos. Un cambio ahí invalida la revisión entera,
 * porque el artefacto se juzgó contra ellos.
 */
export function inputsUnchanged(root: string, c: Candidate): boolean {
  for (const x of c.context) {
    try {
      const r = readMaterial(root, x.path, x.role ? `el insumo ${x.role}` : 'el contexto', x.role !== undefined)
      if (sha256(r.bytes) !== x.sha256) return false
    } catch (e) {
      if (e instanceof SddError) return false
      throw e
    }
  }
  return true
}

/**
 * Congela un artefacto desde el árbol, aunque Git no lo siga: el artefacto, sus insumos con su rol y el
 * contexto. El hash no lleva ningún SHA de Git, así que un commit que no toca estos archivos no lo
 * cambia. Devuelve también los bytes que validó: el material y los blobs salen de ellos y no de otra
 * lectura del árbol.
 */
export function freezeArtifact(root: string, sel: ArtifactSelection): { candidate: Candidate; bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>()
  const seen = new Set<string>()
  const read = (p: string, what: string, requireContent: boolean) => {
    const r = readMaterial(root, p, what, requireContent)
    if (seen.has(r.real)) {
      throw new SddError('usage', `${r.path} aparece más de una vez entre el artefacto, los insumos y el contexto`)
    }
    seen.add(r.real)
    bytes.set(r.path, r.bytes)
    return r
  }
  const art = read(sel.artifact, 'el artefacto', true)
  const lines = countLines(art.bytes.toString('utf8'))
  const inputs = [...sel.inputs].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role)).map((i) => {
    const r = read(i.path, `el insumo ${i.role}`, true)
    return { path: r.path, sha256: sha256(r.bytes), lines: countLines(r.bytes.toString('utf8')), role: i.role } satisfies ContextFile
  })
  const context = sel.context.map((p) => {
    const r = read(p, 'el contexto', false)
    return { path: r.path, sha256: sha256(r.bytes), lines: countLines(r.bytes.toString('utf8')) } satisfies ContextFile
  })
  const manifest = {
    subject: 'artifact', kind: sel.kind,
    artifact: { path: art.path, sha256: sha256(art.bytes) },
    inputs: inputs.map((i) => ({ role: i.role, path: i.path, sha256: i.sha256 })),
    context: context.map((c) => ({ path: c.path, sha256: c.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
  }
  const candidate: Candidate = {
    subject: { kind: sel.kind },
    base_sha: null, head_sha: null,
    files: [{ path: art.path, status: 'A', mode: '100644', sha256: sha256(art.bytes), binary: false, lines, visible: [[1, lines]] }],
    context: [...inputs, ...context], left_out: [], diff: '',
    hash: `sha256:${sha256(JSON.stringify(manifest))}`,
  }
  return { candidate, bytes }
}

type Ranges = Array<[number, number]>

/**
 * Qué cambió de una versión del artefacto a la siguiente, con los dos lados: las líneas agregadas o
 * cambiadas de la nueva y las borradas o reemplazadas de la anterior. Una regresión se ancla en una de
 * ellas, y un cambio que solo borra no deja ninguna línea nueva que citar.
 */
export function artifactDelta(before: string, after: string): { added: Ranges; removed: Ranges } {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-delta-'))
  try {
    writeFileSync(join(dir, 'antes'), before)
    writeFileSync(join(dir, 'despues'), after)
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '-U0',
      join(dir, 'antes'), join(dir, 'despues')], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index falló: ${r.stderr}`)
    const added: Ranges = []
    const removed: Ranges = []
    for (const m of r.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const [a, b, c, d] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
      if (b > 0) removed.push([a, a + b - 1])
      if (d > 0) added.push([c, c + d - 1])
    }
    return { added, removed }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
