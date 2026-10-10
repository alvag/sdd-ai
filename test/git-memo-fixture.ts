import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, openSync, ftruncateSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentGitQueryScope, type GitMemoEvent } from '../src/git-memo.ts'
import { approveAll, BUILD_ROW, HANDOFF_MD, planMd, RED_ROW, SPEC_MD, TASKS_MD, verifyFlow } from './sdd-verify-fixture.ts'
import { runDirIdentity, runInventory, sensitiveInventory } from '../src/writer-store.ts'
import { SOURCE_FILES } from './worktree-config-fixture.ts'

export const SOURCE_ROOT = resolve(import.meta.dirname, '..')
export const worktreeConfigBytes = SOURCE_FILES
export interface CliCapture { stdout: string; stderr: string; exit_code: number | null; error: string | null; json: unknown }
export function runFixtureCli(sourceRoot: string, root: string, argv: string[], env: NodeJS.ProcessEnv = {}) : CliCapture {
  const result = spawnSync(process.execPath, [join(sourceRoot, 'bin', 'sdd-ai'), ...argv], {
    cwd: root, env: cleanGitEnv(env), encoding: 'utf8', timeout: 120000,
  })
  let json: unknown = null
  try { json = JSON.parse(result.stdout) } catch { /* Se conserva la salida completa. */ }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exit_code: result.status, error: result.error?.message ?? null, json }
}

/** La preparación corre fuera del intervalo de medición y usa lectores reales, sin motores. */
export async function createFixture(options: { sourceRoot: string; scenario: 'verify' | 'commit'; checkout: 'principal' | 'linked' }) {
  const fixed = Object.fromEntries(Object.entries(cleanGitEnv()).filter(([name]) => name.startsWith('GIT_')))
  const setup = withGitEnv(fixed, () => verifyFlow())
  const parent = setup.repo
  let root = parent
  try {
    gitIn(parent, 'branch', '-M', 'fixture')
    if (options.checkout === 'linked') {
      root = `${parent}-linked`
      gitIn(parent, 'worktree', 'add', '-qb', 'linked', root, setup.base)
      // El estado candidato y el flujo pertenecen al checkout, no al directorio Git común.
      const { cpSync } = await import('node:fs')
      for (const name of ['src', 'test', '.plans']) cpSync(join(parent, name), join(root, name), { recursive: true })
    }
    const fixtureSha = gitIn(root, 'rev-parse', 'HEAD')
    if (options.scenario === 'commit') {
      const verified = runFixtureCli(options.sourceRoot, root, ['sdd', 'verify', 'f'])
      if (verified.exit_code !== 0 || !(verified.json as { green?: boolean })?.green) throw new Error(`preparación verify fallida: ${verified.stdout} ${verified.stderr}`)
      await prepareFixtureReview(options.sourceRoot, root, setup.base)
    }
    return { root, fixtureSha, flow: 'f', baseCommit: setup.base, cleanup: () => {
      if (root !== parent) rmSync(root, { recursive: true, force: true })
      rmSync(parent, { recursive: true, force: true })
    } }
  } catch (error) {
    if (root !== parent) rmSync(root, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
    throw error
  }
}

/** Conserva blobs reales y acredita la revisión sintética con los lectores de cada versión. */
export async function prepareFixtureReview(sourceRoot: string, root: string, base: string) {
  const { freeze, snapshot } = await import(pathToFileURL(join(sourceRoot, 'src', 'review', 'candidate.ts')).href)
  const { reviewStanding } = await import(pathToFileURL(join(sourceRoot, 'src', 'review', 'standing.ts')).href)
  const id = '20260101-0000-abcd'
  const dir = join(root, '.sdd-ai', 'runs', id)
  mkdirSync(dir, { recursive: true })
  const selection = { base, context: [], untracked: true }
  const candidate = withGitEnv({}, () => freeze(root, selection))
  withGitEnv({}, () => snapshot(root, candidate, dir))
  for (const [name, value] of Object.entries({
    request: { kind: 'review', selection, author: 'codex', degradations: [], flow: 'f' },
    status: { state: 'done', round: 1 }, ledger: { completed: 1, next_id: 1, entries: [] },
    resolved: { family: 'codex' }, candidate,
  })) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value) + '\n')
  const standing = withGitEnv({}, () => reviewStanding(root, id, 'fresh', { baseCommit: base }))
  if (!standing.converged || !standing.fresh || !standing.covers.whole_tree) throw new Error('la revisión sintética no es íntegra y vigente')
}

export function captureState(root: string, output: CliCapture | null = null) {
  const files: Record<string, { mode: number; bytes: string; kind: 'file' | 'link'; target?: string }> = {}
  const collect = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const key = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(path)
      // El directorio .git no se captura; el gitfile de un worktree enlazado sí, porque otros registros citan su hash.
      if (name === '.git' && !stat.isFile()) continue
      if (stat.isDirectory()) collect(path, key)
      else if (stat.isFile()) files[key] = { mode: stat.mode & 0o777, bytes: readFileSync(path).toString('base64'), kind: 'file' }
      else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        files[key] = { mode: stat.mode & 0o777, bytes: Buffer.from(target).toString('base64'), kind: 'link', target }
      }
    }
  }
  collect(root, '')
  const gitDir = gitIn(root, 'rev-parse', '--absolute-git-dir')
  const commonDir = gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  collect(join(gitDir, 'sdd-ai'), '<git>/sdd-ai')
  if (commonDir !== gitDir) collect(join(commonDir, 'sdd-ai'), '<common>/sdd-ai')
  // Metadatos de Git que los registros pueden citar por hash (por ejemplo, el inventario sensible de un control):
  // HEAD, config, commondir, refs y worktrees. Se excluye lo que guarda datos de stat o es voluminoso.
  const meta = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      if (['objects', 'index', 'logs', 'hooks', 'sdd-ai'].includes(name)) continue
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) meta(path, `${prefix}/${name}`)
      else if (stat.isFile()) files[`${prefix}/${name}`] = { mode: stat.mode & 0o777, bytes: readFileSync(path).toString('base64'), kind: 'file' }
    }
  }
  meta(commonDir, '<common-meta>')
  if (commonDir !== gitDir && !gitDir.startsWith(`${commonDir}/`)) meta(gitDir, '<git-meta>')
  return { output, files, head: gitIn(root, 'rev-parse', 'HEAD'), tree: gitIn(root, 'rev-parse', 'HEAD^{tree}'),
    // El índice se compara por su contenido lógico (modo, sha, etapa y ruta). Sus bytes crudos guardan datos de stat
    // (inodo, ctime, mtime) que difieren entre dos fixtures en cuanto una operación lo reescribe.
    refs: gitIn(root, 'show-ref'), index: gitIn(root, 'ls-files', '--stage', '-z'),
    diff: gitIn(root, 'diff-files', '--binary', '-p'), objects: objectConnectivity(root) }
}

