import type { LaunchSpec, WorkerTask } from '../types.ts'

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
  if (t.effort) args.push('-c', `model_reasoning_effort=${t.effort}`)
  args.push('-')
  return { cmd: 'codex', args, cwd: t.cwd, stdinFile: t.promptFile }
}
