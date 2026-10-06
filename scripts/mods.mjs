import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** El módulo que registra los hooks: el único que recibe `$`. Los auxiliares son puros. */
const REGISTER = './register.tsx'
/** El marcador del informe de `claude plugin validate` que lista lo que llama cada módulo. */
const CALLS = 'calls:'
/**
 * Las llamadas exactas que admite el registro: dibujar y guardar su estado de presentación; leer la proyección con
 * `list`, `stat` y `read`; identificar la sesión y su raíz, y sostener el refresco con el reloj. Se comparan por
 * llamada: otra de la misma familia (`$.fs.exists`, `$.clock.sleep`, `$.session.send`) queda fuera. El avisador
 * admite lectura del borrador, submit, su señal propia y persistencia; las rutas y momentos se prueban en el motor.
 */
const ALLOWED = new Set([
  '$.ui.resolve', '$.state.get', '$.state.set',
  '$.fs.list', '$.fs.stat', '$.fs.read',
  '$.session.id', '$.session.root',
  '$.clock.every', '$.clock.after', '$.clock.now',
  '$.prompt.submit', '$.prompt.read', '$.fs.write', '$.store.get', '$.store.set',
  '$.command.register', '$.ui.open', '$.ui.close', '$.ui.panes', '$.env.get',
])
/**
 * La anotación con la que el informe dice por qué funciones del módulo pasa una llamada hecha fuera de un hook, como en
 * `$.fs.read (via readProjection)`. No es una llamada: se quita antes de comparar.
 */
const VIA = /\s*\(via\b[^)]*\)/g
/** Las secuencias de escape de la terminal (CSI, OSC y las de dos caracteres) que el motor puede intercalar. */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g
/** El diagnóstico del motor cuando una sesión anterior guardó apagado el interruptor de rollout de los mods. */
const ROLLOUT_SAVED_OFF = 'hooks modules are turned off in this process: the rollout switch was saved off by an earlier session'
/** La recuperación es manual: refrescar el interruptor llama al modelo, y el script nunca lo hace. */
const ROLLOUT_RECOVERY = [
  'Claude Code apagó los módulos de hooks en este proceso porque una sesión anterior guardó apagado su interruptor de rollout.',
  'Para refrescarlo, ejecuta a mano y con acceso a la red: claude -p --model haiku ok',
  'Después, vuelve a correr: npm run test:mods',
  'Este script no lo refresca por su cuenta, porque esa ejecución llama al modelo.',
].join('\n')
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

/**
 * Reconoce el diagnóstico del interruptor de rollout en la salida de un canal. La terminal puede partirlo en cualquier
 * punto, incluso dentro de una palabra, y sangrar o colorear cada tramo: se compara sin los escapes ni los espacios.
 */
function rolloutSavedOff(output) {
  const compact = (text) => text.replace(ANSI, '').replace(/\s+/g, '')
  return compact(output).includes(compact(ROLLOUT_SAVED_OFF))
}

/** El error que nombra el paso que falló, o `null` si terminó bien. */
function failure(step, result) {
  if (result.error?.code === 'ETIMEDOUT') return new Error(`${step} se cortó: agotó el tope de ${BUDGET_MS / 60_000} minutos`)
  if (result.error) return result.error
  if (result.signal) return new Error(`${step} terminó por la señal ${result.signal}`)
  if (result.status !== 0) return new Error(`${step} terminó con código ${result.status}`)
  return null
}

/**
 * Cierra un paso con el error que lo nombra. Si alguno de sus canales trae el diagnóstico del interruptor de rollout,
 * el paso falla aunque haya terminado con 0, porque el motor no corrió los módulos, y el error agrega la recuperación.
 */
function finish(step, result, outputs = []) {
  const error = failure(step, result)
  if (outputs.some(rolloutSavedOff)) throw new Error(`${error?.message ?? `${step} no corrió los módulos de hooks, aunque terminó con código 0`}\n${ROLLOUT_RECOVERY}`)
  if (error) throw error
}

/**
 * Un paso cuya salida hay que leer antes de propagar su fallo: se capturan stdout y stderr enteros, hasta
 * `CAPTURE_MAX_BYTES`, y se muestran al terminar, tal como llegaron, en su mismo canal.
 */
function capture(command, args) {
  const step = [command, ...args].join(' ')
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: CAPTURE_MAX_BYTES, timeout: remaining(step) })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  finish(step, result, [result.stdout ?? '', result.stderr ?? ''])
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

/** Un paso cuya salida no se lee: la hereda, así se ve mientras corre. */
function inherit(command, args) {
  const step = [command, ...args].join(' ')
  finish(step, spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: remaining(step) }))
}

try {
  if (process.argv[2] === 'test') {
    const inspectEnvironment = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { inspectEnvironment(path); continue }
        if (!/\.tsx?$/.test(entry.name)) continue
        const source = readFileSync(path, 'utf8')
        for (const match of source.matchAll(/\$\s*\.\s*env\s*\.\s*get\s*\(/g)) {
          const argument = source.slice(match.index + match[0].length)
          if (!/^\s*(['"])(CLAUDE_CONFIG_DIR|HOME)\1\s*\)/.test(argument)) {
            throw new Error(`$.env.get solo admite los literales CLAUDE_CONFIG_DIR y HOME: ${path}`)
          }
        }
      }
    }
    inspectEnvironment('mods/sdd-ai/hooks')
    const report = capture('claude', ['plugin', 'validate', '--strict', 'mods/sdd-ai']).replace(ANSI, '')
    // Se revisan las líneas de llamadas de todos los módulos del informe, no solo la del registro: un auxiliar puede
    // traer la suya vacía, pero ninguna llamada.
    const declared = report.split('\n').flatMap((line) => {
      const match = new RegExp(`❯\\s+(\\S+)\\s+${CALLS}(.*)$`).exec(line)
      return match ? [{ module: match[1], calls: match[2].replace(VIA, '').trim().split(/[\s,]+/).filter(Boolean) }] : []
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
    // Se captura en vez de heredarse, para buscar el diagnóstico del interruptor antes de propagar el fallo: la salida
    // se ve al terminar el paso, no mientras corre.
    capture('claude', ['plugin', 'test', 'mods/sdd-ai'])
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
      // El tsc del proyecto primero: una verificación que corre el script sin npm no tiene node_modules/.bin en el PATH.
      const local = resolve('node_modules/.bin/tsc')
      inherit(existsSync(local) ? local : 'tsc', ['-p', config])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  } else throw new Error('uso: node scripts/mods.mjs test|typecheck')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
