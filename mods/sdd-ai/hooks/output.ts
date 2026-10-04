import type { LedgerRow, OriginalOutput, OutputDecision, Summary } from '../types'

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * El tamaño de una salida que Claude Code guardó aparte por grande (más de unos 30 KB): a la llamada le deja solo
 * un recorte de stdout, que no es el resultado completo.
 */
export function persistedSize(output: unknown): number | undefined {
  return record(output) && typeof output.persistedOutputPath === 'string' && typeof output.persistedOutputSize === 'number'
    ? output.persistedOutputSize
    : undefined
}

export function parseOutput(output: unknown, isErrored: boolean): OutputDecision {
  try {
    // Una interrupción se informa aunque la salida sea demasiado grande para resumirla.
    if (record(output) && output.interrupted === true) return { kind: 'interrupted' }
    if (persistedSize(output) !== undefined) return { kind: 'native' }
    let original: OriginalOutput
    let text: string
    if (record(output)) {
      if (typeof output.stdout !== 'string' || (output.stderr !== undefined && typeof output.stderr !== 'string')) return { kind: 'native' }
      original = { kind: 'streams', stdout: output.stdout, stderr: typeof output.stderr === 'string' ? output.stderr : '' }
      text = output.stdout
    } else if (typeof output === 'string') {
      original = { kind: 'text', text: output }
      text = output
    } else return { kind: 'native' }
    // trimEnd quita lo mismo que /\s+$/ en tiempo lineal: ese patrón retrocede de forma cuadrática ante una racha
    // larga de espacios que no llega al final, y esto corre en cada dibujo.
    text = text.trimEnd()
    let exitCode: number | undefined
    const prefix = /^(?:Error: )?Exit code (\d+)\n/.exec(text)
    if (prefix && isErrored) {
      exitCode = Number(prefix[1])
      if (!Number.isSafeInteger(exitCode)) return { kind: 'native' }
      text = text.slice(prefix[0].length)
    }
    if (!text.startsWith('{') || !text.endsWith('}')) return { kind: 'native' }
    const value: unknown = JSON.parse(text)
    if (!record(value)) return { kind: 'native' }
    const summary: Summary = { extra: [] }
    if (exitCode !== undefined) summary.exitCode = exitCode
    for (const [key, field] of Object.entries(value)) {
      if (key === 'ledger') {
        if (!Array.isArray(field) || !field.every((row: unknown) => record(row)
          && ['id', 'severity', 'state', 'claim'].every((name) => typeof row[name] === 'string')
          && (row.reviewer === undefined || typeof row.reviewer === 'string'))) return { kind: 'native' }
        summary.ledger = field as LedgerRow[]
      } else if (key === 'next') {
        if (typeof field === 'string') summary.next = [field]
        else if (record(field)) {
          // Se presentan step, command y question.question cuando son strings; todo lo demás de next queda avisado.
          const lines: string[] = []
          const presented = new Set<string>()
          for (const name of ['step', 'command']) {
            const value = field[name]
            if (typeof value === 'string') { lines.push(`${name}: ${value}`); presented.add(name) }
          }
          const question = field.question
          const questionShown = record(question) && typeof question.question === 'string'
          if (questionShown) { lines.push(`question: ${question.question}`); presented.add('question') }
          if (lines.length) summary.next = lines
          const more = Object.keys(field).some((name) => !presented.has(name))
            || (questionShown && Object.keys(question).some((name) => name !== 'question'))
          if (!lines.length || more) summary.extra.push(key)
        } else summary.extra.push(key)
      } else if (key === 'state' || key === 'code' || key === 'message' || key === 'detail') {
        if (typeof field === 'string') summary[key] = field
        else summary.extra.push(key)
      } else summary.extra.push(key)
    }
    return { kind: 'summary', summary, original }
  } catch {
    return { kind: 'native' }
  }
}
