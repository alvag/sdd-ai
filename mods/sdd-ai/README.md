# sdd-ai-mod

Presentación de las salidas de `sdd-ai` en la terminal de Claude Code. El mod
observa llamadas Bash y dibuja resúmenes; el binario conserva sus resultados,
códigos de salida, guardas y decisiones. El mod no ejecuta `next`, no registra
comandos ni herramientas y no modifica las corridas.

## Compatibilidad y estado de comprobación

Los mods requieren Claude Code **2.1.287 o posterior**. La sonda se validó con
**2.1.288**, y esta implementación se comprobó con **2.1.289**, la versión
instalada al implementarla. Lo observado con esas versiones no se extiende a
otras.

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
también si la sesión arrancó antes de que existiera la copia; una sesión que
ya tenía el mod adopta sola la copia actualizada en cuanto `agents sync` o
`init` terminan de escribirla. En ningún caso se carga dos veces (comprobado con
2.1.289). No hace falta cancelar, relanzar ni modificar una corrida viva para
cambiar su presentación.

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

## Resúmenes y acceso al original

Una ejecución reconocida de `./bin/sdd-ai` o `bin/sdd-ai` con un objeto JSON
completo muestra los campos disponibles, incluidos `state`, `code` y `next`.
El estado de Bash y su código de salida se distinguen del estado publicado
por el binario. Los mensajes, detalles y pasos siguientes conservan su texto
completo. Si hay otros campos, el resumen enumera sus nombres.

El ledger conserva todas las entradas y su orden. Desde 80 columnas de terminal
se presenta como tabla; por debajo, sin ancho medido o sin espacio suficiente
para la afirmación, utiliza bloques. Solo la afirmación puede recortarse con
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
el salto de línea. El mod parte los textos largos en tramos y, si aun así el
dibujo no entraría (por ejemplo, un original con colores en stderr), deja ese
resultado o ese grupo en la vista nativa, con la salida completa. Las salidas
grandes topan antes con el límite del párrafo siguiente.

Claude Code guarda aparte la salida de un Bash de más de unos 30 KB y a la
llamada le deja solo un recorte (comprobado con 2.1.289). Un recorte no es el
resultado completo, así que el mod no lo resume: en el grupo compacto la
llamada sale marcada «sin resumen», con el tamaño de la salida guardada, y el
resultado suelto queda nativo. Pasa con los `review status` de ledgers largos;
el binario y el modelo siguen recibiendo lo mismo que sin el mod.

## Desarrollo y comprobaciones

En una versión compatible de Claude Code, desde la raíz del repositorio:

```sh
npm run test:mods
npm run typecheck:mods
```

`test:mods` ejecuta `claude plugin validate --strict mods/sdd-ai`, revisa que
el informe del módulo solo declare llamadas a `$.ui.resolve`, `$.state.get`
y `$.state.set`, y después ejecuta `claude plugin test mods/sdd-ai`. Cualquier
fallo impide completar el script. Para desarrollar se usa el runner del
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
fuente, y activa `noEmit`. Usa `tsc` del PATH y elimina el temporal al terminar,
también ante un fallo. La fuente no lleva `tsconfig.json` ni una declaración
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
