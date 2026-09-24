import type { LaunchSpec, RejectedField, WorkerTask } from '../types.ts'

const FIELD_FLAGS: Record<RejectedField, string> = { model: '--model', effort: '--effort' }

/**
 * `claude -p` sin la configuración del usuario, con solo herramientas de lectura y sin prompts de
 * permiso que lo dejen colgado. `--tools` es variádico: se pasa con `=` para que no se trague los
 * argumentos siguientes. `stream-json` en modo print exige `--verbose`.
 */
export function claudeLaunch(t: WorkerTask): LaunchSpec {
  const args = [
    '-p', '--safe-mode', '--tools=Read,Grep,Glob', '--permission-prompts', 'none',
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
  const out = [...args.slice(0, i), ...args.slice(i + 2)]
  const s = out.indexOf('--session-id')
  if (s >= 0 && s + 1 < out.length) out[s + 1] = sessionId
  return { args: out, requested: args[i + 1] }
}
