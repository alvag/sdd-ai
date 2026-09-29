---
name: sdd-ai
description: Delega una tarea de solo lectura (explorar, buscar, resumir código) o una escritura acotada a un worker de Claude o Codex elegido por la config del repo, o revisa un diff congelado con un revisor aislado. Usar cuando el usuario pide "delega esto a un worker", "usa sdd-ai", "que otro agente explore esto" o "revisa este diff".
---

# sdd-ai: despachar un worker

El binario decide qué familia hace el trabajo y por qué vía. Tú escribes el encargo, sigues lo que
responde y le preguntas al usuario ante cualquier fallo. Todo comando imprime un JSON.

## 1. Escribe el encargo

Escribe el encargo en un archivo temporal fuera del repositorio. El worker no ve esta conversación:
el encargo tiene que ser autosuficiente (qué hacer, dónde mirar, qué formato de respuesta).

## 2. Pide el despacho

```
./bin/sdd-ai run --prompt-file <archivo> --conductor <claude|codex> --conductor-model <tu modelo>
```

- `--conductor` es tu propia familia: `claude` si eres Claude Code, `codex` si eres Codex.
- Si conoces tu esfuerzo de razonamiento, agrégalo con `--conductor-effort <valor>`. Codex no lo
  expone al shell, así que sin el flag una caída a tu familia no puede conservarlo.
- Agrega `--role <rol>` cuando la tarea tiene un rol claro: `code-review` para revisar código,
  `refute` para refutar, `investigate` para una causa raíz, `design-review`, `debate` o
  `counter-plan`, e `implement` para delegar una escritura (sección 6). Sin el flag, el rol es
  `explore`.
  `explore` e `investigate` pueden buscar en la web; los demás roles trabajan solo con el encargo y
  el repositorio.
- Agrega `--families claude` o `--families codex` solo si el usuario dijo "solo Claude" o
  "solo Codex" para esta tarea.
- **Si eres Codex** y la respuesta va a salir por la vía `process`, ejecuta `run` pidiendo
  escalamiento (fuera del sandbox): el worker necesita red. Si no sabes la vía de antemano, pide
  escalamiento siempre.

## 3. Sigue la respuesta

Cuando `run` devuelve un `id`, ya copió el encargo a la corrida: borra el temporal. Si `run` falla
antes, consérvalo para reintentar.

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

Estas dos decisiones se preguntan con la **pregunta canónica** que trae la vista en `questions`, y se
registran después de la respuesta. El comando lee esa respuesta en la sesión y sin ella no escribe
nada (cómo se pregunta en cada runner, en la sección 9).

- **`en-disputa`** (los de `disputes`): el revisor mantuvo un hallazgo que rechazaste. Tú fuiste parte
  de esa discusión, así que no la decides. Muéstrale al usuario la evidencia del revisor y hazle la
  pregunta de esa disputa: sus opciones traen lo que afirma el hallazgo y tu último motivo. Registra
  lo que responda con `review decide`: `accept` si eligió `Aceptar el hallazgo`, y `reject`, sin
  `--reason` o con el motivo que mostró la pregunta, si eligió `Mantener el rechazo`. Cada disputa
  necesita su respuesta, y redecidirla necesita otra.
- **El tope**: una revisión tiene hasta 3 rondas. Si se terminó la tercera y quedan hallazgos
  vigentes, hazle al usuario la pregunta de la ronda siguiente: si elige `Lanzar la ronda <n>`, corre
  `review round <id> --extra`, que concede solo esa ronda. Relanzar esa misma ronda reusa su
  respuesta, salvo lo que diga `next`.

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

## 6. Delegar una escritura

`./bin/sdd-ai run --role implement --prompt-file <encargo>` lanza un writer por proceso: un worker de
la otra familia que escribe en tu árbol de trabajo, sin commitear. Cuándo usarlo lo dice el bootstrap
con sus umbrales; esta sección dice cómo.