/**
 * Si los objetos alcanzables están completos. La captura no compara los bytes de `objects` (dependen de la
 * compresión y del empaquetado), pero un blob o un árbol faltante tiene que verse: el resultado es `ok` o el error.
 */
function objectConnectivity(root: string): string {
  const result = spawnSync('git', ['fsck', '--connectivity-only', '--no-dangling', '--no-progress'], { cwd: root, env: cleanGitEnv(), encoding: 'utf8' })
  return result.status === 0 ? 'ok' : `error ${result.status}: ${(result.stderr || result.stdout || String(result.error)).trim()}`
}

export interface EquivalenceScenario {
  name: string
  prepare(root: string, env: NodeJS.ProcessEnv): Promise<void> | void
  run(binRoot: string, root: string, env: NodeJS.ProcessEnv): Promise<ReturnType<typeof captureState>> | ReturnType<typeof captureState>
}

export function keyScenarios(): EquivalenceScenario[] {
  return [{
    name: 'keys-stable-checkout',
    prepare() {},
    async run(binRoot, root, env) {
      const api = await import(pathToFileURL(join(binRoot, 'src', 'git.ts')).href)
      // En un ámbito del memo, como los demás escenarios: sin él, el candidato no reutilizaría (bypass no_scope).
      const json = await observeVersion(binRoot, env, () => {
        const dirs = api.gitDirs(root)
        return {
          root: api.repoRoot(root), root_again: api.repoRoot(root),
          dirs, dirs_again: api.gitDirs(root + '/'),
          objects: api.indexEnv({ root, gitDir: dirs.gitDir }, join(root, 'scratch-index')),
          objects_again: api.indexEnv({ root, gitDir: dirs.gitDir }, join(root, 'scratch-index')),
        }
      })
      return captureState(root, { stdout: JSON.stringify(json) + '\n', stderr: '', exit_code: 0, error: null, json })
    },
  }, {
    name: 'keys-host-aliases',
    prepare(root) { symlinkSync(root, join(root, 'key-alias'), process.platform === 'win32' ? 'junction' : 'dir') },
    async run(binRoot, root, env) {
      const api = await import(pathToFileURL(join(binRoot, 'src', 'git.ts')).href)
      // En un ámbito del memo, como los demás escenarios: sin él, el candidato no reutilizaría (bypass no_scope).
      const json = await observeVersion(binRoot, env, () => {
        const original = statSync(root, { bigint: true })
        const variant = root.toUpperCase()
        const sameIdentity = existsSync(variant) && statSync(variant, { bigint: true }).dev === original.dev && statSync(variant, { bigint: true }).ino === original.ino
        return { dirs: api.gitDirs(root), alias: api.gitDirs(join(root, 'key-alias')), case_alias_exists: sameIdentity,
          case_dirs: sameIdentity ? api.gitDirs(variant) : null }
      })
      return captureState(root, { stdout: JSON.stringify(json) + '\n', stderr: '', exit_code: 0, error: null, json })
    },
  }]
}

export function consumerScenarios(): EquivalenceScenario[] {
  const reads: EquivalenceScenario[] = [
    { name: 'flow-list-absent', argv: ['sdd', 'status'] },
    { name: 'flow-not-found', argv: ['sdd', 'status', 'missing-flow'] },
    { name: 'run-not-found', argv: ['wait', '20260101-0000-abcd', '--max', '0'] },
  ].map(({ name, argv }) => ({
    name,
    prepare() {},
    run(binRoot, root, env) { return captureState(root, runFixtureCli(binRoot, root, argv, env)) },
  }))
  return [...reads, {
    name: 'worktree-config-copy',
    prepare(root) {
      const main = gitIn(root, 'worktree', 'list', '--porcelain').split('\n').find((line) => line.startsWith('worktree '))?.slice(9)
      if (!main) throw new Error('el fixture no identifica su checkout principal')
      mkdirSync(join(main, '.sdd-ai'), { recursive: true })
      for (const [name, bytes] of Object.entries(worktreeConfigBytes)) writeFileSync(join(main, '.sdd-ai', name), bytes)
    },
    run(binRoot, root, env) { return captureState(root, runFixtureCli(binRoot, root, ['init', '--reuse-config'], env)) },
  }, {
    // Ensayo de prune con una corrida vieja como candidata; después la unidad cambia y la aplicación la recomprueba.
    name: 'prune-changed-candidate',
    prepare(root) {
      const unit = join(root, '.sdd-ai', 'runs', '20250101-0000-abcd')
      mkdirSync(unit, { recursive: true })
      // Una corrida terminada sin sesión dueña no tiene entrega pendiente: es candidata si es vieja.
      writeFileSync(join(unit, 'request.json'), JSON.stringify({ role: 'explore' }) + '\n')
      writeFileSync(join(unit, 'status.json'), JSON.stringify({ state: 'done' }) + '\n')
      const old = new Date('2025-01-01T00:00:00Z')
      for (const path of [join(unit, 'request.json'), join(unit, 'status.json'), unit]) utimesSync(path, old, old)
    },
    run(binRoot, root, env) {
      const dry = runFixtureCli(binRoot, root, ['prune'], env)
      const digest = (dry.json as { digest?: string })?.digest
      if (dry.exit_code !== 0 || !digest) throw new Error('prune no alcanzó el ensayo')
      writeFileSync(join(root, '.sdd-ai', 'runs', '20250101-0000-abcd', 'late.txt'), 'cambio posterior al ensayo\n')
      const applied = runFixtureCli(binRoot, root, ['prune', '--apply', '--digest', digest], env)
      return captureState(root, combinedCapture([dry, applied], applied.exit_code ?? -1))
    },
  }, {
    // Publicación habilitada: el verbo que publica corre en este proceso, así que su efecto se compara completo.
    name: 'publication-enabled',
    prepare(root) { mkdirSync(join(root, '.sdd-ai'), { recursive: true }) },
    run(binRoot, root, env) {
      // cleanGitEnv apaga la proyección si el entorno no la trae: aquí se enciende de forma explícita.
      const enabled = { ...env, SDD_AI_PROJECTION: 'on' }
      const published = runFixtureCli(binRoot, root, ['__publish', root, 'fixture', 'cli', '1767225600000', '0'], enabled)
      // Normalización declarada de la observación: su id (que es el nombre del archivo), el pid del publicador, el
      // reloj monotónico, el arranque y los instantes cambian entre corridas; el id del checkout se deriva de la
      // raíz, que es distinta en cada fixture. Se comprueba su forma y se compara completo el resto del contenido.
      const live = join(root, '.sdd-ai', 'projection', 'live')
      const observations = existsSync(live) ? readdirSync(live).filter((name) => name.endsWith('.json')).sort().map((name) => {
        const o = JSON.parse(readFileSync(join(live, name), 'utf8'))
        if (!/^[0-9a-f]{64}$/.test(o.checkout?.id ?? '') || typeof o.observation?.publisher?.pid !== 'number') throw new Error('observación con forma inesperada')
        // Los campos que se reemplazan tienen que estar, con un valor: una observación incompleta no se iguala a una completa.
        // Cada uno con el tipo de ProjectionObservation (src/projection-types.ts).
        const fields = { id: 'string', m0: 'string', boot: 'string', observed_at: 'number', read_finished_at: 'number' } as const
        for (const [field, type] of Object.entries(fields)) {
          const value = o.observation[field]
          if (typeof value !== type || value === '' || (type === 'number' && !Number.isFinite(value))) throw new Error(`observación sin ${field} de tipo ${type}`)
        }
        return { ...o, checkout: { ...o.checkout, id: '<checkout-id>' },
          observation: { ...o.observation, id: '<observation>', m0: '<m0>', boot: '<boot>', observed_at: '<epoch>', read_finished_at: '<epoch>',
            publisher: { ...o.observation.publisher, pid: '<pid>' } } }
      }) : []
      // En Windows la proyección no publica: readBootId no tiene fuente de arranque allí (src/projection.ts) y la base
      // tampoco escribe nada. La comparación comprueba igual que las dos versiones dejen lo mismo.
      if (observations.length === 0 && process.platform !== 'win32') throw new Error('la publicación habilitada no dejó ninguna observación')
      rmSync(join(root, '.sdd-ai', 'projection'), { recursive: true, force: true })
      return captureState(root, { ...published, json: { published: published.json, observations } })
    },
  }]
}

