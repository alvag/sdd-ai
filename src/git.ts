import { execFileSync } from 'node:child_process'
import { SddError } from './types.ts'

/** Raíz del árbol de trabajo actual; en un worktree, la de ese worktree. */
export function repoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    throw new SddError('not_a_repo', `${cwd} no está dentro de un repositorio Git`, {
      detail: (e as { stderr?: string }).stderr?.trim(),
      next: 'corre sdd-ai desde un repositorio Git',
    })
  }
}
