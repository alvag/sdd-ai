import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { Scalar, isMap, parse, parseDocument } from 'yaml'
import { agentName, agentsState, leftoverAgents, skillCopies, syncAgents } from './agents.ts'
import { parseCrossModel, parseJiraMode } from './config.ts'
import { type Exec, cliVersion, defaultExec, detectClis, doctor, olderVersion } from './doctor.ts'
import { gitDirs } from './git.ts'
import { MOD_ADOPTION_MESSAGE, MOD_PATH, MOD_RUNTIME_FILES, type ModFile, assertModCopyInside, modChanges, modCopy, modInventory } from './mod-copies.ts'
import { DEFAULT_PROFILES, type WorkersFile, loadCodexCatalog, loadCodexRoot, parseWorkers } from './profiles.ts'
import { roleProfiles } from './resolve.ts'
import { type Family, READ_ONLY_ROLES, RETIRED_ROLES, ROLES, type Role, SddError } from './types.ts'
import { type TelemetryPreference, type UserTelemetryPlan, planUserTelemetry, readUserConfig, writeUserTelemetry } from './user-config.ts'

// `init` prepara un checkout de sdd-ai. El ensayo calcula el plan sin escribir nada; la aplicación lo
// vuelve a calcular con las mismas funciones, comprueba que el digest sea el que vio el usuario y recién
// entonces escribe. No queda estado entre las dos corridas: el digest cubre las entradas y las salidas.

const CONFIG_PATH = '.sdd-ai/config.yml'
const WORKERS_PATH = '.sdd-ai/workers.yml'
const IGNORE_PATH = '.sdd-ai/.gitignore'
/** Las fuentes de las que `agents sync` genera los agentes y las copias de la skill. */
const AGENT_SOURCES = ['agents/worker.md', 'skills/sdd-ai/SKILL.md']
/** Lo que tiene todo checkout de sdd-ai: sin esto, los hooks y la skill no tienen a qué llamar. */
const RUNTIME_FILES = ['bin/sdd-ai', 'bin/sdd-ai-hook', ...AGENT_SOURCES, ...MOD_RUNTIME_FILES]
const FAMILIES: readonly Family[] = ['claude', 'codex']
const HOOK_FILES: Record<Family, string> = { claude: '.claude/settings.json', codex: '.codex/hooks.json' }
/** Los eventos en los que cada CLI tiene que llamar al lanzador. Codex no tiene `PostToolUseFailure`. */
const HOOK_EVENTS: Record<Family, readonly string[]> = {
  claude: ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  codex: ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse'],
}
const AGENT_FILES: Record<Family, (name: string) => string> = {
  claude: (name) => `.claude/agents/${name}.md`,
  codex: (name) => `.codex/agents/${name}.toml`,
}

export type JiraAnswer = 'on' | 'off'
export interface InitAnswers { families?: Family[]; jira?: JiraAnswer; from?: string; telemetry?: TelemetryPreference }
export interface InitOptions {
  /** El comando de `init` con los mismos flags, listo para la shell; con digest, el de la aplicación. */
  command: (digest?: string) => string
  exec?: Exec
}
type Env = Record<string, string | undefined>

interface Current { families: Family[]; selection?: string; jira: JiraAnswer }
interface Resolved { families: Family[]; selection?: string; jira: JiraAnswer }
interface Option { label: string; description: string; value: string }
interface Question { id: 'families' | 'jira_approval' | 'telemetry'; flag: '--families' | '--jira' | '--telemetry'; header: string; question: string; options: Option[] }
interface FileError { code: string; message: string; next?: string }
interface PlannedFile { path: string; action: 'create' | 'update' | 'unchanged' | 'invalid'; content?: string; changes?: string[]; error?: FileError }
interface RemovedProfile { path: string; reason: 'retired' | 'unknown' | 'model_not_in_catalog'; detail: string }
interface WorkersReport { removed: RemovedProfile[]; added: string[]; differs: { path: string; current: string; default: string }[] }
interface AgentChange { path: string; state: 'stale' | 'missing' | 'leftover' }
interface Note { code: string; detail: string; next?: string }