- **Antes de lanzarlo.** Si el usuario no te dio permiso para cambiar el proyecto, pregúntale, como
  harías antes de escribir inline. No delegues un cambio en `.git`, `.sdd-ai/`, `.claude/`, `.codex/`,
  `.agents/` o en archivos que Git ignora: eso va inline o se propone SDD. El árbol tiene que estar
  limpio y en un commit: con cambios sin commitear, `run` los nombra y el `next` te dice que le
  preguntes al usuario si los conserva o los revierte; si los conserva, sigues inline hasta que él
  deje el árbol limpio. sdd-ai nunca hace stash, commit ni revert.
- **El encargo** trae el objetivo, los archivos que se tocan y cómo se comprueba que quedó bien. No
  hace falta ninguna estructura: el binario lo envuelve en un contrato fijo que le prohíbe commitear,
  tocar esas rutas, correr pruebas o comandos, y le pide declarar lo que se desvió y cerrar con
  `STATUS: done`.
- **Mientras corre, no edites el árbol.** Espera con `./bin/sdd-ai wait <id>`. Hay un writer por
  repositorio: otro `run --role implement`, desde cualquier sesión o worktree, se rechaza nombrando
  el que está abierto.
- **Lo que trae `wait`**: la base, cada archivo con su estado, sus líneas y sus modos (los nuevos
  incluidos), la ruta a `diff.patch`, el reporte del writer, si cerró con la marca, las rutas señaladas
  (`flagged`: cambios en el directorio de Git, `.sdd-ai/`, `.claude/`, `.codex/` o `.agents/`), la
  corrida alterada (`run_altered`: archivos de `.sdd-ai/runs/<id>/` que el writer tocó) y si `HEAD` se
  movió. El cambio sale del árbol real contra la base, no del reporte.
- **Antes de aceptar el cambio, en este orden:**
  1. Mira primero `flagged`, `run_altered` y `failed`. Si hay algo, díselo al usuario antes de seguir.
  2. Lee el diff completo.
  3. Lanza el `review start` que trae `next` antes de correr nada que pueda cambiar el árbol. Revisa
     el mismo contenido que la cosecha, archivos nuevos incluidos, y se niega si el árbol ya no es el de
     la cosecha.
  4. Corre los checks focalizados y después los completos.
  5. Espera el resultado de la revisión y resuelve sus hallazgos (sección 4).
  6. Comprueba que el árbol sigue siendo el de la cosecha, o el que revisaste después. Si un check o
     tu corrección lo cambió, esa revisión ya no vale para lo que hay: díselo al usuario y, si siguen,
     revisa el árbol actual con `review start --base <base> --author <familia del writer> --untracked`,
     que suma los archivos nuevos. Si también editaste tú, di que la autoría quedó mezclada.
- **No aceptes con un check en rojo**, salvo que el usuario decida explícitamente sobre cada fallo.
- **La revisión tiene que ser de otra familia que el writer.** Si no puede, por ejemplo después de una
  caída de familia, díselo al usuario y sigue lo que decida: nunca revises con la misma familia sin su
  sí. La caída de familia de un writer también se pregunta antes de correrla.
- **Un diff parcial o que no quedó bien**, o un `wait` que termina en fallo, plazo vencido o
  cancelación: el `next` te dice que le preguntes al usuario si conserva el cambio o lo revierte.
  Después puedes corregir a mano lo chico, relanzar con un encargo mejor (`--retry` relanza el encargo
  original) o proponer SDD. Si no quedó ningún cambio, no hay nada que conservar: ofrece relanzar.
- **`control_unavailable`**: el binario no pudo escribir su almacén de control, que vive en el
  directorio de Git. Pasa cuando lo corres dentro del sandbox de Codex: vuelve a correr el mismo
  comando pidiendo salir del sandbox. Esa escalada la aprueba el usuario o el auto-review; si no se
  aprueba, escribe inline.
- **Cese incierto** (`cessation_uncertain`): el supervisor del writer desapareció y no se puede
  confirmar que el writer dejó de escribir. **Detente y pregúntale al usuario sin tocar el árbol.**
  Con su sí, `./bin/sdd-ai cancel <id>` detiene el grupo del writer si puede acreditar que es el suyo,
  y congela la cosecha. Si no lo acredita, no envía ninguna señal y el `next` trae
  `cancel <id> --writer-gone`: córrelo solo después de que el usuario confirme que el writer ya no
  corre, porque congela y libera la reserva sin señalar a nadie.
