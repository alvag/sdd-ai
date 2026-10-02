import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, readStatus } from '../runs.ts'
import type { Family, Resolution, Status } from '../types.ts'
import { verifyProjectionOf } from '../sdd/verify.ts'
import { type ArtifactSelection, freezeArtifact, inputsUnchanged, isArtifact } from './artifact.ts'
import { type Candidate, type Selection, baseOf, candidateHash, freeze, readContextFile, sha256 as candidateSha256 } from './candidate.ts'
import { type Ledger, type RoundPlan, targets, undecided } from './ledger.ts'
import type { RiskRecord } from './risk.ts'
import { SddError } from '../types.ts'

export interface ReviewRequest {
  /** Un diff, o un artefacto con sus insumos: una corrida anterior a los artefactos siempre es un diff. */
  kind: 'review'; selection: Selection | ArtifactSelection; author: Family; degradations: string[]
  overrides?: { families?: string; model?: string; effort?: string; deadline_sec?: number }
  /** El nivel congelado al empezar; una corrida anterior a la clasificación no lo trae. */
  risk?: RiskRecord
  /** El flujo al que pertenece la revisión. */
  flow?: string
}

/** Lo que una selección arrastra entre rondas y reinicios: los archivos nuevos y la cosecha. */
export const untrackedOf = (sel: Selection): Pick<Selection, 'untracked' | 'harvest'> =>
  ({ ...(sel.untracked ? { untracked: true } : {}), ...(sel.harvest ? { harvest: sel.harvest } : {}) })

export function resolvesTo(root: string, ref: string | undefined, sha: string | null): boolean {
  if (!ref || !sha) return true
  try {
    return freeze(root, { base: ref, context: [] }).base_sha === sha
  } catch {
    return false
  }
}

/**
 * Vigencia del candidato: con `--head`, reconstruye con los SHAs congelados y solo informa si el ref
 * se movió; sin `--head`, reconstruye con la misma base y el mismo contexto sobre el árbol. Si la
 * reconstrucción falla, cuenta como `stale`.
 */
export interface Freshness { stale: boolean; ref_moved?: boolean; stale_reason?: 'inputs' | 'artifact'; verify_projection?: Array<{ path: string; receipt: string }> }

export function freshness(root: string, dir: string, req: ReviewRequest, c: Candidate, head: string | undefined): Freshness {
  if (isArtifact(req.selection)) return artifactFreshness(root, req.selection, c)
  const sel = req.selection
  let moved: Pick<Freshness, 'ref_moved'> = {}
  try {
    const rebuilt = c.head_sha
      ? freeze(root, { base: baseOf(c), head: c.head_sha, context: sel.context })
      : freeze(root, { base: sel.base, context: sel.context, ...untrackedOf(sel) })
    moved = c.head_sha ? { ref_moved: !resolvesTo(root, head, c.head_sha) || !resolvesTo(root, sel.base, c.base_sha) } : {}
    // Las dos versiones se comparan sin el directorio del flujo, con su hash recalculado: verifyProjections
    // recibe esas versiones, no el candidato congelado tal cual.
    const frozenView = withoutFlowDir(c, req.flow)
    const rebuiltView = withoutFlowDir(rebuilt, req.flow)
    if (rebuiltView.hash === frozenView.hash) return { stale: false, ...moved }
    const projection = verifyProjections(root, dir, frozenView, rebuiltView)
    return projection ? { stale: false, ...moved, verify_projection: projection } : { stale: true, ...moved }
  } catch {
    return { stale: true, ...moved }
  }
}

/**
 * El candidato sin los archivos del directorio de su flujo. Los verbos del flujo escriben ahí (el lock, el
 * registro, el header), y si `.plans/` no está ignorado esas escrituras vencerían la revisión del árbol que se
 * va a commitear, que nunca los incluye.
 */
function withoutFlowDir(c: Candidate, flow: string | undefined): Candidate {
  if (flow === undefined) return c
  const own = `.plans/${flow}/`
  let changed = false
  // Un renombre que cruza el borde del directorio del flujo conserva su lado de afuera: si sale, es un alta del
  // destino; si entra, un borrado del origen. Así un árbol da la misma vista lo detecte Git como renombre o no.
  const files = c.files.flatMap((f) => {
    const inside = f.path.startsWith(own)
    const fromInside = f.from?.startsWith(own) ?? false
    if (f.from !== undefined && inside !== fromInside) {
      changed = true
      const { from, ...rest } = f
      return [inside ? { ...rest, path: from, status: 'D' as const } : { ...rest, status: 'A' as const }]
    }
    if (inside) {
      changed = true
      return []
    }
    return [f]
  })
  if (!changed) return c
  const stripped = { ...c, files }
  return { ...stripped, hash: candidateHash(stripped) }
}