export interface InitPlan {
  user_config: UserTelemetryPlan
  mode: 'dry_run'; root: string; current: Current | null; detected: Family[]; seed: { from: string } | null
  questions: Question[]; files: PlannedFile[]; workers: WorkersReport; agents: AgentChange[]; notes: Note[]
  digest: string; next: string
}

export interface InitResult {
  user_config: Pick<UserTelemetryPlan, 'path' | 'action'> & { written: boolean }
  mode: 'applied'; root: string; written: string[]; agents: { written: string[]; removed: string[] } | null
  workers: WorkersReport; notes: Note[]; doctor: ReturnType<typeof doctor>; closing: string
}

/** El plan y lo que la aplicación necesita de él. */
/** El plan, los workers y el inventario del mod que lo respaldan: el mismo alimenta la comparación, el digest y la copia. */
interface Planned { plan: InitPlan; workers: WorkersFile | null; inventory: ModFile[] }

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Como `readText`, pero un archivo que no se lee por cualquier motivo es `null`: sirve para lo que solo avisa. */
function readQuiet(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const sha = (text: string | null) => text === null ? null : createHash('sha256').update(text).digest('hex')
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i])
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v))

/** Claves ordenadas en todos los niveles: el mismo plan da siempre el mismo digest. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]))
  }
  return value
}

function assertCheckout(root: string): void {
  const missing = RUNTIME_FILES.filter((rel) => !existsSync(join(root, rel)))
  if (missing.length === 0) return
  throw new SddError('runtime_missing', `${root} no es un checkout de sdd-ai: falta ${missing.join(', ')}`, {
    next: 'init prepara el repositorio de sdd-ai y sus worktrees; usar sdd-ai en otro repositorio es la instalación global',
  })
}

/**
 * El checkout del que se siembra la config: el que nombra `--from` o, en un worktree enlazado, el
 * checkout principal si tiene config. `missing` dice que era un worktree y el principal no tenía nada.
 */
function seedSource(root: string, from: string | undefined): { source: string | null; missing: boolean } {
  if (from !== undefined) {
    if (!existsSync(join(from, CONFIG_PATH))) {
      throw new SddError('seed_source_invalid', `${from} no tiene ${CONFIG_PATH}`, { next: 'nombra con --from un checkout que ya tenga su config' })
    }
    return { source: realpathSync(from), missing: false }
  }
  const { gitDir, commonDir } = gitDirs(root)
  if (gitDir === commonDir) return { source: null, missing: false }
  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
  const main = /^worktree (.+)$/m.exec(list)?.[1]
  if (main !== undefined && existsSync(join(main, CONFIG_PATH))) return { source: main, missing: false }
  return { source: null, missing: true }
}

/** La config vigente: la misma validación que `run`, y una config que no se lee niega `init` entero. */
function readCurrent(text: string, where: string): Current {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (e) {
    throw new SddError('config_invalid', `${where}: YAML ilegible`, { detail: (e as Error).message })
  }
  let cross: ReturnType<typeof parseCrossModel>
  try {
    cross = parseCrossModel(doc)
  } catch (e) {
    const err = e as SddError
    throw new SddError('config_invalid', `${where}: ${err.message}`, { detail: err.detail, next: 'corrige la config a mano y vuelve a correr init' })
  }
  const jira = parseJiraMode(doc)
  if (jira.mode === 'invalid') throw new SddError('config_invalid', jira.detail, { next: 'corrige jira_approval.mode a mano y vuelve a correr init' })
  const current: Current = { families: cross.families, jira: jira.mode }
  if (cross.selection !== undefined) current.selection = cross.selection
  return current
}

/**
 * Lo que se escribe con las respuestas. Un flag omitido toma lo vigente o, sin config, lo detectado:
 * la primera opción de cada pregunta. La `selection` se conserva mientras las familias no cambien.
 */
