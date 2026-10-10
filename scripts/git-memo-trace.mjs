// Precarga explícita: no selecciona otro Git, no cambia PATH y no crea un destino implícito.
import cp from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { channel } from 'node:diagnostics_channel'

const self = import.meta.url
const params = new URL(self).searchParams
const output = params.get('out')
const operation = params.get('op')
if (!output || !operation) throw new Error('git-memo-trace requiere ?out=<ruta>&op=<operación>')
let sequence = 0
let depth = 0
const pending = []
// Los lanzamientos asíncronos que todavía no cerraron, para declararlos al salir.
const inflight = new Map()
const write = (row) => appendFileSync(output, JSON.stringify({ schema: 1, pid: process.pid, operation, ...row }) + '\n')

export function classify(file, argv) {
  if (basename(String(file)).replace(/\.exe$/i, '') !== 'git') return null
  if (!argv.includes('rev-parse')) return 'other'
  if (argv.includes('--show-toplevel')) return 'repoRoot'
  if (argv.includes('--git-common-dir')) return 'gitDirs'
  if (argv.includes('--git-path') && argv[argv.indexOf('--git-path') + 1] === 'objects') return 'objects'
  return 'other'
}

channel('sdd-ai:git-memo').subscribe((event) => {
  write({ kind: 'memo', event })
  if (event.kind === 'miss' || event.kind === 'bypass') pending.push(event)
})

// Un proceso lanzado con `-e` lleva su programa en process.execArgv: si un fork lo hereda, el hijo vuelve a
// evaluar ese programa en vez de su módulo y la recursión no termina. Al heredar se descartan esas opciones.
const EVAL_WITH_VALUE = new Set(['-e', '--eval', '-p', '--print', '--input-type'])
function inherited(execArgv) {
  const out = []
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]
    if (EVAL_WITH_VALUE.has(arg)) { i++; continue }
    if (/^(--eval|--print|--input-type)=/.test(arg)) continue
    out.push(arg)
  }
  return out
}

function inject(argv) {
  const args = [...argv]
  if (!args.some((arg, i) => arg === '--import' && args[i + 1] === self) && !args.includes(`--import=${self}`)) args.unshift('--import', self)
  return args
}

for (const api of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = cp[api]
  cp[api] = function (...args) {
    if (depth > 0) return Reflect.apply(original, this, args)
    const shell = api === 'exec' || api === 'execSync'
    const fork = api === 'fork'
    const file = shell ? '<shell>' : fork ? process.execPath : args[0]
    const functional = shell ? [String(args[0])] : fork ? [String(args[0]), ...(Array.isArray(args[1]) ? args[1] : [])] : Array.isArray(args[1]) ? [...args[1]] : []
    // Las opciones van después de los argumentos, también cuando estos vienen indefinidos: fork(m, undefined, opts).
    const optionsIndex = Array.isArray(args[1]) || (args[1] == null && args.length > 2) ? 2 : 1
    const options = args[optionsIndex]
    const cwd = options && typeof options === 'object' && options.cwd !== undefined ? String(options.cwd) : process.cwd()
    const query = classify(file, functional)
    const synchronous = api.endsWith('Sync')
    let memo = null
    if (synchronous && query && query !== 'other') {
      const compatible = pending.filter((event) => event.query === query)
      if (compatible.length === 1) {
        memo = compatible[0].seq
        pending.splice(pending.indexOf(compatible[0]), 1)
      } else if (compatible.length > 1) write({ kind: 'correlation_error', reason: 'ambiguous', query })
    }
    const id = `${process.pid}:${++sequence}`
    write({ kind: 'process', stage: 'attempt', id, api, file: String(file), argv: functional, cwd, query, memo,
      scope: memo === null ? null : undefined })
    const started = performance.now()
    const finish = (row) => write({ kind: 'process', stage: 'completion', id, duration_ms: performance.now() - started, ...row })
    const launched = [...args]
    if (fork) {
      launched[optionsIndex] = { ...(options ?? {}), execArgv: inject(options?.execArgv ?? inherited(process.execArgv)) }
    } else if (!shell && String(file) === process.execPath) {
      if (Array.isArray(args[1])) launched[1] = inject(args[1])
      else launched.splice(1, 0, inject([]))
    }
    let result
    try {
      depth++
      result = Reflect.apply(original, this, launched)
    } catch (error) {
      finish({ observed: typeof error.status === 'number' || error.signal != null, exit_code: error.status ?? null,
        signal: error.signal ?? null, error: { code: error.code ?? null, message: error.message }, child_pid: error.pid ?? null })
      throw error
    } finally { depth-- }
    if (synchronous) {
      const spawn = api === 'spawnSync'
      finish({ observed: spawn ? !!result.pid : true, child_pid: spawn ? result.pid || null : null,
        exit_code: spawn ? result.status : 0, signal: spawn ? result.signal : null,
        error: spawn && result.error ? { code: result.error.code ?? null, message: result.error.message } : null })
    } else {
      // El error se observa sin agregar un listener: un 'error' sin manejador propio tiene que seguir terminando el
      // programa medido, igual que sin traza.
      const launch = { started, child_pid: result.pid ?? null, error: null }
      const emit = result.emit
      result.emit = function (name, ...rest) {
        // Un error sin manejador termina el proceso antes de 'close': queda en el lanzamiento para declararlo al salir.
        if (name === 'error') launch.error = { code: rest[0]?.code ?? null, message: rest[0]?.message ?? null }
        return Reflect.apply(emit, this, [name, ...rest])
      }
      inflight.set(id, launch)
      result.once('close', (code, signal) => { inflight.delete(id); finish({ observed: !!result.pid, child_pid: result.pid ?? null, exit_code: code, signal, error: launch.error }) })
    }
    return result
  }
}
syncBuiltinESMExports()
process.once('exit', () => {
  // Los lanzamientos asíncronos sin cierre cuando este proceso termina. Un hijo desligado o con unref que arrancó sigue
  // vivo: queda fuera de la cobertura (no observado). Uno que falló al lanzarse nunca existió: conserva su error.
  for (const [id, launch] of inflight) write({ kind: 'process', stage: 'completion', id, duration_ms: performance.now() - launch.started,
    observed: false, alive_at_exit: launch.error === null && launch.child_pid !== null, child_pid: launch.child_pid, exit_code: null, signal: null, error: launch.error })
  for (const event of pending) write({ kind: 'correlation_error', reason: 'unmatched', seq: event.seq, query: event.query })
})
