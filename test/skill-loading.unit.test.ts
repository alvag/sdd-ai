import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPECTED_SKILL_FILES, skillLinks } from './skill-fixture.ts'

const root = join(import.meta.dirname, '..')

test('el bootstrap modular cubre Step y resuelve todos sus procedimientos y apoyos', () => {
  const bootstrap = readFileSync(join(root, 'skills/sdd-ai/SKILL.md'), 'utf8')
  const status = readFileSync(join(root, 'src/sdd/status.ts'), 'utf8')
  const step = status.match(/export const STEPS = \[([\s\S]*?)\] as const/)
  assert.ok(step)
  const steps = [...step[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()
  const expected: Record<string, string> = {
    no_artifacts: 'start', depth: 'start', resolve_blockers: 'recovery', specify: 'specify', branch: 'branch', plan: 'plan', tasks: 'tasks',
    gate: 'approvals', external_gate: 'approvals', implement: 'implement', verify: 'verify', review_and_commit: 'review-and-commit', push: 'close', open_pr: 'close', archive: 'close',
  }
  const actual: Record<string, string> = {}
  for (const row of bootstrap.matchAll(/^\| ([a-z_, ]+) \| \[[^\]]+\]\(procedures\/([^.)]+)\.md\) \|$/gm)) {
    for (const name of row[1].split(', ')) {
      assert.equal(actual[name], undefined, `step duplicado: ${name}`)
      actual[name] = row[2]
    }
  }
  assert.deepEqual(Object.keys(actual).sort(), steps)
  assert.deepEqual(actual, expected)
  const linked = new Set(skillLinks('SKILL.md', bootstrap))
  for (const path of EXPECTED_SKILL_FILES) {
    const text = readFileSync(join(root, 'skills/sdd-ai', path), 'utf8')
    if (path !== 'SKILL.md') assert.match(text, /Apoyos:/, path)
    for (const target of skillLinks(path, text)) {
      assert.ok(!target.startsWith('../') && !target.startsWith('/'), `${path}: ${target} sale de la skill`)
      assert.ok(EXPECTED_SKILL_FILES.includes(target), `${path}: destino desconocido ${target}`)
      assert.ok(readFileSync(join(root, 'skills/sdd-ai', target)).length > 0)
      linked.add(target)
    }
  }
  assert.deepEqual([...linked].sort(), EXPECTED_SKILL_FILES.filter((path) => path !== 'SKILL.md').slice().sort())
  // Sin cuerpos detallados, contratos JSON, esquemas ni catálogos del monolito.
  assert.doesNotMatch(bootstrap, /## [1-9]\.|### Decidir cada hallazgo|sdd-ai-findings-template|```|known_facts|approval_contradicted/)
  for (const phrase of ['sdd status <id>', 'Al empezar o retomar', 'después de recibir', 'lee explícitamente', 'next.step', 'next.command', 'next.detail', '`wait`', '--context', 'Los bloqueos detienen', 'no reconstruyas', 'step desconocido', 'material ausente', 'no concede permisos', 'cese comprobado y la cosecha', 'sesión nueva']) assert.ok(bootstrap.includes(phrase), phrase)
  for (const operation of ['run', 'review', 'init', 'prune', 'recall']) assert.ok(bootstrap.includes('`'+operation+'`'))
})