function resolveAnswers(answers: InitAnswers, current: Current | null, detected: Family[]): Resolved {
  const families = answers.families ?? current?.families ?? detected
  if (families.length === 0) {
    throw new SddError('clis_missing', 'no hay ninguna CLI de claude ni de codex en el PATH', { next: 'instala una o nombra las familias con --families' })
  }
  const resolved: Resolved = { families, jira: answers.jira ?? current?.jira ?? 'off' }
  if (current !== null && sameList(families, current.families)) {
    if (current.selection !== undefined) resolved.selection = current.selection
  } else {
    resolved.selection = sameSet(families, detected) ? 'full' : 'user_choice'
  }
  return resolved
}

const FAMILY_CHOICES: readonly { families: Family[]; label: string; description: string }[] = [
  { families: ['claude', 'codex'], label: 'claude y codex', description: 'Workers de las dos familias.' },
  { families: ['claude'], label: 'solo claude', description: 'Todos los workers son de Claude.' },
  { families: ['codex'], label: 'solo codex', description: 'Todos los workers son de Codex.' },
]
const JIRA_CHOICES: Record<JiraAnswer, string> = {
  off: 'Sin aprobación externa de la spec.',
  on: 'Todo cambio va por un flujo SDD y la spec se aprueba en Jira; sin liga, la guarda niega el commit.',
}

/** Las preguntas del asistente, con lo vigente primero o, sin config, lo detectado y el default. */
function questionsFor(current: Current | null, detected: Family[]): Question[] {
  const questions: Question[] = []
  const mark = current === null ? 'detectado' : 'actual'
  if (detected.length > 1) {
    const first = current?.families ?? detected
    const rest = FAMILY_CHOICES.filter((c) => !sameSet(c.families, first))
    const own = FAMILY_CHOICES.find((c) => sameSet(c.families, first))
    questions.push({
      id: 'families', flag: '--families', header: 'Familias',
      question: '¿Qué familias trabajan como workers en este checkout?',
      options: [
        { label: `${own?.label ?? first.join(' y ')} (${mark})`, description: own?.description ?? 'La selección vigente.', value: first.join(',') },
        ...rest.map((c) => ({ label: c.label, description: c.description, value: c.families.join(',') })),
      ],
    })
  }
  const jira = current?.jira ?? 'off'
  const other: JiraAnswer = jira === 'on' ? 'off' : 'on'
  questions.push({
    id: 'jira_approval', flag: '--jira', header: 'Jira',
    question: '¿La spec de cada flujo necesita aprobación externa en Jira?',
    options: [
      { label: `${jira} (${current === null ? 'por defecto' : 'actual'})`, description: JIRA_CHOICES[jira], value: jira },
      { label: other, description: JIRA_CHOICES[other], value: other },
    ],
  })
  return questions
}

function freshConfig(r: Resolved): string {
  return [
    '# .sdd-ai/config.yml: la config de sdd-ai en este checkout. Es local y no se versiona.',
    'cross_model:',
    '  schema_version: 1',
    `  families: [${r.families.join(', ')}]`,
    `  selection: ${r.selection ?? 'full'}`,
    'jira_approval:',
    `  mode: "${r.jira}"`,
    '',
  ].join('\n')
}

/**
 * La config fusionada: cambia solo lo que las respuestas cambian y conserva las demás claves y los
 * comentarios. Sin cambios devuelve el texto tal cual, sin reserializarlo.
 */
function mergeConfig(base: string, current: Current, r: Resolved): { content: string; changes: string[] } {
  const doc = parseDocument(base)
  const changes: string[] = []
  if (!sameList(r.families, current.families)) {
    const seq = doc.createNode(r.families)
    seq.flow = true
    // El comentario de la línea vive en el nodo que se reemplaza: se lo pasa al nuevo.
    const old = doc.getIn(['cross_model', 'families'], true) as { comment?: string | null } | undefined
    if (old?.comment) seq.comment = old.comment
    doc.setIn(['cross_model', 'families'], seq)
    changes.push(`families: [${current.families.join(', ')}] → [${r.families.join(', ')}]`)
  }
  if (r.selection !== current.selection) {
    doc.setIn(['cross_model', 'selection'], r.selection)
    changes.push(`selection: ${current.selection ?? '(sin valor)'} → ${r.selection}`)
  }
  if (r.jira !== current.jira) {
    const mode = new Scalar(r.jira)
    mode.type = Scalar.QUOTE_DOUBLE
    doc.setIn(['jira_approval', 'mode'], mode)
    changes.push(`jira_approval.mode: ${current.jira} → ${r.jira}`)
  }
  return { content: changes.length === 0 ? base : doc.toString({ flowCollectionPadding: false }), changes }
}

