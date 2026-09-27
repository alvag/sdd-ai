import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guardDispatch, runHook } from '../src/hooks.ts'
import { cancelNative, launchState, release, reserve } from '../src/native-launch.ts'
import { openRuns, runKey } from '../src/open-runs.ts'
import { createRun, readStatus, setStatus, writeJsonAtomic } from '../src/runs.ts'
import type { Status } from '../src/types.ts'
import { checkOutput, payload } from './hook-contract.ts'
import { makeRepo } from './helpers.ts'

const CLIS = ['claude', 'codex'] as const
type Cli = typeof CLIS[number]

/** Una corrida con dueño `s1` salvo que se diga otro; `session: null` la deja sin dueño. */
function makeRun(repo: string, id: string, status: Status, o: { session?: string | null; review?: boolean; native?: boolean } = {}): string {
  const dir = createRun(repo, id)
  const request: Record<string, unknown> = { conductor: { family: 'claude' }, role: 'explore' }
  if (o.session !== null) request.session = o.session ?? 's1'
  if (o.review) request.kind = 'review'
  writeJsonAtomic(join(dir, 'request.json'), request)
  writeFileSync(join(dir, 'prompt.md'), 'Encargo.\n')
  if (o.native) writeJsonAtomic(join(dir, 'native.json'), { agent: 'sdd-ai-explore', family: 'claude', role: 'explore' })
  setStatus(dir, status)
  return dir
}

const delivered = (dir: string, s: Status) => writeJsonAtomic(join(dir, 'delivered.json'), { round: s.round ?? null, launch: s.launch ?? null })

type Out = Record<string, any>

function fire(cli: Cli, event: 'session-start' | 'stop', repo: string, patch: Record<string, unknown>): Out | '' {
  const out = runHook(JSON.stringify(payload(cli, event, { cwd: repo, ...patch })), cli)
  return out === '' ? '' : JSON.parse(out) as Out
}

/** El texto que el CLI le muestra al modelo: `additionalContext` o, en el `Stop` de Codex, `reason`. */
const text = (out: Out | ''): string => {
  assert.notEqual(out, '', 'se esperaba una salida')
  const o = out as Out
  return o.hookSpecificOutput?.additionalContext ?? o.reason
}

test('un payload inválido, un repo sin .sdd-ai y un error interno salen con 0 y sin salida', () => {
  for (const cli of CLIS) {
    assert.equal(runHook('no es json', cli), '')
    assert.equal(runHook('"un string"', cli), '')
    assert.equal(runHook(JSON.stringify(payload(cli, 'stop', { cwd: makeRepo(), session_id: 's1' })), cli), '')
    assert.equal(runHook(JSON.stringify(payload(cli, 'stop', { cwd: '/no/existe', session_id: 's1' })), cli), '')
    const broken = makeRepo()
    mkdirSync(join(broken, '.sdd-ai'))
    writeFileSync(join(broken, '.sdd-ai', 'runs'), 'no es un directorio')
    assert.equal(runHook(JSON.stringify(payload(cli, 'stop', { cwd: broken, session_id: 's1' })), cli), '')
    // Un payload que respondería, pero pasa de 1 MiB.
    const repo = makeRepo()
    makeRun(repo, '20260101-0001-aaaa', { state: 'running' })
    const big = { ...payload(cli, 'stop', { cwd: repo, session_id: 's1' }), relleno: 'x'.repeat(1024 * 1024) }
    assert.equal(runHook(JSON.stringify(big), cli), '')
    assert.notEqual(runHook(JSON.stringify(payload(cli, 'stop', { cwd: repo, session_id: 's1' })), cli), '')
  }
})

test('una corrida ilegible no calla a las demás', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    makeRun(repo, '20260101-0001-aaaa', { state: 'done' })
    writeFileSync(join(makeRun(repo, '20260101-0002-aaaa', { state: 'done' }), 'request.json'), '{"session":')
    const ctx = text(fire(cli, 'session-start', repo, { session_id: 's1', source: 'resume' }))
    assert.match(ctx, /20260101-0001-aaaa/)
    assert.doesNotMatch(ctx, /20260101-0002-aaaa/)
  }
})

