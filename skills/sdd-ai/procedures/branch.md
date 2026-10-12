<!-- Origen: SKILL.md:1060–1128. Traslado de la base a70c7da. -->

Apoyos: [errors](../references/errors.md); [reception](../references/reception.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

### Crear la rama: `sdd branch`

El conductor corre `./bin/sdd-ai sdd branch <id>` justo después de aprobar la spec en normal y
completa. En corta, lo corre justo después de `sdd start`, antes de `specify`: después ya existe
`plan.md` y el verbo se niega con `plan_exists`. El ensayo no escribe archivos ni refs y sale con 0,
incluso con bloqueos. Informa el nombre y sus partes, HEAD, la base congelada y su punta local,
las salidas con sus bloqueos, `recommended`, `ask` y `next`. Se pregunta al usuario solo si `ask`
no está vacía: `exit` pide elegir la salida y `base_advanced` avisa que la base avanzó. Sin motivos,
se aplica la recomendación; los gates siguen siendo humanos y `sdd approve` registra y sincroniza
los headers existentes conforme a [aprobaciones](approvals.md).

- **`new`**, con `--apply`, crea una rama desde `origin_sha` y cambia a ella. El nombre sale de
  `branch_format` (por defecto `{type}/{ticket}-{slug}`), `--prefix` o `branch_prefix`, y si faltan,
  `change_type` (`feat` da `feature`). `{ticket}` es el id con forma de clave, y `{slug}` es el slug
  normalizado. Se omiten las partes ausentes con su separador. `--prefix <p>` también sirve en el ensayo.
- **`current`**, con `--apply --current`, registra la rama actual con `base_commit` igual a HEAD,
  sin mover HEAD ni crear refs. No puede ser la base. No admite `--prefix` ni `--refreeze`.
- **`--refreeze`**, solo con `--apply`, corta desde la punta local de `base_branch` y actualiza
  `origin_sha`; sin él, conserva la base congelada aunque haya avanzado. No hay fetch, pull ni push.

El ensayo recomienda `current` si el nombre construido ya es el actual, y `new` desde la base.
Desde otra rama, recomienda `new` si su nombre contiene el id, y `current` si no, con `ask: ['exit']`.
Si la recomendación tiene bloqueos y la otra salida no, ofrece la otra y pide elegir; si ninguna
sirve, no propone un `--apply`. La aplicación repite todas las comprobaciones bajo el lock del flujo.

Cada bloqueo trae un `next`; la aplicación se niega con el código del primero y todos en `detail`:

| Código | Qué hacer |
|---|---|
| `flow_blocked` | Resolver los motivos que muestra `sdd status <id>`. |
| `handoff_invalid` | Corregir el header y `change_type`; al retomar, completar a mano `base_commit` si falta o no es un commit. |
| `config_invalid` | Corregir el YAML y los valores de texto de `.sdd-ai/config.yml`; usar solo los placeholders conocidos. |
| `spec_not_approved` | Consultar `sdd status` y aprobar la spec vigente; en corta no se exige este gate. |
| `plan_exists` | Seguir el flujo con `sdd status`; la rama se elige antes de escribir el plan. |
| `head_unknown` | Pasar a una rama con commits. |
| `tree_dirty` | Commitear o guardar las rutas indicadas, fuera de `.plans/`, `.specify/`, `.sdd-ai/` y `.cross-model/`. Un renombre cuenta también por su origen. |
| `phase_running` | Recibir la corrida con `wait`. |
| `writer_open` | Seguir el `next`, que depende de quién tiene la reserva: recibir el writer con `wait`, o esperar a que terminen `sdd verify` o `sdd commit`. Solo una reserva de `sdd branch` cuyo proceso ya no corre se borra a mano, con el lock que nombra el `next`. |
| `refs_busy` | Esperar al dueño de la reserva de refs; si murió, seguir el `next` para retirar su reserva huérfana. |
| `flow_busy` | Esperar al comando dueño; borrar el lock indicado solo si ya no hay otro comando corriendo. |
| `base_branch_unknown` | Completar `base_branch` o corregir `origin_sha`; crear la base local si se necesita su punta. |
| `branch_name_invalid` | Corregir el formato, el prefijo o el slug para que Git acepte el nombre. |
| `branch_is_base` | Elegir otra rama o un prefijo distinto; no registrar la base con `--current`. |
| `branch_exists` | Elegir otro prefijo o registrar la actual con `--current`; nunca se agrega un sufijo automático. También sale cuando otra rama impide crearla por la jerarquía de refs, como `feature` frente a `feature/<id>`. |
| `branch_recorded` | Quitar los flags que contradicen la rama registrada y repetir `--apply`. |
| `branch_create_failed` | Corregir la causa de Git y repetir el mismo `--apply`; la intención ya está en el handoff. Si no se puede corregir, elegir otra rama con `--prefix` o `--current`. |
| `branch_switch_failed` | Git no pudo volver a la rama registrada: corregir la causa con el detalle y repetir el mismo `--apply`. |

Primero se escribe atómicamente el handoff y después se crea la rama. El header queda con `branch`,
`worktree_branch`, `branch_prefix`, `base_commit`, `spec_approved_at` de la última aprobación registrada
(o el valor acreditado por el header; en corta, `null`) y `phase: plan`. Solo cambia `origin_sha` si
faltaba o se pidió `--refreeze`. El resto del header, sus comentarios y el cuerpo se conservan,
salvo la sección `## Rama`, que lleva la salida, la base y los commits; al repetir se reemplaza.

Si el handoff ya nombra la rama, el ensayo informa `recorded` y `retake`: `none` cuando está al día,
`handoff` si solo falta actualizarlo, `create` si falta la ref y `switch` para volver a la rama existente.
La retoma usa el `base_commit` registrado, nunca lo reconstruye. Repetir `--apply` no escribe nada si
ya está al día; acepta `--current` cuando HEAD ya está en ella, un `--prefix` que dé el mismo nombre
y `--refreeze` (sin recongelar de nuevo). Si la rama registrada todavía no existe, es solo una
intención: `--prefix` o `--current` la reemplazan por otra elección. La respuesta dice `created`,
`switched` y `handoff_written`.

Crear una rama o cambiar a una existente toma reservas de checkout y de refs, y las libera al
terminar. La del checkout puede negar con `writer_open`; la de refs, compartida entre worktrees,
con `refs_busy`. `--current` y completar solamente el handoff no toman esas reservas. Un writer
abierto del propio flujo sí bloquea las dos salidas. Una reserva puede quedar huérfana si el proceso
muere antes de liberarla.
Después de aplicar, `next` es el de `sdd status`. El ensayo no liga la sesión; `--apply` sí la liga.

