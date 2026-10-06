import type { On, RenderPropsOf, ToolGroupCall } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { parseOutput } from '../hooks/output'
import { chunks, summaryTree, textCost, treeFits } from '../hooks/render'
import { domainErrorCapture2_1_288 } from './fixtures/domain-error-2.1.288'
import { domainErrorCapture2_1_289 } from './fixtures/domain-error-2.1.289'
import { domainErrorCaptures, reviewStatusCaptures, statusCaptures } from './fixtures/binary-outputs'

const command = './bin/sdd-ai sdd status'
const errorJson = domainErrorCapture2_1_288.tool_result.content.slice('Exit code 1\n'.length)
const errorValue = JSON.parse(errorJson) as Record<string, unknown>
const longNext = 'Revisa todos los campos del resultado original antes de continuar. '.repeat(12)
const longClaim = 'Una afirmación larga debe conservarse íntegra en el resultado original. '.repeat(15)
const firstCapture = reviewStatusCaptures[0]
const capturedRow = firstCapture?.value.ledger[0]
if (!firstCapture || !capturedRow) throw new Error('el fixture de revisiones no trae ledger')
const derivedReview = {
  ...firstCapture.value,
  next: longNext,
  ledger: [
    { ...capturedRow, id: 'F-1', severity: 'CRITICAL', reviewer: 'base', state: 'abierto', claim: longClaim },
    { ...capturedRow, id: 'F-2', severity: 'SUGGESTION', reviewer: 'readability', state: 'resuelto' },
    { ...capturedRow, id: 'F-3', severity: 'WARNING', reviewer: 'reliability', state: 'en-disputa' },
    { ...capturedRow, id: 'F-4', severity: 'NEW_LONG_SEVERITY', reviewer: 'future_long_reviewer', state: 'future_long_state' },
  ],
}

// La atribución usa el estado real de la sesión de prueba; solo la lectura fallida se simula, con un
// rechazo que hace fallar `$.state.get` del mod. Los hooks del test se registran antes de usar `$`, así que la
// falla se enciende después, con `fail()`.
function failingAttributionReads(on: On): { fail: () => void } {
  let failing = false
  on('state.get', { plugin: 'sdd-ai-mod', key: 'attribution' }, (_$, e, next) => failing ? { deny: 'state unavailable' } : next(e))
  return { fail: () => { failing = true } }
}

// El original se dibuja en tramos consecutivos, cortados en un salto de línea que se consume o en cualquier
// carácter. Se reconstruye desde lo dibujado, sin el auxiliar que lo parte, y tiene que dar el texto exacto.
async function expectOriginal(ui: { findAll: (query: { type: string }) => Promise<readonly { text: string }[]> }, text: string) {
  const drawn = (await ui.findAll({ type: 'Text' })).map((entry) => entry.text)
  const start = drawn.findIndex((piece) => piece.length > 0 && text.startsWith(piece))
  expect(start).toBeGreaterThan(-1)
  let rebuilt = drawn[start] ?? ''
  for (const piece of drawn.slice(start + 1)) {
    if (rebuilt.length >= text.length) break
    if (text.startsWith(`${rebuilt}\n${piece}`)) rebuilt = `${rebuilt}\n${piece}`
    else if (text.startsWith(`${rebuilt}${piece}`)) rebuilt = `${rebuilt}${piece}`
    else break
  }
  expect(rebuilt).toBe(text)
}

// Las celdas de cada fila de la tabla, en orden: el kit expone el texto de una Box como el de sus hijos, concatenado.
async function tableRows(ui: { findAll: (query: { type: string }) => Promise<readonly { key?: string; text: string; props: Record<string, unknown> }[]> }) {
  const boxes = await ui.findAll({ type: 'Box' })
  return boxes.flatMap((box, index) => box.key?.startsWith('row-') ? [boxes.slice(index + 1, index + 6)] : [])
}

// La afirmación que dibuja cada fila del ledger, en su orden: la quinta celda de la tabla, o lo que sigue a «claim: » en
// los bloques. Así cada afirmación se comprueba en su propia fila y no la satisface la de otra entrada.
async function rowClaims(ui: { findAll: (query: { type: string }) => Promise<readonly { key?: string; text: string; props: Record<string, unknown> }[]> }) {
  const boxes = await ui.findAll({ type: 'Box' })
  return boxes.flatMap((box, index) => {
    if (!box.key?.startsWith('row-')) return []
    if (box.props.flexDirection === 'row') return [boxes[index + 5]?.text ?? '']
    const at = box.text.indexOf('claim: ')
    return [at < 0 ? '' : box.text.slice(at + 'claim: '.length)]
  })
}

// Lo que muestra la celda de una afirmación: entera o un principio no vacío con elipsis.
const showsClaim = (claim: string, drawn: string) => {
  const flat = claim.replace(/\s+/g, ' ')
  return drawn === flat || (drawn.length > 1 && drawn.endsWith('…') && flat.startsWith(drawn.slice(0, -1)))
}

// Los campos de texto del JSON de una salida, leídos sin el parser del mod: lo esperado no depende de él.
function rawFields(output: unknown): Record<string, unknown> {
  const text = typeof output === 'string' ? output : String((output as { stdout?: unknown }).stdout ?? '')
  return JSON.parse(text.replace(/^(?:Error: )?Exit code \d+\n/, '')) as Record<string, unknown>
}

