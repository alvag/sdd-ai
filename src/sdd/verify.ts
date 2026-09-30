import { execFileSync, spawn } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { ATTEST_OPTIONS, attestQuestion } from '../approval/question.ts'
import { type Proof, prove } from '../approval/proof.ts'
import { type CandidateFingerprint, candidateFingerprint, dirtyPaths, harvestTreeWithout } from '../git.ts'
import { Rejection } from '../review/admit.ts'
import { killGroup } from '../supervisor.ts'
import { type Family, SddError } from '../types.ts'
import { canWriteStore, controlUnavailable, flowWriterOpen, latestFlowHarvest, recordVerifyGroup, releaseWriter, reserveWriter } from '../writer-store.ts'
import { isFlowId } from './id.ts'
import { criteriaIds, replaceSection, setHeaderStatus } from './markdown.ts'
import { localIso } from './phase.ts'
import { appendAttestationRef, appendReceiptRef, implementOf, readPhaseRecord, withFlowLock } from './phase-state.ts'
import { APPROVALS_FILE, FILE_NAMES, flowDir, readFlow } from './read.ts'
import { headerData, resolve } from './status.ts'
import { type ExecutableRow, type ManualRow, type TestRow, type VerificationContract, readVerification } from './verification-contract.ts'
import {
  type AttestationRef, type RowConfirmation, type RowExecution, type RowOutcome, type RowResult, type VerifyReceipt, type VerifyReceiptRef,
  canWriteVerifyStore, currentAttestation, fileSha256, newReceiptId, readVerifyReceipt, receiptDir, writeAttestation, writeVerifyReceipt,
} from './verify-receipt.ts'
import { closeRestoreIntent, inspectRevertPaths, prepareIntent, restorePaths, revertPaths, writeRestoreIntent } from './restore.ts'
import { PLAN_GATE } from './verify-state.ts'

// La ejecución de `sdd verify`: correr cada fila del contrato como argv literal, sin shell, con su
// tope de tiempo y en un grupo de procesos propio, y leer su resultado. El reporte de una fila `test` se
// lee en TAP, el único formato admitido.

/**
 * Una entrada del TAP de `node --test`: su nombre, si pasó, su nivel, el `failureType` de su bloque YAML y,
 * si ese bloque dice `type: 'suite'`, que es una suite y no un test.
 */
export interface TapEntry { name: string; ok: boolean; depth: number; failureType?: string; suite?: true }

const ENTRY = /^( *)(not ok|ok) \d+(?: - (.*?))?(?: # (SKIP|TODO)\b.*)?$/
const YAML_OPEN = /^( *)---$/
const YAML_CLOSE = /^( *)\.\.\.$/
const FAILURE_TYPE = /^ *failureType: *'?([A-Za-z]+)'?$/
const SUITE_TYPE = /^ *type: *'?suite'?$/

/** El nombre de una entrada sin los escapes de TAP (`\#`, `\\`). */
const unescape = (name: string) => name.replace(/\\(.)/g, '$1')

/**
 * Las entradas `ok` y `not ok` de un TAP, en cualquier nivel. Una entrada con directiva SKIP o TODO no
 * cuenta: no se ejecutó. El bloque YAML va dos espacios más adentro que su entrada y se asigna a la
 * anterior de esa indentación, nunca a la de un subtest o una suite.
 */
export function parseTap(stdout: string): TapEntry[] {
  const out: TapEntry[] = []
  const lines = stdout.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const open = YAML_OPEN.exec(lines[i])
    if (open) {
      const indent = open[1].length
      let failureType: string | undefined
      let suite = false
      for (i++; i < lines.length; i++) {
        const close = YAML_CLOSE.exec(lines[i])
        if (close && close[1].length === indent) break
        const m = FAILURE_TYPE.exec(lines[i])
        if (m) failureType = m[1]
        if (SUITE_TYPE.test(lines[i])) suite = true
      }
      const owner = [...out].reverse().find((e) => e.depth * 4 === indent - 2)
      if (owner && failureType !== undefined) owner.failureType = failureType
      if (owner && suite) owner.suite = true
      continue
    }
    const m = ENTRY.exec(lines[i])
    if (!m || m[4] !== undefined) continue
    out.push({ name: unescape(m[3] ?? ''), ok: m[2] === 'ok', depth: m[1].length / 4 })
  }
  return out
}

/**
 * Las entradas del test nombrado; más de una es un nombre ambiguo. No cuentan aunque coincidan una entrada
 * cuyo nombre es la ruta de un archivo de prueba de la fila, que es como `node --test` informa un error de
 * carga, ni una suite: sus pruebas internas pueden pasar sin que el test nombrado exista.
 */
const named = (stdout: string, row: TestRow) => parseTap(stdout).filter((e) => e.name === row.test_name && !e.suite
  && !row.test_paths.some((p) => e.name === p || e.name.endsWith(`/${p}`)))

/**
 * El resultado de una fila ejecutable. `unavailable` si no se pudo lanzar o venció su tope; `unrun` si
 * se interrumpió antes. Si no, `passed` solo con el código de salida esperado, el patrón (si lo hay) en
 * stdout seguido de stderr y, en una fila `test`, exactamente una entrada del test nombrado y en `ok`: la
 * entrada con la ruta del archivo, que es como `node --test` informa un error de carga, no cuenta. Una fila
 * sin patrón que no es `test` no lee su salida, así que el tope de lectura no la afecta.
 */
export function evaluateRow(row: ExecutableRow, execution: RowExecution, output: { stdout: string; stderr: string } | null): RowOutcome {
  if (execution.reason === 'timeout' || execution.reason === 'launch_failed') return 'unavailable'
  if (execution.reason === 'interrupted') return 'unrun'
  if (execution.exit_code !== row.expect.exit_code) return 'failed'
  if (row.expect.output_pattern === undefined && row.kind !== 'test') return 'passed'
  // Una salida demasiado grande para leerla entera no se puede evaluar: no cuenta como verde.
  if (output === null) return 'failed'
  if (row.expect.output_pattern !== undefined && !patternMatches(row.expect.output_pattern, output.stdout + output.stderr)) return 'failed'
  if (row.kind === 'test') {
    const entries = named(output.stdout, row)
    if (entries.length !== 1 || !entries[0].ok) return 'failed'
  }
  return 'passed'
}

