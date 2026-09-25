# sdd-ai — instrucciones para agentes

## Trabajo anterior: vault y engram

Los flujos terminados de este proyecto ya no están en `.plans/`: se archivaron y se retiraron del
disco. Para saber por qué se decidió algo, qué alternativas se descartaron o qué se midió, hay dos
fuentes:

- **El vault de Markdown**, en `~/vaults/dev-memory/projects/sdd-ai/`, es la única copia de cada
  flujo terminado: spec, plan, tasks, handoff, hallazgos y mediciones. Los flujos SDD están en
  `sdd/`: cada uno tiene un nodo `<flujo>.md` con su resumen, y sus documentos están en `<flujo>/`.
  El vault no tiene un verbo de búsqueda: se busca con `grep` o `rg` sobre la carpeta del proyecto.
- **Engram** guarda la memoria de las sesiones (decisiones, descubrimientos, errores y preferencias)
  en el proyecto `sdd-ai`. Con `mem_search` se busca un tema y con `mem_context` se recupera lo
  reciente.

Conviene consultarlos antes de rediseñar o investigar algo que puede estar resuelto, o cuando el
código cita un motivo que no está escrito. Para el trabajo de código de todos los días, alcanza con
el fuente y el historial de Git.
