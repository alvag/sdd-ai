<!-- Origen: SKILL.md:1505–1615. Traslado de la base a70c7da. -->

Apoyos: [errors](errors.md); [mod](mod.md); [writer](writer.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## 11. Preparar el checkout: `init`

### Copia directa en un worktree: `init --reuse-config`

Si falta `.sdd-ai/config.yml` en un worktree enlazado, ejecuta:

```sh
./bin/sdd-ai init --reuse-config
# Desde un worktree sin node_modules, usa el binario de otro checkout:
node '<ruta-del-checkout>/bin/sdd-ai' init --reuse-config
```

La invocación explícita ejecuta la copia sin ensayo previo, digest ni confirmación interactiva propia.
No admite `--apply`, `--digest`, `--families`, `--jira`, `--from`, `--telemetry` ni argumentos posicionales.
Git identifica el checkout principal aunque esté fuera del árbol padre del worktree. Fuera de un
worktree enlazado se rechaza la operación; preparar configuración nueva es una elección separada.

Solo copia `.sdd-ai/.gitignore`, `.sdd-ai/workers.yml` y `.sdd-ai/config.yml`, literalmente, sin
normalizar YAML, fusionar perfiles ni consultar catálogos. La fuente debe tener los tres archivos
regulares, legibles y configuración y workers válidos. Se rechazan enlaces válidos o rotos,
entradas no regulares, directorios `.sdd-ai` simbólicos y errores de acceso antes de comenzar.
Los archivos locales regulares se conservan con sus bytes y fechas; workers locales inválidos
bloquean la copia. Si config local ya existe, se valida y no se completa ningún otro archivo:
un config vacío, inválido o sin cross_model necesita corrección explícita, no reutilización.

El resultado trae `state`, `root`, `source` (null si no se consultó), `copied`, `preserved`, `pending`
y `errors` con `code`, `path` y `message`. Los nombres en las listas son relativos a `.sdd-ai`.
Código 0 corresponde a `copied` o `unchanged`; código 2 a `blocked` o `partial`.
La copia usa creación exclusiva, incluso si un destino aparece concurrentemente, y escribe en orden
`.gitignore`, `workers.yml`, `config.yml`. Un fallo detiene los archivos posteriores: `copied`
contiene solo copias completadas, `pending` solo archivos confirmados ausentes y el error de copia
incluye `entry_exists` (null cuando no se pudo inspeccionar). No hay rollback del conjunto.
Repite el mismo comando para completar solo lo ausente; una entrada incompleta que exista se
conserva y exige corrección explícita. Repetir una copia completa válida no escribe.

No copia runs, projection, hooks, locks, tmp ni otro estado; tampoco recupera restauraciones,
adopta o cancela corridas, publica proyección, sincroniza agentes, instala dependencias ni cambia
preferencias. Copiar no inicia ni aprueba un flujo. Después, repite `sdd start`: los bloqueos
independientes, como CLI ausente o flujo con contenido, siguen vigentes. Un archivo existente
inválido se presenta como `config_invalid`, aunque el loader interno use `config_missing`.

Las rutas se resuelven con Git y utilidades nativas. La revisión de rutas Windows no acredita una
ejecución allí: Windows queda pendiente hasta una prueba real. La prueba de Orca en macOS también
requiere evidencia del conductor; los fixtures de Git no demuestran pertenencia a Orca.

### Preparación general

`init` deja listo un checkout de sdd-ai:
- escribe `.sdd-ai/config.yml` y `.sdd-ai/workers.yml`;
- asegura `.sdd-ai/.gitignore`;
- corre `agents sync`;
- trae el reporte de `doctor`.

Úsalo en un checkout nuevo, en un worktree nuevo o cuando los perfiles de los workers quedaron viejos.
Funciona solo en un checkout de sdd-ai: en otro repositorio sale con `runtime_missing`, porque usar
sdd-ai ahí es la instalación global.

1. **Ensaya.** `./bin/sdd-ai init` no escribe nada. Devuelve:
   - la config vigente (`current`) y las CLIs detectadas;
   - las preguntas del asistente (`questions`);
   - cada archivo con lo que le haría (`files`: `create`, `update` con sus `changes`, `unchanged` o
     `invalid` con su error);
   - lo que cambia en los perfiles (`workers`);
   - la preferencia compartida del usuario (`user_config`), separada de los archivos del checkout;
   - las copias que sincronizaría (`agents`);
   - los avisos (`notes`) y un `digest`.
2. **Pregunta.** Cada pregunta de `questions` trae su opción vigente primero:
   - En Claude Code, con `AskUserQuestion`, pasando `header`, `question` y las opciones con `label`
     y `description`. `value` no se muestra.
   - En Codex, con las opciones numeradas.

   Si una respuesta no es la primera opción, vuelve a ensayar con el `flag` de esa pregunta y el
   `value` elegido, por ejemplo `--families claude` o `--jira on`.
3. **Muestra el ensayo.** Enséñale al usuario `files`, `user_config`, `workers` y `notes`. Los perfiles no se
   preguntan:
   - un `workers.yml` nuevo lleva los defaults de cada rol;
   - uno existente conserva sus perfiles, suma los que faltan y pierde los inexistentes, que son los
     roles retirados o desconocidos y los modelos de Codex que no están en su catálogo local. El
     catálogo lo reescribe cualquier cliente de Codex de la máquina: si lo bajó una versión más vieja que
     el `codex` instalado, `init` no valida los modelos y lo avisa con `codex_catalog_outdated`. Si no se
     puede leer alguna de las dos versiones, valida igual;
   - `codex_model_older_generation` avisa de cada perfil de Codex cuyo modelo el catálogo describe como
     de una generación anterior, con el default del rol. No lo cambia: se edita a mano en `workers.yml`.
     El aviso solo sale con un catálogo válido;
   - `differs` lista, como dato, los perfiles propios que difieren del default.
4. **Aplica** solo si el usuario confirma, con el comando que trae `next`:
   `init --apply --digest <digest>` con los mismos flags. Escribe exactamente lo que mostró el
   ensayo. Si sale `digest_mismatch`, algo cambió desde entonces: vuelve a ensayar y muéstrale el
   plan nuevo.
5. **Cierra** con lo que diga `closing` y el reporte de `doctor`. Si se sincronizaron agentes, hay que
   reabrir la sesión.

En un worktree nuevo, `init` propone copiar la config y los perfiles del checkout principal (`seed`),
y `--from <ruta>` elige otro checkout. Como el worktree no tiene `node_modules`, corre desde él
`node <principal>/bin/sdd-ai init`, o `npm ci` y después `./bin/sdd-ai init`.

`init` no escribe hooks ni archivos de ignore y no corre `npm ci`: lo que falte lo avisa en `notes`.

La preferencia de usuario es `telemetry: on|off` en `~/.sdd-ai/config.yml`. Solo si falta la clave
y no hay flag se pregunta, con off primero y por defecto; una clave existente evita repetir la
pregunta entre checkouts. `init --telemetry on|off` permite cambiarla, incluso en un checkout ya
inicializado. El override de entorno no sustituye ni cambia la preferencia persistida. El ensayo
no escribe: `user_config` muestra path, current, proposed, action y content cuando cambia. Su digest
incluye los bytes y la ruta del archivo de usuario; si cambian, se exige un ensayo nuevo. Se
conservan otras claves, comentarios, permisos y los enlaces a la configuración. YAML o clave
inválidos, o un archivo ilegible, niegan init con `user_config_invalid` y nombran el archivo.
Si no se puede escribir esa preferencia, se aplica el checkout y agents sync igualmente:
`user_config.written` es false y `telemetry_preference_unwritten` indica repetir el ensayo con
`init --telemetry <elección>` desde una terminal con acceso y aprobar su digest. Si la clave
faltaba, volverá a preguntar; si ya existía, mantiene su valor y el cambio requiere otra vez el flag.


El ensayo y su digest contemplan todos los archivos de la skill modular. Sincronizar instala bootstrap, procedimientos y apoyos en ambas familias. No sincronices durante la reserva de un writer: espera cese comprobado y cosecha; conserva artefactos, headers, aprobaciones y registros de corridas.
