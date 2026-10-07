import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modCopy, modInventory, MOD_PATH } from '../src/mod-copies.ts'
import { SESSION_SYNC_HEADER } from '../src/session-start-sync.ts'
import { renderBootstrap } from '../src/route.ts'
import { READ_ONLY_ROLES, type Family } from '../src/types.ts'
import { checkOutput } from './hook-contract.ts'
import {
  PACKAGE_ROOT, agentPath, createPackageFixture, damageCopies, installCurrentCopies, seedHookState,
  skillPath, snapshotCopies, snapshotHookState, withEnv, write,
} from './session-start-sync-fixture.ts'

const remove = (path: string) => rmSync(path, { recursive: true, force: true })
const count = (text: string, needle: string) => text.split(needle).length - 1
const sourcePaths = { mod: 'mods/sdd-ai', agents: 'agents/worker.md', skill: 'skills/sdd-ai/SKILL.md' } as const

test('SessionStart conserva el contexto y ordena acciones ante fuentes copias y perfiles inválidos', async (t) => {
  const started = performance.now()
  const processCwd = mkdtempSync(join(tmpdir(), 'sdd-ai-launch-cwd-'))
  try {
    for (const cli of ['claude', 'codex'] as const) {
      const f = createPackageFixture({ payloadRepo: true })
      const session = `errors-${cli}`
      const input = (sessionId = session) => JSON.stringify({
        hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId, cwd: join(f.root, 'subdirectory'),
      })
      try {
        mkdirSync(join(f.root, 'subdirectory'))
        seedHookState(f.root, { session, ownRuns: 1, otherRuns: 1, flows: ['active', 'approved'], approvedFlows: ['approved'], boundFlow: 'active' })
        const hook = await f.importRunHook()
        const parse = (output: string): string => {
          assert.notEqual(output, '', 'el hook debe preservar el contexto')
          const parsed = JSON.parse(output)
          assert.deepEqual(checkOutput(cli, 'SessionStart', parsed), [])
          return parsed.hookSpecificOutput.additionalContext
        }
        const reference = parse(withEnv(f.env, () => hook(input(), cli)))
        assert.ok(!reference.includes(SESSION_SYNC_HEADER))
        assert.match(reference, /Flujos SDD en .plans\/:/)
        assert.match(reference, /abiertas en otras sesiones/)
        const durable = snapshotHookState(f.root)
        const reset = () => {
          for (const path of ['.claude', '.codex', '.agents']) remove(join(f.root, path))
          remove(join(f.root, '.sdd-ai/workers.yml'))
          remove(join(f.env.CODEX_HOME!, 'config.toml'))
          write(f.env.CODEX_HOME!, 'config.toml', 'model = "fixture-codex"\nmodel_reasoning_effort = "high"\n')
          for (const path of Object.values(sourcePaths)) {
            remove(join(f.pkgDir, path))
            cpSync(join(PACKAGE_ROOT, path), join(f.pkgDir, path), { recursive: true })
          }
          installCurrentCopies(f.root, f.pkgDir, f.env)
        }
        const check = (): string => {
          const before = snapshotCopies(f.root)
          const text = parse(withEnv(f.env, () => hook(input(), cli)))
          assert.equal(snapshotCopies(f.root), before)
          assert.equal(snapshotHookState(f.root), durable)
          assert.ok(text.startsWith(reference + '\n\n' + SESSION_SYNC_HEADER), 'se pierde el contexto previo o falta el aviso')
          const sync = text.slice(text.indexOf(SESSION_SYNC_HEADER))
          assert.match(sync, /comunica este aviso y todas las acciones al usuario y espera su decisión/)
          assert.match(sync, /restaurar fuentes, quitar copias o corregir configuración; no las apliques por tu cuenta/)
          const syncIndex = sync.indexOf('./bin/sdd-ai agents sync')
          if (syncIndex >= 0) {
            assert.equal(count(sync, './bin/sdd-ai agents sync'), 1)
            assert.ok(sync.includes(`cd '${f.root}' && ./bin/sdd-ai agents sync`))
            assert.ok(sync.lastIndexOf('checkout --') < syncIndex)
            assert.ok(sync.lastIndexOf('Revisar o quitar') < syncIndex)
            assert.ok(sync.lastIndexOf('Corregir la configuración') < syncIndex)
            assert.ok(sync.indexOf('Acciones previas:') < syncIndex)
          }
          return sync
        }
        const launch = (launcher: boolean, sessionId: string): string => {
          const before = snapshotCopies(f.root)
          const at = performance.now()
          const r = spawnSync(process.execPath, launcher
            ? [join(f.pkgDir, 'bin/sdd-ai-hook'), cli]
            : [join(f.pkgDir, 'bin/sdd-ai'), 'hook', cli], {
            cwd: processCwd, input: input(sessionId),
            env: Object.fromEntries(Object.entries(f.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
            encoding: 'utf8', timeout: 15_000,
          })
          const duration = performance.now() - at
          t.diagnostic(`${cli} ${launcher ? 'lanzador' : 'binario'} ${sessionId}: ${duration.toFixed(0)} ms`)
          assert.equal(r.error, undefined)
          assert.equal(r.status, 0, r.stderr)
          if (launcher) assert.ok(duration < 5000, `timeout del lanzador: ${duration.toFixed(0)} ms (tope 5000 ms)`)
          const text = parse(r.stdout)
          assert.ok(text.startsWith(renderBootstrap()), 'el binario o lanzador perdió el bootstrap')
          assert.equal(snapshotCopies(f.root), before)
          assert.equal(snapshotHookState(f.root), durable)
          assert.match(text, /Flujos SDD en .plans\/:/)
          assert.match(text, /abiertas en otras sesiones/)
          return text
        }
        // Precargar los mismos archivos con una sesión propia, sin consumir el bootstrap de los escenarios.
        launch(true, `warm-${cli}`)

        for (const which of ['mod', 'agents', 'skill'] as const) {
          for (const how of ['missing', 'dir'] as const) {
            reset()
            if (which === 'agents') damageCopies(f.root, cli, { agents: 'all-missing', skill: 'edited' })
            else damageCopies(f.root, cli, { agents: 'edited' })
            f.damageSource(which, how)
            const text = check()
            assert.equal(count(text, `- ${sourcePaths[which]}: no se pudo leer`), 1)
            assert.match(text, how === 'missing' ? /ENOENT/ : /EISDIR/)
            assert.ok(text.includes(`git -C '${f.pkgDir}' checkout -- ${sourcePaths[which]}`))
            if (which === 'agents') for (const role of READ_ONLY_ROLES) {
              assert.ok(text.includes(`- ${agentPath(cli, role)}: no se pudo comprobar (depende de agents/worker.md)`))
              assert.ok(!text.includes(`- ${agentPath(cli, role)}: ausente`))
            }
            if (which === 'skill') assert.ok(text.includes(`- ${skillPath(cli)}: no se pudo comprobar (depende de skills/sdd-ai/SKILL.md)`))
            if (which === 'mod' && cli === 'claude') assert.ok(text.includes(`- ${MOD_PATH}: no se pudo comprobar (depende de mods/sdd-ai)`))
            if (cli === 'codex') assert.ok(!text.includes(MOD_PATH))
            // Binario y lanzador: fuentes ausentes combinadas con copias stale en ambas CLIs.
            if (how === 'missing' && (which === 'mod' || which === 'skill')) {
              for (const launcher of [false, true]) {
                const processText = launch(launcher, `${which}-${launcher}-${cli}`)
                assert.ok(processText.includes(SESSION_SYNC_HEADER))
                assert.ok(processText.includes(`- ${sourcePaths[which]}: no se pudo leer`))
                assert.ok(processText.includes(`- ${agentPath(cli)}: desactualizada`))
                const diagnostic = processText.slice(processText.indexOf(SESSION_SYNC_HEADER))
                assert.equal(count(diagnostic, './bin/sdd-ai agents sync'), 1)
                assert.ok(diagnostic.indexOf('checkout --') < diagnostic.indexOf('./bin/sdd-ai agents sync'))
                assert.ok(diagnostic.includes(`git -C '${f.pkgDir}' checkout -- ${sourcePaths[which]}`))
                assert.ok(diagnostic.includes(`cd '${f.root}' && ./bin/sdd-ai agents sync`))
              }
            }
          }
        }

        reset()
        f.damageSource('agents', 'invalid')
        damageCopies(f.root, cli, { agents: 'all-missing' })
        let text = check()
        assert.match(text, /agents\/worker.md: no se pudo leer.*frontmatter/)
        for (const role of READ_ONLY_ROLES) {
          assert.ok(text.includes(`- ${agentPath(cli, role)}: no se pudo comprobar`))
          assert.ok(!text.includes(`- ${agentPath(cli, role)}: ausente`))
        }
        reset()
        f.damageSource('agents', 'codex-render')
        text = check()
        assert.match(text, /TOML/)
        if (cli === 'claude') {
          assert.ok(text.includes(`- ${agentPath(cli)}: desactualizada`))
          assert.ok(!text.includes(`- ${agentPath(cli)}: no se pudo comprobar`))
        } else assert.ok(text.includes(`- ${agentPath(cli)}: no se pudo comprobar`))

        reset()
        damageCopies(f.root, cli, { agents: 'unreadable', skill: 'unreadable' })
        damageCopies(f.root, cli, { agents: 'edited', role: READ_ONLY_ROLES[1] })
        text = check()
        assert.ok(text.includes(`- ${agentPath(cli)}: no se pudo comprobar (`))
        assert.ok(text.includes(`- ${agentPath(cli, READ_ONLY_ROLES[1])}: desactualizada`))
        assert.ok(text.includes(`- ${skillPath(cli)}: no se pudo comprobar (`))
        assert.match(text, /EISDIR/)
        assert.ok(text.includes(`Revisar o quitar la copia ${agentPath(cli)}`))
        assert.ok(text.includes(`Revisar o quitar la copia ${skillPath(cli)}`))

        for (const brokenConfig of ['workers', 'codex'] as const) {
          reset()
          if (brokenConfig === 'workers') write(f.root, '.sdd-ai/workers.yml', 'schema_version: 99\n')
          else { remove(join(f.env.CODEX_HOME!, 'config.toml')); mkdirSync(join(f.env.CODEX_HOME!, 'config.toml')) }
          damageCopies(f.root, cli, { skill: 'edited' })
          if (cli === 'claude') damageCopies(f.root, cli, { mod: 'changed' })
          text = check()
          assert.match(text, /perfiles de los workers: inválidos/)
          assert.ok(text.includes(brokenConfig === 'workers' ? join('.sdd-ai', 'workers.yml') : join(f.env.CODEX_HOME!, 'config.toml')))
          assert.match(text, /Corregir la configuración/)
          assert.ok(text.includes(`- ${skillPath(cli)}: desactualizada`))
          if (cli === 'claude') assert.ok(text.includes(`- ${MOD_PATH}: desactualizada`))
        }

        reset()
        const other: Family = cli === 'claude' ? 'codex' : 'claude'
        damageCopies(f.root, other, { agents: 'unreadable', skill: 'unreadable' })
        damageCopies(f.root, cli, { skill: 'edited' })
        text = check()
        assert.doesNotMatch(text, /EISDIR|no se pudo comprobar/)
        assert.ok(!text.includes(agentPath(other)) && !text.includes(skillPath(other)))

        reset()
        remove(join(f.root, agentPath(cli)))
        symlinkSync(join(f.root, 'broken-agent-target'), join(f.root, agentPath(cli)))
        text = check()
        assert.ok(text.includes(`- ${agentPath(cli)}: ausente`))
        assert.doesNotMatch(text, /no se pudo comprobar/)
        if (cli === 'claude') {
          reset()
          damageCopies(f.root, cli, { mod: 'dir-in-file' })
          assert.equal(modCopy(f.root, modInventory(f.pkgDir)).state, 'stale')
          text = check()
          assert.ok(text.includes(`- ${MOD_PATH}: desactualizada`))
          for (const launcher of [false, true]) {
            assert.ok(launch(launcher, `mod-entry-${launcher}`).includes(`- ${MOD_PATH}: desactualizada`))
          }
        } else {
          reset()
          f.damageSource('mod', 'missing')
          text = check()
          assert.ok(text.includes(`git -C '${f.pkgDir}' checkout -- mods/sdd-ai`))
          assert.doesNotMatch(text, /\.\/bin\/sdd-ai agents sync|sesión nueva|adoptar/)
          assert.ok(!text.includes(MOD_PATH))
        }

        // Ausencia total de .claude observada alrededor de eventos reales.
        reset()
        remove(join(f.root, '.claude'))
        const before = snapshotCopies(f.root)
        const finalText = parse(withEnv(f.env, () => hook(input(), cli)))
        assert.equal(snapshotCopies(f.root), before)
        if (cli === 'claude') assert.ok(finalText.includes(`- ${MOD_PATH}: ausente`))
        else assert.ok(!finalText.includes(SESSION_SYNC_HEADER))
      } finally { f.dispose() }
    }
  } finally {
    remove(processCwd)
    t.diagnostic(`duración del archivo de errores: ${(performance.now() - started).toFixed(0)} ms`)
  }
})
