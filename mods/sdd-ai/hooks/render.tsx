import type { Elements, ToolGroupCall } from 'claude-code'
import type { LedgerRow, OriginalOutput, OutputDecision, Summary } from '../types'
import { recognizeCommand } from './command'
import { parseOutput, persistedSize, record } from './output'

export type TerminalElements = Elements['terminal']

// El motor rechaza un Text de más de 10 000 caracteres y un árbol con más de 100 000 caracteres de texto
// o con caracteres de control distintos del tabulador y el salto de línea: dibuja el suyo en su lugar.
const TEXT_LIMIT = 10_000
const TREE_TEXT_LIMIT = 100_000
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** Los textos largos van en tramos de este tamaño, con margen bajo el límite de cada Text. */
const CHUNK = 8000

/** La sangría con la que el motor dibuja un resultado, delante de lo que devuelve el mod. */
export const RESULT_INDENT = 5
/** La sangría con la que el mod anida cada llamada de un grupo. */
const CALL_PADDING = 2
/**
 * El ancho de terminal que se supone sin viewport, para recortar. Sin viewport el ledger va siempre en bloques, porque
 * no se sabe si la terminal llega al mínimo de la tabla.
 */
export const UNMEASURED_COLUMNS = 79
/** El ancho de una llamada del grupo sin viewport, descontadas las dos sangrías. */
const UNMEASURED_CALL_WIDTH = UNMEASURED_COLUMNS - RESULT_INDENT - CALL_PADDING
/** Desde cuántas columnas de terminal el ledger es una tabla, y el ancho mínimo que necesita la afirmación en ella. */
const TABLE_MIN_COLUMNS = 80
const CLAIM_MIN_WIDTH = 20
/** Cuántas líneas de su ancho ocupa una afirmación antes de recortarse con elipsis. */
const CLAIM_LINES = 3
/** El rótulo de una llamada reconocida y el mínimo que se conserva de un comando o una entrada al recortarlos. */
const LABEL = 'sdd-ai: '
const MIN_INPUT_WIDTH = 10
/** Lo que separa la herramienta de su entrada en la línea de una llamada ajena. */
const TOOL_SEPARATOR = ': '
/**
 * Las columnas fijas de la tabla del ledger, con el ancho de los valores que emite el binario: la severidad más larga
 * es `SUGGESTION`, el revisor más largo `reliability` o `readability`, y el estado frecuente más largo `informativo`.
 * Un valor más largo, como `fuera-de-alcance`, envuelve dentro de su columna.
 */
const LEDGER_COLUMNS: readonly { label: string; width: number; value: (row: LedgerRow) => string }[] = [
  { label: 'id', width: 5, value: (row) => row.id },
  { label: 'severity', width: 10, value: (row) => row.severity },
  { label: 'reviewer', width: 11, value: (row) => row.reviewer ?? '' },
  { label: 'state', width: 11, value: (row) => row.state },
]
/** Lo que ocupan las columnas fijas, cada una con su separador de un espacio; la afirmación recibe el resto. */
const FIXED_TABLE_WIDTH = LEDGER_COLUMNS.reduce((total, column) => total + column.width + 1, 0)

/** Parte un texto en tramos que entran en un Text; corta en un salto de línea cuando puede. */
export function chunks(text: string, size = CHUNK): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest.length > size) {
    const newline = rest.lastIndexOf('\n', size)
    if (newline > 0) {
      pieces.push(rest.slice(0, newline))
      rest = rest.slice(newline + 1)
      continue
    }
    // Un corte forzado no separa un par sustituto.
    const cut = /[\uD800-\uDBFF]/.test(rest[size - 1] ?? '') ? size - 1 : size
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  pieces.push(rest)
  return pieces
}

/**
 * Si el motor acepta los textos del árbol: ninguno pasa de 10 000 caracteres, entre todos no pasan de 100 000 y
 * ninguno trae caracteres de control prohibidos. Quien dibuja continúa con la vista nativa si no.
 */
