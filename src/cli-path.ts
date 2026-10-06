import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

type Env = Record<string, string | undefined>

/**
 * Si el CLI `cmd` se puede lanzar desde `env`. En Windows imita al lanzador sin shell de Node: la variable del
 * PATH es la primera clave en orden de código que, sin distinguir mayúsculas, es `PATH`, y en cada directorio
 * cuentan `<cmd>.com` y `<cmd>.exe`, sin mirar `PATHEXT`; una entrada entre comillas vale sin ellas, como en el
 * lanzador. A diferencia del lanzador, no se busca en el directorio actual: la familia cuenta si está en el PATH.
 * Fuera de Windows, el nombre exacto y ejecutable. `platform` solo elige la rama: el separador del PATH, `join` y
 * `X_OK` son los del sistema donde corre, así que simular `darwin` en Windows vale solo con un directorio.
 */
export function inPath(cmd: string, env: Env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (!dir) continue
      try {
        accessSync(join(dir, cmd), constants.X_OK)
        return true
      } catch {
        // Sigue con el próximo directorio.
      }
    }
    return false
  }
  const key = Object.keys(env).sort().find((k) => k.toUpperCase() === 'PATH')
  for (const entry of (key === undefined ? '' : (env[key] ?? '')).split(';')) {
    const dir = entry.replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    for (const ext of ['.com', '.exe']) {
      try {
        if (statSync(join(dir, `${cmd}${ext}`)).isFile()) return true
      } catch {
        // Sigue con la próxima extensión o directorio.
      }
    }
  }
  return false
}
