<!-- Origen: SKILL.md:1129–1230. Traslado de la base a70c7da. -->

Apoyos: [aprobaciones](../procedures/approvals.md), antes de presentar preguntas canónicas o registrar decisiones; [artifact-review](artifact-review.md); [reception](reception.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

### Devolver un documento a su productor

Para corregir una spec, un plan o unas tasks delegadas, el camino normal es devolver el documento
a su productor con los hallazgos aceptados de su revisión vigente. No borres ni muevas el archivo.
Solo corrige inline cambios de hasta unas diez líneas del documento, sin agregar decisiones ni
criterios. Declara esos cambios en el mensaje que presenta el gate, conservando exactamente la
pregunta canónica. En Codex, la declaración va en un mensaje anterior al que contiene exclusivamente
la pregunta; en Claude Code, acompaña la presentación antes de AskUserQuestion.

```
./bin/sdd-ai sdd phase <flow> --revise spec --review <review-id>
./bin/sdd-ai sdd phase <flow> --revise plan --review <review-id> --decisions <respuestas.md>
./bin/sdd-ai sdd phase <flow> --revise tasks --review <review-id> --deadline 600
./bin/sdd-ai wait <corrida>
./bin/sdd-ai sdd status <flow>
```

La devolución admite `normal` y `completa`, un documento existente y un productor inequívocamente
comprobado. Puede solicitarse desde su gate o una fase posterior, también tras aprobarlo, siempre
antes de empezar implementación: sin writer de implement lanzado, tasks marcadas ni recibo de
verify. Que el siguiente paso diga `implement` no significa que ya empezó. Quedan fuera `corta`,
`implement` y `fix`. `--revise` no se combina con `--request`, `--classes`, `--blocks`, `--families` o `--reopen`;
`--review`, `--decisions` y `--new-session` requieren `--revise`.

Toda devolución nueva exige `--review`, también después de `no_changes`. La revisión debe ser de
ese artefacto y flujo, estar terminada, tener aceptados y ninguna decisión pendiente, y corresponder
al documento y sus fuentes vigentes. Se distinguen revisión ausente, ilegible, activa, de diff,
otro documento o flujo, tipo incompatible, candidato o fuentes cambiados, ausencia de aceptados,
decisiones pendientes y revisor de la misma familia (`same_family_reviewer`). Si corriges una spec,
un plan dependiente necesita una revisión nueva contra esa spec antes de devolverlo.

El productor continúa su sesión y familia, incluidas devoluciones sucesivas. Si falta evidencia del
origen, se rechaza: el flag no permite inventarlo. Si el productor es conocido pero su sesión no es
recuperable, rechaza con `session_unrecoverable` y no lanza nada. `--context` sin una corrección
en espera rechaza con `context_not_expected`; si cambió la revisión o sus decisiones desde el pedido
de contexto, rechaza con `review_changed`. Para abrir otra sesión:

```
./bin/sdd-ai sdd phase <flow> --revise plan --review <review-id> --new-session
```

El binario exige la respuesta del usuario a su pregunta canónica, ligada a ese uso, sus huellas, revisión
y ronda; presenta la pregunta como indica `next` y repite el comando solo después de obtenerla.
El conductor no puede suplirla. La sesión autorizada conserva familia, perfil, aislamiento y material,
y su autorización queda registrada. El flag se rechaza con `session_recoverable` si la sesión sigue
siendo recuperable. Un proveedor ausente sigue siendo un impedimento. `resume_rejected` vuelve
esa sesión no recuperable, incluso si su archivo local existe; nunca abre otra automáticamente.

El encargo incluye el documento completo, fuentes vigentes, fuentes y ampliaciones conservadas,
ledger y decisiones. Solo los aceptados son órdenes; rechazos con motivo, disputas e informativos
son contexto. `--decisions` congela un archivo UTF-8 del repositorio con respuestas del usuario y su
huella: es aporte del conductor, sin autoridad sobre pedido ni insumos aprobados. No autoriza
ampliar alcance, editar otros artefactos ni implementar. Una copia histórica ausente se declara al
reanudar; si es necesaria para una sesión nueva, se rechaza con `material_missing`.

Si el productor devuelve preguntas o faltantes, `awaiting_context` conserva el documento y libera
la reserva. El usuario responde las preguntas de producto; el conductor obtiene los faltantes del repo.
Guárdalos en un archivo y continúa explícitamente, sin sustituir al productor:

```
./bin/sdd-ai sdd phase <flow> --revise plan --context <respuestas-y-contexto.md>
```

La continuación conserva revisión, ronda, decisiones y sesión; un `--review` adicional debe coincidir
o se rechaza con `review_mismatch`. Puede volver a pedir contexto. Si el resume de esa continuación
fue rechazado, repite `--context <archivo> --new-session` con la autorización canónica. Una devolución
nueva admitida del mismo documento reemplaza la espera anterior (`superseded`); una rechazada no
la cambia. Esto no modifica la ampliación única de creación, que sigue usando `--context` sin
`--revise` y conserva `awaiting`, `amended` y `closed_inline`.

Mientras hay una corrección activa, otras correcciones, fases y `sdd approve` se niegan con
`revision_running` y orientan a `wait`; una fase documental activa impide devolver con
`phase_running`. `wait` y la consulta del flujo muestran productor, familia, sesión misma o nueva,
autorización, revisión, ronda, aceptados, material y resultados. Los resultados incluyen `published`,
`no_changes`, `awaiting_context`, `conflict`, `not_admitted`, `not_published`, `resume_rejected`,
`launch_failed`, `failed`, `timeout` y `cancelled`, con causas y listas disponibles. Los fallos previos
a publicar conservan el documento. Un cambio posterior del material congelado produce `conflict`
sin sobrescribirlo. Un supervisor muerto sin terminal se informa como `orphan`: sigue su comando
`cancel`. `registry_pending` indica cierre pendiente, para `published` publicación pendiente de
finalizar; usa `wait`, no canceles una publicación consumada. Una recuperación puede mostrar
`terminal_superseded`, con el terminal anterior y el resultado registrado que prevalece.

La publicación reemplaza todo el cuerpo y conserva literalmente el frontmatter existente. No cambia
otros artefactos, ledger ni headers de aprobación. Después de `published` continúa `review round
<review-id>`: la misma revisión independiente verifica aceptados, responde rechazos y puede señalar
regresiones ligadas a CAMBIOS. Si la ronda devuelve `revision_pending`, consulta `wait <corrida>`
para aclarar la intención de publicación y repite la ronda después de cerrar el registro.
Si `wait` informa `registry_pending`, atiende su causa de lectura o escritura antes de continuar. La ronda declara productor y familia solo para su publicación exacta;
un retoque posterior se declara como autoría mezclada. La devolución no reinicia rondas ni autoriza
`--extra` o disputas. Los gates afectados y posteriores requieren la aprobación humana de las huellas
vigentes; un header heredado que aún diga aprobado se informa como divergencia, sin acreditarlo.

Después de `no_changes`, la ronda dirigida no corre con el documento idéntico y aceptados por
verificar. El conductor elige devolver otra vez con `--review` y un `--decisions` que aclare lo pedido,
cambiar la decisión con `review decide <review-id> reject <F-n> --reason <motivo>`, o corregir inline
dentro del límite indicado y declararlo al gate.

Antes de volver a un binario anterior, termina las correcciones abiertas y reaproba los gates
afectados. Esa versión ignora `revisions`, sus barreras y una intención pendiente de publicación:
puede volver a contar acreditaciones por header como `approved_unfingerprinted` y no detectar
una publicación pendiente de finalizar.

