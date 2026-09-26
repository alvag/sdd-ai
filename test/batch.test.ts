import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lotTargets, planBatches, sliceCandidate } from '../src/review/batch.ts'
import { type Candidate, type CandidateFile, freeze } from '../src/review/candidate.ts'
import type { LedgerEntry, Target } from '../src/review/ledger.ts'
import { SddError } from '../src/types.ts'
import { makeRepo } from './helpers.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

const fileOf = (path: string, more: Partial<CandidateFile> = {}): CandidateFile =>
  ({ path, status: 'M', mode: '100644', sha256: 'x', binary: false, lines: 5, visible: [[1, 5]], ...more })

/** Una medición sintética: la base del prompt, más cada archivo, más los pendientes sin archivo en el primer lote. */
function measurer(sizes: Record<string, number>, base = 10, orphans = 0) {
  return (paths: string[], first: boolean) => base + paths.reduce((t, p) => t + sizes[p], 0) + (first ? orphans : 0)
}
const plan = (sizes: Record<string, number>, budget = 100, base = 10, orphans = 0) =>
  planBatches(Object.keys(sizes).map((p) => fileOf(p)), measurer(sizes, base, orphans), budget, (p) => sizes[p] * 2)

test('el mismo candidato da siempre los mismos lotes', () => {
  const sizes = { 'd/2.ts': 30, 'c/1.ts': 60, 'd/1.ts': 30 }
  const once = plan(sizes)
  assert.deepEqual(once, [['c/1.ts'], ['d/1.ts', 'd/2.ts']], 'd/1.ts cabría junto a c/1.ts, pero su directorio va entero al lote siguiente')
  const reordered = planBatches(['d/1.ts', 'c/1.ts', 'd/2.ts'].map((p) => fileOf(p)), measurer(sizes), 100, () => 0)
  assert.deepEqual(reordered, once)
})

test('un directorio que no entra se divide por orden de ruta', () => {
  assert.deepEqual(plan({ 'a/z.ts': 40, 'a/x.ts': 40, 'b/w.ts': 20, 'a/y.ts': 40 }),
    [['a/x.ts', 'a/y.ts'], ['a/z.ts', 'b/w.ts']])
})

test('cada archivo cae en exactamente un lote', () => {
  const sizes: Record<string, number> = {}
  for (let i = 0; i < 40; i++) sizes[`dir${i % 5}/f${i}.ts`] = 5 + ((i * 37) % 60)
  const lots = plan(sizes, 100, 10)
  assert.ok(lots.length > 1)
  const seen = lots.flat()
  assert.deepEqual([...seen].sort(), Object.keys(sizes).sort())
  assert.equal(new Set(seen).size, seen.length)
  for (const [i, lot] of lots.entries()) assert.ok(measurer(sizes)(lot, i === 0) <= 100, `el lote ${i + 1} entra`)
})

test('si todo entra hay un solo lote', () => {
  assert.deepEqual(plan({ 'b.ts': 20, 'a.ts': 20, 'x/c.ts': 20 }), [['a.ts', 'b.ts', 'x/c.ts']])
})

test('un archivo que no entra solo da prompt_too_large con su ruta y sus bytes', () => {
  assert.throws(() => plan({ 'a.ts': 20, 'grande.ts': 200 }), (e: unknown) => {
    assert.ok(e instanceof SddError)
    assert.deepEqual([e.code, e.message], ['prompt_too_large', 'el archivo grande.ts no entra solo en el presupuesto'])
    assert.equal(e.detail, 'grande.ts: su sección numerada mide 400 bytes; el prompt con ese archivo solo mide 210 > 100')
    assert.match(e.next ?? '', /saca del cambio o lo revisa por fuera de review/)
    assert.doesNotMatch(e.next ?? '', /más chico/)
    return true
  })
})

test('el contexto solo que no entra da prompt_too_large', () => {
  assert.throws(() => plan({ 'a.ts': 20 }, 100, 150), (e: unknown) => {
    assert.ok(e instanceof SddError)
    assert.deepEqual([e.code, e.message, e.detail], ['prompt_too_large', 'el contexto solo no entra en el presupuesto', '150 > 100'])
    return true
  })
})

