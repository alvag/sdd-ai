import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentCopies, skillCopies } from '../src/agents.ts'
import { runHook } from '../src/hooks.ts'
import { doctor } from '../src/doctor.ts'
import { MOD_PATH, modCopy, modInventory } from '../src/mod-copies.ts'
import { inspectModEngine } from '../src/mod-engine.ts'
import { nativeProfiles } from '../src/resolve.ts'
import { SESSION_SYNC_HEADER } from '../src/session-start-sync.ts'
import { READ_ONLY_ROLES, type Family } from '../src/types.ts'
import { checkOutput } from './hook-contract.ts'
import { exec } from './mod-fixture.ts'
import {
  PACKAGE_ROOT, agentPath, changeProfile, createHookSyncFixture, createLinkedWorktreeFixture,
  createPackageFixture, damageCopies, installCurrentCopies, seedHookState, skillPath,
  snapshotCopies, snapshotHookState, withEnv, write,
} from './session-start-sync-fixture.ts'

const CLIS = ['claude', 'codex'] as const
const EVENTS = ['startup', 'clear', 'resume', 'compact'] as const
const raw = (root: string, source: unknown = 'startup', session = 'sync-session') =>
  JSON.stringify({ hook_event_name: 'SessionStart', session_id: session, cwd: root, source })
const context = (output: string, cli: Family): string => {
  if (!output) return ''
  const parsed = JSON.parse(output)
  assert.deepEqual(checkOutput(cli, 'SessionStart', parsed), [])
  return parsed.hookSpecificOutput.additionalContext
}
const fire = (root: string, cli: Family, env: Record<string, string | undefined>, source: unknown = 'startup', session = 'sync-session', hook = runHook) =>
  withEnv(env, () => context(hook(raw(root, source, session), cli), cli))
const block = (text: string) => {
  assert.ok(text.includes(SESSION_SYNC_HEADER), 'falta el diagnóstico de sincronización')
  return text.slice(text.indexOf(SESSION_SYNC_HEADER))
}
const count = (text: string, needle: string) => text.split(needle).length - 1
const lines = (text: string) => block(text).split('\n').filter((line) => line.startsWith('- '))
const assertSelected = (text: string, cli: Family) => {
  const other = cli === 'claude' ? 'codex' : 'claude'
  assert.ok(!text.includes(agentPath(other)), text)
  assert.ok(!text.includes(skillPath(other)), text)
  if (cli === 'codex') assert.ok(!text.includes(MOD_PATH), text)
}
const assertBaselineDamage = (root: string, env: Record<string, string | undefined>, pkg = PACKAGE_ROOT) => {
  assert.notEqual(modCopy(root, modInventory(pkg)).state, 'ok')
  assert.ok(agentCopies(root, pkg, nativeProfiles(root, env)).some((copy) => copy.state !== 'ok'))
  assert.ok(skillCopies(root, pkg).some((copy) => copy.state !== 'ok'))
}

test('SessionStart clasifica la copia del mod igual que modCopy', () => {
  const f = createHookSyncFixture()
  try {
    for (const damage of ['missing', 'file', 'link', 'missing-file', 'changed', 'extra'] as const) {
      rmSync(join(f.root, MOD_PATH), { recursive: true, force: true })
      installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
      damageCopies(f.root, 'claude', { mod: damage })
      const expected = modCopy(f.root, modInventory(PACKAGE_ROOT))
      assert.equal(expected.state, damage === 'missing' ? 'missing' : 'stale')
      const text = fire(f.root, 'claude', f.env)
      assert.deepEqual(lines(text), [`- ${MOD_PATH}: ${expected.state === 'missing' ? 'ausente' : 'desactualizada'}`])
      assert.equal(count(block(text), `- ${MOD_PATH}:`), 1)
    }
  } finally { f.dispose() }
})

