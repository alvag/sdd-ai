// Captura literal del 2026-10-03 en una sesión de Claude Code 2.1.289, la versión instalada al implementar:
// el mismo error que domain-error-2.1.288.ts, con las dos formas que dejó el transcript.
export const domainErrorCapture2_1_289 = {
  claude_code_version: '2.1.289',
  captured: '2026-10-03',
  command: './bin/sdd-ai wait 20990101-0000-dead',
  tool_result: {
    tool_use_id: 'toolu_01AZKMrXsfwFcs3ELroyp17t',
    is_error: true,
    content: 'Exit code 1\n{"state":"error","code":"run_not_found","message":"no existe la corrida 20990101-0000-dead","next":"revisa el id que devolvió sdd-ai run"}',
    toolUseResult: 'Error: Exit code 1\n{"state":"error","code":"run_not_found","message":"no existe la corrida 20990101-0000-dead","next":"revisa el id que devolvió sdd-ai run"}',
    version: '2.1.289',
  },
} as const
