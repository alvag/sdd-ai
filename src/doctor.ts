import { spawnSync } from 'node:child_process'
import type { Family, WorkerTask } from './types.ts'
import { claudeLaunch } from './workers/claude.ts'
import { codexLaunch } from './workers/codex.ts'

type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string }

export interface CliReport {
  family: Family
  version?: string
  inPath: boolean
  flags: { flag: string; present: boolean }[]
}

const SAMPLE: WorkerTask = {
  cwd: '/r', promptFile: '/r/p', resultFile: '/r/o', sessionId: 's', model: 'm', effort: 'high',
}
const HELP_ARGS: Record<Family, string[]> = { claude: ['--help'], codex: ['exec', '--help'] }

/** Flags que emiten los adapters, sacados de su propia salida para no mantener una lista aparte. */
export function emittedFlags(family: Family): string[] {
  const args = (family === 'claude' ? claudeLaunch(SAMPLE) : codexLaunch(SAMPLE)).args
  const flags = args.filter((a) => a.startsWith('-') && a !== '-').map((a) => a.split('=')[0])
  return [...new Set(flags)]
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function checkFlags(help: string, flags: string[]): { flag: string; present: boolean }[] {
  const lines = help.split('\n')
  return flags.map((flag) => {
    const re = new RegExp(`(^|[\\s,])${escape(flag)}([\\s,=<]|$)`)
    return { flag, present: lines.some((l) => re.test(l)) }
  })
}

const defaultExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' }
}

/** Contrato con los CLIs instalados: están en PATH y aceptan cada flag que emite sdd-ai. */
export function doctor(exec: Exec = defaultExec): { ok: boolean; clis: CliReport[] } {
  const clis = (['claude', 'codex'] as Family[]).map((family): CliReport => {
    const v = exec(family, ['--version'])
    if (v.status === null) return { family, inPath: false, flags: [] }
    const report: CliReport = { family, inPath: true, flags: checkFlags(exec(family, HELP_ARGS[family]).stdout, emittedFlags(family)) }
    const version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
    if (version) report.version = version
    return report
  })
  const ok = clis.every((c) => c.inPath && c.flags.every((f) => f.present))
  return { ok, clis }
}