test('SessionStart informa solo agentes y skill de la CLI de la sesión', () => {
  for (const cli of CLIS) {
    const f = createHookSyncFixture()
    try {
      for (const agents of ['all-missing', 'one-missing', 'edited'] as const) {
        installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
        damageCopies(f.root, cli, { agents })
        const copies = agentCopies(f.root, PACKAGE_ROOT, nativeProfiles(f.root, f.env)).filter((copy) => copy.family === cli && copy.state !== 'ok')
        const text = block(fire(f.root, cli, f.env))
        assert.deepEqual(lines(text), copies.map((copy) => `- ${copy.path}: ${copy.state === 'missing' ? 'ausente' : 'desactualizada'}`))
        assertSelected(text, cli)
        if (agents === 'all-missing') assert.equal(copies.length, READ_ONLY_ROLES.length)
      }
      for (const family of CLIS) {
        rmSync(join(f.root, '.sdd-ai/workers.yml'), { force: true })
        installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
        changeProfile(f.root, family)
        const copies = agentCopies(f.root, PACKAGE_ROOT, nativeProfiles(f.root, f.env)).filter((copy) => copy.family === cli && copy.state !== 'ok')
        assert.equal(copies.length, 1, 'el hash considera ambas familias')
        const text = block(fire(f.root, cli, f.env))
        assert.deepEqual(lines(text), copies.map((copy) => `- ${copy.path}: desactualizada`))
        assertSelected(text, cli)
      }
      for (const skill of ['missing', 'edited'] as const) {
        installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
        damageCopies(f.root, cli, { skill })
        const state = skillCopies(f.root, PACKAGE_ROOT).find((copy) => copy.path === skillPath(cli))!.state
        const text = block(fire(f.root, cli, f.env))
        assert.deepEqual(lines(text), [`- ${skillPath(cli)}: ${state === 'missing' ? 'ausente' : 'desactualizada'}`])
        assertSelected(text, cli)
      }
      for (const agents of ['one-missing', 'edited'] as const) {
        for (const skill of ['missing', 'edited'] as const) {
          installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
          damageCopies(f.root, cli, { agents, skill, ...(cli === 'claude' ? { mod: 'changed' as const } : {}) })
          const text = block(fire(f.root, cli, f.env))
          assert.ok(text.includes(`- ${agentPath(cli)}: ${agents === 'one-missing' ? 'ausente' : 'desactualizada'}`))
          assert.ok(text.includes(`- ${skillPath(cli)}: ${skill === 'missing' ? 'ausente' : 'desactualizada'}`))
          if (cli === 'claude') assert.ok(text.includes(`- ${MOD_PATH}: desactualizada`))
          assertSelected(text, cli)
        }
      }
      installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
      const other = cli === 'claude' ? 'codex' : 'claude'
      damageCopies(f.root, other, { agents: 'all-missing', skill: 'missing', ...(other === 'claude' ? { mod: 'missing' as const } : {}) })
      assert.ok(!fire(f.root, cli, f.env).includes(SESSION_SYNC_HEADER))
    } finally { f.dispose() }
  }
})

