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

Antes de iniciar un flujo, o para revisar algo de los flujos, se consultan los antecedentes del repo
hermano `sdd-ai-dev` (`../sdd-ai-dev`): `handoff.md`, `roadmap/` y sus issues (`gh issue list -R
alvag/sdd-ai-dev`). Es el repo de desarrollo de sdd-ai: el binario y la skill no lo conocen. Sus
documentos pueden estar atrasados, y no se usa como segundo backlog: si contradicen lo que sigue,
se señala el conflicto en lugar de cambiar archivos en silencio.

## Hallazgos y paquetes

- **Hallazgos nuevos:** todos se registran como issues abiertos en `alvag/sdd-ai`, pendientes del
  triage de Hermes. No se crean issues nuevos en `alvag/sdd-ai-dev`.
- **Issues heredados de `alvag/sdd-ai-dev`:** se resuelven allí, sin migrarlos automáticamente a
  `alvag/sdd-ai`.
- **Qué registra el agente:** el problema, lo esperado y lo observado, la reproducción, la evidencia
  relevante, el commit, el runtime y el SO, la sesión o el paquete de origen y las relaciones que
  conozca, sin secretos. No asigna prioridad definitiva ni conductor, y no implementa el hallazgo
  por su cuenta.
- **Qué hace Hermes:** analiza duplicados, relaciones, impacto, alcance y prioridad; clasifica y
  etiqueta verificando las etiquetas existentes; agrupa el hallazgo en un paquete nuevo o en uno
  existente que todavía no fue tomado, y asigna el host (Mac o Windows) y el conductor (Claude o
  Codex).
- **Coordinación:** los paquetes se coordinan en TaskView, proyecto `sdd-ai` (goal 3), no en otro
  documento de backlog en GitHub.
- **Paquetes tomados:** no se amplían en silencio. Un hallazgo nuevo va a un seguimiento aparte o
  pide una decisión explícita de alcance.
- **Gates:** crear un issue o asignar un paquete no autoriza implementar, cerrar ni publicar. Las
  decisiones de producto y los gates humanos de SDD siguen siendo de Max, y una tarjeta asignada
  o completada no los sustituye.

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

## Tests

- `npm test` corre la suite completa. `node --test` corre cada archivo en su propio proceso, en
  paralelo, y los tests de un mismo archivo en serie: la suite tarda lo que tarda su archivo más
  lento.
- Un archivo que corre el binario, `git` u otro proceso tarda segundos por test. Conviene que ninguno
  pase de unos 50 s dentro de la suite completa: si crece más, se parte por tema y lo común va a un
  módulo `<prefijo>-fixture.ts`, que no termina en `.test.ts`.
- `npm run test:unit` corre solo los `*.unit.test.ts`, en segundos. Esos archivos no pueden lanzar
  subprocesos, ni directamente ni a través de `src/`: con `npm test` y con `npm run test:unit`,
  `test/no-subprocess.ts` hace fallar el test que lo intente. Un `node --test` a mano lo aplica solo
  con `--import ./test/no-subprocess.ts`. Un test que necesita un proceso va en un `*.test.ts` común.
