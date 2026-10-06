# sdd-ai-mod

Presentación de `sdd-ai` en la terminal de Claude Code. El mod observa llamadas
Bash y dibuja resúmenes de sus salidas, y muestra sobre el prompt una banda de
una línea con el flujo ligado a la sesión, su paso y la actividad en curso, que
lee de la proyección que publica el binario (`docs/projection.md`). El binario
conserva sus resultados, códigos de salida, guardas y decisiones. El mod no
ejecuta los pasos sugeridos ni registra herramientas. `/sdd-panel` y `/sdd-runs`
consultan la misma proyección sin pedir una respuesta al modelo. El avisador solicita recepción
mediante `$.prompt.submit`, persiste sus intentos en `$.store` y escribe únicamente
la señal de vida de su propia sesión; no modifica las corridas ni sus recibos.

## Compatibilidad y estado de comprobación

Los mods requieren Claude Code **2.1.287 o posterior**. La sonda se validó con
**2.1.288**, y esta implementación se comprobó con **2.1.289**, la versión
instalada al implementarla. Lo observado con esas versiones no se extiende a
otras.

El panel, los comandos, la banda y los resúmenes guardados se comprobaron en vivo
con **2.1.291** en macOS, siguiendo [`docs/panel-live-check.md`](../../docs/panel-live-check.md):
panel y lista, su alternancia, Escape, conservación del borrador, refresco, salida
guardada aparte, banda a 78 columnas, writer real en curso, cese incierto
(preparado), convivencia con una pregunta, adopción y rollback. El resultado
individual de una salida guardada con el original nativo debajo no se vio en vivo:
lo cubre el test del motor. La sonda del formato guardado se observó en una sesión
iniciada con 2.1.290.

La sonda del aviso se realizó con Claude Code **2.1.289** en macOS y comprobó
conservación del borrador y ausencia de interrupción. Esa sonda no acredita la
integración completa, la prioridad entre sesiones ni la pintura de la banda.
Las comprobaciones reales pendientes siguen el procedimiento de
[`docs/notification-live-check.md`](../../docs/notification-live-check.md).

## Instalación y actualización

Desde la raíz del checkout, ejecuta:

```sh
./bin/sdd-ai agents sync
```

También puedes preparar el checkout mediante el ensayo de `./bin/sdd-ai init`
y aplicar el plan aprobado con su digest. La fuente está en `mods/sdd-ai/`; la
copia generada está en `.claude/skills/sdd-ai-mod/` y se distribuye incluso
cuando la familia seleccionada es Codex. La copia contiene el manifiesto,
`hooks/` y `types/`, sin los tests.

Una **sesión nueva de Claude Code** en el checkout preparado y de confianza
carga el mod al arrancar. En una sesión ya abierta, `/reload-plugins` lo carga,
también si la sesión arrancó antes de que existiera la copia. Con **2.1.290**,
cambiar la copia no basta para adoptarla o descargarla: instalación,
actualización, desactivación y rollback en una sesión abierta requieren
`/reload-plugins` o una sesión nueva. Con **2.1.291**, **modificar** una copia ya
cargada (por ejemplo, con `agents sync` después de actualizar la fuente) se
recarga sola en la sesión abierta («hooks.json changed — reloaded»), pero
**agregarla o quitarla** sigue necesitando `/reload-plugins` o una sesión nueva.
La adopción automática y la ausencia de duplicación observadas con **2.1.289**
quedan limitadas a esa versión. No se
garantiza adopción automática en versiones no comprobadas. No hace falta
cancelar, relanzar ni modificar una corrida viva para cambiar su presentación.

Para desactivar el mod, retira su copia generada y recarga los plugins o abre
otra sesión. Una sincronización posterior vuelve a instalarla. Para rollback,
restaura la fuente de la versión elegida, sincroniza y adopta la copia según
la versión de Claude Code. Ninguna operación entrega resultados ni cambia gates.

