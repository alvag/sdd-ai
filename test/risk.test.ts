import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Candidate, changedRanges, freeze, snapshot } from '../src/review/candidate.ts'
import { classify, classifyDelta, readRisk } from '../src/review/risk.ts'
import { makeRepo } from './helpers.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
const lines = (n: number, prefix = 'línea') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')

function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

/** Repo con `files` commiteados como base. */
function repoWith(files: Record<string, string>): { repo: string; base: string } {
  const repo = makeRepo()
  for (const [p, text] of Object.entries(files)) write(repo, p, text)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  return { repo, base: git(repo, 'rev-parse', 'HEAD') }
}

/** Agrega archivos nuevos al candidato con `add -N`. */
function add(repo: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) write(repo, p, text)
  git(repo, 'add', '-N', ...Object.keys(files))
}

const reasons = (c: Candidate) => classify(c).reasons.map((r) => `${r.signal} ${r.path}`)

test('cada señal sube el nivel con su motivo y su ruta', () => {
  const { repo, base } = repoWith({ 'src/auth/x.ts': 'a\n', 'tool.txt': 'x\n', 'lib.js': 'const a = 1\n' })
  write(repo, 'src/auth/x.ts', 'b\n')
  chmodSync(join(repo, 'tool.txt'), 0o755)
  write(repo, 'lib.js', 'const a = 1\nexec(cmd)\n')
  add(repo, { 'deploy.sh': 'echo hola\n' })
  const r = classify(freeze(repo, { base, context: [] }))
  assert.equal(r.level, 'high')
  assert.deepEqual(r.reasons, [
    { signal: 'shell', path: 'deploy.sh', detail: 'script .sh' },
    { signal: 'process', path: 'lib.js', detail: 'línea 2: exec' },
    { signal: 'path', path: 'src/auth/x.ts', detail: 'segmento auth' },
    { signal: 'executable', path: 'tool.txt', detail: 'modo 100644 → 100755' },
  ])
})

test('los patrones de procesos respetan los bordes de palabra', () => {
  const { repo, base } = repoWith({ 'base.txt': 'x\n' })
  add(repo, {
    'no-regex.js': 'regex.exec(texto)\n', 'no-execlpe.py': 'os.execlpe(a)\n', 'no-shebang.txt': '  #! no\n',
    'si-exec.js': 'exec(cmd)\n', 'si-posix.c': 'posix_spawn(&pid)\n', 'si-shell.php': 'shell_exec($c)\n', 'si-shebang': '#!/bin/sh\n',
  })
  assert.deepEqual(reasons(freeze(repo, { base, context: [] })),
    ['process si-exec.js', 'process si-posix.c', 'process si-shebang', 'process si-shell.php'])
})

test('una línea que ya estaba en la base no cuenta', () => {
  const { repo, base } = repoWith({ 'lib.js': `exec(cmd)\n${lines(5)}` })
  write(repo, 'lib.js', `exec(cmd)\n${lines(5).replace('línea 2\n', 'línea dos\n')}`)
  const c = freeze(repo, { base, context: [] })
  assert.match(c.diff, /^ exec\(cmd\)$/m, 'la línea está en el hunk como contexto')
  assert.deepEqual(classify(c), { level: 'normal', reasons: [] })
})

test('sin señales el nivel es normal', () => {
  const { repo, base } = repoWith({ 'README.md': 'hola\n' })
  write(repo, 'README.md', 'chau\n')
  assert.deepEqual(classify(freeze(repo, { base, context: [] })), { level: 'normal', reasons: [] })
})

test('el tamaño no sube el nivel', () => {
  const { repo, base } = repoWith({ 'README.md': 'hola\n' })
  add(repo, { 'datos.txt': lines(20000) })
  assert.deepEqual(classify(freeze(repo, { base, context: [] })), { level: 'normal', reasons: [] })
})

test('las rutas se comparan sin distinguir mayúsculas', () => {
  const { repo, base } = repoWith({ 'README.md': 'hola\n' })
  add(repo, { 'Auth/x.txt': 'a\n', 'docs/SECURITY.md': 'b\n', 'authorize.txt': 'c\n' })
  assert.deepEqual(reasons(freeze(repo, { base, context: [] })), ['path Auth/x.txt', 'path docs/SECURITY.md'])
})

test('un archivo agregado ejecutable cuenta', () => {
  const { repo, base } = repoWith({ 'README.md': 'hola\n' })
  write(repo, 'run', 'x\n')
  chmodSync(join(repo, 'run'), 0o755)
  git(repo, 'add', '-N', 'run')
  assert.deepEqual(classify(freeze(repo, { base, context: [] })).reasons,
    [{ signal: 'executable', path: 'run', detail: 'modo 000000 → 100755' }])
})

