import { nodeMetadata } from '../recall.ts'
import { SddError } from '../types.ts'

export interface ArchiveNode { bytes: Buffer; state: 'archived'; date: string; summary: string }

/** No transforma el resumen: el lector compartido debe devolverlo literalmente. */
export function buildArchiveNode(input: { flow: string; project: string; date: string; summary: string }): ArchiveNode {
  if (typeof input.summary !== 'string' || !input.summary.trim() || /[\r\n\u2028\u2029]/.test(input.summary)) {
    throw new SddError('archive_summary_invalid', 'el vault exige un resumen no vacío de una sola línea')
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.date)
    || Number.isNaN(Date.parse(input.date))) throw new SddError('archive_node_invalid', 'la fecha debe ser ISO con zona horaria')
  if ([input.flow, input.project].some((value) => !value || /[\r\n]/.test(value))) throw new SddError('archive_node_invalid', 'identidad no representable en el nodo')
  const text = ['---', 'type: sdd-flow', `title: ${input.flow}`, `project: ${input.project}`, `flow: ${input.flow}`,
    'state: archived', `date: ${input.date}`, `summary: ${input.summary}`, '---', '', `# ${input.flow}`, '',
    'Archivo local; no acredita cierre ni aprobaciones de gates.', ''].join('\n')
  const metadata = nodeMetadata(text)
  if (metadata.summary !== input.summary || metadata.date !== input.date || metadata.state !== 'archived') {
    throw new SddError('archive_summary_invalid', 'el resumen no se conserva literalmente con el lector del vault')
  }
  return { bytes: Buffer.from(text), state: 'archived', date: input.date, summary: input.summary }
}
