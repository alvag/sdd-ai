import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gitDirs, indexEntries } from '../src/git.ts'
import { readFlow } from '../src/sdd/read.ts'
import { readProcess } from '../src/writer-store.ts'
import { type WSetup, BIN, alive, cli, git, implement, lockOf, readJsonFile, storeOf, whenRunning } from './cli-run-fixture.ts'
import { chainFlow, chainSetup } from './helpers.ts'
import { cmd } from './sdd-verify-fixture.ts'
import { markAll, review, subject } from './sdd-commit-fixture.ts'

export interface ProcessRun {
  child: ChildProcess
  done: Promise<{ code: number | null; out: any; stderr: string }>
}
export interface ParallelFixture {
  main: WSetup; left: WSetup; right: WSetup; scratch: string
  barrier(label: string): string
  launch(s: WSetup, args: string[], env?: Record<string, string>): ProcessRun
  writer(s: WSetup, label: string, actions?: object[], options?: WriterOptions): Promise<{ id: string; barrier: string; group: { pid: number; pgid: number } }>
  close(): Promise<void>
}

/**
 * Cómo se lanza un writer de prueba: `after` lo detiene después de escribir, en vez de antes; `phase` lo lanza con
 * `sdd phase` (un writer de fase, que vigila también la rama del handoff) en vez de `run --role implement`.
 */
export interface WriterOptions { after?: boolean; phase?: boolean }

export const checkoutLock = (s: WSetup) => lockOf(s.repo)
export const refsLock = (s: WSetup) => join(gitDirs(s.repo).commonDir, 'sdd-ai', 'refs.lock')
export const release = (barrier: string) => writeFileSync(`${barrier}.release`, '')

/**
 * Espera a que un proceso llegue a la barrera y devuelve su pid. El marcador se crea vacío y recibe el pid
 * después (`echo $$ >` en el hook, `writeFileSync` en la fila): se espera hasta leer un pid válido.
 */
export async function arrived(barrier: string): Promise<number> {
  const until = Date.now() + 15000
  for (;;) {
    const pid = existsSync(`${barrier}.arrived`) ? Number(readFileSync(`${barrier}.arrived`, 'utf8').trim()) : 0
    if (Number.isInteger(pid) && pid > 1) return pid
    if (Date.now() > until) throw new Error(`no llegó a la barrera ${barrier}`)
    await sleep(20)
  }
}

/** El script de una fila que espera en una barrera: anuncia su pid y sigue recién cuando la prueba la libera. */
function barrierScript(barrier: string): string {
  return `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(`${barrier}.arrived`)}, String(process.pid));`
    + `while (!fs.existsSync(${JSON.stringify(`${barrier}.release`)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);`
}

/**
 * Borra un temporal de la prueba, solo si de verdad está bajo el temporal del sistema. Fuera de él no borra: lo
 * avisa por stderr y marca la falla con exitCode, sin tapar el error del test que llamó a close() desde su finally.
 */
function removeTemp(path: string): void {
  if (!existsSync(path)) return
  const tmp = realpathSync(tmpdir())
  const real = realpathSync(path)
  if (!real.startsWith(`${tmp}${sep}`)) {
    process.stderr.write(`la limpieza no borra fuera del temporal: ${real}\n`)
    process.exitCode = 1
    return
  }
  rmSync(real, { recursive: true, force: true })
}

/**
 * Si el líder del grupo es un proceso que lanzó esta prueba: su línea de comando nombra el temporal de la prueba (las
 * filas con barrera), o su directorio de trabajo es uno de sus checkouts (la fila de confirmación, que corre
 * `node --test` con una ruta relativa).
 */
