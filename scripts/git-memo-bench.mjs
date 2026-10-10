import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadavg, release, tmpdir } from 'node:os'
import { cleanGitEnv, createFixture, captureState, FIXTURE_GIT_ENV, withGitEnv } from '../test/git-memo-fixture.ts'
import { aggregate, compare, operationReached } from './git-memo-report.mjs'
import { createHash } from 'node:crypto'

const sourceRoot = resolve(import.meta.dirname, '..')
const git = (root, args) => execFileSync('git', args, { cwd: root, env: cleanGitEnv(), maxBuffer: 256 * 1024 * 1024 })

/** Extrae el tar de Git sin depender de un ejecutable tar del host. */
function extractArchive(bytes, destination) {
  mkdirSync(destination, { recursive: true })
  let attributes = {}
  const text = (block, start, size) => block.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '')
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = parseInt(text(header, 124, 12).trim() || '0', 8)
    const mode = parseInt(text(header, 100, 8).trim() || '644', 8)
    const type = text(header, 156, 1)
    const body = bytes.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'g') continue
    if (type === 'x') {
      attributes = {}
      for (let cursor = 0; cursor < body.length;) {
        const space = body.indexOf(32, cursor)
        const length = Number(body.subarray(cursor, space).toString())
        if (!Number.isInteger(length) || length <= 0) throw new Error('cabecera PAX inválida')
        const record = body.subarray(space + 1, cursor + length - 1).toString()
        const equal = record.indexOf('=')
        attributes[record.slice(0, equal)] = record.slice(equal + 1)
        cursor += length
      }
      continue
    }
    const prefix = text(header, 345, 155)
    const name = attributes.path ?? [prefix, text(header, 0, 100)].filter(Boolean).join('/')
    const path = resolve(destination, name)
    const local = relative(destination, path)
    if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('ruta fuera del snapshot')
    mkdirSync(dirname(path), { recursive: true })
    if (type === '5') mkdirSync(path, { recursive: true })
    else if (type === '2') symlinkSync(attributes.linkpath ?? text(header, 157, 100), path)
    else if (type === '' || type === '0') { writeFileSync(path, body); chmodSync(path, mode & 0o777) }
    else throw new Error(`entrada tar no soportada: ${type}`)
    attributes = {}
  }
}