function originalText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const value = output as { stdout?: unknown; stderr?: unknown }
    return [value.stdout, value.stderr].filter((text) => typeof text === 'string').join('\n')
  }
  return String(output ?? '')
}

// Un árbol que dibuja un hook del test no conserva su `key`: el dibujo nativo se reconoce por su texto.
const NATIVE = { type: 'Text', text: /^native:/ } as const

function native(on: On) {
  const received: unknown[] = []
  on('ui.render', ($, e) => {
    received.push(e)
    const { Text } = $.ui.resolve(e)
    const text = e.component === 'ToolGroup' ? e.props.calls.map((call) => originalText(call.output)).join('\n')
      : e.component === 'ToolResult' ? originalText(e.props.output) : e.component
    // El renderer nativo de prueba muestra un tramo sin caracteres de control: un Text no puede pasar
    // de 10 000 caracteres ni llevarlos, y el nativo real del motor sí sabe dibujarlos.
    return Text({ wrap: 'wrap', children: `native:${text.slice(0, 9000).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?')}` })
  })
  return received
}

// El motor no transmite las propiedades con valor `undefined`: la llamada se arma sin ellas, como
// la recibe el renderer.
function call(output: unknown, options: Partial<ToolGroupCall> = {}): ToolGroupCall {
  const entries = Object.entries({ tool_use_id: 'bash-one', tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false, output, ...options })
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as ToolGroupCall
}
const group = (calls: readonly ToolGroupCall[], isExpanded = false): RenderPropsOf['ToolGroup'] => ({ calls, isActive: false, isExpanded })
const viewport = (columns: number) => ({ columns, rows: 50, isFullscreen: true })

test('parse preserves exact originals and accepts only complete attributable objects', () => {
  for (const capture of [domainErrorCapture2_1_288, domainErrorCapture2_1_289]) for (const text of [capture.tool_result.content, capture.tool_result.toolUseResult]) {
    const result = parseOutput(text, true)
    expect(result.kind).toBe('summary')
    if (result.kind !== 'summary') throw new Error('expected summary')
    expect(result.summary.exitCode).toBe(1)
    expect(result.summary.state).toBe('error')
    expect(result.summary.code).toBe('run_not_found')
    expect(result.summary.message).toBe(errorValue.message)
    expect(result.summary.next).toEqual([errorValue.next])
    expect(result.original).toEqual({ kind: 'text', text })
    expect(parseOutput(text, false).kind).toBe('native')
  }
  const streams = { stdout: `${errorJson}\n`, stderr: 'separate warning\n' }
  const result = parseOutput(streams, true)
  if (result.kind !== 'summary') throw new Error('expected summary')
  expect(result.original).toEqual({ kind: 'streams', ...streams })
  expect(result.summary.exitCode).toBe(undefined)
  expect(parseOutput({ ...streams, interrupted: true }, true).kind).toBe('interrupted')
})

test('parse omits wrong field types enumerates extras and never fabricates absent fields', () => {
  const result = parseOutput('{"state":4,"code":null,"message":[],"detail":{},"next":{"step":"review","command":"do nothing","question":{"question":"Proceed?"}},"flows":[]}', false)
  if (result.kind !== 'summary') throw new Error('expected summary')
  expect(result.summary.extra).toEqual(['state', 'code', 'message', 'detail', 'flows'])
  expect(result.summary.next).toEqual(['step: review', 'command: do nothing', 'question: Proceed?'])
  expect(result.summary.state).toBe(undefined)
  const empty = parseOutput('{}\n', false)
  if (empty.kind !== 'summary') throw new Error('expected summary')
  expect(empty.summary).toEqual({ extra: [] })
  expect(parseOutput('{"next":false}', false)).toMatchObject({ summary: { extra: ['next'] } })
  expect(parseOutput('{"next":{}}', false)).toMatchObject({ summary: { extra: ['next'] } })
})

const invalidOutputs: { name: string; output: unknown }[] = [
  { name: 'Bash failure without binary JSON', output: 'Exit code 127\ncommand not found' },
  { name: 'permission denial', output: 'Permission denied' },
  { name: 'timeout', output: 'Command timed out' },
  { name: 'empty text', output: '' },
  { name: 'non JSON text', output: 'not JSON' },
  { name: 'scalar JSON', output: '1' },
  { name: 'array JSON', output: '[]' },
  { name: 'malformed object', output: '{broken}' },
  { name: 'invalid ledger', output: '{"state":"done","ledger":[{"id":"F-1"}]}' },
  { name: 'invalid ledger reviewer', output: '{"ledger":[{"id":"F-1","severity":"NEW","state":"new","claim":"claim","reviewer":4}]}' },
  { name: 'concatenated results', output: '{}\n{}' },
  { name: 'leading whitespace', output: ' {}' },
  { name: 'mixed stderr before JSON', output: `warning\n${errorJson}` },
  { name: 'mixed stderr after JSON', output: `${errorJson}\nwarning` },
  { name: 'mixed stderr in structured stdout', output: { stdout: `warning\n${errorJson}`, stderr: '' } },
  { name: 'mixed stderr after error prefix', output: `Exit code 1\nwarning\n${errorJson}` },
]

for (const c of invalidOutputs) for (const isErrored of [false, true]) test(`parse falls back: ${c.name}; isErrored=${isErrored}`, () => {
  expect(parseOutput(c.output, isErrored).kind).toBe('native')
})