export function treeFits(tree: JSX.Element): boolean {
  let total = 0
  const visit = (node: unknown): boolean => {
    if (typeof node === 'string') {
      total += node.length
      return node.length <= TEXT_LIMIT && total <= TREE_TEXT_LIMIT && !FORBIDDEN_CONTROL.test(node)
    }
    if (Array.isArray(node)) return node.every(visit)
    if (node !== null && typeof node === 'object' && 'children' in node) return visit((node as { children?: unknown }).children)
    return true
  }
  return visit(tree)
}

/**
 * Coste del texto propio, sin atribuir un coste al nodo nativo engine. Una celda de ancho fijo (las columnas de la
 * tabla del ledger) cuesta al menos su ancho más su margen, porque el motor cuenta el texto ya rellenado hasta ese ancho.
 */
export function textCost(tree: unknown): number {
  if (typeof tree === 'string') return tree.length
  if (Array.isArray(tree)) return tree.reduce((sum, child) => sum + textCost(child), 0)
  if (tree === null || typeof tree !== 'object' || !('children' in tree)) return 0
  const own = textCost((tree as { children?: unknown }).children)
  const props = (tree as { props?: { width?: unknown; marginRight?: unknown } }).props
  if (typeof props?.width !== 'number') return own
  return Math.max(own, props.width) + (typeof props.marginRight === 'number' ? props.marginRight : 0)
}

function hasControls(tree: unknown): boolean {
  if (typeof tree === 'string') return FORBIDDEN_CONTROL.test(tree)
  if (Array.isArray(tree)) return tree.some(hasControls)
  return tree !== null && typeof tree === 'object' && 'children' in tree ? hasControls((tree as { children?: unknown }).children) : false
}

function wrapped(ui: TerminalElements, key: string, text: string, props: { dimColor?: boolean; bold?: boolean } = {}): JSX.Element[] {
  const { Text } = ui
  return chunks(text).map((piece, index) => <Text key={`${key}-${index}`} wrap="wrap" {...props}>{piece}</Text>)
}

/** Una línea de hasta `width` caracteres; si sobra, termina en elipsis sin separar un par sustituto. */
const shorten = (text: string, width: number): string => {
  const line = text.replace(/\s+/g, ' ')
  if (line.length <= width) return line
  let cut = Math.max(0, width - 1)
  if (/[\uD800-\uDBFF]/.test(line[cut - 1] ?? '')) cut--
  return `${line.slice(0, cut)}…`
}

/**
 * El resumen de una llamada. `columns` es el ancho de la terminal, que decide la tabla; `available`, el ancho que le
 * queda al resumen después de las sangrías, que calcula quien lo llama (con `UNMEASURED_COLUMNS` si no hay viewport).
 */
