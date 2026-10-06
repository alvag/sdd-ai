import type { FsStat } from 'claude-code'
import { record } from './output'

export const MAX_PERSISTED_BYTES = 1024 * 1024
const absolute = (path: string): boolean => path.startsWith('/') && !path.split('/').includes('..') && !path.includes('\u0000')

/** La raíz sigue la convención del binario; no descubre ni enumera proyectos. */
export function projectsRoot(config: string | undefined, home: string | undefined): string | null {
  const root = config ? `${config.replace(/\/+$/, '')}/projects` : home ? `${home.replace(/\/+$/, '')}/.claude/projects` : null
  return root && absolute(root) ? root : null
}

/** Solo una respuesta terminada de una llamada observada por esta carga permite reservar el intento. */
export function eligiblePersisted(response: unknown, observed: boolean): { path: string; output: unknown; isErrored: boolean } | null {
  if (!observed || !record(response) || response.deny !== undefined || !record(response.result)) return null
  const output = response.result
  if (output.interrupted === true || output.isRunning === true || output.backgroundTaskId !== undefined
    || output.backgroundedByUser === true || output.backgroundedByTurnAbort === true || output.backgroundedToDeliverMessage === true
    || output.timedOutAfterMs !== undefined || typeof output.persistedOutputPath !== 'string') return null
  return { path: output.persistedOutputPath, output, isErrored: response.isError === true }
}

export function lexicalPersistedPath(path: string): boolean {
  return absolute(path) && /\/projects\/[^/]+\/[^/]+\/tool-results\/[^/]+$/.test(path)
    && !path.split('/').slice(-4).includes('.')
}

/** La pertenencia se decide sobre ambas rutas reales, incluyendo raíces alcanzadas por enlaces. */
export function physicalPersistedPath(root: FsStat, file: FsStat): boolean {
  if (root.kind !== 'dir' || file.kind !== 'file' || !root.realPath || !file.realPath
    || !absolute(root.realPath) || !absolute(file.realPath) || !Number.isSafeInteger(file.size)
    || file.size < 0 || file.size > MAX_PERSISTED_BYTES) return false
  const prefix = `${root.realPath.replace(/\/+$/, '')}/`
  if (!file.realPath.startsWith(prefix)) return false
  const parts = file.realPath.slice(prefix.length).split('/')
  return parts.length === 4 && parts.every(part => part !== '' && part !== '.' && part !== '..') && parts[2] === 'tool-results'
}

/** Comprobar también después de read: el archivo puede haber crecido tras stat. */
export function persistedContentFits(text: string): boolean {
  let bytes = 0
  for (const char of text) {
    const point = char.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > MAX_PERSISTED_BYTES) return false
  }
  return true
}
