# Comprobación real del aviso al conductor

Este procedimiento corresponde a V1 y V13–V17 del flujo aviso-al-conductor.
Las pruebas del motor son simulaciones y no acreditan AC-16–AC-18. El conductor
ejecuta los escenarios en Claude Code sobre macOS y conserva la evidencia del flujo
en `.plans/aviso-al-conductor/evidence/`; este documento no declara que se hayan realizado.

Para cada caso registra fecha, `claude --version`, versión de macOS, terminal,
checkout físico, rama, ancho efectivo, ids de sesión y corrida, comandos exactos,
estado anterior/posterior, texto del aviso, respuesta de submit, señal y recibo.
Conserva logs y capturas legibles. Identifica toda inyección o preparación controlada.

## V1: sonda previa del API

En una sesión interactiva usa una sonda controlada que solo lea `$.prompt.read()`
y solicite `$.prompt.submit({ text })`, registrando hora, respuesta y nueva lectura.
No uses asUser, socket ni herramientas automáticas. Prueba:

1. Sesión ociosa sin borrador: registra el aviso y la respuesta con text/origin.
2. Borrador no vacío: registra texto y cursor antes y después del envío.
3. Carrera: escribe después de prompt.read y antes de submit; compara texto/cursor.
4. Turno en curso: comprueba que no se interrumpe y registra cuándo resuelve la promesa.
5. Drop confirmado mediante otro plugin: el plugin emisor no ve su propio submit.
6. AskUserQuestion abierta: registra isWorking y hasSurvey, conserva la pregunta,
   respóndela y observa el aviso como turno posterior.
7. Banda visible plegada: registra que PromptHint sigue observando disponibilidad.
8. Cierra una sesión con aviso encolado antes de quedar ociosa: distingue ausencia de
   respuesta de un rechazo confirmado.

Detén la habilitación si se pierde texto o se interrumpe la actividad. La evidencia
existente de T1 registra conservación del borrador y no interrupción con 2.1.289;
el plegado con banda visible sigue necesitando comprobación posterior. La promesa
puede resolver al iniciar el turno: no confundas encolado con recepción del resultado.

## V13: recepción, convivencia y Stop

Lanza una corrida larga, termina el turno sin wait previo y observa el aviso posterior
con id y `./bin/sdd-ai wait <id>`. Repite done, failed, cancelled y timeout, conservando
el estado que sustenta cada resultado. Recibe una revisión con
`./bin/sdd-ai review status <id>`: compara delivered.json antes del aviso, después
de submit y después de consultar. Compara ledger, disputas y gates: deben conservarse.

Termina corridas durante trabajo, una pregunta y un borrador escrito por Max. Registra
texto/cursor y continuidad del turno; al quedar ociosa y vaciar el borrador, observa
el siguiente ciclo completo. Termina varias corridas juntas y nuevas rondas/lanzamientos;
cuenta solicitudes por identidad. Con señal operativa, comprueba Stop silencioso y
registros de recordatorio intactos. Desactiva el mod durante más de 5 s antes de recibir
y comprueba la alternativa de Stop y sus límites de repetición.

## V14: dueña y relevo

Abre dueña A, ligada B y ajena C en el mismo checkout. Registra sus ids y señales.
Con A y B operativas, termina una corrida de A y deja B ociosa antes: solo A recibe.
Desactiva A, acredita vencimiento y retoma desde otro id con
`./bin/sdd-ai sdd status <flow>`. Prueba terminación anterior/posterior a la liga y /clear.
C y una sesión ligada a otro flujo no reciben. Añade dos candidatas operativas:
no debe elegirse una; resuelve la ambigüedad y observa el pendiente.

Prueba corrida propia sin flujo, asociación ausente/conflictiva y señales ilegibles.
Consulta desde actor ajeno y legítimo, comparando resultado y recibo. Prueba además
una receptora operativa junto a otra ligada degradada, y recuperación manual cuando
solo queda una ligada con señal vigente degradada. La dueña siempre conserva su
recepción manual sin mod. No edites recibos para simular autorización.

## V15: indisponibilidad y recuperación

En un checkout controlado conserva copias de los datos antes de inyectar proyección
ausente, corrupta, incompatible o ajena y una lectura retenida. No deben provocar
avisos nuevos ni renovar una señal operativa indefinidamente. Restaura una lectura
válida y comprueba que no se perdió el pendiente.

Provoca drop confirmado desde otro plugin; conserva la respuesta y las tres solicitudes,
con espera de 30 s y 60 s. Un rejected con reintento pendiente puede seguir operativo;
exhausted queda degradado. Por separado provoca rechazo de promesa, cierre o 10 s
ociosos sin respuesta; no lo etiquetes como drop. Comprueba indeterminación sin reenvío
ciego y recibe manualmente mediante wait/review status. Durante trabajo/pregunta el
plazo no corre. Registra respuestas tardías y ausencia de nuevos intentos.

Compara dominio antes/después del aviso: sin entregas, ligas, contadores, decisiones,
hallazgos o gates modificados por el mod. Declara el método y límites de cada inyección.

## V16: adopción y recarga

Prepara corridas vivas, terminales pendientes y ya recibidas. Registra dueñas, asociaciones
y recibos. Adopta mediante agents sync o init aplicado según su plan aprobado y usa
/reload-plugins en la sesión abierta. Las vivas continúan, las pendientes se avisan sin
nueva transición y las recibidas permanecen cerradas. Actualiza y recarga después de
accepted, antes de recibir y después de recibir: cuenta solicitudes y renovaciones,
registrando instancias para comprobar que el coordinador anterior dejó de producir efectos.
No cambian dueña, flujo ni recibo. Las claves son por resultado y destinataria; no hay
transacción distribuida entre sesiones, y durante un relevo se admite uno por sesión.

## V17: banda en terminal

Observa un writer real en ejecución y conserva captura con la identificación writer.
Observa cessation_uncertain junto con su fuente de estado. Declara si surgió realmente
o se preparó controladamente; no debe disparar aviso terminal, entrega ni liberación.
Prueba 166, 80 y 79 columnas, y un ancho menor si hace falta. Conserva capturas antes
y después: una línea, marcas de writer/cese incierto donde quepan, plegado/despliegue
mediante el control de Max y cesión ante una pregunta. Termina una corrida elegible
con la banda plegada y comprueba su aviso mediante PromptHint.

## Evidencia y cierre

Conserva api-probe.md, delivery-and-stop.md, routing-and-receipt.md, recovery.md,
adoption.md y band.md con los datos de cada caso. El conductor reúne la matriz
AC–task–fila–evidencia, acredita las filas manuales con el mecanismo existente y ejecuta
sdd verify cuando el flujo lo habilite. Deja pendiente cualquier criterio no demostrado;
no cambies el contrato ni apruebes gates para aparentar cobertura.
