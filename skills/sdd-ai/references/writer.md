<!-- Origen: SKILL.md:578–676. Traslado de la base a70c7da. -->

Apoyos: [dispatch](dispatch.md); [reception](reception.md); [diff-review](diff-review.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

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
  hace falta ninguna estructura: el binario lo envuelve en un contrato fijo que le deja leer el
  repositorio, también con el shell, y le prohíbe commitear, tocar esas rutas y ejecutar pruebas, builds
  o comandos que escriban; le pide declarar lo que se desvió y cerrar con `STATUS: done`.
- **Mientras corre, no edites su árbol.** Espera con `./bin/sdd-ai wait <id>` o termina el turno con
  el mod operativo para recibir su aviso ([recepción](reception.md)). La reserva sigue tomada hasta el cese comprobado y la
  cosecha; `cessation_uncertain` no es terminación ni produce aviso terminal. Hay una reserva por
  checkout (`<gitDir>/sdd-ai/checkout.lock`): writer y verify se excluyen allí en ambos sentidos.
  Worktrees distintos admiten writers y verificaciones simultáneos, con controles y recibos locales.
  Antes de trabajar en paralelo, actualiza todos los worktrees con `main`: un binario anterior en
  otro checkout no ve las reservas nuevas. Antes de volver a una rama sin este protocolo, exige que
  no queden `checkout.lock`, `refs.lock` ni writers sin cosechar.
- **Branch y commit.** Crear una ref o cambiar HEAD con branch, y aplicar commit, toman checkout y
  `<commonDir>/sdd-ai/refs.lock` durante toda su aplicación: comprobaciones finales, hooks y registros.
  Se excluyen localmente con writer y verify; las aplicaciones de branch/commit se serializan entre
  checkouts. `refs_busy` informa el titular y pide reintentar al terminar, sin espera automática.
  `--current` y completar solo el handoff no toman estas reservas; conservan gates, lock del flujo,
  writer de fase propio y árbol limpio. Consultar branch y ensayar commit no cambian reservas.
- **Compatibilidad.** El `writer.lock` legacy conserva exclusión global, sin migrarse. Los controles
  y cosechas anteriores siguen legibles: writer se resuelve con wait/cancel y verify con su recuperación
  habitual, solo después del cese de su proceso y del grupo de la fila. La restauración es del propietario.
- **Reservas huérfanas.** Branch y commit no se recuperan automáticamente. Comprueba que terminaron
  el proceso, hooks e hijos antes de borrar manualmente las rutas exactas del diagnóstico. Revisa por
  separado locks de flujo y restauración. Limpiar no deshace refs ni completa el flujo: repite después
  la aplicación para retomar su intención. Un mutex `<lock>.release` abandonado se conserva y produce
  `release_abandoned`: comprueba el cese del liberador antes de retirarlo manualmente. Una liberación
  retenida se reintenta por wait/cancel, recuperación de verify o limpieza manual de branch/commit;
  wait y cancel la informan en el campo `release` de su respuesta.
- **Lo que trae `wait`**: la base, cada archivo con su estado, sus líneas y sus modos (los nuevos
  incluidos), la ruta a `diff.patch`, el reporte del writer, si cerró con la marca, las rutas señaladas
  (`flagged`: cambios en el directorio de Git, `.sdd-ai/`, `.claude/`, `.codex/` o `.agents/`), la
  corrida alterada (`run_altered`: archivos de `.sdd-ai/runs/<id>/` que el writer tocó) y si `HEAD` se
  movió. El cambio sale del árbol real contra la base, no del reporte.
  Los controles nuevos vigilan semánticamente HEAD propio y las ramas congeladas al lanzar (HEAD y
  handoff): cambiar solo la representación suelta/empaquetada no alerta. Se excluyen refs ajenas,
  estado reconocido de otros checkouts, mantenimiento `gc.log`, `gc.pid`, `rr-cache/` y temporales
  Git `*.lock`; config, hooks, las refs de `refs/replace/` (cambian cómo Git resuelve un objeto) y los
  demás archivos no excluidos siguen vigilados. Una lectura de HEAD o de una rama que falla se publica en
  su recurso, con `ref_after: unreadable` y el error. Las diferencias
  describen lo observado sin atribuir autoría: conservarlas o revertirlas requiere decisión humana.
  Los controles legacy conservan su comparación física sin filtrar alertas retrospectivamente.
  La concurrencia no cambia permisos del writer ni gates: branch y commit siguen a cargo del conductor,
  incluido el consentimiento del usuario para commit.
- **Antes de aceptar el cambio de un writer suelto, en este orden** (el de un writer de fase va por
  otro camino: primero `sdd verify` y después la revisión, en [implementación](../procedures/implement.md)):
  1. Mira primero `flagged`, `run_altered` y `failed`. Si hay algo, díselo al usuario antes de seguir.
  2. Lee el diff completo.
  3. Lanza el `review start` que trae `next` antes de correr nada que pueda cambiar el árbol. Revisa
     el mismo contenido que la cosecha, archivos nuevos incluidos, y se niega si el árbol ya no es el de
     la cosecha.
  4. Corre los checks focalizados y después los completos.
  5. Espera el resultado de la revisión y resuelve sus hallazgos ([revisión de diffs](diff-review.md)).
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
  original de un writer suelto; un writer de fase se niega con `phase_writer` y lo sigue `sdd phase`) o
  proponer SDD. Si no quedó ningún cambio, no hay nada que conservar: ofrece relanzar.
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
- **`implement` por fase.** En un flujo SDD en `normal` o `completa`, `sdd phase <id>` en el paso
  `implement` lanza este mismo writer con las tasks pendientes del writer y el contrato de `implement` ([implementación](../procedures/implement.md)).
  Todo lo de esta sección rige igual; `wait` suma el contrato y el paso del flujo.
- **Límites de esta fase:**
  - el writer solo sale por proceso: no hay writer nativo;
  - no hay ciclo de corrección automático;
  - el worker Codex por proceso sigue leyendo el `AGENTS.md` del repo y el global del usuario;
  - el writer Codex conserva su shell para leer, y puede escribir en `$TMPDIR` y `/tmp`;
  - la cosecha no ve archivos ignorados fuera de las rutas señaladas;
  - una sesión abierta antes de este cambio recibe el bootstrap nuevo recién al limpiar, compactar o
    retomar.


La prohibición de escribir durante la reserva incluye los registros del flujo y la sincronización de agentes, skill o mod; espera cese comprobado y cosecha.
