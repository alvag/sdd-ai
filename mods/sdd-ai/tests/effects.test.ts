import type { On, ToolCallResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { domainErrorCapture2_1_288 } from './fixtures/domain-error-2.1.288'

const command = domainErrorCapture2_1_288.command
const forbidden = [
  'command.register', 'tool.register', 'clock.after', 'clock.every',
  'ui.toast', 'ui.status', 'ui.notice', 'ui.open', 'prompt.submit',
  'fs.write', 'store.set', 'store.delete', 'env.set',
] as const

function watchEffects(on: On): string[] {
  const effects: string[] = []
  for (const name of forbidden) on(name, () => {
    effects.push(name)
    throw new Error(`unexpected presentation effect: ${name}`)
  })
  return effects
}

// Observa las escrituras de atribución y las deja llegar al estado real de la sesión de prueba; un
// almacenamiento fallido se simula con un rechazo, que hace fallar `$.state.set` del mod.
function attribution(on: On, fail = false) {
  const writes: unknown[] = []
  on('state.set', { plugin: 'sdd-ai-mod', key: 'attribution' }, (_$, e, next) => {
    writes.push(e)
    return fail ? { deny: 'cannot store attribution' } : next(e)
  })
  return { writes }
}

const responses: { name: string; value: ToolCallResult<'Bash'> }[] = [
  { name: 'structured record text reference context and read-only marker', value: { result: { stdout: '{"state":"done"}\n', stderr: 'warning\n', interrupted: false }, text: 'unchanged model text', ref: 42, context: ['unchanged context'], isReadOnly: true } },
  { name: 'permission denial', value: { deny: 'not allowed' } },
  { name: 'domain error text and reference', value: { result: domainErrorCapture2_1_288.tool_result.toolUseResult, text: domainErrorCapture2_1_288.tool_result.content, ref: 43, isError: true, isReadOnly: true } },
]

for (const response of responses) for (const failedStorage of [false, true]) test(`tool.call continues exactly once with intact ${response.name}; failed storage=${failedStorage}`, async ($, on) => {
  const effects = watchEffects(on)
  const { writes } = attribution(on, failedStorage)
  const input = { tool: 'Bash' as const, tool_use_id: 'effects-call', command, timeout: 1234, description: 'fixture input' }
  let continued = 0
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    continued++
    expect(e).toMatchObject(input)
    return response.value
  })
  expect(await $.tool.call(input)).toEqual(response.value)
  expect(continued).toBe(1)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ plugin: 'sdd-ai-mod', key: 'attribution', id: input.tool_use_id, value: { command } })
  expect(effects).toEqual([])
})

test('a continuation that fails reaches the caller as the engine raises it, once per call', async ($, on) => {
  const effects = watchEffects(on)
  attribution(on)
  let continued = 0
  // El hook inferior lanza para cualquier herramienta: el motor lo salta y la continuación rechaza.
  on('tool.call', () => {
    continued++
    throw new Error('lower continuation failed')
  })
  const failure = async (input: Parameters<typeof $.tool.call>[0]) => {
    try {
      await $.tool.call(input)
      return undefined
    } catch (error) {
      return error
    }
  }
  // La referencia es el error de una herramienta que el mod no observa; el de Bash pasa por el mod y tiene que ser igual.
  const reference = await failure({ tool: 'Read', tool_use_id: 'reference', file_path: '/fixture' } as never)
  const throughMod = await failure({ tool: 'Bash', tool_use_id: 'throwing', command })
  expect(reference).toBeInstanceOf(Error)
  expect(throughMod).toBeInstanceOf(Error)
  expect((throughMod as Error).name).toBe((reference as Error).name)
  expect((throughMod as Error).message).toBe((reference as Error).message)
  // Un hook inferior por llamada: el mod no reintenta la continuación.
  expect(continued).toBe(2)
  expect(effects).toEqual([])
})

test('unrecognized Bash calls continue without recording attribution', async ($, on) => {
  const effects = watchEffects(on)
  const { writes } = attribution(on)
  const result = { deny: 'fixture' }
  let continued = 0
  on('tool.call', { tool: 'Bash' }, () => { continued++; return result })
  // Cada llamada lleva su tool_use_id: si no se guarda atribución es porque el comando no se reconoce.
  for (const [index, command] of ['echo ./bin/sdd-ai', './bin/sdd-ai sdd status | cat', './bin/sdd-ai sdd status; ./bin/sdd-ai sdd status'].entries()) {
    expect(await $.tool.call({ tool: 'Bash', tool_use_id: `unrecognized-${index}`, command })).toEqual(result)
  }
  expect(continued).toBe(3)
  expect(writes).toEqual([])
  expect(effects).toEqual([])
})

test('drawing redrawing and expansion execute no tools or next actions and have no product effects', async ($, on) => {
  const effects = watchEffects(on)
  const { writes } = attribution(on)
  let continued = 0
  const next = 'DO_NOT_EXECUTE_THIS_NEXT_COMMAND'
  const output = `{ "state": "done", "next": "${next}" }\n`
  const response: ToolCallResult<'Bash'> = { result: { stdout: output, stderr: '', interrupted: false }, text: output, ref: 99 }
  on('tool.call', { tool: 'Bash' }, () => { continued++; return response })
  const nativeProps: unknown[] = []
  on('ui.render', ($, e) => {
    nativeProps.push(e.props)
    return $.ui.resolve(e).Text({ children: 'native renderer' })
  })
  const id = 'draw-effects'
  expect(await $.tool.call({ tool: 'Bash', tool_use_id: id, command })).toEqual(response)
  const resultProps = { tool: 'Bash', tool_use_id: id, output: response.result, isErrored: false }
  const single = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolResult', viewport: { columns: 80, rows: 50 }, props: resultProps })
  expect(await single.find({ type: 'Text', text: next })).toBeTruthy()
  expect(await single.find({ type: 'Text', text: output })).toBeTruthy()
  await single.redraw()
  const props = { calls: [{ tool: 'Bash', tool_use_id: id, input: { command }, output: response.result, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded: false }
  const group = await $.ui.mount({ plugin: 'sdd-ai-mod', surface: 'terminal', component: 'ToolGroup', viewport: { columns: 80, rows: 50 }, props })
  await group.redraw({ ...props, isExpanded: true })
  expect(nativeProps.at(-1)).toEqual({ ...props, isExpanded: true })
  await group.redraw(props)
  expect(continued).toBe(1)
  expect(writes).toHaveLength(1)
  expect(effects).toEqual([])
  await single.unmount()
  await group.unmount()
})