function launchedHere(pgid: number, scratch: string, roots: readonly string[]): boolean {
  try {
    if (execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pgid)], { encoding: 'utf8' }).includes(scratch)) return true
    const cwd = execFileSync('lsof', ['-a', '-p', String(pgid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((line) => line.startsWith('n'))?.slice(1)
    return cwd !== undefined && roots.some((root) => cwd === realpathSync(root) || cwd.startsWith(`${realpathSync(root)}${sep}`))
  } catch { return false }
}

/** Las señales viven fuera de todos los checkouts e inventarios vigilados. */
export function parallelFixture(topology: 'main-linked' | 'linked-linked' = 'main-linked'): ParallelFixture {
  const original = chainSetup({ bins: ['codex', 'claude'], families: '[codex, claude]' })
  git(original.repo, 'config', 'user.name', 'Test')
  git(original.repo, 'config', 'user.email', 'test@example.com')
  git(original.repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(original.repo, 'src', 'b.ts'), 'export const b = 1\n')
  git(original.repo, 'add', 'src/b.ts')
  git(original.repo, 'commit', '-qm', 'fixture')
  original.base = git(original.repo, 'rev-parse', 'HEAD')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-parallel-')))
  const prompt = join(scratch, 'prompt.md')
  writeFileSync(prompt, 'Encargo de prueba.\n')
  const main: WSetup = { repo: original.repo, base: original.base, env: { ...original.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, prompt,
    bin: original.env.PATH.split(':')[0] }
  delete main.env.FAKE_WRITERS
  delete main.env.FAKE_CALLS_FILE
  delete main.env.FAKE_PROMPTS_FILE
  const roots = [main.repo]
  const linked = (name: string): WSetup => {
    const repo = join(scratch, name)
    git(main.repo, 'worktree', 'add', '-b', name, repo)
    cpSync(join(main.repo, '.sdd-ai'), join(repo, '.sdd-ai'), { recursive: true })
    roots.push(repo)
    return { ...main, repo, env: { ...main.env, CLAUDE_CODE_SESSION_ID: name,
      CODEX_HOME: join(scratch, `${name}-codex`), CLAUDE_CONFIG_DIR: join(scratch, `${name}-claude`) } }
  }
  const first = linked('linked-one')
  const second = topology === 'linked-linked' ? linked('linked-two') : first
  const left = topology === 'main-linked' ? main : first
  const right = second
  const barriers: string[] = []
  const processes: ProcessRun[] = []
  const writers: Array<{ s: WSetup; id: string; supervisor?: { pid: number; pgid: number; lstart: string; argvHash: string } }> = []
  const hook = '#!/bin/sh\nif [ -n "$SDD_TEST_BARRIER" ]; then\n  echo "$GIT_INDEX_FILE" > "$SDD_TEST_BARRIER.index"\n  echo $$ > "$SDD_TEST_BARRIER.arrived"\n'
    + '  while [ ! -f "$SDD_TEST_BARRIER.release" ]; do sleep 0.02; done\n'
    + '  if [ "$SDD_TEST_HOOK_FAIL" = 1 ]; then exit 1; fi\nfi\n'
  // Sin SDD_TEST_HOOK se arman post-checkout y pre-commit; con él, solo el hook que nombra. Así una prueba que pide
  // detenerse en reference-transaction no queda parada antes en pre-commit, y una que nombra pre-commit sigue armada.
  for (const name of ['post-checkout', 'pre-commit', 'post-commit']) {
    const file = join(gitDirs(main.repo).commonDir, 'hooks', name)
    const selection = name === 'post-commit'
      ? 'if [ "$SDD_TEST_HOOK" != post-commit ]; then exit 0; fi\n'
      : `if [ -n "$SDD_TEST_HOOK" ] && [ "$SDD_TEST_HOOK" != ${name} ]; then exit 0; fi\n`
    writeFileSync(file, hook.replace('#!/bin/sh\n', `#!/bin/sh\n${selection}`))
    chmodSync(file, 0o755)
  }
  const transaction = join(gitDirs(main.repo).commonDir, 'hooks', 'reference-transaction')
  writeFileSync(transaction, '#!/bin/sh\nif [ "$SDD_TEST_HOOK" != reference-prepared ] || [ "$1" != prepared ]; then exit 0; fi\n'
    + hook.slice('#!/bin/sh\n'.length))
  chmodSync(transaction, 0o755)
  const barrier = (label: string) => {
    const file = join(scratch, `${label}-${barriers.length}`)
    barriers.push(file)
    return file
  }
  const launch = (s: WSetup, args: string[], env: Record<string, string> = {}): ProcessRun => {
    const { NODE_TEST_CONTEXT: _context, ...baseEnv } = process.env
    const child = spawn(BIN, args, { cwd: s.repo, env: { ...baseEnv, ...s.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    const done = new Promise<{ code: number | null; out: any; stderr: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        // Una salida que no es JSON (un proceso cortado, un error en texto) se informa con todo lo capturado.
        try { resolve({ code, out: JSON.parse(stdout || 'null'), stderr }) } catch (e) {
          reject(new Error(`salida no JSON de ${args.join(' ')} (código ${code}): ${(e as Error).message}\nstdout: ${stdout}\nstderr: ${stderr}`))
        }
      })
    })
    const run = { child, done }
    processes.push(run)
    return run
  }
  return { main, left, right, scratch, barrier, launch,
    async writer(s, label, actions = [], options = {}) {
      const gate = barrier(label)
      const script = { actions, [options.after ? 'afterBarrier' : 'beforeBarrier']: gate }
      const env = { FAKE_WRITER: JSON.stringify(script) }
      const result = options.phase ? cli(s, ['sdd', 'phase', 'f'], env) : implement(s, [], env)
      assert.equal(result.code, 0, JSON.stringify(result.out))
      const id = result.out.id as string
      const tracked: (typeof writers)[number] = { s, id }
      writers.push(tracked)
      const group = await whenRunning(s.repo, id)
      await arrived(gate)
      const supervisorPid = Number(readFileSync(join(storeOf(s.repo, id), 'supervisor.pid'), 'utf8'))
      const supervisor = readProcess(supervisorPid)
      if (supervisor && supervisor !== 'gone') tracked.supervisor = { pid: supervisorPid, ...supervisor }
      assert.ok(alive(group.pid))
      return { id, group, barrier: gate }
    },
    async close() {
      const groups = new Set<number>()
      for (const gate of barriers) release(gate)
      for (const { s, id, supervisor } of writers) {
        const controlFile = join(storeOf(s.repo, id), 'control.json')
        if (!existsSync(controlFile)) continue
        cli(s, ['cancel', id])
        cli(s, ['wait', id, '--max', '15'])
        if (existsSync(controlFile)) {
          const control = readJsonFile(controlFile)
          // Solo se mata el grupo si su líder sigue siendo el writer registrado: un pgid reciclado es de otro.
          const leader = control.group ? readProcess(control.group.pid) : undefined
          if (control.group && leader && leader !== 'gone' && leader.lstart === control.group.lstart && leader.argvHash === control.group.argvHash) {
            groups.add(control.group.pgid)
            kill(control.group.pgid)
          }
        }
        if (supervisor) {
          const current = readProcess(supervisor.pid)
          if (current && current !== 'gone' && current.lstart === supervisor.lstart && current.argvHash === supervisor.argvHash) {
            groups.add(supervisor.pgid)
            kill(supervisor.pgid)
          }
          const until = Date.now() + 5000
          while (Date.now() < until) {
            const remaining = readProcess(supervisor.pid)
            if (!remaining || remaining === 'gone' || remaining.lstart !== supervisor.lstart) break
            await sleep(20)
          }
        }
      }
      for (const root of roots) {
        const file = lockOf(root)
        if (existsSync(file)) {
          // El grupo de una fila de verify no guarda identidad: se mata solo si su líder lo lanzó esta prueba.
          try {
            const held = readJsonFile(file)
            if (held.group && launchedHere(held.group, scratch, roots)) { groups.add(held.group); kill(held.group) }
          } catch { /* Locks ilegibles se inspeccionan por el test. */ }
        }
      }
      for (const run of processes) if (run.child.exitCode === null && run.child.signalCode === null) {
        groups.add(run.child.pid!)
        kill(run.child.pid!)
      }
      await Promise.allSettled(processes.map((p) => p.done))
      const until = Date.now() + 5000
      while (groups.size && Date.now() < until) {
        for (const group of groups) {
          try { process.kill(-group, 0) } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') groups.delete(group)
          }
        }
        if (groups.size) await sleep(20)
      }
      // Un grupo que no cesa no reemplaza el error del test, que llama a close() desde su finally: se avisa por
      // stderr y el archivo termina en falla con exitCode. Los temporales se retiran igual.
      if (groups.size) {
        process.stderr.write(`los grupos ${[...groups].join(', ')} no cesaron antes de retirar los temporales\n`)
        process.exitCode = 1
      }
      for (const gate of barriers) {
        if (!existsSync(`${gate}.index`)) continue
        // El índice privado de `sdd commit` vive en un temporal con este prefijo (scratch de src/sdd/commit.ts).
        const index = readFileSync(`${gate}.index`, 'utf8').trim()
        if (dirname(index).startsWith(join(tmpdir(), 'sdd-ai-commit-'))) removeTemp(dirname(index))
      }
      removeTemp(main.repo)
      removeTemp(main.bin)
      removeTemp(join(original.env.CODEX_HOME, '..'))
      removeTemp(scratch)
    },
  }
}

/** Espera a que el grupo `pgid` no tenga procesos, con un tope: si sigue vivo, la prueba falla con ese motivo. */
export async function groupCeased(pgid: number, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    try { process.kill(-pgid, 0) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return
    }
    assert.ok(Date.now() < until, `el grupo ${pgid} no cesó en ${timeoutMs} ms`)
    await sleep(20)
  }
}

