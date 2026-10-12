<!-- Origen: SKILL.md:1447–1504. Traslado de la base a70c7da. -->

Apoyos: [errors](errors.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## 10. Retener lo que guarda sdd-ai: `prune`

La telemetría de usuario tiene retención independiente de 30 días de calendario UTC: en cada cierre,
con on u off, se borran solo archivos propios regulares de días anteriores a hoy menos 30; el día
del límite se conserva. No se siguen enlaces ni se reescriben archivos que reciben líneas. `prune`
y `--keep-days` no cambian esa retención ni borran las líneas recientes de una corrida eliminada.
Una revisión final citada en un flujo sin archivar queda protegida por `cited`, también después de
una pausa de más de siete días; al retomar sigue sujeta a las validaciones de status y commit.

`sdd-ai prune` limpia por antigüedad lo que guarda este checkout: las corridas de `.sdd-ai/runs/`,
sus almacenes de writer en el directorio Git, los recibos y acreditaciones de verify, las tomas,
las sesiones de hooks y cada entrada de `.sdd-ai/tmp/`. La ventana es de 7 días; `--keep-days <n>`
la cambia por un entero desde 1. La edad cuenta la modificación más reciente de toda la unidad,
directorios incluidos, sin seguir enlaces.

Conserva las unidades con estos motivos, en este orden:

- `open`: la corrida sigue en vuelo, un writer no tiene cosecha, una nativa está pendiente o sin
  confirmar, una revisión tiene hallazgos sin decidir, o una corrida terminó sin entregarse a su
  sesión dueña. Una terminada sin sesión dueña no tiene entrega pendiente. El ensayo indica cómo cerrarla.
- `unreadable`: no se puede leer el estado de la corrida o el estado de ruta de una sesión de hooks.
- `cited`: su id aparece como token entero en cualquier archivo de un flujo no archivado de `.plans/`,
  en este checkout o en otro worktree del repositorio. El ensayo nombra los flujos que lo citan.
- `bound`: la sesión de hooks está ligada a un flujo abierto de este checkout. Se conserva entera
  para mantener la liga y la guarda del commit.
- `recent`: alguna ruta de la unidad se modificó dentro de la ventana.

Solo borra unidades viejas sin esos motivos. Una sesión de hooks se borra entera, con recordatorios,
estado de ruta, rastro y lock. Una cita de un flujo archivado no protege nada. Nunca borra en otro
worktree, toca `.plans/` ni incluye la reserva compartida, la intención y el lock de restauración,
`config.yml`, `workers.yml` o `.gitignore`.

**Ensayo y gate.** Corre `./bin/sdd-ai prune`, o `./bin/sdd-ai prune --keep-days 30`. No borra nada:
devuelve `state: dry_run`, candidatos agrupados por tipo con id, ruta y bytes, lo conservado con
su motivo, el total que liberaría, el digest y el comando de aplicación en `next`.

El conductor debe mostrarle ese ensayo al usuario y preguntarle si lo aplica: con `AskUserQuestion`
en Claude Code, o con opciones numeradas en Codex. Espera su respuesta. Aplica únicamente con el
digest que el usuario aprobó, usando `./bin/sdd-ai prune --apply --digest <d>`; si cambiaste la ventana,
mantén el mismo `--keep-days <n>`. Nunca encadenes el ensayo y la aplicación sin esa respuesta.
`prune` nunca corre desde un subagente, ni siquiera para hacer el ensayo. No hay limpieza automática.

La aplicación recalcula el digest y recomprueba cada unidad antes de borrarla. Una unidad que pasó
a estar protegida o cambió queda conservada; una revisión con lock ocupado, también huérfano, queda
como `busy`. La salida `applied` informa `deleted`, `kept_on_recheck` y `freed_bytes`. La carrera
residual aceptada es que alguien escriba una cita en un flujo entre la recomprobación y el borrado:
esa cita todavía no protege la unidad.

| Código | Qué hacer |
|---|---|
| `digest_mismatch` | El plan cambió. Haz un ensayo nuevo y pide aprobación de su digest. No se borró nada. |
| `prune_failed` | El borrado se detuvo al primer fallo. Revisa en `detail` lo borrado, la unidad fallida y sus entradas ya borradas; corrige la causa y haz otro ensayo. |
| `flow_unreadable` | No se pudo leer el archivo de flujo indicado. Restablece su lectura y repite el ensayo; no apliques con citas incompletas. |
| `path_invalid` | Una base es un enlace o no es un directorio. Corrige la ruta indicada antes de repetir el ensayo. |

Los temporales van fuera del repositorio. Si hay sobrantes en `.sdd-ai/tmp/`, `prune` limpia cada
entrada por antigüedad y conserva las recientes; no vacía el directorio entero.

