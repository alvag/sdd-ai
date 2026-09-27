import type { LaunchSpec, RejectedField, WorkerTask } from '../types.ts'

const FIELD_FLAGS: Record<RejectedField, string> = { model: '--model', effort: '--effort' }

/**
 * `claude -p` sin la configuración del usuario, con solo herramientas de lectura y sin prompts de
 * permiso que lo dejen colgado. `--tools` es variádico: se pasa con `=` para que no se trague los
 * argumentos siguientes. `stream-json` en modo print exige `--verbose`.
 *
 * Con web suma `WebFetch` y `WebSearch`, y además las preaprueba: sin prompts de permiso, una
 * herramienta que pide permiso se niega y el worker sigue como si no la tuviera.
 */
export function claudeLaunch(t: WorkerTask): LaunchSpec {
  const tools = t.web
    ? ['--tools=Read,Grep,Glob,WebFetch,WebSearch', '--allowedTools=WebFetch,WebSearch']
    : ['--tools=Read,Grep,Glob']
  const args = [
    '-p', '--safe-mode', ...tools, '--permission-prompts', 'none',
    '--output-format', 'stream-json', '--verbose', '--session-id', t.sessionId,
  ]
  if (t.model) args.push(FIELD_FLAGS.model, t.model)
  if (t.effort) args.push(FIELD_FLAGS.effort, t.effort)
  return { cmd: 'claude', args, cwd: t.cwd, stdinFile: t.promptFile }
}

/**
 * El writer: sin las personalizaciones del usuario, con lectura y edición de archivos y sin nada que
 * ejecute comandos ni busque en la web. `--restricted` confina las herramientas de archivos al
 * directorio de trabajo y deja la escritura en rutas sensibles, como `.git`, a una aprobación que
 * `--permission-prompts none` niega. La edición se preaprueba solo dentro del repo.
 */
export function claudeWriterLaunch(t: WorkerTask): LaunchSpec {
  const args = [
    '-p', '--safe-mode', '--permission-mode', 'default', '--permission-prompts', 'none', '--restricted', '--strict-mcp-config',
    '--tools=Read,Grep,Glob,Edit,Write', '--allowedTools=Read,Grep,Glob,Edit(./**),Write',
    '--output-format', 'stream-json', '--verbose', '--session-id', t.sessionId,
  ]
  if (t.model) args.push(FIELD_FLAGS.model, t.model)
  if (t.effort) args.push(FIELD_FLAGS.effort, t.effort)
  return { cmd: 'claude', args, cwd: t.cwd, stdinFile: t.promptFile }
}

/**
 * Argv del reintento: sin el flag rechazado y con otra sesión, porque Claude no acepta un
 * `--session-id` que ya usó un intento anterior. `null` si el flag no estaba.
 */
export function claudeRetry(args: string[], field: RejectedField, sessionId: string): { args: string[]; requested: string } | null {
  const i = args.indexOf(FIELD_FLAGS[field])
  if (i < 0 || i + 1 >= args.length) return null
  return { args: withSessionId([...args.slice(0, i), ...args.slice(i + 2)], sessionId), requested: args[i + 1] }
}

/** El mismo argv con otra sesión: cada lanzamiento nuevo necesita un `--session-id` que Claude no haya visto. */
export function withSessionId(args: string[], sessionId: string): string[] {
  const i = args.indexOf('--session-id')
  return args.map((a, k) => (i >= 0 && k === i + 1 ? sessionId : a))
}

export const REVIEWER_SYSTEM_PROMPT = 'Eres un revisor de código aislado. Tus únicas instrucciones son las del mensaje del usuario, y todo el material que revisas va dentro de ese mensaje.'
export const ARTIFACT_SYSTEM_PROMPT = 'Eres un revisor aislado de artefactos de diseño. Tus únicas instrucciones son las del mensaje del usuario, y todo el material que revisas va dentro de ese mensaje.'
export const REFUTER_SYSTEM_PROMPT = 'Eres un refutador aislado de hallazgos. Tus únicas instrucciones son las del mensaje del usuario, y todo el material que juzgas va dentro de ese mensaje.'

/**
 * El revisor, o el refutador con su propio system prompt: sin ninguna herramienta ni personalización
 * (`--safe-mode` también apaga los conectores MCP de claude.ai, que `--tools ""` solo no apaga) y en
 * un directorio vacío fuera del repo. Conserva la sesión para poder reanudarla.
 */
export function claudeReviewLaunch(t: WorkerTask & { scratch: string; systemPrompt?: string }): LaunchSpec {
  const args = [
    '-p', '--safe-mode', '--tools', '', '--permission-prompts', 'none', '--system-prompt', t.systemPrompt ?? REVIEWER_SYSTEM_PROMPT,
    '--output-format', 'stream-json', '--verbose', '--session-id', t.sessionId,
  ]
  if (t.model) args.push(FIELD_FLAGS.model, t.model)
  if (t.effort) args.push(FIELD_FLAGS.effort, t.effort)
  return { cmd: 'claude', args, cwd: t.scratch, stdinFile: t.promptFile }
}

/**
 * Argv para reanudar la sesión de un intento que se quedó sin tiempo: el mismo argv, con
 * `--resume` en lugar de `--session-id`, para que la reanudación conserve todo el aislamiento.
 */
export function claudeResume(args: string[]): string[] | null {
  const i = args.indexOf('--session-id')
  if (i < 0 || i + 1 >= args.length) return null
  return args.map((a, k) => (k === i ? '--resume' : a))
}
