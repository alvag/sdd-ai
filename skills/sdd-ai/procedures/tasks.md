<!-- Origen: SKILL.md:1231–1304 y 1314–1356. Traslado de la base a70c7da. -->

Apoyos: [document-phases](../references/document-phases.md); [reception](../references/reception.md); [artifact-review](../references/artifact-review.md); [document-revision](../references/document-revision.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

# tasks

Contrato propio de `tasks`: un único objeto JSON con `phase: "tasks"`; las listas comunes son `assumptions`, `blocking_questions` y `missing_context`, más `findings` conforme al contrato vigente.

  - `tasks`: las tres listas y cada task con id `T<n>`, título, `actor` obligatorio (`writer`,
    `conductor` o `user`), los criterios que cubre, el patrón del repositorio, la prueba que la
    discrimina, sus archivos y sus pasos; cada criterio de la spec lo cubre alguna task;

Lee [fases documentales](../references/document-phases.md) antes de lanzar, publicar o continuar. Sus precondiciones, ampliación y límites por profundidad rigen aquí.

Cada task es atómica, tiene un actor único y cobertura AC; los productos preceden a consumidores. Incluye todas las acciones precommit de writer, conductor y user. Verify final, sus acreditaciones, gates y entrega futura no son tasks; verify final exige todas las tasks completadas.