Cada checkout o worktree tiene su propia copia. Si `.claude` o `.claude/skills`
es un enlace que sale del checkout (por ejemplo, a otro worktree), `agents sync`
e `init` se niegan con `mod_copy_outside` antes de escribir nada: la copia del
mod no se escribe ni se limpia fuera del checkout. Un enlace que queda dentro
del checkout sirve. Un checkout existente con la
copia ausente o desactualizada verá `doctor` sin `ok` hasta ejecutar
`agents sync` o aplicar `init`. Ambos comparan los archivos administrados byte
a byte. Los tipos generados por el motor y el `tsconfig.json` de la raíz de la
copia se conservan y no afectan su vigencia.

`package.json` no declara `files`: sdd-ai se usa desde su checkout. Este mod
no se distribuye como un plugin instalable independiente.

## Esperar con aviso y recibir el resultado

Con el mod operativo puedes terminar el turno sin `wait` pendiente. El refresco,
cada **1 s**, considera también resultados terminados antes de instalar o recargar:
para workers y writers solicita `./bin/sdd-ai wait <id>`; para revisiones,
`./bin/sdd-ai review status <id>`, identificando ronda y lanzamiento. Fallo,
cancelación y timeout también pueden avisarse. Progreso, nativas pendientes,
hallazgos de una revisión ya recibida y `cessation_uncertain` no generan avisos
terminales. El plegado afecta a la presentación; PromptHint sostiene la adopción
y observación aun sin banda visible.

El envío espera mientras Claude trabaja, responde una pregunta o tiene texto
escrito en el prompt. Usa únicamente `{ text }`, con origen de plugin. Una
solicitud aceptada significa que el aviso ingresó: **no significa resultado
recibido**. La recepción se registra al obtener la respuesta terminal mediante
el binario. Los hallazgos de revisión y sus gates siguen pendientes de decisión.

La dueña con señal operativa tiene prioridad aunque esté ocupada. Si no está
operativa, una nueva sesión de Claude en el mismo checkout puede retomar con
`./bin/sdd-ai sdd status <flow>`. Debe tener mod con señal vigente y ser la única
candidata operativa ligada al flujo. Para recuperar manualmente un aviso
indeterminado o agotado, si no hay candidatas operativas, basta ser la única
ligada con señal vigente, aun degradada. Sin asociación inequívoca, con varias
candidatas o con lecturas desconocidas, se conserva el pendiente: consulta desde
la dueña o resuelve la indisponibilidad/ambigüedad y vuelve a retomar. Nunca se
elige arbitrariamente una sesión de otro flujo, checkout o worktree.

Si una destinataria aceptó el aviso y desapareció sin recibir, el relevo tiene
su propia clave y puede avisarse. Se admite un aviso por sesión durante una
transición; dentro de la misma sesión, una terminación aceptada no se repite
por redibujos o recargas. Nuevas rondas o lanzamientos vuelven a ser elegibles.

Sin mod operativo, o desde Codex, usa espera activa o consulta manual con esos
comandos. `Stop` recuerda al cerrar un turno y conserva sus límites de repetición;
no despierta espontáneamente una sesión inactiva.

## Señal, fallos y rollback del aviso

La señal propia está en `.sdd-ai/hooks/notifications/claude-<session>.json`.
Contiene versión 1, checkout físico e id, familia, sesión, instancia,
`operational` y `updated_at`. Tanto `updated_at` como el mtime deben tener menos
de **5 s**, sin fechas futuras. Enlaces, rutas ajenas, archivos irregulares y
contenido inválido no acreditan operatividad. Una señal vigente degradada permite
la recuperación manual legítima, pero no da prioridad ni calla a Stop.