const PATTERN_TIMEOUT_MS = 2000

/**
 * Si el patrón aparece en la salida. Se evalúa en un contexto aparte con tope de tiempo: un patrón con
 * retroceso catastrófico no puede colgar a verify ni dejar la reserva tomada. Vencido el tope, no coincide.
 */
export function patternMatches(pattern: string, text: string): boolean {
  try {
    return runInNewContext('new RegExp(pattern).test(text)', { pattern, text }, { timeout: PATTERN_TIMEOUT_MS }) === true
  } catch {
    return false
  }
}

/**
 * Qué dice la corrida con las rutas de implementación en la base. En `red_on_revert` confirma una única
 * entrada `not ok` del test nombrado con `failureType: testCodeFailure`, sea una aserción o un error del
 * código dentro del test; en `green_on_base`, una única entrada `ok`. Con la entrada contraria refuta; sin
 * ella, repetida o sin ejecución, no se puede confirmar.
 */
export function confirmationOutcome(row: TestRow, execution: RowExecution, stdout: string | null): 'confirmed' | 'refuted' | 'not_confirmable' {
  if (execution.reason !== undefined || stdout === null) return 'not_confirmable'
  const entries = named(stdout, row)
  if (entries.length !== 1) return 'not_confirmable'
  const [e] = entries
  if (row.obligation === 'green_on_base') return e.ok ? 'confirmed' : 'refuted'
  if (e.ok) return 'refuted'
  return e.failureType === 'testCodeFailure' ? 'confirmed' : 'not_confirmable'
}

const MAX_EXCERPT = 200
/** Los caracteres de control y de formato se reemplazan: un U+202E invertiría lo que se lee. */
const UNSAFE = /[\p{Cc}\p{Cf}]/gu

/** `exit N; <última línea no vacía de stdout seguido de stderr>`, saneada y de hasta 200 caracteres. */
export function excerpt(exitCode: number | null, stdout: string, stderr: string, reason?: string): string {
  if (exitCode === null) return `exit -; ${reason ?? 'sin código'}`.slice(0, MAX_EXCERPT)
  const last = `${stdout}\n${stderr}`.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? 'sin salida'
  return `exit ${exitCode}; ${last.replace(UNSAFE, '?')}`.slice(0, MAX_EXCERPT)
}

const KILL_GRACE_MS = 2000
/** Cuánto se espera a que el grupo de una fila termine después del SIGKILL, antes de cerrarla igual. */
const GROUP_EXIT_MS = 2000
const now = () => new Date().toISOString()
/** Lo más que se lee de una salida para evaluarla; lo demás queda en el archivo y en su sha256. */
const MAX_EVAL_BYTES = 32 * 1024 * 1024
/** El final de cada salida del que sale el extracto. */
const TAIL_BYTES = 64 * 1024

/** La salida entera si cabe en `MAX_EVAL_BYTES`, o `null` si no: una salida enorme no se carga en memoria. */
function readForEval(dir: string, file: string): string | null {
  const path = join(dir, file)
  return statSync(path).size > MAX_EVAL_BYTES ? null : readFileSync(path, 'utf8')
}