test('parse summarizes a valid output after every invalid one and flags next details it does not show', () => {
  for (const c of invalidOutputs) parseOutput(c.output, true)
  expect(parseOutput('{"state":"done"}', false).kind).toBe('summary')
  // Lo que el resumen no muestra de next queda avisado entre los campos de la salida original.
  for (const output of ['{"next":{"step":"implement","task":"T1"}}', '{"next":{"question":{"question":"¿Seguir?","options":["sí","no"]}}}']) {
    expect(parseOutput(output, false)).toMatchObject({ summary: { extra: ['next'] } })
  }
  expect(parseOutput('{"next":{"step":"implement","command":"x","question":{"question":"¿Seguir?"}}}', false)).toMatchObject({ summary: { extra: [] } })
})

const validOutputs = [
  { name: 'literal domain error content 2.1.288', output: domainErrorCapture2_1_288.tool_result.content, isErrored: true, state: 'error', exitCode: 1 },
  { name: 'literal domain error transcript 2.1.288', output: domainErrorCapture2_1_288.tool_result.toolUseResult, isErrored: true, state: 'error', exitCode: 1 },
  { name: 'literal domain error content 2.1.289', output: domainErrorCapture2_1_289.tool_result.content, isErrored: true, state: 'error', exitCode: 1 },
  { name: 'literal domain error transcript 2.1.289', output: domainErrorCapture2_1_289.tool_result.toolUseResult, isErrored: true, state: 'error', exitCode: 1 },
  ...domainErrorCaptures.map((capture) => ({ name: `captured ${capture.name} with engine prefix`, output: `Exit code ${capture.exitCode}\n${capture.stdout.trimEnd()}`, isErrored: true, state: 'error', exitCode: capture.exitCode })),
  ...statusCaptures.map((capture) => ({ name: `captured ${capture.name}`, output: capture.stdout, isErrored: false, state: undefined, exitCode: undefined })),
  ...reviewStatusCaptures.map((capture) => ({ name: `captured ${capture.name}`, output: capture.stdout, isErrored: false, state: capture.value.state, exitCode: undefined })),
  { name: 'derived domain error code 2 with detail', output: `Exit code 2\n${JSON.stringify({ ...errorValue, detail: 'El detalle completo explica por qué falló la llamada. '.repeat(8) })}`, isErrored: true, state: 'error', exitCode: 2 },
  { name: 'derived domain error without exit prefix', output: errorJson, isErrored: true, state: 'error', exitCode: undefined },
  { name: 'derived launched code 1', output: 'Exit code 1\n{"state":"launched","next":"espera la corrida"}', isErrored: true, state: 'launched', exitCode: 1 },
  { name: 'derived failed terminal review with ledger', output: `Error: Exit code 1\n${JSON.stringify({ ...derivedReview, state: 'failed' })}`, isErrored: true, state: 'failed', exitCode: 1 },
  { name: 'derived separate stderr warning', output: { stdout: JSON.stringify({ state: 'done', next: longNext }), stderr: 'warning kept only in original\n' }, isErrored: false, state: 'done', exitCode: undefined },
  { name: 'derived state error on a non errored tool', output: errorJson, isErrored: false, state: 'error', exitCode: undefined },
  { name: 'derived status without presentable fields', output: '{"flows":[]}', isErrored: false, state: undefined, exitCode: undefined },
]

for (const columns of [166, 80]) for (const c of validOutputs) test(`terminal ${columns}: ${c.name} matches group and attributed result`, async ($, on) => {
  const received = native(on)
  let toolCalls = 0
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    toolCalls++
    expect(e.command).toBe(command)
    return { deny: 'fixture: tool is not executed' }
  })
  const id = 'attributed-result'
  await $.tool.call({ tool: 'Bash', tool_use_id: id, command })
  const grouped = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(columns), props: group([call(c.output, { isErrored: c.isErrored })]) })
  const single = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: viewport(columns), props: { tool: 'Bash', tool_use_id: id, output: c.output, isErrored: c.isErrored } })
  const groupedText = (await grouped.findAll({ type: 'Text' })).map((entry) => entry.text)
  const singleText = (await single.findAll({ type: 'Text' })).map((entry) => entry.text)
  // El ancho disponible difiere por la sangría, así que solo la afirmación puede recortarse distinto: se quitan las
  // líneas que son una afirmación entera o su principio con elipsis, y el resto del resumen suelto es el agrupado.
  const parsed = parseOutput(c.output, c.isErrored)
  if (parsed.kind !== 'summary') throw new Error('expected summary')
  const claims = parsed.summary.ledger?.map((row) => row.claim.replace(/\s+/g, ' ')) ?? []
  const isClaim = (line: string) => {
    const cell = line.replace(/^claim: /, '')
    return claims.some((claim) => claim === cell || (cell.length > 1 && cell.endsWith('…') && claim.startsWith(cell.slice(0, -1))))
  }
  const groupedSummary = groupedText.filter((line) => !isClaim(line))
  expect(singleText.filter((line) => !isClaim(line)).slice(0, groupedSummary.length)).toEqual(groupedSummary)
  // Cada entrada muestra su afirmación en su fila, en las dos vistas; solo puede cambiar el punto del recorte.
  const ledger = parsed.summary.ledger ?? []
  const groupedClaims = await rowClaims(grouped)
  const singleClaims = await rowClaims(single)
  expect(groupedClaims).toHaveLength(ledger.length)
  expect(singleClaims).toHaveLength(ledger.length)
  for (const [index, row] of ledger.entries()) {
    expect(showsClaim(row.claim, groupedClaims[index] ?? '')).toBe(true)
    expect(showsClaim(row.claim, singleClaims[index] ?? '')).toBe(true)
  }
  // El grupo plegado no lleva el original: lo que se lee ahí es el resumen. message y detail van completos, tal como los
  // trae el JSON, y next también.
  const raw = rawFields(c.output)
  for (const key of ['message', 'detail'] as const) {
    if (typeof raw[key] === 'string') expect(await grouped.find({ type: 'Text', text: `${key}: ${raw[key]}` })).toBeTruthy()
  }
  for (const [index, line] of (parsed.summary.next ?? []).entries()) {
    expect(await grouped.find({ type: 'Text', text: `${index === 0 ? 'next: ' : ''}${line}` })).toBeTruthy()
  }
  if (c.state !== undefined) expect(await single.find({ type: 'Text', text: `state: ${c.state}` })).toBeTruthy()
  if (c.exitCode !== undefined) expect(await single.find({ type: 'Text', text: `código de salida: ${c.exitCode}` })).toBeTruthy()
  else expect(await single.find({ type: 'Text', text: 'código de salida:' })).toBe(undefined)
  if (typeof c.output === 'string') await expectOriginal(single, c.output)
  else {
    await expectOriginal(single, c.output.stdout)
    await expectOriginal(single, c.output.stderr)
  }
  expect(received).toHaveLength(0)
  expect(toolCalls).toBe(1)
  await grouped.unmount()
  await single.unmount()
})

