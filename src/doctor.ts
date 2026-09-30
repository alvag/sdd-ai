import { spawnSync } from 'node:child_process'
import type { SkillCopy } from './agents.ts'
import type { Family, WorkerTask } from './types.ts'
import { claudeLaunch, claudeResume, claudeReviewLaunch, claudeWriterLaunch } from './workers/claude.ts'
import { codexLaunch, codexResume, codexReviewLaunch, codexWriterLaunch } from './workers/codex.ts'

export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string }

export interface CliReport {
  family: Family
  version?: string
  inPath: boolean
  flags: { flag: string; present: boolean }[]
}

/** Las copias de la skill del repo, o por qué no se revisaron. */
export type SkillCheck = { copies: SkillCopy[] } | { skipped: string }

type SkillReport = { copies: SkillCopy[]; next?: string } | { skipped: string }

const SAMPLE: WorkerTask = {
  cwd: '/r', promptFile: '/r/p', resultFile: '/r/o', sessionId: 's', model: 'm', effort: 'high',
}
// Un rol con web emite flags propias, como `--allowedTools` en Claude.
const WEB_SAMPLE: WorkerTask = { ...SAMPLE, web: true }
const REVIEW_SAMPLE = { ...SAMPLE, scratch: '/tmp/s' }
const HELP_ARGS: Record<Family, string[]> = { claude: ['--help'], codex: ['exec', '--help'] }
// `codex exec resume` tiene su propia ayuda: acepta menos flags que `exec`.
const CODEX_RESUME_HELP_ARGS = ['exec', 'resume', '--help']

/**
 * Flags que emiten los adapters —worker, writer, revisor y reanudación—, sacados de su propia salida para no
 * mantener una lista aparte. En Codex, la reanudación se contrasta contra la ayuda de `exec resume`.
 */
export function emittedFlags(family: Family, surface: 'exec' | 'resume' = 'exec'): string[] {
  let argvs: string[][]
  if (family === 'claude') {
    const worker = claudeLaunch(SAMPLE).args
    const writer = claudeWriterLaunch(SAMPLE).args
    argvs = [worker, claudeLaunch(WEB_SAMPLE).args, claudeReviewLaunch(REVIEW_SAMPLE).args, writer, claudeResume(worker) ?? [], claudeResume(writer) ?? []]
  } else if (surface === 'resume') {
    argvs = [SAMPLE, WEB_SAMPLE].map((t) => codexResume(codexLaunch(t).args, 't', '/r/o') ?? [])
    argvs.push(codexResume(codexReviewLaunch(REVIEW_SAMPLE).args, 't', '/r/o') ?? [])
    argvs.push(codexResume(codexWriterLaunch(SAMPLE).args, 't', '/r/o') ?? [])
  } else {
    argvs = [codexLaunch(SAMPLE).args, codexLaunch(WEB_SAMPLE).args, codexReviewLaunch(REVIEW_SAMPLE).args, codexWriterLaunch(SAMPLE).args]
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

export const defaultExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' }
}

/** Familias cuya CLI responde en PATH. */
export function detectClis(exec: Exec = defaultExec): Family[] {
  return (['claude', 'codex'] as Family[]).filter((family) => exec(family, ['--version']).status !== null)
}

const versionOf = (text: string): string | null => /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null

/**
 * Si la versión `a` es anterior a `b`, comparando el primer `mayor.menor.parche` de cada una: un sufijo de
 * prerelease no cuenta. Sin un triplete en alguna de las dos, no se comparan.
 */
export function olderVersion(a: string, b: string): boolean {
  const left = versionOf(a)?.split('.').map(Number)
  const right = versionOf(b)?.split('.').map(Number)
  if (!left || !right) return false
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i]
  }
  return false
}

/** La versión `mayor.menor.parche` que informa `<family> --version`, o `null` si no informa ninguna. */
export function cliVersion(exec: Exec, family: Family): string | null {
  return versionOf(exec(family, ['--version']).stdout)
}

/**
 * Contrato con los CLIs instalados: están en PATH y aceptan cada flag que emite sdd-ai. Con las copias
 * de la skill, también que coincidan con su fuente.
 */
export function doctor(exec: Exec = defaultExec, skill?: SkillCheck): { ok: boolean; clis: CliReport[]; skill?: SkillReport } {
  const clis = (['claude', 'codex'] as Family[]).map((family): CliReport => {
    const v = exec(family, ['--version'])
    if (v.status === null) return { family, inPath: false, flags: [] }
    const flags = checkFlags(exec(family, HELP_ARGS[family]).stdout, emittedFlags(family))
    if (family === 'codex') {
      const resume = checkFlags(exec(family, CODEX_RESUME_HELP_ARGS).stdout, emittedFlags(family, 'resume'))
      flags.push(...resume.map((r) => ({ flag: `resume ${r.flag}`, present: r.present })))
    }
    const report: CliReport = { family, inPath: true, flags }
    const version = versionOf(v.stdout)
    if (version) report.version = version
    return report
  })
  const cliOk = clis.every((c) => c.inPath && c.flags.every((f) => f.present))
  if (!skill) return { ok: cliOk, clis }
  if ('skipped' in skill) return { ok: cliOk, clis, skill }
  const skillOk = skill.copies.every((c) => c.state === 'ok')
  return { ok: cliOk && skillOk, clis, skill: skillOk ? skill : { ...skill, next: './bin/sdd-ai agents sync' } }
}
