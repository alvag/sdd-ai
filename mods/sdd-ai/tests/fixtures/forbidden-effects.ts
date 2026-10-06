/**
 * Los efectos que el mod nunca usa, ni para presentar ni para avisar: comandos, herramientas, avisos visuales propios,
 * llenar el prompt, borrar o listar el store, cancelar un turno, el entorno, procesos, red, modelos, agentes y mensajes de sesión.
 * El aviso además usa `prompt.read`, `store.get`, `prompt.submit`, `fs.write` y `store.set`: no están en esta lista, y
 * cada test decide si los admite (la presentación sola no usa ninguno de los que escriben).
 */
export const NEVER_EFFECTS = [
  'command.register', 'tool.register', 'ui.toast', 'ui.status', 'ui.notice', 'ui.open', 'prompt.fill',
  'store.delete', 'store.keys', 'turn.abort', 'env.set', 'process.run', 'http.fetch', 'mcp.call', 'model.complete', 'model.fork',
  'agent.spawn', 'session.append', 'session.send',
] as const
