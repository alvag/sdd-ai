import { createRequire, syncBuiltinESMExports } from 'node:module'

const fs: Record<string, (...args: any[]) => any> = createRequire(import.meta.url)('node:fs')
const target = process.env.SDD_AI_TEST_FAULT_TARGET
const operation = process.env.SDD_AI_TEST_FAULT_OPERATION
const observations = process.env.SDD_AI_TEST_FAULT_OBSERVATIONS
const append = fs.appendFileSync
const read = fs.readFileSync

/** Se limita a rutas temporales declaradas por la fixture, nunca a la configuración real. */
if (target && observations) {
  const descriptors = new Map<number,string>()
  for (const name of ['mkdirSync','openSync','closeSync','writeFileSync','linkSync','unlinkSync','readFileSync','renameSync']) {
    const original = fs[name]
    fs[name] = (...args: any[]) => {
      const path = typeof args[0] === 'number' ? descriptors.get(args[0]) ?? String(args[0]) : String(args[0])
      if (path === target || path.startsWith(`${target}/`) || path.startsWith(`${target}.`)) {
        const failed = name === operation
        append(observations, `${JSON.stringify({ operation: name, path, failed })}\n`)
        if (failed) throw Object.assign(new Error('injected filesystem failure'), { code: 'EACCES' })
      }
      // La cita debe existir antes de mkdir de la corrida, además de antes del worker.
      const registry = process.env.SDD_AI_TEST_CITATION_REGISTRY
      const runs = process.env.SDD_AI_TEST_CITATION_RUNS
      if (registry && runs && name === 'mkdirSync' && path.startsWith(`${runs}/`)) {
        let record: unknown = null
        try { record = JSON.parse(read(registry, 'utf8')) } catch { /* La ausencia también se observa. */ }
        append(observations, `${JSON.stringify({ operation: 'create_run', id: path.slice(runs.length + 1), registry: record })}\n`)
      }
      if (registry && name === 'renameSync' && String(args[1]) === registry) {
        append(observations, `${JSON.stringify({ operation: 'registry_write',record: JSON.parse(read(path,'utf8')) })}\n`)
      }
      const result = original(...args)
      if (name === 'openSync') descriptors.set(result,path)
      if (name === 'closeSync') descriptors.delete(args[0])
      return result
    }
  }
  syncBuiltinESMExports()
  if (operation === 'gitDirs') {
    const cp: Record<string, (...args: any[]) => any> = createRequire(import.meta.url)('node:child_process')
    const exec = cp.execFileSync
    cp.execFileSync = (...args: any[]) => {
      if (args[0] === 'git' && args[1]?.includes('--git-common-dir') && args[2]?.cwd === target) {
        append(observations, `${JSON.stringify({ operation: 'gitDirs',failed: true })}\n`)
        throw new Error('injected Git identity failure')
      }
      return exec(...args)
    }
    syncBuiltinESMExports()
  }
}
