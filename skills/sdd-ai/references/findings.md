<!-- Origen: SKILL.md:13–207. Traslado de la base a70c7da. -->

Apoyos: [writer](writer.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## Registro transversal de hallazgos

El conductor captura inmediatamente, en cualquier fase inline o delegada, los defectos o riesgos
sustentados del producto bajo análisis que estén fuera del alcance aprobado. No espera un recordatorio
ni pide permiso para la captura local. Contrasta contra la spec aprobada; antes de su aprobación declara
la referencia provisional usada y reevalúa la pertinencia al aprobarse el alcance. Los defectos dentro
del alcance, errores del agente al leer otro repositorio y fricciones externas sin evidencia de un
defecto del producto no son hallazgos de este registro. Si el producto es sdd-ai, los defectos de su
skill o runtime sí son elegibles. Registrar no autoriza corregir ni ampliar el alcance.

Si un hallazgo impide cumplir un AC, declara el criterio afectado, detén su avance y pide al usuario
una decisión de alcance o continuidad. No lo dejes solo como pendiente no bloqueante. Solo una decisión
explícita que incorpore el problema al alcance y su resolución permiten `resolved_in_flow`; conserva
ambas evidencias. El triage del proyecto conserva prioridad definitiva, host y conductor: registra
problema y relaciones conocidas sin asignarlos. No migres tickets heredados. Capturar, recibir un
reporte, publicar o completar una tarjeta no aprueba gates: `spec` y `plan-tasks` en profundidad normal
siguen requiriendo respuesta humana.

**Excepción mientras corre un writer ([writer](writer.md)):** no escribas en el árbol, tampoco en `.plans/<id>/`.
Declara en conversación el contenido completo que descubras como «no persistido todavía (writer en
curso)» y regístralo en cuanto recibas la cosecha. Así no se atribuye al writer ni altera su integridad.
Si se corta la sesión antes, esa declaración es la única traza; no afirmes persistencia.

### Registro y entradas

`sdd start --apply` crea `.plans/<id>/hallazgos.md` dentro del conjunto transaccional; el ensayo no
crea archivos. Recibe el mismo tratamiento Git que `handoff.md`, sin ignores nuevos, y no participa en
las huellas que autorizan gates. Para adoptar un flujo antiguo sin registro usa literalmente:

```markdown sdd-ai-findings-template
# Hallazgos — <id>

Registro local de defectos o riesgos sustentados del producto fuera del alcance aprobado.
La captura no autoriza corregir ni ampliar el alcance. Al cierre, el usuario decide la tramitación de cada hallazgo antes de archivar el flujo.
```

Cada entrada nueva comienza `## H-n — <problema>`, numerada en orden de descubrimiento. Usa etiquetas
en español: Momento y fase; Problema; Esperado; Observado; Ubicación; Reproducción/evidencia; Impacto;
Contexto; Fuentes y relaciones; Tramitación. Escribe el momento con fecha y offset cuando lo conozcas.
Incluye rutas relativas, líneas o comandos concretos, commit, runtime, SO y sesión, corrida o paquete
de origen disponibles; lo ausente se declara «desconocido», sin inventarlo. Un lector sin conversación
debe entender el problema y su respaldo. Fuera del flujo identifica la entrada como `<id>/H-n`.

Tramitación empieza con una línea `Estado vigente: pending` y debajo un historial fechado de decisiones
y resultados. Cada cambio actualiza esa línea y agrega una línea al historial, sin borrar historia. Estados: `pending`, `published`, `linked`, `discarded`, `resolved_in_flow`, `uncertain`.
Conserva literalmente los bloques heredados, incluidos los de sdd-flow, y su orden. Reconoce sus H-n,
continúa desde el máximo y agrega evidencia, decisiones y resultados debajo del bloque correspondiente
sin reformatear lo anterior. No exijas retroactivamente los campos nuevos: declara sus faltantes al
preparar publicación.

### Recepción, consolidación y retoma

Consolida cada salida antes de continuar la fase o presentar su gate. Lee primero registro y
`findings-pending/`. Las fases specify, plan, tasks, implement y fix reportan por `findings`; los
rechazos tolerantes llegan por `findings_rejected` y la ausencia en una corrida nueva por
`findings_missing`. Ninguno concede admisión, acredita tasks ni cambia integridad, completitud o filas
de corrección. Los artefactos aprobables no contienen estos reportes. Los controles anteriores no
exigen campos nuevos y las reanudaciones heredan el contrato de origen.

Los cinco roles de run (explore, investigate, counter-plan, debate, design-review) reportan en su
respuesta, incluso siendo de solo lectura. En **todo encargo tuyo que pida JSON a esos roles**, incluye
`findings` en el esquema; el binario anexa su forma e instrucciones compartidas, no agregues claves
informales a un esquema cerrado. Los retries conservan el prompt congelado. Revisores usan el ledger;
refutadores quedan excluidos, pues juzgan un hallazgo existente. Un run sin asociación inequívoca se
presenta al usuario, sin atribuirlo por proximidad: regístralo solo en el flujo que indique.

Compara defecto y ubicación para decidir identidad, distinguiendo problema de recepción. Conserva
corrida, intento e índice; revisión, F-n, ronda, reviewer y batch; o sesión y fase inline disponibles.
Repetir una recepción no crea otra entrada ni duplica evidencia. Un reporte que decides no registrar
(fuera de los criterios de elegibilidad) va a la sección `## Exclusiones` del final del registro, con
origen y motivo en una línea, para no reevaluarlo al retomar. Reformulaciones del mismo problema
agregan fuentes y respaldo nuevos al H-n existente; un defecto distinto recibe otro número. Si la
identidad es dudosa, conserva entradas separadas con su relación declarada para triage. No uses igualdad
literal ni hashes de texto para resolver identidad. Serializa tus ediciones, relee antes de guardar y
usa temporal y reemplazo cuando sea posible. Reconciliación antes de escribir ante cambios concurrentes;
no pises cambios ni sustituyas un registro ilegible por uno vacío.

Evalúa para el registro los `fuera-de-alcance` del diff, los preexistentes no graves que decides no
corregir y los `informativo` de artefacto que describen un defecto del producto. Incorpora solo los
pertinentes conservando claim, ubicación, evidencia y procedencia. Conserva deterministic/inferential,
pero esa clasificación no sustituye reproducción o cita concreta: completa el respaldo disponible.
No mutas el ledger, estados, ejes, decisiones ni veredicto por capturar. Un AC impedido mantiene el
bloqueo aunque la revisión diga informativo o fuera-de-alcance.

Al retomar corre `sdd status`, lee registro y pendientes e informa los H-n existentes al usuario.
Adopta el registro ausente sin reiniciar ni invalidar aprobaciones. Evalúa reviews citadas en
`sdd-ai-phases.json` y revisiones de artefacto explícitamente asociadas por request/candidato al flujo.
Declara resultados inaccesibles; no atribuyas por proximidad ni reconstruyas conversaciones pasadas.
Recibe corridas anteriores o vivas conforme a su contrato, sin fabricar hallazgos retroactivos.

Evalúa también las salidas de recuperación y corrección de admisión aunque la entrega final sea válida:
`wait` no avisa de una corrección, así que lee `.sdd-ai/runs/<corrida>/metrics.json`: trae por intento
`kind` (inicial, reintento de perfil, reanudación, corrección), `suffix`, `admission` y `raw.result` con el
archivo de su respuesta. Evalúa la respuesta de cada intento con `admission` inadmisible, no solo la final;
los nombres cambian según el camino (`result.md`, `result-2.md`, `result-resume.md`, `result-fix.md`); si
`raw.result` es `null`, la respuesta está en `raw.stdout`. Si un intento no tiene archivo legible,
decláralo como inaccesible.
Si la corrida falla o no se admite, sigue referencias a reportes, cosechas e intentos conservados y
recupera solo problemas concretos legibles. No declares la fase admitida ni simules `findings: []`.
Con `findings_missing` o posibles reportes no recuperables, persiste una **incidencia de recepción
pendiente**, con corrida, causa y salidas disponibles, sin fabricar H-n publicables.

Si falla lectura o edición del registro, declara el fallo y guarda reporte saneado, evidencia, origen,
H-n relacionado si se conoce, decisiones y resultados externos en
`findings-pending/<referencia-estable>.md`. No afirmes consolidación. Si tampoco puedes escribir en el
directorio del flujo, entrega el contenido completo en conversación y declara que no quedó persistido;
conserva intacto lo anterior. Al retomar y antes de archive revisa los respaldos, consolida sin duplicar
y marca los incorporados con su H-n sin borrar el respaldo.

### Saneamiento y preservación de evidencia

Worker y conductor omiten antes de reportar, persistir o preparar publicación credenciales, tokens,
datos personales y rutas privadas innecesarias. Usa marcadores de redacción, datos sintéticos y rutas
relativas que mantengan la reproducción; declara las limitaciones del saneamiento. Conserva evidencia
íntegra y saneada en la entrada o `findings-evidence/<referencia-estable>.md`, con referencia al origen
y contenido autosuficiente aunque desaparezca el temporal o corrida. No copies logs, contratos ni
`.sdd-ai/` completos al flujo. Revisa también pendientes y resultados externos antes de archivarlos.
Si un bloque heredado tiene secretos y sanear contradice su conservación literal, declara el conflicto
y pide decisión antes de publicar o archivar ese material.

### Archive: tramitar antes de copiar

Archive es una secuencia del conductor anterior a la copia. Lee registro, pendientes y resultados;
consolida lo legible y reconcilia operaciones inciertas mediante lectura externa antes de otra creación.
Resume `published`, `linked`, `discarded`, `resolved_in_flow`, `uncertain` (el issue puede existir) y
`pending`, incluidos respaldos e incidencias de recepción. Los resueltos dentro del flujo no se proponen
para publicar. Sin hallazgos ni pendientes de recepción declara su ausencia y continúa sin preguntas
ni escrituras externas de hallazgos.

Con registro ilegible detén archive antes de publicar o copiar: entrega solo pendientes legibles y
declara que el resto no pudo leerse, pues no puedes descartar publicaciones previas. Si queda algo por
tramitar, comprueba **antes de preguntar** que contenido preparado y resultados pueden guardarse y
releerse en registro o respaldo del flujo. Si ambos fallan detén y entrega los hallazgos legibles, su
contenido, decisiones y resultados ya creados sin persistir. Registro legible no escribible con respaldo
escribible permite continuar; sin nada por tramitar, la falta de escritura no detiene archive.

Lee las instrucciones del proyecto para destinos propuestos y repositorios de búsqueda de duplicados;
no hay repositorios de destino fijos en esta skill ni en el binario. Consulta posibles duplicados antes
de preguntar y conserva consulta, fecha y coincidencias; ningún resultado es triage definitivo.
Presenta cada `<id>/H-n`, destino, título y cuerpo exactos saneados, faltantes heredados y coincidencias.
Pregunta explícitamente si el usuario confirma publicar allí, vincular una coincidencia, descartar o
cambiar destino. Confirmar archive no autoriza publicar; las instrucciones del proyecto no son permiso
permanente. Cambiar destino o contenido renueva consulta y confirmación. Sin destino declarado pide
que el usuario elija; sin elección o respuesta deja `pending`. Con respuesta parcial tramita solo lo
decidido. Vincular exige confirmación y no modifica el issue existente sin autorización adicional.
Durante el flujo solo adelanta esta secuencia ante petición explícita del usuario, con los mismos controles.

Antes de **cada creación externa**, guarda y relee autorización exacta, destino, contenido, identificación
calificada e intención en registro o respaldo. Esa escritura real comprueba la ruta para conservar el
resultado, también a mitad de la tramitación. Una intención sin resultado se considera `uncertain` al
retomar: exige lectura del destino antes de otra creación. Ejecuta solo lo autorizado con las herramientas
del proyecto. Guarda inmediatamente resultado, número, URL y causa. Solo marca `published` tras leer y
verificar destino y contenido; para `linked` lee y verifica la referencia. Retomar no republica lo verificado.

Si pudo crearse el issue pero resultado o verificación son inciertos, conserva `uncertain`, referencias
conocidas y advertencia de posible existencia. Pide comprobar el destino antes de publicar otra vez;
no lo presentes listo para republicar. Falta de permiso/acceso para consultar o publicar antes de
cualquier creación, contenido rechazado o fallo conocido sin posible creación dejan `pending` con causa
y contenido listo para publicar a mano. Si falta acceso para verificar una creación que pudo ocurrir,
el estado es `uncertain`, no `pending`. Ni `uncertain` ni `pending` bloquean archive por sí solos; sus causas, contenido y referencias
quedan en registro o respaldo y en el resumen archivado.

Si la comprobación previa es negativa o el registro ilegible, en archive detén sin esa publicación ni
copia. Fuera de archive cancela la publicación anticipada, declara causa, deja `pending` y continúa el
flujo. Si el issue ya pudo crearse y no puedes guardar su resultado en registro ni respaldo, detén el
flujo: ninguna otra publicación ni copia. Entrega número, URL, verificación o incertidumbre y cada
hallazgo legible restante con contenido y decisión. Con registro ilegible entrega solo pendientes
legibles y declara el resto desconocido. La comprobación previa no garantiza escritura posterior.
El usuario decide reparación o forma de archivar; guarda el resultado faltante al recuperar escritura,
sin recrear el issue.

Después de tramitar y persistir, presenta el resumen final de todos los estados y pendientes y
guárdalo en la sección `## Cierre` del final del registro (o del respaldo si el registro no se puede
escribir), con fecha. Ahí también queda una preservación pendiente, con su causa. Si archive se
detiene, no escribas `## Cierre`: la entrega va en la conversación. Si no queda nada por tramitar y
no puedes escribir en ningún lugar del flujo, declara en la conversación que el Cierre no quedó
persistido y continúa con el procedimiento nativo siguiente. En proyectos que versionan `.plans/`, la
persistencia de registro, pendientes y evidencia puede dejar cambios posteriores al cierre Git: avisa
antes de congelar el inventario y deja al usuario decidir si los commitea.

1. Ejecuta `sdd archive <id> --prepare`. Copia literalmente solo ledger y verdict de commit.review,
   receipt de commit.receipt y las acreditaciones usadas mediante attestation, con su procedencia en
   evidencia/. No importa stdout/stderr externos ni almacenes o sesiones completos. Sin commit no
   fabrica evidencia de fases. Repetir una preparación compatible no cambia los cuerpos ni procedencia;
   una incompatibilidad detiene sin sobrescribir.
2. Revisa saneamiento de credenciales, tokens, datos personales y rutas privadas innecesarias en todos
   los cuerpos preparados y el material heredado. Evalúa suficiencia y limitaciones. Con revisión
   pendiente, evidencia insuficiente o redacción incompatible con la conservación literal de un cuerpo
   obligatorio, no formules Archivar: presenta a Max la decisión del material fuera del verbo. No
   recalcules hashes ni reescribas referencias o procedencia para acreditar un cuerpo editado. El
   binario verifica integridad y fuentes disponibles; no detecta secretos ni registra esta revisión.
3. Con vault, propón `--summary "<una línea>"` literal, no vacío y legible sin cambios por nodeMetadata.
   Ejecuta el ensayo `sdd archive <id> [--summary "<una línea>"]`: no escribe. Presenta rutas, tamaños,
   SHA-256, directorios vacíos, destino real, cobertura, referencias informativas, impedimentos y resumen.
   El destino depende exclusivamente de knowledge-vault.path_vault; sin clave será
   `.plans/archived/<id>/`, sin nodo ni commit. Configuración inválida, destino inaccesible o identidad
   no única detienen sin fallback. El resumen ausente o incompatible y las precondiciones Git incumplidas
   impiden presentar un ensayo como apto.
4. Declara tu revisión de saneamiento, suficiencia y limitaciones antes de la pregunta. Solo para un
   ensayo apto de una operación nueva presenta la pregunta canónica exacta del next, mediante el runner,
   con Archivar y No archivar. Liga flujo, identidad, inventario, procedencia, destino real y resumen.
   Con vault autoriza también el único commit local acotado; no pide otro digest textual ni segunda
   autorización de retiro. Las decisiones de publicación de hallazgos anteriores siguen separadas.
5. Con la respuesta verificable Archivar, ejecuta
   `sdd archive <id> --apply [--summary "<la misma línea>"] [--conductor claude|codex]`.
   Apply no prepara ni sanea. Conserva todos los archivos sin filtrar sufijos y verifica desde destino
   rutas y bytes, incluidos evidencia/ y directorios vacíos, y termina la limpieza del área de copia
   propia antes del commit y reclamo. Con vault crea y comprueba un único commit
   local de nodo y documentos nuevos, sin rutas ajenas ni manifiesto, con todos los hooks desactivados
   solo para ese comando y configuración permanente intacta. Solo después reclama y retira el origen.
   Sin vault omite el commit. No hace push ni PR. Lee desde destino registro, resultados, pendientes y
   evidencia; el archivo local no acredita cierre, gates ni autoridad de publicación.

La autoridad, el snapshot, las intenciones y el progreso quedan en un manifiesto y registros durables
del checkout, fuera del flujo y del commit del vault. Reanuda una operación pendiente con
`sdd archive <id> --apply`, sin otra respuesta ni --summary; conserva el resumen original y reconoce
el commit ya creado sin repetirlo. Un origen recreado no usa la autoridad de una operación completada.

Distingue las detenciones: summary diferente rechaza el argumento sin cambiar estado ni autoridad;
actividad escritora, locks, precondiciones Git y lecturas fallidas conservan fase reanudable. Resuelto
el impedimento transitorio, reanuda con la misma autoridad, incluso después del commit. Un defecto del
área exclusiva de copia permite descarte completo y recopia desde origen íntegro con la autoridad
original, sin conservar copias defectuosas. Una discrepancia comprobada del material autorizado antes
de publicar aborta, limpia solo esa área y consume la respuesta; una invocación posterior exige nueva
autorización. Una limpieza interrumpida termina primero su intención registrada.

Después de publicar, stagear, commitear o reclamar, una discrepancia comprobada deja `stopped` y
conserva el origen íntegro o restante. Un destino ya publicado ausente o distinto también deja stopped
con preservación y retiro pendientes: no se reconstruye, sobrescribe, borra ni repara desde Git.
Presenta causa, pendientes y entradas stageadas propias, o limitación de inspección, para decisión de
Max fuera del verbo; no limpies el índice. Una lectura fallida del destino es reanudable, no una
diferencia demostrada. Declara los pendientes en conversación: no edites el origen autorizado tras
fallo de apply ni añadas allí otro Cierre que cambie el inventario. Un manifiesto ilegible o incompatible
no permite continuar retirando ni reconstruir autoridad. No hagas copia o retiro manual como alternativa.
No crees otro backlog Git, migres tickets ni corrijas hallazgos.
Retomar desde el vault un flujo ya archivado queda fuera de este procedimiento.

La sincronización del checkout es `agents sync`, sin editar generados ni actualizar otros hosts. Doctor
informa copias stale/missing; reabre la sesión para cargar la skill nueva. Las comprobaciones reales
que lancen Claude son del conductor. Un rollback no borra registros: termina de recibir corridas con
findings usando una versión compatible antes de volver a un binario que rechace ese campo.