for (const fixture of reviewStatusCaptures) for (const columns of [166, 80, 79]) test(`terminal ${columns}: ${fixture.name} keeps ledger order and fields`, async ($, on) => {
  native(on)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(columns), props: group([call(fixture.stdout)]) })
  // Cada entrada se lee en su propia fila, en el orden del ledger, con sus valores y no los de otra: en la tabla,
  // celda por celda; en bloques, con su línea de datos exacta.
  if (columns >= 80) {
    const rows = await tableRows(ui)
    expect(rows).toHaveLength(fixture.value.ledger.length)
    for (const [index, row] of fixture.value.ledger.entries()) {
      const cells = (rows[index] ?? []).map((cell) => cell.text)
      expect(cells.slice(0, 4)).toEqual([row.id, row.severity, row.reviewer ?? '', row.state])
      expect(showsClaim(row.claim, cells[4] ?? '')).toBe(true)
    }
  } else {
    const lines = (await ui.findAll({ type: 'Text' })).map((entry) => entry.text).filter((line) => line.startsWith('id: '))
    expect(lines).toEqual(fixture.value.ledger.map((row) => `id: ${row.id} · severity: ${row.severity}${row.reviewer === undefined ? '' : ` · reviewer: ${row.reviewer}`} · state: ${row.state}`))
  }
  expect(await ui.find({ key: columns >= 80 ? 'ledger-table' : 'ledger-blocks' })).toBeTruthy()
  await ui.unmount()
})

for (const columns of [166, 80, 79, undefined]) test(`derived ledger layout at ${columns ?? 'unmeasured'} columns`, async ($, on) => {
  native(on)
  const id = 'ledger-layout'
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  await $.tool.call({ tool: 'Bash', tool_use_id: id, command })
  const output = JSON.stringify(derivedReview)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: columns === undefined ? undefined : viewport(columns), props: { tool: 'Bash', tool_use_id: id, output, isErrored: false } })
  const table = columns !== undefined && columns >= 80
  expect(await ui.find({ key: table ? 'ledger-table' : 'ledger-blocks' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: 'Una afirmación larga' }))?.text).toMatch('…')
  await expectOriginal(ui, output)
  if (table) {
    // Los anchos del plan: id 5, severidad 10, revisor 11 y estado 11, separados por un espacio; la afirmación recibe lo
    // que dejan la sangría de 5 del resultado y esas columnas (a 166 columnas, 120; a 80, 34).
    const claimWidth: Record<number, number> = { 166: 120, 80: 34 }
    const rows = await tableRows(ui)
    expect(rows).toHaveLength(derivedReview.ledger.length)
    for (const row of rows) expect(row.map((cell) => cell.props.width)).toEqual([5, 10, 11, 11, claimWidth[columns!]])
  }
  await ui.unmount()
  // En el grupo plegado, sin el original, el resumen trae next completo y los valores largos en su celda, envueltos.
  const grouped = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: columns === undefined ? undefined : viewport(columns), props: group([call(output)]) })
  expect(await grouped.find({ type: 'Text', text: `next: ${longNext}` })).toBeTruthy()
  for (const value of ['future_long_reviewer', 'NEW_LONG_SEVERITY', 'future_long_state']) expect(await grouped.find({ type: 'Text', text: value })).toBeTruthy()
  if (table) {
    const cells = await grouped.findAll({ type: 'Text', text: /^(future_long_reviewer|NEW_LONG_SEVERITY|future_long_state)$/ })
    expect(cells).toHaveLength(3)
    for (const entry of cells) expect(entry.props.wrap).toBe('wrap')
  }
  await grouped.unmount()
})