/**
 * Si el default de un rol se puede escribir. Un modelo de Codex que no está en el catálogo local no se
 * escribe nunca, tampoco el default: el rol queda sin ese perfil y usa el heredado. Así un archivo nuevo
 * y uno fusionado siguen la misma regla, y la segunda corrida no lo quita y lo vuelve a agregar.
 */
function writableDefault(role: Role, family: Family, catalog: Set<string> | null): boolean {
  return family !== 'codex' || catalog === null || catalog.has(DEFAULT_PROFILES[role].codex.model)
}

function freshWorkers(catalog: Set<string> | null): string {
  const lines = [
    '# .sdd-ai/workers.yml: los perfiles de los workers de sdd-ai por rol y familia. Es local y no se versiona.',
    '# `model` admite un nombre no vacío o `heredado`; `effort`, `heredado` o bajo | medio | alto | muy_alto | maximo.',
    '# Son los defaults de `sdd-ai init`: cámbialos a mano si quieres otro modelo o esfuerzo para un rol.',
    'schema_version: 1',
    'roles:',
  ]
  for (const role of ROLES) {
    lines.push(`  ${role}:`)
    for (const family of FAMILIES) {
      if (!writableDefault(role, family, catalog)) continue
      const p = DEFAULT_PROFILES[role][family]
      lines.push(`    ${family}:`, `      model: ${p.model}`, `      effort: ${p.effort}`)
    }
  }
  return `${lines.join('\n')}\n`
}

type WorkersPlan = { invalid: FileError } | { content: string; changed: boolean; report: WorkersReport; workers: WorkersFile }

const invalidOf = (e: unknown): { invalid: FileError } => {
  if (!(e instanceof SddError)) throw e
  return { invalid: { code: e.code, message: e.message, ...(e.next === undefined ? {} : { next: e.next }) } }
}

/**
 * Un `workers.yml` existente, completado y limpio: quita los roles que sdd-ai no conoce y los perfiles de
 * Codex con un modelo que no está en el catálogo, agrega con los defaults lo que falta y conserva el
 * resto. Un archivo inválido por otro motivo no se toca: se informa con el mismo error que da `run`.
 */
function mergeWorkers(base: string, where: string, catalog: Set<string> | null): WorkersPlan {
  const doc = parseDocument(base, { uniqueKeys: true })
  if (doc.errors.length > 0) {
    try {
      parseWorkers(base, where)
    } catch (e) {
      return invalidOf(e)
    }
  }
  const report: WorkersReport = { removed: [], added: [], differs: [] }
  const roles = doc.get('roles')
  if (isMap(roles)) {
    for (const pair of [...roles.items]) {
      const role = String((pair.key as Scalar | null)?.value ?? pair.key)
      if ((ROLES as readonly string[]).includes(role)) continue
      doc.deleteIn(['roles', role])
      const renamed = RETIRED_ROLES.get(role)
      report.removed.push(renamed === undefined
        ? { path: `roles.${role}`, reason: 'unknown', detail: `sdd-ai no tiene el rol ${role}` }
        : { path: `roles.${role}`, reason: 'retired', detail: `el rol ${role} ahora se llama ${renamed}` })
    }
  }
  let parsed: WorkersFile
  try {
    parsed = parseWorkers(doc.toString(), where)
  } catch (e) {
    return invalidOf(e)
  }
  if (catalog !== null) {
    for (const role of ROLES) {
      const model = parsed.roles[role]?.codex?.model
      if (model === undefined || model === 'heredado' || catalog.has(model)) continue
      doc.deleteIn(['roles', role, 'codex'])
      // Un rol que queda vacío se borra entero, para que su default se escriba en estilo bloque.
      const left = doc.getIn(['roles', role])
      if (isMap(left) && left.items.length === 0) doc.deleteIn(['roles', role])
      delete parsed.roles[role]?.codex
      report.removed.push({ path: `roles.${role}.codex`, reason: 'model_not_in_catalog', detail: `el modelo ${model} no está en el catálogo local de Codex` })
    }
  }
  for (const role of ROLES) {
    for (const family of FAMILIES) {
      const own = parsed.roles[role]?.[family]
      const def = DEFAULT_PROFILES[role][family]
      if (own === undefined) {
        if (!writableDefault(role, family, catalog)) continue
        doc.setIn(['roles', role, family], doc.createNode({ model: def.model, effort: def.effort }))
        report.added.push(`roles.${role}.${family}`)
      } else if (own.model !== def.model || own.effort !== def.effort) {
        report.differs.push({
          path: `roles.${role}.${family}`,
          current: `${own.model ?? 'heredado'} / ${own.effort ?? 'heredado'}`,
          default: `${def.model} / ${def.effort}`,
        })
      }
    }
  }
  const changed = report.removed.length > 0 || report.added.length > 0
  const content = changed ? doc.toString({ flowCollectionPadding: false }) : base
  return { content, changed, report, workers: parseWorkers(content, where) }
}

