import { type Conductor, type Family, SddError, isFamily, isNativeEffort, toNativeEffort } from './types.ts'

type Env = Record<string, string | undefined>

/**
 * Familia del conductor: el flag manda; sin flag, se detecta por las variables que cada CLI expone a
 * su shell. Si el entorno no permite decidir, se exige el flag en vez de adivinar.
 */
export function detectConductor(
  env: Env,
  flags: { conductor?: string; conductorModel?: string; conductorEffort?: string },
): Conductor {
  let family: Family
  if (flags.conductor !== undefined) {
    if (!isFamily(flags.conductor)) {
      throw new SddError('usage', `conductor desconocido: ${flags.conductor}`, { next: 'usa --conductor claude|codex' })
    }
    family = flags.conductor
  } else {
    const claude = env.CLAUDECODE === '1'
    const codex = Boolean(env.CODEX_THREAD_ID)
    if (claude === codex) {
      throw new SddError('conductor_unknown', 'no se pudo detectar la familia del conductor', {
        detail: claude ? 'el entorno tiene señales de Claude Code y de Codex a la vez' : 'el entorno no tiene señales de ningún CLI',
        next: 'pasa --conductor claude|codex',
      })
    }
    family = claude ? 'claude' : 'codex'
  }

  const conductor: Conductor = { family }
  if (flags.conductorModel) conductor.model = flags.conductorModel
  // Codex no expone su esfuerzo al shell, así que solo lo conoce si el conductor lo declara.
  if (flags.conductorEffort !== undefined) conductor.effort = toNativeEffort(flags.conductorEffort)
  else if (family === 'claude' && isNativeEffort(env.CLAUDE_EFFORT)) conductor.effort = env.CLAUDE_EFFORT
  return conductor
}
