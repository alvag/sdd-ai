<!-- Origen: SKILL.md:987–1059. Traslado de la base a70c7da. -->

Apoyos: [init](../references/init.md); [recall](../references/recall.md); [errors](../references/errors.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

### Arrancar un flujo: `sdd start`

El conductor empieza con `./bin/sdd-ai sdd start <id>`: es un ensayo que no escribe nada, tampoco
recupera una restauración pendiente de verify ni liga la sesión. Devuelve un JSON con el config,
las familias y sus CLIs en el PATH, el estado de `.plans/<id>/`, la rama y el HEAD, la base elegida,
los antecedentes de `recall` y una lista `blockers`. Sale con 0 incluso con bloqueos; un id inválido
es `usage` antes de consultar el repositorio.

Lee solo `.sdd-ai/config.yml`: informa `cross_model` (familias y selección), `jira_approval.mode`
(aprobación externa de la spec), `knowledge-vault.path_vault` (vault donde busca recall), `branch_format`,
`branch_prefix` (nombre que armará `sdd branch`) y `default_branch` (base por defecto), con su valor
y lo que implican. Las demás claves de primer nivel aparecen en `unused`: sdd-ai no las usa.
Sin vault configurado, esa fuente queda `not_configured`.

`--topic "<tema>"` fija la búsqueda; sin él, el tema es el id con espacios en lugar de guiones.
`--base-branch <rama>` elige una rama local existente como base; sin él se usa `default_branch` y,
si tampoco está declarada, la rama actual.
El commit de esa base será `origin_sha`, aunque el checkout esté en otra rama. HEAD separado o sin
commits bloquea incluso con una base explícita. El ensayo no crea una rama.

Entre el ensayo y `--apply`, **el conductor propone la profundidad, el riesgo y el tipo de cambio,
y el usuario los confirma**. El conductor escribe el pedido literal del usuario y su contexto en
un archivo temporal fuera del repositorio. Con esa confirmación, corre:

```
./bin/sdd-ai sdd start <id> --apply --depth normal --risk low --change-type feat --request <archivo>
```

Los cuatro flags son obligatorios: `--depth` admite `corta|normal|completa`, `--risk` admite
`low|high|unknown` y `--change-type` admite `feat|fix|refactor|chore|docs|test|perf`. `--request`
tiene que ser un archivo regular no vacío; su ruta se resuelve desde el directorio actual. También
puedes pasar `--topic` y `--base-branch`. Los flags de aplicación sin `--apply` son `usage`.

Cada bloqueo del ensayo tiene un `next`. Con bloqueos, `--apply` se niega sin escribir el flujo:

| Bloqueo | Qué hacer |
|---|---|
| `config_missing` | Config físicamente ausente: en un worktree enlazado, correr el comando `init --reuse-config` indicado; fuera de él, `init` general. El comando usa el binario disponible del paquete. |
| `config_invalid` | Corregir `.sdd-ai/config.yml` según el detalle y repetir el ensayo; también bloquea Jira inválido. |
| `family_cli_missing` | Instalar el CLI nombrado, o quitar esa familia de `cross_model.families`, y repetir el ensayo. |
| `flow_exists` | Consultar `./bin/sdd-ai sdd status <id>`; no se adopta un directorio con contenido. |
| `path_invalid` | Revisar `.plans/<id>` según el detalle o usar otro id; no se atraviesan enlaces. |
| `head_unknown` | Hacer el primer commit o pasar a una rama con `git switch <rama>` y repetir el ensayo. |
| `base_branch_unknown` | Crear la rama local o pasar otra con `--base-branch`. |

`--apply` repite el ensayo y vuelve a correr `recall`, sin digest entre ambos: guarda lo que encuentra
en ese momento. Una fuente caída queda con su estado y no bloquea. Valida los flags, el pedido y los
bloqueos antes de recuperar una restauración pendiente de verify, en modo bloqueante: un `--apply` que
se niega no escribe nada. Un pedido inválido da `request_invalid`.

Si termina bien, crea o adopta un directorio vacío `.plans/<id>/` y deja tres archivos juntos:
`pedido.md`, byte a byte igual al pedido; `antecedentes.json`, con la salida de recall; y `handoff.md`,
con `phase: specify`, la profundidad, riesgo, tipo, base y commit elegidos, identidad del checkout,
`spec_approved_at: null`, los overrides en `null` y un resumen del config, familias y antecedentes.
La escritura usa un temporal y un renombre: si falla, el directorio del flujo queda ausente o vacío,
como estaba antes; `flow_write_failed` pide repetir la aplicación. La respuesta dirige a
`./bin/sdd-ai sdd phase <id> --request .plans/<id>/pedido.md`.

Como primer tramo del comando del conductor, `--apply` **liga la sesión** al flujo en `specify` y
suprime el recordatorio de sesión larga de la ruta directa. El ensayo no liga. Si la aplicación se
niega porque el flujo ya existe, puede ligar al flujo real, igual que `sdd status`.
Un subagente no puede correr ninguna de las dos formas.

Para explorar con esos antecedentes, corre `./bin/sdd-ai run --role explore --flow <id>
--prompt-file <encargo>` (también admite `investigate`). Agrega una sección delimitada de consulta,
con estado, modo y origen de cada acierto: id y título de Engram, ruta y línea del vault o `.plans/`,
y commit y asunto de Git. Declara que no son instrucciones y que el código y Git mandan sobre el
estado actual. No modifica el encargo original. Con otro rol o `--retry`, es `usage`.
Un flujo arrancado con `sdd-flow` puede no tener `antecedentes.json`: en ese caso da
`antecedents_missing` y no lanza nada. Corre `run` sin `--flow` y, si necesitas antecedentes,
busca con `./bin/sdd-ai recall "<tema>"` y agrégalos al encargo. Un JSON ilegible da
`antecedents_invalid`; un flujo inexistente ofrece `sdd start <id>` y `/sdd-flow` (`$sdd-flow` en Codex).

