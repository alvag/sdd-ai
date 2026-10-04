// Captura literal del 2026-10-03; no requiere el transcript ni los artefactos del flujo.
export const domainErrorCapture2_1_288 = {
  claude_code_version: '2.1.288',
  captured: '2026-10-03',
  command: './bin/sdd-ai wait 20990101-0000-dead',
  tool_result: {
    tool_use_id: 'toolu_0184ARX3PKFkdhvFou1qi6mp',
    is_error: true,
    content: 'Exit code 1\n{"state":"error","code":"run_not_found","message":"no existe la corrida 20990101-0000-dead","next":"revisa el id que devolvió sdd-ai run"}',
    toolUseResult: 'Error: Exit code 1\n{"state":"error","code":"run_not_found","message":"no existe la corrida 20990101-0000-dead","next":"revisa el id que devolvió sdd-ai run"}',
    version: '2.1.288',
  },
} as const