test('derived missing reviewer remains missing', async ($, on) => {
  native(on)
  const [first] = derivedReview.ledger
  if (!first) throw new Error('la revisión derivada no trae ledger')
  const { reviewer: _reviewer, ...row } = first
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(80), props: group([call(JSON.stringify({ ledger: [row] }))]) })
  const text = (await ui.findAll({ type: 'Text' })).map((entry) => entry.text).join('\n')
  expect(text).not.toMatch('base')
  const parsed = parseOutput(JSON.stringify({ ledger: [row] }), false)
  if (parsed.kind !== 'summary') throw new Error('expected summary')
  expect(parsed.summary.ledger?.[0]?.reviewer).toBe(undefined)
  await ui.unmount()
})

test('small available width uses blocks even at 80 terminal columns', async ($, on) => {
  const parsed = parseOutput(JSON.stringify(derivedReview), false)
  if (parsed.kind !== 'summary') throw new Error('expected summary')
  on('ui.render', { component: 'ToolResult' }, ($, e) => summaryTree($.ui.resolve({ surface: 'terminal', component: e.component }), { summary: parsed.summary, command, isErrored: false, columns: 80, available: 55 }, 90000))
  const narrow = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', props: { tool: 'Read', tool_use_id: 'small-width-fixture', output: '', isErrored: false } })
  expect(await narrow.find({ key: 'ledger-blocks' })).toBeTruthy()
  expect(await narrow.find({ key: 'ledger-table' })).toBe(undefined)
  await narrow.unmount()
})

test('empty and absent ledger are distinct and no maximum findings is imposed', async ($, on) => {
  native(on)
  const empty = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(80), props: group([call('{"ledger":[]}')]) })
  expect(await empty.find({ text: 'Ledger: sin hallazgos' })).toBeTruthy()
  await empty.redraw(group([call('{"state":"launched"}')]))
  expect(await empty.find({ text: 'sin hallazgos' })).toBe(undefined)
  const ledger = Array.from({ length: 60 }, (_, index) => ({ ...derivedReview.ledger[0], id: `F-${index + 1}` }))
  await empty.redraw(group([call(JSON.stringify({ ledger }))]))
  expect(await empty.find({ text: 'F-60' })).toBeTruthy()
  expect((await empty.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('row-'))).toHaveLength(60)
  await empty.unmount()
})

for (const columns of [166, 80]) test(`terminal ${columns}: mixed groups keep order and hide unrelated diagnostics`, async ($, on) => {
  const received = native(on)
  const unrelatedDiagnostic = 'unrelated secret diagnostic '.repeat(100)
  const invalidDiagnostic = 'invalid binary diagnostic '.repeat(100)
  const calls = [
    call('', { tool: 'Read', tool_use_id: 'read', input: { file_path: 'first.txt' } }),
    call('{"state":"done","code":"ready","next":"review"}'),
    call(unrelatedDiagnostic, { tool: 'Bash', tool_use_id: 'foreign', input: { command: 'other command '.repeat(50) }, isErrored: true }),
    call(invalidDiagnostic, { tool_use_id: 'invalid' }),
    call('', { tool: 'Grep', tool_use_id: 'grep', input: { pattern: 'needle' } }),
    call('', { tool: 'Edit', tool_use_id: 'edit', input: { file_path: 'edit.txt' } }),
    call('', { tool: 'Write', tool_use_id: 'write', input: { file_path: 'write.txt' } }),
    call('', { tool: 'Glob', tool_use_id: 'glob', input: { pattern: '*.ts' } }),
    call('', { tool: 'custom', tool_use_id: 'custom', input: { count: 1, query: 'first string' } }),
    call('', { tool: 'no-strings', tool_use_id: 'no-strings', input: { count: 1 } }),
    call('{"state":"done"}', { tool_use_id: undefined }),
  ]
  const props = group(calls)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(columns), props })
  const text = (await ui.findAll({ type: 'Text' })).map((entry) => entry.text).join('\n')
  const at = (fragment: string) => {
    const index = text.indexOf(fragment)
    expect(index).toBeGreaterThan(-1)
    return index
  }
  // Una línea por llamada, en el orden en que se hicieron: cada Box de llamada empieza con lo que la identifica.
  const lines = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('call-')).map((box) => box.text)
  const expected = ['Read: first.txt', 'sdd-ai: ', 'Bash: other command', 'Bash: ./bin/sdd-ai sdd status · sin resumen', 'Grep: needle',
    'Edit: edit.txt', 'Write: write.txt', 'Glob: *.ts', 'custom: first string', 'no-strings', `Bash: ${command}`]
  expect(lines).toHaveLength(expected.length)
  for (const [index, start] of expected.entries()) expect(lines[index]?.startsWith(start)).toBe(true)
  expect(at('state: done')).toBeLessThan(at('other command'))
  // La llamada sin tool_use_id es ajena: su línea es la de Bash con el comando, sin resumen ni marca.
  expect((await ui.findAll({ type: 'Text' })).some((entry) => entry.text === `Bash: ${command}`)).toBe(true)
  expect(text).toMatch('Bash: other command')
  expect(text).toMatch('falló')
  expect(text).toMatch('…')
  expect(text).toMatch('Edit: edit.txt')
  expect(text).toMatch('Write: write.txt')
  expect(text).toMatch('Glob: *.ts')
  expect(text).toMatch('custom: first string')
  expect(text).toMatch('no-strings')
  // Ni la salida ajena ni el diagnóstico de la salida inválida aparecen, ni siquiera un fragmento.
  expect(text).not.toMatch('unrelated secret diagnostic')
  expect(text).not.toMatch('invalid binary diagnostic')
  expect(received).toHaveLength(0)
  await ui.redraw({ ...props, isExpanded: true })
  expect((await ui.find(NATIVE))?.text).toMatch(unrelatedDiagnostic)
  expect((await ui.find(NATIVE))?.text).toMatch(invalidDiagnostic)
  expect(received.at(-1)).toMatchObject({ props: { ...props, isExpanded: true } })
  await ui.redraw(props)
  expect(await ui.find(NATIVE)).toBe(undefined)
  expect(received).toHaveLength(1)
  await ui.unmount()
})

