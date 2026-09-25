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

/**
 * El revisor: sin shell ni búsqueda web, sin la config del usuario y en un directorio vacío que no es
 * un repo. `tools.web_search=false` no apaga la búsqueda; `web_search="disabled"` sí.
 */
export function codexReviewLaunch(t: WorkerTask & { scratch: string }): LaunchSpec {
  const args = [
    'exec', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'shell_tool', '-c', 'web_search="disabled"', '--skip-git-repo-check',
    '-s', 'read-only', '-C', t.scratch, '--json', '--output-last-message', t.resultFile,
  ]
  if (t.model) args.push('-m', t.model)
  if (t.effort) args.push('-c', `${EFFORT_KEY}${t.effort}`)
  args.push('-')
  return { cmd: 'codex', args, cwd: t.scratch, stdinFile: t.promptFile }
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

/** El mismo argv con otra `--output-last-message`: cada intento deja su respuesta en su propio archivo. */
export function withResultFile(args: string[], resultFile: string): string[] {
  const i = args.indexOf('--output-last-message')
  return args.map((a, k) => (i >= 0 && k === i + 1 ? resultFile : a))
}

/**
 * Argv para reanudar un hilo que se quedó sin tiempo. `exec resume` no acepta `-C` ni `-s`: el
 * sandbox viaja como config y el directorio es el cwd del proceso. El resto del aislamiento se
 * conserva tal cual.
 */
export function codexResume(args: string[], threadId: string, resultFile: string): string[] | null {
  if (args[0] !== 'exec') return null
  const out = ['exec', 'resume']
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '-s' || a === '-C') {
      i++
    } else if (a === '--output-last-message') {
      out.push(a, resultFile)
      i++
    } else if (a !== '-') {
      out.push(a)
    }
  }
  out.push('-c', 'sandbox_mode="read-only"', threadId, '-')
  return out
}
