/**
 * Los efectos que el mod nunca usa, ni para presentar ni para avisar: ejecución, herramientas, avisos visuales propios,
 * llenar el prompt, borrar o listar el store, cancelar un turno, el entorno, procesos, red, modelos, agentes y mensajes de sesión.
 * El aviso además usa `prompt.read`, `store.get`, `prompt.submit`, `fs.write` y `store.set`: no están en esta lista, y
 * cada test decide si los admite (la presentación sola no usa ninguno de los que escriben).
 */
export const NEVER_EFFECTS = [
  'tool.register', 'ui.toast', 'ui.status', 'ui.notice', 'prompt.fill',
  'store.delete', 'store.keys', 'turn.abort', 'env.set', 'process.run', 'http.fetch', 'mcp.call', 'model.complete', 'model.fork',
  'agent.spawn', 'session.append', 'session.send',
] as const

/** Las excepciones de presentación conservan guardas sobre nombres, panes y foco. */
export function guardPanelEffects(on: import('claude-code').On): void {
  const own = (id: string) => id === 'sdd-panel' || id === 'sdd-runs'
  on('command.register', (_$, e, next) => {
    if (!own(e.name) || e.immediate !== true) throw new Error('Registro de comando fuera del panel autorizado.')
    return next(e)
  })
  on('ui.open', (_$, e, next) => {
    if (!own(e.id) || e.closeOnEscape !== true || e.focus !== undefined) throw new Error('Apertura fuera del pane autorizado.')
    return next(e)
  })
  on('ui.close', (_$, e, next) => {
    if (!own(e.id)) throw new Error('Cierre fuera del pane autorizado.')
    return next(e)
  })
}

/** Solo los dos comandos inmediatos del panel. La guarda de panes está en `paneRegistry({ guard: true })`. */
export function guardCommandRegistration(on: import('claude-code').On): void {
  const own = (id: string) => id === 'sdd-panel' || id === 'sdd-runs'
  on('command.register', (_$, e, next) => {
    if (!own(e.name) || e.immediate !== true) throw new Error('Registro de comando fuera del panel autorizado.')
    return next(e)
  })
}
