---
name: sdd-ai
description: Delega una tarea de solo lectura (explorar, buscar, resumir código) a un worker de Claude o Codex elegido por la config del repo, o revisa un diff congelado con un revisor aislado. Usar cuando el usuario pide "delega esto a un worker", "usa sdd-ai", "que otro agente explore esto" o "revisa este diff".
---

# sdd-ai: despachar un worker read-only

El binario decide qué familia hace el trabajo y por qué vía. Tú escribes el encargo, sigues lo que
responde y le preguntas al usuario ante cualquier fallo. Todo comando imprime un JSON.

## 1. Escribe el encargo

Escribe el encargo en un archivo. El worker no ve esta conversación: el encargo tiene que ser
autosuficiente (qué hacer, dónde mirar, qué formato de respuesta).

## 2. Pide el despacho

```
./bin/sdd-ai run --prompt-file <archivo> --conductor <claude|codex> --conductor-model <tu modelo>
```

- `--conductor` es tu propia familia: `claude` si eres Claude Code, `codex` si eres Codex.
- Si conoces tu esfuerzo de razonamiento, agrégalo con `--conductor-effort <valor>`. Codex no lo
  expone al shell, así que sin el flag una caída a tu familia no puede conservarlo.
- Agrega `--role <rol>` cuando la tarea tiene un rol claro: `code-review` para revisar código,
  `refute` para refutar, `investigate` para una causa raíz, `design-review`, `debate` o
  `counter-plan`. Sin el flag, el rol es `explore`.
  `explore` e `investigate` pueden buscar en la web; los demás roles trabajan solo con el encargo y
  el repositorio.
- Agrega `--families claude` o `--families codex` solo si el usuario dijo "solo Claude" o
  "solo Codex" para esta tarea.
- **Si eres Codex** y la respuesta va a salir por la vía `process`, ejecuta `run` pidiendo
  escalamiento (fuera del sandbox): el worker necesita red. Si no sabes la vía de antemano, pide
  escalamiento siempre.

## 3. Sigue la respuesta

**`"via": "native"`**: lánzalo tú, sin heredar esta conversación.

- Claude Code: herramienta `Agent` con `subagent_type` igual al valor de `agent` (hay un agente
  por rol, como `sdd-ai-explore` o `sdd-ai-code-review`).
- Codex: `spawn_agent` con `agent_type` igual al valor de `agent`, sin heredar el historial.
  El subagente hereda la búsqueda web de tu sesión, porque Codex no aplica `web_search` desde el
  archivo del agente. Por eso `explore` e `investigate` buscan solo si la tienes encendida, y en los
  demás roles la búsqueda se apaga solo por instrucción. Si hace falta garantizarlo, conviene la vía
  `process`.
- En los dos, el mensaje es: `Tu encargo está en <prompt_file>. Léelo completo y cúmplelo.`
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

Si `wait` trae `warnings`, muéstraselas al usuario. Hay dos casos:

- `retry`: el CLI rechazó el modelo o el esfuerzo pedido y el binario reintentó una sola vez sin ese
  campo. Dice qué campo, qué se pidió, qué se usó y el diagnóstico del proveedor.
- `resume`: se agotó el tope y el binario reanudó la misma sesión una vez, pidiéndole que entregue
  lo que tenga. Una respuesta reanudada puede ser más corta: díselo al usuario.

## 4. Revisar un diff

Para la revisión de un diff (la final antes de un commit, o la de un commit ya hecho) usa `review`
en vez de un encargo a mano con `run --role code-review`. El binario congela el diff, arma el
encargo, aísla al revisor y valida su respuesta por código: tú no escribes el encargo ni juzgas si
el reporte está completo.

```
./bin/sdd-ai review start --base <ref> [--head <ref>] [--context <ruta>]... [--risk high] --conductor <claude|codex>
```

- `--base` es obligatoria: el commit contra el que se revisa (en un flujo SDD, el `base_commit` del
  plan). Con `--head <ref>` se revisa el diff entre dos commits; sin él, el árbol de trabajo.