/** Los últimos `TAIL_BYTES` de una salida, sin leer el resto. */
function readTail(dir: string, file: string): string {
  const fd = openSync(join(dir, file), 'r')
  try {
    const size = fstatSync(fd).size
    const n = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** La salida de una fila para evaluarla, o `null` si alguna de las dos no cabe. */
function outputOf(dir: string, e: RowExecution): { stdout: string; stderr: string } | null {
  const stdout = readForEval(dir, e.stdout_file)
  const stderr = readForEval(dir, e.stderr_file)
  return stdout === null || stderr === null ? null : { stdout, stderr }
}

/**
 * El entorno de una fila: el del conductor, sin NODE_TEST_CONTEXT. Con esa variable heredada, un
 * `node --test` le reporta a un proceso de pruebas padre en vez de escribir el TAP que la fila lee.
 */
function rowEnv(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env
  return env
}

/**
 * Corre una fila con su argv literal (`shell: false`), desde la raíz del checkout y en un grupo de
 * procesos propio. stdout y stderr se vuelcan a archivos del directorio del recibo mientras corre. Al
 * vencer el tope o con `signal` abortada, termina el grupo: SIGTERM y, si sigue, SIGKILL.
 */
/** Espera a que el grupo `pgid` no tenga procesos, con un tope: SIGKILL se entrega, pero no al instante. */
async function groupGone(pgid: number): Promise<void> {
  const deadline = Date.now() + GROUP_EXIT_MS
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function executeRow(root: string, runDir: string, row: ExecutableRow, signal: AbortSignal, prefix: string, holder: string | undefined): Promise<RowExecution> {
  const stdout_file = `${prefix}stdout-${row.id}.log`
  const stderr_file = `${prefix}stderr-${row.id}.log`
  const base = { row: row.id, argv: row.argv, stdout_file, stderr_file }
  const out = openSync(join(runDir, stdout_file), 'w')
  const err = openSync(join(runDir, stderr_file), 'w')
  const started_at = now()
  const finish = (r: { exit_code: number | null; reason?: RowExecution['reason']; launch_error?: string }): RowExecution => {
    closeSync(out)
    closeSync(err)
    const [so, se] = [readTail(runDir, stdout_file), readTail(runDir, stderr_file)]
    const reasonText = r.reason === 'timeout' ? 'timeout' : r.reason === 'interrupted' ? 'interrumpida'
      : r.reason === 'launch_failed' ? `no se pudo lanzar: ${r.launch_error ?? 'error'}` : undefined
    return {
      ...base, started_at, ended_at: now(), exit_code: r.exit_code, ...(r.reason ? { reason: r.reason } : {}),
      ...(r.launch_error ? { launch_error: r.launch_error } : {}),
      stdout_sha256: fileSha256(join(runDir, stdout_file)), stderr_sha256: fileSha256(join(runDir, stderr_file)),
      excerpt: excerpt(r.exit_code, so, se, reasonText),
    }
  }
  if (signal.aborted) return finish({ exit_code: null, reason: 'interrupted' })
  return await new Promise<RowExecution>((settle) => {
    let reason: RowExecution['reason']
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(row.argv[0], row.argv.slice(1), { cwd: root, shell: false, detached: true, stdio: ['ignore', out, err], env: rowEnv() })
    } catch (e) {
      settle(finish({ exit_code: null, reason: 'launch_failed', launch_error: (e as NodeJS.ErrnoException).code ?? (e as Error).message }))
      return
    }
    if (holder !== undefined && child.pid !== undefined) recordVerifyGroup(root, holder, child.pid)
    const stop = (why: RowExecution['reason']) => {
      if (reason !== undefined || child.pid === undefined) return
      reason = why
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => child.pid !== undefined && killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref()
    }
    const timer = setTimeout(() => stop('timeout'), row.timeout_ms)
    const onAbort = () => stop('interrupted')
    signal.addEventListener('abort', onAbort, { once: true })
    let settled = false
    // Un comando que no arranca emite `error` y después `close`: se cierra una sola vez.
    const done = (r: Parameters<typeof finish>[0]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      // Lo que el comando dejó corriendo en su grupo no sigue después de la fila: la fila se cierra, y sus
      // salidas se leen, recién cuando el grupo terminó.
      const pgid = child.pid
      if (pgid === undefined) {
        settle(finish(r))
        return
      }
      killGroup(pgid, 'SIGKILL')
      void groupGone(pgid).then(() => {
        if (holder !== undefined) recordVerifyGroup(root, holder, null)
        settle(finish(r))
      })
    }
    child.once('error', (e: NodeJS.ErrnoException) => done({ exit_code: null, reason: 'launch_failed', launch_error: e.code ?? e.message }))
    child.once('close', (code) => done(reason ? { exit_code: null, reason } : { exit_code: code }))
  })
}

/**
 * Corre las filas en orden. Un fallo no detiene las demás; con `signal` abortada, la fila en curso termina
 * su grupo y las siguientes quedan `interrupted` sin ejecutarse. Las filas `manual` no llegan acá. Con
 * `holder`, el id de la reserva de verify, cada fila anota su grupo en la reserva mientras corre.
 */
export async function executeRows(root: string, runDir: string, rows: readonly ExecutableRow[], signal: AbortSignal, prefix = '', holder?: string): Promise<RowExecution[]> {
  mkdirSync(runDir, { recursive: true })
  const out: RowExecution[] = []
  for (const row of rows) out.push(await executeRow(root, runDir, row, signal, prefix, holder))
  return out
}

/** Lo que una corrida de verify leyó al arrancar, bajo el lock del flujo, y el id de su recibo. */
export interface VerifyStart {
  root: string; flow: string; mode: 'final' | 'baseline'; receiptId: string; runDir: string; baseCommit: string
  planFingerprint: string; contract: VerificationContract; specAcs: string[]
  refs: { receipts: VerifyReceiptRef[]; attestations: AttestationRef[] }
}

/** Los pasos desde los que arranca cada modo: la corrida final con la implementación terminada, la base antes del writer. */
const STEPS: Record<VerifyStart['mode'], readonly string[]> = { final: ['verify', 'review_and_commit'], baseline: ['implement'] }

/**
 * Las precondiciones de una corrida, en orden y sin escribir nada hasta pasarlas: el almacén se puede
 * escribir; bajo el lock del flujo, el paso admite el modo, el gate que cubre el plan tiene una aprobación
 * registrada con la huella de hoy, el flujo no tiene bloqueos, ningún writer del flujo sigue abierto y el
 * contrato es estructurado y se admite contra los criterios de la spec. Recién entonces genera el id del
 * recibo y toma la reserva de writer con él.
 */
export function prepareVerify(root: string, flow: string, mode: VerifyStart['mode'], o: { guard?: TreeGuard } = {}): VerifyStart {
  if (!canWriteStore(root) || !canWriteVerifyStore(root)) throw controlUnavailable()
  const read = withFlowLock(root, flow, () => verifyPreconditions(root, flow, mode, o.guard))
  const receiptId = newReceiptId()
  const reserved = reserveWriter(root, receiptId, 'verify')
  if (!reserved.ok) throw new SddError('writer_open', `ya hay un writer abierto en este repositorio: ${reserved.holder}`, { next: 'espera a que termine y vuelve a correr sdd verify' })
  // Entre la comprobación del árbol y la reserva nadie más lanza un writer, pero el conductor puede editar.
  if (mode === 'final' && o.guard) {
    try {
      o.guard('reserved', read.baseCommit)
    } catch (e) {
      releaseWriter(root, receiptId)
      throw e
    }
  }
  return { root, flow, mode, receiptId, runDir: receiptDir(root, receiptId), ...read }
}

/**
 * La guarda del árbol de una corrida final con writers de fase: bajo el lock, antes de ejecutar nada,
 * exige que el árbol sea el del último eslabón de la cadena o registra la toma; con la reserva tomada,
 * vuelve a comparar. Lanza para negarse.
 */
export type TreeGuard = (when: 'locked' | 'reserved', base: string) => void

/** Lo que `prepareVerify` comprueba y lee del flujo. Va dentro de `withFlowLock`. */
type Preconditions = Omit<VerifyStart, 'root' | 'flow' | 'mode' | 'receiptId' | 'runDir'>

function verifyPreconditions(root: string, flow: string, mode: VerifyStart['mode'], guard?: TreeGuard): Preconditions {
  const { facts } = readFlow(root, flow)
  const status = resolve(facts)
  if (status.blocked_reasons.length > 0) {
    throw new SddError('flow_blocked', `el flujo ${flow} tiene bloqueos: ${status.blocked_reasons.map((r) => r.code).join(', ')}`, { next: `./bin/sdd-ai sdd status ${flow}` })
  }
  if (!STEPS[mode].includes(status.next.step)) {
    throw new SddError('verify_not_now', `sdd verify${mode === 'baseline' ? ' --baseline' : ''} no corre en el paso ${status.next.step} del flujo ${flow}`, {
      detail: mode === 'baseline' ? 'la medición sobre la base va antes del primer writer, en el paso implement' : 'la verificación final va con todas las tasks hechas, en el paso verify o review_and_commit',
      next: `./bin/sdd-ai sdd status ${flow}`,
    })
  }
  const gate = status.depth === null ? undefined : PLAN_GATE[status.depth]
  const view = status.gates.find((g) => g.gate === gate)
  const fingerprint = gate === undefined ? undefined : facts.fingerprints[gate]
  if (view?.state !== 'approved' || fingerprint === undefined) {
    throw new SddError('plan_not_approved', `el gate ${gate ?? 'del plan'} no tiene una aprobación registrada vigente: sdd verify no ejecuta un contrato sin aprobar`, {
      detail: view?.state === 'approved_unfingerprinted' ? 'el header lo da por aprobado, pero sin sdd approve no hay huella que compare cambios en los comandos' : undefined,
      next: `./bin/sdd-ai sdd status ${flow}`,
    })
  }
  const open = flowWriterOpen(root, flow)
  if (open) throw new SddError('writer_open', `el writer ${open} del flujo sigue abierto`, { next: `./bin/sdd-ai wait ${open}` })
  const dir = flowDir(root, flow)
  const plan = readFileSync(join(dir, FILE_NAMES.plan), 'utf8')
  const spec = facts.files.spec === 'present' ? readFileSync(join(dir, FILE_NAMES.spec), 'utf8') : plan
  const specAcs = criteriaIds(spec)
  let contract: VerificationContract
  try {
    const v = readVerification(plan, specAcs)
    if (v.kind === 'prose') {
      throw new SddError('contract_prose', `el plan de ${flow} tiene el contrato de verificación en prosa: sdd verify no lo ejecuta`, {
        next: `republica el plan con sdd phase ${flow} para que el contrato sea estructurado`,
      })
    }
    contract = v.contract
  } catch (e) {
    if (e instanceof Rejection) throw new SddError('contract_invalid', `el contrato de verificación del plan no se admite: ${e.message}`, { next: 'corrige el bloque de ## Verification y reaprueba el plan' })
    throw e
  }
  const baseCommit = headerData(facts.planHeader)?.base_commit
  if (typeof baseCommit !== 'string' || baseCommit === '') throw new SddError('plan_invalid', 'plan.md no declara base_commit')
  if (mode === 'final' && guard) guard('locked', baseCommit)
  const rec = readPhaseRecord(root, flow)
  return { baseCommit, planFingerprint: fingerprint, contract, specAcs, refs: rec.verify ?? { receipts: [], attestations: [] } }
}

/** Corre `fn` con la reserva de la corrida y la libera al terminar, también si falla o se interrumpe. */
export async function withVerifyReservation<T>(start: VerifyStart, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } finally {
    releaseWriter(start.root, start.receiptId)
  }
}

const REFUTED: Record<'red_on_revert' | 'green_on_base', string> = {
  red_on_revert: 'con las rutas de implementación en la base, el test siguió pasando',
  green_on_base: 'con las rutas de implementación en la base, el test falló',
}

/** Un fallo de enlace de Node: quién importa, qué módulo y, si lo dice el error, qué export falta. */
interface LoadFailure { importer: string; module: string; exportName?: string }

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const MISSING_EXPORT = /^SyntaxError: The requested module '([^']+)' does not provide an export named '([^']+)'/
// El importador va hasta el final de la línea, porque su ruta puede tener espacios, sin la comilla con
// que el reporte TAP puede cerrar el error.
const MISSING_MODULE = /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module '([^']+)' imported from (.+?)['"]?\s*$/
const FILE_LINE = /^file:\/\/\S+?:\d+$/

