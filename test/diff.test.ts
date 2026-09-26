import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Candidate, freeze } from '../src/review/candidate.ts'
import { addedLines, numbered, sections } from '../src/review/diff.ts'
import { makeRepo } from './helpers.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
const lines = (n: number, prefix = 'línea') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')

/** Un candidato con un archivo de cada forma que Git imprime distinto. */
function mixed(): Candidate {
  const repo = makeRepo()
  writeFileSync(join(repo, 'a.txt'), lines(20))
  writeFileSync(join(repo, 'b.txt'), lines(3, 'b'))
  writeFileSync(join(repo, 'c.txt'), lines(6, 'c'))
  writeFileSync(join(repo, 'r.txt'), lines(7, 'r'))
  writeFileSync(join(repo, 'm.sh'), 'echo\n')
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2]))
  symlinkSync('a.txt', join(repo, 'enlace'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 10\n', 'línea diez\n'))
  rmSync(join(repo, 'b.txt'))
  git(repo, 'mv', 'c.txt', 'd.txt')
  git(repo, 'mv', 'r.txt', 's.txt')
  writeFileSync(join(repo, 's.txt'), lines(7, 'r').replace('r 4\n', 'r cuatro\n'))
  chmodSync(join(repo, 'm.sh'), 0o755)
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 9, 2]))
  rmSync(join(repo, 'enlace'))
  writeFileSync(join(repo, 'enlace'), 'ahora es un archivo\n')
  writeFileSync(join(repo, 'n.txt'), lines(2, 'n'))
  git(repo, 'add', '-N', 'n.txt')
  return freeze(repo, { base, context: [] })
}

test('las secciones reconstruyen el diff byte a byte', () => {
  const c = mixed()
  assert.equal(sections(c.diff, c.files).map((s) => s.text).join(''), c.diff)
})

test('cada archivo del candidato tiene exactamente una sección', () => {
  const c = mixed()
  const paths = sections(c.diff, c.files).map((s) => s.path)
  assert.deepEqual([...paths].sort(), c.files.map((f) => f.path).sort())
  const enlace = sections(c.diff, c.files).find((s) => s.path === 'enlace')
  assert.equal(enlace?.text.split('\ndiff --git ').length, 2, 'un cambio de tipo une sus dos secciones')
  assert.throws(() => sections(c.diff, c.files.filter((f) => f.path !== 'a.txt')), /el diff no tiene una sección por archivo: diff --git a\/a\.txt b\/a\.txt/)
  assert.throws(() => sections(c.diff, [...c.files, { ...c.files[0], path: 'otro.txt' }]), /el diff no tiene una sección por archivo: otro\.txt/)
})

test('una ruta que Git cita tiene su sección', () => {
  const repo = makeRepo()
  const tab = 'con\ttab.txt'
  writeFileSync(join(repo, 'a"b.txt'), 'uno\n')
  writeFileSync(join(repo, tab), 'uno\n')
  writeFileSync(join(repo, 'ñandú.txt'), 'uno\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  for (const p of ['a"b.txt', tab, 'ñandú.txt']) writeFileSync(join(repo, p), 'dos\n')
  const c = freeze(repo, { base, context: [] })
  assert.match(c.diff, /^diff --git "a\/a\\"b\.txt" "b\/a\\"b\.txt"$/m)
  assert.match(c.diff, /^diff --git "a\/con\\ttab\.txt" "b\/con\\ttab\.txt"$/m)
  const s = sections(c.diff, c.files)
  assert.deepEqual(s.map((x) => x.path).sort(), ['a"b.txt', tab, 'ñandú.txt'].sort())
  assert.equal(s.map((x) => x.text).join(''), c.diff)
})

test('numera un hunk con el lado nuevo, y deja en blanco las quitadas y los encabezados', () => {
  const c = mixed()
  const a = sections(c.diff, c.files).find((s) => s.path === 'a.txt')?.text ?? ''
  const out = numbered(a, false).split('\n')
  assert.equal(out.at(-1), '', 'conserva el salto final')
  assert.ok(out[0].startsWith('  │diff --git a/a.txt b/a.txt'))
  assert.ok(out.some((l) => l.startsWith('  │@@ -7,7 +7,7 @@')))
  assert.ok(out.includes(' 7│ línea 7'))
  assert.ok(out.includes('  │-línea 10'))
  assert.ok(out.includes('10│+línea diez'))
  assert.ok(out.includes('13│ línea 13'))
  assert.equal(out.map((l) => l.slice(l.indexOf('│') + 1)).join('\n'), a, 'después de │ va la línea original')
})

test('addedLines lista las agregadas con su número y no toma el +++', () => {
  const c = mixed()
  const by = (p: string) => sections(c.diff, c.files).find((s) => s.path === p)?.text ?? ''
  assert.deepEqual(addedLines(by('a.txt')), [{ line: 10, text: 'línea diez' }])
  assert.deepEqual(addedLines(by('n.txt')), [{ line: 1, text: 'n 1' }, { line: 2, text: 'n 2' }])
  assert.deepEqual(addedLines(by('b.txt')), [])
  assert.deepEqual(addedLines(by('enlace')), [{ line: 1, text: 'ahora es un archivo' }])
  assert.deepEqual(addedLines(by('m.sh')), [])
})
