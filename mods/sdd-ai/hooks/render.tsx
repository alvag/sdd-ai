import type { Elements, ToolGroupCall } from 'claude-code'
import type { LedgerRow, OriginalOutput, Summary } from '../types'
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

function wrapped(ui: TerminalElements, key: string, text: string, props: { dimColor?: boolean } = {}): JSX.Element[] {
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
export function summaryTree(ui: TerminalElements, input: { summary: Summary; command: string; isErrored: boolean; columns?: number; available: number }): JSX.Element {
  const { Box, Text } = ui
  const { summary, command, isErrored, columns, available } = input
  const claimWidth = available - FIXED_TABLE_WIDTH
  const table = columns !== undefined && columns >= TABLE_MIN_COLUMNS && claimWidth >= CLAIM_MIN_WIDTH
  return <Box flexDirection="column">
    <Text bold wrap="wrap">{`${LABEL}${shorten(command, Math.max(MIN_INPUT_WIDTH, available - LABEL.length))}`}</Text>
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
        <Box key="claim" width={claimWidth} flexShrink={0}><Text wrap="wrap">{shorten(row.claim, claimWidth * CLAIM_LINES)}</Text></Box>
      </Box> : <Box key={`row-${index}`} flexDirection="column">
        {wrapped(ui, `meta-${index}`, `id: ${row.id} · severity: ${row.severity}${row.reviewer === undefined ? '' : ` · reviewer: ${row.reviewer}`} · state: ${row.state}`)}
        <Text wrap="wrap">{`claim: ${shorten(row.claim, Math.max(CLAIM_MIN_WIDTH, available) * CLAIM_LINES)}`}</Text>
      </Box>)}
    </Box> : null}
  </Box>
}

function mainInput(call: ToolGroupCall): string {
  const input = record(call.input) ? call.input : {}
  const key = call.tool === 'Bash' ? 'command' : ['Read', 'Edit', 'Write'].includes(call.tool) ? 'file_path' : ['Grep', 'Glob'].includes(call.tool) ? 'pattern' : undefined
  const value = key ? input[key] : Object.values(input).find((v) => typeof v === 'string')
  return typeof value === 'string' ? value : ''
}

export function groupTree(ui: TerminalElements, calls: readonly ToolGroupCall[], columns?: number): JSX.Element | null {
  const { Box, Text } = ui
  let recognized = false
  const available = columns === undefined ? undefined : columns - RESULT_INDENT - CALL_PADDING
  const width = available ?? UNMEASURED_CALL_WIDTH
  const lines = calls.map((call, index) => {
    const command = record(call.input) ? call.input.command : undefined
    const attributed = call.tool === 'Bash' && !!call.tool_use_id && typeof command === 'string' && recognizeCommand(command).kind === 'recognized'
    const output = attributed ? parseOutput(call.output, call.isErrored) : { kind: 'native' as const }
    let tree: JSX.Element
    if (attributed && (call.isInterrupted || output.kind === 'interrupted')) {
      recognized = true
      tree = <Text wrap="wrap">{`${LABEL}${shorten(mainInput(call), Math.max(MIN_INPUT_WIDTH, width - LABEL.length - ' · interrumpida'.length))} · interrumpida`}</Text>
    } else if (attributed && call.isRunning) {
      recognized = true
      tree = <Text wrap="wrap">{`${LABEL}${shorten(mainInput(call), Math.max(MIN_INPUT_WIDTH, width - LABEL.length - ' · en curso'.length))} · en curso`}</Text>
    } else if (attributed && output.kind === 'summary') {
      recognized = true
      tree = summaryTree(ui, { summary: output.summary, command: mainInput(call), isErrored: call.isErrored, columns, available: width })
    } else {
      const suffix = `${call.isErrored ? ' · falló' : ''}${attributed ? ' · sin resumen' : ''}`
      const line = <Text wrap="wrap">{`${call.tool}${mainInput(call) ? `${TOOL_SEPARATOR}${shorten(mainInput(call), Math.max(MIN_INPUT_WIDTH, width - call.tool.length - suffix.length - TOOL_SEPARATOR.length))}` : ''}${suffix}`}</Text>
      // Claude Code guarda aparte una salida grande y a la llamada le deja un recorte: el motivo va en su línea, y la
      // llamada cuenta como reconocida aunque sea la única de sdd-ai del grupo.
      const persisted = attributed ? persistedSize(call.output) : undefined
      if (persisted !== undefined) recognized = true
      tree = persisted === undefined ? line : <Box flexDirection="column">
        {line}
        <Text dimColor wrap="wrap">{`salida de ${(persisted / 1024).toFixed(1).replace('.', ',')} KB guardada aparte por Claude Code`}</Text>
      </Box>
    }
    return <Box key={`call-${index}`} flexDirection="column" paddingLeft={CALL_PADDING}>{tree}</Box>
  })
  return recognized ? <Box flexDirection="column">{lines}</Box> : null
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