- **Límites de esta fase:**
  - el writer solo sale por proceso: no hay writer nativo;
  - no hay ciclo de corrección automático;
  - el worker Codex por proceso sigue leyendo el `AGENTS.md` del repo y el global del usuario;
  - el writer Codex conserva su shell para leer, y puede escribir en `$TMPDIR` y `/tmp`;
  - la cosecha no ve archivos ignorados fuera de las rutas señaladas;
  - una sesión abierta antes de este cambio recibe el bootstrap nuevo recién al limpiar, compactar o
    retomar.

## 7. Si algo falla

- **`launch_failed`**: muestra `reason` y `detail` al usuario y **pregúntale** si quiere caer a tu
  familia, tu modelo y tu esfuerzo (`fallback`). Solo con un sí, corre el comando exacto que trae
  `next` (reutiliza el encargo, el rol y el plazo con `--retry`, y fija `--families`, `--model` y
  `--effort`). Nunca cambies de familia sin preguntar.
- **`launch_failed` con `supervisor_not_started`**: el sistema no lanzó el proceso que supervisa la
  corrida, y el comando que la lanzó ya falló con ese error. No es cosa de la familia, así que no
  propongas caer a la tuya: díselo al usuario y **pregúntale** si la relanza. Solo con un sí, una
  revisión se relanza con el `next` de `./bin/sdd-ai review status <id>` y una corrida de `run`
  con `./bin/sdd-ai run --retry <id>`.
- **`session_unknown`**: una corrida nativa necesita el id de tu sesión (`CLAUDE_CODE_SESSION_ID` en
  Claude Code, `CODEX_SESSION_ID` en Codex), porque sin él ningún hook la dejaría lanzar. Díselo al
  usuario.
- **Rol `implement`**: los errores del writer (`control_unavailable`, `writer_open`, `no_head`,
  `tree_dirty`) y el cese incierto están en la sección 6.
- **Rol `pr`**: ahora se llama `code-review`. El error de migración vale para `--role pr` y para una
  clave `pr:` en `.sdd-ai/workers.yml`; no edites la config sin permiso.
- **`agents_stale`**: los agentes generados están desactualizados. Propón
  `./bin/sdd-ai agents sync` (en Codex, con escalamiento: escribe en `.codex/`) y reabrir la sesión.
- **`doctor` con la skill `stale` o `missing`**: una copia de esta skill (`.claude/skills/` o
  `.agents/skills/`) no coincide con su fuente, o falta, y el CLI está leyendo otra versión. Se
  corrige igual: `./bin/sdd-ai agents sync` y reabrir la sesión.
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

## 8. Los hooks

`.claude/settings.json` y `.codex/hooks.json` instalan hooks que hacen cumplir esta skill. Todos
llaman al lanzador `bin/sdd-ai-hook`, que corre `./bin/sdd-ai hook <claude|codex>`, y callan en un
repositorio sin `.sdd-ai/` o ante cualquier error. Las excepciones son un despacho `sdd-ai-*` que no
se puede comprobar, que se niega, y un `git commit` que no se puede comprobar, que se niega según las
reglas de la guarda del commit (abajo).

- **`SessionStart`**: al retomar o compactar, te devuelve las corridas abiertas de tu sesión, cada
  una con lo que sigue. Al abrir o limpiar, lista en una línea las abiertas de otras sesiones, solo
  como dato. En los cuatro casos suma una línea por flujo SDD activo de `.plans/`, con su
  profundidad y su paso siguiente. Marca el flujo ligado a tu sesión (§9) y muestra un flujo ilegible
  con su motivo. Un directorio sin artefactos no es un flujo y no sale.
- **`Stop`**: si terminas el turno con corridas propias abiertas, lo reabre una vez con qué corrida,
  en qué estado y qué sigue. Una corrida está abierta si:
  - un worker o una revisión siguen corriendo;
  - terminaron y nadie te devolvió su estado (`wait`, `review status` o el propio `run`);
  - es una nativa sin lanzar o con una reserva sin confirmar;
  - es una revisión con hallazgos sin decidir.
  Vuelve a recordar solo si ese conjunto cambia. Con la sesión ligada a un flujo (§9), recuerda además
  su paso siguiente, una vez por cambio de paso o de gate; otra task del mismo paso no cuenta. Si los
  dos recordatorios coinciden, salen juntos. En Codex, cada uno reabre el turno una sola vez.
