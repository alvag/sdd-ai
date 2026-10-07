import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandSegments, pipelineSegments, shellPipelines } from '../src/shell.ts'

const texts = (command: string, grammar: 'posix' | 'powershell') => pipelineSegments(command, grammar).flat().map((s) => s.text.trim())

test('commandSegments suma los tramos de PowerShell solo en Windows y conserva el negativo POSIX de la barra antes del punto y coma', () => {
  const command = 'echo \\; ./bin/sdd-ai run'
  for (const prefix of ['a` --%', "echo it`'s` --%"]) assert.equal(texts(`${prefix} ; git commit`, 'powershell').at(-1), 'git commit')
  for (const eol of ['\n', '\r\n']) assert.equal(texts(`a\`${eol}--% ; git commit`, 'powershell').at(-1), 'git commit')
  assert.deepEqual(pipelineSegments(command, 'posix').flat().map((s) => s.text), [command])
  assert.deepEqual(texts(command, 'powershell'), ['echo \\', './bin/sdd-ai run'])
  assert.deepEqual(commandSegments(command, 'linux').filter((s) => s.includes('sdd-ai run')), [command])
  assert.ok(commandSegments(command, 'win32').includes(' ./bin/sdd-ai run'))
  assert.equal(commandSegments(command, 'linux').length, 1)
  const quoted = 'echo "C:\\a\\"; ./bin/sdd-ai run'
  assert.ok(commandSegments(quoted, 'win32').includes(' ./bin/sdd-ai run'))
  assert.deepEqual(commandSegments(quoted, 'linux'), [quoted])
})

test('pipelineSegments conserva el resultado de shellPipelines con la gramática posix y la posición de cada tramo', () => {
  for (const command of ['cat a | grep b && git diff | head', 'git add . & git commit; ls', 'git diff 2>&1 | head &> out', 'echo "a | b; c" || ls']) {
    assert.deepEqual(pipelineSegments(command, 'posix').map((p) => p.map((s) => s.text)), shellPipelines(command), command)
  }
  const command = 'cd C:\\x\\; git commit'
  for (const segment of pipelineSegments(command, 'powershell').flat()) assert.equal(command.slice(segment.start, segment.start + segment.text.length), segment.text)
  assert.deepEqual(texts(command, 'powershell'), ['cd C:\\x\\', 'git commit'])
  assert.deepEqual(texts(command, 'posix'), [command])
  assert.equal(pipelineSegments(command, 'powershell').flat()[1].start, command.indexOf(' git commit'))
})

test('en PowerShell una comilla con backslash final no esconde el commit siguiente y las simples no escapan', () => {
  assert.deepEqual(texts("echo 'C:\\a\\'; git commit", 'powershell'), ["echo 'C:\\a\\'", 'git commit'])
  assert.deepEqual(texts("echo 'C:\\a\\'; git commit", 'posix'), ["echo 'C:\\a\\'", 'git commit'])
  assert.deepEqual(texts('echo "C:\\a\\"; git commit', 'powershell'), ['echo "C:\\a\\"', 'git commit'])
  assert.deepEqual(texts('echo "C:\\a\\"; git commit', 'posix'), ['echo "C:\\a\\"; git commit'])
  assert.deepEqual(texts("echo 'a''b; c'; ls", 'powershell'), ["echo 'a''b; c'", 'ls'])
})

test('en PowerShell backtick con LF o CRLF es una continuación y no parte el tramo', () => {
  assert.deepEqual(texts('git --% status \\| git commit', 'powershell'), ['git --% status \\', 'git commit'])
  for (const eol of ['\n', '\r\n']) assert.deepEqual(texts(`git --% log --grep='${eol}git commit`, 'powershell'), ["git --% log --grep='", 'git commit'])
  for (const eol of ['\n', '\r\n']) {
    assert.equal(pipelineSegments(`git \`${eol}--% -C a;b commit`, 'powershell').flat().length, 1)
    assert.deepEqual(texts(`git \`${eol}commit`, 'powershell'), [`git \`${eol}commit`])
    assert.deepEqual(texts(`git \`${eol}commit; ls`, 'powershell'), [`git \`${eol}commit`, 'ls'])
  }
  assert.deepEqual(texts('echo `; git commit', 'powershell'), ['echo `; git commit'])
})
