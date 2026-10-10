import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDirs, indexEnv, repoRoot } from '../src/git.ts'
import { withGitQueryScope, withoutGitQueryMemo } from '../src/git-memo.ts'
import { interceptExecFileSync, listenGitMemo, makeGitMemoRepo, withGitEnv } from './git-memo-fixture.ts'

/** El resultado o el error de una consulta, para comparar la versión con memo y la versión sin memo. */
const outcome = (read: () => unknown) => {
  try { return { ok: true, value: read() } } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? null, message: (error as Error).message }
  }
}

test('la configuración de Git que cambia en el ámbito no queda oculta por el memo', () => {
  const fixture = makeGitMemoRepo()
  const { root } = fixture
  const home = mkdtempSync(join(tmpdir(), 'sdd-ai-git-memo-config-'))
  // La configuración global queda aislada en un archivo propio, que al principio no existe; la de sistema, apagada.
  const global = join(home, 'gitconfig')
  const isolated = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' }
  const observed = listenGitMemo()
  let configLists = 0
  const restore = interceptExecFileSync({ match: (argv) => argv.includes('--show-origin'), before() { configLists++ } })
  try {
    withGitEnv(isolated, () => {
      const gitDir = gitDirs(root).gitDir
      const reads: Record<'repoRoot' | 'gitDirs' | 'objects', () => unknown> = {
        repoRoot: () => repoRoot(root),
        gitDirs: () => gitDirs(root),
        objects: () => indexEnv({ root, gitDir }, join(root, 'scratch')).GIT_ALTERNATE_OBJECT_DIRECTORIES,
      }
      // En el mismo ámbito: cada consulta con memo da lo mismo que sin memo, también el error.
      const agree = (when: string) => {
        for (const [query, read] of Object.entries(reads)) {
          assert.deepEqual(outcome(read), outcome(() => withoutGitQueryMemo(read)), `${query}: ${when}`)
        }
      }
      const config = join(root, '.git', 'config')
      const included = join(home, 'included.config')
      const saved = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n`
      const bypassed = (from: number, queries: string[], when: string) => {
        for (const query of queries) {
          assert.ok(observed.events.slice(from).some((e) => e.kind === 'bypass' && e.reason === 'config_include' && e.query === query),
            `${query} no se memoriza con un include: ${when}`)
        }
      }

      withGitQueryScope('call', () => {
        // Configuración estable y sin includes: se reutiliza, con un solo listado de orígenes en el ámbito (dos consultas:
        // la segunda confirma que la configuración no cambió mientras se estampaba).
        const start = observed.events.length
        const lists = configLists
        for (const read of Object.values(reads)) { read(); read() }
        const own = observed.events.slice(start)
        for (const query of ['repoRoot', 'gitDirs', 'objects']) {
          assert.ok(own.some((e) => e.kind === 'hit' && e.query === query), `${query} se reutiliza con la configuración estable`)
        }
        assert.equal(configLists - lists, 2, 'un listado de orígenes (dos consultas) por directorio Git y ámbito')

        // Un global que se crea donde no existía, mal formado.
        writeFileSync(global, '[broken global\n')
        agree('global creado y mal formado')
        rmSync(global)
        agree('global borrado')

        // El config del repositorio mal formado, y después restaurado.
        writeFileSync(config, '[broken repo config\n')
        agree('config del repositorio mal formado')
        writeFileSync(config, saved)
        agree('config del repositorio restaurado')

        // Un include válido: las tres consultas van a Git sin memo (config_include).
        writeFileSync(included, '[core]\n\tbare = false\n')
        appendFileSync(config, `[include]\n\tpath = ${included.split('\\').join('/')}\n`)
        const withInclude = observed.events.length
        agree('include válido')
        bypassed(withInclude, ['repoRoot', 'gitDirs', 'objects'], 'include válido')
        // El caso de la revisión de Hermes: el archivo incluido se rompe en el mismo ámbito.
        writeFileSync(included, '[broken syntax\n')
        agree('archivo incluido mal formado')
        writeFileSync(config, saved)
      })

      withGitQueryScope('call', () => {
        // Una variable GIT_CONFIG_* que cambia la respuesta de Git: entra en la clave.
        for (const read of Object.values(reads)) read()
        const worktree = join(home, 'worktree')
        mkdirSync(worktree)
        process.env.GIT_CONFIG_COUNT = '1'
        process.env.GIT_CONFIG_KEY_0 = 'core.worktree'
        process.env.GIT_CONFIG_VALUE_0 = worktree
        try { agree('GIT_CONFIG_* cambia core.worktree') } finally {
          delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0
        }
        agree('GIT_CONFIG_* retirada')
      })

      withGitQueryScope('call', () => {
        // GIT_CONFIG solo lo lee `git config`, como si fuera --file: la sonda no puede tomar ese archivo por la
        // configuración que lee rev-parse y perder el include del repositorio.
        writeFileSync(included, '[core]\n\tbare = false\n')
        appendFileSync(config, `[include]\n\tpath = ${included.split('\\').join('/')}\n`)
        const empty = join(home, 'empty.config')
        writeFileSync(empty, '')
        process.env.GIT_CONFIG = empty
        const from = observed.events.length
        try {
          agree('GIT_CONFIG definido con un include en el repositorio')
          bypassed(from, ['repoRoot', 'gitDirs', 'objects'], 'GIT_CONFIG definido')
        } finally { delete process.env.GIT_CONFIG; writeFileSync(config, saved) }
      })

      withGitQueryScope('call', () => {
        // Un global relativo se resuelve desde el directorio de la consulta, no desde el del proceso: repoRoot y gitDirs
        // corren Git desde el checkout, que tiene ese archivo con un include; el proceso del test no lo tiene.
        const relative = join(root, 'relative.gitconfig')
        writeFileSync(relative, `[include]\n\tpath = ${included.split('\\').join('/')}\n`)
        process.env.GIT_CONFIG_GLOBAL = 'relative.gitconfig'
        const from = observed.events.length
        try {
          agree('GIT_CONFIG_GLOBAL relativo con un include')
          bypassed(from, ['repoRoot', 'gitDirs'], 'GIT_CONFIG_GLOBAL relativo')
        } finally { process.env.GIT_CONFIG_GLOBAL = global; rmSync(relative) }
      })

      withGitQueryScope('call', () => {
        // Un GIT_CONFIG_SYSTEM que no existe y se crea en el ámbito: Git no lo informa como origen mientras no existe,
        // así que la estampa lo vigila por su ruta.
        const system = join(home, 'system.config')
        delete process.env.GIT_CONFIG_NOSYSTEM
        process.env.GIT_CONFIG_SYSTEM = system
        try {
          for (const read of Object.values(reads)) read()
          writeFileSync(system, '[broken system\n')
          agree('GIT_CONFIG_SYSTEM creado mal formado')
        } finally { process.env.GIT_CONFIG_NOSYSTEM = '1'; delete process.env.GIT_CONFIG_SYSTEM; rmSync(system, { force: true }) }
      })

      withGitQueryScope('call', () => {
        // Un include que aparece entre el listado de orígenes y su estampa: ninguna consulta se guarda con los orígenes
        // viejos y el contenido nuevo.
        writeFileSync(included, '[core]\n\tbare = false\n')
        let armed = true
        const race = interceptExecFileSync({ match: (argv) => argv.includes('--show-origin'), after() {
          if (!armed) return
          armed = false
          appendFileSync(config, `[include]\n\tpath = ${included.split('\\').join('/')}\n`)
        } })
        const from = observed.events.length
        try {
          agree('include agregado mientras se estampaba la configuración')
          assert.ok(!observed.events.slice(from).some((e) => e.kind === 'store'), 'nada se guarda con una configuración que cambió al estamparla')
        } finally { race(); writeFileSync(config, saved) }
      })
    })
  } finally { restore(); observed.stop(); rmSync(home, { recursive: true, force: true }); fixture.cleanup() }
})
