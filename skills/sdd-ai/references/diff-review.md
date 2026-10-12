<!-- Origen: SKILL.md:347–535. Traslado de la base a70c7da. -->

Apoyos: [aprobaciones](../procedures/approvals.md), antes de presentar preguntas canónicas o registrar decisiones; [reception](reception.md); [findings](findings.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

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

- La revisión final de un flujo SDD lleva `--flow <id>`, con `--untracked` o `--harvest`, sin
  `--head` ni `--artifact`, y con la base del plan. Así `sdd status` y `sdd commit` la reconocen.

Antes de crear la corrida de ese diff y lanzar al revisor, su id queda citado en `reviews` de
`sdd-ai-phases.json`. Las citas se acumulan sin borrar fases, writer, verify ni commit y permanecen
durante rondas y recepción. El lock vivo del flujo se espera; uno huérfano niega con `flow_busy`.
Un registro inválido (`phases_invalid`), un flujo ausente en este checkout (`flow_not_found`), una
ruta inválida (`path_invalid`), una base distinta o un fallo de escritura impiden crear y lanzar
la corrida. Un fallo posterior deja la cita. Citar no concede validez ni gates: siguen mandando
la convergencia, la base y el respaldo del candidato. No hay protección retroactiva automática
para revisiones anteriores ni al continuarlas. `--artifact --flow` también se admite: exige el
handoff local, no plan ni base, transporta la asociación y nunca cita una revisión final.

### Nivel de riesgo y revisores

`review start` clasifica el candidato en `normal` o `high` y lo congela en la corrida. La respuesta
trae `risk`: el nivel, los motivos (cada uno con la señal y la ruta que la disparó) y `forced`, que
dice si el nivel se subió a mano. Es `high` si el candidato tiene una ruta con un segmento `auth`,
`security`, `update`, `webhook` o `payments`, un script de shell agregado o cambiado, un archivo
que pasa a ejecutable, o una línea agregada que lanza procesos (`exec(`, `spawn`, `child_process`,
un shebang…). El tamaño del diff no cuenta. En las rondas siguientes, la señal de procesos cuenta solo
los identificadores nuevos de cada bloque reemplazado: editar una línea que ya los tenía no la dispara.

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

Antes de aceptar una corrección, contrástala con el pedido o los AC aprobados: lo que el pedido o un
AC no sostiene no es exigencia. Las decisiones ya aprobadas en el plan y las tasks siguen siendo vinculantes.

- `accept` y corrige los hallazgos sustentados por el pedido o un AC y los defectos o riesgos
  concretos que introduce el propio cambio, dentro del alcance autorizado.
- `reject` las ampliaciones y las decisiones que ni el pedido ni los AC sostienen: «falta decidir»
  no equivale a «falta exigir». Usa el motivo literal «fuera de lo pedido» y explica qué pedido o AC
  no sostiene esa exigencia, de forma comprobable contra esos insumos.
- `reject` si no lo vas a corregir, con un motivo que el revisor pueda verificar en el código
  ("la línea 12 ya valida el caso vacío") o en el pedido y los AC aprobados, no una opinión.
  El revisor va a responder ese motivo.
- Solo si propones incorporar una ampliación como conductor, consulta a Max ofreciendo excluirla
  o diferirla y espera su respuesta antes de incorporarla.
- Un defecto o riesgo sustentado fuera de alcance que no impide cumplir un AC se rechaza en el ledger
  con «fuera de lo pedido» y se registra en el registro transversal. Si impide cumplir un AC, conserva
  su tratamiento bloqueante: registra el hallazgo, declara el AC afectado, detén su avance y pide una
  decisión humana de alcance o continuidad. Registrar o aceptar un hallazgo no autoriza ampliar el
  alcance ni sustituye los gates humanos de spec y plan-tasks.
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
- La ronda siguiente es una pasada de la base, en lotes si el material no entra, con cada pendiente
  en el lote de su archivo. En una revisión con lentes, un delta de riesgo alto corre además las
  cuatro lentes sobre lo que cambió: conserva el ledger y las respuestas a los pendientes, y la salida
  trae `reviewers` y `delta_risk`. Sin señal alta nueva, corre solo la base.
- **`risk_high`**: en una revisión sin lentes, la corrección trajo riesgo alto (`detail` nombra la
  señal y la ruta), así que la ronda no corre: nada nuevo de riesgo alto queda aprobado sin las
  lentes. Pregúntale al usuario si reinicia la revisión con lentes; si dice que sí, corre el
  `review start … --risk high` que trae `next`.
- **Relanzar una ronda que no terminó**, también la 1: `review round <id>`, como diga `next`. Corre
  solo los trabajos que faltan; lo ya admitido se conserva mientras su encargo sea el mismo. Si el
  candidato cambió, corre todos, y en una revisión sin lentes antes se frena con `risk_high` si el
  cambio trajo riesgo alto. Con lentes no se frena: en la ronda 1 corre la base y las lentes sobre el
  candidato vigente; en una ronda posterior corre la base y suma las lentes solo si el delta trae
  riesgo alto, sobre CAMBIOS.

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
nada (cómo se pregunta en cada runner, en [aprobaciones](../procedures/approvals.md)).

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
- **La proyección de `sdd verify`**: si el único cambio del contexto es lo que `sdd verify` escribió en
  el plan (solo `## Verify` y el `status` del header, respaldados por un recibo), la revisión no queda
  en `stale` y la vista trae `verify_projection` con el plan y el recibo. Cualquier otro cambio, de
  código o de contexto, sí la vence.
- El recibo informa: no autoriza el commit ni el push. Un eje en `fail` se resuelve o se declara,
  como en cualquier revisión.