export function kill(pgid: number): void {
  if (pgid <= 1) return
  try { process.kill(-pgid, 'SIGKILL') } catch { /* Ya terminó. */ }
}

export function branchFlow(s: WSetup, id: string): void {
  const dir = join(s.repo, '.plans', id)
  mkdirSync(dir, { recursive: true })
  const branch = git(s.repo, 'symbolic-ref', '--short', 'HEAD')
  writeFileSync(join(dir, 'handoff.md'), `---\nprofundidad: corta\nrisk: low\nchange_type: feat\nbase_branch: ${branch}\norigin_sha: ${s.base}\n---\n`)
}

export function verifyBarrierFlow(s: WSetup, barrier: string, confirmation = false): void {
  const wait = barrierScript(barrier)
  let rows: unknown[] = [cmd('V1', [process.execPath, '--input-type=module', '-e', wait], { acs: ['AC-1'], timeout_ms: 60000 })]
  if (confirmation) {
    // Con la implementación en la base (f() da 1), la fila espera en la barrera: la prueba la detiene a mitad de la
    // confirmación, con las rutas revertidas.
    const testPath = join(s.repo, 'test', 'confirm.test.ts')
    const hold = wait.replace("import fs from 'node:fs';", '')
    writeFileSync(testPath, `import fs from 'node:fs';\nimport {test} from 'node:test'; import assert from 'node:assert/strict'; import {f} from '../src/a.ts';\n`
      + `test('candidate', () => { if(f()===1) { ${hold} } assert.equal(f(),2) });\n`)
    rows = [{ id: 'V1', acs: ['AC-1'], kind: 'test', obligation: 'red_on_revert', argv: [process.execPath, '--test', '--test-reporter=tap', 'test/confirm.test.ts'],
      implementation_paths: ['src/a.ts', 'src/b.ts'], test_paths: ['test/confirm.test.ts'], test_name: 'candidate', report_format: 'tap', timeout_ms: 60000, expect: { exit_code: 0 } }]
  }
  chainFlow({ ...s, calls: '', prompts: '' }, { rows, status: 'implementing' })
  markAll({ ...s, calls: '', prompts: '' })
  if (confirmation) {
    writeFileSync(join(s.repo, 'src/a.ts'), 'export const f = () => 2\n')
    writeFileSync(join(s.repo, 'src/b.ts'), 'export const b = 2\n')
    chmodSync(join(s.repo, 'src/b.ts'), 0o755)
  }
}

