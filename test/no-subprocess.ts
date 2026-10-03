// Un archivo *.unit.test.ts no puede lanzar subprocesos, ni directamente ni a través de src/.
// `npm test` y `npm run test:unit` cargan este módulo con --import. El runner de Node 26 lo carga solo en
// el proceso de cada archivo de test, que lanza con la ruta del archivo como primer argumento, y no en
// su propio proceso, el que corre con --test y necesita lanzar a los demás: por las dudas, ahí no actúa.
// test/no-subprocess.test.ts comprueba los dos lados. Con --test-isolation=none, que corre todos los
// archivos en un solo proceso, no actúa.
import { createRequire, syncBuiltinESMExports } from 'node:module'

if (!process.execArgv.includes('--test') && process.argv[1]?.endsWith('.test.ts')) {
  process.env.SDD_AI_TELEMETRY = 'off'
}

if (!process.execArgv.includes('--test') && process.argv[1]?.endsWith('.unit.test.ts')) {
  const childProcess: Record<string, unknown> = createRequire(import.meta.url)('node:child_process')
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[name] = (...args: unknown[]): never => {
      throw new Error(`Un test unitario no puede lanzar subprocesos: ${name}(${String(args[0])})`)
    }
  }
  syncBuiltinESMExports()
}
