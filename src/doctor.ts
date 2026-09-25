import { spawnSync } from 'node:child_process'
import type { Family, WorkerTask } from './types.ts'
import { claudeLaunch, claudeResume, claudeReviewLaunch } from './workers/claude.ts'
import { codexLaunch, codexResume, codexReviewLaunch } from './workers/codex.ts'

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
const REVIEW_SAMPLE = { ...SAMPLE, scratch: '/tmp/s' }
const HELP_ARGS: Record<Family, string[]> = { claude: ['--help'], codex: ['exec', '--help'] }
// `codex exec resume` tiene su propia ayuda: acepta menos flags que `exec`.
const CODEX_RESUME_HELP_ARGS = ['exec', 'resume', '--help']

/**
 * Flags que emiten los adapters —worker, revisor y reanudación—, sacados de su propia salida para no
 * mantener una lista aparte. En Codex, la reanudación se contrasta contra la ayuda de `exec resume`.
 */
export function emittedFlags(family: Family, surface: 'exec' | 'resume' = 'exec'): string[] {
  let argvs: string[][]
  if (family === 'claude') {
    const worker = claudeLaunch(SAMPLE).args
    argvs = [worker, claudeReviewLaunch(REVIEW_SAMPLE).args, claudeResume(worker) ?? []]
  } else if (surface === 'resume') {
    argvs = [codexResume(codexLaunch(SAMPLE).args, 't', '/r/o') ?? [], codexResume(codexReviewLaunch(REVIEW_SAMPLE).args, 't', '/r/o') ?? []]
  } else {
    argvs = [codexLaunch(SAMPLE).args, codexReviewLaunch(REVIEW_SAMPLE).args]
  }
  const flags = argvs.flat().filter((a) => a.startsWith('-') && a !== '-').map((a) => a.split('=')[0])
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
    const flags = checkFlags(exec(family, HELP_ARGS[family]).stdout, emittedFlags(family))
    if (family === 'codex') {
      const resume = checkFlags(exec(family, CODEX_RESUME_HELP_ARGS).stdout, emittedFlags(family, 'resume'))
      flags.push(...resume.map((r) => ({ flag: `resume ${r.flag}`, present: r.present })))
    }
    const report: CliReport = { family, inPath: true, flags }
    const version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0]
    if (version) report.version = version
    return report
  })
  const ok = clis.every((c) => c.inPath && c.flags.every((f) => f.present))
  return { ok, clis }
}