- **Archivos nuevos:** solo entran los que están en el índice. Antes de revisar, marca los nuevos
  que son parte del cambio con `git add -N <ruta>`. La respuesta trae `left_out`: los archivos
  nuevos que quedaron afuera. Si alguno era parte del cambio, agrégalo y vuelve a correr `start`.
- Pasa la spec, el plan y las tareas con `--context`: sin ellos, el revisor no puede juzgar el eje
  SPEC.
- El revisor es de la familia opuesta al autor del diff (`--author`, que por defecto es la tuya). Si
  la respuesta trae `same_family` en `degradations`, avísale al usuario: revisó un agente fresco de
  la misma familia, sin la diversidad de la otra.
- **Si eres Codex**, pide escalamiento para `review start`, igual que para `run`.

### Nivel de riesgo y revisores

`review start` clasifica el candidato en `normal` o `high` y lo congela en la corrida. La respuesta
trae `risk`: el nivel, los motivos (cada uno con la señal y la ruta que la disparó) y `forced`, que
dice si el nivel se subió a mano. Es `high` si el candidato tiene una ruta con un segmento `auth`,
`security`, `update`, `webhook` o `payments`, un script de shell agregado o cambiado, un archivo
que pasa a ejecutable, o una línea agregada que lanza procesos (`exec(`, `spawn`, `child_process`,
un shebang…). El tamaño del diff no cuenta.

- **`--risk high`** sube el nivel a mano. Úsalo cuando el cambio toca algo sensible que las señales
  no ven, como una regla de permisos en un archivo con otro nombre. Solo sube: no hay forma de bajar
  un `high`.
- **Qué revisores corren** (`reviewers`): en `normal`, la revisión base (SCOPE → SPEC → QUALITY); en
  `high`, la base y cuatro lentes aisladas, en este orden: riesgo, resiliencia, fiabilidad y
  legibilidad. Todos son de la misma familia y corren **en serie**, y `--deadline` vale para cada uno.
  Un cambio `high` repartido en dos lotes son diez trabajos seguidos: avísale al usuario del tiempo.
- **Procedencia**: cada hallazgo del `ledger` trae `reviewer` (`base` o la lente) y `batch` (el lote).
  El binario no fusiona hallazgos repetidos entre revisores: si dos dicen lo mismo, rechaza el
  duplicado con `review decide <id> reject <F-n> --reason "duplicado de F-m"`.
- **Lotes**: si un prompt no entra en 200 KiB, el material se reparte en lotes de archivos completos,
  agrupados por directorio, y cada revisor corre una vez por lote. La respuesta trae `batches` con
  los archivos de cada lote y `batches_note`: **las relaciones entre archivos de lotes distintos no
  se revisaron juntas**. Díselo al usuario.

Después, `./bin/sdd-ai wait <id>`, igual que en la vía `process`. Si el tope de `wait` vence con la
ronda en curso, la salida trae `progress`: qué revisor y qué lote corren, y cuántos trabajos van de
cuántos. Al terminar, `wait` devuelve la misma vista que `./bin/sdd-ai review status <id>`: el
nivel, los revisores y los lotes, los ejes `SCOPE`, `SPEC` y `QUALITY`, el `ledger` con cada
hallazgo (`F-1`, `F-2`…), su estado y su procedencia, y `next`. Sigue siempre lo que dice `next`.

### Decidir cada hallazgo

Cada hallazgo `abierto` (los de `pending`) espera tu decisión:

```
./bin/sdd-ai review decide <id> accept <F-n>...
./bin/sdd-ai review decide <id> reject <F-n>... --reason "<motivo>"
```

