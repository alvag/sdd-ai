import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'

/** Expectativa independiente del inventario de producción. */
export const EXPECTED_SKILL_FILES: readonly string[] = [
  'SKILL.md',
  'procedures/start.md',
  'procedures/recovery.md',
  'procedures/specify.md',
  'procedures/branch.md',
  'procedures/plan.md',
  'procedures/tasks.md',
  'procedures/approvals.md',
  'procedures/implement.md',
  'procedures/verify.md',
  'procedures/review-and-commit.md',
  'procedures/close.md',
  'references/dispatch.md',
  'references/adoption.md',
  'references/reception.md',
  'references/document-phases.md',
  'references/document-revision.md',
  'references/artifact-review.md',
  'references/diff-review.md',
  'references/writer.md',
  'references/errors.md',
  'references/hooks.md',
  'references/init.md',
  'references/prune.md',
  'references/recall.md',
  'references/findings.md',
  'references/mod.md',
]
const SOURCE_ROOT = join(import.meta.dirname, '..')

export const installedSkillPath = (family: 'claude' | 'codex', path = 'SKILL.md'): string =>
  `${family === 'claude' ? '.claude' : '.agents'}/skills/sdd-ai/${path}`

export function writeSkillFile(root: string, path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), bytes)
}

export function copySkillSource(root: string, source = SOURCE_ROOT): void {
  for (const path of EXPECTED_SKILL_FILES) writeSkillFile(root, `skills/sdd-ai/${path}`, readFileSync(join(source, 'skills/sdd-ai', path)))
}

export function installSkillFixture(root: string, source = SOURCE_ROOT, families: readonly ('claude' | 'codex')[] = ['claude', 'codex']): void {
  for (const family of families) for (const path of EXPECTED_SKILL_FILES) {
    writeSkillFile(root, installedSkillPath(family, path), readFileSync(join(source, 'skills/sdd-ai', path)))
  }
}

export function installMonolithicSkill(root: string): void {
  for (const family of ['claude', 'codex'] as const) {
    const dir = dirname(join(root, installedSkillPath(family)))
    rmSync(dir, { recursive: true, force: true })
    writeSkillFile(root, installedSkillPath(family), '---\nname: sdd-ai\ndescription: copia monolítica anterior\n---\n# Procedimientos anteriores\n')
  }
}

export function damageSkillFile(root: string, path: string, damage: 'missing' | 'stale' | 'unreadable'): void {
  const file = join(root, path)
  if (damage === 'stale') writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\ncambio real\n')]))
  else {
    rmSync(file, { recursive: true, force: true })
    if (damage === 'unreadable') mkdirSync(file, { recursive: true })
  }
}

export function skillBytes(root: string, prefix = 'skills/sdd-ai'): Record<string, string> {
  return Object.fromEntries(EXPECTED_SKILL_FILES.map((path) => [path, readFileSync(join(root, prefix, path)).toString('base64')]))
}

/** Resuelve enlaces desde el documento que los contiene; nunca desde el checkout fuente. */
export function skillLinks(path: string, text: string): string[] {
  return [...text.matchAll(/\[[^\]\n]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].split('#')[0])
    .filter((link) => link && !/^[a-z]+:|^#/.test(link))
    .map((link) => posix.normalize(posix.join(posix.dirname(path), link)))
}
