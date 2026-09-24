// CLI falso para probar el supervisor. El comportamiento sale de FAKE_MODE; las salidas son las
// muestras reales de test/fixtures.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const args = process.argv.slice(2)
// Cada invocación queda anotada para que los tests cuenten los intentos y vean sus argumentos.
if (process.env.FAKE_CALLS_FILE) appendFileSync(process.env.FAKE_CALLS_FILE, `${JSON.stringify(args)}\n`)

function okClaude(): void {
  process.stdout.write(fixture('claude-stream.jsonl'))
}

function okCodex(): void {
  process.stdout.write(fixture('codex-stream.jsonl'))
  const i = args.indexOf('--output-last-message')
  if (i >= 0) writeFileSync(args[i + 1], 'ok')
}

function fail(stdout: string, stderr = ''): void {
  process.stdout.write(fixture(stdout))
  if (stderr) process.stderr.write(fixture(stderr))
  process.exitCode = 1
}

switch (process.env.FAKE_MODE) {
  case 'ok-claude':
    okClaude()
    break
  case 'ok-codex':
    okCodex()
    break
  case 'reject-model-claude':
    if (args.includes('--model')) fail('claude-modelo-rechazado.jsonl', 'claude-modelo-rechazado.err')
    else okClaude()
    break
  case 'reject-effort-codex':
    if (args.some((a) => a.startsWith('model_reasoning_effort='))) fail('codex-esfuerzo-rechazado.jsonl')
    else okCodex()
    break
  case 'always-reject-model-codex':
    fail('codex-modelo-rechazado.jsonl')
    break
  case 'no-auth-codex':
    process.stdout.write(fixture('codex-sin-auth.jsonl'))
    process.stderr.write(fixture('codex-sin-auth.err'))
    process.exitCode = 1
    break
  case 'empty-claude':
    process.stdout.write('{"type":"assistant","message":{}}\n{"type":"result","is_error":false,"result":""}\n')
    break
  case 'ignore-term':
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
    break
  case 'hang-child': {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    writeFileSync(process.env.FAKE_PID_FILE ?? '/dev/null', `${process.pid},${child.pid}`)
    setInterval(() => {}, 1000)
    break
  }
  default:
    process.stderr.write(`fake-cli: FAKE_MODE desconocido: ${process.env.FAKE_MODE}\n`)
    process.exitCode = 99
}