La operatividad requiere observación actual, completa y compatible, identidad y
persistencia válidas y cobertura de los pendientes de esa sesión. Un pendiente
sin identidad de entrega, `indeterminate` o `exhausted` mantiene la señal
degradada hasta su recepción o recuperación de los hechos. Una colección parcial
puede avisar una corrida propia suficientemente conocida; no sostiene el silencio
de Stop ni demuestra la unicidad del relevo. La última lectura visual retenida
no genera nuevos avisos ni renueva operatividad.

Los rechazos confirmados (`drop`) admiten **3 solicitudes**, incluida la inicial,
con esperas de **30 s** y **60 s** y un nuevo ciclo válido antes de reintentar.
Mientras queda reintento, la señal puede seguir operativa. Agotado el límite,
recibe manualmente. Una respuesta indeterminada no se reenvía automáticamente:
consulta `wait` o `review status`. El plazo de **10 s** solo cuenta tiempo ocioso;
una respuesta tardía cierra el intento sin habilitar otro envío. Un prepared
heredado no inició solicitud; un submitting heredado se conserva como indeterminado.

Store dispone de **4 MiB**; una cuota agotada, registro corrupto o fallo de lectura
o escritura requiere recepción manual. Los registros de aviso no son recibos del
dominio. La señal no cambia ligas, contadores, hallazgos ni aprobaciones.

Para rollback, desactiva o sustituye el mod y sincroniza la copia con los mecanismos
existentes. La señal anterior deja de justificar el silencio de Stop en como máximo
5 s desde la última renovación. No hace falta cancelar corridas, cambiar dueña o
flujo ni borrar recibos. Si reviertes también el productor, conserva la limpieza
de `.sdd-ai/projection/` documentada en `docs/projection.md`. Los registros de aviso
nunca se convierten en entregas durante el rollback.

## Resúmenes y acceso al original

Una ejecución reconocida de `./bin/sdd-ai` o `bin/sdd-ai` con un objeto JSON
completo muestra los campos disponibles, incluidos `state`, `code` y `next`.
El estado de Bash y su código de salida se distinguen del estado publicado
por el binario. Los mensajes, detalles y pasos siguientes conservan su texto
completo. Si hay otros campos, el resumen enumera sus nombres.

El ledger conserva el orden y muestra el prefijo de entradas completas que cabe.
Si se recorta, dice «faltan N entradas; el original las contiene». Desde 80 columnas de terminal
se presenta como tabla; por debajo, sin ancho medido o sin espacio suficiente
para la afirmación, utiliza bloques. Dentro de una entrada solo la afirmación puede recortarse con
una elipsis visible. Un ledger vacío indica que no contiene hallazgos; un
ledger ausente no hace esa afirmación.

En un grupo compacto, las llamadas ajenas conservan su posición y muestran
una línea de identificación, sin volcar su salida. Al expandir el grupo, las
llamadas mantienen su presentación nativa y sus resultados originales.
`ctrl+o` permite acceder al texto completo. En pantalla completa, sus filas
individuales usan `ToolResult`: una llamada atribuida muestra el resumen y,
debajo, el original completo, incluidos stderr separado y prefijos de error.

La atribución de un `ToolResult` requiere que esta carga del mod haya observado
su llamada Bash. Un resultado histórico anterior a una reanudación o recarga,
sin atribución disponible, conserva la presentación nativa aunque contenga
JSON parecido. Un grupo puede reconocer esa llamada directamente desde su
`input`.

Las tuberías, varias invocaciones, construcciones ambiguas, salidas mezcladas,
ledger inválido o errores de la herramienta sin JSON conservan la vista
nativa. Una interrupción tampoco se presenta como un resultado terminado.
El resultado original que recibe Claude permanece intacto.

