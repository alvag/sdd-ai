import type { RenderElement } from 'claude-code'
import type { SessionViews } from '../types'
import type { Observed } from './projection'
import { chunks } from './render'

const gateMeaning = {
  pending: 'pendiente de aprobación', approved: 'aprobación vigente con huella',
  approved_unfingerprinted: 'aprobación sin huella; no acredita vigencia', stale: 'aprobación desactualizada',
} as const
const valueOf = <T,>(value: Observed<T>): string => value.reason !== null
  ? `desconocido (${value.reason.code}: ${value.reason.detail})` : String(value.value)

/** Árbol de datos puro: no recibe el motor ni consulta el dominio. */
function viewTree(views: SessionViews | undefined, budget: number, bodyColumns: number, now: number, detail: boolean): RenderElement {
  const lines: string[] = []
  let cost = 0
  let reserved = 0
  const add = (text: string): boolean => {
    if (cost + text.length + reserved > budget) return false
    lines.push(text); cost += text.length
    return true
  }
  const appendList = (items: string[], label: string) => {
    // Reservar la cuenta antes de admitir un prefijo de entradas completas.
    const reserve = `faltan ${items.length} ${label}`.length
    let shown = 0
    for (const item of items) {
      if (cost + item.length + reserve + reserved > budget) break
      add(item); shown++
    }
    if (shown < items.length) add(`faltan ${items.length - shown} ${label}`)
  }
  add(detail ? 'sdd-ai · panel de sesión' : 'sdd-ai · corridas de sesión')
  if (!views?.selection) {
    add(`Datos no disponibles: ${views?.unavailable ?? 'projection_unavailable'}`)
  } else {
    const selection = views.selection
    // Los encabezados y el detalle del flujo no pueden consumir el aviso de corridas faltantes: se reserva primero.
    reserved = selection.runs.items.length ? `faltan ${selection.runs.items.length} corridas`.length : 0
    const linked = selection.binding.flow
    if (linked) add(`Flujo ${linked.id} · paso observado ${linked.step}${linked.gate ? ` · gate ${linked.gate}` : ''}`)
    else add(selection.binding.known ? 'Sin flujo ligado' : `Liga no disponible${selection.binding.reason ? `: ${selection.binding.reason.detail}` : ''}`)
    if (views.retained) add('Última lectura de esta identidad; no es una observación actual')
    if (views.observedAt !== null) add(`Observado hace ${Math.max(0, Math.floor((now - views.observedAt) / 1000))} s`)
    if (selection.runs.availability !== 'available') add(`Inventario ${selection.runs.availability}${selection.runs.reason ? `: ${selection.runs.reason.detail}` : ''}`)
    if (selection.writerAvailability !== 'available') add('Control del writer no disponible')
    if (selection.omitted) add(`${selection.omitted} corridas omitidas por falta de atribución`)
    if (linked && (selection.flow?.view.value === null || !selection.flow)) {
      add(`Vista del flujo no disponible${selection.flow?.view.reason ? `: ${selection.flow.view.reason.detail}` : ''}; gates, tasks y bloqueos desconocidos`)
    }
    if (detail && selection.flow?.view.value) {
      const flow = selection.flow.view.value
      const tasks = flow.tasks
      add(`Tasks: total ${tasks.total} · hechas ${tasks.done} · pendientes ${tasks.pending} · primera pendiente ${tasks.first_pending ?? 'ninguna'}`)
      const blockedReserve = flow.blocked_reasons.length ? `faltan ${flow.blocked_reasons.length} bloqueos`.length : 0
      reserved += blockedReserve
      appendList(flow.gates.map((gate) => `Gate ${gate.gate}: ${gate.state} · ${gateMeaning[gate.state]} · ${gate.artifacts.join(', ')}`), 'gates')
      reserved -= blockedReserve
      if (!flow.blocked_reasons.length) add('Sin motivos de bloqueo publicados')
      appendList(flow.blocked_reasons.map((reason) => `Bloqueo ${reason.code}: ${reason.detail}`), 'bloqueos')
    }
    reserved = 0
    if (!selection.runs.items.length) add(selection.runs.availability === 'available' && selection.writerAvailability === 'available' && !selection.omitted
      ? 'Sin corridas propias abiertas' : 'No se puede comprobar la ausencia de corridas propias')
    appendList(selection.runs.items.map(({ run, writer, kind }) => [
      `${run.id}${writer ? ' · writer protegido' : ''}`, `clase: ${valueOf(kind)}`, `ejecución: ${valueOf(run.state)}`,
      `apertura: ${valueOf(run.open)}`, `flujo: ${valueOf(run.flow)}`,
    ].join(bodyColumns < 80 ? '\n' : ' · ')), 'corridas')
  }
  return { type: 'Box', props: { flexDirection: 'column' }, children: lines.flatMap((line) =>
    chunks(line).map((text) => ({ type: 'Text' as const, props: { wrap: 'wrap' as const }, children: [text] }))) }
}

export function panelTree(views: SessionViews | undefined, budget: number, bodyColumns: number, now: number): RenderElement {
  return viewTree(views, budget, bodyColumns, now, true)
}
export function runsTree(views: SessionViews | undefined, budget: number, bodyColumns: number, now: number): RenderElement {
  return viewTree(views, budget, bodyColumns, now, false)
}