test('SessionStart indica una recuperación y la adopción correcta bajo decisión del usuario', () => {
  for (const cli of CLIS) {
    const f = createHookSyncFixture()
    try {
      const reference = fire(f.root, cli, f.env)
      const scenarios = cli === 'claude'
        ? [{ mod: 'missing' as const }, { agents: 'edited' as const }, { skill: 'missing' as const }, { mod: 'changed' as const, agents: 'all-missing' as const, skill: 'edited' as const }]
        : [{ agents: 'edited' as const }, { skill: 'missing' as const }, { agents: 'all-missing' as const, skill: 'edited' as const }]
      for (const spec of scenarios) {
        installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
        damageCopies(f.root, cli, spec)
        const text = fire(f.root, cli, f.env)
        const sync = block(text)
        assert.equal(count(text, './bin/sdd-ai agents sync'), count(reference, './bin/sdd-ai agents sync') + 1)
        assert.equal(count(sync, './bin/sdd-ai agents sync'), 1)
        assert.ok(sync.includes(`cd '${f.root}' && ./bin/sdd-ai agents sync`))
        assert.ok(sync.lastIndexOf(': ausente') < sync.indexOf('./bin/sdd-ai agents sync'))
        assert.ok(sync.lastIndexOf(': desactualizada') < sync.indexOf('./bin/sdd-ai agents sync'))
        assert.match(sync, /Conductor: comunica este aviso y todas las acciones al usuario y espera su decisión antes de sincronizar/)
        assert.match(sync, /no las apliques por tu cuenta/)
        // Sin acciones previas, el aviso no las menciona.
        assert.doesNotMatch(sync, /acciones previas/)
        assert.match(sync, /Para recuperar las copias, ejecutar en el worktree afectado/)
        if (cli === 'codex') {
          assert.match(sync, /Codex, abrir una sesión nueva/)
          assert.doesNotMatch(sync, /reload-plugins|Claude Code/)
        } else {
          if ('mod' in spec) assert.match(sync, /corre \/reload-plugins; una sesión nueva lo carga al arrancar/)
          if ('agents' in spec || 'skill' in spec) {
            assert.match(sync, /abrir una sesión nueva; no está comprobado que \/reload-plugins los cargue/)
            if ('mod' in spec) assert.ok(sync.indexOf('Para cargar sdd-ai-mod') < sync.indexOf('Para adoptar los agentes'))
          } else assert.doesNotMatch(sync, /no está comprobado/)
        }
      }
    } finally { f.dispose() }
  }
})

test('SessionStart reevalúa las copias en startup clear resume y compact', () => {
  for (const cli of CLIS) {
    const f = createHookSyncFixture()
    const session = `repeat-${cli}`
    const observe = (source: string) => {
      const before = snapshotCopies(f.root)
      const text = fire(f.root, cli, f.env, source, session)
      assert.equal(snapshotCopies(f.root), before)
      return text
    }
    try {
      if (cli === 'claude') rmSync(join(f.root, '.claude'), { recursive: true })
      else damageCopies(f.root, cli, { agents: 'all-missing', skill: 'missing' })
      for (let repeat = 0; repeat < 2; repeat++) for (const event of EVENTS) {
        const text = observe(event)
        assert.equal(count(text, SESSION_SYNC_HEADER), 1)
        assert.equal(count(block(text), `- ${agentPath(cli)}: ausente`), 1)
        assert.equal(count(block(text), './bin/sdd-ai agents sync'), 1)
      }
      installCurrentCopies(f.root, PACKAGE_ROOT, f.env)
      for (const event of EVENTS) assert.ok(!observe(event).includes(SESSION_SYNC_HEADER))
      damageCopies(f.root, cli, { skill: 'edited' })
      for (const event of EVENTS) assert.deepEqual(lines(observe(event)), [`- ${skillPath(cli)}: desactualizada`])
    } finally { f.dispose() }
  }
})

test('SessionStart no avisa por copias vigentes CRLF ni archivos generados del motor', () => {
  const f = createHookSyncFixture()
  try {
    const check = () => {
      assert.equal(modCopy(f.root, modInventory(PACKAGE_ROOT)).state, 'ok')
      assert.ok(agentCopies(f.root, PACKAGE_ROOT, nativeProfiles(f.root, f.env)).every((copy) => copy.state === 'ok'))
      assert.ok(skillCopies(f.root, PACKAGE_ROOT).every((copy) => copy.state === 'ok'))
      for (const cli of CLIS) assert.ok(!fire(f.root, cli, f.env).includes(SESSION_SYNC_HEADER))
    }
    check()
    for (const copy of [...agentCopies(f.root, PACKAGE_ROOT, nativeProfiles(f.root, f.env)), ...skillCopies(f.root, PACKAGE_ROOT)]) {
      const file = join(f.root, copy.path)
      writeFileSync(file, readFileSync(file, 'latin1').replace(/\r?\n/g, '\r\n'), 'latin1')
    }
    check()
    write(f.root, `${MOD_PATH}/.claude-plugin/types/generated.ts`, 'tipos generados')
    write(f.root, `${MOD_PATH}/tsconfig.json`, 'config generada')
    check()
  } finally { f.dispose() }
})

