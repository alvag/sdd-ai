<!-- Origen: SKILL.md:238–346. Traslado de la base a70c7da. -->

Apoyos: [writer](writer.md); [mod](mod.md); [findings](findings.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## 3. Sigue la respuesta

La telemetría local es opcional: `telemetry: on|off` en `~/.sdd-ai/config.yml`, apagada por
defecto. `SDD_AI_TELEMETRY=on|off` tiene prioridad incluso si el archivo no se lee; otros valores
se ignoran. El supervisor captura la variable al arrancar y lee el archivo en cada cierre de
intento. Con on publica una línea JSONL privada por intento en `~/.sdd-ai/telemetry/`, antes de
terminar la corrida: consultar o admitir la respuesta no la duplica. Solo registra identificación,
perfiles y consumo, nunca prompts, respuestas, código, salidas ni diagnósticos. Los archivos nuevos
tienen permisos 0600 y el directorio 0700. La vía nativa no genera líneas ni se exportan métricas
anteriores. Si una reanudación Codex carece de baseline, conserva el contador acumulado del hilo,
su id y el scope `thread_cumulative` por contador; `metrics.json` conserva su comportamiento.
La telemetría calla sus fallos: nada avisa cuando está encendida y no escribe.

Cuando `run` devuelve un `id`, ya copió el encargo a la corrida: borra el temporal. Si `run` falla
antes, consérvalo para reintentar.

**`"via": "native"`**: lánzalo tú, sin heredar esta conversación.

- Claude Code: herramienta `Agent` con `subagent_type` igual al valor de `agent` (hay un agente
  por rol, como `sdd-ai-explore` o `sdd-ai-code-review`). Los roles de fase (`specify`, `plan` y
  `tasks`) no tienen agente: los despacha solo `sdd phase`, por proceso ([fases documentales](document-phases.md)).
- Codex: `spawn_agent` con `agent_type` igual al valor de `agent`, sin heredar el historial.
  El subagente hereda la búsqueda web de tu sesión, porque Codex no aplica `web_search` desde el
  archivo del agente. Por eso `explore` e `investigate` buscan solo si la tienes encendida, y en los
  demás roles la búsqueda se apaga solo por instrucción. Si hace falta garantizarlo, conviene la vía
  `process`.
- En los dos, el mensaje es: `Tu encargo está en <prompt_file>. Léelo completo y cúmplelo.`
- El encargo leído por todo subagente nativo debe prohibir ejecutar `claude`, directamente
  o mediante scripts que lo lanzan: `npm run test:mods`, la preparación de las declaraciones
  del motor y la recuperación del rollout. Si una comprobación necesaria exige Claude, el
  delegado la informa como pendiente para el conductor y no la ejecuta. El conductor la
  realiza con red; no la vuelve a delegar.
- Si la respuesta trae `model` o `effort`, pásalos a la herramienta: en Codex, `model` y
  `reasoning_effort` de `spawn_agent`; en Claude Code, `model` del `Agent` con el alias que
  corresponda (`opus`, `sonnet`, `haiku` o `fable`).
- Si la respuesta trae `warnings`, muéstraselas al usuario antes de lanzar: dicen qué parte del
  perfil pedido no se puede aplicar (por ejemplo, el esfuerzo de un subagente de Claude Code).
- El hook de `PreToolUse` liga el despacho a su corrida y **reescribe el input entero**: el mensaje
  canónico, el modelo y el esfuerzo de la corrida y, en Codex, sin historial. Lo que agregues de más
  se descarta. Si tienes más de una corrida nativa sin lanzar para ese agente, cita en el mensaje el
  `prompt_file` de la que despachas.
- **Codex con `spawn_agent` v2** (el que tiene `task_name` y `fork_turns`): el mensaje va cifrado y el
  hook no lo puede leer ni reescribir. Escríbelo igual, con el mensaje canónico, y despacha con una
  sola corrida nativa sin lanzar para ese agente: si hay varias, cancela las que no vas a despachar.
- **Si el lanzamiento falla y tu CLI lo informa** (solo Claude Code, que libera la reserva):
  muéstrale el error al usuario tal cual y no reintentes por tu cuenta. Si el usuario decide
  reintentar, despacha la misma corrida citando su `prompt_file`.
- **Si queda una reserva sin confirmar** (un fallo en Codex, que no informa fallos, o cualquier
  despacho que no llegó a confirmarse), un nuevo despacho de esa corrida se niega: pregúntale al
  usuario. Si decide reintentar o descartar, primero `./bin/sdd-ai cancel <id>`, que cambia solo el
  registro local y no detiene a un agente que quizá arrancó. Para reintentar, después
  `./bin/sdd-ai run --retry <id>`: hereda el encargo, el rol, los overrides y la familia del
  conductor. Si la config cambió desde entonces, la resolución puede ser otra y la respuesta de `run`
  lo muestra: es una corrida nueva.

**`"via": "process"`**: el binario ya lanzó al worker. Espera el resultado:

```
./bin/sdd-ai wait <id>
```

En Claude Code, con timeout de Bash de 600000 ms. Si sale con código 3, la corrida sigue viva:
vuelve a llamar a `wait`. Con código 0, el resultado está en `result`.

Con el mod de Claude operativo puedes terminar el turno sin dejar un `wait` pendiente: al observar una
terminación sin recibir, pide otro turno con el id y el comando de recepción. Recibe workers y writers
con `./bin/sdd-ai wait <id>`, y revisiones con `./bin/sdd-ai review status <id>` (también admiten `wait`).
Un resultado terminal fallido puede recibirse aunque la consulta salga con código 1. El aviso aceptado
no registra entrega: la registra el binario después de construir la respuesta. Interpretar el resultado,
decidir hallazgos y aprobar gates siguen siendo acciones posteriores del conductor y de Max.

Sin mod operativo, o desde Codex, conserva la espera activa o consulta manualmente esos comandos.
`Stop` actúa cuando termina un turno; no despierta espontáneamente una sesión inactiva. Tener instalada
la copia del mod no prueba operatividad: su señal de vida debe estar vigente y tener `operational: true`.
Trabajo, preguntas, borrador de Max y banda plegada no desactivan por sí solos el aviso; el envío espera
a que la sesión esté disponible y el borrador esté vacío.

La dueña operativa tiene prioridad, aunque esté ocupada. Para retomar desde otra sesión de Claude en el
mismo checkout, ejecuta `./bin/sdd-ai sdd status <flow>`: el hook liga esa sesión al flujo. Solo puede
recibir como relevo si la dueña está acreditada como no operativa y hay una única candidata operativa
ligada al flujo. Si ninguna está operativa, la recepción manual sigue disponible para la única ligada
con señal vigente, incluso degradada. Una sesión sin señal vigente no recibe como relevo.

Con asociación ausente o contradictoria, varias candidatas o lecturas desconocidas, conserva el pendiente:
la dueña puede consultar manualmente sin mod; para el relevo, recupera las lecturas o resuelve las ligas
mediante los hooks existentes y vuelve a consultar `sdd status`. No elijas una sesión por proximidad ni
edites los recibos a mano. Si desaparece la destinataria de un aviso aceptado, la siguiente receptora
legítima tiene su propia clave de aviso. En una transición puede haber uno por sesión para el mismo
resultado; una recepción ya registrada es inocua al volver a consultar.

Un rechazo confirmado admite tres solicitudes por resultado y sesión, incluida la inicial: espera 30 s
antes de la segunda y 60 s antes de la tercera, siempre tras una observación válida. Agotados los intentos
(`exhausted`), recibe manualmente. Una promesa rechazada, respuesta ilegible, cierre durante el envío o
10 s de espera ociosa producen `indeterminate`: consulta `wait` o `review status`, sin reenvío ciego.
El plazo no corre mientras Claude trabaja o espera una pregunta. Una respuesta tardía puede cerrar el
intento; nunca inicia otro. Con persistencia corrupta o la cuota de store agotada, también recibe manualmente.

La señal vence a los 5 s desde su última renovación, comprobando su fecha y la del archivo. Solo una
señal vigente operativa calla a `Stop`, sin consumir recordatorios. Al desactivar el mod, dejar de funcionar
o perder la proyección compatible, esa cobertura deja de justificar el silencio. Sin cobertura, `Stop`
conserva sus límites anteriores. Instalación, recarga y rollback están en [operación del mod](mod.md).

Si `wait` trae `warnings`, muéstraselas al usuario. Hay dos casos:

- `retry`: el CLI rechazó el modelo o el esfuerzo pedido y el binario reintentó una sola vez sin ese
  campo. Dice qué campo, qué se pidió, qué se usó y el diagnóstico del proveedor.
- `resume`: se agotó el tope y el binario reanudó la misma sesión una vez, pidiéndole que entregue
  lo que tenga. Una respuesta reanudada puede ser más corta: díselo al usuario.


Después de recibir un resultado que pueda cambiar el flujo, consulta `./bin/sdd-ai sdd status <id>` y carga el procedimiento del next vigente. Un aviso o reporte no acredita entrega, tasks ni aprobación; revisa el resultado antes de continuar.