test('un session_id con separadores se ignora', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    makeRun(repo, '20260101-0001-aaaa', { state: 'running' }, { session: '../x' })
    makeRun(repo, '20260101-0002-aaaa', { state: 'running' }, { session: 'a/b' })
    assert.equal(fire(cli, 'stop', repo, { session_id: '../x' }), '')
    assert.equal(fire(cli, 'stop', repo, { session_id: 'a/b' }), '')
    assert.equal(fire(cli, 'session-start', repo, { session_id: '../x', source: 'resume' }), '')
    assert.equal(existsSync(join(repo, '.sdd-ai', 'x.json')), false)
    assert.equal(existsSync(join(repo, '.sdd-ai', 'hooks', 'a')), false)
  }
})

test('el validador rechaza un allow sin updatedInput, un deny sin motivo y un ask', () => {
  const pre = (h: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...h } })
  assert.deepEqual(checkOutput('codex', 'PreToolUse', pre({ permissionDecision: 'allow', updatedInput: { message: 'x' } })), [])
  assert.deepEqual(checkOutput('codex', 'PreToolUse', pre({ permissionDecision: 'deny', permissionDecisionReason: 'motivo' })), [])
  assert.notDeepEqual(checkOutput('codex', 'PreToolUse', pre({ permissionDecision: 'allow' })), [])
  assert.notDeepEqual(checkOutput('codex', 'PreToolUse', pre({ permissionDecision: 'deny' })), [])
  assert.notDeepEqual(checkOutput('codex', 'PreToolUse', pre({ permissionDecision: 'deny', permissionDecisionReason: '  ' })), [])
  assert.notDeepEqual(checkOutput('codex', 'PreToolUse', pre({ permissionDecision: 'ask', permissionDecisionReason: 'motivo' })), [])
  assert.notDeepEqual(checkOutput('codex', 'PreToolUse', pre({ updatedInput: { message: 'x' } })), [])
  assert.notDeepEqual(checkOutput('codex', 'Stop', { decision: 'block' }), [])
  assert.notDeepEqual(checkOutput('codex', 'Stop', { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x' } }), [])
  assert.notDeepEqual(checkOutput('codex', 'SessionStart', { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'x' }, extra: 1 }), [])
  assert.notDeepEqual(checkOutput('claude', 'SessionStart', { decision: 'block', reason: 'x' }), [])
  assert.notDeepEqual(checkOutput('claude', 'Stop', { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'x' } }), [])
})

test('SessionStart resume y compact inyectan las abiertas propias', () => {
  for (const cli of CLIS) {
    for (const source of ['resume', 'compact']) {
      const repo = makeRepo()
      makeRun(repo, '20260101-0001-aaaa', { state: 'done' })
      makeRun(repo, '20260101-0002-aaaa', { state: 'delegated' }, { native: true })
      makeRun(repo, '20260101-0003-aaaa', { state: 'running' }, { session: 's2' })
      const out = fire(cli, 'session-start', repo, { session_id: 's1', source })
      assert.deepEqual(checkOutput(cli, 'SessionStart', out), [], `${cli} ${source}`)
      const ctx = text(out)
      assert.match(ctx, /20260101-0001-aaaa \(worker\) terminó sin entregar; sigue: \.\/bin\/sdd-ai wait 20260101-0001-aaaa/)
      assert.match(ctx, /20260101-0002-aaaa \(nativa\) no se lanzó/)
      assert.doesNotMatch(ctx, /20260101-0003-aaaa/)
    }
  }
})

test('sin corridas abiertas SessionStart no inyecta nada', () => {
  for (const cli of CLIS) {
    const empty = makeRepo()
    mkdirSync(join(empty, '.sdd-ai'))
    assert.equal(fire(cli, 'session-start', empty, { session_id: 's1', source: 'resume' }), '')
    const repo = makeRepo()
    const done: Status = { state: 'done' }
    delivered(makeRun(repo, '20260101-0001-aaaa', done), done)
    for (const source of ['resume', 'compact']) assert.equal(fire(cli, 'session-start', repo, { session_id: 's1', source }), '')
  }
})

