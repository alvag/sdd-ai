import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Regla conservadora: el acceso al filesystem debe estar expresado mediante imports nombrados. */
function filesystemViolations(source: string): string[] {
  const violations: string[] = []
  if (/['"](?:node:)?(?:fs\/promises|worker_threads)['"]/.test(source)) violations.push('promesas o hilos de trabajo')
  if (/\b(?:import|require)\s*\(\s*['"](?:node:)?fs['"]/.test(source)) violations.push('filesystem importado dinámicamente')
  // Toda cláusula de import de `fs`, también las mixtas (`fs, { readFile }`, `fs, * as ns`) y las de varias líneas: lo que
  // no es la lista de nombrados (un import predeterminado o un namespace) es una violación.
  const imports = /\bimport\s+(type\s+)?((?:(?!\bimport\b)[^'";])*?)\s*\bfrom\s*['"](?:node:)?fs['"]/g
  for (const match of source.matchAll(imports)) {
    if (match[1]) continue
    const clause = match[2]
    const named = /\{([^}]*)\}/.exec(clause)
    if (clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim() !== '') violations.push('filesystem sin imports nombrados')
    for (const part of named?.[1].split(',') ?? []) {
      const name = part.trim()
      if (!name || name.startsWith('type ')) continue
      const imported = name.split(/\s+as\s+/)[0]
      if (!imported.endsWith('Sync') && imported !== 'constants') violations.push(`filesystem no sincrónico: ${imported}`)
    }
  }
  if (/\bexport\s+[^;\n]*\bfrom\s*['"](?:node:)?fs['"]/.test(source)) violations.push('reexportación de filesystem')
  return violations
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

test('source has no asynchronous filesystem calls or worker threads that a synchronous working directory change could redirect', () => {
  const violations = sources(join(import.meta.dirname, '..', 'src')).flatMap((path) =>
    filesystemViolations(readFileSync(path, 'utf8')).map((detail) => `${path}: ${detail}`))
  assert.deepEqual(violations, [])
})

test('filesystem source guard rejects asynchronous aliases dynamic imports namespaces and worker threads', () => {
  for (const source of [
    "import { readFile } from 'node:fs'", "import { readFile as read } from 'node:fs'",
    "import fs from 'node:fs'", "import * as fs from 'node:fs'", "import('node:fs')",
    "require('node:fs')", "import { readFile } from 'node:fs/promises'",
    "import { Worker } from 'node:worker_threads'", "export * from 'node:fs'",
    // Las formas mixtas: un predeterminado o un namespace junto a nombrados, sincrónicos o no.
    "import fs, { readFile } from 'node:fs'", "import fs, { readFileSync } from 'node:fs'", "import fs,{readFile}from'fs'",
    "import fs, * as ns from 'node:fs'", "import { default as fs } from 'node:fs'",
    "import {\n  readFileSync,\n  readFile,\n} from 'node:fs'",
  ]) assert.ok(filesystemViolations(source).length > 0, source)
  assert.deepEqual(filesystemViolations("import fs, { readFile } from 'node:fs'"), ['filesystem sin imports nombrados', 'filesystem no sincrónico: readFile'])
  assert.deepEqual(filesystemViolations("import { type Stats, readFileSync as read, constants } from 'node:fs'"), [])
  assert.deepEqual(filesystemViolations("import {\n  readFileSync,\n  type Stats,\n} from 'node:fs'"), [])
  assert.deepEqual(filesystemViolations("import type { Stats } from 'node:fs'"), [])
  assert.deepEqual(filesystemViolations("import { join } from 'node:path'\nimport { readFileSync } from 'node:fs'"), [])
  assert.deepEqual(filesystemViolations("// import de abajo\nimport { readFileSync } from 'node:fs'"), [])
})
