import type { LaunchSpec, WorkerTask } from '../types.ts'

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
  if (t.model) args.push('--model', t.model)
  if (t.effort) args.push('--effort', t.effort)
  return { cmd: 'claude', args, cwd: t.cwd, stdinFile: t.promptFile }
}