for (const columns of [166, 80]) test(`terminal ${columns}: running interruption and launched are distinct`, async ($, on) => {
  native(on)
  const running = group([call(undefined, { isRunning: true }), call('{"state":"done"}', { tool_use_id: 'already-done' })])
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(columns), props: { ...running, isActive: true } })
  expect(await ui.find({ text: 'en curso' })).toBeTruthy()
  expect(await ui.find({ text: 'state: done' })).toBeTruthy()
  expect(await ui.find({ text: 'state: launched' })).toBe(undefined)
  await ui.redraw(group([call('Exit code 1\n{"state":"launched"}', { isErrored: true })]))
  expect(await ui.find({ text: 'en curso' })).toBe(undefined)
  expect(await ui.find({ text: 'state: launched' })).toBeTruthy()
  expect(await ui.find({ text: 'código de salida: 1' })).toBeTruthy()
  for (const interrupted of [call('{}', { isInterrupted: true }), call({ stdout: '{}', stderr: '', interrupted: true })]) {
    await ui.redraw(group([interrupted]))
    expect(await ui.find({ text: 'interrumpida' })).toBeTruthy()
    expect(await ui.find({ text: 'state:' })).toBe(undefined)
  }
  await ui.unmount()
})

for (const columns of [166, 80]) for (const c of invalidOutputs) for (const isErrored of [false, true]) test(`terminal ${columns}: native diagnostics and recovery ${c.name}; isErrored=${isErrored}`, async ($, on) => {
  const received = native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const id = 'invalid-output'
  await $.tool.call({ tool: 'Bash', tool_use_id: id, command })
  const props = { tool: 'Bash', tool_use_id: id, output: c.output, isErrored }
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: viewport(columns), props })
  // La igualdad exacta vale porque estas salidas son cortas y sin caracteres de control: el renderer nativo de
  // prueba recorta a 9000 caracteres y reemplaza esos caracteres.
  expect((await ui.find(NATIVE))?.text).toBe(`native:${originalText(c.output)}`)
  expect(received.at(-1)).toMatchObject({ props })
  await ui.redraw({ ...props, output: '{"state":"done"}', isErrored: false })
  expect(await ui.find(NATIVE)).toBe(undefined)
  expect(await ui.find({ text: 'state: done' })).toBeTruthy()
  await ui.unmount()
})

test('unattributed historical results foreign tools and interrupted results stay native', async ($, on) => {
  const received = native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const output = '{"state":"done","code":"ready","next":"continue"}'
  const historical = { tool: 'Bash', tool_use_id: 'historical', output, isErrored: false }
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', props: historical })
  expect(await ui.find(NATIVE)).toBeTruthy()
  expect(received.at(-1)).toMatchObject({ props: historical })
  const foreign = { ...historical, tool: 'Read' }
  await ui.redraw(foreign)
  expect(received.at(-1)).toMatchObject({ props: foreign })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'interrupted', command })
  const interrupted = { ...historical, tool_use_id: 'interrupted', output: { stdout: output, stderr: '', interrupted: true } }
  await ui.redraw(interrupted)
  expect(await ui.find(NATIVE)).toBeTruthy()
  expect(received.at(-1)).toMatchObject({ props: interrupted })
  await ui.unmount()
})

test('unrelated groups and nonterminal surfaces continue with original props', async ($, on) => {
  const received = native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const props = group([call('{"state":"done"}', { tool: 'Read', input: { file_path: 'file' } })])
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', props })
  expect(received.at(-1)).toMatchObject({ props })
  expect(await ui.find(NATIVE)).toBeTruthy()
  const missingId = group([call('{}', { tool_use_id: undefined })])
  await ui.redraw(missingId)
  expect(received.at(-1)).toMatchObject({ props: missingId })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'desktop', command })
  const desktopProps = { tool: 'Bash', tool_use_id: 'desktop', output: '{"state":"done"}', isErrored: false }
  const desktop = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'desktop', component: 'ToolResult', props: desktopProps })
  // Escribir la caché de salidas guardadas redibuja el grupo de la terminal: se busca el último dibujo de escritorio.
  expect(received.filter((item) => (item as { surface?: string }).surface === 'desktop').at(-1)).toMatchObject({ surface: 'desktop', props: desktopProps })
  expect(await desktop.find(NATIVE)).toBeTruthy()
  const desktopGroup = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'desktop', component: 'ToolGroup', props: group([call('{}')]) })
  expect(await desktopGroup.find(NATIVE)).toBeTruthy()
  await ui.unmount()
  await desktop.unmount()
  await desktopGroup.unmount()
})