test('un primer lote sin archivos lleva solo los pendientes huérfanos', () => {
  const lots = plan({ 'a/1.ts': 50, 'b/1.ts': 50 }, 100, 10, 60)
  assert.deepEqual(lots, [[], ['a/1.ts'], ['b/1.ts']])
})

test('sliceCandidate conserva el hash y el contexto y recorta el diff', () => {
  const repo = makeRepo()
  mkdirSync(join(repo, 'x'))
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'x', 'b.txt'), 'b\n')
  writeFileSync(join(repo, 'spec.md'), '# spec\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'a2\n')
  writeFileSync(join(repo, 'x', 'b.txt'), 'b2\n')
  const c = freeze(repo, { base, context: ['spec.md'] })
  const view = sliceCandidate(c, ['x/b.txt'])
  assert.deepEqual([view.hash, view.base_sha, view.head_sha, view.context, view.left_out], [c.hash, c.base_sha, c.head_sha, c.context, c.left_out])
  assert.deepEqual(view.files.map((f) => f.path), ['x/b.txt'])
  assert.match(view.diff, /^diff --git a\/x\/b\.txt b\/x\/b\.txt$/m)
  assert.doesNotMatch(view.diff, /a\.txt b\/a\.txt/)
  assert.ok(c.diff.includes(view.diff))
})

const entry = (id: string, location: string): LedgerEntry => ({
  id, round: 1, state: 'aceptado', axis: 'quality', severity: 'CRITICAL', location, claim: 'x', responses: [],
})
const candidate: Candidate = {
  base_sha: 'b', head_sha: null, hash: 'h', left_out: [], diff: '',
  files: [fileOf('a/x.ts'), fileOf('b/y.ts'), fileOf('nuevo.ts', { status: 'R', from: 'viejo.ts' })],
  context: [{ path: 'spec.md', sha256: 's', lines: 3 }],
}
const ids = (t: Target[]) => t.map((x) => x.id)

test('la ronda N en lotes lleva cada pendiente al lote de su archivo', () => {
  const entries = [entry('F-1', 'a/x.ts:2'), entry('F-2', 'b/y.ts:1-3')]
  const targets: Target[] = [{ id: 'F-1', kind: 'verify' }, { id: 'F-2', kind: 'respond' }]
  assert.deepEqual(ids(lotTargets(targets, entries, candidate, ['a/x.ts'], true)), ['F-1'])
  assert.deepEqual(ids(lotTargets(targets, entries, candidate, ['b/y.ts'], false)), ['F-2'])
})

test('ronda N: un pendiente de un archivo renombrado va al lote de la ruta nueva', () => {
  const entries = [entry('F-1', 'viejo.ts:4')]
  const targets: Target[] = [{ id: 'F-1', kind: 'verify' }]
  assert.deepEqual(ids(lotTargets(targets, entries, candidate, ['nuevo.ts'], false)), ['F-1'])
  assert.deepEqual(ids(lotTargets(targets, entries, candidate, ['a/x.ts'], true)), [])
})

test('ronda N: un pendiente de contexto o de un archivo que ya no está va al primer lote', () => {
  const entries = [entry('F-1', 'spec.md:1'), entry('F-2', 'borrado.ts:2'), entry('F-3', 'a/x.ts:1')]
  const targets: Target[] = [{ id: 'F-1', kind: 'respond' }, { id: 'F-2', kind: 'verify' }, { id: 'F-3', kind: 'verify' }]
  assert.deepEqual(ids(lotTargets(targets, entries, candidate, ['b/y.ts'], true)), ['F-1', 'F-2'])
  assert.deepEqual(ids(lotTargets(targets, entries, candidate, [], true)), ['F-1', 'F-2'])
  assert.deepEqual(ids(lotTargets(targets, entries, candidate, ['a/x.ts'], false)), ['F-3'])
})
