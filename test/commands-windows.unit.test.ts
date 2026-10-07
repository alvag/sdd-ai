import { test } from 'node:test'
import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import { commitTargets, invokesBinding } from '../src/commands.ts'

// Lógica pura con la plataforma 'win32' explícita: no depende del sistema donde corre.
const W = 'C:\\w'
const UNKNOWN = { unknown: true }
const targets = (command: string) => commitTargets(command, W, 'win32')
const dir = (...parts: string[]) => ({ dir: win32.resolve(...parts) })

test('en Windows una ruta nativa citada, con slash o entre comillas dobles conservadas da el destino, y sin comillas queda desconocida', () => {
  assert.deepEqual(targets("git -C 'C:\\a\\b' commit"), [dir('C:\\a\\b')])
  assert.deepEqual(targets("git -C 'C:\\a b\\repo' commit"), [dir('C:\\a b\\repo')])
  assert.deepEqual(targets('git -C "C:\\a b\\repo" commit'), [dir('C:\\a b\\repo')])
  assert.deepEqual(targets('git -C "C:\\a\\b" commit'), [dir('C:\\a\\b')])
  assert.deepEqual(targets('git -C "C:\\Users\\x\\other" commit'), [dir('C:\\Users\\x\\other')])
  assert.deepEqual(targets('git -C C:/a/b commit'), [dir('C:\\a\\b')])
  assert.deepEqual(targets("git -C 'C:/a/b' commit"), [dir('C:\\a\\b')])
  assert.deepEqual(targets("git -C 'C:\\cash$box' commit"), [dir('C:\\cash$box')])
  assert.deepEqual(targets("git -C 'C:\\cash`box' commit"), [dir('C:\\cash`box')])
  assert.deepEqual(targets('git -C "C:/cash$box" commit'), [UNKNOWN])
  assert.deepEqual(targets('git -C "C:/cash`box" commit'), [UNKNOWN])
  assert.deepEqual(targets('git -C C:\\a\\b commit'), [UNKNOWN])
  assert.deepEqual(targets('git -C C:\\Users\\x\\other commit'), [UNKNOWN])
})

test('en Windows los -C relativos citados se resuelven contra cwd o un -C absoluto previo y los ambiguos quedan desconocidos', () => {
  assert.deepEqual(targets("git -C 'sub\\anidado' commit"), [dir(W, 'sub\\anidado')])
  assert.deepEqual(targets('git -C "sub\\anidado" commit'), [dir(W, 'sub\\anidado')])
  assert.deepEqual(targets("git -C '.\\sub' commit"), [dir(W, 'sub')])
  assert.deepEqual(targets('git -C sub/anidado commit'), [dir(W, 'sub', 'anidado')])
  assert.deepEqual(targets("git -C 'C:\\r' -C 'sub\\x' commit"), [dir('C:\\r', 'sub\\x')])
  assert.deepEqual(targets('git -C sub\\anidado commit'), [UNKNOWN])
  assert.deepEqual(targets('git -C .\\sub commit'), [UNKNOWN])
  assert.deepEqual(targets("git -C C:\\r -C 'sub' commit"), [UNKNOWN])
})

const MOVES = ['cd', 'pushd', 'Set-Location', 'sl', 'chdir', 'Push-Location', 'Pop-Location', 'popd', 'cd..', 'cd\\', 'D:']

test('en Windows cada cambio de directorio sin -C absoluto posterior deja el destino desconocido y con él lo determina', () => {
  for (const move of MOVES) {
    for (const m of [move.toLowerCase(), move.toUpperCase(), move]) {
      assert.deepEqual(targets(`${m} && git commit`), [UNKNOWN], `${m}: sin -C`)
      assert.deepEqual(targets(`${m} && git -C 'sub' commit`), [UNKNOWN], `${m}: -C relativo`)
      assert.deepEqual(targets(`${m} && git -C 'C:\\other' commit`), [dir('C:\\other')], `${m}: -C absoluto citado`)
      assert.deepEqual(targets(`${m} && git -C C:/other commit`), [dir('C:\\other')], `${m}: -C absoluto con slash`)
    }
  }
  assert.deepEqual(targets('cd C:\\x\\; git commit'), [UNKNOWN])
})

test('en Windows un -C no literal, UNC, de unidad relativa, sin unidad o con backslash final ambiguo queda desconocido', () => {
  const unknown = [
    'git -C $X commit',
    'git -C $env:X commit',
    'git -C ~\\r commit',
    'git --git-dir=C:/r/.git commit',
    'git --git-dir C:/r/.git commit',
    'git --work-tree=C:/r commit',
    "git -C '\\\\srv\\share\\r' commit",
    'git -C //srv/r commit',
    'git -C C:x commit',
    "git -C 'C:x' commit",
    'git -C /r commit',
    "git -C '\\r' commit",
    'git -C \\r commit',
    'git -C "C:\\a\\" commit',
  ]
  for (const command of unknown) assert.deepEqual(targets(command), [UNKNOWN], command)
  // Con las dos lecturas de acuerdo, el backslash final conserva el destino.
  assert.deepEqual(targets("git -C 'C:\\a\\' commit"), [dir('C:\\a')])
  // Sin señal de shell, una ruta con unidad y slash no se vuelve desconocida.
  assert.deepEqual(targets('git -C C:/r commit'), [dir('C:\\r')])
  assert.deepEqual(targets('git commit'), [dir(W)])
})