/** La ruta relativa al repositorio, o `null` si `abs` cae fuera de él. */
function repoPath(root: string, abs: string): string | null {
  if (!isAbsolute(abs)) return null
  let real = root
  try {
    real = realpathSync(root)
  } catch {
    // Sin ruta real, se compara solo con la ruta dada.
  }
  for (const base of new Set([root, real])) {
    const rel = relative(base, abs)
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join('/')
  }
  return null
}

/**
 * Los fallos de enlace de Node que trae una salida, con rutas relativas si caen en el repositorio: sin
 * ANSI ni el prefijo `# ` con que el reporte TAP cita el stderr de un proceso. El importador de un export
 * ausente es la última línea `file://…:<n>` anterior al mensaje, desde el diagnóstico anterior: sin
 * un marcador propio, el diagnóstico no cuenta.
 */
function loadFailures(root: string, text: string): LoadFailure[] {
  const out: LoadFailure[] = []
  let file: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').replace(/^\s*(?:# )?/, '')
    if (FILE_LINE.test(line)) {
      try {
        file = fileURLToPath(line.replace(/:\d+$/, ''))
      } catch {
        file = null
      }
      continue
    }
    const noExport = MISSING_EXPORT.exec(line)
    if (noExport) {
      const importerFile = file
      file = null
      if (importerFile === null) continue
      const importer = repoPath(root, importerFile)
      const absolute = resolvePath(dirname(importerFile), noExport[1])
      const module = repoPath(root, absolute) ?? absolute
      if (importer) out.push({ importer, module, exportName: noExport[2] })
      continue
    }
    const missing = MISSING_MODULE.exec(line)
    if (missing) {
      file = null
      const importer = repoPath(root, missing[2])
      const module = repoPath(root, missing[1]) ?? missing[1]
      if (importer) out.push({ importer, module })
    }
  }
  return out
}

