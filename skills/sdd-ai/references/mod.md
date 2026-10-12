<!-- Origen: mods/sdd-ai/README.md: compatibilidad, instalación, espera y señal/fallos/rollback. Traslado de la base a70c7da. -->

Apoyos: ninguno. Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## Compatibilidad y estado de comprobación

Los mods requieren Claude Code **2.1.287 o posterior**. La sonda se validó con
**2.1.288**, y esta implementación se comprobó con **2.1.289**, la versión
instalada al implementarla. Lo observado con esas versiones no se extiende a
otras.

El panel, los comandos, la banda y los resúmenes guardados se comprobaron en vivo
con **2.1.291** en macOS, siguiendo la guía de comprobación del repositorio de desarrollo:
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
la guía de comprobación del repositorio de desarrollo.

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
de `.sdd-ai/projection/` documentada por la documentación de desarrollo de la proyección. Los registros de aviso
nunca se convierten en entregas durante el rollback.