Claude Code rechaza un dibujo con un texto de más de 10 000 caracteres, con
más de 100 000 en total o con caracteres de control distintos del tabulador y
el salto de línea. El mod fragmenta cada Text a 8 000 caracteres y reserva
90 000 para el texto propio. En línea descuenta el coste del original; en grupos
reserva identificaciones y campos, y reparte el resto entre los ledgers,
redistribuyendo lo no usado. Si ni todos los campos de un grupo caben, conserva
resúmenes en orden con el ledger reducido a conteo; las llamadas restantes
conservan identificación y un aviso cuenta los resúmenes faltantes. Si tampoco
caben las identificaciones, cuenta las llamadas faltantes. Los caracteres de
control, incluidos colores en stderr, siguen dejando la presentación nativa.
El resultado individual de una salida guardada aparte usa **60 000**: el motor
cuenta contra el límite de 100 000 el original nativo que dibuja el nodo
`engine` debajo del resumen, así que se le reservan 30 000. Lo midió el test del
motor; en vivo, con 2.1.291, un resumen de 43 KB se dibujó sin caer a la vista
nativa. Una celda de ancho fijo de la tabla del ledger cuenta su ancho completo,
porque el motor cuenta el texto rellenado. Si los campos de un resumen
individual, sin el ledger, superan solos el presupuesto, se muestran los que
entran y una línea cuenta los que faltan; el original nativo de debajo los
conserva todos.

Claude Code guarda aparte salidas grandes de Bash y a la llamada le deja solo
un recorte (observado desde unos 30 KB con 2.1.289). La sonda en la sesión
iniciada con 2.1.290 guardó stdout seguido de stderr con salida 0; la salida 3
quedó en línea y recortada. No se deduce de eso otro formato para errores.
Un recorte no es el
resultado completo y no se utiliza como entrada del resumen. Solo las llamadas
reconocidas y atribuidas por esta carga habilitan un intento de lectura al
terminar. La raíz es `<CLAUDE_CONFIG_DIR>/projects` o, sin esa variable,
`<HOME>/.claude/projects`. La ruta absoluta debe terminar en
`/projects/<proyecto>/<sesión>/tool-results/<archivo>`, sin segmentos `..`.
Antes de leer se resuelven físicamente raíz y archivo: el archivo regular debe
quedar bajo la raíz real con esos cuatro segmentos y no superar **1 MiB**.
Una raíz alcanzada por enlace es válida; un archivo que escapa no lo es. El
prefijo léxico anterior a `projects` puede tener otra ortografía, pero no evita
la comprobación física. Persiste la carrera entre stat y read declarada en #110.

El mod lee únicamente la ruta exacta, una vez por llamada, y conserva el resumen
durante esta carga. No lista proyectos ni busca alternativas. También comprueba
el tamaño recibido. Un archivo ilegible, denegado, desaparecido, corrupto o con
stderr pegado que impida admitir el JSON mantiene «sin resumen» y su tamaño en
el grupo, y el resultado individual nativo. Durante la lectura ocurre lo mismo.
Las llamadas históricas, ambiguas, ajenas, interrumpidas o todavía en background
no habilitan lectura. Recargar descarta la caché anterior; después de rollback
su clave queda sin uso hasta terminar la sesión.

El resumen individual conserva debajo el dibujo original de Claude Code,
incluido el recorte y la referencia al archivo. El archivo leído no sustituye
ese dibujo ni la respuesta de Bash. El contenido del resumen coincide con el
equivalente en línea antes de aplicar los presupuestos de cada sitio. El binario
y el modelo siguen recibiendo lo mismo que sin el mod.

## Panel y lista inmediata

`/sdd-panel` muestra el flujo ligado, su paso observado, gates, resumen de tasks,
bloqueos y corridas propias abiertas. `/sdd-runs` se concentra en ese mismo
inventario: id, clase, ejecución, motivo de apertura, asociación y writer
protegido, sin duplicarlo. No muestran historial cerrado ni atribuyen corridas
por coincidir en el flujo. Cuentan las omitidas por falta de atribución y las que
no entran en el dibujo. Distinguen ausencia conocida, datos parciales,
indisponibilidad y última lectura retenida; la antigüedad no acredita cierre.