/**
 * Solo el error propagado de un subproceso del test nombrado, no sus comentarios ni los valores de una
 * aserción. Node pone ese error en el bloque YAML de la entrada: `Command failed: …` con su stderr.
 */
function namedLoadOutput(stdout: string, row: TestRow): string | null {
  const lines = stdout.replace(ANSI, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const entry = ENTRY.exec(lines[i])
    if (!entry || entry[2] !== 'not ok' || unescape(entry[3] ?? '') !== row.test_name || entry[4]) continue
    const indent = entry[1].length + 2
    for (i++; i < lines.length; i++) {
      if (lines[i] === `${' '.repeat(indent)}...`) break
      if (lines[i] !== `${' '.repeat(indent)}error: |-` && lines[i] !== `${' '.repeat(indent)}error: |`) continue
      const prefix = ' '.repeat(indent + 2)
      const error: string[] = []
      for (i++; i < lines.length && lines[i].startsWith(prefix); i++) error.push(lines[i].slice(prefix.length))
      return error[0]?.startsWith('Command failed:') ? error.join('\n') : null
    }
  }
  return null
}

const failureKey = (f: LoadFailure) => `${f.importer}\0${f.module}\0${f.exportName ?? ''}`

/**
 * Si la corrida con las rutas revertidas no cargó por un conjunto incoherente del contrato: el diagnóstico
 * de enlace involucra una ruta revertida, no aparece en la ejecución del candidato y la fila falló por él
 * (su archivo de prueba en `not ok` sin el test nombrado, o el test nombrado en `not ok` con el diagnóstico
 * en el error propagado del subproceso). Devuelve el motivo, o `null` si la salida no lo demuestra.
 */
function contractIncoherence(start: VerifyStart, row: TestRow, candidate: RowExecution, execution: RowExecution): string | null {
  const read = (e: RowExecution) => {
    const stdout = readForEval(start.runDir, e.stdout_file)
    const stderr = readForEval(start.runDir, e.stderr_file)
    return stdout === null || stderr === null ? null : { stdout, stderr }
  }
  const reverted = read(execution)
  const green = read(candidate)
  if (!reverted || !green) return null
  const inImpl = (p: string) => row.implementation_paths.includes(p)
  const inTest = (p: string) => row.test_paths.includes(p)
    || /(?:^|\/)(?:tests?|__tests__)\//.test(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p)
  const seen = new Set([green.stdout, green.stderr].flatMap((text) => loadFailures(start.root, text)).map(failureKey))
  const entries = parseTap(reverted.stdout)
  const fileFailed = entries.some((e) => !e.ok && !e.suite && row.test_paths.some((p) => e.name === p || e.name.endsWith(`/${p}`)))
  const test = named(reverted.stdout, row)
  const output = test.length === 0 && fileFailed ? [reverted.stdout, reverted.stderr]
    : test.length === 1 && !test[0].ok ? namedLoadOutput(reverted.stdout, row) : null
  if (output === null) return null
  const failures = (Array.isArray(output) ? output : [output]).flatMap((text) => loadFailures(start.root, text))
    .filter((f) => !seen.has(failureKey(f)) && (inImpl(f.importer) || inImpl(f.module)) && !(inImpl(f.importer) && inImpl(f.module)))
  if (failures.length === 0) return null

  const [first] = failures
  const routes = new Set<string>()
  let limit = ''
  for (const f of failures) {
    const candidatePath = inImpl(f.importer) ? f.module : f.importer
    if (inTest(f.importer)) limit = `el importador ${f.importer} es una prueba`
    else if (isAbsolute(f.module)) limit = `el módulo ${f.module} está fuera del repositorio`
    else if (inTest(candidatePath)) limit = `el módulo ${candidatePath} es una prueba`
    else routes.add(candidatePath)
  }
  let route: string | undefined
  if (routes.size === 1 && limit === '') {
    const [candidatePath] = routes
    const admitted = inspectRevertPaths(start.root, start.baseCommit, { ...row, implementation_paths: [candidatePath] })
    if (admitted.eligible) route = candidatePath
    else limit = `${candidatePath} no es admisible como ruta de implementación: ${admitted.reason}`
  } else if (limit === '') {
    limit = 'no hay una única ruta candidata'
  }
  const what = first.exportName === undefined
    ? `${first.importer} importa ${first.module}, que no existe`
    : `${first.importer} importa «${first.exportName}» de ${first.module}, que no lo exporta`
  const fix = route ? `falta ${route} en implementation_paths` : `no se puede determinar la ruta que falta (${limit})`
  return `con las rutas de implementación en la base el test no carga: ${what}; ${fix}; es un defecto del contrato, clase contract`
}

/**
 * Confirma una fila con obligación: guarda los dos contenidos de sus rutas de implementación, escribe la
 * intención, las devuelve a la base, corre la fila con el prefijo `confirm-` y las restaura, también si la
 * fila falla o se interrumpe. La intención se cierra solo después de restaurar: si algo corta en el medio,
 * la resuelve el verbo siguiente. Al final la huella tiene que volver a ser `original`.
 */
export async function confirmRow(start: VerifyStart, row: TestRow, original: CandidateFingerprint, signal: AbortSignal, candidate: RowExecution): Promise<RowConfirmation> {
  const head = { row: row.id, obligation: row.obligation }
  if (row.obligation === 'none') return { ...head, state: 'not_required', restored: true }
  const eligible = inspectRevertPaths(start.root, start.baseCommit, row)
  if (!eligible.eligible) return { ...head, state: 'not_confirmable', reason: eligible.reason, restored: true }
  const intent = prepareIntent(start.root, start.receiptId, start.baseCommit, row.implementation_paths)
  writeRestoreIntent(start.root, intent)
  let changed: string[] = []
  let execution: RowExecution | undefined
  try {
    changed = revertPaths(start.root, intent)
    if (changed.length === 0) [execution] = await executeRows(start.root, start.runDir, [row], signal, 'confirm-', start.receiptId)
  } finally {
    // Con rutas cambiadas, el revert no tocó ninguna y no hay nada que restaurar.
    if (changed.length === 0) restorePaths(start.root, intent)
  }
  closeRestoreIntent(start.root)
  if (execution === undefined) {
    return { ...head, state: 'not_confirmable', reason: `${changed.join(', ')} cambió después de guardar su contenido, así que no se revirtió`, restored: true }
  }
  const restored = candidateFingerprint(start.root, start.flow, start.baseCommit).tree === original.tree
  const incoherent = execution.reason === undefined ? contractIncoherence(start, row, candidate, execution) : null
  if (incoherent !== null) return { ...head, state: 'contract_incoherent', reason: incoherent, restored, execution }
  const state = confirmationOutcome(row, execution, readForEval(start.runDir, execution.stdout_file))
  const reason = state === 'refuted' ? REFUTED[row.obligation]
    : state === 'not_confirmable' ? `el reporte no muestra una única entrada del test «${row.test_name}» con el resultado que confirma (${execution.excerpt})` : undefined
  return { ...head, state, ...(reason ? { reason } : {}), restored, execution }
}