test('SessionStart startup y clear listan en una línea las abiertas de otras sesiones', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    makeRun(repo, '20260101-0001-aaaa', { state: 'done' })
    makeRun(repo, '20260101-0002-aaaa', { state: 'running' }, { session: 's2' })
    makeRun(repo, '20260101-0003-aaaa', { state: 'delegated' }, { session: 's3', native: true })
    makeRun(repo, '20260101-0004-aaaa', { state: 'running' }, { session: null })
    for (const source of ['startup', 'clear']) {
      const out = fire(cli, 'session-start', repo, { session_id: 's1', source })
      assert.deepEqual(checkOutput(cli, 'SessionStart', out), [], `${cli} ${source}`)
      const ctx = text(out)
      assert.equal(ctx.includes('\n'), false, 'una sola línea')
      assert.match(ctx, /20260101-0002-aaaa \(corriendo\)/)
      assert.match(ctx, /20260101-0003-aaaa \(nativa sin lanzar\)/)
      assert.doesNotMatch(ctx, /20260101-0001-aaaa|20260101-0004-aaaa/)
    }
    assert.equal(fire(cli, 'session-start', repo, { session_id: 's1', source: 'fork' }), '')
    const alone = makeRepo()
    makeRun(alone, '20260101-0001-aaaa', { state: 'running' })
    assert.equal(fire(cli, 'session-start', alone, { session_id: 's1', source: 'startup' }), '')
  }
})

test('Stop recuerda una vez las corridas abiertas propias con lo que sigue', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    makeRun(repo, '20260101-0001-aaaa', { state: 'done' })
    const reserved = makeRun(repo, '20260101-0002-aaaa', { state: 'delegated' }, { native: true })
    assert.equal(reserve(reserved, 'tu-1'), true)
    makeRun(repo, '20260101-0003-aaaa', { state: 'running' }, { session: 's2' })
    const out = fire(cli, 'stop', repo, { session_id: 's1' })
    assert.deepEqual(checkOutput(cli, 'Stop', out), [])
    if (cli === 'codex') assert.equal((out as Out).decision, 'block')
    else assert.equal((out as Out).hookSpecificOutput.hookEventName, 'Stop')
    const reason = text(out)
    assert.match(reason, /sigue: \.\/bin\/sdd-ai wait 20260101-0001-aaaa/)
    assert.match(reason, /20260101-0002-aaaa .*sigue: preguntarle al usuario/)
    assert.doesNotMatch(reason, /20260101-0003-aaaa/)
    assert.equal(fire(cli, 'stop', repo, { session_id: 's1' }), '')
    assert.equal(fire(cli, 'stop', makeRepo(), { session_id: 's1' }), '', 'sin corridas propias no hay nada que recordar')
  }
})

test('Stop calla con el mismo conjunto o con stop_hook_active', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    makeRun(repo, '20260101-0001-aaaa', { state: 'running' })
    assert.equal(fire(cli, 'stop', repo, { session_id: 's1', stop_hook_active: true }), '')
    assert.notEqual(fire(cli, 'stop', repo, { session_id: 's1' }), '')
    assert.equal(fire(cli, 'stop', repo, { session_id: 's1' }), '')
    assert.equal(fire(cli, 'stop', repo, { session_id: 's1', stop_hook_active: true }), '')
  }
})

test('Stop calla si no puede guardar el recordatorio', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    makeRun(repo, '20260101-0001-aaaa', { state: 'running' })
    writeFileSync(join(repo, '.sdd-ai', 'hooks'), 'no es un directorio')
    assert.equal(fire(cli, 'stop', repo, { session_id: 's1' }), '')
  }
})

test('Stop recuerda el relanzamiento de una ronda de revisión', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    const dir = makeRun(repo, '20260101-0001-aaaa', { state: 'running', round: 1, launch: 1 }, { review: true })
    assert.match(text(fire(cli, 'stop', repo, { session_id: 's1' })), /revisión, ronda 1/)
    assert.equal(fire(cli, 'stop', repo, { session_id: 's1' }), '')
    setStatus(dir, { launch: 2 })
    assert.notEqual(fire(cli, 'stop', repo, { session_id: 's1' }), '')
    const reminded = JSON.parse(readFileSync(join(repo, '.sdd-ai', 'hooks', 's1.json'), 'utf8')).reminded
    assert.ok(reminded.includes(runKey(openRuns(repo)[0])), 'la clave guardada es la de openRuns')
    assert.ok(reminded.includes('20260101-0001-aaaa|running|1|2|'))
  }
})