export function recoveryScenarios(): EquivalenceScenario[] {
  return [{
    name: 'identification-loss-and-replacement',
    prepare(root) {
      const gitDir = gitIn(root, 'rev-parse', '--absolute-git-dir')
      const commonDir = gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      const replacement = join(root, 'replacement-git')
      cpSync(gitDir, replacement, { recursive: true })
      if (gitDir !== commonDir) writeFileSync(join(replacement, 'commondir'), `${commonDir}\n`)
    },
    async run(binRoot, root, env) {
      const api = await import(pathToFileURL(join(binRoot, 'src', 'git.ts')).href)
      const observe = () => {
        const first = api.gitDirs(root)
        const again = api.gitDirs(root)
        renameSync(join(root, '.git'), join(root, 'original-identification'))
        const failures: Array<{ code: string; message: string; detail: string | null }> = []
        for (let i = 0; i < 2; i++) {
          try { api.repoRoot(root); throw new Error('la identificación ausente se informó disponible') } catch (error) {
            const failure = error as { code?: string; message: string; detail?: string }
            if (failure.code !== 'not_a_repo') throw error
            failures.push({ code: failure.code, message: failure.message, detail: failure.detail ?? null })
          }
        }
        writeGitFile(root, join(root, 'replacement-git'))
        return { first, again, failures, current: api.gitDirs(root), root: api.repoRoot(root) }
      }
      const scopeFile = join(binRoot, 'src', 'git-memo.ts')
      const scoped = existsSync(scopeFile) ? await import(pathToFileURL(scopeFile).href) : null
      const json = withGitEnv(env, () => scoped ? scoped.withGitQueryScope('call', observe) : observe())
      return captureState(root, { stdout: JSON.stringify(json) + '\n', stderr: '', exit_code: 0, error: null, json })
    },
  }]
}

/** La base no exporta el memo nuevo: la misma observación corre sin ámbito allí. */
async function observeVersion<T>(binRoot: string, env: NodeJS.ProcessEnv, observe: () => T): Promise<T> {
  const scopeFile = join(binRoot, 'src', 'git-memo.ts')
  const scoped = existsSync(scopeFile) ? await import(pathToFileURL(scopeFile).href) : null
  return withGitEnv(env, () => scoped ? scoped.withGitQueryScope('call', observe) : observe())
}

