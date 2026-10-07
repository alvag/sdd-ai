import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { renderSessionSync, SESSION_SYNC_HEADER } from '../src/session-start-sync.ts'
import { MOD_PATH } from '../src/mod-copies.ts'
import { READ_ONLY_ROLES } from '../src/types.ts'
import {
  agentPath, changeProfile, createSessionSyncFixture, damageCopies, installCurrentCopies,
  skillPath, snapshotCopies, write,
} from './session-start-sync-fixture.ts'

const remove = (path: string) => rmSync(path, { recursive: true, force: true })
const block = (root: string, path: string) => { remove(join(root, path)); mkdirSync(join(root, path), { recursive: true }) }
const syncCount = (text: string) => text.split('./bin/sdd-ai agents sync').length - 1
const agentSource = 'agents/worker.md'
const skillSource = 'skills/sdd-ai/SKILL.md'

test('La comprobación de SessionStart solo lee y no lanza procesos', () => {
  const f = createSessionSyncFixture()
  try {
    // .claude completamente ausente: comprobar no debe crearlo.
    for (const cli of ['claude', 'codex'] as const) {
      const before = snapshotCopies(f.root)
      const text = renderSessionSync(f.root, f.pkgDir, cli, f.env)
      assert.equal(snapshotCopies(f.root), before)
      const expected = [
        ...(cli === 'claude' ? [MOD_PATH] : []),
        ...READ_ONLY_ROLES.map((role) => agentPath(cli, role)), skillPath(cli),
      ].map((path) => `- ${path}: ausente`)
      assert.deepEqual(text.split('\n').filter((line) => line.startsWith('- ')), expected)
      assert.equal(text.split(SESSION_SYNC_HEADER).length - 1, 1)
      assert.equal(syncCount(text), 1)
      assert.doesNotMatch(text, /no se pudo|inválidos|subprocesos/)
    }
    installCurrentCopies(f.root, f.pkgDir, f.env)
    for (const cli of ['claude', 'codex'] as const) {
      const before = snapshotCopies(f.root)
      assert.equal(renderSessionSync(f.root, f.pkgDir, cli, f.env), '')
      assert.equal(snapshotCopies(f.root), before)
      damageCopies(f.root, cli, { agents: 'edited', skill: 'missing' })
      const damaged = snapshotCopies(f.root)
      const text = renderSessionSync(f.root, f.pkgDir, cli, f.env)
      assert.deepEqual(text.split('\n').filter((line) => line.startsWith('- ')), [
        `- ${agentPath(cli)}: desactualizada`, `- ${skillPath(cli)}: ausente`,
      ])
      assert.doesNotMatch(text, /no se pudo|subprocesos/)
      assert.equal(snapshotCopies(f.root), damaged)
      installCurrentCopies(f.root, f.pkgDir, f.env)
    }
  } finally { f.dispose() }
})