/** El lanzador en cada evento de cada CLI; un archivo que falta o no se lee es un aviso, nunca un error. */
function hookNotes(root: string): Note[] {
  const notes: Note[] = []
  for (const family of FAMILIES) {
    const rel = HOOK_FILES[family]
    let hooks: Record<string, unknown> = {}
    try {
      hooks = (JSON.parse(readFileSync(join(root, rel), 'utf8')) as { hooks?: Record<string, unknown> }).hooks ?? {}
    } catch {
      // Sin archivo o sin JSON, faltan todos los eventos.
    }
    const calls = new RegExp(`bin/sdd-ai-hook"?\\s+${family}\\b`)
    const missing = HOOK_EVENTS[family].filter((event) => {
      const groups = hooks[event]
      return !Array.isArray(groups) || !groups.some((g) => Array.isArray(g?.hooks)
        && g.hooks.some((h: { command?: unknown }) => typeof h?.command === 'string' && calls.test(h.command)))
    })
    if (missing.length > 0) {
      notes.push({ code: 'hooks_missing', detail: `${rel} no llama a bin/sdd-ai-hook en: ${missing.join(', ')}`, next: 'restaura el archivo desde Git; init no escribe hooks' })
    }
  }
  return notes
}

function plansIgnored(root: string): boolean | null {
  try {
    execFileSync('git', ['check-ignore', '-q', '.plans/'], { cwd: root, stdio: 'ignore' })
    return true
  } catch (e) {
    return (e as { status?: number }).status === 1 ? false : null
  }
}

/**
 * Las copias de agentes y de la skill que `agents sync` cambiaría, desde las fuentes del checkout, y los
 * agentes sobrantes que borraría.
 */
function agentChanges(root: string, workers: WorkersFile, env: Env, inventory: readonly ModFile[]): AgentChange[] {
  const profiles = roleProfiles(workers, loadCodexRoot(env))
  const out: AgentChange[] = []
  for (const role of READ_ONLY_ROLES) {
    for (const family of FAMILIES) {
      const state = agentsState(root, root, family, role, profiles)
      if (state !== 'ok') out.push({ path: AGENT_FILES[family](agentName(role)), state })
    }
  }
  for (const copy of skillCopies(root, root)) if (copy.state !== 'ok') out.push({ path: copy.path, state: copy.state })
  for (const file of leftoverAgents(root)) out.push({ path: relative(root, file), state: 'leftover' })
  out.push(...modChanges(root, inventory))
  return out
}

/**
 * Cómo describe el catálogo de Codex un modelo de una generación anterior. El catálogo no trae un campo de
 * generación, así que se lee el comienzo de la descripción, sin distinguir mayúsculas: si cambia la
 * redacción, el aviso deja de salir, pero nunca sale de más.
 */