/** Copia otro flujo antes de lanzar procesos; vuelve a respaldar sus propias huellas. */
export function duplicateFlow(s: WSetup, id: string, barrier?: string): void {
  const dir = join(s.repo, '.plans', id)
  cpSync(join(s.repo, '.plans', 'f'), dir, { recursive: true })
  const plan = join(dir, 'plan.md')
  let text = readFileSync(plan, 'utf8').replace(/^id: f$/m, `id: ${id}`).replace(/^branch: feature\/f$/m, `branch: feature/${id}`)
  if (barrier) {
    const wait = barrierScript(barrier)
    const contract = { schema_version: 1, rows: [cmd('V1', [process.execPath, '--input-type=module', '-e', wait], { acs: ['AC-1'], timeout_ms: 60000 })] }
    text = text.replace(/```sdd-ai-verification-v1\n[\s\S]*?\n```/, `\`\`\`sdd-ai-verification-v1\n${JSON.stringify(contract)}\n\`\`\``)
      .replace(/^status: verified$/m, 'status: implementing')
  }
  writeFileSync(plan, text)
  const fp = readFlow(s.repo, id).facts.fingerprints
  const approvals = ['spec', 'plan', 'tasks'].map((gate, i) => ({ gate, depth: 'completa', fingerprint: fp[gate as keyof typeof fp],
    previous: i === 0 ? {} : i === 1 ? { spec: fp.spec } : { spec: fp.spec, plan: fp.plan }, at: new Date(Date.parse('2026-09-29T14:00:00Z') + i * 60000).toISOString() }))
  writeFileSync(join(dir, 'sdd-ai-approvals.json'), JSON.stringify({ schema_version: 1, approvals }))
}

