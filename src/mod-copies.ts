import { createHash } from 'node:crypto'
import { type Stats, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { SddError } from './types.ts'

export const MOD_PATH = '.claude/skills/sdd-ai-mod'
const MOD_SOURCE = 'mods/sdd-ai'
const MANIFEST = '.claude-plugin/plugin.json'
/** Los archivos fijos de la fuente: el manifiesto, el que nombra el módulo y el módulo que nombra. */
const MOD_FIXED_FILES = [MANIFEST, 'hooks/hooks.json', 'hooks/register.tsx'] as const
export const MOD_RUNTIME_FILES: readonly string[] = MOD_FIXED_FILES.map((path) => `${MOD_SOURCE}/${path}`)
/**
 * Las rutas, relativas a la copia, de lo que el motor deja al cargarla: el directorio de tipos entero y el tsconfig de la
 * raíz. No cuentan para la vigencia y nada las borra.
 */
export const ENGINE_PATHS: ReadonlySet<string> = new Set(['.claude-plugin/types', 'tsconfig.json'])
/** El sufijo del temporal con el que se escribe cada archivo de la copia antes de renombrarlo. */
const TEMPORARY_SUFFIX = '.sdd-ai-tmp'
// Comprobado con Claude Code 2.1.289: una sesión abierta que ya tenía el mod adopta sola la copia nueva, y
// /reload-plugins carga la copia también en una sesión que arrancó sin ella, sin duplicar el mod.
export const MOD_ADOPTION_MESSAGE = 'Para cargar sdd-ai-mod en una sesión de Claude Code ya abierta en este checkout, corre /reload-plugins; una sesión nueva lo carga al arrancar.'
export interface ModFile { path: string; bytes: Buffer; sha256: string }
export interface ModCopy { path: string; state: 'ok' | 'missing' | 'stale' }
export interface ModChange { path: string; state: 'missing' | 'stale' | 'leftover' }

/** La entrada misma, sin seguir un enlace; `undefined` si no existe. */
const entry = (path: string): Stats | undefined => lstatSync(path, { throwIfNoEntry: false })

/** Los archivos distribuibles bajo `rel` en la fuente, sin los tests y sin seguir enlaces. */
function sourceFiles(source: string, rel: string): string[] {
  if (!entry(join(source, rel))?.isDirectory()) return []
  return readdirSync(join(source, rel), { withFileTypes: true }).flatMap((e) => {
    const path = `${rel}/${e.name}`
    if (e.name === 'tests' || /\.test\.tsx?$/.test(e.name)) return []
    if (e.isDirectory()) return sourceFiles(source, path)
    return e.isFile() ? [path] : []
  })
}

/**
 * Lo que la copia administra: toda entrada que no es un directorio, también un enlace, salvo lo que deja el motor.
 * No entra en un directorio enlazado: el enlace mismo es la entrada.
 */
function managedCopyEntries(copy: string, rel = ''): string[] {
  const dir = rel ? join(copy, rel) : copy
  if (!entry(dir)?.isDirectory()) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name
    if (ENGINE_PATHS.has(path)) return []
    return e.isDirectory() ? managedCopyEntries(copy, path) : [path]
  })
}

/**
 * El inventario comprueba las fuentes fijas antes de que cualquier consumidor escriba: tienen que ser archivos regulares
 * en directorios propios de la fuente, porque el recorrido no sigue enlaces y un fijo enlazado quedaría fuera.
 */
