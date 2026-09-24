// CLI falso para probar el supervisor. El comportamiento sale de FAKE_MODE; las salidas son las
// muestras reales de test/fixtures.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const args = process.argv.slice(2)

switch (process.env.FAKE_MODE) {
  case 'ok-claude':
    process.stdout.write(fixture('claude-stream.jsonl'))
    break
  case 'ok-codex': {
    process.stdout.write(fixture('codex-stream.jsonl'))
    const i = args.indexOf('--output-last-message')
    if (i >= 0) writeFileSync(args[i + 1], 'ok')
    break
  }
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
