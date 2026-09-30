// CLI falso para probar el supervisor. El comportamiento sale de FAKE_MODE; las salidas son las
// muestras reales de test/fixtures.
import { spawn } from 'node:child_process'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const args = process.argv.slice(2)
// Cada invocación queda anotada para que los tests cuenten los intentos y vean sus argumentos y su cwd.
if (process.env.FAKE_CALLS_FILE) {
  appendFileSync(process.env.FAKE_CALLS_FILE, `${JSON.stringify(args)}\n`)
  appendFileSync(`${process.env.FAKE_CALLS_FILE}.cwd`, `${process.cwd()}\n`)
  // Lo que había en un archivo cuando corrió el worker: prueba qué se escribió antes del lanzamiento.
  const probe = process.env.FAKE_PROBE_FILE
  if (probe) appendFileSync(`${process.env.FAKE_CALLS_FILE}.probe`, `${existsSync(probe) ? readFileSync(probe, 'utf8').trim() : 'ausente'}\n`)
}

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
 * Las rutas que el prompt pide en `inspection.paths`: las de su sección LOTE si la trae, aunque sean
 * cero; si no, las del manifiesto.
 */
function pathsOf(prompt: string): string[] {
  const lot = /(?:^|\n)## LOTE\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)
  if (lot) return [...lot[1].matchAll(/^LOTE: (.+)$/gm)].map((m) => m[1])
  return [...prompt.matchAll(/^[AMDRT] (\S+)(?: \(antes [^)]+\))? — /gm)].map((m) => m[1])
}

/**
 * Un revisor falso: lee el prompt por stdin, toma el hash y las rutas que pide, y responde en el canal
 * de su familia (el `result` del stream en Claude, `--output-last-message` en Codex).
 */
