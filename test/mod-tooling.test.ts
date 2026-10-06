import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/**
 * Un npm-cli.js para correr los scripts con este Node: primero el que viene junto a él; si no está, el que lanzó la
 * suite (si es un .js) y por último el `npm` del PATH que resuelve a un .js.
 */
function npmCli(): string | undefined {
  const bundled = join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  if (existsSync(bundled)) return bundled
  if (process.env.npm_execpath?.endsWith('.js')) return process.env.npm_execpath
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'npm')
    if (!existsSync(candidate)) continue
    const real = realpathSync(candidate)
    if (real.endsWith('.js')) return real
  }
  return undefined
}

/** Las llamadas que hoy admite el registro, tal como las lista `claude plugin validate`. */
const ADMITTED = ['$.ui.resolve', '$.state.get', '$.state.set', '$.fs.list', '$.fs.stat', '$.fs.read', '$.session.id', '$.session.root', '$.clock.every', '$.clock.after', '$.clock.now', '$.prompt.submit', '$.prompt.read', '$.fs.write', '$.store.get', '$.store.set', '$.command.register', '$.ui.open', '$.ui.close', '$.ui.panes', '$.env.get']
const ALLOWED_REPORT = '❯ ./register.tsx hooks: tool.call, ui.render\n❯ ./register.tsx calls: $.ui.resolve, $.state.get, $.state.set'
/** El diagnóstico del motor cuando una sesión anterior guardó apagado el interruptor de rollout. */
const ROLLOUT_SAVED_OFF = 'hooks modules are turned off in this process: the rollout switch was saved off by an earlier session'

/**
 * Un checkout temporal con `package.json`, `scripts/mods.mjs` y la fuente del mod, y un `claude` y un `tsc` falsos que
 * registran cada llamada. El `claude` falso imprime en stdout el informe de `MOD_REPORT` al validar, y escribe en
 * stdout o en stderr lo que digan `MOD_VALIDATE_STDOUT`, `MOD_VALIDATE_STDERR`, `MOD_TEST_STDOUT` y `MOD_TEST_STDERR`.
 * El PATH no alcanza el Claude real: ninguna ejecución puede llamar al modelo.
 */
