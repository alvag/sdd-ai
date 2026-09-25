// CLI falso para probar el supervisor. El comportamiento sale de FAKE_MODE; las salidas son las
// muestras reales de test/fixtures.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/** Emite una línea y deja el proceso vivo hasta que lo maten, como un worker que no terminó a tiempo. */
function hang(line: string): void {
  process.stdout.write(`${line}\n`)
  setInterval(() => {}, 1000)
}

/**
 * Un revisor falso: lee el prompt por stdin, toma el hash y las rutas del manifiesto, y responde en
 * el canal de su familia (el `result` del stream en Claude, `--output-last-message` en Codex).
 */
function reviewer(kind: 'ok' | 'bad' | 'unavailable'): void {
  const prompt = readFileSync(0, 'utf8')
  const hash = /sha256:[0-9a-f]{64}/.exec(prompt)?.[0] ?? ''
  const paths = [...prompt.matchAll(/^[AMDRT] (\S+)(?: \(antes [^)]+\))? — /gm)].map((m) => m[1])
  const answer = kind === 'bad'
    ? 'no pude armar el JSON'
    : JSON.stringify(kind === 'ok'
      ? { candidate_hash: hash, inspection: { status: 'completed', paths }, findings: [] }
      : { candidate_hash: hash, inspection: { status: 'unavailable', paths: [], reason: 'no pude' }, findings: [] })
  if (args[0] === 'exec') {
    process.stdout.write('{"type":"thread.started","thread_id":"T1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"."}}\n')
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n')
    const i = args.indexOf('--output-last-message')
    if (i >= 0) writeFileSync(args[i + 1], answer)
  } else {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"s","model":"claude-falso","tools":[]}\n')
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"."}]}}\n')
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, result: answer, usage: { input_tokens: 10, output_tokens: 5 } })}\n`)
  }
}

const claudeInit = () => fixture('claude-stream.jsonl').split('\n')[0]
const codexThread = '{"type":"thread.started","thread_id":"T1"}'

/** Cuántas veces se invocó el CLI falso en esta corrida, contando la actual. */
const callCount = () => (process.env.FAKE_CALLS_FILE ? readFileSync(process.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').length : 1)

/**
 * Guion de respuestas: la invocación k usa `answers[k-1]` de FAKE_ANSWERS. Un texto es la respuesta,
 * con `$HASH` (el hash del prompt) y `$PATHS` (las rutas del manifiesto) reemplazados; `__hang__` abre
 * la sesión y se cuelga; `__fail__` sale con 1 sin stream.
 */
function scripted(): void {
  const answers = JSON.parse(readFileSync(process.env.FAKE_ANSWERS ?? '', 'utf8')) as string[]
  const answer = answers[callCount() - 1] ?? '__fail__'
  const codex = args[0] === 'exec'
  const prompt = readFileSync(0, 'utf8')
  // Una reanudación solo recibe el mensaje de cierre: como la sesión real, recuerda el candidato anterior.
  const memory = `${process.env.FAKE_CALLS_FILE ?? '/dev/null'}.memoria`
  let hash = /sha256:[0-9a-f]{64}/.exec(prompt)?.[0]
  let paths = [...prompt.matchAll(/^[AMDRT] (\S+)(?: \(antes [^)]+\))? — /gm)].map((m) => m[1])
  if (hash) {
    if (process.env.FAKE_CALLS_FILE) writeFileSync(memory, JSON.stringify({ hash, paths }))
  } else if (process.env.FAKE_CALLS_FILE && existsSync(memory)) {
    ({ hash, paths } = JSON.parse(readFileSync(memory, 'utf8')) as { hash: string; paths: string[] })
  }
  if (answer === '__fail__') {
    process.stderr.write('fake-cli: falla guionada\n')
    process.exitCode = 1
    return
  }
  if (answer === '__hang__') {
    hang(codex ? codexThread : claudeInit())
    return
  }
  const text = answer.replaceAll('$HASH', hash ?? '').replaceAll('$PATHS', JSON.stringify(paths))
  if (codex) {
    process.stdout.write(`${codexThread}\n{"type":"item.completed","item":{"type":"agent_message","text":"."}}\n`)
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n')
    const i = args.indexOf('--output-last-message')
    if (i >= 0) writeFileSync(args[i + 1], text)
  } else {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"s","model":"claude-falso","tools":[]}\n')
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"."}]}}\n')
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 } })}\n`)
  }
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
  case 'hang-unless-resume-claude':
    if (args.includes('--resume')) okClaude()
    else hang(claudeInit())
    break
  case 'hang-unless-resume-fail':
    if (args.includes('--resume')) {
      process.stderr.write('fake-cli: la reanudación falló\n')
      process.exitCode = 1
    } else {
      hang(claudeInit())
    }
    break
  case 'hang-unless-resume-codex':
    if (args[0] === 'exec' && args[1] === 'resume') okCodex()
    else hang(codexThread)
    break
  case 'hang-always-session':
    hang(process.env.FAKE_FAMILY === 'codex' ? codexThread : claudeInit())
    break
  case 'review-ok':
    reviewer('ok')
    break
  case 'scripted':
    scripted()
    break
  case 'review-unavailable':
    reviewer('unavailable')
    break
  case 'review-bad-then-ok':
    reviewer(callCount() === 1 ? 'bad' : 'ok')
    break
  case 'review-bad-always':
    reviewer('bad')
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
