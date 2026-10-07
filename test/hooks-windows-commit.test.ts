import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { CHILD, CLIS, boundRepo, denial, flowRepo, shell, type Cli } from './hooks-fixture.ts'
import { makeRepo } from './helpers.ts'

// La guarda de commit con eventos Bash de Claude y de Codex, sin campo de shell: el comando es lo único que llega.
const win = { skip: process.platform !== 'win32' }
const UNKNOWN = 'no se puede saber a qué repositorio va'
const VERIFIED = { plan: { status: 'verified' }, tasks: 'done' } as const
const MOVES = ['cd', 'pushd', 'Set-Location', 'sl', 'chdir', 'Push-Location', 'Pop-Location', 'popd', 'cd..', 'cd\\', 'D:']

/** El mismo directorio escrito de las tres formas que la guarda entiende: simples, dobles y con slash. */
const forms = (dir: string): string[] => {
  const slash = dir.replaceAll('\\', '/')
  return [`'${dir}'`, `"${dir}"`, /\s/.test(slash) ? `"${slash}"` : slash]
}

function assertUnknown(cli: Cli, repo: string, command: string): void {
  const reason = denial(shell(cli, repo, command))
  assert.ok(reason.includes('flujo f1') && reason.includes(UNKNOWN), `${command}: ${reason}`)
}

function nestedRepo(repo: string): string {
  const nested = join(repo, 'sub', 'anidado')
  mkdirSync(nested, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: nested })
  return nested
}

test('en Windows git -C a otro repositorio pasa con ruta nativa citada, con comillas dobles y con slash, y sin comillas se niega por destino desconocido', win, () => {
  for (const cli of CLIS) {
    const other = makeRepo()
    const withSpaces = makeRepo('sdd-ai-space repo-')
    const stripped = other.replaceAll('\\', '')
    const bound = boundRepo(cli, VERIFIED)
    const boundWithJira = boundRepo(cli, VERIFIED, 'on')
    const jira = flowRepo('on')
    // El parser previo resuelve C:ruta como relativo a la unidad del cwd; resolve quita el ':' de la ruta final.
    for (const repo of [bound, boundWithJira, jira]) {
      mkdirSync(win32.resolve(repo, stripped), { recursive: true })
    }
    for (const form of [...forms(other), ...forms(withSpaces)]) {
      assert.equal(shell(cli, bound, `git -C ${form} commit -m x`), '', `liga: ${form}`)
      assert.equal(shell(cli, boundWithJira, `git -C ${form} commit -m x`), '', `liga y jira: ${form}`)
      assert.equal(shell(cli, jira, `git -C ${form} commit -m x`), '', `jira: ${form}`)
    }
    // En comillas simples, $ y backtick forman parte del nombre en ambas shells.
    for (const name of ['cash$box', 'cash`box']) {
      const literal = join(other, name)
      mkdirSync(literal)
      const init = spawnSync('git', ['init', '-q'], { cwd: literal })
      assert.equal(init.status, 0, String(init.stderr))
      for (const repo of [bound, boundWithJira, jira]) {
        assert.equal(shell(cli, repo, `git -C '${literal}' commit -m x`), '', literal)
      }
    }
    assertUnknown(cli, bound, `git -C ${other} commit -m x`)
    assertUnknown(cli, boundWithJira, `git -C ${other} commit -m x`)
    assert.match(denial(shell(cli, jira, `git -C ${other} commit -m x`)), /con jira_approval en on/)
  }
})

test('en Windows git -C a este repositorio o a sub con ruta nativa se niega por el paso, pasa desde review_and_commit y la cadena que liga se sigue negando', win, () => {
  for (const cli of CLIS) {
    const before = boundRepo(cli)
    const from = boundRepo(cli, VERIFIED)
    for (const repo of [before, from]) mkdirSync(join(repo, 'sub'), { recursive: true })
    for (const target of [(r: string) => r, (r: string) => join(r, 'sub')]) {
      for (const quoted of [(d: string) => `'${d}'`, (d: string) => `"${d}"`]) {
        const early = denial(shell(cli, before, `git -C ${quoted(target(before))} commit -m x`))
        assert.ok(early.includes('flujo f1') && early.includes('implement') && !early.includes(UNKNOWN), early)
        assert.equal(shell(cli, from, `git -C ${quoted(target(from))} commit -m x`), '', quoted(target(from)))
      }
    }
    const chains = [`./bin/sdd-ai sdd status f1 && git -C '${from}' commit -m x`, `echo \\; ./bin/sdd-ai sdd status f1 && git -C '${from}' commit -m x`]
    for (const chain of chains) assert.match(denial(shell(cli, from, chain)), /por separado/, chain)
  }
})