type SummaryInput = { summary: Summary; command: string; isErrored: boolean; columns?: number; available: number }
function fullSummaryTree(ui: TerminalElements, input: SummaryInput): JSX.Element {
  const { Box, Text } = ui
  const { summary, command, isErrored, columns, available } = input
  const claimWidth = available - FIXED_TABLE_WIDTH
  const table = columns !== undefined && columns >= TABLE_MIN_COLUMNS && claimWidth >= CLAIM_MIN_WIDTH
  return <Box flexDirection="column">
    {wrapped(ui, 'command', `${LABEL}${shorten(command, Math.max(MIN_INPUT_WIDTH, available - LABEL.length))}`, { bold: true })}
    {isErrored ? <Text>{`Bash: falló${summary.exitCode === undefined ? '' : ` · código de salida: ${summary.exitCode}`}`}</Text> : null}
    {(['state', 'code', 'message', 'detail'] as const).map((key) => summary[key] === undefined ? null : wrapped(ui, key, `${key}: ${summary[key]}`))}
    {summary.next?.map((line, index) => wrapped(ui, `next-${index}`, `${index === 0 ? 'next: ' : ''}${line}`))}
    {summary.extra.length ? wrapped(ui, 'extra', `Más campos en la salida original: ${summary.extra.join(', ')}`, { dimColor: true }) : null}
    {summary.ledger?.length === 0 ? <Text>Ledger: sin hallazgos</Text> : null}
    {summary.ledger && summary.ledger.length > 0 ? <Box flexDirection="column" key={table ? 'ledger-table' : 'ledger-blocks'}>
      {table ? <Box flexDirection="row">
        {LEDGER_COLUMNS.map((column) => <Box key={column.label} width={column.width} marginRight={1} flexShrink={0}><Text>{column.label}</Text></Box>)}
        <Box key="claim" width={claimWidth} flexShrink={0}><Text>claim</Text></Box>
      </Box> : null}
      {summary.ledger.map((row, index) => table ? <Box key={`row-${index}`} flexDirection="row">
        {LEDGER_COLUMNS.map((column) => <Box key={column.label} width={column.width} marginRight={1} flexShrink={0} flexDirection="column">{wrapped(ui, `${column.label}-${index}`, column.value(row))}</Box>)}
        <Box key="claim" width={claimWidth} flexShrink={0} flexDirection="column">{wrapped(ui, `claim-${index}`, shorten(row.claim, claimWidth * CLAIM_LINES))}</Box>
      </Box> : <Box key={`row-${index}`} flexDirection="column">
        {wrapped(ui, `meta-${index}`, `id: ${row.id} · severity: ${row.severity}${row.reviewer === undefined ? '' : ` · reviewer: ${row.reviewer}`} · state: ${row.state}`)}
        {wrapped(ui, `claim-${index}`, `claim: ${shorten(row.claim, Math.max(CLAIM_MIN_WIDTH, available) * CLAIM_LINES)}`)}
      </Box>)}
    </Box> : null}
  </Box>
}

const missingLedger = (count: number) => `faltan ${count} entradas; el original las contiene`
function prefixTree(ui: TerminalElements, input: SummaryInput, count: number): JSX.Element {
  const { Box, Text } = ui
  const ledger = input.summary.ledger
  const missing = ledger ? ledger.length - count : 0
  const summary = ledger ? { ...input.summary, ledger: count === 0 && ledger.length > 0 ? undefined : ledger.slice(0, count) } : input.summary
  return <Box flexDirection="column">{fullSummaryTree(ui, { ...input, summary })}{missing > 0 ? <Text wrap="wrap">{missingLedger(missing)}</Text> : null}</Box>
}

/** Si los campos solos desbordan, conservar su prefijo completo y contar los que faltan. */
function boundedFieldsTree(ui: TerminalElements, input: SummaryInput, budget: number): JSX.Element {
  const { Box, Text } = ui
  const { summary } = input
  const identification = fullSummaryTree(ui, { ...input, summary: { extra: [] }, isErrored: false })
  const fields: JSX.Element[] = []
  if (input.isErrored) fields.push(<Text>{`Bash: falló${summary.exitCode === undefined ? '' : ` · código de salida: ${summary.exitCode}`}`}</Text>)
  for (const key of ['state', 'code', 'message', 'detail'] as const) {
    if (summary[key] !== undefined) fields.push(<Box flexDirection="column">{wrapped(ui, key, `${key}: ${summary[key]}`)}</Box>)
  }
  if (summary.next) fields.push(<Box flexDirection="column">{summary.next.map((line, index) => wrapped(ui, `next-${index}`, `${index === 0 ? 'next: ' : ''}${line}`))}</Box>)
  if (summary.extra.length) fields.push(<Box flexDirection="column">{wrapped(ui, 'extra', `Más campos en la salida original: ${summary.extra.join(', ')}`, { dimColor: true })}</Box>)
  if (summary.ledger?.length === 0) fields.push(<Text>Ledger: sin hallazgos</Text>)
  const ledgerNotice = summary.ledger?.length ? missingLedger(summary.ledger.length) : ''
  const missingFields = (count: number) => `faltan ${count} campos; el original los contiene`
  let cost = textCost(identification) + ledgerNotice.length
  let count = 0
  for (const field of fields) {
    const missing = fields.length - count - 1
    if (cost + textCost(field) + (missing ? missingFields(missing).length : 0) > budget) break
    cost += textCost(field); count++
  }
  return <Box flexDirection="column">{identification}{fields.slice(0, count)}
    {count < fields.length ? <Text>{missingFields(fields.length - count)}</Text> : null}
    {ledgerNotice ? <Text>{ledgerNotice}</Text> : null}
  </Box>
}