test('Stop vuelve a recordar si cambian el estado, la ronda o el intento', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    const stop = () => fire(cli, 'stop', repo, { session_id: 's1' })
    const worker = makeRun(repo, '20260101-0001-aaaa', { state: 'running' })
    assert.notEqual(stop(), '')
    setStatus(worker, { state: 'done' })
    assert.match(text(stop()), /20260101-0001-aaaa \(worker\) terminó sin entregar/)
    delivered(worker, { state: 'done' })

    const review = makeRun(repo, '20260101-0002-aaaa', { state: 'running', round: 1, launch: 1 }, { review: true })
    assert.notEqual(stop(), '')
    setStatus(review, { round: 2, launch: 1 })
    assert.match(text(stop()), /revisión, ronda 2/)
    setStatus(review, { state: 'cancelled' })
    delivered(review, { state: 'cancelled', round: 2, launch: 1 })

    const native = makeRun(repo, '20260101-0003-aaaa', { state: 'delegated' }, { native: true })
    assert.notEqual(stop(), '')
    assert.equal(reserve(native, 'tu-1'), true)
    assert.notEqual(stop(), '')
    assert.equal(release(native, 'tu-1'), true)
    assert.match(text(stop()), /1 lanzamiento fallido/)
    assert.equal(stop(), '')
  }
})

// Despachos de agentes: las corridas nativas salen de bin/sdd-ai run, como en una sesión real.

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const DISPATCH = { claude: 'pre-tool-use-agent', codex: 'pre-tool-use-spawn-agent-v1' } as const
const canonical = (file: string) => `Tu encargo está en ${file}. Léelo completo y cúmplelo.`

function sdd(repo: string, cli: Cli, args: string[], session = 's1'): Out {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CODEX_HOME: mkdtempSync(join(tmpdir(), 'sdd-ai-codexhome-')) }
  if (cli === 'claude') Object.assign(env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session })
  else Object.assign(env, { CODEX_THREAD_ID: 't', CODEX_SESSION_ID: session })
  const r = spawnSync(BIN, args, { cwd: repo, env, encoding: 'utf8' })
  return JSON.parse(r.stdout) as Out
}