Los estados de gate se muestran literalmente: `pending`, `approved`,
`approved_unfingerprinted` y `stale`. Los dos últimos no acreditan aprobación
vigente con huella. Ambos comandos alternan según el registro del motor:
cierran el pane mostrado o abren/muestran el solicitado. El botón Cerrar y
Escape usan el cierre del motor. No se solicita foco ni se modifica el borrador.
Si el motor responde `isPlaced: false`, el pane queda registrado esperando lugar.

El refresco compartido consulta cada segundo, sin un turno nuevo; conserva los
límites y excepciones del lector de proyección. Estas vistas no entregan
resultados, aprueban gates, marcan tasks, deciden hallazgos, ligan sesiones,
cancelan corridas ni ejecutan pasos sugeridos. Cualquier aviso independiente
conserva su propio funcionamiento.

## La banda sobre el prompt

En la terminal, el mod dibuja una línea sobre el prompt con:

- el flujo ligado a la sesión y su paso;
- una actividad de la propia sesión: primero las del flujo ligado (el writer en
  vuelo, la revisión en ejecución, otro worker y los pendientes, en ese orden) y,
  si no hay, otra propia con su flujo real. Una revisión muestra su ronda, el
  revisor y el lote, y su progreso por ronda («base 3/5»); un writer se reconoce
  como tal, y uno en `cessation_uncertain` se marca como de cese incierto;
- la antigüedad de la observación, solo si hay una corrida viva y nadie publicó
  en los últimos 60 segundos.

Sin flujo ligado ni actividad propia, la banda lo dice («sin flujo ligado ni
actividad en esta sesión»). Si la proyección falta, está corrupta, es de una
versión que el mod no entiende o su directorio fue alterado, dice que no está
disponible y por qué; no lo confunde con el estado vacío y no cae a una
observación anterior.
Si la lectura no alcanza a leer una observación que otra publicación acaba de
podar, conserva la última lectura marcada como tal. Lo mismo hace si una lectura
pasa de 10 segundos, y no empieza otra hasta que esa termine; si mientras tanto
cambia la sesión o el checkout, retira los datos de la anterior y dice que no
está disponible hasta que esa lectura termine.

El lector de proyección consulta cada segundo, solo dentro de
`.sdd-ai/projection/live/` del checkout de la sesión, y la banda cambia sin un
turno nuevo, sin llamar al modelo y sin esperar a `wait`. Cuando la línea no
cabe, acorta en este orden: el nombre del flujo, la asociación de una actividad
ajena, el revisor y el lote, y la ronda; el paso, el progreso, la marca de writer
y la antigüedad no se acortan. Cede el lugar a una encuesta, respeta el plegado
de la persona y solo se dibuja en la terminal: en el escritorio y en las demás
superficies, el mod deja ese lugar como está.

La proyección la publica el binario también con Codex como conductor o con el
mod desactivado; sin el mod, simplemente no hay banda.

### Volver atrás

Para quitar la banda basta con volver a una versión del mod sin ella y correr
`./bin/sdd-ai agents sync`, y adoptar la copia según la versión de Claude Code
(`/reload-plugins` o sesión nueva con 2.1.290 y 2.1.291). Para volver a un binario que no publica la
proyección hay que borrar además `.sdd-ai/projection/` en cada checkout y
worktree: si no, un consumidor seguiría mostrando la última observación, que
puede no tener corridas vivas ni antigüedad que la delate. `sdd commit` no
admite cuerpo, así que esta instrucción vive acá, en `docs/projection.md` y en el
handoff del flujo.

## Desarrollo y comprobaciones

En una versión compatible de Claude Code, desde la raíz del repositorio:

```sh
npm run test:mods
npm run typecheck:mods
```

