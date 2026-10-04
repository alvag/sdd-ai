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

test('mod scripts propagate failures require generated types and isolate runtimes', () => {
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
  writeFileSync(fake, `import { appendFileSync, copyFileSync } from 'node:fs'\nconst name = process.env.MOD_NAME\nconst args = process.argv.slice(2)\nappendFileSync(process.env.MOD_LOG, JSON.stringify({name,args})+'\\n')\nif(name === 'tsc') {copyFileSync(args[1], process.env.MOD_CONFIG); process.exitCode = Number(process.env.MOD_TSC_EXIT || 0)}\nelse if(args.includes('validate')) {console.log(process.env.MOD_REPORT); process.exitCode = Number(process.env.MOD_VALIDATE_EXIT || 0)}\nelse process.exitCode = Number(process.env.MOD_TEST_EXIT || 0)\n`)
  const namedInstall = (name: string) => writeFileSync(join(bin, name), `#!/bin/sh\nMOD_NAME=${name} exec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  namedInstall('claude')
  namedInstall('tsc')
  const allowed = '❯ ./register.tsx hooks: tool.call, ui.render\n❯ ./register.tsx calls: $.ui.resolve, $.state.get, $.state.set'
  const run = (script: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [npm, 'run', script], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, MOD_REPORT: allowed, MOD_LOG: log, MOD_CONFIG: configLog, ...extra },
  })
  const calls = (): { name: string; args: string[] }[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  try {
    assert.equal(existsSync(join(root, 'node_modules')), false)
    let result = run('test:mods')
    assert.equal(result.status, 0, result.stderr)
    // Un auxiliar con su línea de llamadas vacía no es una violación.
    rmSync(log, { force: true })
    result = run('test:mods', { MOD_REPORT: `${allowed}\n❯ ./render.tsx calls:` })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls().map((call) => call.args), [['plugin', 'validate', '--strict', 'mods/sdd-ai'], ['plugin', 'test', 'mods/sdd-ai']])
    const failures: Record<string, string>[] = [
      { MOD_VALIDATE_EXIT: '4' },
      { MOD_REPORT: '❯ ./register.tsx hooks: tool.call, ui.render' },
      { MOD_REPORT: '❯ ./register.tsx calls: $.fs.write' },
      { MOD_REPORT: '❯ ./register.tsx calls: $.ui.resolve, $.command.register' },
      // Un auxiliar que declara llamadas también falla, aunque el registro esté en regla.
      { MOD_REPORT: `${allowed}\n❯ ./render.tsx calls: $.ui.toast` },
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