- **`PreToolUse` sobre `Agent` y `spawn_agent`** (también la v2 de Codex): deja pasar un `sdd-ai-*`
  solo si corresponde a una nativa sin lanzar ni reservar de tu sesión, de ese rol y de tu CLI.
  Reserva la corrida y reescribe el input (§3); en la v2 de Codex, todo menos el mensaje cifrado.
  Desde un subagente, lo niega. Los agentes que no son `sdd-ai-*` no se tocan.
  Si la única corrida de ese agente tiene una reserva sin confirmar, la negación la nombra y remite a
  preguntarle al usuario si reintenta o la descarta: `cancel` solo cambia el registro local, y
  reintentar puede lanzar otro agente si el primero llegó a arrancar.
- **`PostToolUse`**, sobre todas las herramientas: confirma la reserva de un despacho, liga tu sesión
  cuando un `Bash` tuyo corre `sdd status <id>` o `sdd approve <id> <gate>` (§9) y cuenta la
  herramienta para el recordatorio de sesión larga. En Claude Code, **`PostToolUseFailure`** libera la
  reserva de un despacho que falló y liga igual cuando el comando del `Bash` sale con un código
  distinto de cero: en Claude Code, ese comando llega por este evento.
- **`PreToolUse` sobre `Bash`**: en cualquier sesión, aplica la guarda del commit (abajo). Dentro de un
  subagente, además, niega `sdd-ai run`, `review`, `wait`, `cancel` y `sdd approve`. Un worker no
  delega, no toca las corridas del conductor ni aprueba gates.

Claude Code carga los hooks del repositorio sin pedir nada. Codex los ejecuta solo después de que el
usuario los aprueba en `/hooks`, y vuelve a pedirlo cada vez que cambian sus definiciones.

### La guarda del commit

- **Con tu sesión ligada a un flujo**, un `git commit` a este repositorio se niega mientras el paso
  siguiente del flujo esté antes de `review_and_commit`. Vale tanto para uno tuyo como para uno de un
  subagente de tu sesión. Desde ahí pasa: `review_and_commit`, `push`, `open_pr` y `archive`. El
  motivo nombra el flujo y su paso.
- **Qué cuenta como commit.** Cuenta con opciones globales antes del subcomando (`git -C <dir>
  commit`, `git -c k=v commit`), con asignaciones o dentro de una subcapa, y en cualquier tramo de la
  cadena, también después de un `&`. No cuentan `git log --grep commit`, `echo "git commit"` ni `git
  commit-tree`.
- **El destino se compara por su raíz Git.** Un commit a otro repositorio, también a uno anidado,
  pasa. El destino es:
  - la ruta de un `-C` absoluto;
  - si no hay, desconocido cuando un tramo anterior hace `cd` o `pushd`;
  - si tampoco, el directorio del comando con los `-C` relativos.

  Un `-C` que no es una ruta literal, `--git-dir` o `--work-tree` también lo vuelven desconocido. Con
  liga, un destino desconocido se niega.
- **Una cadena que liga y hace commit se niega en cualquier sesión**: corre `sdd status` o `sdd
  approve` y el commit por separado.
- **Si no se puede leer el estado, se niega.** Con liga, el commit se niega si no se puede leer el
  estado del flujo o el de tu sesión, o si el binario del hook falla o vence. El motivo pide que el
  commit lo haga el usuario o que se arregle el flujo.
- **Sin liga**, la guarda solo mira la regla de Jira (abajo): con `jira_approval` en `on`, o con un
  valor inválido, se niega un commit a este repositorio o de destino desconocido. Con `off`, pasa, y un
  error nunca niega.
- **El commit bloqueado lo hace el usuario.** Tú no tienes cómo saltear la guarda. El usuario
  commitea desde su terminal, o con la vía para comandos del usuario de su runner, que no pasa por los
  hooks:
  - en Claude Code, `!git commit …` desde el prompt;
  - en Codex, `!git commit …` desde el prompt del TUI, en modo shell.

  La sonda de la fase 5c lo comprobó en Claude Code 2.1.284 y Codex 0.158.0.
