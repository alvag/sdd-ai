<!-- Origen: SKILL.md:907–986. Traslado de la base a70c7da. -->

Apoyos: [hooks](../references/hooks.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

- **`sdd approve` exige la respuesta del usuario a la pregunta canónica del gate**, la que trae
  `next.question` cuando `next.step` es `gate`. La pregunta lleva un código atado a las huellas de ese
  gate y de los anteriores: si un artefacto cambia después de la respuesta, hay que volver a
  preguntar. Registra solo si la última respuesta a esa pregunta es `Aprobar`, y cada respuesta sirve
  una vez para una decisión nueva. Los gates son `single` en
  `corta`, `spec` y `plan-tasks` en `normal`, y `spec`, `plan` y `tasks` en `completa`.
- **Los headers se sincronizan después del registro.** `spec` escribe en el handoff existente
  `spec_approved_at` con el ISO completo, exactamente igual al `at` registrado. `plan` avanza el
  plan a `plan-approved`; `single`, `plan-tasks` y `tasks`, a `tasks-ready`. También completa los
  campos atrasados de gates anteriores con aprobación vigente y probada, nunca de posteriores.
  El `status` solo avanza: conserva `implementing`, `verified` y los estados siguientes, sin
  acreditar verificación ni cierre. No crea headers ausentes o vacíos ni repara headers inválidos,
  no cambia los cuerpos y no concede `gate_status` ni un gate externo.
- **Recuperación obligatoria.** Repite `sdd approve <id> <gate>` si su última entrada sigue vigente
  y tiene `proof`: completa los campos pendientes sin pregunta nueva, sin consumir otra respuesta,
  sin duplicar la entrada y sin cambiar su fecha. Si ya coincide todo, no escribe. Si venció o
  falta `proof`, exige una respuesta nueva a la pregunta canónica. Un header y un reintento nunca
  sustituyen la prueba humana. Reaprobar la spec no renueva los gates dependientes vencidos:
  cada uno requiere su propia respuesta, y conserva `header_ahead` hasta su reaprobación.
- **Actividad incompatible.** Antes de escribir, `phase_running` o `writer_open` nombran la corrida
  que debe recibirse con `wait`; `activity_unknown` identifica la ruta y la causa que impiden
  descartar actividad. Restablece su lectura, o recibe o cancela la corrida, y repite el verbo.
  El rechazo anterior al registro no consume la respuesta; si las huellas no cambiaron, sirve al
  reintentar. La recuperación aplica los mismos controles y restricciones de ejecutor.
- **Sincronización pendiente.** Una operación parcial devuelve exit code **3**, `state: sync_pending`,
  `code: approval_sync_pending` y `approval_registered: true`. `pending_headers` enumera `path`,
  `field`, `expected` y `current`; `status` trae el estado releído o `null`. Sigue `recovery_command`,
  que repite el mismo verbo y conserva `--conductor`. No reviertas el registro ni los headers ya
  completados. Una lista vacía puede significar que falta confirmar el resultado: lee `detail`.
  Si las huellas cambiaron antes del reintento, vuelve al gate humano.
- **`sdd-flow` pide el "aprobado" a su manera.** Cuando el usuario aprueba en su gate, hazle además la
  pregunta canónica antes de `sdd approve`: el "aprobado" escrito no es una respuesta a esa pregunta.
- **Cómo se hace la pregunta canónica**, para un gate, una disputa o la ronda extra:
  - **En Claude Code**, con `AskUserQuestion`, pasando el objeto tal cual como su única pregunta, con
    selección simple. No cambies el texto, el header ni las opciones.
  - **En Codex**, con un mensaje cuyo único contenido es la pregunta con sus opciones numeradas, como la
    trae `next` de un rechazo. El contexto va en un mensaje anterior. Después se espera el próximo
    mensaje del usuario: vale la etiqueta de una opción o su número.
- **Cuando el comando rechaza**, el `next` trae la pregunta y cómo hacerla:
  - `runner_required`: el entorno no identifica la sesión de Claude Code ni la de Codex, o el comando
    corre en un worker. La decisión la toma el usuario en la sesión del conductor.
  - `conductor_unknown`: el entorno tiene las dos sesiones, como Codex abierto desde Claude Code. Agrega
    `--conductor claude|codex` con la sesión donde preguntaste.
  - `approval_missing`: no hay respuesta, la última no es una opción, o el archivo de la sesión no se
    pudo leer. Haz la pregunta y vuelve a correr el comando.
  - `approval_contradicted`: la última respuesta no autoriza esa acción, o el `--reason` de un `reject`
    no es el motivo que mostró la disputa. No insistas: la decisión ya está tomada.
  - `approval_reused`: esa respuesta ya registró una decisión. Si el usuario quiere otra, pregúntale de
    nuevo.
  - `review_in_progress`: otro `review decide` o `review round` tiene tomada la revisión. Si no hay
    ninguno corriendo, el `next` dice qué lock borrar.
  - `decision_conflict`: otro comando decidió lo mismo mientras este esperaba. Mira el estado nuevo
    con `status` antes de decidir nada.
- **La prueba frena el atajo del modelo, no la forja.** El transcript, el rollout y los registros son
  archivos que se pueden editar desde el shell. Un subagente no puede correr `sdd approve`: el hook lo
  niega ([hooks](../references/hooks.md)).
- **Un gate `approved_unfingerprinted`** es uno que el header da por aprobado sin una aprobación
  registrada ni prueba del runner: un cambio en sus artefactos no se detecta. Regístralo con `sdd
  approve` solo si el usuario responde que lo que hay ahora es lo que aprobó. Una aprobación
  registrada antes de que existiera la prueba sigue contando, con la nota `approval_unproven`.
- **Ante `header_ahead`, el gate vuelve al usuario** antes de seguir con `sdd-flow`, que por su header
  retomaría más adelante de lo que el registro sostiene.
- **`next` no autoriza avanzar sobre un gate externo pendiente.** La nota `external_gate` dice que el
  handoff espera la aprobación externa de la spec, y ahí `next` es `external_gate` en vez de
  `implement`: seguir sin esa aprobación lo decide el usuario. Con `jira_approval` en `on` ([hooks](../references/hooks.md)), vale
  también cuando el handoff no tiene `gate_status`, y alcanza a `verify` y a `review_and_commit`.
- **La liga.** `sdd start <id> --apply`, `sdd branch <id> --apply`, `sdd status <id>`, `sdd approve <id> <gate>` o `sdd phase <id>`, como primer tramo de
  un comando tuyo, ligan tu sesión a ese flujo, termine como termine el comando. El paso de ese momento queda como
  referencia de `Stop`.
  - Otro id mueve la liga, y el mismo renueva la referencia.
  - Se suelta sola cuando el plan llega a `status: done` o el directorio del flujo ya no está.
  - No ligan un comando en otro tramo (después de un `cd` o de un `&&`), un subagente, un `status` sin
    id, un id inválido ni un flujo sin artefactos.
  - La liga es de tu sesión: otra sesión del mismo repositorio no la ve.
  - Si no se pudo guardar, el hook te lo dice; vuelve a correr el comando.

  **Corre `sdd status <id>` al empezar o retomar un flujo**, y también al seguir en una sesión que se
  abrió antes de actualizar los hooks. Sin liga, `Stop` no recuerda su paso, la guarda del commit no
  lo ve y el recordatorio de sesión larga no se calla ([hooks](../references/hooks.md)).