- `accept` si lo vas a corregir.
- `reject` si no, con un motivo que el revisor pueda verificar en el código ("la línea 12 ya valida
  el caso vacío"), no una opinión. El revisor va a responder ese motivo.
- Una decisión se puede cambiar hasta que lances la ronda siguiente.
- Lo grave que ya estaba antes del cambio queda `fuera-de-alcance`: no se decide y no hace fallar
  ningún eje.

### La ronda siguiente

Corrige los aceptados y, con todo decidido, lanza:

```
./bin/sdd-ai review round <id> [--head <ref>]
```

La ronda revisa el candidato corregido con el mismo revisor, en una sesión nueva. No es una revisión
completa: el revisor dice si cada aceptado quedó resuelto, responde cada rechazo y solo puede abrir
hallazgos nuevos en lo que cambió desde la ronda anterior. `round` no lanza nada si queda un hallazgo
sin decidir, si hay aceptados y no corregiste nada, o si no hay nada que verificar ni responder.

- **`stale: true` después de corregir es lo esperado**: el diff cambió porque lo corregiste. Lanza la
  ronda; no lances un `review start` nuevo.
- Un aceptado que la ronda ve sin resolver vuelve a esperar: corrígelo otra vez (`accept`), o
  recházalo con motivo si la evidencia del revisor no te convence.
- La ronda siguiente no corre lentes: es una pasada de la base, en lotes si el material no entra,
  con cada pendiente en el lote de su archivo.
- **`risk_high`**: la corrección trajo riesgo alto (`detail` nombra la señal y la ruta), así que la
  ronda no corre: nada nuevo de riesgo alto queda aprobado sin las lentes. Pregúntale al usuario si
  reinicia la revisión con lentes; si dice que sí, corre el `review start … --risk high` que trae
  `next`.
- **Relanzar una ronda que no terminó**, también la 1: `review round <id>`, como diga `next`. Corre
  solo los trabajos que faltan; lo ya admitido se conserva mientras su encargo sea el mismo. Si el
  candidato cambió, corre todos, y antes se frena con `risk_high` si el cambio trajo riesgo alto.

### Si algo no entra en el presupuesto

`start` y `round` miden cada prompt antes de lanzar. Si alguno no entra, sale `prompt_too_large`, no
se lanza nada y la corrida queda como estaba. El mensaje dice qué no entra:

- **Un archivo** (`el archivo <ruta> no entra solo en el presupuesto`): `review` no puede revisarlo.
  Pregúntale al usuario si lo saca del cambio o lo revisa por fuera de `review`. No partas el cambio
  por tu cuenta.
- **El contexto** (`el contexto solo no entra`): pregúntale qué contexto quitar.
- **Un bloque de pendientes** (`el bloque de pendientes … no entra`): los hallazgos pendientes de ese
  lote no caben en un prompt. Pregúntale al usuario cómo seguir.

### Lo que decide el usuario, nunca tú

- **`en-disputa`** (los de `disputes`): el revisor mantuvo un hallazgo que rechazaste. Tú fuiste parte
  de esa discusión, así que no la decides: muéstrale al usuario tu motivo y la evidencia del revisor,
  pregúntale, y registra lo que diga con `review decide` (`accept` para corregirlo, `reject` para
  cerrarlo).
- **El tope**: una revisión tiene hasta 3 rondas. Si se terminó la tercera y quedan hallazgos
  vigentes, pregúntale al usuario si quiere una ronda más (`review round <id> --extra`, que concede
  una sola) o dejar la revisión como está.

### Refutación

Un hallazgo grave que solo se sostiene razonando (`evidence: inferential`) va a un refutador aislado,
que intenta desmentirlo con el mismo material:

- **`refutado`** (los de `refuted`): sale del veredicto, pero queda visible en el ledger. Si no estás
  de acuerdo con la refutación, díselo al usuario.
- Un hallazgo **inconcluso** (los de `inconclusive`, cada uno con su `reason`): el refutador no pudo
  decidir, no respondió, no entraba en un prompt (`prompt_too_large`) o se canceló (`cancelled`).
  Sigue contando y se decide como cualquier otro.
- Si el material no entra entero, la tanda se reparte por hallazgos en sub-tandas; el registro de la
  refutación en el recibo lo dice con `trimmed`.
- Un `cancel` durante la refutación deja la ronda `cancelled` con su ledger escrito: se sigue con
  `decide` y `round`, sin relanzar la refutación.

### El resultado

- **`unavailable`** con `reason: jobs_incomplete`: algún trabajo de la ronda no quedó admitido (el
  revisor no pudo inspeccionar, se agotó el tope, falló el CLI o su respuesta no se admitió ni después
  de una corrección). `jobs` trae el estado de cada trabajo y `detail` lo resume. Muéstraselo al
  usuario y pregunta si relanza la ronda con `review round <id>`, como diga `next`.
- **`stale: true` sin nada pendiente**: el diff cambió desde la última ronda y el veredicto ya no
  vale para lo que hay. Propón la revisión nueva que trae `next`.
- El recibo informa: no autoriza el commit ni el push. Un eje en `fail` se resuelve o se declara,
  como en cualquier revisión.

## 5. Revisar un artefacto

Para revisar una spec, un plan o unas tasks antes de su gate usa `review` con `--artifact`. El
binario congela el documento desde el árbol aunque Git lo ignore, lo revisa contra sus insumos de
arriba y valida la respuesta por código. El revisor es de la familia opuesta al autor, con el perfil
de `design-review`. No hay nivel de riesgo, lentes, lotes ni refutador.

```
./bin/sdd-ai review start --artifact <ruta> --kind spec|plan|tasks <insumos> [--context <ruta>]... --conductor <claude|codex>
```

- **Los insumos van con su rol**, y cada tipo exige los suyos:
  - una spec: `--request <pedido>`;
  - un plan: `--spec <spec>`;
  - unas tasks: `--spec <spec> --plan <plan>`.
- **El pedido de una spec se escribe a un archivo** con el pedido original de la persona y las
  decisiones que lo modificaron después (por ejemplo, las respuestas de clarify). Nunca con un
  resumen de la spec: el eje SPEC compara la spec contra el pedido, y un pedido copiado de la spec
  la aprueba sola. **Muéstrale ese archivo al usuario en el gate**, para que compruebe que es fiel.
- **Código:** el revisor no lee el repo. Si el plan o las tasks afirman algo del código ("`resolve`
  está en `src/cli.ts:283`"), pasa esas fuentes con `--context`. Lo que no viaje, o viaje incompleto,
  el revisor lo declara en `unverifiable`.
- Con una ronda en marcha no cambies los insumos ni el contexto: si cambian, `review round` no se
  lanza y `next` pide un `review start` nuevo.

### Lo que trae la respuesta

- **`informative`**: defectos de un insumo o de un contexto, no del artefacto. No cuentan para el
  veredicto ni se deciden con `review decide`: muéstraselos al usuario, que decide si reabre ese
  documento.
- **`unverifiable`**: lo que el revisor no pudo comprobar con el material, de la última ronda. No
  cuenta para el veredicto. Suma el código que falta y revisa de nuevo, o declara esas afirmaciones en
  el gate.
- La ronda siguiente es dirigida, como en un diff. Además admite las regresiones que causó la
  corrección en cualquier línea del artefacto, cada una con su `cause` (`+N` o `-N`).
- **El gate es del usuario.** El veredicto informa y no aprueba nada: presenta el artefacto con el
  resultado de la revisión y espera su aprobación.

## 6. Si algo falla

- **`launch_failed`**: muestra `reason` y `detail` al usuario y **pregúntale** si quiere caer a tu
  familia, tu modelo y tu esfuerzo (`fallback`). Solo con un sí, corre el comando exacto que trae
  `next` (reutiliza el encargo, el rol y el plazo con `--retry`, y fija `--families`, `--model` y
  `--effort`). Nunca cambies de familia sin preguntar.
- **`session_unknown`**: una corrida nativa necesita el id de tu sesión (`CLAUDE_CODE_SESSION_ID` en
  Claude Code, `CODEX_SESSION_ID` en Codex), porque sin él ningún hook la dejaría lanzar. Díselo al
  usuario.
- **Rol `implement`**: da un error de uso porque todavía no hay un worker que escriba. Díselo al
  usuario y no lo cambies por otro rol sin preguntarle.
- **Rol `pr`**: ahora se llama `code-review`. El error de migración vale para `--role pr` y para una
  clave `pr:` en `.sdd-ai/workers.yml`; no edites la config sin permiso.
- **`agents_stale`**: los agentes generados están desactualizados. Propón
  `./bin/sdd-ai agents sync` (en Codex, con escalamiento: escribe en `.codex/`) y reabrir la sesión.
- **`config_missing`**: muestra el bloque que trae `next` y pregunta si lo creas. No escribas la
  config sin permiso.
- Para cortar una corrida: `./bin/sdd-ai cancel <id>`. En una revisión detiene el trabajo en curso y
  no lanza los que faltan. En una nativa sin lanzar o con una reserva sin confirmar, solo la marca
  como cancelada: no detiene a un agente que quizá llegó a arrancar.
- **Codex no corre los hooks del proyecto**: si al abrir avisa "Hooks need review", o los hooks no
  responden, pídele al usuario que los apruebe en `/hooks`. Hace falta la primera vez y cada vez que
  cambian las definiciones de `.codex/hooks.json`.
- **Límites declarados de `review`**: si el supervisor muere en medio de una ronda, no deja su
  registro y el relanzamiento corre todos los trabajos, no solo los que faltaban. Las sesiones del
  revisor Claude dejan un directorio de proyecto en `~/.claude/projects/`: el binario solo borra su
  temporal del sistema.

Después de cada `./bin/sdd-ai agents sync` hay que reabrir la sesión para que el CLI cargue los
agentes y esta skill.

## 7. Los hooks

`.claude/settings.json` y `.codex/hooks.json` instalan hooks que hacen cumplir esta skill. Todos
llaman al lanzador `bin/sdd-ai-hook`, que corre `./bin/sdd-ai hook <claude|codex>`, y callan en un
repositorio sin `.sdd-ai/` o ante cualquier error. La excepción es un despacho `sdd-ai-*` que no se
puede comprobar: ese se niega.

- **`SessionStart`**: al retomar o compactar, te devuelve las corridas abiertas de tu sesión, cada
  una con lo que sigue. Al abrir o limpiar, lista en una línea las abiertas de otras sesiones, solo
  como dato.
- **`Stop`**: si terminas el turno con corridas propias abiertas, lo reabre una vez con qué corrida,
  en qué estado y qué sigue. Una corrida está abierta si:
  - un worker o una revisión siguen corriendo;
  - terminaron y nadie te devolvió su estado (`wait`, `review status` o el propio `run`);
  - es una nativa sin lanzar o con una reserva sin confirmar;
  - es una revisión con hallazgos sin decidir.
  Vuelve a recordar solo si ese conjunto cambia.
- **`PreToolUse` sobre `Agent` y `spawn_agent`** (también la v2 de Codex): deja pasar un `sdd-ai-*`
  solo si corresponde a una nativa sin lanzar ni reservar de tu sesión, de ese rol y de tu CLI.
  Reserva la corrida y reescribe el input (§3); en la v2 de Codex, todo menos el mensaje cifrado.
  Desde un subagente, lo niega. Los agentes que no son `sdd-ai-*` no se tocan.
- **`PostToolUse`**, y en Claude Code también **`PostToolUseFailure`**: confirman o liberan la
  reserva del despacho.
- **`PreToolUse` sobre `Bash`**: dentro de un subagente, niega `sdd-ai run`, `review`, `wait` y
  `cancel`. Un worker no delega ni toca las corridas del conductor.

Claude Code carga los hooks del repositorio sin pedir nada. Codex los ejecuta solo después de que el
usuario los aprueba en `/hooks`, y vuelve a pedirlo cada vez que cambian sus definiciones.

**Ante una negación, sigue el motivo**: dice qué correr, qué citar o que le preguntes al usuario. No
busques un rodeo, como otro agente, otro nombre o lanzar el CLI a mano.