- **Límites declarados:**
  - no ve un commit dentro de una variable, un alias, un script, `$(…)`, `sh -c` o `eval`;
  - no mira `merge`, `cherry-pick`, `revert`, `rebase` ni `am`;
  - los workers por proceso corren sin hooks, así que sus commits quedan fuera;
  - un `cd` previo niega de más: `cd /otro-repo && git commit` se niega con liga aunque vaya a otro
    repositorio;
  - el commit WIP del sub-paso `pause` de `sdd-flow` se niega en `implementing`, así que ese commit
    también lo hace el usuario.

### La regla de Jira

- **Dónde se configura.** `jira_approval.mode` va en `.sdd-ai/config.yml`, con la forma del bloque de
  `sdd-flow` (`"on"` u `"off"`, entre comillas). `overrides.jira_approval` del handoff de un flujo la
  pisa para ese flujo. Sin archivo, sin bloque o sin `mode`, vale `off`.
- **Con `on`, todo cambio del proyecto va por un flujo SDD**, aunque sea `corta`. La spec se publica
  en Jira con dos partes: un resumen para el PO, en lenguaje no técnico, y la definición técnica.
- **Qué cambia con `on`:**
  - el bootstrap lo dice y no ofrece escribir inline ni delegar la escritura; el trabajo de solo
    lectura sigue igual;
  - el recordatorio de sesión larga, al cruzar el umbral de ediciones, dice que todo cambio va por un
    flujo SDD y no propone el writer; el de lecturas y llamadas no cambia;
  - sin liga, la guarda niega el commit;
  - en el estado del flujo, sin `gate_status: approved` en el handoff (también si falta),
    `implement`, `verify` y `review_and_commit` pasan a `external_gate` (§9).
- **Un valor inválido no cuenta como apagado.** `sdd status` lo informa como `jira_approval_invalid`,
  la guarda niega el commit, y el bootstrap y el recordatorio dicen que rige lo mismo que con `on`.
  Mientras dure, los flujos quedan en `resolve_blockers` y `sdd approve` se traba: corrige la config
  primero.

### La ruta directa

Para el trabajo que no va por SDD, los hooks le dan al conductor una guía y un recordatorio. Los
números salen de una constante del binario: esta skill no los repite y los nombra "los umbrales del
bootstrap".

- **El bootstrap** llega por `SessionStart` al abrir, limpiar, compactar o retomar, antes de la lista
  de corridas. Dice cuándo la exploración y la escritura se delegan y con qué comando, qué no se delega,
  que el tamaño y el riesgo solo proponen SDD, y cómo se cierra. Al retomar sale solo
  si la sesión no lo tenía, porque la conversación retomada conserva el de su arranque. Los subagentes
  nativos no lo reciben, porque no disparan `SessionStart`, y los workers por proceso tampoco, porque
  corren con los hooks apagados.
- **El recordatorio de sesión larga** cuenta las llamadas, lecturas y ediciones del conductor desde el
  último `run` o `review` de su sesión. Cuando alguna llega a su umbral del bootstrap, agrega un
  recordatorio como contexto, con los umbrales que se cruzaron y qué hacer, y los contadores vuelven
  a cero. Nunca bloquea una herramienta. Con la sesión ligada a un flujo SDD (§9), el recordatorio se
  calla: la ruta directa no aplica a quien conduce un flujo. Los contadores vuelven a cero igual, y el
  rastro lo registra. El conteo es aproximado:
  - un `Bash` es una lectura si una de sus tuberías empieza con un comando de lectura (`cat`, `sed -n`,
    `rg`, `grep`, `ls`, `find`, `head`, `tail`, `nl`, `wc`), en los dos CLIs. Decide el primer comando
    de cada tubería: `git diff | head` no es una lectura y `cat a | grep b` sí. Claude Code no tiene
    `Grep` ni `Glob`, y busca por `Bash`;
  - en Claude Code, `Read`, `Grep` y `Glob` son lecturas, y `Edit`, `Write` y `NotebookEdit`,
    ediciones; en Codex, `apply_patch` es una edición;
  - toda edición cuenta, también una mecánica;
  - las herramientas de un subagente (las que llegan con `agent_id`) no cuentan;
  - una llamada fallida no cuenta, salvo un `Bash` de Codex: su hook no recibe el código de salida;
  - la llamada que crea una corrida no cuenta, y un `run` o un `review` de la sesión reinicia los
    contadores.