test('La comprobación aísla cada fuente configuración y copia de la CLI elegida', () => {
  for (const cli of ['claude', 'codex'] as const) {
    const f = createSessionSyncFixture()
    const pristineAgent = readFileSync(join(f.pkgDir, agentSource), 'utf8')
    const pristineSkill = readFileSync(join(f.pkgDir, skillSource), 'latin1')
    const inspect = () => {
      const before = snapshotCopies(f.root)
      const text = renderSessionSync(f.root, f.pkgDir, cli, f.env)
      assert.equal(snapshotCopies(f.root), before)
      assert.ok(text.startsWith(SESSION_SYNC_HEADER))
      assert.match(text, /comunica este aviso y todas las acciones al usuario y espera su decisión/)
      if (syncCount(text)) {
        assert.equal(syncCount(text), 1)
        assert.ok(text.indexOf('Acciones previas:') < text.indexOf('./bin/sdd-ai agents sync'))
      }
      return text
    }
    const reset = () => {
      for (const path of ['.claude', '.codex', '.agents', '.sdd-ai']) remove(join(f.root, path))
      remove(join(f.pkgDir, agentSource)); write(f.pkgDir, agentSource, pristineAgent)
      remove(join(f.pkgDir, skillSource)); write(f.pkgDir, skillSource, pristineSkill)
      remove(join(f.env.CODEX_HOME!, 'config.toml'))
      write(f.env.CODEX_HOME!, 'config.toml', 'model = "fixture-codex"\nmodel_reasoning_effort = "high"\n')
      installCurrentCopies(f.root, f.pkgDir, f.env)
    }
    try {
      reset()
      // Una copia ilegible no oculta las demás ni inspecciona la otra familia.
      damageCopies(f.root, cli, { agents: 'unreadable', skill: 'unreadable' })
      damageCopies(f.root, cli, { agents: 'one-missing', role: READ_ONLY_ROLES[1] })
      let text = inspect()
      assert.ok(text.includes(`- ${agentPath(cli)}: no se pudo comprobar (`))
      assert.ok(text.includes(`- ${agentPath(cli, READ_ONLY_ROLES[1])}: ausente`))
      assert.ok(text.includes(`- ${skillPath(cli)}: no se pudo comprobar (`))
      assert.match(text, /EISDIR/)
      assert.ok(text.includes(`Revisar o quitar la copia ${agentPath(cli)}`))
      reset()
      const other = cli === 'claude' ? 'codex' : 'claude'
      damageCopies(f.root, other, { agents: 'unreadable', skill: 'unreadable' })
      assert.equal(renderSessionSync(f.root, f.pkgDir, cli, f.env), '')
      damageCopies(f.root, cli, { skill: 'edited' })
      text = inspect()
      assert.doesNotMatch(text, /EISDIR|no se pudo comprobar/)
      assert.ok(!text.includes(agentPath(other)) && !text.includes(skillPath(other)))

      for (const mode of ['missing', 'dir', 'invalid'] as const) {
        reset()
        damageCopies(f.root, cli, { agents: 'all-missing', skill: 'edited' })
        remove(join(f.pkgDir, agentSource))
        if (mode === 'dir') mkdirSync(join(f.pkgDir, agentSource))
        if (mode === 'invalid') write(f.pkgDir, agentSource, 'sin frontmatter')
        text = inspect()
        for (const role of READ_ONLY_ROLES) {
          assert.ok(text.includes(`- ${agentPath(cli, role)}: no se pudo comprobar (depende de agents/worker.md)`))
          assert.ok(!text.includes(`- ${agentPath(cli, role)}: ausente`))
        }
        assert.equal(text.split('- agents/worker.md: no se pudo leer').length - 1, 1)
        assert.ok(text.includes(`git -C '${f.pkgDir}' checkout -- agents/worker.md`))
        assert.ok(text.includes(`- ${skillPath(cli)}: desactualizada`))
      }
      reset()
      // Parsear no basta: Codex no puede renderizar un cuerpo con triple apóstrofe.
      write(f.pkgDir, agentSource, pristineAgent + "\n'''\n")
      text = inspect()
      assert.match(text, /TOML/)
      if (cli === 'claude') {
        assert.ok(text.includes(`- ${agentPath(cli)}: desactualizada`))
        assert.ok(!text.includes(`- ${agentPath(cli)}: no se pudo comprobar`))
      } else assert.ok(text.includes(`- ${agentPath(cli)}: no se pudo comprobar`))
      reset()
      write(f.root, '.sdd-ai/workers.yml', 'schema_version: 99\n')
      damageCopies(f.root, cli, { skill: 'missing' })
      if (cli === 'claude') damageCopies(f.root, cli, { mod: 'changed' })
      text = inspect()
      assert.match(text, /perfiles de los workers: inválidos.*workers.yml/)
      for (const role of READ_ONLY_ROLES) assert.ok(text.includes(`- ${agentPath(cli, role)}: no se pudo comprobar (depende de los perfiles)`))
      assert.ok(text.includes(`- ${skillPath(cli)}: ausente`))
      if (cli === 'claude') assert.ok(text.includes(`- ${MOD_PATH}: desactualizada`))
      reset()
      block(f.env.CODEX_HOME!, 'config.toml')
      text = inspect()
      assert.match(text, /perfiles de los workers: inválidos.*config.toml/)
      assert.match(text, /Corregir .*config.toml/)
      reset()
      remove(join(f.root, agentPath(cli)))
      symlinkSync(join(f.root, 'absent-target'), join(f.root, agentPath(cli)))
      text = inspect()
      assert.ok(text.includes(`- ${agentPath(cli)}: ausente`))
      reset()
      block(f.pkgDir, skillSource)
      text = inspect()
      assert.ok(text.includes(`- ${skillPath(cli)}: no se pudo comprobar (depende de skills/sdd-ai/SKILL.md)`))
      assert.match(text, /skills\/sdd-ai\/SKILL.md: no se pudo leer/)
      reset()
      if (cli === 'claude') {
        damageCopies(f.root, cli, { mod: 'dir-in-file' })
        text = inspect()
        assert.ok(text.includes(`- ${MOD_PATH}: desactualizada`))
        assert.doesNotMatch(text, /no se pudo comprobar/)
        reset()
        damageCopies(f.root, cli, { agents: 'edited', skill: 'missing' })
        const before = snapshotCopies(f.root)
        text = renderSessionSync(f.root, f.pkgDir, cli, f.env, () => { throw new Error('fallo de lectura inyectado') })
        assert.equal(snapshotCopies(f.root), before)
        assert.ok(text.includes(`- ${MOD_PATH}: no se pudo comprobar (fallo de lectura inyectado)`))
        assert.ok(text.includes(`- ${agentPath(cli)}: desactualizada`))
        assert.ok(text.includes(`- ${skillPath(cli)}: ausente`))
      }
      reset()
      remove(join(f.pkgDir, 'mods/sdd-ai'))
      text = inspect()
      assert.match(text, /mods\/sdd-ai: no se pudo leer/)
      assert.ok(text.includes(`git -C '${f.pkgDir}' checkout -- mods/sdd-ai`))
      if (cli === 'codex') {
        assert.equal(syncCount(text), 0)
        assert.ok(!text.includes(MOD_PATH))
        assert.doesNotMatch(text, /adoptar|sesión nueva/)
      } else assert.ok(text.includes(`- ${MOD_PATH}: no se pudo comprobar`))
    } finally { f.dispose() }
  }

  // Fallos independientes simultáneos: cada fuente tiene una sola causa y su acción.
  const f = createSessionSyncFixture()
  try {
    remove(join(f.pkgDir, 'mods/sdd-ai'))
    remove(join(f.pkgDir, agentSource))
    remove(join(f.pkgDir, skillSource))
    const text = renderSessionSync(f.root, f.pkgDir, 'claude', f.env)
    for (const path of ['mods/sdd-ai', agentSource, skillSource]) {
      assert.equal(text.split(`- ${path}: no se pudo leer`).length - 1, 1)
      assert.ok(text.includes(`checkout -- ${path}`))
    }
    assert.doesNotMatch(text, /: ausente|: desactualizada/)
    assert.equal(syncCount(text), 1)
  } finally { f.dispose() }
})