/**
 * Si lo único que cambió del contexto desde que se congeló es la proyección de `sdd verify` en un plan,
 * respaldada por un recibo íntegro, y con los sha congelados el hash vuelve a ser el de la revisión.
 * Devuelve cada contexto reconocido con su recibo, o `null` si algo más cambió.
 */
export function verifyProjections(root: string, dir: string, c: Candidate, again: Candidate): Array<{ path: string; receipt: string }> | null {
  if (c.context.length !== again.context.length || c.context.some((x, i) => x.path !== again.context[i].path)) return null
  const found: Array<{ path: string; receipt: string }> = []
  for (const [i, frozen] of c.context.entries()) {
    const now = again.context[i]
    if (frozen.sha256 === now.sha256) continue
    const current = readContextFile(root, frozen.path).bytes
    if (candidateSha256(current) !== now.sha256) return null
    const receipt = verifyProjectionOf(root, frozen.path, readFileSync(join(dir, 'blobs', frozen.sha256), 'utf8'), current.toString('utf8'))
    if (receipt === null) return null
    found.push({ path: frozen.path, receipt })
  }
  if (found.length === 0) return null
  const restored = again.context.map((x, i) => (found.some((f) => f.path === x.path) ? c.context[i] : x))
  return candidateHash({ ...again, context: restored }) === c.hash ? found : null
}

/**
 * Vigencia de un artefacto, sin Git: primero los insumos y el contexto, porque un cambio ahí invalida la
 * revisión entera; después el artefacto, que cambia a propósito entre rondas.
 */
export function artifactFreshness(root: string, sel: ArtifactSelection, c: Candidate): Freshness {
  if (!inputsUnchanged(root, c)) return { stale: true, stale_reason: 'inputs' }
  try {
    return freezeArtifact(root, sel).candidate.hash === c.hash ? { stale: false } : { stale: true, stale_reason: 'artifact' }
  } catch (e) {
    if (e instanceof SddError) return { stale: true, stale_reason: 'artifact' }
    throw e
  }
}

export const REVIEW_LOCK = 'review.lock'

export function converged(dir: string, s: Status, ledger: Ledger): boolean {
  return s.state === 'done' && ledger.completed === (s.round ?? 1)
    && undecided(ledger).length === 0 && targets(ledger).length === 0 && !existsSync(join(dir, REVIEW_LOCK))
}

export interface ReviewStanding {
  id: string; flow: string | null; artifact: boolean; family: Family; degradations: string[]
  covers: { base_sha: string; whole_tree: boolean }; converged: boolean
  /** Con `check: 'fresh'`: la vigencia completa. Sin calcular si la revisión no cubre la base pedida o no convergió. */
  fresh?: boolean
  /** Con `check: 'files'`: los archivos son los del árbol de ahora, sin mirar el contexto. Mismo cálculo perezoso. */
  sameFiles?: boolean
}

/** La vigencia completa (`fresh`) o solo los archivos, sin el contexto (`files`). */
export type StandingCheck = 'fresh' | 'files'

const requestOf = (root: string, run: string) => readJson<ReviewRequest>(join(root, '.sdd-ai', 'runs', run, 'request.json'))

/**
 * El estado de una revisión. La comprobación cara (`fresh` o `sameFiles`) recongela el árbol, así que con
 * `baseCommit` solo se calcula si la revisión cubre el candidato entero de esa base y convergió.
 */
