import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Candidate, changedRanges, freeze, freezeStable, readContext, readContextBlobs, snapshot, stillChanged } from '../src/review/candidate.ts'
import { renderMaterial } from '../src/review/prompt.ts'
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

/** Congela la ronda y guarda sus blobs en `dir`, como hace cada ronda de una revisión. */
function round(repo: string, base: string, dir: string, head?: string): Candidate {
  const c = freeze(repo, { base, ...(head ? { head } : {}), context: [] })
  snapshot(repo, c, dir)
  return c
}
const runDir = () => mkdtempSync(join(tmpdir(), 'sdd-ai-run-'))

test('snapshot guarda los bytes de cada archivo por su hash; un borrado, con los de la base', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(21))
  rmSync(join(repo, 'b.txt'))
  const dir = runDir()
  const c = round(repo, base, dir)
  assert.equal(readFileSync(join(dir, 'blobs', sha(lines(21))), 'utf8'), lines(21))
  assert.equal(readFileSync(join(dir, 'blobs', sha(lines(5, 'b'))), 'utf8'), lines(5, 'b'))
  assert.equal(c.files.length, 2)
})

test('snapshot da candidate_unstable si un archivo cambió después de congelarse', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(21))
  const c = freeze(repo, { base, context: [] })
  writeFileSync(join(repo, 'a.txt'), lines(22))
  const dir = runDir()
  assert.throws(() => snapshot(repo, c, dir), (e: unknown) => e instanceof SddError && e.code === 'candidate_unstable')
  assert.equal(existsSync(join(dir, 'blobs', sha(lines(22)))), false)
})

test('changedRanges: solo las líneas añadidas o sustituidas entre candidatos, sin el contexto de los hunks', () => {
  const { repo, base } = repoWithBase()
  const dir = runDir()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 3\n', 'línea tres\n'))
  writeFileSync(join(repo, 'b.txt'), lines(5, 'b').replace('b 2\n', 'b dos\n'))
  const prev = round(repo, base, dir)
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 3\n', 'línea tres\n').replace('línea 12\n', 'línea doce\nextra\n'))
  const next = round(repo, base, dir)
  assert.deepEqual(changedRanges(prev, next, dir), { 'a.txt': [[12, 13]] })
})

test('stillChanged: conserva solo líneas distintas de la base y las rutas binarias', () => {
  const { repo, base } = repoWithBase()
  const dir = runDir()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 3\n', 'tres\n').replace('línea 12\n', 'doce\n'))
  writeFileSync(join(repo, 'b.txt'), 'otra versión\n')
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 7, 0]))
  const prev = round(repo, base, dir)
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 12\n', 'doce corregida\nextra\n'))
  writeFileSync(join(repo, 'b.txt'), lines(5, 'b'))
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 8, 0]))
  const next = round(repo, base, dir)
  const changed = changedRanges(prev, next, dir)
  assert.deepEqual(stillChanged({ ...changed, 'b.txt': [[1, 5]] }, next), { 'a.txt': [[12, 13]], 'bin.dat': 'binary' })
})

test('changedRanges: un archivo nuevo o que antes estaba borrado cambia entero', () => {
  const { repo, base } = repoWithBase()
  const dir = runDir()
  rmSync(join(repo, 'b.txt'))
  const prev = round(repo, base, dir)
  writeFileSync(join(repo, 'b.txt'), lines(6, 'b'))
  writeFileSync(join(repo, 'nuevo.txt'), lines(2, 'n'))
  git(repo, 'add', '-N', 'nuevo.txt')
  const next = round(repo, base, dir)
  assert.deepEqual(changedRanges(prev, next, dir), { 'b.txt': [[1, 6]], 'nuevo.txt': [[1, 2]] })
})

test('changedRanges: un binario que cambió se cita por ruta; un borrado en la ronda nueva no deja entrada', () => {
  const { repo, base } = repoWithBase()
  const dir = runDir()
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 7, 0]))
  writeFileSync(join(repo, 'c.txt'), lines(4, 'c'))
  const prev = round(repo, base, dir)
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 8, 0]))
  rmSync(join(repo, 'c.txt'))
  const next = round(repo, base, dir)
  assert.deepEqual(changedRanges(prev, next, dir), { 'bin.dat': 'binary' })
})

