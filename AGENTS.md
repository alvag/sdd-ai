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

## Idioma de los nombres

El código se nombra en inglés y se explica en español. La regla vale también para las specs, los
planes y las tasks que proponen nombres: un nombre en español ahí termina en el código.

- **En inglés:**
  - los identificadores: funciones, tipos, variables, constantes y archivos;
  - las claves de un JSON de salida o de un archivo que escribe el binario;
  - los códigos y los valores de estado, en snake_case, como `run_not_found` o `cessation_uncertain`;
  - los nombres que se pasan por la CLI, en kebab-case, como los roles `code-review` o `counter-plan`.
- **En español:** los mensajes para el usuario (`message`, `detail`, `next`), los comentarios, la skill
  y la documentación.
- **Con su nombre original:** lo que el binario lee de otra herramienta. Por ejemplo, las
  profundidades `corta`, `normal` y `completa`, los `status` y las claves del header de `sdd-flow`, o
  las secciones `## Verify` y `## Extras (fuera de AC)`.
- **Sin mezclar idiomas dentro de un mismo contrato:** si hace falta un nombre nuevo junto a otros en
  inglés, va en inglés.

Hay valores anteriores a esta regla que están en español, como los estados del ledger de `review`
(`abierto`, `aceptado`) o el nivel de riesgo `no_aplica`. Se conservan hasta que un cambio los toque
por otro motivo.
