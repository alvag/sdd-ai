import type { MatchedHook, Register } from 'claude-code'
import { recognizeCommand } from './command'
import { parseOutput } from './output'
import { RESULT_INDENT, UNMEASURED_COLUMNS, groupTree, originalTree, summaryTree, treeFits } from './render'

const observeCall: MatchedHook<'tool.call', { tool: 'Bash' }> = async ($, e, next) => {
  // La atribución se guarda antes de continuar, así está cuando se dibuja el resultado. Un fallo del reconocimiento o del
  // estado se descarta: un error de la atribución de presentación nunca impide la herramienta. La espera no se acota:
  // acotarla pediría un reloj, que no está entre las llamadas permitidas del mod, y la herramienta espera lo que tarde
  // el motor en guardar el estado de la sesión.
  try {
    if (recognizeCommand(e.command).kind === 'recognized') {
      await $.state.set({ plugin: 'sdd-ai-mod', key: 'attribution', id: e.tool_use_id }, { command: e.command })
    }
  } catch {
    // Sin atribución, el resultado suelto queda nativo.
  }
  return next(e)
}

const renderOutput: MatchedHook<'ui.render', { component: ['ToolGroup', 'ToolResult'] }> = async ($, e, next) => {
  if (e.surface !== 'terminal') return next(e)
  if (e.component === 'ToolGroup') {
    if (e.props.isExpanded) return next(e)
    const tree = groupTree($.ui.resolve(e), e.props.calls, e.viewport?.columns)
    return tree && treeFits(tree) ? tree : next(e)
  }
  if (e.component === 'ToolResult' && e.props.tool === 'Bash') {
    let command: string | undefined
    try {
      command = (await $.state.get({ plugin: 'sdd-ai-mod', key: 'attribution', id: e.props.tool_use_id })).value?.command
    } catch {
      return next(e)
    }
    if (command === undefined) return next(e)
    const output = parseOutput(e.props.output, e.props.isErrored)
    if (output.kind !== 'summary') return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const tree = <Box flexDirection="column">
      {summaryTree(ui, { summary: output.summary, command, isErrored: e.props.isErrored, columns: e.viewport?.columns, available: (e.viewport?.columns ?? UNMEASURED_COLUMNS) - RESULT_INDENT })}
      {originalTree(ui, output.original)}
    </Box>
    // Un resultado que el motor no dibujaría (demasiado texto o caracteres de control) queda nativo, con su
    // salida original completa.
    return treeFits(tree) ? tree : next(e)
  }
  return next(e)
}

export const register: Register = (on) => {
  on('tool.call', { tool: 'Bash' }, observeCall)
  on('ui.render', { component: ['ToolGroup', 'ToolResult'] }, renderOutput)
}