test('en Windows un -C relativo con backslash citado se resuelve y sin comillas se niega por destino desconocido', win, () => {
  for (const cli of CLIS) {
    const repo = boundRepo(cli)
    nestedRepo(repo)
    // El directorio que resultaría de quitar la barra existe: el destino falso no se confunde con un fallo de lookup.
    mkdirSync(join(repo, 'subanidado'))
    assert.equal(shell(cli, repo, "git -C 'sub\\anidado' commit -m x"), '')
    assert.equal(shell(cli, repo, 'git -C "sub\\anidado" commit -m x'), '')
    const sub = denial(shell(cli, repo, "git -C 'sub' commit -m x"))
    assert.ok(sub.includes('flujo f1') && sub.includes('implement') && !sub.includes(UNKNOWN), sub)
    assertUnknown(cli, repo, 'git -C sub\\anidado commit -m x')
  }
})

test('en Windows un cambio de directorio previo o una forma PowerShell no admitida niegan por destino desconocido', win, () => {
  const unsupported = [
    "git -C 'C:\\a'\"b\" commit",
    "git -C 'C:\\a'b commit",
    "git -C 'C:\\a''b' commit",
    "git -C 'C:\\a\"b' commit",
    'git -C $env:SUB\\r commit',
    'git -C C:\\$env:SUB commit',
    'git --% commit',
    'git --% -C sub(dir) commit',
    "git --% -C sub'dir commit",
    'git --% -C "sub dir" commit',
    'git --% -c key="a\\"b" commit',
    "git --% log --grep='\ngit -C --% C:/a commit",
    "git --% log --grep='\r\ngit -C --% C:/a commit",
    'git --% status \\| git -C --% C:/a commit',
    'git -C --% C:/a commit',
    'git -c --% key=value commit',
    'git `\ncommit',
    'git `\r\ncommit',
    "git -C '\\\\srv\\share\\r' commit",
    'git -C C:x commit',
    'git -C /x commit',
    'git -C \\x commit',
    'cd C:\\x\\; git commit',
  ]
  for (const cli of CLIS) {
    const other = makeRepo()
    const repo = boundRepo(cli, VERIFIED)
    const jira = flowRepo('on')
    const beforeCommit = boundRepo(cli, { plan: { status: 'implementing' }, tasks: 'done' })
    for (const quote of ["'", '"']) {
      assert.match(denial(shell(cli, beforeCommit, `echo ${quote}C:\\a\\${quote}; git commit -m x`)), /flujo f1.*verify/)
      assert.match(denial(shell(cli, jira, `echo ${quote}C:\\a\\${quote}; git commit -m x`)), /con jira_approval en on/)
    }
    assert.match(denial(shell(cli, repo, 'echo "C:\\a\\"; ./bin/sdd-ai run', CHILD)), /un worker no delega ni toca las corridas del conductor/)
    for (const prefix of ["echo it\\'s;", 'echo --% x;']) {
      assert.match(denial(shell(cli, beforeCommit, `${prefix} git commit -m x`)), /flujo f1.*verify/)
      assert.match(denial(shell(cli, repo, `${prefix} ./bin/sdd-ai run`, CHILD)), /un worker no delega ni toca las corridas del conductor/)
    }
    for (const move of MOVES) {
      for (const m of new Set([move, move.toLowerCase(), move.toUpperCase()])) {
        assertUnknown(cli, repo, `${m} && git commit -m x`)
        assertUnknown(cli, repo, `${m} && git -C 'sub' commit -m x`)
        for (const form of forms(other)) assert.equal(shell(cli, repo, `${m} && git -C ${form} commit -m x`), '', `${m}: ${form}`)
        assert.match(denial(shell(cli, jira, `${m} && git commit -m x`)), /con jira_approval en on/, m)
        assert.match(denial(shell(cli, jira, `${m} && git -C 'sub' commit -m x`)), /con jira_approval en on/, m)
        assert.equal(shell(cli, jira, `${m} && git -C '${other}' commit -m x`), '', m)
      }
    }
    for (const form of [...unsupported, `git -C '${join(repo, 'missing')}' commit`]) {
      const command = `${form} -m x`
      assertUnknown(cli, repo, command)
      // Sin liga solo rige Jira: se acredita por su negación, no por el texto del destino desconocido.
      assert.match(denial(shell(cli, jira, command)), /con jira_approval en on/, JSON.stringify(command))
    }
  }
})