/** Repo con sdd-ai configurado para una sola familia y sus agentes generados. */
function sddRepo(cli: Cli): string {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: [${cli}]\n  selection: full\n`)
  sdd(repo, cli, ['agents', 'sync'])
  return repo
}

/** Una corrida nativa creada por `run`; devuelve lo que `run` le mostró al conductor. */
function nativeRun(repo: string, cli: Cli, args: string[] = [], session = 's1'): Out {
  const prompt = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(prompt, 'Encargo de prueba.\n')
  const out = sdd(repo, cli, ['run', '--prompt-file', prompt, ...args], session)
  assert.equal(out.via, 'native', JSON.stringify(out))
  return out
}

function dispatch(cli: Cli, repo: string, input: Record<string, unknown>, patch: Record<string, unknown> = {}): Out | '' {
  const base = payload(cli, DISPATCH[cli], {})
  const p = { ...base, cwd: repo, session_id: 's1', tool_use_id: 'tu-1', ...patch, tool_input: { ...(base.tool_input as object), ...input } }
  const out = runHook(JSON.stringify(p), cli)
  return out === '' ? '' : JSON.parse(out) as Out
}

const CIPHER = (payload('codex', 'pre-tool-use-spawn-agent-v2', {}).tool_input as Record<string, string>).message

/** Un despacho de `spawn_agent` v2, como lo manda Codex: `collaborationspawn_agent` con el mensaje cifrado. */
function dispatchV2(repo: string, input: Record<string, unknown> = {}, patch: Record<string, unknown> = {}): Out | '' {
  const base = payload('codex', 'pre-tool-use-spawn-agent-v2', {})
  const p = { ...base, cwd: repo, session_id: 's1', tool_use_id: 'tu-1', ...patch, tool_input: { ...(base.tool_input as object), ...input } }
  const out = runHook(JSON.stringify(p), 'codex')
  return out === '' ? '' : JSON.parse(out) as Out
}

const typeKey = (cli: Cli) => (cli === 'claude' ? 'subagent_type' : 'agent_type')
const textKey = (cli: Cli) => (cli === 'claude' ? 'prompt' : 'message')
const decision = (out: Out | '') => (out === '' ? '' : out.hookSpecificOutput.permissionDecision)
const denial = (out: Out | ''): string => {
  assert.equal(decision(out), 'deny', JSON.stringify(out))
  return (out as Out).hookSpecificOutput.permissionDecisionReason
}

test('sin .sdd-ai calla también ante un despacho sdd-ai-*', () => {
  for (const cli of CLIS) {
    assert.equal(dispatch(cli, makeRepo(), { [typeKey(cli)]: 'sdd-ai-explore' }), '')
    assert.equal(dispatch(cli, makeRepo(), { [typeKey(cli)]: 'sdd-ai-explore' }, { agent_id: 'a1', agent_type: 'worker' }), '')
  }
})

test('un despacho sdd-ai-* desde un hijo se niega', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const run = nativeRun(repo, cli)
    const out = dispatch(cli, repo, { [typeKey(cli)]: 'sdd-ai-explore', [textKey(cli)]: run.prompt_file }, { agent_id: 'a1', agent_type: 'general-purpose' })
    assert.match(denial(out), /subagente/)
    assert.deepEqual(checkOutput(cli, 'PreToolUse', out), [])
    assert.equal(existsSync(join(repo, '.sdd-ai', 'runs', run.id, 'launch.json')), false)
  }
})

test('una sesión principal con agent_type y sin agent_id no se trata como hijo', () => {
  const repo = sddRepo('claude')
  const run = nativeRun(repo, 'claude')
  const out = dispatch('claude', repo, { subagent_type: 'sdd-ai-explore' }, { agent_type: 'mi-agente' })
  assert.equal(decision(out), 'allow', JSON.stringify(out))
  assert.equal(existsSync(join(repo, '.sdd-ai', 'runs', run.id, 'launch.json')), true)
})

test('un agente que no es sdd-ai-* no se toca', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    nativeRun(repo, cli)
    assert.equal(dispatch(cli, repo, { [typeKey(cli)]: 'general-purpose' }), '')
    assert.equal(dispatch(cli, repo, { [typeKey(cli)]: 'general-purpose' }, { agent_id: 'a1', agent_type: 'worker' }), '')
  }
  const repo = sddRepo('codex')
  const noType = payload('codex', DISPATCH.codex, { cwd: repo, session_id: 's1', tool_input: { message: 'hola' } })
  assert.equal(runHook(JSON.stringify(noType), 'codex'), '')
})

test('sin corrida que corresponda el despacho se niega con qué correr', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const empty = dispatch(cli, repo, { [typeKey(cli)]: 'sdd-ai-explore' })
    assert.match(denial(empty), /\.\/bin\/sdd-ai run --role explore/)
    assert.deepEqual(checkOutput(cli, 'PreToolUse', empty), [])
    nativeRun(repo, cli, [], 's2')
    nativeRun(repo, cli, ['--role', 'code-review'])
    assert.match(denial(dispatch(cli, repo, { [typeKey(cli)]: 'sdd-ai-explore' })), /sdd-ai run/)
  }
  // Una corrida de la otra familia tampoco corresponde.
  const repo = sddRepo('codex')
  nativeRun(repo, 'codex')
  assert.match(denial(dispatch('claude', repo, { subagent_type: 'sdd-ai-explore' })), /sdd-ai run/)
})

test('se niega con dos citas o con una cita a una corrida no elegible, también dentro de items', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const a = nativeRun(repo, cli)
    const b = nativeRun(repo, cli)
    const other = nativeRun(repo, cli, [], 's2')
    const type = { [typeKey(cli)]: 'sdd-ai-explore' }
    assert.match(denial(dispatch(cli, repo, { ...type, [textKey(cli)]: `${a.prompt_file} y ${b.prompt_file}` })), /más de una/)
    assert.match(denial(dispatch(cli, repo, { ...type, [textKey(cli)]: `${a.prompt_file}.bak` })), /cita el prompt_file/)
    assert.match(denial(dispatch(cli, repo, { ...type, [textKey(cli)]: `${a.prompt_file}/extra` })), /cita el prompt_file/)
    assert.match(denial(dispatch(cli, repo, { ...type, [textKey(cli)]: other.prompt_file })), new RegExp(`${other.id} no se puede despachar`))
    if (cli === 'codex') {
      const items = [{ type: 'text', text: `lee ${other.prompt_file}` }]
      assert.match(denial(dispatch(cli, repo, { ...type, message: a.prompt_file, items })), /más de una/)
      assert.match(denial(dispatch(cli, repo, { ...type, message: 'hola', items })), new RegExp(`${other.id} no se puede despachar`))
    }
    for (const id of [a.id, b.id, other.id]) assert.equal(existsSync(join(repo, '.sdd-ai', 'runs', id, 'launch.json')), false)
    // El mensaje canónico cierra la cita con un punto, y sigue contando como cita.
    assert.equal(decision(dispatch(cli, repo, { ...type, [textKey(cli)]: canonical(a.prompt_file) })), 'allow')
  }
})

test('sin poder listar las corridas el despacho se niega con el error', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    mkdirSync(join(repo, '.sdd-ai'))
    writeFileSync(join(repo, '.sdd-ai', 'runs'), 'no es un directorio')
    const out = dispatch(cli, repo, { [typeKey(cli)]: 'sdd-ai-explore' })
    assert.match(denial(out), /no se pudieron listar las corridas.*ENOTDIR/)
    assert.deepEqual(checkOutput(cli, 'PreToolUse', out), [])
  }
})

test('reescribe el input en Claude, Codex v1 y Codex v2 sin dejar texto del original', () => {
  const noise = 'TEXTO-DEL-ORIGINAL'
  const claude = sddRepo('claude')
  const c = nativeRun(claude, 'claude', ['--model', 'sonnet'])
  const cOut = dispatch('claude', claude, {
    subagent_type: 'sdd-ai-explore', description: noise, prompt: `${noise} ${c.prompt_file}`, model: 'haiku', run_in_background: true,
  })
  assert.deepEqual(checkOutput('claude', 'PreToolUse', cOut), [])
  assert.deepEqual((cOut as Out).hookSpecificOutput.updatedInput, {
    subagent_type: 'sdd-ai-explore', description: `sdd-ai explore ${c.id}`, prompt: canonical(c.prompt_file), model: 'sonnet', run_in_background: true,
  })

  const v1 = sddRepo('codex')
  const x = nativeRun(v1, 'codex', ['--model', 'gpt-prueba', '--effort', 'maximo'])
  const v1Out = dispatch('codex', v1, {
    agent_type: 'sdd-ai-explore', message: `${noise} ${x.prompt_file}`, items: [{ type: 'text', text: noise }], fork_context: true, model: 'otro', reasoning_effort: 'low',
  })
  assert.deepEqual(checkOutput('codex', 'PreToolUse', v1Out), [])
  assert.deepEqual((v1Out as Out).hookSpecificOutput.updatedInput, {
    agent_type: 'sdd-ai-explore', message: canonical(x.prompt_file), fork_context: false, model: 'gpt-prueba', reasoning_effort: 'max',
  })

  // En v2 el mensaje llega cifrado: pasa tal cual y el resto del input se arma desde cero.
  const v2 = sddRepo('codex')
  const r = nativeRun(v2, 'codex', ['--role', 'code-review', '--model', 'gpt-prueba', '--effort', 'maximo'])
  const v2Out = dispatchV2(v2, { agent_type: 'sdd-ai-code-review', task_name: noise, fork_turns: 'all', model: 'otro' })
  assert.deepEqual(checkOutput('codex', 'PreToolUse', v2Out), [])
  assert.deepEqual((v2Out as Out).hookSpecificOutput.updatedInput, {
    agent_type: 'sdd-ai-code-review', task_name: `sdd_ai_code_review_${r.id.replace(/[^a-z0-9]/g, '_')}`, message: CIPHER, fork_turns: 'none',
    model: 'gpt-prueba', reasoning_effort: 'max',
  })
  for (const out of [cOut, v1Out, v2Out]) assert.doesNotMatch(JSON.stringify((out as Out).hookSpecificOutput.updatedInput), new RegExp(noise))
  assert.equal(JSON.parse(readFileSync(join(v2, '.sdd-ai', 'runs', r.id, 'launch.json'), 'utf8')).tool_use_id, 'tu-1')
})

test('PostToolUse confirma y PostToolUseFailure libera por tool_use_id', () => {
  const post = (cli: Cli, name: string, repo: string, toolUseId: string) =>
    runHook(JSON.stringify(payload(cli, name, { cwd: repo, session_id: 's1', tool_use_id: toolUseId })), cli)
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const run = nativeRun(repo, cli)
    const dir = join(repo, '.sdd-ai', 'runs', run.id)
    assert.equal(decision(dispatch(cli, repo, { [typeKey(cli)]: 'sdd-ai-explore' })), 'allow')
    const name = cli === 'claude' ? 'post-tool-use-agent' : 'post-tool-use-spawn-agent'
    assert.equal(post(cli, name, repo, 'tu-otro'), '')
    assert.equal(existsSync(join(dir, 'launched.json')), false)
    assert.equal(post(cli, name, repo, 'tu-1'), '')
    assert.deepEqual(launchState(dir, readStatus(dir)), { kind: 'launched' })
  }
  const repo = sddRepo('claude')
  const run = nativeRun(repo, 'claude')
  const dir = join(repo, '.sdd-ai', 'runs', run.id)
  assert.equal(decision(dispatch('claude', repo, { subagent_type: 'sdd-ai-explore' })), 'allow')
  assert.equal(post('claude', 'post-tool-use-failure-agent', repo, 'tu-otro'), '')
  assert.equal(post('claude', 'post-tool-use-failure-agent', repo, 'tu-1'), '')
  assert.deepEqual(launchState(dir, readStatus(dir)), { kind: 'pending', attempt: 1 })
  // Liberada, la misma corrida se puede volver a despachar.
  assert.equal(decision(dispatch('claude', repo, { subagent_type: 'sdd-ai-explore' }, { tool_use_id: 'tu-2' })), 'allow')

  // spawn_agent v2 confirma con su propio nombre.
  const v2 = sddRepo('codex')
  const v2Run = nativeRun(v2, 'codex')
  const v2Dir = join(v2, '.sdd-ai', 'runs', v2Run.id)
  assert.equal(decision(dispatchV2(v2)), 'allow')
  assert.equal(post('codex', 'post-tool-use-spawn-agent-v2', v2, 'tu-1'), '')
  assert.deepEqual(launchState(v2Dir, readStatus(v2Dir)), { kind: 'launched' })
})

test('en Codex v2 se niega a los hijos, sin corrida y con varias pendientes', () => {
  const repo = sddRepo('codex')
  const none = dispatchV2(repo)
  assert.match(denial(none), /sdd-ai run --role explore/)
  const a = nativeRun(repo, 'codex')
  assert.match(denial(dispatchV2(repo, {}, { agent_id: 'a1', agent_type: 'worker' })), /subagente/)
  const b = nativeRun(repo, 'codex')
  const many = dispatchV2(repo)
  assert.match(denial(many), /cifrado.*\.\/bin\/sdd-ai cancel/)
  for (const out of [none, many]) assert.deepEqual(checkOutput('codex', 'PreToolUse', out), [])
  for (const run of [a, b]) assert.equal(existsSync(join(repo, '.sdd-ai', 'runs', run.id, 'launch.json')), false)
  assert.equal(cancelNative(join(repo, '.sdd-ai', 'runs', b.id)), true)
  assert.equal(decision(dispatchV2(repo)), 'allow')
  assert.equal(existsSync(join(repo, '.sdd-ai', 'runs', a.id, 'launch.json')), true)
})

test('en Claude el modelo viaja como alias', () => {
  const repo = sddRepo('claude')
  const run = nativeRun(repo, 'claude', ['--model', 'claude-sonnet-5'])
  const out = dispatch('claude', repo, { subagent_type: 'sdd-ai-explore', prompt: canonical(run.prompt_file) })
  assert.equal((out as Out).hookSpecificOutput.updatedInput.model, 'sonnet')
  // Lo que no se puede traducir pasa igual: el CLI lo rechaza a la vista.
  const other = sddRepo('claude')
  nativeRun(other, 'claude', ['--model', 'no-existe'])
  assert.equal((dispatch('claude', other, { subagent_type: 'sdd-ai-explore' }) as Out).hookSpecificOutput.updatedInput.model, 'no-existe')
})

test('una reserva sin confirmar se niega y Stop pide preguntar', () => {
  for (const cli of CLIS) {
    const repo = sddRepo(cli)
    const run = nativeRun(repo, cli)
    const type = { [typeKey(cli)]: 'sdd-ai-explore' }
    assert.equal(decision(dispatch(cli, repo, type)), 'allow')
    assert.match(denial(dispatch(cli, repo, { ...type, [textKey(cli)]: run.prompt_file }, { tool_use_id: 'tu-2' })), new RegExp(`${run.id} no se puede despachar`))
    assert.match(denial(dispatch(cli, repo, type, { tool_use_id: 'tu-3' })), /sdd-ai run/)
    assert.match(text(fire(cli, 'stop', repo, { session_id: 's1' })), new RegExp(`${run.id} .*sigue: preguntarle al usuario`))
  }
  // Cancelada entre la elegibilidad y la reserva: se libera y se niega.
  const repo = sddRepo('claude')
  const run = nativeRun(repo, 'claude')
  const p = payload('claude', DISPATCH.claude, { cwd: repo, session_id: 's1', tool_use_id: 'tu-1', tool_input: { subagent_type: 'sdd-ai-explore', prompt: 'hola' } })
  const out = JSON.parse(guardDispatch(p, repo, 's1', 'claude', (dir) => { cancelNative(dir) })) as Out
  assert.match(denial(out), /se canceló/)
  assert.equal(existsSync(join(repo, '.sdd-ai', 'runs', run.id, 'launch.json')), false)
})

test('cada salida cumple el esquema de salida de Codex y la forma de Claude', () => {
  for (const cli of CLIS) {
    const outputs: Array<[string, Out | '']> = []
    const repo = sddRepo(cli)
    makeRun(repo, '20260101-0001-aaaa', { state: 'done' })
    makeRun(repo, '20260101-0002-aaaa', { state: 'running' }, { session: 's2' })
    outputs.push(['SessionStart', fire(cli, 'session-start', repo, { session_id: 's1', source: 'resume' })])
    outputs.push(['SessionStart', fire(cli, 'session-start', repo, { session_id: 's1', source: 'startup' })])
    outputs.push(['Stop', fire(cli, 'stop', repo, { session_id: 's1' })])
    const type = { [typeKey(cli)]: 'sdd-ai-explore' }
    outputs.push(['PreToolUse', dispatch(cli, repo, type)])
    outputs.push(['PreToolUse', dispatch(cli, repo, type, { agent_id: 'a1', agent_type: 'worker' })])
    nativeRun(repo, cli)
    nativeRun(repo, cli)
    outputs.push(['PreToolUse', dispatch(cli, repo, type)])
    const run = nativeRun(repo, cli, ['--role', 'debate'])
    outputs.push(['PreToolUse', dispatch(cli, repo, { [typeKey(cli)]: 'sdd-ai-debate', [textKey(cli)]: run.prompt_file })])
    for (const [event, out] of outputs) {
      assert.notEqual(out, '', `${cli} ${event} respondió`)
      assert.deepEqual(checkOutput(cli, event, out), [], `${cli} ${event}: ${JSON.stringify(out)}`)
    }
  }
})

function shell(cli: Cli, repo: string, command: string, patch: Record<string, unknown> = {}): Out | '' {
  const base = payload(cli, 'pre-tool-use-bash', {})
  const p = { ...base, cwd: repo, session_id: 's1', ...patch, tool_input: { ...(base.tool_input as object), command } }
  const out = runHook(JSON.stringify(p), cli)
  return out === '' ? '' : JSON.parse(out) as Out
}

const CHILD = { agent_id: 'a1', agent_type: 'general-purpose' }
const WORKER_COMMANDS = [
  'sdd-ai run --prompt-file encargo.md',
  './bin/sdd-ai wait 20260101-0001-aaaa',
  '/abs/repo/bin/sdd-ai review start --base main',
  'node /abs/repo/bin/sdd-ai cancel 20260101-0001-aaaa',
  'cd sub && ./bin/sdd-ai run --prompt-file encargo.md',
  'echo ok\n./bin/sdd-ai wait 20260101-0001-aaaa',
]

test('dentro de un hijo se niegan run, review, wait y cancel en las formas reconocidas', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    mkdirSync(join(repo, '.sdd-ai'))
    for (const command of WORKER_COMMANDS) {
      const out = shell(cli, repo, command, CHILD)
      assert.match(denial(out), /un worker no delega ni toca las corridas del conductor/, command)
      assert.deepEqual(checkOutput(cli, 'PreToolUse', out), [], command)
    }
    for (const command of ['./bin/sdd-ai agents sync', 'sdd-ai doctor', 'ls bin/sdd-ai']) assert.equal(shell(cli, repo, command, CHILD), '', command)
  }
})

test('fuera de un hijo nunca se niega un comando de shell', () => {
  for (const cli of CLIS) {
    const repo = makeRepo()
    mkdirSync(join(repo, '.sdd-ai'))
    for (const command of WORKER_COMMANDS) assert.equal(shell(cli, repo, command), '', command)
    assert.equal(shell('claude', repo, WORKER_COMMANDS[0], { agent_type: 'mi-agente' }), '', 'agent_type sin agent_id es la sesión principal')
    for (const command of ['echo "sdd-ai run"', 'echo "a; sdd-ai run x"', 'echo \\; ./bin/sdd-ai run']) {
      assert.equal(shell(cli, repo, command, CHILD), '', command)
    }
  }
})