- **El rastro** de cada sesión queda en `.sdd-ai/hooks/route/<sesión>.jsonl`, con su estado en
  `<sesión>.json`, que también guarda la liga. Registra solo hechos: el inicio (`start`), las corridas
  que ya existían (`existing`), cada recordatorio emitido (`reminder`) o callado por la liga
  (`reminder_suppressed`) y cada corrida nueva de la sesión (`run`). No
  registra si el conductor leyó el recordatorio ni qué ruta siguió: esa ruta la declara el conductor
  al cerrar.

Límites declarados:

- Todo esto actúa solo en un repositorio con `.sdd-ai/`. Habilitarlo en otro repositorio queda para
  la instalación de la fase 6: hoy el runtime (`bin/sdd-ai`, `bin/sdd-ai-hook` y `src/`) y las
  definiciones de los hooks viven en este repositorio, y crear `.sdd-ai/` en otro no alcanza.
- Codex abre a veces sesiones internas que disparan `SessionStart`. La sonda no encontró una señal que
  las distinga de un conductor sin callar a alguno, así que si aparecen, reciben el bootstrap.
- Si Codex tuviera subagentes internos cuyas herramientas llegaran sin `agent_id`, contarían como del
  conductor. La sonda no vio ninguno.
- Cada cambio de `.codex/hooks.json` exige que el usuario vuelva a aprobar los hooks en `/hooks` de
  Codex.

**Ante una negación, sigue el motivo**: dice qué correr, qué citar o que le preguntes al usuario. No
busques un rodeo, como otro agente, otro nombre o lanzar el CLI a mano.

## 9. El estado de un flujo SDD

`sdd status` calcula el estado de un flujo de `.plans/<id>/` desde sus archivos, en solo lectura: su
profundidad, sus gates, sus tasks, el paso siguiente y lo que lo bloquea. `sdd approve` registra la
aprobación de un gate con la huella de sus artefactos y la de los gates anteriores: si después
cambian, `status` devuelve el flujo a ese gate.

```
./bin/sdd-ai sdd status [<id>]
./bin/sdd-ai sdd approve <id> <gate> [--conductor claude|codex]
```

- **Lo que trae `sdd status <id>`**: `depth`, los `gates` de esa profundidad con su `state`
  (`pending`, `approved`, `approved_unfingerprinted` o `stale`), las `tasks` con la primera pendiente,
  `next` con su `step`, y `blocked_reasons` y `notes`, cada una con su `code` y su `detail`. Sale con 0
  aunque el flujo esté bloqueado; con bloqueos, `next` es `resolve_blockers`. Sin id, lista los
  flujos de `.plans/` con su `next`.
- **`status` es el estado del flujo para sdd-ai, y `sdd-flow` sigue leyendo sus headers.** Cuando
  discrepan, `status` lo dice en `notes`: `header_behind` si una aprobación registrada todavía no
  llegó al header, y `header_ahead` si el header da por aprobado un gate cuya aprobación registrada
  venció.
- **`sdd approve` exige la respuesta del usuario a la pregunta canónica del gate**, la que trae
  `next.question` cuando `next.step` es `gate`. La pregunta lleva un código atado a las huellas de ese
  gate y de los anteriores: si un artefacto cambia después de la respuesta, hay que volver a
  preguntar. Registra solo si la última respuesta a esa pregunta es `Aprobar`, y cada respuesta sirve
  una vez. Se corre antes de actualizar el header que pide `sdd-flow`. Los gates son `single` en
  `corta`, `spec` y `plan-tasks` en `normal`, y `spec`, `plan` y `tasks` en `completa`.
