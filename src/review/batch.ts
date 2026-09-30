import { SddError } from '../types.ts'
import { parseLocation } from './admit.ts'
import type { Candidate, CandidateFile } from './candidate.ts'
import { numbered, sections } from './diff.ts'
import type { LedgerEntry, Reviewer, RoundPlan, Target } from './ledger.ts'
import { REVIEW_PROMPT_BUDGET, measure, renderLensRoundPrompt, renderMaterial, renderRoundPrompt } from './prompt.ts'

/**
 * La vista de un lote: sus archivos y sus secciones del diff, con el mismo hash y el mismo contexto.
 * El revisor del lote ve el manifiesto completo, pero se lo admite contra esta vista.
 */
export function sliceCandidate(c: Candidate, paths: string[]): Candidate {
  const keep = new Set(paths)
  return {
    ...c,
    files: c.files.filter((f) => keep.has(f.path)),
    diff: sections(c.diff, c.files).filter((s) => keep.has(s.path)).map((s) => s.text).join(''),
  }
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * Reparte los archivos en lotes de archivos completos que entran en el presupuesto. `measure` da los
 * bytes del prompt más grande de un lote; `first` dice si es el primero, que además lleva los
 * pendientes sin archivo. Los archivos de un directorio van juntos mientras entren, y uno que no entra
 * se reparte por orden de ruta. El mismo candidato da siempre los mismos lotes.
 */
export function planBatches(files: CandidateFile[], measure: (paths: string[], first: boolean) => number,
  budget: number, sectionBytes: (path: string) => number): string[][] {
  const all = files.map((f) => f.path).sort((a, b) => a.localeCompare(b))
  if (measure(all, true) <= budget) return [all]
  const alone = measure([], true)
  if (alone > budget) {
    throw new SddError('prompt_too_large', 'el contexto solo no entra en el presupuesto', {
      detail: `${alone} > ${budget}`,
      next: 'review no puede revisar con este contexto: pregunta al usuario qué contexto quitar',
    })
  }
  for (const f of all) {
    const bytes = measure([f], false)
    if (bytes > budget) {
      throw new SddError('prompt_too_large', `el archivo ${f} no entra solo en el presupuesto`, {
        detail: `${f}: su sección numerada mide ${sectionBytes(f)} bytes; el prompt con ese archivo solo mide ${bytes} > ${budget}`,
        next: `review no puede revisar ${f}: pregunta al usuario si lo saca del cambio o lo revisa por fuera de review`,
      })
    }
  }

  const groups = new Map<string, string[]>()
  for (const f of all) groups.set(dirOf(f), [...(groups.get(dirOf(f)) ?? []), f])
  const lots: string[][] = []
  let current: string[] = []
  // El primer lote puede cerrarse vacío: pasa cuando los pendientes sin archivo entran solos pero no
  // junto a ningún archivo.
  const place = (paths: string[]): boolean => {
    if (measure([...current, ...paths], lots.length === 0) <= budget) {
      current.push(...paths)
      return true
    }
    if (measure(paths, false) > budget) return false
    lots.push(current)
    current = [...paths]
    return true
  }
  for (const group of groups.values()) {
    if (place(group)) continue
    for (const f of group) place([f])
  }
  lots.push(current)
  return lots
}

/**
 * Los pendientes de un lote: los de las rutas del lote, con la ruta nueva si la cita es de la anterior
 * a un renombre. Los que citan el contexto o un archivo que ya no está van al primer lote.
 */
export function lotTargets(targets: Target[], entries: LedgerEntry[], c: Candidate, paths: string[], first: boolean): Target[] {
  const inLot = new Set(paths)
  return targets.filter((t) => {
    const e = entries.find((x) => x.id === t.id)
    const cited = e ? parseLocation(e.location).path : undefined
    const file = c.files.find((f) => f.path === cited) ?? c.files.find((f) => f.from === cited)
    return file ? inLot.has(file.path) : first
  })
}

/** Un trabajo planificado: su prompt ya renderizado y medido, todavía sin archivo. */
export interface PlannedJob { key: string; reviewer: Reviewer; batch: number; paths: string[]; text: string; targets?: Target[] }

/** Los bytes de la sección numerada de cada archivo: lo que el mensaje de un archivo que no entra informa. */
function sectionSizes(c: Candidate): (path: string) => number {
  const bytes = new Map(sections(c.diff, c.files).map((s) => {
    const deleted = c.files.find((f) => f.path === s.path)?.status === 'D'
    return [s.path, Buffer.byteLength(numbered(s.text, deleted))]
  }))
  return (path) => bytes.get(path) ?? 0
}

/**
 * Los trabajos de una ronda 1: un reparto único para todos los revisores, calculado con el prompt más
 * grande, y un trabajo por revisor y lote, en ese orden. Cada prompt se mide con la reserva de
 * corrección antes de devolverlo, así que ninguno se lanza si alguno no entra.
 */
export function planJobs(c: Candidate, reviewers: readonly Reviewer[], render: (r: Reviewer, paths: string[]) => string):
  { batches: string[][]; jobs: PlannedJob[] } {
  const largest = (paths: string[]) => Math.max(...reviewers.map((r) => measure(render(r, paths))))
  const batches = planBatches(c.files, largest, REVIEW_PROMPT_BUDGET, sectionSizes(c))
  const jobs = reviewers.flatMap((reviewer) => batches.map((paths, i) =>
    ({ key: `${reviewer}-b${i + 1}`, reviewer, batch: i + 1, paths, text: render(reviewer, paths) })))
  return { batches, jobs }
}

function pendingBlock(where: string, bytes: number): SddError {
  return new SddError('prompt_too_large', `el bloque de pendientes ${where} no entra en el presupuesto`, {
    detail: `${bytes} > ${REVIEW_PROMPT_BUDGET}`,
    next: 'review no puede verificar esos pendientes en un solo prompt: pregunta al usuario cómo seguir',
  })
}

/**
 * Los trabajos de una ronda N, que es una pasada dirigida de la base: uno solo si el prompt entero
 * entra; si no, uno por lote, cada uno con los pendientes de su lote. Si el reparto falla, se vuelve a
 * medir sin pendientes para decir si lo que no entra es un archivo, el contexto o un bloque de
 * pendientes. Con lentes, el reparto se mide con el prompt más grande entre la base con sus pendientes y
 * cada lente; los pendientes quedan en la base y las lentes van con `targets: []`, solo en los lotes
 * que tienen rutas.
 */
export function planRoundJobs(c: Candidate, contextTexts: Map<string, string>, plan: RoundPlan, entries: LedgerEntry[],
  cap: number, reviewers: readonly Reviewer[] = ['base']): { reviewers: readonly Reviewer[]; batches: string[][]; jobs: PlannedJob[] } {
  const all = c.files.map((f) => f.path)
  const lenses = all.length === 0 ? [] : reviewers.filter((r): r is Exclude<Reviewer, 'base'> => r !== 'base')
  const plannedReviewers: readonly Reviewer[] = ['base', ...lenses]
  const whole = renderRoundPrompt(c, renderMaterial(c, contextTexts), plan, entries, cap)
  const wholeMaterial = lenses.length > 0 ? renderMaterial(c, contextTexts) : ''
  const wholeLens = lenses.map((lens) => renderLensRoundPrompt(c, wholeMaterial, plan, lens, cap))
  if (Math.max(measure(whole), ...wholeLens.map(measure)) <= REVIEW_PROMPT_BUDGET) {
    return {
      reviewers: plannedReviewers, batches: [all],
      jobs: [
        { key: 'base-b1', reviewer: 'base', batch: 1, paths: all, text: whole },
        ...lenses.map((lens, i): PlannedJob => ({ key: `${lens}-b1`, reviewer: lens, batch: 1, paths: all, targets: [], text: wholeLens[i] as string })),
      ],
    }
  }
  const lotPlan = (paths: string[], goals: Target[]): RoundPlan =>
    ({ ...plan, targets: goals, changed: Object.fromEntries(Object.entries(plan.changed).filter(([p]) => paths.includes(p))) })
  const render = (paths: string[], goals: Target[]) =>
    renderRoundPrompt(c, renderMaterial(c, contextTexts, sliceCandidate(c, paths)), lotPlan(paths, goals), entries, cap, paths)
  const renderLens = (lens: Exclude<Reviewer, 'base'>, paths: string[]) =>
    renderLensRoundPrompt(c, renderMaterial(c, contextTexts, sliceCandidate(c, paths)), lotPlan(paths, []), lens, cap, paths)
  const withPending = (paths: string[], first: boolean) => Math.max(
    measure(render(paths, lotTargets(plan.targets, entries, c, paths, first))),
    ...lenses.map((lens) => measure(renderLens(lens, paths))),
  )
  let batches: string[][]
  try {
    batches = planBatches(c.files, withPending, REVIEW_PROMPT_BUDGET, sectionSizes(c))
  } catch (e) {
    if (!(e instanceof SddError) || e.code !== 'prompt_too_large') throw e
    const bare = (paths: string[]) => measure(render(paths, []))
    if (bare([]) > REVIEW_PROMPT_BUDGET) throw e
    const orphans = withPending([], true)
    if (orphans > REVIEW_PROMPT_BUDGET) throw pendingBlock('sin archivo', orphans)
    const file = [...all].sort((a, b) => a.localeCompare(b)).find((p) => withPending([p], false) > REVIEW_PROMPT_BUDGET)
    if (file && bare([file]) <= REVIEW_PROMPT_BUDGET) throw pendingBlock(`de ${file}`, withPending([file], false))
    throw e
  }
  const baseJobs = batches.map((paths, i): PlannedJob => {
    const goals = lotTargets(plan.targets, entries, c, paths, i === 0)
    return { key: `base-b${i + 1}`, reviewer: 'base', batch: i + 1, paths, targets: goals, text: render(paths, goals) }
  })
  const lensJobs = lenses.flatMap((lens) => batches.flatMap((paths, i): PlannedJob[] =>
    paths.length === 0 ? [] : [{ key: `${lens}-b${i + 1}`, reviewer: lens, batch: i + 1, paths, targets: [], text: renderLens(lens, paths) }]))
  return { reviewers: plannedReviewers, batches, jobs: [...baseJobs, ...lensJobs] }
}