export function snapshotBase(baseCommit, destination, root = sourceRoot) {
  extractArchive(git(root, ['archive', '--format=tar', baseCommit]), destination)
  symlinkSync(join(root, 'node_modules'), join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return { root: destination, source_sha: baseCommit }
}

export async function snapshotCandidate(root, baseCommit, destination) {
  snapshotBase(baseCommit, destination, root)
  const { candidateFingerprint } = await import(pathToFileURL(join(root, 'src', 'git.ts')).href)
  const fingerprint = withGitEnv({}, () => candidateFingerprint(root, 'git-memo-228', baseCommit))
  // Sin detección de renombres: un renombre lista el origen (que se borra del snapshot) y el destino.
  const changed = new Set([...git(root, ['diff', '--name-only', '--no-renames', '-z', baseCommit]).toString().split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0')].filter(Boolean))
  // Las rutas más profundas primero: si el candidato reemplaza un directorio `d` por un enlace, `d/file` se procesa
  // mientras `d` sigue siendo el directorio del snapshot, y no a través del enlace ya copiado.
  const inside = realpathSync(destination)
  for (const name of [...changed].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))) {
    if (name === '.plans/git-memo-228' || name.startsWith('.plans/git-memo-228/')) continue
    const from = join(root, name); const to = join(destination, name)
    // Nunca se borra ni se escribe fuera del snapshot.
    // Se mira el ancestro más cercano que existe: un directorio que todavía no existe se crea debajo de él.
    let ancestor = dirname(to)
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
    const parent = realpathSync(ancestor)
    if (parent !== inside && !parent.startsWith(inside + sep)) throw new Error(`ruta candidata fuera del snapshot: ${name}`)
    rmSync(to, { recursive: true, force: true })
    // lstat y no existsSync: existsSync sigue el enlace y daría por ausente un symlink colgante, que Git versiona.
    let stat
    try { stat = lstatSync(from) } catch (error) {
      // Solo una ruta ausente (borrada en el candidato) se omite; otro error deja la causa y la ruta a la vista.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      throw error
    }
    mkdirSync(dirname(to), { recursive: true })
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
    else if (stat.isFile()) { writeFileSync(to, readFileSync(from)); chmodSync(to, stat.mode & 0o777) }
    else throw new Error(`archivo candidato no soportado: ${name}`)
  }
  git(destination, ['init', '-q', '--initial-branch=snapshot'])
  // node_modules es un enlace a las dependencias del checkout: el patrón `node_modules/` de .gitignore solo
  // atrapa directorios, así que sin esta exclusión el enlace entraría en el árbol del snapshot.
  writeFileSync(join(destination, '.git', 'info', 'exclude'), 'node_modules\n')
  git(destination, ['add', '-A'])
  // El índice nuevo no conoce los archivos versionados que coinciden con .gitignore, y `add -A` los omite: se agregan
  // forzados los que están en el árbol del candidato.
  const tracked = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', fingerprint.tree], { cwd: root, env: cleanGitEnv(), maxBuffer: 256 * 1024 * 1024 })
  // Con --literal-pathspecs: un nombre versionado como `:asset` o `:(literal)foo` es una ruta, no sintaxis de pathspec.
  execFileSync('git', ['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: destination, env: cleanGitEnv(), input: tracked })
  git(destination, ['commit', '-qm', 'candidate snapshot'])
  const tree = git(destination, ['rev-parse', 'HEAD^{tree}']).toString().trim()
  if (tree !== fingerprint.tree) throw new Error('el snapshot no representa el mismo candidato')
  return { root: destination, fingerprint, snapshot_sha: git(destination, ['rev-parse', 'HEAD']).toString().trim() }
}

/** Los archivos que escribe el bench en su directorio de salida. */
const BENCH_FILE = /^(?:manifest\.json|baseline\.json|report\.json|.+\.(?:initial|evidence|aggregate)\.json|.+\.trace\.jsonl)$/

const putJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const fileDigest = (file) => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`

// Un timeout o un fallo de lanzamiento ya se rechazó en timedOperation. El criterio de camino lo comparten el bench y la
// validación del informe (operationReached), para que el informe no acepte una operación que el bench rechazaría.
export const validateOperation = operationReached

/** El entorno de cada operación medida: Git sin variables heredadas, telemetría y publicación apagadas. */
export function operationEnv() {
  return cleanGitEnv({ SDD_AI_TELEMETRY: 'off', SDD_AI_PROJECTION: 'off' })
}

/**
 * El entorno que registra el manifiesto, derivado del que reciben las operaciones: los interruptores, las variables
 * GIT_* que fija el fixture y las que no fija (heredadas, que tienen que ser ninguna).
 */
function measuredEnv() {
  const env = operationEnv()
  const git = Object.keys(env).filter((name) => name.startsWith('GIT_')).sort()
  // Heredada es la que el fixture no fija, no la que coincide con el host: el fixture puede fijar a propósito el mismo
  // valor que tiene el host (por ejemplo, GIT_CONFIG_NOSYSTEM=1).
  return { SDD_AI_TELEMETRY: env.SDD_AI_TELEMETRY, SDD_AI_PROJECTION: env.SDD_AI_PROJECTION, git_variables: git,
    inherited_git_variables: git.filter((name) => !Object.hasOwn(FIXTURE_GIT_ENV, name) || FIXTURE_GIT_ENV[name] !== env[name]) }
}

const OPERATION_TIMEOUT_MS = 240000
// Lo que se espera a que los pipes terminen de entregar la salida después de que time salió: un descendiente que se
// desligó a otro grupo puede retenerlos, y la espera no puede depender de él.
const DRAIN_MS = 2000

/** Los grupos de procesos de las operaciones en curso, para matarlos si el bench se interrumpe. */
const activeGroups = new Set()
let interrupted = null
const killGroup = (pid) => { try { process.kill(-pid, 'SIGKILL') } catch { /* El grupo ya terminó. */ } }

/**
 * Corre la operación en su propio grupo de procesos: un timeout o una interrupción del bench matan a time, a sdd-ai y
 * a todos sus hijos del grupo. La espera termina cuando time sale, aunque un descendiente desligado retenga los pipes.
 */
function runGroup(command, options) {
  return new Promise((done, reject) => {
    const child = spawn(command[0], command.slice(1), { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid) }, OPERATION_TIMEOUT_MS)
    const finish = (status, signal) => {
      if (settled) return
      // Un hijo que quedó en el grupo después de que time salió no puede seguir cargando las muestras siguientes.
      settled = true; clearTimeout(timer); killGroup(child.pid); activeGroups.delete(child.pid)
      child.stdout.destroy(); child.stderr.destroy()
      done({ stdout, stderr, status, signal, timedOut })
    }
    if (child.pid !== undefined) activeGroups.add(child.pid)
    child.once('error', (error) => { settled = true; clearTimeout(timer); activeGroups.delete(child.pid); reject(error) })
    child.once('close', finish)
    child.once('exit', (status, signal) => setTimeout(() => finish(status, signal), DRAIN_MS).unref())
  })
}

async function timedOperation(binRoot, root, argv, trace, operation) {
  // Una interrupción que llegó sin un grupo activo (entre operaciones o al preparar el fixture) no lanza otra operación.
  if (interrupted) throw interrupted
  const preload = pathToFileURL(join(sourceRoot, 'scripts', 'git-memo-trace.mjs'))
  preload.searchParams.set('out', trace ?? ''); preload.searchParams.set('op', operation)
  const nodeArgs = [...(trace ? ['--import', preload.href] : []), join(binRoot, 'bin', 'sdd-ai'), ...argv]
  // time permanece fuera de la precarga en ambas condiciones. No se usa en Windows.
  const command = ['/usr/bin/time', '-p', process.execPath, ...nodeArgs]
  const loadBefore = loadavg()
  const result = await runGroup(command, { cwd: root, env: operationEnv() })
  const loadAfter = loadavg()
  if (interrupted) throw interrupted
  // Un intento rechazado lleva lo que la operación alcanzó a producir, para guardarlo como evidencia de la exclusión.
  const rejected = (message) => Object.assign(new Error(message), { operation: { command, cwd: root, stdout: result.stdout, stderr: result.stderr,
    exit_code: result.status, signal: result.signal, timed_out: result.timedOut, load_before: loadBefore, load_after: loadAfter } })
  if (result.timedOut) throw rejected(`timeout: la operación superó ${OPERATION_TIMEOUT_MS / 1000} s y se mató su grupo de procesos`)
  const timing = /(?:^|\n)real\s+([\d.]+)\s*\nuser\s+([\d.]+)\s*\nsys\s+([\d.]+)\s*$/.exec(result.stderr ?? '')
  if (!timing) throw rejected(`time no produjo CPU y pared con unidades conocidas (código ${result.status}, señal ${result.signal})`)
  const stderr = result.stderr.slice(0, timing.index)
  let json = null
  try { json = JSON.parse(result.stdout) } catch { /* La muestra se rechaza por no alcanzar el camino. */ }
  return { command, cwd: root, stdout: result.stdout, stderr, exit_code: result.status, json,
    load_before: loadBefore, load_after: loadAfter, timing_stderr: timing[0].trim(),
    cpu: { value: Number(timing[2]) + Number(timing[3]), user: Number(timing[2]), sys: Number(timing[3]), unit: 's', source: '/usr/bin/time user+sys' },
    wall: { value: Number(timing[1]), unit: 's', source: '/usr/bin/time real' } }
}

async function measureSample({ binRoot, scenario, instrumented, directory, reportDir, id }) {
  const fixture = await createFixture({ sourceRoot: binRoot, scenario, checkout: 'principal' })
  try {
    const initial = captureState(fixture.root)
    const initialFile = join(directory, `${id}.initial.json`)
    putJson(initialFile, initial)
    const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']).toString().trim()
    const trace = instrumented ? join(directory, `${id}.trace.jsonl`) : null
    // La precarga agrega líneas: la traza empieza vacía aunque el archivo exista.
    if (trace) writeFileSync(trace, '')
    const operations = []
    const evidenceFile = join(directory, `${id}.evidence.json`)
    const evidencePath = relative(reportDir, evidenceFile).split(sep).join('/')
    const operate = async (argv, operation) => {
      try { return await timedOperation(binRoot, fixture.root, argv, trace, operation) } catch (error) {
        // Un timeout o una salida sin time: se guarda lo que la operación produjo antes de excluir la muestra.
        if (error.operation) {
          putJson(evidenceFile, { flow: fixture.flow, operations: [...operations, error.operation], failure: error.message })
          error.evidence = evidencePath
        }
        throw error
      }
    }
    if (scenario === 'verify') operations.push(await operate(['sdd', 'verify', fixture.flow], `${id}:verify`))
    else {
      const draft = await operate(['sdd', 'commit', fixture.flow, '--subject', 'fixture candidate'], `${id}:commit-draft`)
      operations.push(draft)
      if (draft.exit_code === 0 && draft.json?.digest) operations.push(await operate(
        ['sdd', 'commit', fixture.flow, '--subject', 'fixture candidate', '--apply', '--digest', draft.json.digest], `${id}:commit-apply`))
    }
    const afterHead = git(fixture.root, ['rev-parse', 'HEAD']).toString().trim()
    let receipt = null
    if (scenario === 'verify' && operations[0].json?.receipt) {
      const gitDir = git(fixture.root, ['rev-parse', '--absolute-git-dir']).toString().trim()
      receipt = JSON.parse(readFileSync(join(gitDir, 'sdd-ai', 'verify', operations[0].json.receipt, 'receipt.json'), 'utf8'))
    }
    // La evidencia de las operaciones se guarda antes de validarlas: un intento rechazado conserva su salida y su código.
    putJson(evidenceFile, { flow: fixture.flow, operations, receipt, before_head: beforeHead, after_head: afterHead })
    let reached
    try { reached = validateOperation(scenario, operations, beforeHead, afterHead, receipt) } catch (error) {
      error.evidence = evidencePath
      throw error
    }
    const afterParent = reached.commit_created ? git(fixture.root, ['rev-parse', 'HEAD^']).toString().trim() : null
    if (reached.commit_created && afterParent !== beforeHead) throw new Error('el commit no tiene el padre esperado')
    const final = captureState(fixture.root)
    if (reached.commit_created) {
      const registry = JSON.parse(readFileSync(join(fixture.root, '.plans', fixture.flow, 'sdd-ai-phases.json'), 'utf8'))
      if (registry.commit?.state !== 'done' || registry.commit.sha !== afterHead || registry.commit.tree !== final.tree) throw new Error('registro de commit ausente o incoherente')
    }
    putJson(evidenceFile, { flow: fixture.flow, operations, receipt, before_head: beforeHead, after_head: afterHead, after_parent: afterParent, final })
    const traced = trace ? aggregate(readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))) : null
    if (traced) putJson(join(directory, `${id}.aggregate.json`), traced)
    return { fixture_sha: fixture.fixtureSha,
      initial_identity: { head: initial.head, tree: initial.tree, index: initial.index,
        candidate_files: Object.fromEntries(Object.entries(initial.files).filter(([name]) => name.startsWith('src/') || name.startsWith('test/'))) },
      ...reached, operations,
      cpu: { value: operations.reduce((n, op) => n + op.cpu.value, 0), unit: 's', source: '/usr/bin/time user+sys' },
      wall: { value: operations.reduce((n, op) => n + op.wall.value, 0), unit: 's', source: '/usr/bin/time real' },
      accumulated_duration: traced?.accumulated_duration ?? { value: null, unit: 'ms', source: 'not instrumented' },
      observed_processes: traced?.observed_processes ?? null, git_queries: traced?.git_queries ?? null,
      groups: traced?.groups ?? null,
      // Rutas relativas al informe, con `/`: el informe se valida desde otro clon o host.
      artifacts: [initialFile, evidenceFile, ...(trace ? [trace, join(directory, `${id}.aggregate.json`)] : [])]
        .map((file) => ({ path: relative(reportDir, file).split(sep).join('/'), digest: fileDigest(file) })) }
  } finally { fixture.cleanup() }
}

export async function runBenchmark({ base, candidateRoot, pairs = 3, output, report: reportFile = join(output, 'report.json') }) {
  if (process.platform !== 'darwin') throw new Error('el bench usa /usr/bin/time exclusivamente en macOS')
  if (!Number.isInteger(pairs) || pairs < 3) throw new Error('--pairs exige al menos tres pares válidos')
  // Una medición anterior en el mismo directorio mezclaría sus trazas con las nuevas. Otros contenidos (por ejemplo, la
  // evidencia de Windows junto a la de macOS) no molestan.
  const previous = existsSync(output) ? readdirSync(output).filter((name) => BENCH_FILE.test(name)) : []
  if (previous.length) throw new Error(`el directorio de salida ya tiene una medición: ${previous.slice(0, 3).join(', ')}`)
  if (existsSync(reportFile)) throw new Error(`el informe ya existe: ${reportFile}`)
  mkdirSync(output, { recursive: true })
  const reportDir = dirname(reportFile)
  mkdirSync(reportDir, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-git-bench-'))
  // Las operaciones corren en otro grupo, así que un Ctrl-C no les llega: el bench mata sus grupos y termina la muestra
  // en curso con error, para que se limpien los fixtures y el directorio temporal.
  // Una segunda señal termina el bench de inmediato, por si algo que no es un grupo medido quedó esperando.
  interrupted = null
  const onSignal = (signal) => {
    if (interrupted) { for (const pid of activeGroups) killGroup(pid); process.exit(130) }
    interrupted = new Error(`bench interrumpido por ${signal}`)
    for (const pid of activeGroups) killGroup(pid)
  }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
  try {
    const baseline = snapshotBase(base, join(scratch, 'base'), candidateRoot)
    const candidate = await snapshotCandidate(candidateRoot, base, join(scratch, 'candidate'))
    const manifest = { schema: 1, base_commit: base, candidate: { fingerprint: candidate.fingerprint, snapshot_sha: candidate.snapshot_sha,
      source_sha: git(candidateRoot, ['rev-parse', 'HEAD']).toString().trim() }, fixture_sha: null,
      runtime: { node: process.version, git: git(candidateRoot, ['--version']).toString().trim(), os: process.platform, release: release() },
      env: measuredEnv(), samples: [], exclusions: [],
      coverage: 'APIs Node interceptadas; no procesos internos de Git, hooks no Node, hijos sin precarga ni CPU de procesos desligados' }
    // Se conserva la procedencia antes de la primera muestra, sin tocar el producto.
    putJson(join(output, 'baseline.json'), { base_commit: base, runtime: manifest.runtime, env: manifest.env })
    for (const scenario of ['verify', 'commit']) {
      let validRounds = 0
      for (let attempt = 0; attempt < 2 * pairs && validRounds < pairs; attempt++) {
        const round = validRounds
        const versions = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
        const conditions = round % 2 === 0 ? [false, true] : [true, false]
        const staged = []
        try {
          let order = 0
          for (const version of versions) for (const instrumented of conditions) {
            const id = `${scenario}-${attempt}-${version}-${instrumented ? 'trace' : 'plain'}`
            const sample = await measureSample({ binRoot: version === 'baseline' ? baseline.root : candidate.root, scenario, instrumented, directory: output, reportDir, id })
            if (manifest.fixture_sha === null) manifest.fixture_sha = sample.fixture_sha
            if (sample.fixture_sha !== manifest.fixture_sha) throw new Error('SHA de fixture distinto')
            staged.push({ id, scenario, version, instrumented, round, attempt, order: order++, valid: true,
              version_pair: `${scenario}:${round}:${instrumented}`, overhead_pair: `${scenario}:${round}:${version}`, ...sample })
          }
          manifest.samples.push(...staged)
          validRounds++
        } catch (error) {
          if (interrupted) throw interrupted
          manifest.exclusions.push({ scenario, attempt, round, reason: error.message, evidence: error.evidence ?? null, samples: staged })
        }
        putJson(join(output, 'manifest.json'), manifest)
      }
      if (validRounds < pairs) throw new Error(`${scenario}: no se alcanzaron ${pairs} pares válidos en ${2 * pairs} intentos`)
    }
    const report = compare(manifest)
    putJson(reportFile, report)
    return report
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, ...args] = process.argv.slice(2)
    const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
    if (command !== 'run' || !option('--base') || !option('--output')) throw new Error('uso: run --base <SHA> --candidate-root <raíz> --pairs 3 --output <directorio> [--report <archivo>]')
    await runBenchmark({ base: option('--base'), candidateRoot: resolve(option('--candidate-root') ?? sourceRoot), pairs: Number(option('--pairs') ?? 3),
      output: resolve(option('--output')), ...(option('--report') ? { report: resolve(option('--report')) } : {}) })
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
