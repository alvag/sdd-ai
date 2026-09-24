import type { LaunchSpec, RejectedField, WorkerTask } from '../types.ts'

const EFFORT_KEY = 'model_reasoning_effort='

/**
 * `codex exec` sin la configuración del usuario ni sus hooks, apps o plugins, en sandbox de solo
 * lectura. El último mensaje del agente queda en `resultFile`; el prompt entra por stdin (`-`).
 */
export function codexLaunch(t: WorkerTask): LaunchSpec {
  const args = [
    'exec', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '-s', 'read-only', '-C', t.cwd, '--json', '--output-last-message', t.resultFile,
  ]
  if (t.model) args.push('-m', t.model)
  if (t.effort) args.push('-c', `${EFFORT_KEY}${t.effort}`)
  args.push('-')
  return { cmd: 'codex', args, cwd: t.cwd, stdinFile: t.promptFile }
}

/** Argv del reintento: sin `-m <modelo>` o sin el par `-c model_reasoning_effort=…`. `null` si no estaba. */
export function codexRetry(args: string[], field: RejectedField): { args: string[]; requested: string } | null {
  const i = field === 'model'
    ? args.indexOf('-m')
    : args.findIndex((a, k) => a === '-c' && (args[k + 1] ?? '').startsWith(EFFORT_KEY))
  if (i < 0 || i + 1 >= args.length) return null
  const value = args[i + 1]
  return { args: [...args.slice(0, i), ...args.slice(i + 2)], requested: field === 'model' ? value : value.slice(EFFORT_KEY.length) }
}