/** El flujo y lo que una persona acredita: la fila `manual` de `rowId` y las huellas de ahora. */
interface AttestTarget { root: string; flow: string; row: ManualRow; candidate: CandidateFingerprint; planFingerprint: string }

/**
 * Acredita una fila `manual`: solo en los pasos `verify` o `review_and_commit`, con el gate del plan
 * vigente y un contrato estructurado, y solo para una fila que existe y es `manual`. Exige la respuesta
 * del usuario a la pregunta canónica de esa fila, que no puede haber autorizado otra decisión: bajo el lock
 * del flujo se reúnen las respuestas de las aprobaciones y de las acreditaciones. No toma la reserva ni
 * ejecuta nada.
 */
export function attestRow(root: string, flow: string, rowId: string, env: Record<string, string | undefined>, conductor?: Family): AttestationRef {
  if (!canWriteVerifyStore(root)) throw controlUnavailable()
  return withFlowLock(root, flow, () => {
    const start = verifyPreconditions(root, flow, 'final')
    const row = start.contract.rows.find((r) => r.id === rowId)
    if (!row) throw new SddError('usage', `el contrato no tiene la fila ${rowId}`, { next: `las filas son ${start.contract.rows.map((r) => r.id).join(', ')}` })
    if (row.kind !== 'manual') throw new SddError('usage', `la fila ${rowId} es ${row.kind}, no manual: la acredita su ejecución`)
    const target: AttestTarget = { root, flow, row, candidate: candidateFingerprint(root, flow, start.baseCommit), planFingerprint: start.planFingerprint }
    const q = attestQuestion(flow, target.row.id, target.row.observation, target.candidate, target.planFingerprint)
    const rec = readPhaseRecord(root, flow)
    const consumed = new Set([...approvalRefs(root, flow), ...(rec.verify?.attestations ?? []).map((a) => a.proof_ref)])
    const proof: Proof = prove({ env, conductor, q, authorizes: ATTEST_OPTIONS.attest, consumed })
    const ref = writeAttestation(root, {
      id: newReceiptId(), flow, row: target.row.id, observation: target.row.observation, candidate: target.candidate,
      plan_fingerprint: target.planFingerprint, answered_at: proof.answered_at, proof_ref: proof.ref,
    })
    appendAttestationRef(root, flow, ref)
    return ref
  })
}

/** Las respuestas que ya consumieron las aprobaciones del flujo. */
function approvalRefs(root: string, flow: string): string[] {
  try {
    const log = JSON.parse(readFileSync(join(flowDir(root, flow), APPROVALS_FILE), 'utf8')) as { approvals?: Array<{ proof?: { ref?: string } }> }
    return (log.approvals ?? []).flatMap((a) => (a.proof?.ref ? [a.proof.ref] : []))
  } catch {
    return []
  }
}

/** Las filas ejecutables y las manuales del contrato, separadas. */
const split = (c: VerificationContract) => ({
  executable: c.rows.filter((r): r is ExecutableRow => r.kind !== 'manual'),
  manual: c.rows.filter((r): r is ManualRow => r.kind === 'manual'),
})

/** Lo que registra una fila `manual`, que no ejecuta nada: sus tiempos, sin código de salida y salidas vacías. */
function manualExecution(runDir: string, row: string): RowExecution {
  mkdirSync(runDir, { recursive: true })
  const at = now()
  const [stdout_file, stderr_file] = [`stdout-${row}.log`, `stderr-${row}.log`]
  writeFileSync(join(runDir, stdout_file), '')
  writeFileSync(join(runDir, stderr_file), '')
  return {
    row, started_at: at, ended_at: at, argv: [], exit_code: null, reason: 'manual', stdout_file, stderr_file,
    stdout_sha256: fileSha256(join(runDir, stdout_file)), stderr_sha256: fileSha256(join(runDir, stderr_file)), excerpt: 'exit -; manual',
  }
}

const coverageOf = (c: VerificationContract, acs: readonly string[]) =>
  Object.fromEntries(acs.map((ac) => [ac, c.rows.filter((r) => r.acs.includes(ac)).map((r) => r.id)]))

/**
 * Mide la base: con el candidato igual a la base, corre las filas ejecutables cuyo ejecutable se resuelve
 * y cuyos archivos declarados existen, sin revertir nada. Publica un recibo `baseline`, que nunca cuenta
 * para `verified`, y no toca `plan.md`. Si una fila escribió en el árbol, el recibo lista las rutas.
 */
