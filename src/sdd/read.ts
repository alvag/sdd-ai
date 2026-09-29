import { type Stats, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { type JiraMode, loadJiraMode } from '../config.ts'
import { hasRemote } from '../git.ts'
import { sha256 } from '../review/candidate.ts'
import { SddError } from '../types.ts'
import { isFlowId } from './id.ts'
import {
  type HeaderResult, type SectionState, combinedFingerprint, countTasks, planFingerprint, readHeader, section, singleFingerprint, specFingerprint,
  tasksFingerprint,
} from './markdown.ts'
import { type Approval, type ApprovalLog, type Depth, type FileState, type FlowFacts, GATES, type GateId, type Next, type Reason, isDepth, resolve } from './status.ts'

/** El registro de aprobaciones vive en el flujo: viaja con él al archivarlo. */
export const APPROVALS_FILE = 'sdd-ai-approvals.json'
export const LOCK_FILE = 'sdd-ai-approvals.lock'

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const ARTIFACTS = ['spec', 'plan', 'tasks', 'handoff'] as const
type FileKey = (typeof ARTIFACTS)[number] | 'approvals'
export const FILE_NAMES: Record<FileKey, string> = {
  spec: 'spec.md', plan: 'plan.md', tasks: 'tasks.md', handoff: 'handoff.md', approvals: APPROVALS_FILE,
}
const START_FLOW = 'para empezar un flujo, corre /sdd-flow en Claude Code o $sdd-flow en Codex'

const outside = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function pathInvalid(what: string, why: string): SddError {
  return new SddError('path_invalid', `${what} ${why}: no se lee ni se escribe a través de él`, {
    next: 'reemplaza el enlace por el directorio o el archivo real dentro de .plans/',
  })
}

/** El `lstat` de una ruta, o `null` si no existe. */
export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * `<root>/.plans/<id>`, sin enlaces en el camino. Valida el id antes de tocar el disco. Ni `.plans/`
 * ni el flujo pueden ser enlaces, y sus rutas reales tienen que caer dentro del repo y de `.plans/`.
 */
export function flowDir(root: string, id: string): string {
  if (!isFlowId(id)) {
    throw new SddError('usage', `el id de flujo no es válido: ${id}`, {
      detail: 'un id lleva solo letras, dígitos, ., _ y -, hasta 128 caracteres, y no es . ni ..',
    })
  }
  const plans = join(root, '.plans')
  const dir = join(plans, id)
  for (const [path, what] of [[plans, '.plans'], [dir, `.plans/${id}`]]) {
    const st = lstatOrNull(path)
    if (st === null) throw new SddError('flow_not_found', `no existe el flujo ${id} en .plans/`, { next: START_FLOW })
    if (st.isSymbolicLink()) throw pathInvalid(what, 'es un enlace simbólico')
    if (!st.isDirectory()) throw pathInvalid(what, 'no es un directorio')
  }
  const realPlans = realpathSync(plans)
  if (outside(relative(realpathSync(root), realPlans)) || outside(relative(realPlans, realpathSync(dir)))) {
    throw pathInvalid(`.plans/${id}`, 'resuelve fuera de .plans/ del repositorio')
  }
  return dir
}

interface FileRead { state: FileState; text: string | null; digest: string }
const UNREADABLE: FileRead = { state: 'unreadable', text: null, digest: 'unreadable' }

/**
 * Un archivo del flujo. Un enlace se rechaza; lo que no es un archivo regular (un directorio, un FIFO,
 * un socket o un dispositivo) es ilegible y no se abre, así que no puede colgar la lectura.
 */
function readFlowFile(dir: string, id: string, key: FileKey): FileRead {
  let st: Stats | null
  try {
    st = lstatOrNull(join(dir, FILE_NAMES[key]))
  } catch {
    return UNREADABLE
  }
  if (st === null) return { state: 'absent', text: null, digest: 'absent' }
  if (st.isSymbolicLink()) throw pathInvalid(`.plans/${id}/${FILE_NAMES[key]}`, 'es un enlace simbólico')
  if (!st.isFile()) return UNREADABLE
  let bytes: Buffer
  try {
    bytes = readFileSync(join(dir, FILE_NAMES[key]))
  } catch {
    return UNREADABLE
  }
  const text = bytes.toString('utf8')
  const state = text.trim() === '' ? 'empty' : 'present'
  return { state, text, digest: `${state}:${sha256(bytes)}` }
}

/** Qué le falta al registro para tener la forma esperada; `null` si la tiene. */
function logProblem(data: unknown): string | null {
  if (!isRecord(data) || data.schema_version !== 1) return 'schema_version no es 1'
  if (!Array.isArray(data.approvals)) return 'approvals no es una lista'
  for (const [i, a] of data.approvals.entries()) {
    const where = `approvals[${i}]`
    if (!isRecord(a)) return `${where} no es un objeto`
    if (!isDepth(a.depth)) return `${where}.depth no es corta, normal ni completa`
    const gates: readonly string[] = GATES[a.depth]
    if (typeof a.gate !== 'string' || !gates.includes(a.gate)) return `${where}.gate no es un gate de ${a.depth}`
    if (typeof a.fingerprint !== 'string' || !FINGERPRINT.test(a.fingerprint)) return `${where}.fingerprint no es sha256: más 64 hex`
    const previous = gates.slice(0, gates.indexOf(a.gate))
    if (!isRecord(a.previous) || Object.keys(a.previous).sort().join() !== [...previous].sort().join()
      || !Object.values(a.previous).every((f) => typeof f === 'string' && FINGERPRINT.test(f))) {
      return `${where}.previous no trae las huellas de ${previous.length > 0 ? previous.join(', ') : 'ningún gate'}`
    }
    if (typeof a.at !== 'string' || !ISO_8601.test(a.at) || Number.isNaN(Date.parse(a.at))) return `${where}.at no es una fecha ISO 8601`
    if (a.proof !== undefined) {
      const problem = proofProblem(a.proof)
      if (problem !== null) return `${where}.proof ${problem}`
    }
  }
  return null
}

const SOURCE_OF = { claude: 'ask_user_question', codex: 'rollout_message' } as const

/** Una prueba trae sus cinco campos como strings no vacíos, y su fuente es la de su runner. */
function proofProblem(p: unknown): string | null {
  if (!isRecord(p)) return 'no es un objeto'
  for (const key of ['runner', 'source', 'ref', 'session', 'answered_at']) {
    if (typeof p[key] !== 'string' || p[key] === '') return `no trae ${key} como texto no vacío`
  }
  if (p.runner !== 'claude' && p.runner !== 'codex') return 'tiene un runner que no es claude ni codex'
  if (p.source !== SOURCE_OF[p.runner]) return `tiene una fuente que no es la de ${p.runner}`
  return null
}

function toLog(f: FileRead): ApprovalLog {
  if (f.state === 'absent') return { state: 'absent' }
  if (f.text === null) return { state: 'invalid', detail: `${APPROVALS_FILE} no se puede leer` }
  let data: unknown
  try {
    data = JSON.parse(f.text)
  } catch (e) {
    return { state: 'invalid', detail: `${APPROVALS_FILE} no es JSON: ${(e as Error).message}` }
  }
  const problem = logProblem(data)
  return problem === null ? { state: 'ok', approvals: (data as { approvals: Approval[] }).approvals } : { state: 'invalid', detail: problem }
}

const sectionState = (s: string | null): SectionState => (s === null ? 'absent' : s.trim() === '' ? 'empty' : 'present')

/**
 * Los hechos de un flujo, y el digest de cada archivo leído: `absent`, `unreadable`, o su estado y el
 * `sha256` de sus bytes. Dos lecturas con los mismos digests leyeron lo mismo. No escribe nada.
 */
export interface FlowRead { facts: FlowFacts; digests: Record<FileKey, string> }

/** El modo de Jira del flujo: un override `"on"` u `"off"` del handoff pisa el de la config, también uno inválido. */
function flowJira(id: string, handoffHeader: HeaderResult | null, config: JiraMode): JiraMode {
  const overrides = handoffHeader?.ok ? handoffHeader.data.overrides : undefined
  const where = `.plans/${id}/handoff.md`
  if (overrides === undefined || overrides === null) return config
  if (!isRecord(overrides)) return { mode: 'invalid', detail: `${where}: overrides tiene que ser un mapa` }
  const v = overrides.jira_approval
  if (v === undefined || v === null) return config
  if (v === 'on' || v === 'off') return { mode: v }
  return { mode: 'invalid', detail: `${where}: overrides.jira_approval tiene que ser "on" u "off", o null para no pisar la config, no ${JSON.stringify(v)}` }
}

export const bytesHash = (b: Buffer | string) => `sha256:${sha256(b)}`

/** La huella de un artefacto leído por `readFlow`: sus bytes si está presente; si no, su estado. */
export const artifactHash = (read: FlowRead, key: 'spec' | 'plan' | 'tasks') => {
  const d = read.digests[key]
  return d.startsWith('present:') ? `sha256:${d.slice('present:'.length)}` : d
}

/** Un valor con las claves de cada mapa ordenadas, para que la huella no dependa del orden en el archivo. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}

/** La huella del header del handoff: su cuerpo cambia en cada paso del conductor y no cuenta. */
export function headerHash(h: HeaderResult | null): string {
  if (h === null) return 'absent'
  if (!h.ok) return `invalid:${sha256(h.detail)}`
  return bytesHash(JSON.stringify(canonical(h.data)))
}

/** Un artefacto que todavía no está en disco: `readFlow` lo lee de este texto, para evaluar el flujo con él. */
export interface FlowCandidate { artifact: 'spec' | 'plan' | 'tasks'; text: string }

function candidateRead(text: string): FileRead {
  const bytes = Buffer.from(text, 'utf8')
  const state = text.trim() === '' ? 'empty' : 'present'
  return { state, text, digest: `${state}:${sha256(bytes)}` }
}

export function readFlow(root: string, id: string, jira: JiraMode = loadJiraMode(root), candidate?: FlowCandidate): FlowRead {
  const dir = flowDir(root, id)
  const files = Object.fromEntries(ARTIFACTS.map((a) => [a, readFlowFile(dir, id, a)])) as Record<(typeof ARTIFACTS)[number], FileRead>
  if (candidate) files[candidate.artifact] = candidateRead(candidate.text)
  const approvals = readFlowFile(dir, id, 'approvals')
  const text = (a: (typeof ARTIFACTS)[number]) => (files[a].state === 'present' ? files[a].text : null)
  const [spec, planText, tasks, handoff] = ARTIFACTS.map(text)

  const planHeader = planText === null ? null : readHeader(planText)
  const handoffHeader = handoff === null ? null : readHeader(handoff)
  let planSections: FlowFacts['planSections'] = null
  let tasksSection: FlowFacts['tasksSection'] = null
  if (planText !== null) {
    const body = planHeader?.ok ? planHeader.body : planText
    const tasksText = section(body, 'Tasks')
    planSections = { spec: sectionState(section(body, 'Spec')), tasks: sectionState(tasksText) }
    tasksSection = tasksText === null ? null : countTasks(tasksText)
  }

  const fingerprints: Partial<Record<GateId, string>> = {}
  if (spec !== null) fingerprints.spec = specFingerprint(spec)
  if (planText !== null) {
    fingerprints.plan = planFingerprint(planText)
    fingerprints.single = singleFingerprint(planText)
  }
  if (tasks !== null) fingerprints.tasks = tasksFingerprint(tasks)
  if (fingerprints.plan && fingerprints.tasks) fingerprints['plan-tasks'] = combinedFingerprint({ plan: fingerprints.plan, tasks: fingerprints.tasks })

  const rel = `.plans/${id}`
  const paths = Object.fromEntries([['dir', rel], ...Object.entries(FILE_NAMES).map(([k, name]) => [k, `${rel}/${name}`])])
  return {
    facts: {
      id,
      files: { spec: files.spec.state, plan: files.plan.state, tasks: files.tasks.state, handoff: files.handoff.state },
      planHeader,
      handoffHeader,
      planSections,
      tasksFile: tasks === null ? null : countTasks(tasks),
      tasksSection,
      fingerprints,
      log: toLog(approvals),
      paths,
      hasRemote: hasRemote(root),
      jira: flowJira(id, handoffHeader, jira),
    },
    digests: {
      spec: files.spec.digest, plan: files.plan.digest, tasks: files.tasks.digest, handoff: files.handoff.digest, approvals: approvals.digest,
    },
  }
}

export interface ListEntry { id: string; depth: Depth | null; next: Next; blocked: boolean; blocked_reasons: Reason[] }

const blockedEntry = (id: string, reason: Reason): ListEntry =>
  ({ id, depth: null, next: { step: 'resolve_blockers' }, blocked: true, blocked_reasons: [reason] })

/**
 * Los directorios de `.plans/` salvo `archived/`, como los lista el retomado de `sdd-flow`; los archivos
 * sueltos se ignoran. Un nombre que no es un id, un enlace o un flujo roto salen bloqueados sin romper
 * el listado, y los dos primeros sin leerse.
 */
export function listFlows(root: string): ListEntry[] {
  const plans = join(root, '.plans')
  const st = lstatOrNull(plans)
  if (st === null) return []
  if (st.isSymbolicLink()) throw pathInvalid('.plans', 'es un enlace simbólico')
  if (!st.isDirectory()) throw pathInvalid('.plans', 'no es un directorio')
  const jira = loadJiraMode(root)
  const names = readdirSync(plans, { withFileTypes: true })
    .filter((e) => e.name !== 'archived' && (e.isDirectory() || e.isSymbolicLink()))
    .map((e) => e.name)
    .sort()
  return names.map((id): ListEntry => {
    if (!isFlowId(id)) return blockedEntry(id, { code: 'id_invalid', detail: 'el nombre del directorio no es un id de flujo válido' })
    try {
      const s = resolve(readFlow(root, id, jira).facts)
      return { id, depth: s.depth, next: s.next, blocked: s.blocked_reasons.length > 0, blocked_reasons: s.blocked_reasons }
    } catch (e) {
      if (e instanceof SddError) return blockedEntry(id, { code: e.code, detail: e.message })
      throw e
    }
  })
}
