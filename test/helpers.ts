import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Ejecutable `claude` o `codex` en `dir` que delega en el CLI falso de los tests. */
export function makeFakeBin(dir: string, name: 'claude' | 'codex'): void {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, 'fake-cli.ts')}" "$@"\n`)
  chmodSync(file, 0o755)
}

/** Repo Git vacío en un directorio temporal (ruta real, sin el symlink de /var en macOS). */
export function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-repo-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}
