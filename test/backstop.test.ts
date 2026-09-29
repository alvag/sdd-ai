import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FlowBinding, countTool, markBootstrap, readBinding, setBinding, startTrail } from '../src/backstop.ts'
import { ROUTE, type RouteThresholds } from '../src/route.ts'
import { createRun, writeJsonAtomic } from '../src/runs.ts'
import { payload } from './hook-contract.ts'
import { makeRepo } from './helpers.ts'

const MODULE = join(import.meta.dirname, '..', 'src', 'backstop.ts')
const EXPLORE = '`./bin/sdd-ai run --role explore --prompt-file <encargo>`'

type Cli = 'claude' | 'codex'
type Line = Record<string, unknown>

function sddRepo(): string {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  return repo
}

/** Una corrida como la deja `run` o `review`: `request.json` y, si `complete`, `resolved.json`. */
function makeRun(repo: string, id: string, o: { session?: string; kind?: 'worker' | 'native' | 'review'; role?: string; complete?: boolean } = {}): string {
  const dir = createRun(repo, id)
  const request: Record<string, unknown> = { session: o.session ?? 's1', conductor: { family: 'claude' } }
  if (o.kind === 'review') request.kind = 'review'
  else request.role = o.role ?? 'explore'
  writeJsonAtomic(join(dir, 'request.json'), request)
  if (o.complete !== false) completeRun(dir, o.kind)
  return dir
}

const completeRun = (dir: string, kind?: string) =>
  writeJsonAtomic(join(dir, 'resolved.json'), { family: 'claude', via: kind === 'native' ? 'native' : 'process', origin: { model: 'heredado', effort: 'heredado' } })

const routeDir = (repo: string) => join(repo, '.sdd-ai', 'hooks', 'route')
const trail = (repo: string, session = 's1'): Line[] => {
  const file = join(routeDir(repo), `${session}.jsonl`)
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line) : []
}
const state = (repo: string, session = 's1') => JSON.parse(readFileSync(join(routeDir(repo), `${session}.json`), 'utf8')) as Record<string, any>
const events = (repo: string, session = 's1') => trail(repo, session).map((l) => l.event)

/** Un `PostToolUse` real de la sonda, en este repo y en la sesión pedida. */
const tool = (cli: Cli, name: string, repo: string, patch: Record<string, unknown> = {}) =>
  payload(cli, name, { cwd: repo, session_id: 's1', ...patch })
const bash = (cli: Cli, repo: string, command: string) => {
  const base = tool(cli, 'post-tool-use-bash', repo)
  return { ...base, tool_input: { ...(base.tool_input as object), command } }
}
const named = (cli: Cli, repo: string, toolName: string) => ({ ...tool(cli, 'post-tool-use-bash', repo), tool_name: toolName, tool_input: {} })

/** Corre `n` veces la herramienta y devuelve la última salida. */
function repeat(n: number, fn: () => string): string {
  let out = ''
  for (let i = 0; i < n; i++) out = fn()
  return out
}

// El rastro y el estado (sin contar todavía).

test('el rastro registra start, existing, reminder y run como hechos', () => {
  const repo = sddRepo()
  makeRun(repo, '20260101-0001-aaaa', { role: 'explore' })
  makeRun(repo, '20260101-0002-aaaa', { kind: 'review' })
  makeRun(repo, '20260101-0003-aaaa', { session: 's2' })
  startTrail(repo, 's1', 'SessionStart:startup')
  const lines = trail(repo)
  assert.deepEqual(lines.map((l) => l.event), ['start', 'existing', 'existing'])
  assert.equal(lines[0].via, 'SessionStart:startup')
  assert.deepEqual(lines.slice(1).map((l) => [l.run, l.kind, l.role]), [['20260101-0001-aaaa', 'worker', 'explore'], ['20260101-0002-aaaa', 'review', undefined]])
  startTrail(repo, 's1', 'PreToolUse')
  assert.equal(trail(repo).length, 3, 'la segunda llamada no agrega nada')

  // Los eventos reminder y run salen del contador.
  for (let i = 0; i < ROUTE.backstop.edits; i++) countTool(tool('claude', 'post-tool-use-edit', repo), repo, 's1', 'claude')
  makeRun(repo, '20260101-0004-aaaa', { kind: 'native', role: 'refute' })
  countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  const all = trail(repo)
  assert.deepEqual(all.map((l) => l.event), ['start', 'existing', 'existing', 'reminder', 'run'])
  assert.deepEqual([all[4].run, all[4].kind, all[4].role], ['20260101-0004-aaaa', 'native', 'refute'])
  for (const line of all) {
    assert.equal(typeof line.at, 'string')
    for (const claim of ['received', 'launched', 'delivered', 'obeyed']) assert.equal(claim in line, false, `${line.event} afirma ${claim}`)
  }
})