export async function runBaseline(start: VerifyStart, signal: AbortSignal): Promise<{ receipt: VerifyReceipt; ref: VerifyReceiptRef }> {
  return await withVerifyReservation(start, async () => {
    const started_at = new Date().toISOString()
    const before = candidateFingerprint(start.root, start.flow, start.baseCommit)
    if (before.tree !== before.base_tree) {
      throw new SddError('baseline_not_clean', 'la medición sobre la base necesita el árbol igual a la base: hay cambios fuera del flujo', {
        next: 'corre sdd verify --baseline antes del primer writer, con el árbol limpio',
      })
    }
    const { executable } = split(start.contract)
    const measurable = executable.filter((r) => measurableAtBase(start.root, start.baseCommit, r))
    const executions = await executeRows(start.root, start.runDir, measurable, signal, '', start.receiptId)
    const byRow = new Map(executions.map((e) => [e.row, e]))
    const rows: RowResult[] = start.contract.rows.map((r) => {
      const e = byRow.get(r.id)
      if (!e || r.kind === 'manual') return { row: r.id, outcome: 'unrun', baseline: 'not_measurable' }
      const outcome = evaluateRow(r, e, outputOf(start.runDir, e))
      return { row: r.id, outcome, execution: e, baseline: outcome === 'passed' || outcome === 'failed' ? outcome : 'not_measurable' }
    })
    const after = candidateFingerprint(start.root, start.flow, start.baseCommit)
    const receipt: VerifyReceipt = {
      id: start.receiptId, flow: start.flow, mode: 'baseline', started_at, ended_at: new Date().toISOString(), before, after,
      plan_fingerprint: start.planFingerprint, coverage: coverageOf(start.contract, start.specAcs), rows,
      ...(after.tree !== before.tree ? { dirtied_paths: dirtiedPaths(start.root, start.flow) } : {}), green: false,
    }
    const ref = writeVerifyReceipt(start.root, receipt)
    appendReceiptRef(start.root, start.flow, ref)
    return { receipt, ref }
  })
}

/**
 * Si el ejecutable de la fila se resuelve y sus archivos declarados existen en el commit base: un test que
 * todavía no existe, o que solo existe como archivo ignorado, no se mide.
 */