export function reviewStanding(root: string, run: string, check: StandingCheck = 'fresh',
  o: { req?: ReviewRequest; baseCommit?: string } = {}): ReviewStanding {
  const dir = join(root, '.sdd-ai', 'runs', run)
  const req = o.req ?? requestOf(root, run)
  if (req.kind !== 'review') throw new Error('no es una revisión')
  const s = readStatus(dir)
  const ledgerFile = join(dir, 'ledger.json')
  const ledger = existsSync(ledgerFile) ? readJson<Ledger>(ledgerFile) : null
  const round = ledger?.completed || 1
  const tag = round === 1 ? '' : `-r${round}`
  const c = readJson<Candidate>(join(dir, `candidate${tag}.json`))
  const artifact = isArtifact(req.selection)
  const sel = req.selection
  const head = round === 1 ? (isArtifact(sel) ? undefined : sel.head)
    : readJson<RoundPlan>(join(dir, `round${tag}.json`)).head
  const standing: ReviewStanding = {
    id: run, flow: req.flow ?? null, artifact,
    family: readJson<Resolution>(join(dir, 'resolved.json')).family, degradations: req.degradations,
    covers: { base_sha: c.base_sha ?? '', whole_tree: !isArtifact(sel) && !!(sel.untracked || sel.harvest) && !sel.head },
    converged: ledger !== null && converged(dir, s, ledger),
  }
  // La comprobación cara solo vale la pena si la revisión ya sirve en todo lo demás.
  if (o.baseCommit !== undefined && !coversAndConverged(standing, o.baseCommit)) return standing
  if (check === 'fresh') return { ...standing, fresh: !freshness(root, dir, req, c, head).stale }
  let sameFiles = false
  if (!isArtifact(sel)) {
    try {
      const again = freeze(root, { base: baseOf(c), context: [], ...untrackedOf(sel) })
      const files = (candidate: Candidate) => withoutFlowDir(candidate, req.flow).files.map(({ path, status, from, mode, sha256 }) => ({ path, status, from, mode, sha256 }))
      sameFiles = JSON.stringify(files(c)) === JSON.stringify(files(again))
    } catch {
      // Un candidato que no se puede reconstruir no respalda el árbol actual.
    }
  }
  return { ...standing, sameFiles }
}

export type FlowReview =
  | { ok: true; review: { id: string; family: Family; degradations: string[] } }
  | { ok: false; reason: 'review_missing' | 'review_partial' | 'review_not_converged' | 'review_stale'; latest?: string }

/** Si la revisión cubre el candidato entero de esa base y convergió: todo lo que no exige recongelar el árbol. */
function coversAndConverged(r: Pick<ReviewStanding, 'covers' | 'converged'>, baseCommit: string): boolean {
  return r.covers.whole_tree && r.covers.base_sha === baseCommit && r.converged
}

/** Por qué una revisión del flujo no sirve, en el orden de prioridad del plan; `null` si sirve. */
function unfitReason(r: ReviewStanding, baseCommit: string, check: StandingCheck): Exclude<FlowReview, { ok: true }>['reason'] | null {
  if (!r.covers.whole_tree || r.covers.base_sha !== baseCommit) return 'review_partial'
  if (!r.converged) return 'review_not_converged'
  if (!(check === 'fresh' ? r.fresh : r.sameFiles)) return 'review_stale'
  return null
}

function findFlowReview(root: string, flow: string, baseCommit: string, check: StandingCheck): FlowReview {
  const runs = join(root, '.sdd-ai', 'runs')
  if (!existsSync(runs)) return { ok: false, reason: 'review_missing' }
  let latest: FlowReview | undefined
  for (const run of readdirSync(runs).sort().reverse()) {
    try {
      // Antes de recongelar nada, el request barato descarta las corridas que no son revisiones de este flujo.
      const req = requestOf(root, run)
      if (req.kind !== 'review' || req.flow !== flow || isArtifact(req.selection)) continue
      const r = reviewStanding(root, run, check, { req, baseCommit })
      const reason = unfitReason(r, baseCommit, check)
      if (reason === null) return { ok: true, review: { id: run, family: r.family, degradations: r.degradations } }
      latest ??= { ok: false, reason, latest: run }
    } catch {
      // Una corrida ilegible se salta.
    }
  }
  return latest ?? { ok: false, reason: 'review_missing' }
}

export function flowReview(root: string, flow: string, baseCommit: string): FlowReview {
  return findFlowReview(root, flow, baseCommit, 'fresh')
}

export function flowReviewBacking(root: string, flow: string, baseCommit: string): FlowReview {
  return findFlowReview(root, flow, baseCommit, 'files')
}

/** Un argumento listo para pegar en la shell: tal cual si es seguro, entre comillas simples si no. */
export const shellArg = (s: string) => /^[\w./@:+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`

/**
 * La revisión final de un flujo, atada a él: el árbol entero contra la base del plan o, con `harvest`, la cosecha
 * de un writer. Todo lo que viene del flujo pasa por `shellArg`: el comando se propone para ejecutarse tal cual.
 */
export function reviewStartCommand(flow: string, base: string, harvest?: { run: string; author: string }): string {
  return harvest
    ? `./bin/sdd-ai review start --harvest ${shellArg(harvest.run)} --base ${shellArg(base)} --author ${shellArg(harvest.author)} --flow ${shellArg(flow)}`
    : `./bin/sdd-ai review start --base ${shellArg(base)} --untracked --flow ${shellArg(flow)}`
}