export function exclusionScenarios(): EquivalenceScenario[] {
  return [...(['checkout', 'refs'] as const).map((domain): EquivalenceScenario => ({
    name: `reservation-${domain}-conflict`,
    prepare(root) {
      const gitDir = gitIn(root, 'rev-parse', '--absolute-git-dir')
      const commonDir = gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      const path = join(domain === 'checkout' ? gitDir : commonDir, 'sdd-ai', `${domain}.lock`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ version: 2, domain, path, token: 'fixture-reservation-token',
        id: 'fixture-holder', kind: 'commit', pid: process.pid, lstart: null, checkout: { root, gitDir, commonDir } }) + '\n')
    },
    async run(binRoot, root, env) {
      const api = await import(pathToFileURL(join(binRoot, 'src', 'writer-store.ts')).href)
      const json = await observeVersion(binRoot, env, () => {
        const first = api.inspectReservations(root, ['checkout', 'refs'])
        const again = api.inspectReservations(root, ['checkout', 'refs'])
        const blocked = api.acquireReservation(root, 'fixture-contender', 'commit')
        if (blocked.ok) {
          api.releaseAll(blocked.handles)
          throw new Error('una reserva incompatible no bloqueó la operación')
        }
        const owned = api.ownReservation(root) ?? null
        if (!first?.holder) throw new Error('no se leyó el titular íntegro de la reserva')
        const released = api.releaseReservation(first.holder)
        const after = api.inspectReservations(root, ['checkout', 'refs'])
        return { first, again, blocked, owned, released, after }
      })
      return captureState(root, { stdout: JSON.stringify(json) + '\n', stderr: '', exit_code: 0, error: null, json })
    },
  })), {
    // Un writer cuyo supervisor ya no existe: wait informa el cese incierto y cancel no señala a nadie sin la confirmación.
    name: 'cancel-uncertain-cessation',
    prepare(root) {
      const writer = prepareWaitingWriter(root)
      // Los dos lados escriben los mismos bytes.
      const gone = GONE_PID
      writeFileSync(join(writer.store, 'status.json'), JSON.stringify({ state: 'running', supervisor_pid: gone }))
      writeFileSync(join(root, '.sdd-ai', 'runs', writer.id, 'status.json'), JSON.stringify({ state: 'running', supervisor_pid: gone }))
    },
    run(binRoot, root, env) {
      const id = WAITING_WRITER_ID
      const waited = runFixtureCli(binRoot, root, ['wait', id, '--max', '0'], env)
      const cancelled = runFixtureCli(binRoot, root, ['cancel', id], env)
      return captureState(root, combinedCapture([waited, cancelled], cancelled.exit_code ?? -1))
    },
  }, {
    // Un gate vencido (huella distinta de tasks) impide la aplicación de commit con el digest de un ensayo válido, sin
    // escribir nada.
    name: 'invalid-gates',
    prepare: prepareScenarioFlow,
    async run(binRoot, root, env) {
      const verified = runFixtureCli(binRoot, root, ['sdd', 'verify', 'f'], env)
      if (verified.exit_code !== 0 || !(verified.json as { green?: boolean })?.green) throw new Error('no se preparó un recibo real para commit')
      await prepareFixtureReview(binRoot, root, gitIn(root, 'rev-parse', 'HEAD'))
      const drafted = runFixtureCli(binRoot, root, ['sdd', 'commit', 'f', '--subject', 'fixture candidate'], env)
      const digest = (drafted.json as { digest?: string })?.digest
      if (drafted.exit_code !== 0 || !digest) throw new Error('commit no alcanzó el ensayo antes de vencer el gate')
      const path = join(root, '.plans', 'f', 'sdd-ai-approvals.json')
      const approvals = JSON.parse(readFileSync(path, 'utf8'))
      approvals.approvals.find((a: { gate: string }) => a.gate === 'tasks').fingerprint = 'sha256:' + '0'.repeat(64)
      writeFileSync(path, JSON.stringify(approvals))
      const head = gitIn(root, 'rev-parse', 'HEAD')
      const blocked = runFixtureCli(binRoot, root, ['sdd', 'commit', 'f', '--subject', 'fixture candidate', '--apply', '--digest', digest], env)
      // El rechazo tiene que venir del gate (el flujo vuelve al paso gate), no de un digest distinto.
      const refusal = blocked.json as { code?: string; message?: string } | null
      if (blocked.exit_code === 0 || refusal?.code !== 'step_not_commit' || !/el paso es gate/.test(refusal.message ?? '') || gitIn(root, 'rev-parse', 'HEAD') !== head) {
        throw new Error(`un gate vencido no bloqueó el commit por el gate: ${blocked.stdout}`)
      }
      return captureState(root, combinedCapture([verified, drafted, blocked], blocked.exit_code ?? -1))
    },
  }]
}

