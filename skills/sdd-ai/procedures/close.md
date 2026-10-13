<!-- Origen: SKILL.md:133–207 y 1441–1445. Traslado de la base a70c7da. -->

Apoyos: [findings](../references/findings.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

# Cierre

## push

Sigue el estado vigente y las instrucciones del proyecto y la decisión humana de publicación. `sdd commit` no hace push.

## open_pr

Sigue las instrucciones vigentes del proyecto para publicar el PR; next orienta, no concede permisos. `sdd commit` no crea PR.

## archive

Lee [hallazgos](../references/findings.md) y ejecuta «Archive: tramitar antes de copiar». Tramita y
persiste hallazgos y sus decisiones antes de congelar el inventario. `sdd commit` no archiva.

El procedimiento nativo es `sdd archive <id> --prepare`, revisión de saneamiento y suficiencia de los
cuerpos preparados y el material heredado, propuesta de `--summary "<una línea>"` con vault, ensayo
`sdd archive <id> [--summary "<una línea>"]`, declaración del conductor y pregunta canónica exacta
del `next` del ensayo. Solo tras la respuesta **Archivar** ejecuta
`sdd archive <id> --apply [--summary "<la misma línea>"] [--conductor claude|codex]`.

Con revisión pendiente, evidencia insuficiente o conflicto entre saneamiento y conservación literal
de un cuerpo obligatorio, no preguntes Archivar. Presenta a Max la decisión del material fuera del
verbo; no reescribas hashes, referencias ni procedencia para hacer pasar una edición por copia literal.
El binario no detecta secretos ni registra tu revisión de contenido.

Con `knowledge-vault.path_vault`, el binario conserva todos los documentos y genera el nodo compatible
con recall, verifica la copia y crea un único commit local acotado antes del reclamo y retiro del origen.
Desactiva todos los hooks solo para ese commit; no modifica su configuración permanente ni hace push.
Sin esa clave, conserva el flujo en `.plans/archived/<id>/` sin commit. Una configuración inválida no
habilita fallback. El archivo local no autoriza publicación remota ni acredita cierre o gates.

Una operación pendiente se reanuda con `sdd archive <id> --apply`, mediante su manifiesto durable en
el checkout: no necesita otra respuesta, digest textual ni `--summary`, y reconoce el commit ya creado.
Un argumento summary diferente se rechaza sin cambiar estado o autoridad. Actividad escritora, locks,
precondiciones Git y lecturas fallidas son impedimentos transitorios: resuélvelos y reanuda con la misma
autoridad. Un defecto del área exclusiva de copia permite su descarte completo y recopia; no retengas
copias defectuosas. Una discrepancia del material autorizado antes de publicar aborta y consume la
respuesta; una operación nueva posterior exige otra respuesta. Después de publicar, stagear, commitear
o reclamar, una discrepancia deja `stopped`.

El área de copia propia se elimina después de verificar la publicación y antes del commit y reclamo.
Un destino ya publicado ausente o distinto deja preservación y retiro pendientes con `stopped`, sin
reparación automática. Presenta causa, pendientes y las entradas stageadas propias del vault, o la
limitación de inspección; Max decide sobre ese material fuera del verbo. No limpies el índice ni el
destino y no restaures archivos desde blobs Git. Una lectura fallida del destino permite reanudar al
restablecerla. No edites el origen autorizado después de un fallo de apply.
