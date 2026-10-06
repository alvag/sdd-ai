import type { FsStat } from 'claude-code'
import type { On } from 'claude-code'
import { World } from './band-world'

export const PROJECTS = '/home/max/.claude/projects'
export const PERSISTED = `${PROJECTS}/checkout/session/tool-results/result.txt`
export const physicalStat = (realPath: string, kind: FsStat['kind'] = 'file', size = 100): FsStat => ({ realPath, kind, size, isLink: false, mtimeMs: 1 })
export const savedResponse = (path = PERSISTED, size = 100) => ({ ref: 42, text: 'recorte original',
  result: { stdout: 'recorte', stderr: '', interrupted: false, persistedOutputPath: path, persistedOutputSize: size } })
export const completeOutput = (rows: number) => ({ state: 'done', code: 'review_status', message: 'Estado observado',
  next: { step: 'review' }, ledger: Array.from({ length: rows }, (_, i) => ({ id: `F-${i}`, severity: 'BUG', reviewer: 'base', state: 'abierto', claim: `Hallazgo ${i}: ${'detalle '.repeat(20)}` })) })

export class PersistedWorld extends World {
  config: string | undefined
  home = '/home/max'
  readonly environment: string[] = []
  override install(on: On): void {
    super.install(on)
    on('env.get', (_$, e) => {
      this.environment.push(e.name)
      if (e.name !== 'HOME' && e.name !== 'CLAUDE_CONFIG_DIR') throw new Error('Variable ajena a la lectura guardada')
      return { value: e.name === 'HOME' ? this.home : this.config }
    })
  }
  saved(path: string, content: string, realPath = path, size?: number): void {
    this.entries.set(path, { kind: 'file', text: content, realPath, size })
  }
}