test('un session_id inválido no crea archivos', () => {
  const repo = sddRepo()
  for (const session of ['../x', '', 'a/b']) {
    startTrail(repo, session, 'SessionStart:startup')
    assert.equal(markBootstrap(repo, session), false)
    assert.equal(countTool(tool('claude', 'post-tool-use-read', repo, { session_id: session }), repo, session, 'claude'), '')
  }
  assert.deepEqual(readdirSync(join(repo, '.sdd-ai')), [])
  assert.equal(existsSync(join(repo, 'x.json')), false)
})

test('un repo con .sdd-ai recién creada y sin runs empieza el rastro', () => {
  const repo = sddRepo()
  startTrail(repo, 's1', 'SessionStart:startup')
  assert.deepEqual(events(repo), ['start'])
  assert.deepEqual(state(repo).seen, [])
})

test('una corrida a medio escribir al empezar el rastro se registra como existente', () => {
  const repo = sddRepo()
  const dir = makeRun(repo, '20260101-0001-aaaa', { complete: false })
  startTrail(repo, 's1', 'SessionStart:startup')
  assert.deepEqual(events(repo), ['start'])
  assert.deepEqual(state(repo).snapshot_pending, ['20260101-0001-aaaa'])
  for (let i = 0; i < 3; i++) countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  completeRun(dir)
  countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  assert.deepEqual(events(repo), ['start', 'existing'])
  assert.equal(state(repo).reads, 4, 'no reinicia')
  assert.deepEqual(state(repo).snapshot_pending, [])
})

test('el rastro vive en .sdd-ai/hooks/route/ y no toca el estado de Stop', () => {
  const repo = sddRepo()
  mkdirSync(join(repo, '.sdd-ai', 'hooks'))
  const stopFile = join(repo, '.sdd-ai', 'hooks', 's1.json')
  writeFileSync(stopFile, '{"reminded":["x"]}\n')
  startTrail(repo, 's1', 'SessionStart:startup')
  assert.equal(markBootstrap(repo, 's1'), false)
  countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  assert.equal(readFileSync(stopFile, 'utf8'), '{"reminded":["x"]}\n')
  assert.deepEqual(readdirSync(join(repo, '.sdd-ai', 'hooks')).sort(), ['route', 's1.json'])
  assert.deepEqual(readdirSync(routeDir(repo)).sort(), ['s1.json', 's1.jsonl'])
  const bare = makeRepo()
  startTrail(bare, 's1', 'SessionStart:startup')
  assert.equal(markBootstrap(bare, 's1'), false)
  assert.equal(countTool(tool('claude', 'post-tool-use-read', bare), bare, 's1', 'claude'), '')
  assert.equal(existsSync(join(bare, '.sdd-ai')), false)
})

test('markBootstrap marca una vez por sesión', () => {
  const repo = sddRepo()
  assert.equal(markBootstrap(repo, 's1'), false)
  assert.equal(markBootstrap(repo, 's1'), true)
  assert.equal(markBootstrap(repo, 's2'), false)
  assert.equal(typeof state(repo).bootstrap_at, 'string')
  assert.equal(trail(repo)[0].via, 'bootstrap')
})

// El contador.