function toolingFixture() {
  // Sin npm no se puede probar que los scripts corren por npm run: el test falla, no se omite.
  const npm = npmCli()
  assert.ok(npm, 'no se encontró un npm-cli.js para este Node: instala npm o corre la suite con npm test')
  // npm corre el script con la ruta real del checkout (en macOS, /private/var en vez de /var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-mod-tooling-')))
  const source = join(import.meta.dirname, '..')
  const bin = join(root, 'fake-bin')
  const log = join(root, 'calls.jsonl')
  const configLog = join(root, 'config.json')
  mkdirSync(bin)
  mkdirSync(join(root, 'scripts'))
  cpSync(join(source, 'package.json'), join(root, 'package.json'))
  cpSync(join(source, 'scripts/mods.mjs'), join(root, 'scripts/mods.mjs'))
  cpSync(join(source, 'mods/sdd-ai'), join(root, 'mods/sdd-ai'), { recursive: true })
  symlinkSync(process.execPath, join(bin, 'node'))
  const fake = join(root, 'fake.mjs')
  writeFileSync(fake, [
    `import { appendFileSync, copyFileSync } from 'node:fs'`,
    `const name = process.env.MOD_NAME`,
    `const args = process.argv.slice(2)`,
    `const emit = (prefix) => { for (const channel of ['STDOUT', 'STDERR']) { const text = process.env[prefix + channel]; if (text) process[channel.toLowerCase()].write(text) } }`,
    `appendFileSync(process.env.MOD_LOG, JSON.stringify({name,args})+'\\n')`,
    `if(name === 'tsc') {copyFileSync(args[1], process.env.MOD_CONFIG); process.exitCode = Number(process.env.MOD_TSC_EXIT || 0)}`,
    `else if(args.includes('validate')) {console.log(process.env.MOD_REPORT); emit('MOD_VALIDATE_'); process.exitCode = Number(process.env.MOD_VALIDATE_EXIT || 0)}`,
    `else {emit('MOD_TEST_'); process.exitCode = Number(process.env.MOD_TEST_EXIT || 0)}`,
  ].join('\n'))
  const namedInstall = (name: string) => writeFileSync(join(bin, name), `#!/bin/sh\nMOD_NAME=${name} exec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  namedInstall('claude')
  namedInstall('tsc')
  const run = (script: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [npm, 'run', script], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, MOD_REPORT: ALLOWED_REPORT, MOD_LOG: log, MOD_CONFIG: configLog, ...extra },
  })
  const calls = (): { name: string; args: string[] }[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  /** Corre `test:mods` desde un registro de llamadas vacío. */
  const testMods = (extra: Record<string, string> = {}) => {
    rmSync(log, { force: true })
    return run('test:mods', extra)
  }
  return { root, source, bin, log, configLog, namedInstall, run, calls, testMods }
}

const VALIDATE = ['plugin', 'validate', '--strict', 'mods/sdd-ai']
const PLUGIN_TEST = ['plugin', 'test', 'mods/sdd-ai']

test('mod tooling admite solo las capacidades de panel comandos y lectura autorizadas', () => {
  const { root, calls, testMods } = toolingFixture()
  const hook = join(root, 'mods/sdd-ai/hooks/register.tsx')
  const original = readFileSync(hook, 'utf8')
  try {
    writeFileSync(hook, `${original}\n// Sonda de la validación estática del fixture.\n$.env.get('HOME'); $.env.get("CLAUDE_CONFIG_DIR");\n`)
    let result = testMods({ MOD_REPORT: `❯ ./register.tsx calls: ${ADMITTED.join(', ')}` })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls().map(call => call.args), [VALIDATE, PLUGIN_TEST])
    for (const argument of ["'PATH'", 'name', "'HOME' + suffix"]) {
      writeFileSync(hook, `${original}\n$.env.get(${argument});\n`)
      result = testMods()
      assert.notEqual(result.status, 0, argument)
      assert.match(result.stderr, /env\.get/)
      assert.deepEqual(calls(), [])
    }
    writeFileSync(hook, original)
    for (const call of ['$.env.set', '$.command.run', '$.process.run', '$.http.fetch', '$.model.complete']) {
      result = testMods({ MOD_REPORT: `❯ ./register.tsx calls: ${[...ADMITTED, call].join(', ')}` })
      assert.notEqual(result.status, 0, call)
      assert.deepEqual(calls().map(entry => entry.args), [VALIDATE])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mod tooling admits notification capabilities and still rejects execution', () => {
  const { root, testMods, calls } = toolingFixture()
  try {
    const capabilities = ['$.prompt.submit', '$.prompt.read', '$.fs.write', '$.store.get', '$.store.set']
    const result = testMods({ MOD_REPORT: `❯ ./register.tsx calls: ${capabilities.map(c => `${c} (via notifyOnce)`).join(', ')}` })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls().map(c => c.args), [VALIDATE, PLUGIN_TEST])
    for (const call of ['$.process.run', '$.http.fetch', '$.tool.call', '$.prompt.fill', '$.store.delete', '$.store.keys']) {
      assert.notEqual(testMods({ MOD_REPORT: `❯ ./register.tsx calls: ${call}` }).status, 0)
    }
    assert.notEqual(testMods({ MOD_REPORT: `${ALLOWED_REPORT}\n❯ ./notification.ts calls: $.store.get` }).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mod scripts propagate failures require generated types and isolate runtimes', () => {
  const { root, source, bin, log, configLog, namedInstall, run, calls } = toolingFixture()
  try {
    assert.equal(existsSync(join(root, 'node_modules')), false)
    let result = run('test:mods')
    assert.equal(result.status, 0, result.stderr)
    // Un auxiliar con su línea de llamadas vacía no es una violación.
    rmSync(log, { force: true })
    result = run('test:mods', { MOD_REPORT: `${ALLOWED_REPORT}\n❯ ./render.tsx calls:` })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls().map((call) => call.args), [VALIDATE, PLUGIN_TEST])
    const failures: Record<string, string>[] = [
      { MOD_VALIDATE_EXIT: '4' },
      { MOD_REPORT: '❯ ./register.tsx hooks: tool.call, ui.render' },
      { MOD_REPORT: '❯ ./register.tsx calls: $.prompt.fill' },
      { MOD_REPORT: '❯ ./register.tsx calls: $.ui.resolve, $.env.set' },
      // Un auxiliar que declara llamadas también falla, aunque el registro esté en regla.
      { MOD_REPORT: `${ALLOWED_REPORT}\n❯ ./render.tsx calls: $.ui.toast` },
      { MOD_REPORT: '❯ ./register.tsx calls:' },
    ]
    for (const extra of failures) {
      rmSync(log, { force: true })
      result = run('test:mods', extra)
      assert.notEqual(result.status, 0)
      assert.equal(calls().length, 1)
    }
    assert.notEqual(run('test:mods', { MOD_TEST_EXIT: '7' }).status, 0)
    // Un ejecutable que no puede arrancar produce ENOENT sin buscar el Claude real del PATH.
    rmSync(join(bin, 'claude'))
    symlinkSync(join(root, 'absent-cli'), join(bin, 'claude'))
    const missingCli = run('test:mods')
    assert.notEqual(missingCli.status, 0)
    rmSync(join(bin, 'claude'))
    namedInstall('claude')
    result = run('typecheck:mods')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /agents sync/)
    const types = join(root, '.claude/skills/sdd-ai-mod/.claude-plugin/types')
    mkdirSync(dirname(types), { recursive: true })
    result = run('typecheck:mods')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /claude -p --plugin-dir \.claude\/skills\/sdd-ai-mod/)
    for (const dir of ['claude-code', 'claude-code-tools', 'claude-code-mcp']) mkdirSync(join(types, dir), { recursive: true })
    writeFileSync(join(types, 'tsconfig.json'), '{}')
    rmSync(log, { force: true })
    result = run('typecheck:mods')
    assert.equal(result.status, 0, result.stderr)
    const args = calls()[0]!.args
    assert.equal(args[0], '-p')
    assert.equal(existsSync(args[1]!), false)
    assert.deepEqual(JSON.parse(readFileSync(configLog, 'utf8')), {
      extends: join(types, 'tsconfig.json'), compilerOptions: { noEmit: true },
      include: ['hooks', 'types', 'tests'].map((dir) => join(root, 'mods/sdd-ai', dir)),
    })
    result = run('typecheck:mods', { MOD_TSC_EXIT: '9' })
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(calls().at(-1)!.args[1]!), false)
    rmSync(join(bin, 'tsc'))
    result = run('typecheck:mods')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ENOENT/)
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts.test, 'node --import ./test/no-subprocess.ts --test "test/**/*.test.ts"')
    assert.deepEqual(JSON.parse(readFileSync(join(source, 'tsconfig.json'), 'utf8')).include, ['src', 'test'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mod tooling admits exact presentation capabilities and diagnoses saved rollout failure without model calls', () => {
  const { root, calls, testMods } = toolingFixture()
  /** Ninguna ejecución llama al modelo: el `claude` falso solo recibe la validación y, si llega, el runner. */
  const noModelCalls = () => {
    for (const call of calls()) {
      assert.equal(call.name, 'claude')
      assert.ok(!call.args.includes('-p') && !call.args.includes('--model'), `llamada al modelo: ${call.args.join(' ')}`)
    }
  }
  try {
    // Exactamente las admitidas, en el orden en que las lista el motor: pasa y corre el runner.
    let result = testMods({ MOD_REPORT: `❯ ./register.tsx hooks: tool.call, ui.render, ui.render{component=AbovePrompt}\n❯ ./register.tsx calls: ${[...ADMITTED].sort().join(', ')}` })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls().map((call) => call.args), [VALIDATE, PLUGIN_TEST])

    // Cada capacidad fuera de la frontera se rechaza por llamada, aunque las demás estén admitidas y aunque sea de una
    // familia admitida, sin llegar al runner.
    const outside = [
      '$.process.run', '$.process.spawn', '$.http.fetch', '$.mcp.call', '$.model.complete', '$.model.fork',
      '$.prompt.fill', '$.session.send', '$.env.set', '$.command.run', '$.tool.register', '$.tool.call',
      '$.agent.spawn', '$.fs.exists', '$.fs.ancestors', '$.clock.sleep', '$.session.cwd', '$.store.delete', '$.ui.status',
    ]
    for (const call of outside) {
      result = testMods({ MOD_REPORT: `❯ ./register.tsx calls: ${[...ADMITTED, call].join(', ')}` })
      assert.notEqual(result.status, 0, call)
      assert.ok(result.stderr.includes(`llamadas no permitidas en ./register.tsx: ${call}`), result.stderr)
      assert.deepEqual(calls().map((entry) => entry.args), [VALIDATE])
    }
    // El motor anota por qué funciones del módulo pasa una llamada hecha fuera de un hook. La anotación no es una
    // llamada: las admitidas así pasan, y una prohibida se rechaza nombrando solo la llamada.
    const via = (call: string, index: number) => `${call}${index % 2 ? ` (via helper${index}, tick)` : ''}`
    result = testMods({ MOD_REPORT: `❯ ./register.tsx calls: ${[...ADMITTED].sort().map(via).join(', ')}` })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls().map((entry) => entry.args), [VALIDATE, PLUGIN_TEST])
    result = testMods({ MOD_REPORT: `❯ ./register.tsx calls: ${[...ADMITTED.map(via), '$.prompt.fill (via save)', '$.ui.status (via readProjection, tick)'].join(', ')}` })
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes('llamadas no permitidas en ./register.tsx: $.prompt.fill, $.ui.status\n'), result.stderr)
    assert.deepEqual(calls().map((entry) => entry.args), [VALIDATE])
    result = testMods({ MOD_REPORT: `${ALLOWED_REPORT}\n❯ ./band.ts calls: $.fs.read (via readProjection)` })
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes('./band.ts declara llamadas: $.fs.read\n'), result.stderr)
    assert.deepEqual(calls().map((entry) => entry.args), [VALIDATE])
    // Una capacidad admitida en el registro sigue prohibida en un auxiliar: solo el registro recibe `$`.
    result = testMods({ MOD_REPORT: `${ALLOWED_REPORT}\n❯ ./projection.ts calls: $.fs.read` })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /\.\/projection\.ts declara llamadas: \$\.fs\.read/)
    assert.deepEqual(calls().map((entry) => entry.args), [VALIDATE])

    // El diagnóstico llega partido en líneas, sangrado y con escapes de la terminal, en stdout o en stderr, de la
    // validación o del runner. Se conserva en su canal, el resultado es un fallo y se explica la recuperación manual.
    const half = ROLLOUT_SAVED_OFF.indexOf('the rollout')
    const wrapped = `\x1b[31mError:\x1b[0m ${ROLLOUT_SAVED_OFF.slice(0, half)}\n    \x1b[1m${ROLLOUT_SAVED_OFF.slice(half, half + 6)}\r\n${ROLLOUT_SAVED_OFF.slice(half + 6)}\x1b[0m\n`
    const diagnosed: { extra: Record<string, string>; channel: 'stdout' | 'stderr'; steps: string[][] }[] = [
      { extra: { MOD_TEST_STDOUT: wrapped, MOD_TEST_EXIT: '1' }, channel: 'stdout', steps: [VALIDATE, PLUGIN_TEST] },
      { extra: { MOD_TEST_STDERR: wrapped, MOD_TEST_EXIT: '1' }, channel: 'stderr', steps: [VALIDATE, PLUGIN_TEST] },
      { extra: { MOD_VALIDATE_STDERR: `${ROLLOUT_SAVED_OFF}\n`, MOD_VALIDATE_EXIT: '1' }, channel: 'stderr', steps: [VALIDATE] },
      { extra: { MOD_VALIDATE_STDOUT: wrapped, MOD_VALIDATE_EXIT: '1' }, channel: 'stdout', steps: [VALIDATE] },
      // Un runner que no corrió los módulos no informa pruebas aprobadas, aunque termine con 0.
      { extra: { MOD_TEST_STDERR: wrapped }, channel: 'stderr', steps: [VALIDATE, PLUGIN_TEST] },
    ]
    for (const { extra, channel, steps } of diagnosed) {
      result = testMods(extra)
      assert.notEqual(result.status, 0, JSON.stringify(extra))
      assert.ok(result[channel].includes(wrapped) || result[channel].includes(ROLLOUT_SAVED_OFF), result[channel])
      assert.match(result.stderr, /interruptor de rollout/)
      assert.match(result.stderr, /claude -p --model haiku ok/)
      assert.match(result.stderr, /con acceso a la red/)
      assert.match(result.stderr, /npm run test:mods/)
      assert.match(result.stderr, steps.length === 1 ? /claude plugin validate --strict mods\/sdd-ai/ : /claude plugin test mods\/sdd-ai/)
      assert.deepEqual(calls().map((entry) => entry.args), steps)
      noModelCalls()
    }

    // Una ejecución correcta y los fallos distintos, incluido uno parecido, no reciben la explicación.
    const unexplained: { extra: Record<string, string>; ok: boolean }[] = [
      { extra: { MOD_TEST_STDOUT: '255 pass\n0 fail\n' }, ok: true },
      { extra: { MOD_TEST_STDERR: 'error: plugin failed to load\n', MOD_TEST_EXIT: '1' }, ok: false },
      { extra: { MOD_TEST_STDERR: 'hooks modules are turned off in this process: the rollout switch is off\n', MOD_TEST_EXIT: '1' }, ok: false },
      { extra: { MOD_VALIDATE_STDERR: 'hooks modules are turned off\n', MOD_VALIDATE_EXIT: '1' }, ok: false },
      { extra: { MOD_TEST_EXIT: '1' }, ok: false },
    ]
    for (const { extra, ok } of unexplained) {
      result = testMods(extra)
      assert.equal(result.status === 0, ok, `${JSON.stringify(extra)}\n${result.stderr}`)
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /claude -p --model haiku ok|interruptor de rollout/)
      noModelCalls()
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
