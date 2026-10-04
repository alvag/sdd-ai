import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** El módulo que registra los hooks: el único que recibe `$`. Los auxiliares son puros. */
const REGISTER = './register.tsx'
/** El marcador del informe de `claude plugin validate` que lista lo que llama cada módulo. */
const CALLS = 'calls:'
const ALLOWED = new Set(['$.ui.resolve', '$.state.get', '$.state.set'])
/**
 * El tope de todo el modo, no de cada paso: los pasos de `test` comparten cuatro minutos, menos que el tope de cinco de
 * V7, así que un paso colgado se corta con un mensaje que lo nombra antes de que lo corte el arnés. El corte llega al
 * proceso directo del paso; los que ese proceso haya lanzado terminan si él los cierra al recibir la señal.
 */
const BUDGET_MS = 4 * 60 * 1000
const deadline = Date.now() + BUDGET_MS
/** El tope de la salida capturada de un paso: mucho mayor que el de 1 MiB que Node pone por defecto. */
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024

/** Lo que queda del tope para un paso; si ya no queda nada, el paso no arranca. */
function remaining(step) {
  const left = deadline - Date.now()
  if (left <= 0) throw new Error(`${step} no arrancó: se agotó el tope de ${BUDGET_MS / 60_000} minutos`)
  return left
}

function finish(step, result) {
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${step} se cortó: agotó el tope de ${BUDGET_MS / 60_000} minutos`)
  if (result.error) throw result.error
  if (result.signal) throw new Error(`${step} terminó por la señal ${result.signal}`)
  if (result.status !== 0) throw new Error(`${step} terminó con código ${result.status}`)
}

/** Un paso cuyo informe hay que leer: se captura entero, hasta `CAPTURE_MAX_BYTES`, y se muestra al terminar. */
function capture(command, args) {
  const step = [command, ...args].join(' ')
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: CAPTURE_MAX_BYTES, timeout: remaining(step) })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  finish(step, result)
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

/** Un paso cuya salida no se lee: la hereda, así se ve mientras corre. */
function inherit(command, args) {
  const step = [command, ...args].join(' ')
  finish(step, spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: remaining(step) }))
}

try {
  if (process.argv[2] === 'test') {
    const report = capture('claude', ['plugin', 'validate', '--strict', 'mods/sdd-ai']).replace(/\x1b\[[0-9;]*m/g, '')
    // Se revisan las líneas de llamadas de todos los módulos del informe, no solo la del registro: un auxiliar puede
    // traer la suya vacía, pero ninguna llamada.
    const declared = report.split('\n').flatMap((line) => {
      const match = new RegExp(`❯\\s+(\\S+)\\s+${CALLS}(.*)$`).exec(line)
      return match ? [{ module: match[1], calls: match[2].trim().split(/[\s,]+/).filter(Boolean) }] : []
    })
    if (!declared.some(({ module }) => module === REGISTER)) throw new Error(`la validación no informa ${CALLS} de ${REGISTER}`)
    for (const { module, calls } of declared) {
      if (module !== REGISTER) {
        if (calls.length) throw new Error(`solo ${REGISTER} recibe $, y ${module} declara llamadas: ${calls.join(', ')}`)
        continue
      }
      if (!calls.length) throw new Error(`la línea ${CALLS} de ${REGISTER} no lista llamadas`)
      const forbidden = calls.filter((call) => !ALLOWED.has(call))
      if (forbidden.length) throw new Error(`llamadas no permitidas en ${REGISTER}: ${forbidden.join(', ')}`)
    }
    inherit('claude', ['plugin', 'test', 'mods/sdd-ai'])
  } else if (process.argv[2] === 'typecheck') {
    const copy = resolve('.claude/skills/sdd-ai-mod')
    if (!existsSync(copy)) throw new Error('falta la copia del mod: ejecuta ./bin/sdd-ai agents sync')
    const types = join(copy, '.claude-plugin/types')
    if (!['claude-code', 'claude-code-tools', 'claude-code-mcp', 'tsconfig.json'].every((path) => existsSync(join(types, path)))) {
      // El motor escribe los tipos junto a un mod cargado con --plugin-dir, no junto a la copia que carga desde
      // las skills del proyecto; ese --plugin-dir desplaza a la copia del proyecto y no duplica el mod.
      throw new Error('faltan las declaraciones del motor: genéralas con claude -p --plugin-dir .claude/skills/sdd-ai-mod --model haiku ok')
    }
    const temporary = mkdtempSync(join(tmpdir(), 'sdd-ai-mod-types-'))
    try {
      const config = join(temporary, 'tsconfig.json')
      writeFileSync(config, JSON.stringify({ extends: join(types, 'tsconfig.json'), compilerOptions: { noEmit: true }, include: ['hooks', 'types', 'tests'].map((dir) => resolve('mods/sdd-ai', dir)) }))
      inherit('tsc', ['-p', config])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  } else throw new Error('uso: node scripts/mods.mjs test|typecheck')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