/** Recortar el ledger primero; si los demás campos solos exceden el presupuesto, contar su recorte. */
export function summaryTree(ui: TerminalElements, input: SummaryInput, budget: number): JSX.Element {
  const length = input.summary.ledger?.length ?? 0
  const full = prefixTree(ui, input, length)
  if (hasControls(full)) return full
  if (textCost(full) <= budget) return full
  if (textCost(prefixTree(ui, input, 0)) > budget) return boundedFieldsTree(ui, input, budget)
  let low = 0, high = length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textCost(prefixTree(ui, input, middle)) <= budget) low = middle
    else high = middle - 1
  }
  return prefixTree(ui, input, low)
}

function mainInput(call: ToolGroupCall): string {
  const input = record(call.input) ? call.input : {}
  const key = call.tool === 'Bash' ? 'command' : ['Read', 'Edit', 'Write'].includes(call.tool) ? 'file_path' : ['Grep', 'Glob'].includes(call.tool) ? 'pattern' : undefined
  const value = key ? input[key] : Object.values(input).find((v) => typeof v === 'string')
  return typeof value === 'string' ? value : ''
}

export function groupTree(ui: TerminalElements, calls: readonly ToolGroupCall[], budget: number, columns?: number, cached: Readonly<Record<string, Summary>> = {}): JSX.Element | null {
  const { Box, Text } = ui
  let recognized = false
  const available = columns === undefined ? undefined : columns - RESULT_INDENT - CALL_PADDING
  const width = available ?? UNMEASURED_CALL_WIDTH
  const parts = calls.map((call) => {
    const command = record(call.input) ? call.input.command : undefined
    const attributed = call.tool === 'Bash' && !!call.tool_use_id && typeof command === 'string' && recognizeCommand(command).kind === 'recognized'
    const saved = call.tool_use_id ? cached[call.tool_use_id] : undefined
    const output: OutputDecision = attributed && saved ? { kind: 'summary', summary: saved, original: { kind: 'text', text: '' } }
      : attributed ? parseOutput(call.output, call.isErrored) : { kind: 'native' }
    let tree: JSX.Element
    let summary: SummaryInput | undefined
    if (attributed && (call.isInterrupted || output.kind === 'interrupted')) {
      recognized = true
      tree = <Box flexDirection="column">{wrapped(ui, 'interrupted', `${LABEL}${shorten(mainInput(call), Math.max(MIN_INPUT_WIDTH, width - LABEL.length - ' · interrumpida'.length))} · interrumpida`)}</Box>
    } else if (attributed && call.isRunning) {
      recognized = true
      tree = <Box flexDirection="column">{wrapped(ui, 'running', `${LABEL}${shorten(mainInput(call), Math.max(MIN_INPUT_WIDTH, width - LABEL.length - ' · en curso'.length))} · en curso`)}</Box>
    } else if (attributed && output.kind === 'summary') {
      recognized = true
      summary = { summary: output.summary, command: mainInput(call), isErrored: call.isErrored, columns, available: width }
      tree = prefixTree(ui, summary, 0)
    } else {
      const suffix = `${call.isErrored ? ' · falló' : ''}${attributed ? ' · sin resumen' : ''}`
      const line = <Box flexDirection="column">{wrapped(ui, 'native', `${call.tool}${mainInput(call) ? `${TOOL_SEPARATOR}${shorten(mainInput(call), Math.max(MIN_INPUT_WIDTH, width - call.tool.length - suffix.length - TOOL_SEPARATOR.length))}` : ''}${suffix}`)}</Box>
      // Claude Code guarda aparte una salida grande y a la llamada le deja un recorte: el motivo va en su línea, y la
      // llamada cuenta como reconocida aunque sea la única de sdd-ai del grupo.
      const persisted = attributed ? persistedSize(call.output) : undefined
      if (persisted !== undefined) recognized = true
      tree = persisted === undefined ? line : <Box flexDirection="column">
        {line}
        <Text dimColor wrap="wrap">{`salida de ${(persisted / 1024).toFixed(1).replace('.', ',')} KB guardada aparte por Claude Code`}</Text>
      </Box>
    }
    const identification = summary ? <Box flexDirection="column">{wrapped(ui, 'identification', `${LABEL}${shorten(mainInput(call), Math.max(MIN_INPUT_WIDTH, width - LABEL.length))}`)}</Box> : tree
    const full = summary ? prefixTree(ui, summary, summary.summary.ledger?.length ?? 0) : tree
    return { tree, identification, summary, unsafe: hasControls(full), base: textCost(tree), extra: summary ? Math.max(0, textCost(full) - textCost(tree)) : 0 }
  })
  if (!recognized) return null
  if (parts.some(part => part.unsafe)) return null
  const callsReserve = `faltan ${parts.length} llamadas`.length + `faltan ${parts.length} resúmenes en el grupo`.length
  let identificationCost = 0, count = 0
  for (const part of parts) {
    if (identificationCost + textCost(part.identification) + callsReserve > budget) break
    identificationCost += textCost(part.identification); count++
  }
  const shown = parts.slice(0, count)
  const callsMissing = parts.length - count
  const summaryReserve = `faltan ${shown.length} resúmenes en el grupo`.length
  const availableBudget = budget - (callsMissing ? `faltan ${callsMissing} llamadas`.length : 0) - summaryReserve
  const base = shown.reduce((cost, part) => cost + part.base, 0)
  const allocated = shown.map(() => 0)
  let left = Math.max(0, availableBudget - base)
  let active = shown.map((part, index) => ({ part, index })).filter(({ part }) => part.extra > 0)
  while (left > 0 && active.length) {
    const share = Math.max(1, Math.floor(left / active.length))
    for (const { part, index } of active) {
      const use = Math.min(left, share, part.extra - allocated[index]!)
      allocated[index]! += use; left -= use
    }
    active = active.filter(({ part, index }) => allocated[index]! < part.extra)
  }
  let remaining = availableBudget - identificationCost
  let summariesMissing = 0, stopped = false
  const lines = shown.map((part, index) => {
    let tree = part.tree
    if (base <= availableBudget && part.summary) tree = summaryTree(ui, part.summary, part.base + allocated[index]!)
    else if (base > availableBudget && part.summary) {
      const extra = part.base - textCost(part.identification)
      if (stopped || extra > remaining) { tree = part.identification; summariesMissing++; stopped = true }
      else remaining -= extra
    }
    return <Box key={`call-${index}`} flexDirection="column" paddingLeft={CALL_PADDING}>{tree}</Box>
  })
  return <Box flexDirection="column">{lines}
    {summariesMissing ? <Text>{`faltan ${summariesMissing} resúmenes en el grupo`}</Text> : null}
    {callsMissing ? <Text>{`faltan ${callsMissing} llamadas`}</Text> : null}
  </Box>
}

export function originalTree(ui: TerminalElements, original: OriginalOutput): JSX.Element {
  const { Box, Text } = ui
  return <Box flexDirection="column">
    {original.kind === 'text' ? wrapped(ui, 'original', original.text) : <Box flexDirection="column">
      <Text dimColor>stdout:</Text>{wrapped(ui, 'stdout', original.stdout)}
      {original.stderr ? <Box flexDirection="column"><Text dimColor>stderr:</Text>{wrapped(ui, 'stderr', original.stderr)}</Box> : null}
    </Box>}
  </Box>
}