export function legacyScenarios(): EquivalenceScenario[] {
  return [...[false, true].map((frozen): EquivalenceScenario => ({
    name: frozen ? 'legacy-control-frozen' : 'legacy-control-without-checkout',
    prepare(root) {
      const id = '20260101-0000-abcd'
      // Con la forma de gitDirs (realpathSync), como las escribe el producto: en Windows, Git devuelve rutas con `/`.
      const gitDir = realpathSync(gitIn(root, 'rev-parse', '--absolute-git-dir'))
      const commonDir = realpathSync(gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
      writeLegacyControl(root, id, { base: gitIn(root, 'rev-parse', 'HEAD'), family: 'codex', prompt: 'fixture',
        ...(frozen ? { checkout: { root, gitDir, commonDir } } : {}) },
      // Con la forma de gitDirs (realpathSync), que es la que escribe el producto: en Windows, Git devuelve `/`.
      { id, pid: process.pid, lstart: null, gitDir: realpathSync(gitDir) })
    },
    async run(binRoot, root, env) {
      const api = await import(pathToFileURL(join(binRoot, 'src', 'writer-store.ts')).href)
      const json = await observeVersion(binRoot, env, () => {
        const id = '20260101-0000-abcd'
        const control = api.readControl(root, id)
        const again = api.readControl(root, id)
        const store = api.controlStore(root, control)
        const before = api.readHarvest(root, id) ?? null
        const reservation = api.ownReservation(root)
        if (!reservation || reservation.version !== 1) throw new Error('no se conservó la reserva del protocolo anterior')
        publishDoneHarvest(root, store, control.base)
        const after = api.readHarvest(root, id)
        const released = api.releaseReservation(reservation)
        return { control, again, store, before, reservation, after, released }
      })
      return captureState(root, { stdout: JSON.stringify(json) + '\n', stderr: '', exit_code: 0, error: null, json })
    },
  })), {
    // Un writer vivo: la primera vuelta de wait lo ve corriendo y, cuando publica su cosecha, la siguiente la entrega.
    name: 'live-writer-evolution',
    prepare(root) { prepareWaitingWriter(root) },
    run(binRoot, root, env) {
      const id = WAITING_WRITER_ID
      const running = runFixtureCli(binRoot, root, ['wait', id, '--max', '0'], env)
      if ((running.json as { state?: string })?.state !== 'running') throw new Error(`la primera vuelta no vio el writer corriendo: ${running.stdout}`)
      const store = waitingWriterStore(root, id)
      publishDoneHarvest(root, store, JSON.parse(readFileSync(join(store, 'control.json'), 'utf8')).base)
      const delivered = runFixtureCli(binRoot, root, ['wait', id, '--max', '0'], env)
      if ((delivered.json as { state?: string })?.state !== 'done') throw new Error(`la segunda vuelta no entregó la cosecha: ${delivered.stdout}`)
      return captureState(root, combinedCapture([running, delivered], delivered.exit_code ?? -1))
    },
  }]
}

/**
 * El registro de una cosecha terminada y sin cambios de un writer de prueba. Solo lo arma: su `patchFile` apunta al
 * parche vacío que escribe publishDoneHarvest.
 */
export function doneHarvestRecord(root: string, store: string, base: string) {
  return { state: 'done', base, tree: gitIn(root, 'rev-parse', 'HEAD^{tree}'), files: [],
    patchFile: join(store, 'diff.patch'), flagged: [], runAltered: [], headMoved: false, endMark: true, report: 'fixture\nSTATUS: done' }
}

/** Publica en el almacén la cosecha terminada de un writer de prueba: el parche vacío y el registro. */
export function publishDoneHarvest(root: string, store: string, base: string) {
  writeFileSync(join(store, 'diff.patch'), '')
  writeFileSync(join(store, 'harvest.json'), JSON.stringify(doneHarvestRecord(root, store, base)) + '\n')
}

/** El almacén de un writer, con la forma de gitDirs (realpathSync) con que lo escribe el producto y lo prepara writeLegacyControl. */
export function waitingWriterStore(root: string, id: string) {
  return join(realpathSync(gitIn(root, 'rev-parse', '--absolute-git-dir')), 'sdd-ai', 'runs', id)
}

/** Instala el contrato seguro de verify sobre el fixture de la matriz, con una base reproducible. */
function prepareScenarioFlow(root: string) {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), '.plans/\n.sdd-ai/\nbuild/\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const f = () => 1\n')
  gitIn(root, 'add', '.gitignore', 'src/a.ts')
  gitIn(root, 'commit', '-qm', 'verify scenario base')
  const base = gitIn(root, 'rev-parse', 'HEAD')
  const dir = join(root, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of Object.entries({ 'spec.md': SPEC_MD, 'handoff.md': HANDOFF_MD,
    'tasks.md': TASKS_MD(true), 'plan.md': planMd(base, 'implementing', [RED_ROW, BUILD_ROW]) })) writeFileSync(join(dir, name), bytes)
  writeFileSync(join(root, 'src', 'a.ts'), 'export const f = () => 2\n')
  writeFileSync(join(root, 'test', 'a.test.ts'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from '../src/a.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n")
  withGitEnv({}, () => approveAll(root))
}

/**
 * Las operaciones de un escenario en una sola captura. Un error de lanzamiento o un timeout de cualquiera de ellas
 * queda en el `error` de la captura combinada, que es el campo que comprueba la matriz.
 */
function combinedCapture(operations: unknown[], exitCode: number): CliCapture {
  const json = { operations }
  const errors = operations.map((op) => (op && typeof op === 'object' ? (op as { error?: unknown }).error : null)).filter((error) => error !== null && error !== undefined)
  return { stdout: JSON.stringify(json) + '\n', stderr: '', exit_code: exitCode, error: errors.length ? errors.map(String).join('; ') : null, json }
}

export function changeScenarios(): EquivalenceScenario[] {
  return [{
    name: 'verify-final-success',
    prepare: prepareScenarioFlow,
    run(binRoot, root, env) {
      const verified = runFixtureCli(binRoot, root, ['sdd', 'verify', 'f'], env)
      if (verified.exit_code !== 0 || !(verified.json as { green?: boolean })?.green) throw new Error('verify final no dio un recibo verde')
      return captureState(root, verified)
    },
  }, {
    name: 'commit-draft-and-apply-success',
    prepare: prepareScenarioFlow,
    async run(binRoot, root, env) {
      // runFixtureCli pasa por cleanGitEnv, que fija las fechas de autor y de commit: los dos lados crean el mismo SHA.
      const verified = runFixtureCli(binRoot, root, ['sdd', 'verify', 'f'], env)
      if (verified.exit_code !== 0 || !(verified.json as { green?: boolean })?.green) throw new Error('no se preparó un recibo real para commit')
      const head = gitIn(root, 'rev-parse', 'HEAD')
      await prepareFixtureReview(binRoot, root, head)
      const drafted = runFixtureCli(binRoot, root, ['sdd', 'commit', 'f', '--subject', 'fixture candidate'], env)
      const digest = (drafted.json as { digest?: string })?.digest
      if (drafted.exit_code !== 0 || !digest) throw new Error('commit no alcanzó el ensayo')
      const applied = runFixtureCli(binRoot, root, ['sdd', 'commit', 'f', '--subject', 'fixture candidate', '--apply', '--digest', digest], env)
      if (applied.exit_code !== 0 || gitIn(root, 'rev-parse', 'HEAD^') !== head) throw new Error('la aplicación no creó el commit sobre la base')
      return captureState(root, combinedCapture([verified, drafted, applied], applied.exit_code ?? -1))
    },
  }, {
    name: 'verify-content-change-during-row',
    prepare(root) {
      prepareScenarioFlow(root)
      configureFixtureBuild(root, "require('node:fs').writeFileSync('src/a.ts', 'export const f = () => 3\\n')")
    },
    run(binRoot, root, env) {
      const verified = runFixtureCli(binRoot, root, ['sdd', 'verify', 'f'], env)
      if (verified.exit_code !== 0 || (verified.json as { green?: boolean })?.green !== false) throw new Error('verify no rechazó el cambio durante la fila')
      return captureState(root, verified)
    },
  }, {
    name: 'commit-content-change-after-draft',
    prepare: prepareScenarioFlow,
    async run(binRoot, root, env) {
      const verified = runFixtureCli(binRoot, root, ['sdd', 'verify', 'f'], env)
      if (verified.exit_code !== 0 || !(verified.json as { green?: boolean })?.green) throw new Error('no se preparó un recibo real para commit')
      await prepareFixtureReview(binRoot, root, gitIn(root, 'rev-parse', 'HEAD'))
      const drafted = runFixtureCli(binRoot, root, ['sdd', 'commit', 'f', '--subject', 'fixture candidate'], env)
      const digest = (drafted.json as { digest?: string })?.digest
      if (drafted.exit_code !== 0 || !digest) throw new Error('commit no alcanzó el ensayo')
      const head = gitIn(root, 'rev-parse', 'HEAD')
      writeFileSync(join(root, 'src', 'a.ts'), 'export const f = () => 3\n')
      const applied = runFixtureCli(binRoot, root, ['sdd', 'commit', 'f', '--subject', 'fixture candidate', '--apply', '--digest', digest], env)
      if (applied.exit_code === 0 || gitIn(root, 'rev-parse', 'HEAD') !== head) throw new Error('commit no rechazó el contenido cambiado después del ensayo')
      return captureState(root, combinedCapture([verified, drafted, applied], applied.exit_code ?? -1))
    },
  }, {
    name: 'commit-head-change-at-final-check',
    prepare: prepareScenarioFlow,
    async run(binRoot, root, env) {
      const verified = runFixtureCli(binRoot, root, ['sdd', 'verify', 'f'], env)
      if (verified.exit_code !== 0 || !(verified.json as { green?: boolean })?.green) throw new Error('no se preparó un recibo real para commit')
      const head = gitIn(root, 'rev-parse', 'HEAD')
      await prepareFixtureReview(binRoot, root, head)
      const tree = gitIn(root, 'rev-parse', 'HEAD^{tree}')
      const alternate = gitIn(root, 'commit-tree', tree, '-p', head, '-m', 'external head')
      const branch = gitIn(root, 'symbolic-ref', 'HEAD')
      const ref = join(gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), branch)
      const api = await import(pathToFileURL(join(binRoot, 'src', 'cli.ts')).href)
      return withGitAndSwitchesEnvAsync(env, async () => {
        const drafted = await api.main(['sdd', 'commit', 'f', '--subject', 'fixture candidate'], env, root)
        if (drafted.code !== 0 || !drafted.out.digest) throw new Error('commit no alcanzó el ensayo')
        let mutations = 0
        const restore = interceptExecFileSync({ match: (argv, opts, stack) => resolve(String(opts.cwd)) === resolve(root) && argv.includes('HEAD^{commit}') && stack.includes('commitOnce'),
          before() { if (mutations++ === 0) { mkdirSync(dirname(ref), { recursive: true }); writeFileSync(ref, `${alternate}\n`) } } })
        try {
          const applied = await api.main(['sdd', 'commit', 'f', '--subject', 'fixture candidate', '--apply', '--digest', drafted.out.digest], env, root)
          if (mutations === 0 || applied.code === 0 || applied.out.code !== 'head_moved' || gitIn(root, 'rev-parse', 'HEAD') !== alternate) throw new Error('commit no rechazó el cambio en su comprobación final de HEAD')
          return captureState(root, combinedCapture([verified, drafted, applied], applied.code))
        } finally { restore() }
      })
    },
  }]
}

