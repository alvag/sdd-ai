import { test } from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { bindingCommand, commitTargets, invokesBinding } from '../src/commands.ts'
import { shellPipelines } from '../src/shell.ts'

// Estos casos fijan la lectura POSIX previa: plataforma 'linux' y rutas de path.posix, también desde Windows.
const W = posix.resolve('/w')
const resolve = posix.resolve
const targets = (command: string, cwd: string) => commitTargets(command, cwd, 'linux')

test('bindingCommand reconoce las formas del binario solo en el primer tramo', () => {
  const binds: [string, 'status' | 'approve' | 'phase'][] = [
    ['sdd-ai sdd status f1', 'status'],
    ['./bin/sdd-ai sdd status --json f1', 'status'],
    ['/x/bin/sdd-ai sdd approve f1 spec --conductor claude', 'approve'],
    ['./bin/sdd-ai sdd approve --conductor claude f1 spec', 'approve'],
    ['node /x/bin/sdd-ai sdd status f1 | head', 'status'],
  ]
  for (const [command, verb] of binds) assert.deepEqual(bindingCommand(command), { verb, id: 'f1' }, command)
  const phases = [
    './bin/sdd-ai sdd phase f1',
    './bin/sdd-ai sdd phase f1 --request pedido.md',
    './bin/sdd-ai sdd phase --context c.md f1',
    './bin/sdd-ai sdd phase f1 --families codex --conductor claude --deadline 900',
    './bin/sdd-ai sdd phase f1 --request=pedido.md',
  ]
  for (const command of phases) assert.deepEqual(bindingCommand(command), { verb: 'phase', id: 'f1' }, command)
  for (const command of ['sdd-ai sdd phase', 'sdd-ai sdd phase f1 f2', 'sdd-ai sdd phase f1 --otra x', 'sdd-ai sdd phase f1 --request']) {
    assert.equal(bindingCommand(command), undefined, command)
  }
  const verifies = [
    './bin/sdd-ai sdd verify f1',
    './bin/sdd-ai sdd verify f1 --baseline',
    './bin/sdd-ai sdd verify --attest V3 f1',
    './bin/sdd-ai sdd verify f1 --attest=V3 --conductor codex',
  ]
  for (const command of verifies) assert.deepEqual(bindingCommand(command), { verb: 'verify', id: 'f1' }, command)
  for (const command of ['sdd-ai sdd verify', 'sdd-ai sdd verify f1 f2', 'sdd-ai sdd verify f1 --otra', 'sdd-ai sdd verify f1 --attest']) {
    assert.equal(bindingCommand(command), undefined, command)
  }
  const none = [
    'cd x && ./bin/sdd-ai sdd status f1',
    'false && ./bin/sdd-ai sdd status f1',
    'sdd-ai sdd status',
    'sdd-ai sdd status ../x',
    'sdd-ai sdd status f1 f2',
    'sdd-ai sdd approve f1',
    'sdd-ai sdd approve f1 spec extra',
  ]
  for (const command of none) assert.equal(bindingCommand(command), undefined, command)
  assert.equal(invokesBinding('cd x && ./bin/sdd-ai sdd status f1', 'linux'), true)
  assert.equal(invokesBinding('false && ./bin/sdd-ai sdd status f1', 'linux'), true)
  assert.equal(invokesBinding('echo sdd-ai sdd status f1 && git status', 'linux'), false)
})

test('commitTargets encuentra git commit con -C, -c, asignaciones, subcapas y en cualquier tramo, también tras un & simple', () => {
  const commands = [
    'git commit -m x',
    'git -c user.name=a commit',
    'A=1 git commit',
    '(git commit)',
    '{ git commit; }',
    'git add . && git commit',
    'git add . & git commit',
    'x | git commit',
  ]
  for (const command of commands) assert.deepEqual(targets(command, W), [{ dir: W }], command)
  assert.deepEqual(targets('git -C /r commit && git commit', W), [{ dir: resolve('/r') }, { dir: W }])
})

test('el destino: -C absoluto, cd o pushd previo desconocido, relativo al cwd, no literal desconocido', () => {
  const cases: [string, unknown][] = [
    ['git -C /r commit', { dir: resolve('/r') }],
    ['cd /r1 && git -C /r2 commit', { dir: resolve('/r2') }],
    ['cd /r && git -C . commit', { unknown: true }],
    ['cd /r && git commit', { unknown: true }],
    ['pushd /r; git commit', { unknown: true }],
    ['git -C sub commit', { dir: resolve(W, 'sub') }],
    ['git -C /r -C sub commit', { dir: resolve('/r', 'sub') }],
    ['git -C $X commit', { unknown: true }],
    ['git -C ~/r commit', { unknown: true }],
    ['git --git-dir=/r/.git commit', { unknown: true }],
    ['git --git-dir /r/.git commit', { unknown: true }],
    ['git --work-tree=/r commit', { unknown: true }],
  ]
  for (const [command, target] of cases) assert.deepEqual(targets(command, W), [target], command)
})

test('no son commits git log --grep commit, echo git commit ni git commit-tree', () => {
  for (const command of ['git log --grep commit', 'echo git commit', 'git commit-tree', 'echo "a; git commit"']) {
    assert.deepEqual(targets(command, W), [], command)
  }
})

test('fuera de Windows se conserva la lectura POSIX previa en comillas dobles, tramos y movimientos', () => {
  // Entre comillas dobles la barra escapa cualquier carácter, como antes.
  assert.deepEqual(targets('git -C "/a\\b" commit', W), [{ dir: resolve('/ab') }])
  assert.deepEqual(targets("git -C '/a\\b' commit", W), [{ dir: resolve('/a\\b') }])
  assert.deepEqual(targets('git -C /a\\ b commit', W), [{ dir: resolve('/a b') }])
  // Solo cd y pushd mueven; las formas de PowerShell no aplican.
  for (const command of ['Set-Location /r && git commit', 'sl /r && git commit', 'cd.. && git commit', 'D: && git commit']) {
    assert.deepEqual(targets(command, W), [{ dir: W }], command)
  }
  for (const command of ['cd /r && git commit', 'pushd /r && git commit']) assert.deepEqual(targets(command, W), [{ unknown: true }], command)
  // La barra ante `;` escapa el separador: no hay segundo tramo.
  assert.deepEqual(targets('echo \\; git commit', W), [])
  assert.equal(invokesBinding('echo \\; ./bin/sdd-ai sdd status f1', 'linux'), false)
  // Una ruta con unidad no se lee como absoluta fuera de Windows.
  assert.deepEqual(targets("git -C 'C:\\a' commit", W), [{ dir: resolve(W, 'C:\\a') }])
})

test('shellPipelines agrupa los tramos por tubería, también tras un & simple, sin partir una redirección', () => {
  const trimmed = (command: string) => shellPipelines(command).map((p) => p.map((c) => c.trim()))
  assert.deepEqual(trimmed('cat a | grep b && git diff | head'), [['cat a', 'grep b'], ['git diff', 'head']])
  assert.deepEqual(trimmed('git add . & git commit; ls'), [['git add .'], ['git commit'], ['ls']])
  assert.deepEqual(trimmed('git diff 2>&1 | head &> out'), [['git diff 2>&1', 'head &> out']])
  assert.deepEqual(trimmed('echo "a | b; c" || ls'), [['echo "a | b; c"'], ['ls']])
})
