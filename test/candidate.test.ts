import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Candidate, freeze, freezeStable, readContext } from '../src/review/candidate.ts'
import { SddError } from '../src/types.ts'
import { makeRepo } from './helpers.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const lines = (n: number, prefix = 'línea') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')

/** Repo con una base commiteada: a.txt (20 líneas), b.txt (5), c.txt (3) y bin.dat (binario). */
function repoWithBase(): { repo: string; base: string } {
  const repo = makeRepo()
  writeFileSync(join(repo, 'a.txt'), lines(20))
  writeFileSync(join(repo, 'b.txt'), lines(5, 'b'))
  writeFileSync(join(repo, 'c.txt'), lines(3, 'c'))
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  return { repo, base: git(repo, 'rev-parse', 'HEAD') }
}

const file = (c: Candidate, path: string) => c.files.find((f) => f.path === path)

test('un archivo modificado es M y solo son visibles las líneas del lado nuevo de sus hunks', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 10\n', 'línea diez\n'))
  const c = freeze(repo, { base, context: [] })
  const a = file(c, 'a.txt')
  assert.deepEqual([a?.status, a?.visible, a?.lines, a?.binary], ['M', [[7, 13]], 20, false])
  assert.equal(a?.sha256, sha(lines(20).replace('línea 10\n', 'línea diez\n')))
  assert.equal(c.base_sha, base)
  assert.equal(c.head_sha, null)
})

test('un archivo agregado con add -N entra completo; uno sin agregar queda en left_out', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'nuevo.txt'), lines(3, 'n'))
  writeFileSync(join(repo, 'suelto.txt'), 'no agregado\n')
  git(repo, 'add', '-N', 'nuevo.txt')
  const c = freeze(repo, { base, context: [] })
  assert.deepEqual([file(c, 'nuevo.txt')?.status, file(c, 'nuevo.txt')?.visible], ['A', [[1, 3]]])
  assert.equal(file(c, 'suelto.txt'), undefined)
  assert.deepEqual(c.left_out, ['suelto.txt'])
})

test('un borrado es D con las líneas de su versión base visibles', () => {
  const { repo, base } = repoWithBase()
  rmSync(join(repo, 'b.txt'))
  const b = file(freeze(repo, { base, context: [] }), 'b.txt')
  assert.deepEqual([b?.status, b?.lines, b?.visible, b?.sha256], ['D', 5, [[1, 5]], sha(lines(5, 'b'))])
})

test('un binario entra sin bytes y sin líneas citables', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 255]))
  const c = freeze(repo, { base, context: [] })
  const bin = file(c, 'bin.dat')
  assert.deepEqual([bin?.binary, bin?.visible, bin?.lines], [true, [], 0])
  assert.equal(bin?.sha256, sha(Buffer.from([0, 9, 9, 9, 0, 255])))
  assert.match(c.diff, /Binary files a\/bin\.dat and b\/bin\.dat differ/)
})

test('un renombre es R con la ruta anterior', () => {
  const { repo, base } = repoWithBase()
  git(repo, 'mv', 'c.txt', 'd.txt')
  const d = file(freeze(repo, { base, context: [] }), 'd.txt')
  assert.deepEqual([d?.status, d?.from], ['R', 'c.txt'])
})

test('con head congela el diff entre commits y lee el contenido del commit, no del árbol', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(21))
  git(repo, 'commit', '-qam', 'cambio')
  const head = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'otra cosa en el árbol\n')
  writeFileSync(join(repo, 'suelto.txt'), 'x\n')
  const c = freeze(repo, { base, head: 'HEAD', context: [] })
  assert.equal(c.head_sha, head)
  assert.deepEqual(c.left_out, [])
  assert.equal(file(c, 'a.txt')?.sha256, sha(lines(21)))
})

test('el contexto entra con su hash; una ruta fuera del repo se rechaza', () => {
  const { repo, base } = repoWithBase()
  mkdirSync(join(repo, '.plans'))
  writeFileSync(join(repo, '.plans', 'spec.md'), '# Spec\n\nAC-1\n')
  const c = freeze(repo, { base, context: ['.plans/spec.md'] })
  assert.deepEqual(c.context, [{ path: '.plans/spec.md', sha256: sha('# Spec\n\nAC-1\n'), lines: 3 }])
  assert.equal(readContext(repo, c).get('.plans/spec.md'), '# Spec\n\nAC-1\n')
  assert.throws(() => freeze(repo, { base, context: ['/etc/hosts'] }), (e: unknown) => e instanceof SddError && e.code === 'usage')
})

test('un contexto que es un symlink hacia fuera del repo se rechaza', () => {
  const { repo, base } = repoWithBase()
  const outside = join(mkdtempSync(join(tmpdir(), 'sdd-ai-fuera-')), 'ajeno.md')
  writeFileSync(outside, 'fuera del repo\n')
  symlinkSync(outside, join(repo, 'ctx.md'))
  assert.throws(() => freeze(repo, { base, context: ['ctx.md'] }), (e: unknown) => e instanceof SddError && e.code === 'usage')
})

test('el hash no cambia si nada cambia y cambia si cambia un byte', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 1\n', 'línea uno\n'))
  const h1 = freeze(repo, { base, context: [] }).hash
  assert.match(h1, /^sha256:[0-9a-f]{64}$/)
  assert.equal(freeze(repo, { base, context: [] }).hash, h1)
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 1\n', 'línea uno!\n'))
  assert.notEqual(freeze(repo, { base, context: [] }).hash, h1)
})

test('un cambio de modo cambia el hash aunque el contenido sea el mismo', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 1\n', 'línea uno\n'))
  const before = freeze(repo, { base, context: [] })
  chmodSync(join(repo, 'a.txt'), 0o755)
  const after = freeze(repo, { base, context: [] })
  assert.notEqual(before.diff, after.diff)
  assert.notEqual(before.hash, after.hash)
})

test('la config Git del usuario no cambia el hash ni las rutas', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 5\n', 'línea cinco\n'))
  const before = freeze(repo, { base, context: [] })
  git(repo, 'config', 'diff.noprefix', 'true')
  git(repo, 'config', 'color.ui', 'always')
  const after = freeze(repo, { base, context: [] })
  assert.equal(after.hash, before.hash)
  assert.deepEqual(after.files.map((f) => f.path), before.files.map((f) => f.path))
  assert.equal(after.diff, before.diff)
})

test('un symlink se congela como el texto de su enlace', () => {
  const { repo, base } = repoWithBase()
  symlinkSync('a.txt', join(repo, 'enlace'))
  git(repo, 'add', 'enlace')
  assert.equal(file(freeze(repo, { base, context: [] }), 'enlace')?.sha256, sha('a.txt'))
})

test('una captura inestable da candidate_unstable', () => {
  const { repo, base } = repoWithBase()
  let n = 0
  const unstable = (root: string, sel: { base: string; context: string[] }) => ({ ...freeze(root, sel), hash: `sha256:${String(n++).padStart(64, '0')}` })
  assert.throws(() => freezeStable(repo, { base, context: [] }, unstable), (e: unknown) => e instanceof SddError && e.code === 'candidate_unstable')
  assert.equal(freezeStable(repo, { base, context: [] }).base_sha, base)
})

test('un contexto que cambió después de congelar da candidate_unstable al leerlo', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'ctx.md'), 'uno\n')
  const c = freeze(repo, { base, context: ['ctx.md'] })
  writeFileSync(join(repo, 'ctx.md'), 'dos\n')
  assert.throws(() => readContext(repo, c), (e: unknown) => e instanceof SddError && e.code === 'candidate_unstable')
})