export function configureFixtureBuild(root: string, program: string) {
  const base = gitIn(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, '.plans', 'f', 'plan.md'), planMd(base, 'implementing', [RED_ROW, { ...BUILD_ROW, argv: [process.execPath, '-e', program] }]))
  withGitEnv({}, () => approveAll(root))
}

/** APIs existentes, expuestas desde el helper nuevo para conservar los imports red_on_revert. */
export async function consumerApis() {
  const [open, prune, config] = await Promise.all([
    import('../src/open-runs.ts'), import('../src/prune.ts'), import('../src/worktree-config.ts'),
  ])
  return { ...open, ...prune, ...config }
}

export async function reservationApis() {
  return import('../src/writer-store.ts')
}

export async function supervisorApis() {
  return import('../src/supervisor.ts')
}

/** Ejecuta el supervisor real con un proceso Node, sin motor ni cambios al PATH. */
export async function startSupervisedNode(root: string, onSignal: 'exit' | 'ignore') {
  const api = await supervisorApis()
  const dir = join(root, '.sdd-ai', 'runs', `supervisor-${onSignal}`)
  mkdirSync(dir, { recursive: true })
  const marker = join(dir, 'ready.json'); const signalled = join(dir, 'signalled')
  const stdinFile = join(dir, 'prompt.md')
  writeFileSync(stdinFile, 'fixture\n')
  const program = `const fs=require('node:fs');
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(signalled)},'SIGTERM'); if(${JSON.stringify(onSignal)}==='exit') process.exit(0)});
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);`
  writeFileSync(join(dir, 'argv.json'), JSON.stringify({ family: 'codex', kind: 'run', root,
    deadline_sec: 30, grace_ms: 50, launch: { cmd: process.execPath, args: ['-e', program], cwd: root, stdinFile } }))
  const ended = api.supervise(dir)
  return { dir, marker, signalled, ended, async cleanup() {
    writeFileSync(join(dir, 'cancel.request'), 'cleanup')
    await ended
  } }
}

/**
 * Los ámbitos de la primera llamada de una lista de eventos, para un verbo cuya entrada resuelve la raíz antes de la
 * primera vuelta (como `wait`). El ámbito de la llamada es el primero que abre: el de menor id con ese `call`, y tiene
 * que traer la consulta repoRoot de la entrada. Los demás son sus vueltas. Si no hay una llamada o su ámbito no se
 * puede identificar así, lanza en vez de tomar una vuelta por la llamada.
 */
export function scopesOfCall(events: GitMemoEvent[]) {
  const call = events.find((e) => e.call !== null)?.call
  if (call === undefined) throw new Error('ningún evento pertenece a una llamada')
  const own = events.filter((e) => e.call === call && e.scope !== null)
  const callScope = Math.min(...own.map((e) => e.scope as number))
  if (!own.some((e) => e.scope === callScope && e.query === 'repoRoot')) throw new Error('no se identificó el ámbito de la llamada: no tiene la consulta repoRoot de la entrada')
  return { call, callScope, iterations: new Set<number | null>(own.map((e) => e.scope).filter((scope) => scope !== callScope)) }
}

/**
 * Un PID que no puede existir: supera el máximo de macOS (99999) y de Linux (4194304), y en Windows, que ignora los dos
 * bits bajos, equivale a 2147483644, muy por encima de los PID que asigna. A diferencia del PID de un hijo terminado,
 * el sistema no lo reasigna.
 */
export const GONE_PID = 2147483647

/** El id de la corrida del writer de prueba: prepare y run de un escenario lo comparten. */
export const WAITING_WRITER_ID = '20260101-0000-abcd'