test('recuerda al cruzar 20 llamadas, 5 lecturas o 2 ediciones, con todos los umbrales cruzados y qué hacer con cada uno', () => {
  const { calls, reads, edits } = ROUTE.backstop
  const callsRepo = sddRepo()
  assert.equal(repeat(calls - 1, () => countTool(named('claude', callsRepo, 'Agent'), callsRepo, 's1', 'claude')), '')
  const byCalls = countTool(named('claude', callsRepo, 'Agent'), callsRepo, 's1', 'claude')
  assert.match(byCalls, new RegExp(`${calls} llamadas a herramientas \\(umbral: ${calls}\\)`))
  assert.ok(byCalls.includes(EXPLORE))
  assert.doesNotMatch(byCalls, /lecturas|ediciones \(/)

  const readsRepo = sddRepo()
  assert.equal(repeat(reads - 1, () => countTool(tool('claude', 'post-tool-use-read', readsRepo), readsRepo, 's1', 'claude')), '')
  const byReads = countTool(tool('claude', 'post-tool-use-read', readsRepo), readsRepo, 's1', 'claude')
  assert.match(byReads, new RegExp(`${reads} lecturas \\(umbral: ${reads}\\)`))
  assert.ok(byReads.includes(`si son ${ROUTE.exploreMinFiles} o más, delegar la exploración`))

  const editsRepo = sddRepo()
  assert.equal(repeat(edits - 1, () => countTool(tool('codex', 'post-tool-use-apply-patch', editsRepo), editsRepo, 's1', 'codex')), '')
  const byEdits = countTool(tool('codex', 'post-tool-use-apply-patch', editsRepo), editsRepo, 's1', 'codex')
  assert.match(byEdits, new RegExp(`${edits} ediciones \\(umbral: ${edits}\\)`))
  assert.match(byEdits, /--role implement.*se le propone SDD/)

  // La quinta lectura que es también la vigésima llamada: un solo recordatorio con los dos.
  const both = sddRepo()
  repeat(calls - reads, () => countTool(named('claude', both, 'Agent'), both, 's1', 'claude'))
  repeat(reads - 1, () => countTool(tool('claude', 'post-tool-use-read', both), both, 's1', 'claude'))
  const twice = countTool(tool('claude', 'post-tool-use-read', both), both, 's1', 'claude')
  assert.match(twice, /llamadas a herramientas/)
  assert.match(twice, /lecturas/)
  const reminders = trail(both).filter((l) => l.event === 'reminder')
  assert.equal(reminders.length, 1)
  assert.deepEqual(reminders[0].crossed, ['calls', 'reads'])
  assert.deepEqual(reminders[0].counts, { calls, reads, edits: 0 })
  assert.equal(typeof reminders[0].at, 'string')
})

test('clasifica lecturas y ediciones por CLI', () => {
  const kinds = (cli: Cli, p: Record<string, unknown>) => {
    const repo = sddRepo()
    countTool({ ...p, cwd: repo }, repo, 's1', cli)
    const s = state(repo)
    return [s.calls, s.reads, s.edits]
  }
  const reads = ['cat a.txt', "sed -n '1,5p' a.txt", 'rg foo', 'grep -rn foo .', 'ls', 'find . -name x', 'head a', 'tail a', 'nl a', 'wc -l a', 'cd sub && cat a.txt', 'npm test && rg foo']
  for (const cli of ['claude', 'codex'] as const) {
    for (const command of reads) assert.deepEqual(kinds(cli, bash(cli, '/r', command)), [1, 1, 0], `${cli}: ${command}`)
    for (const command of ['npm test', "sed -i 's/a/b/' a.txt", 'echo "cat a"', 'git status']) {
      assert.deepEqual(kinds(cli, bash(cli, '/r', command)), [1, 0, 0], `${cli}: ${command}`)
    }
  }
  // La búsqueda de Claude Code sin Grep: un Bash real de la sonda.
  assert.deepEqual(kinds('claude', payload('claude', 'post-tool-use-bash-grep', {})), [1, 1, 0])
  assert.deepEqual(kinds('claude', payload('claude', 'post-tool-use-read', {})), [1, 1, 0])
  for (const name of ['Grep', 'Glob']) assert.deepEqual(kinds('claude', named('claude', '/r', name)), [1, 1, 0], name)
  assert.deepEqual(kinds('claude', payload('claude', 'post-tool-use-edit', {})), [1, 0, 1])
  for (const name of ['Write', 'NotebookEdit']) assert.deepEqual(kinds('claude', named('claude', '/r', name)), [1, 0, 1], name)
  assert.deepEqual(kinds('codex', payload('codex', 'post-tool-use-apply-patch', {})), [1, 0, 1])
  assert.deepEqual(kinds('codex', payload('codex', 'post-tool-use-bash', {})), [1, 1, 0])
  // Los nombres de una familia no cuentan en la otra.
  assert.deepEqual(kinds('codex', named('codex', '/r', 'Read')), [1, 0, 0])
  assert.deepEqual(kinds('claude', named('claude', '/r', 'apply_patch')), [1, 0, 0])
})

test('los contadores vuelven a cero al recordar y una sesión nueva empieza en cero', () => {
  const repo = sddRepo()
  const { edits } = ROUTE.backstop
  repeat(edits, () => countTool(tool('claude', 'post-tool-use-edit', repo), repo, 's1', 'claude'))
  assert.deepEqual([state(repo).calls, state(repo).reads, state(repo).edits], [0, 0, 0])
  assert.equal(countTool(tool('claude', 'post-tool-use-edit', repo), repo, 's1', 'claude'), '')
  assert.equal(state(repo).edits, 1)
  countTool(tool('claude', 'post-tool-use-read', repo, { session_id: 's2' }), repo, 's2', 'claude')
  assert.deepEqual([state(repo, 's2').calls, state(repo, 's2').reads, state(repo, 's2').edits], [1, 1, 0])
})

test('si no se puede guardar el estado no se registra ni se emite el recordatorio', () => {
  const repo = sddRepo()
  const { edits } = ROUTE.backstop
  repeat(edits - 1, () => countTool(tool('claude', 'post-tool-use-edit', repo), repo, 's1', 'claude'))
  const fail = { writeState: () => { throw new Error('disco lleno') } }
  assert.equal(countTool(tool('claude', 'post-tool-use-edit', repo), repo, 's1', 'claude', ROUTE, fail), '')
  assert.deepEqual(events(repo), ['start'])
  assert.equal(state(repo).edits, edits - 1)
  assert.equal(existsSync(join(routeDir(repo), 's1.lock')), false, 'libera el lock')
})

test('el recordatorio se entiende sin el bootstrap', () => {
  const repo = sddRepo()
  const out = repeat(ROUTE.backstop.edits, () => countTool(tool('codex', 'post-tool-use-apply-patch', repo), repo, 's1', 'codex'))
  assert.match(out, /^Recordatorio de sdd-ai/)
  assert.ok(out.includes('`./bin/sdd-ai run --role implement --prompt-file <encargo>`'))
  const reads = sddRepo()
  const byReads = repeat(ROUTE.backstop.reads, () => countTool(tool('codex', 'post-tool-use-bash', reads), reads, 's1', 'codex'))
  assert.ok(byReads.includes(EXPLORE))
  assert.ok(byReads.includes('archivo temporal fuera del repositorio'))
})

test('recordatorio con Jira: countTool pide el modo solo al emitir con ediciones cruzadas', () => {
  let asked = 0
  const on = () => {
    asked++
    return { mode: 'on' as const }
  }
  const quiet = sddRepo()
  countTool(tool('claude', 'post-tool-use-edit', quiet), quiet, 's1', 'claude', ROUTE, undefined, on)
  const reads = sddRepo()
  const byReads = repeat(ROUTE.backstop.reads, () => countTool(tool('claude', 'post-tool-use-read', reads), reads, 's1', 'claude', ROUTE, undefined, on))
  assert.ok(byReads.includes(EXPLORE))
  assert.equal(asked, 0)
  const edits = sddRepo()
  const byEdits = repeat(ROUTE.backstop.edits, () => countTool(tool('claude', 'post-tool-use-edit', edits), edits, 's1', 'claude', ROUTE, undefined, on))
  assert.equal(asked, 1)
  assert.ok(byEdits.includes('todo cambio del proyecto va por un flujo SDD'))
  assert.ok(!byEdits.includes('--role implement'))
  const broken = sddRepo()
  const fails = () => {
    throw new Error('sin yaml')
  }
  const byBroken = repeat(ROUTE.backstop.edits, () => countTool(tool('claude', 'post-tool-use-edit', broken), broken, 's1', 'claude', ROUTE, undefined, fails))
  assert.ok(byBroken.includes('la config de Jira no se puede leer (no se pudo cargar la config)'))
  assert.ok(!byBroken.includes('--role implement'))
})

test('el contador cruza los umbrales de la constante que recibe', () => {
  const t: RouteThresholds = { ...ROUTE, backstop: { calls: 3, reads: 7, edits: 9 } }
  const repo = sddRepo()
  assert.equal(repeat(2, () => countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude', t)), '')
  const out = countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude', t)
  assert.match(out, /3 llamadas a herramientas \(umbral: 3\)/)
  assert.doesNotMatch(out, new RegExp(`umbral: ${ROUTE.backstop.calls}\\)`))
  assert.doesNotMatch(out, /lecturas/)
  const five = sddRepo()
  const lax: RouteThresholds = { ...ROUTE, backstop: { calls: 100, reads: 7, edits: 9 } }
  assert.equal(repeat(ROUTE.backstop.reads, () => countTool(tool('claude', 'post-tool-use-read', five), five, 's1', 'claude', lax)), '')
})

test('una corrida nueva de la sesión reinicia los contadores y una de otra sesión no', () => {
  for (const kind of ['worker', 'native', 'review'] as const) {
    const repo = sddRepo()
    repeat(3, () => countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude'))
    makeRun(repo, '20260101-0001-aaaa', { session: 's2', kind })
    countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
    assert.equal(state(repo).reads, 4, `${kind}: la de otra sesión no reinicia`)
    makeRun(repo, '20260101-0002-aaaa', { kind, role: kind === 'review' ? undefined : 'debate' })
    assert.equal(countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude'), '')
    assert.deepEqual([state(repo).calls, state(repo).reads, state(repo).edits], [0, 0, 0], `${kind}: la llamada que la creó no cuenta`)
    const runs = trail(repo).filter((l) => l.event === 'run')
    assert.equal(runs.length, 1)
    assert.deepEqual([runs[0].run, runs[0].kind, runs[0].role], ['20260101-0002-aaaa', kind, kind === 'review' ? undefined : 'debate'])
    assert.equal(typeof runs[0].at, 'string')
  }
})

test('una corrida a medio escribir se registra en el evento siguiente', () => {
  const repo = sddRepo()
  repeat(3, () => countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude'))
  const dir = makeRun(repo, '20260101-0001-aaaa', { complete: false })
  countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  assert.equal(state(repo).reads, 4)
  assert.deepEqual(events(repo), ['start'])
  completeRun(dir)
  countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  assert.equal(state(repo).reads, 0)
  assert.deepEqual(events(repo), ['start', 'run'])
})

test('un Agent que no es de sdd-ai no reinicia', () => {
  const repo = sddRepo()
  repeat(3, () => countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude'))
  const agent = payload('claude', 'post-tool-use-agent', { cwd: repo, session_id: 's1', tool_input: { subagent_type: 'general-purpose', prompt: 'x' } })
  countTool(agent, repo, 's1', 'claude')
  assert.deepEqual([state(repo).calls, state(repo).reads], [4, 3])
  assert.deepEqual(events(repo), ['start'])
})

test('las herramientas con agent_id no cuentan', () => {
  const repo = sddRepo()
  for (let i = 0; i < 30; i++) {
    assert.equal(countTool(tool('claude', 'post-tool-use-read-subagent', repo), repo, 's1', 'claude'), '')
    assert.equal(countTool(tool('codex', 'post-tool-use-bash-subagent', repo), repo, 's1', 'codex'), '')
  }
  assert.equal(existsSync(join(routeDir(repo), 's1.json')), false)
  // Control: la misma herramienta del conductor sí cuenta.
  countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  countTool(tool('codex', 'post-tool-use-bash', repo), repo, 's1', 'codex')
  assert.deepEqual([state(repo).calls, state(repo).reads], [2, 2])
})

test('un lock que no se puede inspeccionar no cuelga el hook', () => {
  const repo = sddRepo()
  mkdirSync(routeDir(repo), { recursive: true })
  // Un enlace colgante: abrirlo con 'wx' da EEXIST y leer su fecha falla siempre.
  symlinkSync(join(repo, 'no-existe'), join(routeDir(repo), 's1.lock'))
  const script = 'const { countTool } = await import(process.env.MOD); process.stdout.write(countTool(JSON.parse(process.env.P), process.env.REPO, "s1", "claude"))'
  const started = Date.now()
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MOD: MODULE, REPO: repo, P: JSON.stringify(tool('claude', 'post-tool-use-read', repo)) }, encoding: 'utf8', timeout: 3000,
  })
  assert.equal(r.status, 0, `el hijo no terminó: ${r.signal ?? r.stderr}`)
  assert.equal(r.stdout, '')
  assert.ok(Date.now() - started < 2000, `tardó ${Date.now() - started} ms`)
})

/** Un hijo que espera al instante `at` y cuenta una herramienta: los dos compiten de verdad por el lock. */
function countAt(repo: string, at: number): Promise<string> {
  const script = 'const { countTool } = await import(process.env.MOD); const p = JSON.parse(process.env.P); ' +
    'while (Date.now() < Number(process.env.AT)); process.stdout.write(countTool(p, process.env.REPO, "s1", "claude"))'
  const p = JSON.stringify(tool('claude', 'post-tool-use-edit', repo))
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MOD: MODULE, REPO: repo, P: p, AT: String(at) }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  return new Promise((done) => child.on('close', () => done(out)))
}

test('de dos hooks paralelos que cruzan el umbral sale un solo recordatorio', async () => {
  for (let i = 0; i < 5; i++) {
    const repo = sddRepo()
    repeat(ROUTE.backstop.edits - 1, () => countTool(tool('claude', 'post-tool-use-edit', repo), repo, 's1', 'claude'))
    const at = Date.now() + 800
    const outs = await Promise.all([countAt(repo, at), countAt(repo, at)])
    assert.equal(outs.filter((o) => o !== '').length, 1, `vuelta ${i}: ${JSON.stringify(outs)}`)
    assert.equal(trail(repo).filter((l) => l.event === 'reminder').length, 1, `vuelta ${i}`)
    assert.equal(state(repo).edits, 1, `vuelta ${i}: la segunda cuenta después del reinicio`)
    assert.equal(existsSync(join(routeDir(repo), 's1.lock')), false)
  }
})

const BINDING: FlowBinding = { id: 'f1', step: 'implement', gate: null, at: '2026-09-28T12:00:00.000Z' }

test('con liga el recordatorio se calla, los contadores vuelven a cero y el rastro registra reminder_suppressed', () => {
  const repo = sddRepo()
  assert.equal(setBinding(repo, 's1', BINDING), true)
  const { edits } = ROUTE.backstop
  for (let i = 0; i < edits; i++) assert.equal(countTool(tool('claude', 'post-tool-use-edit', repo), repo, 's1', 'claude'), '')
  assert.deepEqual([state(repo).calls, state(repo).reads, state(repo).edits], [0, 0, 0])
  assert.deepEqual(state(repo).flow, BINDING)
  const last = trail(repo).at(-1)
  assert.deepEqual(last && { ...last, at: undefined }, { at: undefined, event: 'reminder_suppressed', crossed: ['edits'], counts: { calls: edits, reads: 0, edits }, flow: 'f1' })
  assert.equal(events(repo).includes('reminder'), false)
})

test('solo el primer comando de cada tubería decide la lectura', () => {
  const reads = (command: string) => {
    const repo = sddRepo()
    countTool(bash('claude', repo, command), repo, 's1', 'claude')
    return state(repo).reads
  }
  assert.equal(reads('git diff | head'), 0)
  assert.equal(reads('cat a | grep b'), 1)
  assert.equal(reads('git status && ls'), 1)
})

test('readBinding da null sin estado o sin liga y unreadable con el JSON roto', () => {
  const repo = sddRepo()
  assert.equal(readBinding(repo, 's1'), null)
  startTrail(repo, 's1', 'SessionStart')
  assert.equal(readBinding(repo, 's1'), null)
  setBinding(repo, 's1', BINDING)
  assert.deepEqual(readBinding(repo, 's1'), BINDING)
  writeFileSync(join(routeDir(repo), 's1.json'), '{roto')
  assert.equal(readBinding(repo, 's1'), 'unreadable')
})

test('setBinding guarda y borra la liga sin tocar los contadores, y devuelve false si no puede escribir', () => {
  const repo = sddRepo()
  countTool(tool('claude', 'post-tool-use-read', repo), repo, 's1', 'claude')
  assert.equal(setBinding(repo, 's1', BINDING), true)
  assert.deepEqual([state(repo).calls, state(repo).reads, state(repo).flow], [1, 1, BINDING])
  assert.equal(setBinding(repo, 's1', null), true)
  assert.equal(state(repo).flow, undefined)
  assert.equal(state(repo).reads, 1)
  const blocked = sddRepo()
  mkdirSync(join(blocked, '.sdd-ai', 'hooks'))
  writeFileSync(join(blocked, '.sdd-ai', 'hooks', 'route'), 'no es un directorio')
  assert.equal(setBinding(blocked, 's1', BINDING), false)
})
