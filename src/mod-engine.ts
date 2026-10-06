import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MOD_PATH } from './mod-copies.ts'
import { type Family, SddError } from './types.ts'

export const MOD_SYNC_COMMAND = './bin/sdd-ai agents sync'
export const MOD_TYPES_COMMAND = 'claude -p --plugin-dir .claude/skills/sdd-ai-mod --model haiku ok'
export const MOD_ENGINE_FILES = ['claude-code/index.d.ts', 'claude-code-tools/index.d.ts', 'claude-code-mcp/index.d.ts', 'tsconfig.json'] as const
export interface ModEngine {
  state: 'available' | 'copy_missing' | 'types_missing'
  copy: string
  paths: string[]
  missing: string[]
}
export interface ModEngineWarning { code: string; message: string; next: string }
export interface ModEngineContext { context: string; warnings: ModEngineWarning[] }

/** Solo las declaraciones reales de este checkout; nunca genera ni reemplaza el API. */
export function inspectModEngine(root: string): ModEngine {
  const copy = resolve(root, MOD_PATH)
  const paths = MOD_ENGINE_FILES.map((file) => join(copy, '.claude-plugin/types', file))
  try {
    if (!statSync(copy).isDirectory()) return { state: 'copy_missing', copy, paths, missing: paths }
  } catch { return { state: 'copy_missing', copy, paths, missing: paths } }
  const missing = paths.filter((path) => {
    try {
      if (!statSync(path).isFile()) return true
      readFileSync(path)
      return false
    } catch { return true }
  })
  return { state: missing.length ? 'types_missing' : 'available', copy, paths, missing }
}

/** El conductor prepara con red; Codex puede continuar declarando sus supuestos. */
export function modEngineContext(engine: ModEngine, conductor: Family): ModEngineContext {
  if (engine.state === 'available') return {
    context: ['## API real del motor de mods', 'Declaraciones legibles del checkout donde trabaja el worker:',
      ...engine.paths.map((path) => `- ${path}`), 'Consulta estas declaraciones para afirmar capacidades del motor.'].join('\n'), warnings: [],
  }
  const warning: ModEngineWarning = engine.state === 'copy_missing'
    ? { code: 'mod_copy_missing', message: 'Falta la copia del mod en este checkout.', next: MOD_SYNC_COMMAND }
    : { code: 'mod_engine_types_missing', message: 'Faltan declaraciones legibles del motor en este checkout.', next: MOD_TYPES_COMMAND }
  if (conductor === 'claude') throw new SddError(warning.code, warning.message, { next: warning.next, detail: engine.missing.join('\n') })
  return { warnings: [warning], context: [
    '## API del motor de mods no disponible', warning.message,
    'Toda afirmación sobre el API del motor debe declararse como supuesto; no presentes declaraciones sustitutas como el API real.',
    'No prepares las declaraciones: esa comprobación queda pendiente para el conductor.',
  ].join('\n') }
}