const OLDER_GENERATION = /^(?:Older|Previous generation|Legacy)\b/i

function compute(root: string, answers: InitAnswers, env: Env, o: InitOptions): Planned {
  assertCheckout(root)
  // Una sola lectura de la fuente del mod: la comparación, el digest y la aplicación usan los mismos bytes.
  const inventory = modInventory(root)
  assertModCopyInside(root)
  const userSnapshot = readUserConfig(env.HOME ?? homedir())
  const user_config = planUserTelemetry(userSnapshot, answers.telemetry)
  const configText = readText(join(root, CONFIG_PATH))
  if (configText !== null && answers.from !== undefined) {
    throw new SddError('usage', `--from solo sirve cuando falta ${CONFIG_PATH}: este checkout ya tiene su config`)
  }
  const seed = configText === null ? seedSource(root, answers.from) : { source: null, missing: false }
  const source = seed.source
  const sourceConfig = source === null ? null : readText(join(source, CONFIG_PATH))
  const baseConfig = configText ?? sourceConfig
  const configWhere = join(configText === null && source !== null ? source : root, CONFIG_PATH)
  const current = baseConfig === null ? null : readCurrent(baseConfig, configWhere)
  const detected = detectClis(o.exec)
  const resolved = resolveAnswers(answers, current, detected)

  const files: PlannedFile[] = []
  if (baseConfig === null || current === null) {
    files.push({ path: CONFIG_PATH, action: 'create', content: freshConfig(resolved) })
  } else {
    const merged = mergeConfig(baseConfig, current, resolved)
    if (configText === null) files.push({ path: CONFIG_PATH, action: 'create', content: merged.content })
    else if (merged.changes.length === 0) files.push({ path: CONFIG_PATH, action: 'unchanged' })
    else files.push({ path: CONFIG_PATH, action: 'update', content: merged.content, changes: merged.changes })
  }

  const workersText = readText(join(root, WORKERS_PATH))
  const sourceWorkers = workersText === null && source !== null ? readText(join(source, WORKERS_PATH)) : null
  const loaded = loadCodexCatalog(env)
  const codexVersion = detected.includes('codex') ? cliVersion(o.exec ?? defaultExec, 'codex') : null
  const outdated = loaded !== null && loaded.clientVersion !== null && codexVersion !== null && olderVersion(loaded.clientVersion, codexVersion)
  // Solo un catálogo de un cliente igual o más nuevo que el instalado sirve para validar los modelos.
  const validationSlugs = loaded === null || outdated ? null : loaded.slugs
  let report: WorkersReport = { removed: [], added: [], differs: [] }
  let workers: WorkersFile | null = null
  const baseWorkers = workersText ?? sourceWorkers
  if (baseWorkers === null) {
    const content = freshWorkers(validationSlugs)
    workers = parseWorkers(content, join(root, WORKERS_PATH))
    const added = ROLES.flatMap((r) => FAMILIES.filter((f) => writableDefault(r, f, validationSlugs)).map((f) => `roles.${r}.${f}`))
    report = { removed: [], added, differs: [] }
    files.push({ path: WORKERS_PATH, action: 'create', content })
  } else {
    const where = join(workersText === null && source !== null ? source : root, WORKERS_PATH)
    const merged = mergeWorkers(baseWorkers, where, validationSlugs)
    if ('invalid' in merged) {
      files.push({ path: WORKERS_PATH, action: 'invalid', error: merged.invalid })
    } else {
      workers = merged.workers
      report = merged.report
      const changes = [...merged.report.removed.map((r) => `quita ${r.path}: ${r.detail}`), ...merged.report.added.map((p) => `agrega ${p}`)]
      if (workersText === null) files.push({ path: WORKERS_PATH, action: 'create', content: merged.content })
      else if (!merged.changed) files.push({ path: WORKERS_PATH, action: 'unchanged' })
      else files.push({ path: WORKERS_PATH, action: 'update', content: merged.content, changes })
    }
  }

  const ignoreText = readText(join(root, IGNORE_PATH))
  files.push(ignoreText === null ? { path: IGNORE_PATH, action: 'create', content: '*\n' } : { path: IGNORE_PATH, action: 'unchanged' })

  const agents = workers === null ? [] : agentChanges(root, workers, env, inventory)
  const notes: Note[] = [...hookNotes(root)]
  notes.push({ code: 'codex_hooks_approval', detail: 'Codex ejecuta los hooks del proyecto recién después de aprobarlos en /hooks, y vuelve a pedirlo cuando cambian' })
  if (!existsSync(join(root, 'node_modules'))) {
    notes.push({ code: 'node_modules_missing', detail: 'falta node_modules: el binario de este checkout no arranca sin sus dependencias', next: 'npm ci' })
  }
  if (plansIgnored(root) === false) {
    notes.push({ code: 'plans_not_ignored', detail: '.plans/ no está ignorado: sus artefactos aparecerían como cambios', next: 'agrega .plans/ a .git/info/exclude; init no edita archivos de ignore' })
  }
  if (loaded === null) notes.push({ code: 'codex_catalog_missing', detail: 'no se encontró el catálogo local de Codex (models_cache.json): no se validaron los modelos de Codex' })
  if (outdated) notes.push({ code: 'codex_catalog_outdated', detail: `el catálogo local de Codex lo bajó la versión ${loaded?.clientVersion} y el codex instalado es la ${codexVersion}: no se validaron los modelos de Codex`, next: 'corre codex una vez para que baje su catálogo y vuelve a ensayar' })
  if (loaded !== null && !outdated && workers !== null) {
    for (const role of ROLES) {
      const model = workers.roles[role]?.codex?.model
      if (!model || model === 'heredado') continue
      const description = loaded.descriptions.get(model)
      if (description && OLDER_GENERATION.test(description)) {
        notes.push({ code: 'codex_model_older_generation', detail: `el perfil de ${role} usa ${model}, que el catálogo describe como «${description}»; el default del rol es ${DEFAULT_PROFILES[role].codex.model}`, next: 'si quieres el default, cámbialo a mano en .sdd-ai/workers.yml' })
      }
    }
  }
  // Un default que falta en el catálogo no se escribe (ver `writableDefault`), y se avisa.
  const skipped = workers === null ? [] : ROLES.filter((r) => !writableDefault(r, 'codex', validationSlugs) && workers?.roles[r]?.codex === undefined)
  if (skipped.length > 0) {
    const models = [...new Set(skipped.map((r) => DEFAULT_PROFILES[r].codex.model))]
    notes.push({
      code: 'codex_default_not_in_catalog',
      detail: `el catálogo local de Codex no trae ${models.join(', ')}: los roles ${skipped.join(', ')} quedan sin perfil de Codex y usan el modelo heredado de la config de Codex`,
      next: 'actualiza Codex o pon a mano un modelo del catálogo en esos perfiles de .sdd-ai/workers.yml',
    })
  }
  for (const family of resolved.families) {
    if (!detected.includes(family)) notes.push({ code: 'family_cli_missing', detail: `la CLI de ${family} no está en el PATH: sus workers no van a arrancar` })
  }
  if (seed.missing) notes.push({ code: 'seed_source_missing', detail: `el checkout principal no tiene ${CONFIG_PATH}: la config se arma como en un checkout nuevo` })
  if (workers === null) notes.push({ code: 'agents_skipped', detail: `${WORKERS_PATH} no es válido: no se calculan ni se sincronizan los agentes` })

  // Las fuentes de los agentes y la raíz del config de Codex deciden qué escribe `agents sync`; las notas,
  // lo que el usuario vio. Todo lo que cambia el ensayo cambia el digest.
  const digest = createHash('sha256').update(JSON.stringify(canonical({
    answers: { ...resolved, from: source, telemetry: user_config.proposed },
    inputs: {
      config: sha(configText), workers: sha(workersText), ignore: sha(ignoreText),
      user_config_path: userSnapshot.path, user_config_bytes: userSnapshot.bytes,
      source_config: sha(sourceConfig), source_workers: sha(sourceWorkers),
      catalog: loaded === null ? null : [...loaded.slugs].sort(), catalog_client: loaded?.clientVersion ?? null, codex_version: codexVersion, detected,
      agent_sources: AGENT_SOURCES.map((rel) => sha(readText(join(root, rel)))), codex_root: loadCodexRoot(env),
      mod_sources: inventory.map(({ path, sha256 }) => ({ path, sha256 })),
      hooks: FAMILIES.map((f) => sha(readQuiet(join(root, HOOK_FILES[f])))),
    },
    files, agents, notes, user_config,
  }))).digest('hex').slice(0, 16)

  const plan: InitPlan = {
    mode: 'dry_run', root, current, detected, seed: source === null ? null : { from: source }, questions: questionsFor(current, detected),
    files, workers: report, agents, notes, digest, user_config,
    next: `hazle al usuario las preguntas de questions; si alguna respuesta no es la primera opción, vuelve a ensayar con su flag. Muéstrale files, user_config, workers y notes y, si confirma, corre: ${o.command(digest)}`,
  }
  if (userSnapshot.current === null && answers.telemetry === undefined) plan.questions.push({
    id: 'telemetry', flag: '--telemetry', header: 'Telemetría',
    question: '¿Guardar metadatos locales de consumo, sin contenido, durante 30 días?',
    options: [
      { label: 'off (por defecto)', description: 'Sin publicaciones de telemetría.', value: 'off' },
      { label: 'on', description: 'Una línea privada por intento cerrado.', value: 'on' },
    ],
  })
  return { plan, workers, inventory }
}

