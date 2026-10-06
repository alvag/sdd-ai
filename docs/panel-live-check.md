# Comprobación real de panel y comandos

Este procedimiento corresponde al conductor en Claude Code sobre macOS. Los workers
y subagentes no ejecutan `claude`, `npm run test:mods`, preparación de declaraciones,
recuperación del rollout ni estas sondas. Las pruebas simuladas no acreditan pintura
real. Un escenario impedido o no observado queda pendiente.

Guardar reportes, matriz y capturas legibles en
`.plans/panel-y-comandos/evidence/`. Registrar para cada ejecución fecha, comando
exacto, versión de Claude Code y Node, macOS, terminal, columnas, checkout, sesión,
corridas y preparaciones artificiales. No consultar memoria, web, vault ni el repo
hermano para ampliar la lista de escenarios.

## Preparación y comprobaciones

1. Sincronizar con `./bin/sdd-ai agents sync` antes de cada uso real del mod.
2. Confirmar que las declaraciones reales y `tsconfig.json` bajo
   `.claude/skills/sdd-ai-mod/.claude-plugin/types/` son legibles. Si faltan, el
   conductor las prepara con red mediante
   `claude -p --plugin-dir .claude/skills/sdd-ai-mod --model haiku ok`.
3. Adoptar la copia según la versión: en 2.1.290, `/reload-plugins` o una sesión
   nueva. Cambiar la copia por sí solo no acredita adopción en una sesión abierta.
4. Después de los comandos y después de las salidas guardadas, correr
   `npm run test:mods` con red. Antes de la observación final, conservar también
   `npm run typecheck:mods`, `npm run typecheck` y las filas acotadas del plan.
   Un fallo de preparación o rollout apagado es un impedimento, nunca un verde.
5. Separar la instrumentación de comandos de las señales del avisador existente:
   un turno independiente del avisador no se atribuye a abrir una vista.

## Contraste del rollout de #108

En un entorno aislado, registrar el estado inicial y guardar diferencias de sus
artefactos de configuración antes y después de cada ejecución. Intentar identificar
el archivo y la clave que persisten el interruptor y observar su valor. El mensaje
de módulos apagados no identifica por sí solo esa persistencia.

Preparar tres ejecuciones desde estados iniciales equivalentes, registrando versión,
comando, condiciones de red, archivos cambiados, valor anterior y posterior si se
localizó, resultado y diagnóstico:

| Ejecución | Preparación | Comparación |
| --- | --- | --- |
| Control | No lanzar la ejecución sospechosa | Estado inicial frente al final |
| Con red | Lanzar la ejecución sospechosa con red disponible | Frente al control |
| Sin red | Lanzar la misma ejecución con red impedida | Frente al control y a la ejecución con red |

La recuperación `claude -p --model haiku ok` se registra como otra ejecución, no
como observación neutral. Si se utiliza `test:mods`, correrlo con red, registrarlo
como ejecución adicional del contraste y agregar un control que permita separar
su efecto. No usar el runner como instrumento neutral.

Guardar intentos y resultados en `evidence/rollout.md`. Solo declarar causa
comprobada si se identificó el valor persistido y el contraste acredita un cambio
atribuible. Sin localización o reproducción, distinguir hipótesis vigentes y
descartadas, mantener #108 abierto y dejar su acreditación a Max en verify. La
prevención se entrega aunque la causa no se reproduzca.

## Primera sonda de salidas guardadas

Después de T10 y su comprobación, sincronizar y adoptar el mod. Con Claude real y
red, obtener tres salidas de más de 30 KB: un `review status` real, una salida con
stdout grande y stderr, y otra grande con código distinto de cero. Para las dos
últimas puede usarse un comando de prueba; registrar su texto exacto.

Conservar ToolResult, `persistedOutputPath`, contenido del archivo y la raíz
calculada: `<CLAUDE_CONFIG_DIR>/projects` cuando está definida esa variable, o
`<HOME>/.claude/projects` en otro caso. Comparar ruta léxica y física con
`/projects/<proyecto>/<sesión>/tool-results/<archivo>`.

Documentar si el archivo contiene stdout, stderr o el prefijo `Exit code N`, y cómo
su texto resulta equivalente al inline sin reconstruir contenido ni cambiar el
JSON del binario. `isErrored` sigue saliendo del ToolResult. Guardar la evidencia
en `evidence/persisted-format.md` antes de T12 y T13. Si la forma de ruta, raíz o
formato no corresponden al plan, detenerse y consultar a Max antes de implementar.

## Segunda sonda: resumen y original nativo

Después de T16 y su comprobación, sincronizar y adoptar la rama. Obtener un
`review status` guardado cuyo ledger sature el presupuesto después del recorte.
Registrar tamaño, presupuesto, entradas visibles y faltantes, versión y capturas.
Aceptar solo si el individual muestra resumen y original, sin caída nativa por
tamaño ni árbol rechazado por el motor.