test('failed attribution reads fall back without changing result props', async ($, on) => {
  const received = native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const reads = failingAttributionReads(on)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'read-fails', command })
  const props = { tool: 'Bash', tool_use_id: 'read-fails', output: '{"state":"done"}', isErrored: false }
  // Control: con la lectura sana, la llamada atribuida se resume.
  const healthy = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', props })
  expect(await healthy.find({ type: 'Text', text: 'state: done' })).toBeTruthy()
  await healthy.unmount()
  // Con la lectura rechazada, el mismo resultado queda nativo y con sus props.
  reads.fail()
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', props })
  expect(await ui.find(NATIVE)).toBeTruthy()
  expect(received.at(-1)).toMatchObject({ props })
  await ui.unmount()
})

test('long originals are drawn whole in pieces below the summary', async ($, on) => {
  native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const id = 'long-original'
  await $.tool.call({ tool: 'Bash', tool_use_id: id, command })
  const output = `${JSON.stringify({ ...derivedReview, detail: 'Un detalle de varias páginas. '.repeat(1200) })}\n`
  expect(chunks(output).length).toBeGreaterThan(1)
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: viewport(166), props: { tool: 'Bash', tool_use_id: id, output, isErrored: false } })
  expect(await ui.find(NATIVE)).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: 'state: done' })).toBeTruthy()
  for (const entry of await ui.findAll({ type: 'Text' })) expect(entry.text.length).toBeLessThan(10000)
  await expectOriginal(ui, output)
  await ui.unmount()
})

test('an individual oversized message keeps the field prefix and the complete native original', async ($, on) => {
  const received = native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const id = 'oversized-message'
  const source = {
    state: 'blocked', code: 'gate_pending',
    message: 'El original conserva este mensaje completo. '.repeat(4000),
    detail: 'Detalle después del mensaje.', next: 'Revisa el gate.',
  }
  const output = JSON.stringify(source)
  await $.tool.call({ tool: 'Bash', tool_use_id: id, command })
  const props = { tool: 'Bash', tool_use_id: id, output, isErrored: false }
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: viewport(166), props })
  const texts = (await ui.findAll({ type: 'Text' })).map(entry => entry.text)
  const originalIndex = texts.findIndex(text => text.startsWith('native:'))
  expect(originalIndex).toBeGreaterThan(-1)
  const expectedFields = ['state', 'code'] as const
  const missing = Object.keys(source).length - expectedFields.length
  expect(texts.slice(0, originalIndex)).toEqual([
    `sdd-ai: ${command}`, ...expectedFields.map(key => `${key}: ${source[key]}`),
    `faltan ${missing} campos; el original los contiene`,
  ])
  expect(textCost(await ui.drawn())).toBeLessThanOrEqual(90000)
  expect(texts.slice(0, originalIndex).every(text => text.length <= 8000)).toBe(true)
  // El nativo de prueba dibuja solo una muestra; comprobar que recibe el original íntegro.
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({ component: 'ToolResult', props })
  await ui.redraw()
  expect(received.at(-1)).toMatchObject({ props })
  await ui.unmount()
})

test('extreme groups retain call identifications and count summaries that cannot fit', async ($, on) => {
  const received = native(on)
  const outputs = Array.from({ length: 10 }, (_, index) => JSON.stringify({ state: `entry-${index} ${'x'.repeat(18000)}`, ledger: [{ id: `F-${index}`, severity: 'BUG', state: 'abierto', claim: 'Hallazgo' }] }))
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(166), props: group(outputs.map(output => call(output))) })
  const texts = (await ui.findAll({ type: 'Text' })).map(item => item.text)
  expect(textCost(await ui.drawn())).toBeLessThanOrEqual(90000)
  expect(texts.filter(text => text.startsWith('sdd-ai: ')).length).toBe(10)
  const summaries = texts.filter(text => text.startsWith('state: entry-'))
  expect(summaries.length).toBe(4)
  expect(texts.includes('faltan 6 resúmenes en el grupo')).toBe(true)
  expect(texts.filter(text => text === 'faltan 1 entradas; el original las contiene').length).toBe(4)
  expect(texts.every(text => text.length <= 8000)).toBe(true)
  expect(received).toHaveLength(0)
  await ui.unmount()
})

test('control characters stay native while oversized compact ledgers use counted prefixes', async ($, on) => {
  const received = native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const id = 'oversized'
  await $.tool.call({ tool: 'Bash', tool_use_id: id, command })
  // El ledger grande se prueba en el grupo; el fixture individual en línea conserva el límite de 30 KB.
  const review = (length: number) => `${JSON.stringify({ ...derivedReview, ledger: Array.from({ length }, (_, index) => ({ ...capturedRow, id: `F-${index + 1}` })) })}\n`
  const withControl = { stdout: '{"state":"done"}\n', stderr: 'aviso \u001b[31mrojo\u001b[0m\n' }
  for (const output of [withControl]) {
    const props = { tool: 'Bash', tool_use_id: id, output, isErrored: false }
    const single = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: viewport(166), props })
    expect(await single.find(NATIVE)).toBeTruthy()
    expect(received.at(-1)).toMatchObject({ props })
    await single.unmount()
  }
  const grouped = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(166), props: group([call(review(120))]) })
  expect(await grouped.find(NATIVE)).toBe(undefined)
  expect(await grouped.find({ text: 'F-120' })).toBeTruthy()
  const tooLarge = group([call(review(300))])
  await grouped.redraw(tooLarge)
  expect(await grouped.find(NATIVE)).toBe(undefined)
  const drawn = await grouped.findAll({ type: 'Text' })
  const ids = drawn.map(entry => entry.text).filter(text => /^F-\d+$/.test(text))
  expect(ids.length).toBeLessThan(300)
  for (let index = 0; index < ids.length; index++) expect(ids[index]).toBe(`F-${index + 1}`)
  expect(drawn.some(entry => entry.text === `faltan ${300 - ids.length} entradas; el original las contiene`)).toBe(true)
  await grouped.unmount()
})

