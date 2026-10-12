<!-- Origen: SKILL.md:1231–1356. Traslado de la base a70c7da. -->

Apoyos: [aprobaciones](../procedures/approvals.md), antes de presentar preguntas canónicas o registrar decisiones; [dispatch](dispatch.md); [reception](reception.md); [artifact-review](artifact-review.md); [document-revision](document-revision.md); [findings](findings.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

### Las fases en un worker: `sdd phase`

`sdd phase <id>` lanza la fase que dice `sdd status` (`specify`, `plan`, `tasks` o `implement`) en un
worker por proceso, con el encargo que escribe el binario. Solo en `normal` y `completa`: en `corta` las
fases van inline. El hijo devuelve un contrato fijo, el binario lo valida y escribe el artefacto que
falta; el paso siguiente lo sigue decidiendo `sdd status`, no el hijo.

- **Qué comando corres lo dice `sdd status <id>`** en `next.command`: `sdd phase <id>` (en `specify`,
  con `--request <archivo>`), `wait <corrida>` si hay una corrida de fase activa, o `--context
  <archivo>` si la fase espera ampliación. Sin comando, `next.detail` dice por qué: la fase va inline o
  el árbol tiene cambios que resolver antes de `implement`. La línea del flujo de `SessionStart` dice lo
  mismo.
- **El pedido de `specify`** va en un archivo dentro del repositorio, de texto UTF-8 y no vacío, con
  `--request`, y solo en la primera corrida: la corrida guarda su copia. `--context` sigue las mismas
  reglas. Los bytes de los dos se congelan al lanzar.
- **Se niega antes de crear nada** en un worker o un subagente, en `corta`, en un paso que no es una
  fase (un gate, `verify` o cualquier otro), con una corrida de fase activa del flujo (el `next` trae su
  `wait`), con la fase esperando ampliación sin `--context`, con la fase cerrada inline, con `--context`
  sin ampliación o `--request` fuera de la primera corrida de `specify`. En `plan` se niega si falta la
  rama (`branch_missing`) o la del handoff no coincide con la actual (`branch_mismatch`): ambos
  ofrecen `sdd branch <id>`. También se niega si falta `HEAD` o `change_type`, `profundidad` o `risk`
  en el header de `handoff.md`; en `tasks`, si la
  spec no tiene criterios `- **AC-<n>:**` en `## Criterios de aceptación`; en `implement`, si alguna task
  pendiente no sigue la línea `- [ ] **T<n> — <título>**` de la plantilla. En esos tres casos la fase va
  inline.
- **Los contratos.** Un único objeto JSON con `phase` igual al paso; un `next` se descarta, cualquier
  otra clave de más se rechaza y las listas van aunque estén vacías, que es "ninguno", salvo
  `delivery` en specify, que es opcional:
  Consulta el contrato propio en [specify](../procedures/specify.md), [plan](../procedures/plan.md), [tasks](../procedures/tasks.md) o [implement](../procedures/implement.md).
  En `specify`, `plan` y `tasks` una salida que no se admite tiene una sola corrección; si la segunda
  tampoco, la corrida falla sin artefacto.
- **Entrega posterior al commit:** las obligaciones que solo pueden cumplirse después del commit
  van en `delivery`, fuera de `acceptance_criteria`, filas de Verification y tasks, incluso si se
  mencionan entre las decisiones del plan. Ninguna fila o task exige el commit, la publicación del PR
  o la revisión externa posteriores que esa misma verificación habilita. La clasificación depende del
  momento, sin excepciones por actor: las comprobaciones reales del conductor anteriores al commit
  siguen siendo trabajo precommit. Se conserva la cobertura completa de todos los AC del producto.
  Los contratos anteriores sin delivery siguen admitiéndose como ausencia de entrega; esto no elimina
  obligaciones ya aprobadas, concede gates ni autoriza acciones de entrega. Los controles vigentes de
  status, verify, takeover y commit se conservan.
- **El artefacto.** El binario escribe `spec.md`, `plan.md` o `tasks.md` desde los campos validados, solo
  si no existe y si nada cambió desde el lanzamiento: el paso, la profundidad, los insumos, el header de
  `handoff.md` y, en `plan`, la rama y `HEAD`. La creación inicial no reemplaza un destino existente;
  para corregir un documento delegado usa la [devolución explícita al productor](document-revision.md).
- **Lo que trae `wait`**: el estado, `outcome` (`published`, `awaiting_context`, `closed_inline`,
  `not_published` o `not_admitted`), el `artifact` escrito, los `assumptions` del hijo y, si no se
  escribió, las `blocking_questions` y el `missing_context`, o la `cause`. Entrega también `findings`, `findings_rejected` y `findings_missing` presentes,
  aun sin publicar; consolídalos antes de continuar. No trae el documento ni el
  contrato: quedan en la corrida. Su `next` es el de `sdd status` en ese momento. **Declara los
  `assumptions` en el gate**, como cualquier supuesto tuyo.
- **La ampliación, una por fase.** Si el hijo devolvió preguntas o faltantes, el artefacto no se
  escribe. **Las preguntas bloqueantes las contesta el usuario**: házselas, no las respondas tú. **El
  contexto faltante sale del repositorio**: búscalo tú. Escribe las respuestas y lo encontrado en un
  archivo del repositorio y corre `sdd phase <id> --context <archivo>`: relanza la fase con sus insumos
  y ese archivo. Si esa corrida no llega a publicar ni a cerrar (no arranca, falla o no se admite), la
  fase sigue esperando y puedes volver a lanzarla con `--context`. Si el hijo vuelve a devolver
  faltantes, la fase de creación se cierra y **la sigues inline**. Esta ampliación única de creación
  conserva su significado; es distinta de continuar una corrección con `--revise --context`.
- Para implementación y responsabilidades por actor, lee [implement](../procedures/implement.md).
- **Límites:**
  - las fases van solo por proceso, aunque la familia sea la tuya: la vía nativa no le entrega al
    binario la respuesta del hijo;
  - el binario valida la forma, no el mérito: que un criterio tenga método o una task cite un patrón no
    dice que sirvan, y eso lo juzgan la revisión del artefacto y el gate;
  - el writer no corre pruebas: las comprobaciones las corre `sdd verify`;
  - el hijo Codex sigue leyendo el `AGENTS.md` del repositorio y el del usuario: el encargo le pide
    ignorarlos, sin garantía;
  - con `.plans/` versionado, publicar o marcar tasks ensucia el árbol, y `next.detail` lo dice antes de
    `implement`;
  - el registro de las fases vive en `.plans/<id>/sdd-ai-phases.json`, bajo el mismo lock que `sdd
    approve`: un writer que desobedece sus reglas podría alterarlo.