/** El ensayo: el plan completo, sin escribir nada. */
export function planInit(root: string, answers: InitAnswers, env: Env, o: InitOptions): InitPlan {
  return compute(root, answers, env, o).plan
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

/** Valida el digest antes de escribir el checkout; un fallo de preferencia se informa por separado. */
export function applyInit(root: string, answers: InitAnswers, digest: string, env: Env, o: InitOptions): InitResult {
  const { plan, workers, inventory } = compute(root, answers, env, o)
  if (plan.digest !== digest) {
    throw new SddError('digest_mismatch', `el plan cambió desde el ensayo: su digest es ${plan.digest}, no ${digest}`, {
      next: `vuelve a ensayar y muéstrale el plan nuevo al usuario: ${o.command()}`,
    })
  }
  const written: string[] = []
  for (const f of plan.files) {
    if ((f.action === 'create' || f.action === 'update') && f.content !== undefined) {
      writeAtomic(join(root, f.path), f.content)
      written.push(f.path)
    }
  }
  const agents = plan.agents.length > 0 && workers !== null ? syncAgents(root, root, roleProfiles(workers, loadCodexRoot(env)), inventory) : null
  let userWritten = false
  try {
    writeUserTelemetry(plan.user_config)
    userWritten = plan.user_config.action !== 'unchanged'
  } catch {
    plan.notes.push({ code: 'telemetry_preference_unwritten', detail: `${plan.user_config.path}: no se escribió la preferencia de telemetría`,
      next: `desde una terminal con acceso, repite init --telemetry ${plan.user_config.proposed}, revisa el ensayo y aprueba la aplicación con su digest` })
  }
  const closing = [
    `Los perfiles de ${WORKERS_PATH} y las claves de la config que init no pregunta se cambian a mano.`,
    ...(agents === null ? [] : ['Reabre la sesión para que el CLI cargue los agentes y la skill.']),
    ...(plan.agents.some((change) => change.path.startsWith(`${MOD_PATH}/`)) ? [MOD_ADOPTION_MESSAGE] : []),
  ].join(' ')
  return {
    mode: 'applied', root, written, agents, workers: plan.workers, notes: plan.notes,
    user_config: { path: plan.user_config.path, action: plan.user_config.action, written: userWritten },
    doctor: doctor(o.exec, { copies: skillCopies(root, root) }, { copies: [modCopy(root, inventory)] }), closing,
  }
}
