<!-- Origen: SKILL.md:1231–1304 y 1314–1356. Traslado de la base a70c7da. -->

Apoyos: [document-phases](../references/document-phases.md); [reception](../references/reception.md); [artifact-review](../references/artifact-review.md); [document-revision](../references/document-revision.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

# plan

Contrato propio de `plan`: un único objeto JSON con `phase: "plan"`; las listas comunes son `assumptions`, `blocking_questions` y `missing_context`, más `findings` conforme al contrato vigente.

  - `plan`: las tres listas y `approach`, `decisions` (admite "ninguno"), `files` y `verification`, que
    va bajo `## Verification`; el header de `plan.md` lo arma el binario con las claves de `sdd-flow`;

Lee [fases documentales](../references/document-phases.md) antes de lanzar, publicar o continuar. Sus precondiciones, ampliación y límites por profundidad rigen aquí.

Antes de plan deben existir rama y HEAD y coincidir la rama actual con el handoff. `branch_missing` o `branch_mismatch` remiten a [rama](branch.md). Las comprobaciones precommit del conductor permanecen en Verification; la entrega futura queda separada.
