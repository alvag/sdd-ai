import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRepo, telemetryOff } from './helpers.ts'
import { SOURCE_ROOT, copyModSource, write } from './mod-fixture.ts'

type Out = Record<string, any>

/** Una ruta de un archivo del repo: relativa a su raíz y con `/`, sin unidad ni barra inicial. */
function assertRepoPath(path: unknown, where: string): void {
  assert.equal(typeof path, 'string', where)
  const p = path as string
  assert.equal(p.includes('\\'), false, `${where}: ${p} tiene \\`)
  assert.equal(p.startsWith('/'), false, `${where}: ${p} empieza con /`)
  assert.equal(/^[A-Za-z]:/.test(p), false, `${where}: ${p} empieza con una unidad`)
}

test('init y doctor informan las rutas del repo relativas y con barra normal', () => {
  const root = makeRepo('sdd-ai-init-paths-')
  const home = mkdtempSync(join(tmpdir(), 'sdd-ai-init-paths-home-'))
  try {
    for (const rel of ['agents/worker.md', 'skills/sdd-ai/SKILL.md', '.gitignore']) write(root, rel, readFileSync(join(SOURCE_ROOT, rel)))
    for (const rel of ['bin/sdd-ai', 'bin/sdd-ai-hook']) write(root, rel, '')
    copyModSource(root)
    // Una copia de la skill vieja y un agente que sobra.
    write(root, '.claude/skills/sdd-ai/SKILL.md', 'viejo\n')
    write(root, '.claude/agents/sdd-ai-viejo.md', '<!-- generado por sdd-ai desde agents/worker.md · no editar a mano -->\n')
    const env = telemetryOff({
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'codex'), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    })
    const cli = (args: string[]): { code: number | null; out: Out } => {
      const r = spawnSync(process.execPath, [join(SOURCE_ROOT, 'bin/sdd-ai'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 })
      return { code: r.status, out: JSON.parse(r.stdout || 'null') as Out }
    }
    const checkDoctor = (doctor: Out, where: string) => {
      const skill = doctor.skill?.copies ?? []
      const mod = doctor.mod?.copies ?? []
      assert.ok(skill.length > 0, `${where}: sin copias de la skill`)
      assert.ok(mod.length > 0, `${where}: sin copia del mod`)
      for (const c of [...skill, ...mod]) assertRepoPath(c.path, `${where} copia`)
    }

    const flags = ['--telemetry', 'off', '--families', 'claude']
    const dry = cli(['init', ...flags])
    assert.equal(dry.code, 0, JSON.stringify(dry.out))
    for (const f of dry.out.files) assertRepoPath(f.path, 'ensayo files')
    assert.ok(dry.out.agents.some((a: Out) => a.state === 'leftover'), 'el ensayo no informa el agente que sobra')
    for (const a of dry.out.agents) assertRepoPath(a.path, 'ensayo agents')

    const before = cli(['doctor'])
    checkDoctor(before.out, 'doctor antes de aplicar')

    const applied = cli(['init', '--apply', '--digest', dry.out.digest, ...flags])
    assert.equal(applied.code, 0, JSON.stringify(applied.out))
    for (const p of applied.out.written) assertRepoPath(p, 'aplicación written')
    for (const p of [...applied.out.agents.written, ...applied.out.agents.removed]) assertRepoPath(p, 'aplicación agents')
    assert.ok(applied.out.agents.removed.includes('.claude/agents/sdd-ai-viejo.md'), JSON.stringify(applied.out.agents.removed))
    checkDoctor(applied.out.doctor, 'aplicación doctor')

    checkDoctor(cli(['doctor']).out, 'doctor después de aplicar')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
