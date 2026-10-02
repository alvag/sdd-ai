// Lo común de los tests de `sdd commit` por el binario, que están partidos por tema en `sdd-commit-*.test.ts`.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChainSetup, chainFlow, chainSetup, runBin } from './helpers.ts'

export const subject = 'agrega el cambio'

/** El contenido de `src/a.ts` que verifica la fila de la fixture: varias pruebas lo restauran para volver al candidato. */
export const VERIFIED = 'export const f = () => 2\n'

/** Un digest con forma válida que no es el de ningún ensayo: o la negativa llega antes de compararlo, o no coincide. */
export const FOREIGN_DIGEST = `sha256:${'0'.repeat(64)}`

export const git = (s: ChainSetup, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
  cwd: s.repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim()

export const file = (s: ChainSetup, path: string) => join(s.repo, path)

export const text = (s: ChainSetup, path: string) => readFileSync(file(s, path), 'utf8')

export const put = (s: ChainSetup, path: string, value: string) => {
  mkdirSync(join(file(s, path), '..'), { recursive: true })
  writeFileSync(file(s, path), value)
}

export const planPath = '.plans/f/plan.md'

export const registryPath = '.plans/f/sdd-ai-phases.json'

export const registry = (s: ChainSetup) => JSON.parse(text(s, registryPath))

export const writeRegistry = (s: ChainSetup, r: unknown) => put(s, registryPath, `${JSON.stringify(r, null, 2)}\n`)

export const reviewPath = (id: string, name: string) => `.sdd-ai/runs/${id}/${name}.json`

export const json = (s: ChainSetup, path: string) => JSON.parse(text(s, path))

export const markAll = (s: ChainSetup) => put(s, '.plans/f/tasks.md', text(s, '.plans/f/tasks.md').replaceAll('- [ ]', '- [x]'))

export const report = (done: string[], pending: string[] = []) => `${JSON.stringify({ phase: 'implement', missing_context: [],
  tasks: [...done.map((id) => ({ id, completion: 'done' })), ...pending.map((id) => ({ id, completion: 'pending' }))]
    .map((t) => ({ ...t, change_kind: 'behavior_change', changed: 'resultado', deviation: null, check: 'V1' })),
})}\nSTATUS: done\n`

export const success = (r: ReturnType<typeof runBin>) => {
  assert.equal(r.code, 0, `${JSON.stringify(r.out)}\n${r.stderr}`)
  return r.out
}

export const wait = (s: ChainSetup, id: string) => success(runBin(s, ['wait', id, '--max', '60']))

export const draft = (s: ChainSetup, value = subject) => runBin(s, ['sdd', 'commit', 'f', '--subject', value])

export const apply = (s: ChainSetup, digest: string, value = subject) => runBin(s, ['sdd', 'commit', 'f', '--subject', value, '--apply', '--digest', digest])

export const snapshot = (s: ChainSetup) => ({
  head: git(s, 'rev-parse', 'HEAD'), index: readFileSync(file(s, '.git/index')),
  objects: readdirSync(file(s, '.git/objects'), { recursive: true }).sort(),
  plan: text(s, planPath), registry: existsSync(file(s, registryPath)) ? text(s, registryPath) : null,
  // diff-files no refresca el índice: un `git diff` lo reescribiría y la comparación de bytes fallaría sola.
  diff: git(s, 'diff-files', '--binary', '-p'),
})

export const unchanged = (s: ChainSetup, before: ReturnType<typeof snapshot>) => assert.deepEqual(snapshot(s), before)

export const refused = (s: ChainSetup, code: string, digest?: string) => {
  const before = snapshot(s)
  for (const r of [draft(s), ...(digest ? [apply(s, digest)] : [])]) {
    assert.notEqual(r.code, 0, JSON.stringify(r.out))
    assert.equal(r.out.code, code, JSON.stringify(r.out))
    assert.ok(r.out.next, JSON.stringify(r.out))
    unchanged(s, before)
  }
}

export function review(s: ChainSetup, extra: string[] = []): string {
  const r = success(runBin(s, ['review', 'start', '--base', s.base, '--untracked', '--flow', 'f', '--author', 'claude', ...extra], { FAKE_MODE: 'review-ok' }))
  assert.equal(wait(s, r.id).state, 'done')
  return r.id
}

/** Un candidato verificado y revisado; las variantes preparan su base antes de crear el flujo. */
export function committable(o: { chain?: boolean; takeover?: boolean; prepare?: (s: ChainSetup) => void; edit?: (s: ChainSetup) => void; review?: boolean } = {}) {
  const s = chainSetup({ bins: ['codex', 'claude'], families: '[codex, claude]',
    writers: [{ actions: [{ write: 'src/a.ts', content: VERIFIED }], report: report(['T1']) }] })
  git(s, 'config', 'user.name', 't')
  git(s, 'config', 'user.email', 't@t')
  if (o.prepare) {
    o.prepare(s)
    git(s, 'add', '-A')
    git(s, 'commit', '-q', '-m', 'fixture')
    s.base = git(s, 'rev-parse', 'HEAD')
  }
  chainFlow(s, { status: o.chain ? 'tasks-ready' : 'implementing' })
  let run: string | undefined
  if (o.chain) {
    run = success(runBin(s, ['sdd', 'phase', 'f'])).id
    wait(s, run!)
  } else put(s, 'src/a.ts', VERIFIED)
  o.edit?.(s)
  markAll(s)
  const verified = success(runBin(s, ['sdd', 'verify', 'f', ...(o.takeover ? ['--takeover', '--reason', 'edición del conductor'] : [])]))
  assert.equal(verified.green, true, JSON.stringify(verified))
  assert.match(text(s, planPath), /^status: verified$/m)
  const reviewId = o.review === false ? undefined : review(s)
  return { s, run, reviewId, verified }
}
