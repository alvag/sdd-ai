<!-- Origen: SKILL.md:1231–1304 y 1314–1356. Traslado de la base a70c7da. -->

Apoyos: [document-phases](../references/document-phases.md); [reception](../references/reception.md); [artifact-review](../references/artifact-review.md); [document-revision](../references/document-revision.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

# specify

Contrato propio de `specify`: un único objeto JSON con `phase: "specify"`; las listas comunes son `assumptions`, `blocking_questions` y `missing_context`, más `findings` conforme al contrato vigente.

  - `specify`: `known_facts` (hecho y puntero al código), `assumptions`, `blocking_questions`,
    `missing_context`, `acceptance_criteria` (id `AC-<n>`, texto, autoridad y método de verificación) y
    la prosa de `problem`, `background` y `scope`, y `delivery` opcional (lista de textos no vacíos).
    Ausencia y `[]` significan ninguna obligación de entrega. Se representa como viñetas de texto en
    `## Entrega posterior al commit`, después de los AC, sin checkboxes ni certificaciones añadidas.
    Se rechaza cualquier línea de delivery que empiece, tras espacios o tabulaciones y un marcador
    de lista opcional (`-`, `*`, `+` o `<n>.`), con `[ ]`, `[x]` o `[X]`; también headings reservados
    de spec o estado (incluido el título de entrega) y cercas sin cerrar. La causa identifica el
    elemento inválido; otros símbolos y menciones de checkbox dentro de una frase se admiten;

Lee [fases documentales](../references/document-phases.md) antes de lanzar, publicar o continuar. Sus precondiciones, ampliación y límites por profundidad rigen aquí.

El request inicial debe ser texto UTF-8 no vacío dentro del repositorio; solo la primera corrida recibe `--request`. La entrega posterior al commit queda fuera de AC, Verification y tasks.