test('un renombre puro de un script no cuenta y uno con cambios sí', () => {
  const { repo, base } = repoWith({ 'a.sh': lines(10, 'a'), 'b.sh': lines(10, 'b') })
  git(repo, 'mv', 'a.sh', 'c.sh')
  git(repo, 'mv', 'b.sh', 'd.sh')
  write(repo, 'd.sh', lines(10, 'b').replace('b 5\n', 'b cinco\n'))
  const c = freeze(repo, { base, context: [] })
  assert.deepEqual(c.files.map((f) => `${f.status} ${f.path}`).sort(), ['R c.sh', 'R d.sh'])
  assert.deepEqual(reasons(c), ['shell d.sh'])
})

test('la ruta de origen de un renombre y la de un borrado cuentan', () => {
  const { repo, base } = repoWith({ 'auth.txt': lines(10), 'webhook/y.txt': 'y\n' })
  git(repo, 'mv', 'auth.txt', 'plain.txt')
  rmSync(join(repo, 'webhook/y.txt'))
  assert.deepEqual(reasons(freeze(repo, { base, context: [] })), ['path auth.txt', 'path webhook/y.txt'])
})

/** Dos rondas sobre el mismo repo: congela, guarda los blobs y devuelve lo que cambió entre las dos. */
function rounds(repo: string, base: string, between: () => void): { prev: Candidate; next: Candidate; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-run-'))
  const prev = freeze(repo, { base, context: [] })
  snapshot(repo, prev, dir)
  between()
  const next = freeze(repo, { base, context: [] })
  snapshot(repo, next, dir)
  return { prev, next, dir }
}

test('el delta evalúa ruta y script de todo archivo cambiado', () => {
  const { repo, base } = repoWith({ 'src/auth/x.ts': lines(5), 'tools/run.sh': lines(5), 'payments.txt': lines(5) })
  write(repo, 'src/auth/x.ts', lines(5).replace('línea 1\n', 'uno\n'))
  write(repo, 'tools/run.sh', lines(5).replace('línea 1\n', 'uno\n'))
  write(repo, 'payments.txt', lines(5).replace('línea 1\n', 'uno\n'))
  const { prev, next, dir } = rounds(repo, base, () => {
    write(repo, 'src/auth/x.ts', lines(5).replace('línea 1\n', 'uno\n').replace('línea 4\n', 'cuatro\n'))
    write(repo, 'tools/run.sh', lines(5).replace('línea 1\n', 'uno\n').replace('línea 4\n', 'cuatro\n'))
  })
  assert.deepEqual(classifyDelta(prev, next, changedRanges(prev, next, dir)).reasons, [
    { signal: 'path', path: 'src/auth/x.ts', detail: 'segmento auth' },
    { signal: 'shell', path: 'tools/run.sh', detail: 'script .sh' },
  ])
  const same = rounds(repo, base, () => {})
  assert.deepEqual(classifyDelta(same.prev, same.next, changedRanges(same.prev, same.next, same.dir)), { level: 'normal', reasons: [] })
})

test('el delta cuenta modos y líneas agregadas', () => {
  const { repo, base } = repoWith({ 'lib.js': lines(20), 'tool.txt': 'x\n', 'bin.txt': 'y\n' })
  write(repo, 'lib.js', lines(20).replace('línea 2\n', 'exec(a)\n'))
  write(repo, 'tool.txt', 'x2\n')
  chmodSync(join(repo, 'bin.txt'), 0o755)
  const { prev, next, dir } = rounds(repo, base, () => {
    write(repo, 'lib.js', lines(20).replace('línea 2\n', 'exec(a)\n').replace('línea 18\n', 'spawn(b)\n'))
    chmodSync(join(repo, 'tool.txt'), 0o755)
    write(repo, 'bin.txt', 'y2\n')
  })
  const r = classifyDelta(prev, next, changedRanges(prev, next, dir))
  assert.equal(r.level, 'high')
  assert.deepEqual(r.reasons, [
    { signal: 'process', path: 'lib.js', detail: 'línea 18: spawn' },
    { signal: 'executable', path: 'tool.txt', detail: 'modo 100644 → 100755' },
  ])
})

test('una corrida sin nivel congelado se lee como normal', () => {
  assert.deepEqual(readRisk({}), { level: 'normal', classified: 'normal', reasons: [], forced: false })
})

test('el delta no cuenta las líneas de un archivo que solo se movió', () => {
  const { repo, base } = repoWith({ 'README.md': 'hola\n' })
  add(repo, { 'tool.js': 'spawn(cmd)\n' })
  const { prev, next, dir } = rounds(repo, base, () => {
    git(repo, 'rm', '-q', '--cached', 'tool.js')
    renameSync(join(repo, 'tool.js'), join(repo, 'movido.js'))
    git(repo, 'add', '-N', 'movido.js')
  })
  assert.deepEqual(next.files.map((f) => f.path), ['movido.js'])
  assert.deepEqual(classifyDelta(prev, next, changedRanges(prev, next, dir)), { level: 'normal', reasons: [] })
})
