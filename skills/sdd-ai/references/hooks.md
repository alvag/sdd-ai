<!-- Origen: SKILL.md:716–872. Traslado de la base a70c7da. -->

Apoyos: [mod](mod.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## 8. Los hooks

`.claude/settings.json` y `.codex/hooks.json` instalan hooks que hacen cumplir esta skill. Todos
llaman al lanzador `bin/sdd-ai-hook`, que corre `./bin/sdd-ai hook <claude|codex>`, y callan en un
repositorio sin `.sdd-ai/` o ante cualquier error. Las excepciones son un despacho `sdd-ai-*` que no
se puede comprobar, que se niega, y un `git commit` que no se puede comprobar, que se niega según las
reglas de la guarda del commit (abajo).

- **`SessionStart`**: al retomar o compactar, te devuelve las corridas abiertas de tu sesión, cada
  una con lo que sigue. Al abrir o limpiar, lista en una línea las abiertas de otras sesiones, solo
  como dato. En los cuatro casos suma una línea por flujo SDD activo de `.plans/`, con su
  profundidad y su paso siguiente y, en una fase, su comando o por qué no lo hay ([fases documentales](document-phases.md)). Marca el flujo ligado a tu sesión ([aprobaciones](../procedures/approvals.md)) y muestra un flujo ilegible
  con su motivo. Un directorio sin artefactos no es un flujo y no sale.
- **`Stop`**: con la señal Claude vigente y operativa permanece silencioso sin consumir recordatorios.
  Sin esa cobertura, si terminas el turno con corridas propias abiertas, lo reabre una vez con qué corrida,
  en qué estado y qué sigue. Una corrida está abierta si:
  - un worker o una revisión siguen corriendo;
  - terminaron y nadie te devolvió su estado (`wait`, `review status` o el propio `run`);
  - es una nativa sin lanzar o con una reserva sin confirmar;
  - es una revisión con hallazgos sin decidir.
  Vuelve a recordar solo si ese conjunto cambia. Con la sesión ligada a un flujo ([aprobaciones](../procedures/approvals.md)), recuerda además
  su paso siguiente, una vez por cambio de paso o de gate; otra task del mismo paso no cuenta. Si los
  dos recordatorios coinciden, salen juntos. En Codex, cada uno reabre el turno una sola vez.
- **`PreToolUse` sobre `Agent` y `spawn_agent`** (también la v2 de Codex): deja pasar un `sdd-ai-*`
  solo si corresponde a una nativa sin lanzar ni reservar de tu sesión, de ese rol y de tu CLI.
  Reserva la corrida y reescribe el input ([recepción](reception.md)); en la v2 de Codex, todo menos el mensaje cifrado.
  Desde un subagente, lo niega. Los agentes que no son `sdd-ai-*` no se tocan.
  Si la única corrida de ese agente tiene una reserva sin confirmar, la negación la nombra y remite a
  preguntarle al usuario si reintenta o la descarta: `cancel` solo cambia el registro local, y
  reintentar puede lanzar otro agente si el primero llegó a arrancar.
- **`PostToolUse`**, sobre todas las herramientas: confirma la reserva de un despacho, liga tu sesión
  cuando un `Bash` tuyo corre `sdd start <id> --apply`, `sdd branch <id> --apply`, `sdd status <id>`, `sdd approve <id> <gate>` o `sdd phase <id>` ([aprobaciones](../procedures/approvals.md)) y cuenta la
  herramienta para el recordatorio de sesión larga. En Claude Code, **`PostToolUseFailure`** libera la
  reserva de un despacho que falló y liga igual cuando el comando del `Bash` sale con un código
  distinto de cero: en Claude Code, ese comando llega por este evento.
- **`PreToolUse` sobre `Bash`**: en cualquier sesión, aplica la guarda del commit (abajo). Dentro de un
  subagente, además, niega `sdd-ai run`, `review`, `wait`, `cancel`, `prune`, `recall`, `sdd start`, `sdd branch`, `sdd approve` y `sdd phase`. Un
  worker no delega, no toca las corridas del conductor, no arranca flujos, no aprueba gates ni lanza fases.

Claude Code carga los hooks del repositorio sin pedir nada. Codex los ejecuta solo después de que el
usuario los aprueba en `/hooks`, y vuelve a pedirlo cada vez que cambian sus definiciones.

### La guarda del commit

El camino normal es `sdd commit`; el commit a mano sigue disponible desde `review_and_commit`.

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
    `implement`, `verify` y `review_and_commit` pasan a `external_gate` ([aprobaciones](../procedures/approvals.md)).
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
  a cero. Nunca bloquea una herramienta. Con la sesión ligada a un flujo SDD ([aprobaciones](../procedures/approvals.md)), el recordatorio se
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