// Derivada con la forma que Claude Code 2.1.289 deja en una llamada cuya salida pasó de unos 30 KB: un recorte de
// stdout y la ruta y el tamaño de la salida completa, guardada aparte.
const PERSISTED_SIZE = 128_382
const persistedOutput = (stdout: string) => ({
  stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
  persistedOutputPath: '/tmp/tool-results/fixture.txt', persistedOutputSize: PERSISTED_SIZE,
})
/** El recorte que deja Claude Code de la revisión derivada, y la línea que dice por qué no se resume. */
const savedApart = persistedOutput(JSON.stringify(derivedReview).slice(0, 2000))
const SAVED_APART_LINE = `salida de ${(PERSISTED_SIZE / 1024).toFixed(1).replace('.', ',')} KB guardada aparte por Claude Code`

test('outputs Claude Code saved apart are never summarized and the group says why', async ($, on) => {
  const received = native(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'fixture' }))
  const truncated = savedApart
  // Aunque el recorte fuera un JSON completo, no es la salida entera.
  expect(parseOutput(persistedOutput('{"state":"done"}'), false).kind).toBe('native')
  expect(parseOutput(truncated, false).kind).toBe('native')
  const props = group([call(truncated), call('{"state":"done"}', { tool_use_id: 'next-one' })])
  const grouped = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(80), props })
  expect(await grouped.find({ text: 'sin resumen' })).toBeTruthy()
  expect(await grouped.find({ text: SAVED_APART_LINE })).toBeTruthy()
  expect((await grouped.find({ text: 'sin resumen' }))?.text).toMatch('./bin/sdd-ai sdd status')
  expect(await grouped.find({ text: 'state: done' })).toBeTruthy()
  await grouped.unmount()
  const id = 'persisted'
  await $.tool.call({ tool: 'Bash', tool_use_id: id, command })
  const resultProps = { tool: 'Bash', tool_use_id: id, output: truncated, isErrored: false }
  const single = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: viewport(80), props: resultProps })
  expect(await single.find(NATIVE)).toBeTruthy()
  expect(received.at(-1)).toMatchObject({ props: resultProps })
  await single.unmount()
})

test('a call the group recognizes alone still says why it has no summary, and an interruption wins over the size', async ($, on) => {
  const received = native(on)
  const saved = savedApart
  const alone = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(80), props: group([call(saved)]) })
  expect(await alone.find(NATIVE)).toBe(undefined)
  expect(await alone.find({ text: 'sin resumen' })).toBeTruthy()
  expect(await alone.find({ text: SAVED_APART_LINE })).toBeTruthy()
  const interrupted = { ...saved, interrupted: true }
  expect(parseOutput(interrupted, false).kind).toBe('interrupted')
  await alone.redraw(group([call(interrupted)]))
  expect(await alone.find({ text: 'interrumpida' })).toBeTruthy()
  expect(await alone.find({ text: 'guardada aparte' })).toBe(undefined)
  expect(received).toHaveLength(0)
  await alone.unmount()
})

test('long ledger values are drawn in pieces and the engine limits are checked before drawing', async ($, on) => {
  const received = native(on)
  // Derivada: un estado de 10 001 caracteres en una entrada válida del ledger. Va en tramos, así que el grupo se resume.
  const longState = 'x'.repeat(10_001)
  const output = JSON.stringify({ ledger: [{ ...capturedRow, state: longState }] })
  const ui = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: viewport(166), props: group([call(output)]) })
  expect(await ui.find(NATIVE)).toBe(undefined)
  const pieces = (await ui.findAll({ type: 'Text', text: /^x+$/ })).map((entry) => entry.text)
  expect(pieces.join('')).toBe(longState)
  for (const piece of pieces) expect(piece.length).toBeLessThan(10_000)
  expect(received).toHaveLength(0)
  await ui.unmount()
  // treeFits rechaza un texto de más de 10 000 caracteres, más de 100 000 en total o un carácter de control.
  const text = (children: string[]) => ({ type: 'Text', children }) as unknown as JSX.Element
  const box = (children: JSX.Element[]) => ({ type: 'Box', children }) as unknown as JSX.Element
  expect(treeFits(text(['x'.repeat(10_000)]))).toBe(true)
  expect(treeFits(text(['x'.repeat(10_001)]))).toBe(false)
  expect(treeFits(box(Array.from({ length: 11 }, () => text(['x'.repeat(9_500)]))))).toBe(false)
  expect(treeFits(text(['color \u001b[31m']))).toBe(false)
  expect(treeFits(text(['tab\ty salto\n']))).toBe(true)
})