test('SessionStart ignora declaraciones ausentes o ilegibles que doctor sigue informando', () => {
  const f = createHookSyncFixture()
  try {
    const engine = inspectModEngine(f.root)
    for (const path of engine.paths) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'declaración') }
    const reference = Object.fromEntries(CLIS.map((cli) => [cli, fire(f.root, cli, f.env)]))
    const check = (missing: boolean) => {
      assert.equal(modCopy(f.root, modInventory(PACKAGE_ROOT)).state, 'ok')
      const report = doctor(exec, undefined, { copies: [modCopy(f.root, modInventory(PACKAGE_ROOT))] }, inspectModEngine(f.root))
      assert.equal(Boolean(report.warnings?.some((warning) => warning.code === 'mod_engine_types_missing')), missing)
      for (const cli of CLIS) {
        const text = fire(f.root, cli, f.env)
        assert.equal(text, reference[cli])
        assert.ok(!text.includes(SESSION_SYNC_HEADER))
        assert.doesNotMatch(text, /claude -p|mod_engine_types_missing/)
      }
    }
    check(false)
    for (const path of engine.paths) rmSync(path)
    check(true)
    for (const path of engine.paths.slice(1)) writeFileSync(path, 'declaración')
    check(true)
    mkdirSync(engine.paths[0])
    check(true)
  } finally { f.dispose() }
})

test('SessionStart conserva el silencio para payload sesión repo y origen no admitidos', () => {
  const f = createHookSyncFixture()
  try {
    rmSync(join(f.root, '.claude'), { recursive: true })
    damageCopies(f.root, 'codex', { agents: 'all-missing', skill: 'missing' })
    assertBaselineDamage(f.root, f.env)
    for (const cli of CLIS) {
      // green_on_base: las incidencias las acredita assertBaselineDamage con las inspecciones de la base, no runHook.
      for (const input of ['no es json', '[]', raw(f.root, 'startup', '../invalid'), raw(f.root, 'startup', ''), JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.root })]) {
        assert.equal(withEnv(f.env, () => runHook(input, cli)), '')
      }
      for (const source of ['fork', 'unknown', null, 7, ['startup'], { toString: 'startup' }]) {
        assert.equal(withEnv(f.env, () => runHook(raw(f.root, source), cli)), '')
      }
    }
    rmSync(join(f.root, '.sdd-ai'), { recursive: true })
    for (const cli of CLIS) assert.equal(withEnv(f.env, () => runHook(raw(f.root), cli)), '')
  } finally { f.dispose() }
})