function measurableAtBase(root: string, base: string, row: ExecutableRow): boolean {
  const files = row.kind === 'test' ? [...row.implementation_paths, ...row.test_paths] : []
  const inBase = (p: string) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${base}:${p}`], { cwd: root, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  const isFile = (path: string) => {
    try {
      return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }
  const exe = row.argv[0]
  const resolvable = exe.includes('/') ? isFile(isAbsolute(exe) ? exe : join(root, exe))
    : (process.env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && isFile(join(dir, exe)))
  return resolvable && files.every(inBase)
}

/** Las rutas con cambios respecto de `HEAD` fuera del directorio del flujo, para decir qué limpiar después de una medición. */
function dirtiedPaths(root: string, flow: string): string[] {
  return dirtyPaths(root).filter((p) => !p.startsWith(`.plans/${flow}/`))
}

/** Qué pasó con la proyección de una corrida final en `plan.md`. */
export type Projection = 'written' | 'plan_changed' | 'not_published'

/**
 * La corrida final. Corre todas las filas ejecutables y evalúa cada una, confirma las que tienen
 * obligación (solo si pasaron), aplica las acreditaciones vigentes de las manuales y agrega la observación
 * de la última cosecha del flujo y la de la base. Es verde solo si todo eso da verde, la huella no cambió y,
 * si hubo writer, su cosecha cerró con `STATUS: done`. Una corrida interrumpida publica un recibo rojo si
 * el árbol volvió a su huella; si no, no publica y deja la intención para la recuperación.
 */
export async function runFinal(start: VerifyStart, signal: AbortSignal): Promise<{ receipt: VerifyReceipt; ref: VerifyReceiptRef | null; projection: Projection }> {
  return await withVerifyReservation(start, async () => {
    const started_at = new Date().toISOString()
    const before = candidateFingerprint(start.root, start.flow, start.baseCommit)
    const { executable, manual } = split(start.contract)
    const executions = new Map((await executeRows(start.root, start.runDir, executable, signal, '', start.receiptId)).map((e) => [e.row, e]))
    const baseline = latestBaseline(start)
    const rows: RowResult[] = []
    for (const row of start.contract.rows) {
      const observed = baseline?.get(row.id) ?? 'missing'
      if (row.kind === 'manual') {
        const current = currentAttestation(start.root, start.refs.attestations, start.flow, row.id, before, start.planFingerprint)
        rows.push({
          row: row.id, outcome: current.ref ? 'passed' : 'unrun', execution: manualExecution(start.runDir, row.id),
          ...(current.ref ? { attestation: current.ref.id } : {}),
          ...(current.invalid.length > 0 ? { invalid_attestations: current.invalid } : {}), baseline: observed,
        })
        continue
      }
      const e = executions.get(row.id)!
      const evaluated = evaluateRow(row, e, outputOf(start.runDir, e))
      const confirmation = row.kind !== 'test' || row.obligation === 'none' ? undefined
        : evaluated !== 'passed' || signal.aborted ? { row: row.id, obligation: row.obligation, state: 'not_confirmable' as const, reason: 'la fila no está en verde', restored: true }
          : await confirmRow(start, row, before, signal, e)
      // Una fila con obligación pasa solo si además se confirmó y se restauró.
      const outcome = confirmation && evaluated === 'passed' && !(confirmation.state === 'confirmed' && confirmation.restored) ? 'failed' : evaluated
      rows.push({ row: row.id, outcome, execution: e, ...(confirmation ? { confirmation } : {}), baseline: observed })
    }
    const harvest = latestFlowHarvest(start.root, start.flow)
    const after = candidateFingerprint(start.root, start.flow, start.baseCommit)
    const takeover = lastTakeover(start.root, start.flow)
    const observed = harvest ? writerObservation(start, harvest, after) : undefined
    const writer = observed && takeover ? { ...observed, takeover } : observed
    // Después de una toma el candidato es del conductor: la marca final del último writer ya no cuenta.
    const green = rows.every((r) => r.outcome === 'passed')
      && after.tree === before.tree && after.base_commit === before.base_commit && (writer === undefined || writer.end_mark || writer.takeover !== undefined)
    const receipt: VerifyReceipt = {
      id: start.receiptId, flow: start.flow, mode: 'final', started_at, ended_at: new Date().toISOString(), before, after,
      plan_fingerprint: start.planFingerprint, coverage: coverageOf(start.contract, start.specAcs), rows, ...(writer ? { writer } : {}), green,
    }
    if (signal.aborted && after.tree !== before.tree) return { receipt, ref: null, projection: 'not_published' }
    const ref = writeVerifyReceipt(start.root, receipt)
    appendReceiptRef(start.root, start.flow, ref)
    return { receipt, ref, projection: project(start, receipt) }
  })
}

/** La observación de la última medición de base con la misma base y el mismo plan, por fila, o `null` si no hay. */
function latestBaseline(start: VerifyStart): Map<string, NonNullable<RowResult['baseline']>> | null {
  for (const ref of [...start.refs.receipts].reverse()) {
    if (ref.mode !== 'baseline') continue
    let r: VerifyReceipt
    try {
      r = readVerifyReceipt(start.root, ref)
    } catch {
      continue
    }
    if (r.before.base_commit === start.baseCommit && r.plan_fingerprint === start.planFingerprint) {
      return new Map(r.rows.map((row) => [row.row, row.baseline ?? 'not_measurable']))
    }
  }
  return null
}

/** La toma que cierra la última cadena del flujo, si su último eslabón es una. */
function lastTakeover(root: string, flow: string): string | undefined {
  const chain = implementOf(readPhaseRecord(root, flow)).chains.at(-1)
  const last = chain?.entries.at(-1)
  return last?.kind === 'takeover' ? last.id : undefined
}

/** Si la última cosecha cerró completa y si su árbol, sin el flujo, es el del candidato de ahora. */
function writerObservation(start: VerifyStart, h: NonNullable<ReturnType<typeof latestFlowHarvest>>, after: CandidateFingerprint): NonNullable<VerifyReceipt['writer']> {
  const tree = harvestTreeWithout(start.root, start.flow, h.harvest.base, h.harvest.patchFile)
  return { run: h.run, end_mark: h.harvest.state === 'done' && h.harvest.endMark, tree_matches: tree === null ? 'not_comparable' : tree === after.tree }
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/** La evidencia de una fila en `## Verify`: el extracto, y la confirmación o la acreditación. */
function evidence(r: RowResult): string {
  if (r.attestation) return `acreditada (${r.attestation})`
  const base = r.execution?.excerpt ?? 'exit -; manual'
  const c = r.confirmation
  if (!c || c.state === 'not_required') return base
  return `${base}; revert: ${c.state}${c.reason ? ` (${c.reason})` : ''}`
}

/** `## Verify` como proyección del recibo: una línea por AC y fila, y la huella y el recibo al pie. */
export function renderVerify(receipt: VerifyReceipt): string {
  const byRow = new Map(receipt.rows.map((r) => [r.row, r]))
  const lines = ['| AC | Fila | Resultado | Evidencia | Fecha |', '|---|---|---|---|---|']
  for (const [ac, ids] of Object.entries(receipt.coverage)) {
    for (const id of ids) {
      const r = byRow.get(id)
      if (!r) continue
      const ok = r.outcome === 'passed' && (r.confirmation === undefined || r.confirmation.state === 'confirmed' || r.confirmation.state === 'not_required')
      const when = localIso(new Date(r.execution?.ended_at ?? receipt.ended_at))
      lines.push(`| ${ac} | ${id} | ${ok ? '✅' : '❌'} ${r.outcome} | ${cell(evidence(r))} | ${when} |`)
    }
  }
  lines.push('', `Candidato: base \`${receipt.after.base_commit}\`, árbol \`${receipt.after.tree}\`. Recibo \`${receipt.id}\`${receipt.green ? '' : ' (no está en verde)'}.`)
  return lines.join('\n')
}

/**
 * Escribe la proyección en `plan.md`: bajo el lock del flujo, relee el plan y, si su huella sigue siendo
 * la del contrato que se ejecutó, reemplaza solo `## Verify` y la línea `status` del header (`verified` si
 * el recibo es verde, `implementing` si no). Escribe un temporal y lo renombra sobre `plan.md`, que tiene
 * que ser un archivo regular: no usa la publicación de fases, que no pisa un artefacto existente.
 */
function project(start: VerifyStart, receipt: VerifyReceipt): Projection {
  return withFlowLock(start.root, start.flow, () => {
    const { facts } = readFlow(start.root, start.flow)
    const depth = resolve(facts).depth
    const gate = depth === null ? undefined : PLAN_GATE[depth]
    if (gate === undefined || facts.fingerprints[gate] !== start.planFingerprint) return 'plan_changed'
    const file = join(flowDir(start.root, start.flow), FILE_NAMES.plan)
    if (!lstatSync(file).isFile()) throw new SddError('path_invalid', `${file} no es un archivo regular`)
    const text = readFileSync(file, 'utf8')
    writeTextAtomic(file, projectVerify(text, receipt))
    return 'written'
  })
}

/** El plan con la proyección del recibo: solo `## Verify` y el `status` del header cambian. */
export function projectVerify(text: string, receipt: VerifyReceipt): string {
  return setHeaderStatus(replaceSection(text, 'Verify', renderVerify(receipt)), receipt.green ? 'verified' : 'implementing')
}

/**
 * Si `current` es exactamente lo que la proyección de un recibo final íntegro del flujo hace a `frozen`,
 * devuelve el id de ese recibo. Solo aplica al plan `.plans/<flujo>/plan.md`; ante cualquier error, `null`.
 */
export function verifyProjectionOf(root: string, contextPath: string, frozen: string, current: string): string | null {
  const m = /^\.plans\/([^/]+)\/plan\.md$/.exec(contextPath)
  if (!m || !isFlowId(m[1])) return null
  const flow = m[1]
  try {
    const refs = (readPhaseRecord(root, flow).verify?.receipts ?? []).filter((r) => r.mode === 'final')
    for (const ref of [...refs].reverse()) {
      const receipt = readVerifyReceipt(root, ref)
      if (receipt.flow !== flow) continue
      if (projectVerify(frozen, receipt) === current) return receipt.id
    }
  } catch {
    return null
  }
  return null
}

function writeTextAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
