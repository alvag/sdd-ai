Apoyos: [writer](writer.md); [recepción](reception.md); [recuperación](../procedures/recovery.md); [mod](mod.md). Lee writer antes de sincronizar con una reserva, recepción al recibir, recuperación al retomar y mod solo para operación en Claude.

## Adopción tras agents sync

Las vías de esta guía están comprobadas con **Claude Code 2.1.296** y **Codex 0.162.1**, en **macOS**. Adoptar no exige `init`, cambios de preferencias ni configuración global. Sincronizar instala copias, pero no demuestra qué cargó la sesión.

Antes de sincronizar con un writer reservado, espera **cese comprobado y cosecha**. Ante `cessation_uncertain`, detente sin escrituras en el árbol, pregunta al usuario y no liberes la reserva por tu cuenta. Emitir orientación no sincroniza automáticamente ni autoriza reparación, recuperación, recepción o gates.

## Condición observable por componente

- **Primera carga:** el componente no estaba operativo antes de instalarlo en la sesión abierta.
- **Actualización con carga previa comprobada:** antes de actualizar se usaron efectivamente la skill y sus apoyos anteriores, se invocó realmente el agente anterior o se observó el mod operativo en Claude, según el componente.
- **Carga desconocida:** falta esa observación previa. Archivos, hashes, contadores y estados `missing`, `stale` u `ok` describen disco, no carga. Usa la vía comprobada para ambas condiciones; comprueba operación con material vigente antes de continuar.

## Claude Code 2.1.296 en macOS

| Componente | Primera carga o carga desconocida | Actualización con operación previa comprobada |
|---|---|---|
| Agentes | `/reload-plugins`; comprobar con Agent e instrucciones vigentes | `/reload-plugins`; la adopción automática no es fiable (el agente anterior siguió respondiendo después de la sync); comprobar con Agent |
| Skill y apoyos | `/reload-plugins`; usar material vigente | Adopción automática; recarga adicional también comprobada |
| Mod | `/reload-plugins`; comprobar comportamiento operativo | Adopción automática; recarga adicional no duplica el mod |

`/reload-skills` solo adopta la skill; no es un paso adicional obligatorio después de `/reload-plugins` y no adopta agentes ni mod.

Si la recarga falla, no está disponible o carece de verificación, conserva sesión nueva como fallback: `/exit` y `claude --resume <id>` usando el comando mostrado al salir, en la misma terminal. En el entorno probado adopta los tres componentes y conserva conversación e id. Fuera de ese entorno no extiendas esa garantía.

## Codex 0.162.1 en macOS

| Componente | Primera carga o carga desconocida | Actualización con operación previa comprobada |
|---|---|---|
| Skill y apoyos | Adopción automática; no requiere hilo nuevo solo para ella | Adopción automática |
| Agentes | `/fork` → `Use current Git worktree`; invocar el agente vigente | Adopción automática; `/fork` también comprobado con agente anterior operativo |
| Mod | No aplicable: distribuir su copia no lo ejecuta en Codex | No aplicable |

`/fork` conserva conversación y terminal, crea un hilo nuevo y cambia `CODEX_THREAD_ID`. Antes de `/fork` o `/new`, recibe las corridas nativas abiertas de esta sesión: el hilo nuevo no ve ni recibe las nativas del hilo anterior. La adopción automática no lo requiere. Después de `/fork` o `/new`, ejecuta exactamente `./bin/sdd-ai sdd status <id>` para ligar la sesión nueva al flujo antes de continuar o recibir. Ese relevo no demuestra transferencia nativa ni entrega.

Fallback: `/new` adopta agentes y pierde la conversación. Resume del hilo original **no adopta agentes nuevos**; no lo presentes como alternativa positiva. Si falla la adopción automática de la skill o el entorno no está verificado, conserva sesión nueva como fallback sin prometer conservación de conversación.

## Continuidad y límites

Conservar terminal, conservar conversación y recuperar estado persistido son cosas distintas. Retoma el flujo existente sin reiniciarlo ni recrear artefactos, aprobaciones o registros. La adopción no altera por sí sola identidad de corridas ni relación corrida–flujo–checkout. Un relevo legítimo de sesión no inventa entregas ni aprobaciones. No canceles ni relances corridas para adoptar.

La continuidad con corridas vivas requiere comprobación operacional: una recarga no la acredita por sí sola, tampoco después del cese comprobado y la cosecha de un writer.

En otras versiones o sistemas, estas opciones solo están ensayadas en el entorno indicado y carecen de verificación actual. Conserva sesión nueva como fallback, declara límites de retoma y conversación y comprueba cada componente operativo sin editar configuración global. La falta de verificación no reemplaza una investigación obligatoria.