Si no hay una salida real suficiente, el conductor prepara un worktree descartable
con `git worktree add --detach` sobre HEAD. Antes de copiar el árbol actual, retira
allí los archivos versionados borrados que identifica `git ls-files -z -d`.
Copia después archivos versionados y nuevos no ignorados con
`git ls-files -z -co --exclude-standard | rsync -a --from0 --ignore-missing-args --files-from=- ./ <worktree>/`.
No crear commits, cambiar el índice ni mover la rama de trabajo.

En ese worktree, correr `./bin/sdd-ai agents sync` antes de reemplazar su binario
por un sustituto. Este imprime un `review status` real del flujo con ledger
repetido e ids renumerados, válido, entre 30 KB y 1 MiB y suficiente para saturar
el presupuesto. Abrir Claude allí y ejecutar `./bin/sdd-ai review status <id>`;
declarar la preparación sintética en la evidencia.

Si el árbol de 90 000 se rechaza, reducir únicamente el presupuesto individual
guardado a 60 000, reservar 30 000 para el original, ajustar tests y repetir las
comprobaciones y la sonda. Grupo e inline conservan sus presupuestos del plan.
Si también se rechaza con 60 000, detenerse y consultar a Max. Nunca omitir el nodo
original ni modificar el JSON. Retirar el worktree con
`git worktree remove --force <worktree>` al terminar.

## Matriz visual cerrada

Guardar en `evidence/live-check.md` el resultado de cada fila y sus capturas. Las
comparaciones de contenido usan la proyección de origen, no otra consulta del
dominio que pudiera recibir resultados. Medir el refresco desde la disponibilidad
de la observación válida hasta su pintura, sin turno ni refresco manual.

| Escenario | Preparación | Observación y comparación |
| --- | --- | --- |
| Panel y lista | Flujo ligado, gates, tasks, bloqueos y corridas propias abiertas | `/sdd-panel` y `/sdd-runs` muestran los datos publicados y sus limitaciones |
| Consulta durante turno | Turno en curso; instrumentación de solicitudes y dominio | Abrir y cerrar no llama al modelo ni cambia el dominio; separar el avisador |
| Borrador | Texto sin enviar en el compositor | Abrir, alternar y cerrar conserva el texto y permite seguir usando el prompt |
| Refresco | Publicar un cambio controlado | Pintura en hasta cinco segundos normales; registrar excepciones declaradas del lector |
| Salida guardada | `review status` atribuido a esta carga | Resumen individual y compacto, recorte contado y acceso al original |
| Fallo de lectura | Archivo no disponible o denegado | Individual nativo; grupo sin resumen y tamaño cuando se conoce |
| Writer en curso | Writer real ejecutándose | Banda identifica esa corrida; no sustituirlo por un estado preparado |
| Cese incierto | Real o preparado y declarado | Banda distingue la protección incierta |
| Anchos | Dos anchos, uno de 80 columnas o menos | Banda de una línea en ambos, con la versión vigente |
| Pregunta abierta | Pregunta visible junto con la banda | Convivencia visual y continuidad del prompt |

Si Claude sigue en 2.1.290, no repetir plegado ni aviso con banda plegada. Si cambió
la versión, agregar ambos a la matriz y observarlos con esa versión. Para cómo
observar la banda se puede usar `docs/notification-live-check.md`; esta lista manda
sobre sus escenarios. Todo estado artificial queda identificado.

## Adopción, desactivación y rollback

Después de la matriz visual, preparar antes de adoptar corridas vivas, terminales
abiertas o pendientes, cerradas y una salida guardada histórica. Registrar identidad,
dueñas, asociaciones, entregas, gates y estado de ejecución.

Para instalación, actualización y recarga según la versión, comprobar que panel
y lista muestran pendientes ya publicados sin relanzarlos ni exigir una transición
nueva. Las cerradas siguen excluidas y la salida histórica conserva su presentación
anterior, sin lectura retrospectiva. Comparar el dominio tras cada operación.

Aplicar desactivación y rollback según el README y verificar su adopción efectiva.
En 2.1.290 usar `/reload-plugins` o sesión nueva también para descargar una copia.
Si además se revierte el productor de proyección, conservar la limpieza descrita
en el README. No atribuir a las vistas cambios de acciones independientes.

Guardar en `evidence/adoption.md` la matriz antes/después, diferencias, capturas,
limitaciones y casos pendientes. Reconciliar después el README con lo observado,
delimitando garantías por versión y registrando V13 en `evidence/readme-check.md`.
No modificar el repositorio hermano desde este procedimiento.