test('changedRanges: un hunk que solo borra marca la línea anterior al borrado, o la 1', () => {
  const { repo, base } = repoWithBase()
  const dir = runDir()
  writeFileSync(join(repo, 'a.txt'), `cero\n${lines(20)}`)
  const prev = round(repo, base, dir)
  writeFileSync(join(repo, 'a.txt'), `cero\n${lines(20).replace('línea 8\n', '')}`)
  assert.deepEqual(changedRanges(prev, round(repo, base, dir), dir), { 'a.txt': [[8, 8]] })
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 8\n', ''))
  assert.deepEqual(changedRanges(prev, round(repo, base, dir), dir), { 'a.txt': [[1, 1], [7, 7]] })
})

test('changedRanges: con --head compara los contenidos de los dos commits', () => {
  const { repo, base } = repoWithBase()
  const dir = runDir()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 2\n', 'línea dos\n'))
  git(repo, 'commit', '-qam', 'primera')
  const prev = round(repo, base, dir, 'HEAD')
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 2\n', 'línea dos\n').replace('línea 18\n', 'línea dieciocho\n'))
  git(repo, 'commit', '-qam', 'segunda')
  writeFileSync(join(repo, 'a.txt'), 'el árbol no cuenta\n')
  assert.deepEqual(changedRanges(prev, round(repo, base, dir, 'HEAD'), dir), { 'a.txt': [[18, 18]] })
})

test('changedRanges: un cambio que solo toca el modo no deja líneas citables', () => {
  const { repo, base } = repoWithBase()
  const dir = runDir()
  writeFileSync(join(repo, 'a.txt'), lines(21))
  const prev = round(repo, base, dir)
  chmodSync(join(repo, 'a.txt'), 0o755)
  const next = round(repo, base, dir)
  assert.notEqual(prev.hash, next.hash)
  assert.deepEqual(changedRanges(prev, next, dir), {})
})

test('numerar no cambia el hash del candidato', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(20).replace('línea 10\n', 'línea diez\n'))
  const c = freeze(repo, { base, context: [] })
  const { diff, hash } = c
  assert.match(renderMaterial(c, new Map()), /10│\+línea diez/)
  assert.deepEqual([c.diff, c.hash], [diff, hash])
  assert.equal(freeze(repo, { base, context: [] }).hash, hash)
})

test('el modo anterior queda fuera del hash', () => {
  const { repo, base } = repoWithBase()
  chmodSync(join(repo, 'a.txt'), 0o755)
  const c = freeze(repo, { base, context: [] })
  assert.deepEqual([file(c, 'a.txt')?.old_mode, file(c, 'a.txt')?.mode], ['100644', '100755'])
  const manifest = {
    base_sha: c.base_sha, head_sha: c.head_sha,
    files: c.files.map((f) => ({ path: f.path, status: f.status, from: f.from ?? null, mode: f.mode, sha256: f.sha256 })),
    context: [],
  }
  assert.equal(c.hash, `sha256:${sha(JSON.stringify(manifest))}`)
})

test('snapshot guarda también los bytes del contexto', () => {
  const { repo, base } = repoWithBase()
  writeFileSync(join(repo, 'a.txt'), lines(21))
  writeFileSync(join(repo, 'ctx.md'), '# contexto\n')
  const c = freeze(repo, { base, context: ['ctx.md'] })
  const dir = runDir()
  const written = snapshot(repo, c, dir)
  assert.ok(written.includes(join(dir, 'blobs', sha('# contexto\n'))))
  writeFileSync(join(repo, 'ctx.md'), '# otro\n')
  assert.deepEqual([...readContextBlobs(dir, c)], [['ctx.md', '# contexto\n']])
  assert.throws(() => snapshot(repo, c, runDir()), (e: unknown) => e instanceof SddError && e.code === 'candidate_unstable' && /contexto/.test(e.message))
})