- **`sdd-flow` pide el "aprobado" a su manera.** Cuando el usuario aprueba en su gate, hazle además la
  pregunta canónica antes de `sdd approve`: el "aprobado" escrito no es una respuesta a esa pregunta.
- **Cómo se hace la pregunta canónica**, para un gate, una disputa o la ronda extra:
  - **En Claude Code**, con `AskUserQuestion`, pasando el objeto tal cual como su única pregunta, con
    selección simple. No cambies el texto, el header ni las opciones.
  - **En Codex**, con un mensaje cuyo único contenido es la pregunta con sus opciones numeradas, como la
    trae `next` de un rechazo. El contexto va en un mensaje anterior. Después se espera el próximo
    mensaje del usuario: vale la etiqueta de una opción o su número.
- **Cuando el comando rechaza**, el `next` trae la pregunta y cómo hacerla:
  - `runner_required`: el entorno no identifica la sesión de Claude Code ni la de Codex, o el comando
    corre en un worker. La decisión la toma el usuario en la sesión del conductor.
  - `conductor_unknown`: el entorno tiene las dos sesiones, como Codex abierto desde Claude Code. Agrega
    `--conductor claude|codex` con la sesión donde preguntaste.
  - `approval_missing`: no hay respuesta, la última no es una opción, o el archivo de la sesión no se
    pudo leer. Haz la pregunta y vuelve a correr el comando.
  - `approval_contradicted`: la última respuesta no autoriza esa acción, o el `--reason` de un `reject`
    no es el motivo que mostró la disputa. No insistas: la decisión ya está tomada.
  - `approval_reused`: esa respuesta ya registró una decisión. Si el usuario quiere otra, pregúntale de
    nuevo.
  - `review_in_progress`: otro `review decide` o `review round` tiene tomada la revisión. Si no hay
    ninguno corriendo, el `next` dice qué lock borrar.
  - `decision_conflict`: otro comando decidió lo mismo mientras este esperaba. Mira el estado nuevo
    con `status` antes de decidir nada.
- **La prueba frena el atajo del modelo, no la forja.** El transcript, el rollout y los registros son
  archivos que se pueden editar desde el shell. Un subagente no puede correr `sdd approve`: el hook lo
  niega (sección 8).
- **Un gate `approved_unfingerprinted`** es uno que el header da por aprobado sin una aprobación
  registrada ni prueba del runner: un cambio en sus artefactos no se detecta. Regístralo con `sdd
  approve` solo si el usuario responde que lo que hay ahora es lo que aprobó. Una aprobación
  registrada antes de que existiera la prueba sigue contando, con la nota `approval_unproven`.
- **Ante `header_ahead`, el gate vuelve al usuario** antes de seguir con `sdd-flow`, que por su header
  retomaría más adelante de lo que el registro sostiene.
- **`next` no autoriza avanzar sobre un gate externo pendiente.** La nota `external_gate` dice que el
  handoff espera la aprobación externa de la spec, y ahí `next` es `external_gate` en vez de
  `implement`: seguir sin esa aprobación lo decide el usuario. Con `jira_approval` en `on` (§8), vale
  también cuando el handoff no tiene `gate_status`, y alcanza a `verify` y a `review_and_commit`.
- **La liga.** `sdd status <id>` o `sdd approve <id> <gate>`, como primer tramo de un comando tuyo,
  ligan tu sesión a ese flujo, termine como termine el comando. El paso de ese momento queda como
  referencia de `Stop`.
  - Otro id mueve la liga, y el mismo renueva la referencia.
  - Se suelta sola cuando el plan llega a `status: done` o el directorio del flujo ya no está.
  - No ligan un comando en otro tramo (después de un `cd` o de un `&&`), un subagente, un `status` sin
    id, un id inválido ni un flujo sin artefactos.
  - La liga es de tu sesión: otra sesión del mismo repositorio no la ve.
  - Si no se pudo guardar, el hook te lo dice; vuelve a correr el comando.

  **Corre `sdd status <id>` al empezar o retomar un flujo**, y también al seguir en una sesión que se
  abrió antes de actualizar los hooks. Sin liga, `Stop` no recuerda su paso, la guarda del commit no
  lo ve y el recordatorio de sesión larga no se calla (§8).