/** Un digest que no coincide con ningún ensayo: el de una aplicación de commit que la prueba sabe vencida. */
export const STALE_DIGEST = `sha256:${'0'.repeat(64)}`
export const commitArgs = (digest?: string) => ['sdd', 'commit', 'f', '--subject', subject, ...(digest ? ['--apply', '--digest', digest] : [])]
export function prepareCommit(s: WSetup): string {
  const chain = { ...s, calls: '', prompts: '' }
  chainFlow(chain, { status: 'implementing' })
  writeFileSync(join(s.repo, 'src/a.ts'), 'export const f = () => 2\n')
  markAll(chain)
  const verified = cli(s, ['sdd', 'verify', 'f'])
  assert.equal(verified.code, 0, JSON.stringify(verified.out))
  assert.equal(verified.out.green, true, JSON.stringify(verified.out))
  review(chain)
  const draft = cli(s, commitArgs())
  assert.equal(draft.code, 0, JSON.stringify(draft.out))
  return draft.out.digest as string
}
export const snapshot = (s: WSetup) => ({ head: git(s.repo, 'rev-parse', 'HEAD'),
  refs: git(s.repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
  index: readFileSync(join(gitDirs(s.repo).gitDir, 'index')), tree: Object.fromEntries(indexEntries(s.repo, s.base, { kind: 'current' }) ?? []),
  flows: existsSync(join(s.repo, '.plans')) ? Object.fromEntries(readdirSync(join(s.repo, '.plans'), { recursive: true, encoding: 'utf8' })
    .filter((p) => typeof p === 'string' && lstatSync(join(s.repo, '.plans', p)).isFile()).sort()
    .map((p) => [p, readFileSync(join(s.repo, '.plans', p)).toString('hex')])) : {} })