export function modInventory(pkgDir: string): ModFile[] {
  const source = join(pkgDir, MOD_SOURCE)
  for (const path of MOD_FIXED_FILES) {
    // Una fuente fija ausente lanza el mismo ENOENT que la fuente ausente de la skill.
    readFileSync(join(source, path))
    const found = ownEntry(source, path)
    if (found === 'blocked' || found?.isFile() !== true) throw new Error(`la fuente del mod tiene ${MOD_SOURCE}/${path} como enlace o dentro de un directorio enlazado: tiene que ser un archivo propio`)
  }
  const paths = [MANIFEST, ...sourceFiles(source, 'hooks'), ...sourceFiles(source, 'types')].sort()
  return paths.map((path) => {
    const bytes = readFileSync(join(source, path))
    return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
}

/**
 * La entrada `rel` dentro de `base`, sin pasar por enlaces. Si un ancestro falta, la entrada falta; si un ancestro existe
 * pero no es un directorio propio (un enlace o un archivo), la entrada no es de `base` y se informa `'blocked'`, que nunca
 * se confunde con un archivo. Nunca resuelve un enlace, así que un ciclo no la detiene.
 */
function ownEntry(base: string, rel: string): Stats | 'blocked' | undefined {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i++) {
    const ancestor = entry(join(base, ...parts.slice(0, i)))
    if (!ancestor) return undefined
    if (!ancestor.isDirectory()) return 'blocked'
  }
  return entry(join(base, rel))
}

export function modChanges(root: string, inventory: readonly ModFile[]): ModChange[] {
  const copy = join(root, MOD_PATH)
  // Una copia que no es un directorio propio (un enlace, por ejemplo) no se lee: todo falta.
  const own = entry(copy)?.isDirectory() === true
  const changes: ModChange[] = []
  for (const file of inventory) {
    const path = `${MOD_PATH}/${file.path}`
    const found = own ? ownEntry(copy, file.path) : undefined
    if (!found) changes.push({ path, state: 'missing' })
    else if (found === 'blocked' || !found.isFile() || !readFileSync(join(root, path)).equals(file.bytes)) changes.push({ path, state: 'stale' })
  }
  const keep = new Set(inventory.map((file) => file.path))
  for (const path of own ? managedCopyEntries(copy).sort() : []) {
    if (!keep.has(path)) changes.push({ path: `${MOD_PATH}/${path}`, state: 'leftover' })
  }
  return changes
}

export function modCopy(root: string, inventory: readonly ModFile[]): ModCopy {
  return { path: MOD_PATH, state: !entry(join(root, MOD_PATH)) ? 'missing' : modChanges(root, inventory).length ? 'stale' : 'ok' }
}

/**
 * Deja libre la ruta de un archivo del inventario: quita lo que no es un directorio en sus ancestros dentro de la copia
 * y lo que no es un archivo regular en la ruta misma. Un enlace se quita sin tocar su destino.
 */
function clearPath(copy: string, rel: string, removed: string[]): void {
  const parts = rel.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const path = join(copy, ...parts.slice(0, i))
    const found = entry(path)
    if (!found) return
    const isLast = i === parts.length
    if (isLast ? !found.isFile() : !found.isDirectory()) {
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
      return
    }
  }
}

/**
 * La copia tiene que quedar dentro del checkout: si `.claude` o `.claude/skills` es un enlace que sale de él (por ejemplo,
 * a otro checkout), sincronizar escribiría y borraría ahí. Se comprueba antes de escribir nada; un enlace que resuelve
 * dentro del checkout sirve. La copia de la skill no tiene esta regla.
 */
export function assertModCopyInside(root: string): void {
  const checkout = realpathSync(root)
  for (const rel of ['.claude/skills', '.claude']) {
    if (!entry(join(root, rel))) continue
    const real = realpathSync(join(root, rel))
    if (real === checkout || real.startsWith(`${checkout}${sep}`)) return
    throw new SddError('mod_copy_outside', `${rel} resuelve fuera del checkout (${real}): la copia de sdd-ai-mod se escribiría ahí`, {
      next: `reemplaza el enlace ${rel} por un directorio del checkout y repite el comando`,
    })
  }
}

/**
 * Deja la copia igual a la fuente. Solo administra `.claude/skills/sdd-ai-mod` del checkout: si es un enlace, se
 * reemplaza por un directorio propio, y nunca se escribe ni se borra en el destino de un enlace de la copia. Que sus
 * ancestros no salgan del checkout lo exige `assertModCopyInside` antes de escribir.
 */
export function syncModCopy(root: string, inventory: readonly ModFile[]): { written: string[]; removed: string[] } {
  assertModCopyInside(root)
  const copy = join(root, MOD_PATH)
  const removed: string[] = []
  const top = entry(copy)
  if (top && !top.isDirectory()) {
    rmSync(copy)
    removed.push(copy)
  }
  mkdirSync(copy, { recursive: true })
  // El módulo que nombra hooks.json se escribe último: una sesión que recarga a mitad no carga un registro nuevo con
  // auxiliares viejos.
  const entryLast = [...inventory].sort((a, b) => Number(a.path === MOD_FIXED_FILES[2]) - Number(b.path === MOD_FIXED_FILES[2]))
  const written = entryLast.map((file) => {
    clearPath(copy, file.path, removed)
    const path = join(copy, file.path)
    mkdirSync(dirname(path), { recursive: true })
    // Un temporal y un renombre: una sesión que recarga el mod nunca ve un archivo a medio escribir. Lo que ya ocupe la
    // ruta del temporal (un enlace que quedó, por ejemplo) se quita sin seguirlo, y el temporal se crea exclusivo.
    const temporary = `${path}${TEMPORARY_SUFFIX}`
    rmSync(temporary, { recursive: true, force: true })
    writeFileSync(temporary, file.bytes, { flag: 'wx' })
    renameSync(temporary, path)
    return path
  })
  // Los sobrantes se borran al final, cuando la copia ya tiene todo lo que importa el módulo nuevo.
  const keep = new Set(inventory.map((file) => file.path))
  for (const rel of managedCopyEntries(copy)) {
    if (keep.has(rel)) continue
    rmSync(join(copy, rel), { recursive: true, force: true })
    removed.push(join(copy, rel))
  }
  return { written, removed }
}