test('en Windows cada commit da una sola entrada por su posición en el texto, ordenada, y un destino distinto entre lecturas es desconocido', () => {
  assert.deepEqual(targets("git commit && git -C 'C:\\a' commit"), [dir(W), dir('C:\\a')])
  assert.deepEqual(targets("git -C 'C:\\a' commit; git commit"), [dir('C:\\a'), dir(W)])
  assert.deepEqual(targets('git commit; git commit'), [dir(W), dir(W)])
  // Dos barras consecutivas: POSIX deja una y PowerShell dos, y ambas normalizan al mismo directorio.
  assert.deepEqual(targets('git -C C:\\\\a\\\\b commit'), [dir('C:\\a\\b')])
  // Destinos distintos entre lecturas: desconocido, en una sola entrada.
  assert.deepEqual(targets('git -C C:\\a\\b commit'), [UNKNOWN])
  assert.deepEqual(targets('git -C .\\sub commit; git -C C:/a commit'), [UNKNOWN, dir('C:\\a')])
  // Solo PowerShell ve este commit y conserva su posición.
  assert.deepEqual(targets("echo \\; git -C 'C:\\a' commit && git commit"), [dir('C:\\a'), dir(W)])
})

test('en Windows la segmentación une ambas lecturas: un commit que solo ve una no desaparece', () => {
  assert.deepEqual(targets('a` --% ; git -C sub\\x commit'), [UNKNOWN])
  assert.deepEqual(targets('git --% status || git -C sub\\x commit'), [UNKNOWN])
  assert.deepEqual(targets("echo it`'s` --% ; git commit"), [dir(W)])
  for (const eol of ['\n', '\r\n']) {
    assert.deepEqual(targets(`a\`${eol}--% ; git -C sub\\x commit`), [UNKNOWN])
    assert.deepEqual(targets(`echo it\`'s\`${eol}--% ; git commit`), [dir(W)])
  }
  for (const command of ["echo it\\'s; git commit", 'echo --% x; git commit']) assert.deepEqual(targets(command), [dir(W)])
  assert.deepEqual(targets('git --% status \\| git commit'), [dir(W)])
  for (const eol of ['\n', '\r\n']) assert.deepEqual(targets(`git --% log --grep='${eol}git commit`), [dir(W)])
  assert.deepEqual(targets("git -C '--%' commit"), [dir(W, '--%')])
  assert.deepEqual(targets("echo \\; git -C 'C:\\a' commit"), [dir('C:\\a')])
  assert.deepEqual(targets('echo "C:\\a\\"; git commit'), [dir(W)])
  assert.deepEqual(targets("echo 'C:\\a\\'; git commit"), [dir(W)])
  assert.deepEqual(targets('cd C:\\x\\; git commit'), [UNKNOWN])
  assert.deepEqual(targets("cd 'C:\\x\\'; git commit"), [UNKNOWN])
})

test('en Windows las formas PowerShell no admitidas detectan el commit con destino desconocido', () => {
  const unsupported = [
    "git -C 'C:\\a'\"b\" commit",
    "git -C 'C:\\a'b commit",
    "git -C 'C:\\a''b' commit",
    "git -C 'C:\\a\"b' commit",
    'git -C "C:\\a""b" commit',
    'git -C $env:SUB\\r commit',
    'git -C C:\\$env:SUB commit',
    'git -C `C:\\a commit',
    'git --% commit',
    'git --% -C C:/a commit',
    'git --% -C sub(dir) commit',
    'git --% -C --% commit',
    "git --% -C sub'dir commit",
    'git --% -C "sub dir" commit',
    'git --% -c key="a\\"b" commit',
    'git -C --% C:/a commit',
    'git -c --% key=value commit',
    'git `\ncommit',
    'git `\r\ncommit',
    ...['\n', '\r\n'].map((eol) => `git \`${eol}--% -C a;b commit`),
  ]
  for (const command of unsupported) assert.deepEqual(targets(command), [UNKNOWN], JSON.stringify(command))
  // Las rutas simples citadas siguen dando su destino.
  assert.deepEqual(targets("git -C 'C:\\a' commit"), [dir('C:\\a')])
  assert.deepEqual(targets('git -C "C:\\a" commit'), [dir('C:\\a')])
  assert.deepEqual(targets("git -C '--%' commit"), [dir(W, '--%')])
})

test('en Windows invokesBinding une ambas lecturas sin ampliar los lanzadores reconocidos', () => {
  for (const command of ['./bin/sdd-ai sdd status f1', 'bin/sdd-ai sdd status f1', 'sdd-ai sdd status f1', 'node ./bin/sdd-ai sdd status f1']) {
    assert.equal(invokesBinding(command, 'win32'), true, command)
  }
  assert.equal(invokesBinding('.\\bin\\sdd-ai sdd status f1', 'win32'), false)
  assert.equal(invokesBinding('echo sdd-ai sdd status f1 && git status', 'win32'), false)
  const chain = 'echo \\; ./bin/sdd-ai sdd status f1 && git commit'
  assert.equal(invokesBinding(chain, 'win32'), true)
  assert.equal(invokesBinding(chain, 'linux'), false)
  const quoted = 'echo "C:\\a\\"; ./bin/sdd-ai sdd status f1'
  assert.equal(invokesBinding(quoted, 'win32'), true)
  assert.equal(invokesBinding(quoted, 'linux'), false)
  assert.equal(invokesBinding("echo it\\'s; ./bin/sdd-ai sdd status f1", 'win32'), true)
  assert.equal(invokesBinding('echo --% x; ./bin/sdd-ai sdd status f1', 'win32'), true)
})

test('en Windows echo git commit, git log --grep commit y git commit-tree siguen sin ser commits', () => {
  for (const command of ['git log --grep commit', 'git --% log --grep commit', 'echo git commit', 'git commit-tree', 'echo "a; git commit"']) {
    assert.deepEqual(targets(command), [], command)
  }
})