`test:mods` ejecuta `claude plugin validate --strict mods/sdd-ai`, revisa que
el informe declare llamadas solo desde `register.tsx` y solo a `$.ui.resolve`,
`$.state.get`, `$.state.set`, `$.fs.list`, `$.fs.stat`, `$.fs.read`,
`$.session.id`, `$.session.root`, `$.clock.every`, `$.clock.after` y
`$.clock.now`, `$.prompt.submit`, `$.prompt.read`, `$.fs.write`, `$.store.get`,
`$.store.set`, `$.command.register`, `$.ui.open`, `$.ui.close`, `$.ui.panes` y
`$.env.get`, y después ejecuta `claude plugin test mods/sdd-ai`. La fuente limita
`$.env.get` a los argumentos literales `CLAUDE_CONFIG_DIR` y `HOME`. La
comparación es por llamada exacta; la anotación `(via <función>)` con que el
motor marca una llamada hecha desde un auxiliar no cuenta. Cualquier fallo impide
completar el script.

Si Claude Code responde que los módulos están apagados porque una sesión
anterior guardó apagado el interruptor de rollout («hooks modules are turned off
in this process: the rollout switch was saved off by an earlier session»),
`test:mods` lo dice y falla sin informar pruebas aprobadas. Se recupera a mano:
`claude -p --model haiku ok` con acceso a red refresca el interruptor, y después
se reintenta `npm run test:mods`. El script nunca lo ejecuta por su cuenta. Para desarrollar se usa el runner del
plugin; no cargues la fuente con `--plugin-dir` en una sesión que ya tenga la
copia instalada, para evitar dos instancias del mismo mod.

Los tests del motor montan explícitamente la superficie `terminal` y comprueban
contenido y distribución a 166, 80 y 79 columnas. Esas comprobaciones no
acreditan la pintura real de la terminal de Orca, que exige observación visual.

`typecheck:mods` consume las declaraciones que escribe el motor cuando carga
la copia con `--plugin-dir`:

```text
.claude/skills/sdd-ai-mod/.claude-plugin/types/
  claude-code/
  claude-code-tools/
  claude-code-mcp/
  tsconfig.json
```

Una sesión que carga la copia desde las skills del proyecto no las escribe, y
`validate` y `plugin test` tampoco. Se generan desde la raíz del checkout con:

```sh
claude -p --plugin-dir .claude/skills/sdd-ai-mod --model haiku ok
```

Durante esa ejecución, el `--plugin-dir` desplaza a la copia del proyecto, que
tiene el mismo nombre: el mod no se carga dos veces. Si falta la copia, el
script pide ejecutar `./bin/sdd-ai agents sync`; si faltan las declaraciones,
muestra ese comando.
El `tsconfig.json` que el motor escribe en la raíz de la copia tampoco es la
configuración que consume el script.

El script crea fuera del repositorio una configuración temporal que hereda
la del motor, incluye únicamente los hooks, tipos propios y tests de la
fuente, y activa `noEmit`. Usa el `tsc` del proyecto (`node_modules/.bin`)
o, si falta, el del PATH, y elimina el temporal al terminar, también ante un
fallo. La fuente no lleva `tsconfig.json` ni una declaración
sustituta del API. Los archivos generados del motor están ignorados por Git.

`npm test` y `npm run typecheck` permanecen separados del plugin y pueden
ejecutarse sin Claude Code; el mod no entra en el entorno Node de esos scripts.

## Uso sin el mod

Con una versión anterior a 2.1.287 o sin soporte de mods, utiliza el binario
habitual y lee su JSON. Las comprobaciones específicas del plugin requieren
una versión compatible y no se ofrecen como disponibles en versiones sin
soporte. La distribución de su copia no cambia las funciones del binario.

Los repositorios sin confianza y los workers Claude lanzados con
`--safe-mode` funcionan sin activar el mod. Codex conserva las salidas JSON
y no incorpora esta presentación. `agents sync`, `init` y `doctor` informan
la copia local del mod incluso en esos modos.