export function prepareWaitingWriter(root: string, id = WAITING_WRITER_ID) {
  // Con la forma de gitDirs (realpathSync), como escribe el producto el checkout del control: en Windows, Git
  // devuelve rutas con `/`.
  const gitDir = realpathSync(gitIn(root, 'rev-parse', '--absolute-git-dir'))
  const commonDir = realpathSync(gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  const checkout = { root, gitDir, commonDir }
  mkdirSync(join(root, '.sdd-ai', 'runs', id), { recursive: true })
  const visible = runDirIdentity(root, id)
  if (!visible) throw new Error('no se pudo identificar la corrida visible del writer de prueba')
  const control = { id, base: gitIn(root, 'rev-parse', 'HEAD'), family: 'codex', prompt: 'fixture writer', checkout,
    request: { role: 'implement', conductor: { family: 'codex' }, deadline_sec: 30 },
    preLaunch: runInventory(root, id), inventory: sensitiveInventory(root, checkout), runDir: visible }
  const store = writeLegacyControl(root, id, control)
  writeFileSync(join(store, 'status.json'), JSON.stringify({ state: 'running', supervisor_pid: process.pid }))
  return { id, store, control, harvest: doneHarvestRecord(root, store, control.base) }
}

export interface ControlledLaunch { api: 'execFileSync' | 'spawnSync' | 'execFile' | 'spawn' | 'exec' | 'execSync' | 'fork'; file: string; argv?: string[]; cwd?: string }
/**
 * Lanza un programa Node que hace los lanzamientos pedidos, en orden. Con `tolerateFailures`, un lanzamiento que falla
 * (por ejemplo, un ejecutable inexistente) no detiene el programa: no agrega lanzamientos, solo tolera los que fallan.
 */
export function spawnControlledProcess(options: { launches: ControlledLaunch[]; tolerateFailures?: boolean; execArgv?: string[] }) {
  const program = `import cp from 'node:child_process'; import { channel } from 'node:diagnostics_channel';
const launches = ${JSON.stringify(options.launches)}; let seq = 0;
for (const launch of launches) {
 const args = launch.argv ?? []; const opts = { cwd: launch.cwd, stdio: 'pipe' };
 const query = args.includes('--show-toplevel') ? 'repoRoot' : args.includes('--git-common-dir') ? 'gitDirs' : args.includes('--git-path') ? 'objects' : null;
 const sync = launch.api.endsWith('Sync');
 if (sync && query) channel('sdd-ai:git-memo').publish({v:1,kind:'bypass',query,key:JSON.stringify(args),scope:null,call:null,reason:'no_scope',seq:++seq});
 try {
  if (launch.api === 'execSync') cp.execSync(launch.file, opts);
  else if (launch.api === 'exec') await new Promise((resolve, reject) => cp.exec(launch.file, opts, (e) => e ? reject(e) : resolve()));
  else if (sync) cp[launch.api](launch.file, args, opts);
  else await new Promise((resolve, reject) => { const child = cp[launch.api](launch.file, args, opts); child.on('error', reject); child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error('lanzamiento terminado con código ' + code + ' y señal ' + signal))); });
 } catch (error) { if (!${JSON.stringify(options.tolerateFailures ?? false)}) throw error; }
}`
  // El programa va a un archivo y no a `-e`: con `-e`, un fork del proceso heredaría el programa en su execArgv
  // y lo volvería a evaluar, en una recursión sin fin.
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-controlled-'))
  const script = join(scratch, 'controlled.mjs')
  writeFileSync(script, program)
  const child = spawn(process.execPath, [...(options.execArgv ?? []), script], { env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const ended = new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    child.once('error', reject); child.once('close', (code) => done({ code, stdout, stderr }))
  }).finally(() => {
    // Una falla de limpieza (por ejemplo, EBUSY si en Windows un antivirus retiene el programa) no reemplaza el
    // resultado de un proceso que terminó: se reintenta y, si sigue, el temporal queda.
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* El temporal queda en tmpdir. */ }
  })
  return { child, ended }
}

export function spawnControlledWriter(options: { root: string; onSignal: 'exit' | 'ignore'; steps: Array<{ path: string; content?: string; remove?: boolean; move_to?: string; copy_from?: string; delay_ms?: number }> }) {
  const state = join(options.root, 'controlled-writer.json')
  const program = `import { closeSync, cpSync, ftruncateSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'; import { dirname, resolve } from 'node:path';
const root = ${JSON.stringify(options.root)}; const state = ${JSON.stringify(state)};
process.on('SIGTERM', () => { if (${JSON.stringify(options.onSignal)} === 'exit') process.exit(0); });
writeFileSync(state, JSON.stringify({pid:process.pid,step:0}));
const steps = ${JSON.stringify(options.steps)};
for (const [index, step] of steps.entries()) { await new Promise(r => setTimeout(r,step.delay_ms ?? 0)); const path = resolve(root,step.path);
 if (step.remove) rmSync(path,{recursive:true,force:true});
 else if (step.move_to) { const target = resolve(root,step.move_to); mkdirSync(dirname(target),{recursive:true}); renameSync(path,target); }
 else if (step.copy_from) { mkdirSync(dirname(path),{recursive:true}); cpSync(resolve(root,step.copy_from),path,{recursive:true}); }
 else { mkdirSync(dirname(path),{recursive:true}); const bytes = Buffer.from(step.content ?? '');
  // Un archivo existente se reescribe con 'r+', como writeGitFile: Git for Windows marca oculto el gitfile y 'w' falla con EPERM.
  let existing = false; try { existing = lstatSync(path).isFile() } catch {}
  if (existing) { const fd = openSync(path,'r+'); try { ftruncateSync(fd,0); writeSync(fd,bytes,0,bytes.length,0) } finally { closeSync(fd) } }
  else writeFileSync(path,bytes); }
 writeFileSync(state, JSON.stringify({pid:process.pid,step:index+1})); }
// Sigue vivo mientras viva el proceso del test: si este muere sin limpiar, el writer desligado no queda huérfano.
setInterval(() => { try { process.kill(${process.pid}, 0) } catch { process.exit(0) } }, 500);`
  const child: ChildProcess = spawn(process.execPath, ['--input-type=module', '-e', program], { env: cleanGitEnv(), stdio: 'ignore', detached: true })
  const ended = new Promise<void>((done, reject) => { child.once('error', reject); child.once('exit', () => done()) })
  return { child, state, ended, async cleanup() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended } }
}

/** Registros anteriores mínimos: sus lectores reales deciden qué campos necesitan. */
export function writeLegacyControl(root: string, id: string, control: Record<string, unknown>, reservation?: Record<string, unknown>) {
  // Con la forma de gitDirs (realpathSync), como las escribe el producto: en Windows, Git devuelve rutas con `/`.
  const gitDir = realpathSync(gitIn(root, 'rev-parse', '--absolute-git-dir'))
  const commonDir = realpathSync(gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  const dir = join(gitDir, 'sdd-ai', 'runs', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ ...control, id }) + '\n')
  if (reservation) { mkdirSync(join(commonDir, 'sdd-ai'), { recursive: true }); writeFileSync(join(commonDir, 'sdd-ai', 'writer.lock'), JSON.stringify(reservation) + '\n') }
  return dir
}

/**
 * La configuración de Git del host no entra en los tests: sin la de sistema y con un global que no existe. Un
 * `commit.gpgsign` impediría crear commits, y un include global haría que las consultas no se memoricen
 * (`config_include`). Un test que necesita otra configuración la trae en su `extra`.
 */
export const ISOLATED_GIT_CONFIG = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(tmpdir(), 'sdd-ai-git-memo-no-config', 'gitconfig') }

/** Las variables Git que fija el fixture: cualquier otra GIT_* en un entorno de operación vendría del host. */
export const FIXTURE_GIT_ENV: Readonly<Record<string, string>> = { ...ISOLATED_GIT_CONFIG, GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }

export function cleanGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'NODE_TEST_CONTEXT')),
    ...FIXTURE_GIT_ENV, SDD_AI_TELEMETRY: 'off', SDD_AI_PROJECTION: 'off', ...extra }
}

/** Las modificaciones globales del entorno son síncronas y se restauran aun con excepción. */
export function withGitEnv<T>(extra: NodeJS.ProcessEnv, fn: () => T): T {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('GIT_')))
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
  Object.assign(process.env, ISOLATED_GIT_CONFIG)
  for (const [name, value] of Object.entries(extra)) if (name.startsWith('GIT_') && value !== undefined) process.env[name] = value
  try { return fn() } finally {
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
    Object.assign(process.env, saved)
  }
}

/**
 * La versión asíncrona del aislamiento de Git, para tests que llaman a `main` en este proceso. A diferencia de
 * withGitEnv, también fija SDD_AI_TELEMETRY y SDD_AI_PROJECTION (por defecto en `off`, salvo que `extra` los traiga),
 * porque `main` publica y registra telemetría en el proceso del test.
 */
export async function withGitAndSwitchesEnvAsync<T>(extra: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('GIT_')))
  const switches = ['SDD_AI_TELEMETRY', 'SDD_AI_PROJECTION'] as const
  const savedSwitches = Object.fromEntries(switches.map((name) => [name, process.env[name]]))
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
  Object.assign(process.env, ISOLATED_GIT_CONFIG)
  for (const [name, value] of Object.entries(extra)) if (name.startsWith('GIT_') && value !== undefined) process.env[name] = value
  for (const name of switches) process.env[name] = extra[name] ?? 'off'
  try { return await fn() } finally {
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
    Object.assign(process.env, saved)
    for (const name of switches) {
      if (savedSwitches[name] === undefined) delete process.env[name]
      else process.env[name] = savedSwitches[name]
    }
  }
}

export async function abortFixtureVerify(root: string) {
  const { prepareVerify, runFinal } = await import('../src/sdd/verify.ts')
  const marker = join(root, '.plans', 'f', 'row-started')
  configureFixtureBuild(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`)
  const controller = new AbortController()
  const start = prepareVerify(root, 'f', 'final')
  const timer = setInterval(() => { if (existsSync(marker)) controller.abort() }, 10)
  const deadline = setTimeout(() => controller.abort(), 10000)
  try {
    const result = await runFinal(start, controller.signal)
    if (!existsSync(marker)) throw new Error('el aborto no llegó a una fila en ejecución')
    return result
  } finally { clearInterval(timer); clearTimeout(deadline); rmSync(marker, { force: true }) }
}

export const gitIn = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * Compara dos rutas por su forma resuelta. En Windows, Git devuelve rutas con `/` (repoRoot y la ruta de objetos)
 * y node:path las arma con `\\`: la misma ruta puede tener dos grafías.
 */
export function assertSamePath(actual: string | undefined, expected: string, message = `se esperaba ${expected}`) {
  if (actual === undefined) assert.fail(`ruta ausente; ${message}`)
  assert.equal(resolve(actual), resolve(expected), message)
}

export function makeGitMemoRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-git-memo-')))
  try {
    gitIn(root, 'init', '-q', '--initial-branch=fixture')
    gitIn(root, 'config', 'user.name', 'Fixture')
    gitIn(root, 'config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, 'content.txt'), 'fixture\n')
    gitIn(root, 'add', 'content.txt')
    gitIn(root, 'commit', '-qm', 'fixture')
    return { root, fixtureSha: gitIn(root, 'rev-parse', 'HEAD'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error }
}

export function listenGitMemo() {
  const events: GitMemoEvent[] = []
  const listener = (message: unknown) => events.push(message as GitMemoEvent)
  const diagnostics = channel('sdd-ai:git-memo')
  diagnostics.subscribe(listener)
  return { events, stop: () => diagnostics.unsubscribe(listener) }
}

export function classifyGitQuery(argv: readonly string[]): GitMemoEvent['query'] | null {
  if (!argv.includes('rev-parse')) return null
  if (argv.includes('--show-toplevel')) return 'repoRoot'
  if (argv.includes('--git-common-dir')) return 'gitDirs'
  if (argv.includes('--git-path') && argv[argv.indexOf('--git-path') + 1] === 'objects') return 'objects'
  return null
}

interface Interception {
  match: (argv: readonly string[], opts: Record<string, unknown>, stack: string) => boolean
  before?: () => void
  after?: () => void
}

/** El caller restaura en finally; las mutaciones no lanzan un Git falso ni cambian PATH. */
export function interceptExecFileSync({ match, before, after }: Interception) {
  const cp = createRequire(import.meta.url)('node:child_process') as { execFileSync: typeof execFileSync }
  const original = cp.execFileSync
  cp.execFileSync = ((...args: Parameters<typeof execFileSync>) => {
    const [file, rawArgs, rawOpts] = args
    const argv = Array.isArray(rawArgs) ? rawArgs : []
    const opts = (Array.isArray(rawArgs) ? rawOpts : rawArgs) as Record<string, unknown> | undefined
    const matched = file === 'git' && match(argv, opts ?? {}, new Error().stack ?? '')
    if (matched) before?.()
    try { return Reflect.apply(original, cp, args) } finally { if (matched) after?.() }
  }) as typeof execFileSync
  syncBuiltinESMExports()
  return () => { cp.execFileSync = original; syncBuiltinESMExports() }
}

export function countGitQueries() {
  const launches: Array<{ query: GitMemoEvent['query']; cwd: unknown; scope: number | null; call: number | null }> = []
  const restore = interceptExecFileSync({ match(argv, opts) {
    const query = classifyGitQuery(argv)
    if (query) launches.push({ query, cwd: opts.cwd ?? process.cwd(), ...currentGitQueryScope() })
    return false
  } })
  return { launches, restore }
}

export function writeGitFile(root: string, gitDir: string) {
  mkdirSync(root, { recursive: true })
  // Git for Windows marca oculto el gitfile, y en Windows writeFileSync no abre con 'w' un archivo oculto (EPERM).
  // Un archivo existente se reescribe abriéndolo con 'r+': funciona también oculto y conserva el inodo, del que
  // dependen las estampas de las pruebas de captura.
  const file = join(root, '.git')
  const bytes = Buffer.from(`gitdir: ${gitDir}\n`)
  if (!existsSync(file)) { writeFileSync(file, bytes); return }
  const fd = openSync(file, 'r+')
  try { ftruncateSync(fd, 0); writeSync(fd, bytes, 0, bytes.length, 0) } finally { closeSync(fd) }
}