test('SessionStart usa el worktree del cwd las fuentes del paquete y los perfiles de esa raíz', async () => {
  const f = createLinkedWorktreeFixture()
  try {
    assert.notEqual(nativeProfiles(f.worktreeRoot, f.env).explore.claude.model, nativeProfiles(PACKAGE_ROOT, f.env).explore.claude.model)
    assert.equal(nativeProfiles(f.worktreeRoot, f.env).explore.codex.model, 'fixture-codex')
    for (const root of [f.mainRoot, f.worktreeRoot]) {
      assert.ok(agentCopies(root, PACKAGE_ROOT, nativeProfiles(root, f.env)).every((copy) => copy.state === 'ok'))
      for (const cli of CLIS) assert.ok(!fire(root, cli, f.env).includes(SESSION_SYNC_HEADER))
    }
    for (const cli of CLIS) {
      damageCopies(f.worktreeRoot, cli, { agents: 'one-missing', skill: 'edited' })
      const sub = join(f.worktreeRoot, 'subdirectory')
      mkdirSync(sub, { recursive: true })
      const atRoot = block(fire(f.worktreeRoot, cli, f.env))
      const atSub = block(fire(sub, cli, f.env))
      assert.equal(atSub, atRoot)
      assert.ok(atSub.includes(`cd '${f.worktreeRoot}' && ./bin/sdd-ai agents sync`))
      assert.ok(!atSub.includes(`cd '${sub}'`))
      assert.ok(atSub.includes(`- ${agentPath(cli)}: ausente`))
      assert.ok(atSub.includes(`- ${skillPath(cli)}: desactualizada`))
      assert.ok(!fire(f.mainRoot, cli, f.env).includes(SESSION_SYNC_HEADER))
    }
  } finally { f.dispose() }

  const pkg = createPackageFixture({ payloadRepo: false })
  try {
    const hook = await pkg.importRunHook()
    pkg.writeSource('agents', readFileSync(join(pkg.pkgDir, 'agents/worker.md'), 'utf8') + '\nfuente del paquete temporal\n')
    pkg.writeSource('skill', readFileSync(join(pkg.pkgDir, 'skills/sdd-ai/SKILL.md'), 'utf8') + '\nfuente temporal\n')
    changeProfile(pkg.root, 'codex')
    installCurrentCopies(pkg.root, pkg.pkgDir, pkg.env)
    // Fuentes locales distintas no deben usarse; el paquete ejecutado es el temporal.
    write(pkg.root, 'agents/worker.md', readFileSync(join(PACKAGE_ROOT, 'agents/worker.md')))
    write(pkg.root, 'skills/sdd-ai/SKILL.md', 'fuente local diferente')
    for (const cli of CLIS) {
      assert.ok(agentCopies(pkg.root, pkg.pkgDir, nativeProfiles(pkg.root, pkg.env)).every((copy) => copy.state === 'ok'))
      assert.ok(!fire(pkg.root, cli, pkg.env, 'startup', 'package-session', hook).includes(SESSION_SYNC_HEADER))
      damageCopies(pkg.root, cli, { skill: 'edited' })
      assert.deepEqual(lines(fire(pkg.root, cli, pkg.env, 'startup', 'package-session', hook)), [`- ${skillPath(cli)}: desactualizada`])
      installCurrentCopies(pkg.root, pkg.pkgDir, pkg.env)
    }
  } finally { pkg.dispose() }
})

test('SessionStart preserva contratos bootstrap corridas flujos y aprobaciones', () => {
  for (const cli of CLIS) {
    const current = createHookSyncFixture()
    const damaged = createHookSyncFixture()
    const session = 'preserved-session'
    try {
      for (const f of [current, damaged]) seedHookState(f.root, {
        session, ownRuns: 2, otherRuns: 1, flows: ['active', 'approved'], approvedFlows: ['approved'], boundFlow: 'active',
      })
      rmSync(join(damaged.root, '.claude'), { recursive: true })
      damageCopies(damaged.root, 'codex', { agents: 'all-missing', skill: 'missing' })
      assertBaselineDamage(damaged.root, damaged.env)
      const state = snapshotHookState(damaged.root)
      const copies = snapshotCopies(damaged.root)
      for (const event of [...EVENTS, 'resume']) {
        const expected = fire(current.root, cli, current.env, event, session)
        const text = fire(damaged.root, cli, damaged.env, event, session)
        const index = text.indexOf(SESSION_SYNC_HEADER)
        if (index < 0) assert.equal(text, expected)
        else {
          assert.equal(text.slice(0, index), expected ? expected + '\n\n' : '')
          assert.equal(count(text, SESSION_SYNC_HEADER), 1)
        }
        assert.equal(snapshotHookState(damaged.root), state)
        assert.equal(snapshotCopies(damaged.root), copies)
        assert.ok(text.includes('Flujos SDD en .plans/:'))
        assert.match(text, /active.*ligado a esta sesión/)
        if (event === 'startup' || event === 'clear') assert.match(text, /abiertas en otras sesiones/)
        else assert.match(text, /abiertas en esta sesión/)
      }
    } finally { current.dispose(); damaged.dispose() }
  }
})