function reviewer(kind: 'ok' | 'bad' | 'unavailable'): void {
  const prompt = readFileSync(0, 'utf8')
  const hash = /sha256:[0-9a-f]{64}/.exec(prompt)?.[0] ?? ''
  const paths = pathsOf(prompt)
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
 * con `$HASH` (el hash del prompt) y `$PATHS` (las rutas que pide el prompt) reemplazados; `__hang__` abre
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
  let paths = pathsOf(prompt)
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


/** Una acción del writer falso, con rutas relativas a su cwd; `run*` actúa sobre cada corrida visible. */
type WriterAction =
  | { write: string; content: string } | { append: string; content: string } | { delete: string } | { rename: [string, string] }
  | { binary: string } | { chmod: [string, string] } | { symlink: [string, string] }
  | { runWrite: string; content: string } | { runLink: [string, string] } | { runDelete: string } | { runSwap: string }
  | { runFuture: string } | { runsSwap: string }

interface WriterScript {
  actions?: WriterAction[]; report?: string
  /** Se cuelga después de actuar; con `hangUnlessResume`, solo en el primer lanzamiento. */
  hang?: boolean; hangUnlessResume?: boolean
  /** La reanudación sale con 1 sin responder. */
  resumeFail?: boolean
  /** Sale enseguida sin escribir nada en el stream. */
  silent?: boolean
  /** Con `-m`, el proveedor rechaza el modelo, después de actuar. */
  rejectModel?: boolean
  /** Deja un hijo vivo en su grupo, que sobrevive al writer. */
  child?: boolean
  exit?: number
  /** Un dato que la sesión recuerda; una reanudación lo escribe en `recall` para probar la memoria. */
  remember?: string
  recall?: string
  /** Espera a que exista este archivo (ruta absoluta) antes de actuar, hasta 30 s: la corrida sigue activa mientras tanto. Si no aparece, sale con 1 sin actuar. */
  waitFor?: string
}

const runDirs = () => {
  const runs = join('.sdd-ai', 'runs')
  return existsSync(runs) ? readdirSync(runs).map((id) => join(runs, id)) : []
}

function act(a: WriterAction): void {
  const mk = (p: string) => mkdirSync(dirname(p), { recursive: true })
  if ('write' in a) { mk(a.write); writeFileSync(a.write, a.content) }
  else if ('append' in a) appendFileSync(a.append, a.content)
  else if ('delete' in a) rmSync(a.delete, { force: true, recursive: true })
  else if ('rename' in a) renameSync(a.rename[0], a.rename[1])
  else if ('binary' in a) { mk(a.binary); writeFileSync(a.binary, Buffer.from([0, 1, 2, 255, 0])) }
  else if ('chmod' in a) chmodSync(a.chmod[0], Number.parseInt(a.chmod[1], 8))
  else if ('symlink' in a) { mk(a.symlink[1]); symlinkSync(a.symlink[0], a.symlink[1]) }
  else if ('runWrite' in a) for (const d of runDirs()) writeFileSync(join(d, a.runWrite), a.content)
  else if ('runLink' in a) for (const d of runDirs()) { rmSync(join(d, a.runLink[0]), { force: true }); symlinkSync(a.runLink[1], join(d, a.runLink[0])) }
  else if ('runDelete' in a) for (const d of runDirs()) rmSync(join(d, a.runDelete), { force: true, recursive: true })
  else if ('runSwap' in a) for (const d of runDirs()) { rmSync(d, { recursive: true, force: true }); symlinkSync(a.runSwap, d) }
  else if ('runFuture' in a) for (const d of runDirs()) { const t = new Date(Date.now() + 86_400_000); utimesSync(join(d, a.runFuture), t, t) }
  else if ('runsSwap' in a) { renameSync(join('.sdd-ai', 'runs'), a.runsSwap); symlinkSync(a.runsSwap, join('.sdd-ai', 'runs')) }
}

/**
 * El guion de esta invocación: con FAKE_WRITERS, uno por invocación en orden (y cada uno actúa también
 * si reanuda); si no, FAKE_WRITER para todas, y una reanudación solo cierra.
 */
function writerScript(): { script: WriterScript; perCall: boolean } {
  if (process.env.FAKE_WRITERS === undefined) return { script: JSON.parse(process.env.FAKE_WRITER ?? '{}') as WriterScript, perCall: false }
  const list = JSON.parse(process.env.FAKE_WRITERS) as WriterScript[]
  return { script: list[callCount() - 1] ?? {}, perCall: true }
}

/**
 * Con FAKE_SESSION_FILES, la sesión vive en un archivo donde la busca el runner real: Claude en
 * `CLAUDE_CONFIG_DIR/projects/-repo/<sesión>.jsonl`, Codex en `CODEX_HOME/sessions/.../rollout-*-<hilo>.jsonl`.
 * Una reanudación sin su archivo falla como el CLI real. Devuelve el id y el dato recordado.
 */
function session(codex: boolean, resumed: boolean, remember: string | undefined): { id: string; remembered?: string } | 'missing' {
  const files = process.env.FAKE_SESSION_FILES === '1'
  const id = codex
    ? (resumed ? args[args.length - 2] : files ? `th-${process.pid}-${Date.now()}` : 'T1')
    : args[args.indexOf(resumed ? '--resume' : '--session-id') + 1]
  if (!files) return { id }
  const file = codex
    ? join(process.env.CODEX_HOME ?? '/nonexistent', 'sessions', '2026', '09', '29', `rollout-2026-09-29T00-00-00-${id}.jsonl`)
    : join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'projects', '-repo', `${id}.jsonl`)
  if (resumed) {
    if (!existsSync(file)) return 'missing'
    const remembered = (JSON.parse(readFileSync(file, 'utf8').split('\n')[0]) as { remember?: string }).remember
    return { id, remembered }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ remember })}\n`)
  return { id }
}

/** El writer falso: lee su prompt, actúa sobre el árbol y responde en el stream de su familia. */
function writer(): void {
  const { script, perCall } = writerScript()
  const prompt = readFileSync(0, 'utf8')
  if (process.env.FAKE_PROMPTS_FILE) appendFileSync(process.env.FAKE_PROMPTS_FILE, `${JSON.stringify(prompt)}\n`)
  if (script.silent) return
  const codex = args[0] === 'exec'
  const resumed = codex ? args[1] === 'resume' : args.includes('--resume')
  if (resumed && script.resumeFail) {
    process.exitCode = 1
    return
  }
  const s = session(codex, resumed, script.remember)
  if (s === 'missing') {
    process.stderr.write('fake-cli: no se encontró la sesión\n')
    process.exitCode = 1
    return
  }
  const opening = process.env.FAKE_SESSION_FILES === '1'
    ? JSON.stringify(codex ? { type: 'thread.started', thread_id: s.id } : { type: 'system', subtype: 'init', session_id: s.id, model: 'claude-falso', tools: [] })
    : codex ? codexThread : claudeInit()
  process.stdout.write(`${opening}\n`)
  if (resumed && script.recall && s.remembered !== undefined) writeFileSync(script.recall, s.remembered)
  if (script.waitFor) {
    const until = Date.now() + 30_000
    while (!existsSync(script.waitFor) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    // Si la señal no llegó, la invocación falla: una prueba que coordina con ella no sigue como si hubiera llegado.
    if (!existsSync(script.waitFor)) {
      process.stderr.write(`fake-cli: no apareció ${script.waitFor}\n`)
      process.exitCode = 1
      return
    }
  }
  if (!resumed || perCall) for (const a of script.actions ?? []) act(a)
  if (script.rejectModel && (args.includes('-m') || args.includes('--model'))) {
    fail(codex ? 'codex-modelo-rechazado.jsonl' : 'claude-modelo-rechazado.jsonl')
    return
  }
  if (script.child) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    writeFileSync(process.env.FAKE_PID_FILE ?? '/dev/null', `${process.pid},${child.pid}`)
  }
  if (script.hang || (script.hangUnlessResume && !resumed)) {
    setInterval(() => {}, 1000)
    return
  }
  const report = script.report ?? 'Hice el cambio pedido.\nSTATUS: done'
  if (codex) {
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: report } })}\n`)
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n')
  } else {
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"."}]}}\n')
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, result: report, usage: { input_tokens: 10, output_tokens: 5 } })}\n`)
  }
  if (script.child) setTimeout(() => process.exit(script.exit ?? 0), 50)
  else process.exitCode = script.exit ?? 0
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
  case 'writer':
    writer()
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
