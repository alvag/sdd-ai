import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRun, setStatus, writeJsonAtomic } from '../src/runs.ts'
import { checkOutput, payload } from './hook-contract.ts'
import { makeRepo } from './helpers.ts'

const ROOT = join(import.meta.dirname, '..')
const CLIS = ['claude', 'codex'] as const
type Cli = typeof CLIS[number]

interface Handler { type: string; command: string; timeout: number }
interface Group { matcher?: string; hooks: Handler[] }
type Config = { hooks: Record<string, Group[]> }

const config = (cli: Cli): Config =>
  JSON.parse(readFileSync(join(ROOT, cli === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'), 'utf8')) as Config

const LAUNCHER = join(ROOT, 'bin', 'sdd-ai-hook')
const COMMANDS: Record<Cli, string> = {
  claude: 'node "${CLAUDE_PROJECT_DIR}/bin/sdd-ai-hook" claude',
  codex: 'node "$(git rev-parse --show-toplevel)/bin/sdd-ai-hook" codex',
}

const foreign = () => mkdtempSync(join(tmpdir(), 'sdd-ai-ajeno-'))

/** Corre el lanzador desde un directorio que no es el repo: la raíz tiene que salir del payload. */
function launch(cli: Cli, input: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [LAUNCHER, cli], { cwd: foreign(), input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout }
}

/**
 * Corre el comando del archivo de config como lo corre cada CLI: Claude Code exporta
 * `CLAUDE_PROJECT_DIR`, y Codex ejecuta el hook con el cwd de la sesión, que es el `cwd` del payload.
 */
function runConfigured(cli: Cli, repo: string, input: string): { code: number | null; out: string } {
  const command = config(cli).hooks.SessionStart[0].hooks[0].command
  const opts = cli === 'claude'
    ? { cwd: foreign(), env: { ...process.env, CLAUDE_PROJECT_DIR: repo } }
    : { cwd: repo, env: process.env }
  const r = spawnSync('sh', ['-c', command], { ...opts, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout }
}

/** Repo de prueba con sdd-ai y una corrida abierta de `s1`; `bin` decide qué hay en `bin/sdd-ai`. */
function testRepo(bin: 'real' | 'none' | 'fails' | 'hangs' = 'real'): string {
  const repo = makeRepo()
  const dir = createRun(repo, '20260101-0001-aaaa')
  writeJsonAtomic(join(dir, 'request.json'), { session: 's1', conductor: { family: 'claude' }, role: 'explore' })
  setStatus(dir, { state: 'running' })
  if (bin === 'none') return repo
  mkdirSync(join(repo, 'bin'))
  if (bin === 'real') {
    symlinkSync(join(ROOT, 'bin', 'sdd-ai'), join(repo, 'bin', 'sdd-ai'))
    symlinkSync(LAUNCHER, join(repo, 'bin', 'sdd-ai-hook'))
    // El lanzador cuenta en su propio proceso con el código de la raíz del payload.
    symlinkSync(join(ROOT, 'src'), join(repo, 'src'))
  } else writeFileSync(join(repo, 'bin', 'sdd-ai'), bin === 'fails' ? 'process.exit(1)\n' : 'setTimeout(() => {}, 60000)\n')
  return repo
}

const DISPATCH = { claude: 'pre-tool-use-agent', codex: 'pre-tool-use-spawn-agent-v1' } as const
const stopOf = (cli: Cli, repo: string, patch: Record<string, unknown> = {}) => JSON.stringify(payload(cli, 'stop', { cwd: repo, session_id: 's1', ...patch }))
const dispatchOf = (cli: Cli, repo: string, patch: Record<string, unknown> = {}) =>
  JSON.stringify(payload(cli, DISPATCH[cli], { cwd: repo, session_id: 's1', ...patch }))

test('los dos archivos declaran los hooks con el lanzador fijo y timeouts cortos', () => {
  const events: Record<Cli, Record<string, string | undefined>> = {
    claude: { SessionStart: undefined, Stop: undefined, PreToolUse: 'Agent|Bash', PostToolUse: '*', PostToolUseFailure: 'Agent|Bash' },
    codex: { SessionStart: undefined, Stop: undefined, PreToolUse: 'Agent|Bash|collaborationspawn_agent', PostToolUse: '*' },
  }
  for (const cli of CLIS) {
    const hooks = config(cli).hooks
    assert.deepEqual(Object.keys(hooks).sort(), Object.keys(events[cli]).sort(), cli)
    for (const [event, matcher] of Object.entries(events[cli])) {
      assert.equal(hooks[event].length, 1, `${cli} ${event}`)
      const [group] = hooks[event]
      assert.equal(group.matcher, matcher, `${cli} ${event}`)
      assert.equal(group.hooks.length, 1)
      const [handler] = group.hooks
      assert.deepEqual([handler.type, handler.command, handler.timeout], ['command', COMMANDS[cli], 10], `${cli} ${event}`)
    }
  }
  // El lanzador tiene que alcanzar a negar antes de que el CLI lo mate.
  const internal = Number(/BINARY_TIMEOUT_MS = (\d+)/.exec(readFileSync(LAUNCHER, 'utf8'))?.[1])
  assert.ok(internal > 0, 'el lanzador declara su tope interno')
  assert.ok(10 * 1000 - internal >= 5000, `tope interno ${internal} ms`)
})

test('los dos archivos declaran PostToolUse para todas las herramientas con el lanzador fijo', () => {
  for (const cli of CLIS) {
    const groups = config(cli).hooks.PostToolUse
    assert.equal(groups.length, 1, cli)
    assert.equal(groups[0].matcher, '*', cli)
    assert.deepEqual(groups[0].hooks, [{ type: 'command', command: COMMANDS[cli], timeout: 10 }], cli)
    // El resto de los eventos usa el mismo comando.
    for (const [event, list] of Object.entries(config(cli).hooks)) assert.equal(list[0].hooks[0].command, COMMANDS[cli], `${cli} ${event}`)
  }
})

test('el lanzador encuentra el binario desde el cwd del payload', () => {
  for (const cli of CLIS) {
    // Un repo por invocación: el mismo Stop en la misma sesión ya no recuerda nada.
    const [direct, configured] = [testRepo(), testRepo()]
    for (const r of [launch(cli, stopOf(cli, direct)), runConfigured(cli, configured, stopOf(cli, configured))]) {
      assert.equal(r.code, 0)
      const out = JSON.parse(r.out) as unknown
      assert.deepEqual(checkOutput(cli, 'Stop', out), [])
      assert.match(r.out, /20260101-0001-aaaa/)
    }
  }
})

test('el lanzador sale con 0 y sin salida ante un payload ilegible, mayor de 1 MiB o con un cwd fuera de un repo', () => {
  for (const cli of CLIS) {
    const repo = testRepo()
    const big = JSON.stringify({ ...JSON.parse(stopOf(cli, repo)), relleno: 'x'.repeat(1024 * 1024) })
    const outside = mkdtempSync(join(tmpdir(), 'sdd-ai-sin-repo-'))
    for (const input of ['no es json', '', big, stopOf(cli, outside), dispatchOf(cli, outside)]) {
      assert.deepEqual(launch(cli, input), { code: 0, out: '' }, input.slice(0, 60))
    }
  }
})

test('el lanzador respeta el silencio del binario ante un session_id inválido', () => {
  for (const cli of CLIS) {
    const repo = testRepo()
    assert.deepEqual(launch(cli, dispatchOf(cli, repo, { session_id: '../x' })), { code: 0, out: '' })
    assert.deepEqual(launch(cli, stopOf(cli, repo, { session_id: '../x' })), { code: 0, out: '' })
  }
})

test('el lanzador niega un despacho sdd-ai-* si el binario falla', () => {
  for (const cli of CLIS) {
    for (const bin of ['none', 'fails', 'hangs'] as const) {
      const repo = testRepo(bin)
      const r = launch(cli, dispatchOf(cli, repo))
      assert.equal(r.code, 0)
      const out = JSON.parse(r.out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', `${cli} ${bin}`)
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /no pudo comprobar el despacho/)
      assert.deepEqual(checkOutput(cli, 'PreToolUse', out), [], `${cli} ${bin}`)
      if (cli === 'codex') {
        const v2 = JSON.parse(launch(cli, JSON.stringify(payload(cli, 'pre-tool-use-spawn-agent-v2', { cwd: repo, session_id: 's1' }))).out)
        assert.equal(v2.hookSpecificOutput.permissionDecision, 'deny', `v2 ${bin}`)
      }
      // Fuera de un despacho sdd-ai-*, un binario roto no niega ni recuerda nada.
      assert.deepEqual(launch(cli, stopOf(cli, repo)), { code: 0, out: '' }, `${cli} ${bin}`)
    }
  }
})

const toolOf = (cli: Cli, repo: string, name: string, patch: Record<string, unknown> = {}) =>
  JSON.stringify(payload(cli, name, { cwd: repo, session_id: 's1', ...patch }))
const routeOf = (repo: string, session = 's1') => join(repo, '.sdd-ai', 'hooks', 'route', `${session}.json`)
const trailOf = (repo: string) =>
  readFileSync(join(repo, '.sdd-ai', 'hooks', 'route', 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)

test('el lanzador deja pasar el Bash del conductor en PostToolUse', () => {
  for (const cli of CLIS) {
    const repo = testRepo()
    assert.deepEqual(launch(cli, toolOf(cli, repo, 'post-tool-use-bash')), { code: 0, out: '' })
    const state = JSON.parse(readFileSync(routeOf(repo), 'utf8')) as Record<string, number>
    assert.deepEqual([state.calls, state.reads], [1, 1], 'el Bash de la sonda es una lectura')
  }
})

test('el lanzador calla ante una herramienta de subagente sin arrancar el binario', () => {
  for (const cli of CLIS) {
    // Un binario que se cuelga: si el lanzador lo arrancara, tardaría su tope entero.
    const repo = testRepo('hangs')
    const name = cli === 'claude' ? 'post-tool-use-read-subagent' : 'post-tool-use-bash-subagent'
    const started = Date.now()
    assert.deepEqual(launch(cli, toolOf(cli, repo, name)), { code: 0, out: '' })
    assert.ok(Date.now() - started < 2000, `tardó ${Date.now() - started} ms`)
    assert.equal(existsSync(join(repo, '.sdd-ai', 'hooks')), false)
  }
})

test('el lanzador en proceso ignora un session_id inválido', () => {
  for (const cli of CLIS) {
    const repo = testRepo()
    assert.deepEqual(launch(cli, toolOf(cli, repo, 'post-tool-use-bash', { session_id: '../x' })), { code: 0, out: '' })
    assert.deepEqual(launch(cli, toolOf(cli, repo, 'pre-tool-use-bash', { session_id: '../x' })), { code: 0, out: '' })
    assert.equal(existsSync(join(repo, '.sdd-ai', 'hooks')), false)
  }
})

test('una sesión abierta antes de los hooks registra como run la corrida que lanza su primer Bash', () => {
  for (const cli of CLIS) {
    const repo = testRepo()
    writeJsonAtomic(join(repo, '.sdd-ai', 'runs', '20260101-0001-aaaa', 'resolved.json'), { family: cli, via: 'process' })
    assert.deepEqual(launch(cli, toolOf(cli, repo, 'pre-tool-use-bash')), { code: 0, out: '' })
    assert.ok(existsSync(routeOf(repo)), 'el primer Bash empieza el rastro')
    const dir = createRun(repo, '20260101-0002-aaaa')
    writeJsonAtomic(join(dir, 'request.json'), { session: 's1', conductor: { family: cli }, role: 'explore' })
    writeJsonAtomic(join(dir, 'resolved.json'), { family: cli, via: 'process' })
    assert.deepEqual(launch(cli, toolOf(cli, repo, 'post-tool-use-bash')), { code: 0, out: '' })
    const lines = trailOf(repo)
    assert.deepEqual(lines.map((l) => [l.event, l.run]), [['start', undefined], ['existing', '20260101-0001-aaaa'], ['run', '20260101-0002-aaaa']])
    assert.equal(lines[0].via, 'PreToolUse')
    assert.deepEqual(readdirSync(join(repo, '.sdd-ai', 'hooks', 'route')).sort(), ['s1.json', 's1.jsonl'])
  }
})

/** Un `bin/sdd-ai` que anota cada evento que recibe en `stub.log` y sale con `code`, o se cuelga. */
function stubRepo(stub: number | 'hangs', jira?: string): string {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  mkdirSync(join(repo, 'bin'))
  const body = stub === 'hangs' ? 'setTimeout(() => {}, 60000)' : `process.exit(${stub})`
  writeFileSync(join(repo, 'bin', 'sdd-ai'),
    `const fs = require('fs')\nfs.appendFileSync(__dirname + '/../stub.log', JSON.parse(fs.readFileSync(0, 'utf8')).hook_event_name + '\\n')\n${body}\n`)
  if (jira !== undefined) writeFileSync(join(repo, '.sdd-ai', 'config.yml'), jira)
  return repo
}
const stubCalls = (repo: string) => (existsSync(join(repo, 'stub.log')) ? readFileSync(join(repo, 'stub.log'), 'utf8').trim().split('\n') : [])

/** El payload de un `Bash` con `command`, en el evento de ese fixture. */
const bashOf = (cli: Cli, repo: string, name: string, command: string, patch: Record<string, unknown> = {}) => {
  const base = payload(cli, name, {})
  return JSON.stringify({ ...base, cwd: repo, session_id: 's1', ...patch, tool_input: { ...(base.tool_input as object), command } })
}

/** Como `launch`, pero sin bloquear: los casos del binario colgado corren a la vez. */
function launchAsync(cli: Cli, input: string, launcher = LAUNCHER): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [launcher, cli], { cwd: foreign() })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.on('close', (code) => done({ code, out }))
    child.stdin.end(input)
  })
}

const BIND = './bin/sdd-ai sdd status f1'

test('el lanzador no arranca el binario para un comando sin git commit y sí para uno con commit', () => {
  for (const cli of CLIS) {
    const repo = stubRepo(0)
    for (const command of ['ls', 'git log --grep commit', 'echo "git commit"', 'git commit-tree x']) {
      assert.deepEqual(launch(cli, bashOf(cli, repo, 'pre-tool-use-bash', command)), { code: 0, out: '' }, command)
    }
    assert.deepEqual(stubCalls(repo), [])
    assert.deepEqual(launch(cli, bashOf(cli, repo, 'pre-tool-use-bash', 'git add . && git commit -m x')), { code: 0, out: '' })
    assert.deepEqual(stubCalls(repo), ['PreToolUse'])
  }
})

test('el lanzador manda al binario el PostToolUse de un comando de liga y no el de otro comando', () => {
  for (const cli of CLIS) {
    const repo = stubRepo(0)
    assert.deepEqual(launch(cli, bashOf(cli, repo, 'post-tool-use-bash', 'ls')), { code: 0, out: '' })
    assert.deepEqual(stubCalls(repo), [])
    assert.deepEqual(launch(cli, bashOf(cli, repo, 'post-tool-use-bash', `${BIND} --json | head`)), { code: 0, out: '' })
    assert.deepEqual(stubCalls(repo), ['PostToolUse'])
  }
  const repo = stubRepo(0)
  assert.deepEqual(launch('claude', bashOf('claude', repo, 'post-tool-use-failure-bash', 'false')), { code: 0, out: '' })
  assert.deepEqual(stubCalls(repo), [])
  assert.deepEqual(launch('claude', bashOf('claude', repo, 'post-tool-use-failure-bash', BIND)), { code: 0, out: '' })
  assert.deepEqual(stubCalls(repo), ['PostToolUseFailure'])
})

test('si el binario falla ante un commit, el lanzador niega con liga o con jira_approval en la config y calla sin ninguno', async () => {
  const cases: Array<Promise<void>> = []
  for (const cli of CLIS) {
    for (const stub of [1, 'hangs'] as const) {
      const check = (name: string, repo: string, denies: RegExp | null) => cases.push(launchAsync(cli, bashOf(cli, repo, 'pre-tool-use-bash', 'git commit -m x')).then((r) => {
        assert.equal(r.code, 0, name)
        if (denies === null) return assert.equal(r.out, '', `${cli} ${stub} ${name}`)
        const out = JSON.parse(r.out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
        assert.deepEqual(checkOutput(cli, 'PreToolUse', out), [], `${cli} ${stub} ${name}`)
        assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', `${cli} ${stub} ${name}`)
        assert.match(out.hookSpecificOutput.permissionDecisionReason, denies, `${cli} ${stub} ${name}`)
        assert.match(out.hookSpecificOutput.permissionDecisionReason, /el commit lo hace el usuario/, `${cli} ${stub} ${name}`)
      }))
      const bound = stubRepo(stub)
      mkdirSync(join(bound, '.sdd-ai', 'hooks', 'route'), { recursive: true })
      writeFileSync(routeOf(bound), JSON.stringify({ calls: 0, reads: 0, edits: 0, seen: [], snapshot_pending: [], flow: { id: 'f1', step: 'implement', gate: null, at: 'x' } }))
      check('con liga', bound, /flujo f1/)
      const broken = stubRepo(stub)
      mkdirSync(join(broken, '.sdd-ai', 'hooks', 'route'), { recursive: true })
      writeFileSync(routeOf(broken), '{roto')
      check('estado ilegible', broken, /el estado de esta sesión no se puede leer/)
      const nulled = stubRepo(stub)
      mkdirSync(join(nulled, '.sdd-ai', 'hooks', 'route'), { recursive: true })
      writeFileSync(routeOf(nulled), 'null')
      check('estado null', nulled, /el estado de esta sesión no se puede leer/)
      check('jira on', stubRepo(stub, 'jira_approval:\n  mode: "on"\n'), /jira_approval/)
      check('jira off', stubRepo(stub, 'jira_approval:\n  mode: "off"\n'), null)
      check('sin config', stubRepo(stub), null)
    }
  }
  await Promise.all(cases)
})

test('si el binario falla o vence al ligar, el lanzador avisa con el evento correcto', async () => {
  const cases: Array<Promise<void>> = []
  for (const stub of [1, 'hangs'] as const) {
    const events: Array<[Cli, string, string]> = [['claude', 'post-tool-use-bash', 'PostToolUse'], ['codex', 'post-tool-use-bash', 'PostToolUse'], ['claude', 'post-tool-use-failure-bash', 'PostToolUseFailure']]
    for (const [cli, name, event] of events) {
      cases.push(launchAsync(cli, bashOf(cli, stubRepo(stub), name, BIND)).then((r) => {
        const out = JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
        assert.deepEqual(checkOutput(cli, event, out), [], `${cli} ${event} ${stub}`)
        assert.equal(out.hookSpecificOutput.hookEventName, event)
        assert.match(out.hookSpecificOutput.additionalContext, /^sdd-ai: no se pudo confirmar la liga con el flujo f1 \(.+\); corre \.\/bin\/sdd-ai sdd status f1 otra vez$/)
      }))
    }
  }
  await Promise.all(cases)
})

test('si el parser no carga, el evento posterior va al binario y, si también falla, avisa', () => {
  const copy = join(mkdtempSync(join(tmpdir(), 'sdd-ai-lanzador-')), 'bin')
  mkdirSync(copy)
  const launcher = join(copy, 'sdd-ai-hook')
  copyFileSync(LAUNCHER, launcher)
  const run = (cli: Cli, input: string) => {
    const r = spawnSync(process.execPath, [launcher, cli], { cwd: foreign(), input, encoding: 'utf8' })
    return { code: r.status, out: r.stdout }
  }
  for (const cli of CLIS) {
    const ok = stubRepo(0)
    assert.deepEqual(run(cli, bashOf(cli, ok, 'post-tool-use-bash', BIND)), { code: 0, out: '' })
    assert.deepEqual(run(cli, bashOf(cli, ok, 'pre-tool-use-bash', 'git commit -m x')), { code: 0, out: '' })
    assert.deepEqual(stubCalls(ok), ['PostToolUse', 'PreToolUse'])
    const failing = stubRepo(1)
    const r = run(cli, bashOf(cli, failing, 'post-tool-use-bash', BIND))
    const out = JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    assert.deepEqual(checkOutput(cli, 'PostToolUse', out), [], cli)
    assert.match(out.hookSpecificOutput.additionalContext, /^sdd-ai: no se pudo comprobar si el comando liga un flujo \(.+\); si corriste sdd status <id>, córrelo otra vez$/)
  }
})
