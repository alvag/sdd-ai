import { MOD_ADOPTION_MESSAGE } from './mod-copies.ts'
import { type Family } from './types.ts'

export type AdoptionComponent = 'agents' | 'skill' | 'mod'

/** Guardas de orientación: emitirlas no sincroniza, repara ni libera una reserva. */
export const ADOPTION_GUARDS = 'Antes de sincronizar con un writer reservado, espera el cese comprobado y la cosecha. Ante cessation_uncertain, detente sin escrituras en el árbol y pregunta al usuario; no liberes la reserva por tu cuenta. La orientación no autoriza reparación automática, recuperación ni gates humanos; no exige cancelación de corridas, init o cambios de configuración global.'

/** Orientación pura por familia e incidencias; el estado de las copias no acredita carga. */
export function adoptionGuidance(family: Family, components: readonly AdoptionComponent[] = ['agents', 'skill', 'mod']): string {
  const lines = [family === 'claude' ? 'Claude Code 2.1.296 en macOS:' : 'Codex 0.162.1 en macOS:']
  if (family === 'claude') {
    for (const component of components) {
      if (component === 'mod') lines.push(MOD_ADOPTION_MESSAGE)
      else if (component === 'agents') lines.push('Agentes: /reload-plugins en primera carga, carga previa desconocida y actualización; comprueba con Agent que responde con las instrucciones vigentes antes de seguir. En actualización, la adopción automática de agentes no es fiable en el entorno probado.')
      else lines.push('Skill y apoyos: primera carga o carga previa desconocida → /reload-plugins; actualización con operación previa comprobada → adopción automática, con /reload-plugins como alternativa adicional comprobada.')
    }
    if (components.includes('skill')) lines.push('/reload-skills solo adopta la skill; no es un paso adicional obligatorio después de /reload-plugins.')
    lines.push('Fallback de sesión nueva: /exit y claude --resume <id>, usando el comando mostrado al salir en la misma terminal. En el entorno probado conserva el id y la conversación.')
  } else {
    if (components.includes('skill')) lines.push('Skill y apoyos: adopción automática en primera carga y actualización; no requieren un hilo nuevo solo para la skill.')
    if (components.includes('agents')) lines.push('Agentes: primera carga o carga previa desconocida → /fork y Use current Git worktree. Conserva conversación y terminal, crea un hilo nuevo y cambia CODEX_THREAD_ID. Actualización con agentes previamente operativos comprobados → adopción automática; /fork también está comprobado en esa condición. Fallback: /new adopta agentes y pierde la conversación. Resume del hilo original no adopta agentes nuevos. Antes de /fork o /new, recibe las corridas nativas abiertas de esta sesión: el hilo nuevo no ve ni recibe las nativas del hilo anterior. La adopción automática no lo requiere. Después de /fork o /new, ejecuta ./bin/sdd-ai sdd status <id> para ligar la sesión nueva al flujo antes de continuar o recibir; no acredita transferencia nativa ni entrega.')
    lines.push('Mod: no aplicable; el mod no opera en Codex.')
    if (components.includes('skill')) lines.push('Si la adopción automática de la skill falla o no está verificada en tu entorno, conserva una sesión nueva como fallback, sin garantía de conversación conservada.')
  }
  lines.push('Carga previa comprobada significa uso efectivo de la skill y sus apoyos, invocación real del agente u operación observable del mod en Claude, según el componente. Archivos, hashes y contadores no acreditan carga; missing, stale y ok describen disco, no sesión. Sin observación previa, trata la carga como desconocida.',
    'Las garantías se limitan a las versiones y macOS indicados. En otras versiones o sistemas las opciones ensayadas carecen de verificación actual: conserva sesión nueva como fallback y comprueba operación antes de continuar, sin prometer recarga universal ni conservación de conversación. Retoma el flujo persistido sin reiniciarlo: la adopción no altera por sí sola artefactos, aprobaciones, corridas ni su relación con flujo y checkout; continuidad con corridas vivas requiere comprobación operacional.',
    ADOPTION_GUARDS)
  return lines.join('\n')
}

/** Sync distribuye ambas familias; init permite omitir el mod si su copia no cambió. */
export function allAdoptionGuidance(includeMod = true): string {
  return [adoptionGuidance('claude', includeMod ? ['agents', 'skill', 'mod'] : ['agents', 'skill']), adoptionGuidance('codex', ['agents', 'skill'])].join('\n')
}
