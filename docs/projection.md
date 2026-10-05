# La proyección del estado de sdd-ai

La proyección es un JSON que publica el binario con el estado observable de un checkout: las corridas abiertas, el writer
en vuelo, los flujos y las ligas entre sesiones y flujos. La lee la banda del mod `sdd-ai` y la puede leer cualquier otro
consumidor sin conocer los archivos internos de las corridas.

Es **informativa, nunca una autoridad**. Nadie entrega, aprueba, decide ni libera nada por lo que diga. Un writer puede
escribir en su directorio; si lo altera, la siguiente publicación lo repara.

## Dónde vive

```text
.sdd-ai/
  .gitignore                 # `*`: nada de .sdd-ai entra en Git
  projection/                # excluido de la vigilancia del writer
    live/                    # las observaciones
      obs-<m0>-<arranque>-<pid>-<aleatorio>.json
      tmp-<m>-<arranque>-<pid>-<aleatorio>       # temporales de un publicador en curso
      claim-<m0>-<arranque>-<pid>-<aleatorio>    # reserva vacía de un publicador que está leyendo
    stale-<aleatorio>/       # un live/ apartado
```

- `m0` es el reloj monotónico de la máquina (`process.hrtime.bigint()`, nanosegundos desde el arranque) en el momento en
  que el publicador empezó a leer las fuentes, con 20 dígitos. El nombre ordena por `m0`. Una reserva lleva el `m0` de
  la observación que su publicador va a publicar.
- `arranque` es el identificador del arranque de la máquina (`/proc/sys/kernel/random/boot_id` en Linux,
  `kern.bootsessionuuid` en macOS). El reloj monotónico vuelve a empezar en cada arranque.
- `pid` es el del publicador y `aleatorio` son 32 dígitos hexadecimales.

## Cuál es la proyección

La proyección es la observación de nombre válido más nueva de `live/`: la de mayor `m0`, y a igual `m0`, la de mayor
resto del nombre como texto. Los temporales, las reservas y cualquier otra entrada no son observaciones, aunque cuentan
para el límite de 256 entradas.

Un consumidor:

1. obtiene la ruta real del checkout y comprueba que `.sdd-ai/`, `projection/` y `live/` son directorios y no enlaces;
2. lista `live/`. Si tiene más de 256 entradas, la proyección **no está disponible** hasta la siguiente publicación, que
   aparta `live/`. Un listado así puede ser caro (unos 1,4 s con 100 000 entradas): no conviene repetirlo enseguida;
3. elige la más nueva y, antes de leerla, comprueba que es un archivo regular, no un enlace, de menos de 4 MiB, y que su
   ruta real es exactamente la del checkout seguida de `.sdd-ai/projection/live/<nombre>`;
4. si desapareció entre el listado y la lectura (la podó una publicación más nueva), prueba con las siguientes de la
   misma lista y vuelve a listar. Si la más nueva no sirve por otro motivo (irregular, corrupta o de una versión que no
   entiende), la proyección **no está disponible**: no cae a una anterior, que podría mostrar un estado viejo como
   actual.

Queda un límite: Node no ofrece lecturas relativas a un directorio abierto, así que un writer que cambia un directorio de
la ruta por un enlace justo entre las comprobaciones y la lectura puede hacer que un consumidor lea un archivo ajeno. Ese
archivo no pasa como proyección válida, o se ve como una observación falsa.

## El contrato (`schema_version: 1`)

La forma exacta está en `src/projection-types.ts` (`Projection` y `validateProjection`).

- `checkout`: `id` (sha256 de la ruta física) y `root`.
- `observation`: `id` (el nombre del archivo), `publisher` (`pid` y `kind`: `cli`, `hook`, `supervisor` o `unknown`),
  `m0`, `boot`, `observed_at` (milisegundos desde la época, cuando empezó a leer) y `read_finished_at`.
- `runs`: las corridas abiertas, cada una con su clase, su estado de ejecución, el motivo por el que sigue abierta
  (`running`, `undelivered`, `native_pending`, `native_unconfirmed` o `review_pending`), la sesión, el flujo asociado
  por un registro, si está viva y, en una revisión, su progreso por ronda y lanzamiento. Una corrida cerrada no está.
- `writer`: el writer en vuelo según su control protegido, también en `cessation_uncertain`.
- `flows`: el último estado observado de cada flujo del catálogo local, equivalente a `sdd status <id>`, con el momento de
  esa observación.
- `bindings`: la liga de cada sesión con su flujo.
- `omissions`: lo que no entró en los 4 MiB y cuántas entidades, en orden: primero los flujos `done`, después los flujos
  sin liga ni corridas abiertas. Nunca se omiten las corridas abiertas, el writer ni los flujos ligados.

Un dato desconocido vale `null` con su causa (`{ value: null, reason: { code, detail } }`); nunca se inventa. Una
colección tiene `availability`: `available`, `partial` o `unavailable`. Un catálogo vacío se distingue de uno que no se
pudo observar.

### La antigüedad

`observed_at` es del reloj de pared y sirve solo para la antigüedad: un salto del reloj la cambia, pero no cambia qué
observación gana. Un supervisor vivo publica cada 20 s aunque nada cambie; una corrida viva (motivo `running`, o un
writer en `cessation_uncertain`) que pasa más de 60 s sin publicaciones indica que nadie la está observando.

## Quién publica y cuándo

Cada verbo publica después de cada `status.json` que escribe y al terminar; cada hook, al terminar; cada supervisor,
después de cada estado, cada 20 s y al terminar. La publicación corre en un proceso aparte (`bin/sdd-ai __publish`), así
que no le suma tiempo al verbo: el cambio llega a `live/` unos cientos de milisegundos después. Un repositorio sin
`.sdd-ai/` no se toca. Antes de leer las fuentes, el publicador mira `live/`: si la observación más nueva es válida, de
este arranque y con un `m0` posterior al reloj monotónico del pedido, no lee nada y termina, porque esa observación ya
leyó las fuentes después del cambio.

Si no, varios pedidos que llegan juntos no leen todos las fuentes. Después de entrar al directorio y de tomar su `m0`,
el publicador crea en `live/` su reserva, vacía, en exclusiva, sin seguir enlaces y sin permisos, y busca reservas
**decididas** y **vivas** con un `m0` posterior al reloj del pedido y anterior al suyo: la de un publicador que empezó
a leer después del cambio pedido y antes que él. Si hay una, cede: borra su reserva, no lee y termina; el registro de
`SDD_AI_PROJECTION_MEASURE` lo anota como `skipped` con el nombre de esa reserva. Si no, marca la suya como decidida
(permisos `0600`), lee y publica, y la borra al terminar, publique o no. Así, de varios que arrancan juntos, lee el que
empezó primero y los demás ceden.

Si no cede, pero hay una reserva decidida y viva con un `m0` anterior o igual al reloj del pedido (la de un publicador
que empezó a leer antes del cambio y sigue leyendo), el publicador queda en la cola: borra su reserva, espera sin
ninguna en `live/` a que esa deje de estar viva, mirando cada 50 ms, y vuelve a empezar: mira otra vez si una
observación ya cubre el pedido y, si no, pone una reserva con un `m0` nuevo. De los que despiertan juntos lee uno y los
demás le ceden, así que por checkout leen a lo sumo el que corre y el siguiente. La espera dura en total hasta 5 s y
vuelve a empezar hasta tres veces; después lee igual, aunque el anterior siga detenido. Como corre en `__publish`, no le
suma tiempo a ningún verbo.

- **Viva** es un archivo regular, no un enlace, de este arranque, de un `pid` que existe y con un `m0` de no más de
  60 s que no está adelante del reloj.
- **Decidida** es una reserva cuyo publicador ya decidió leer. Mientras busca, la suya no tiene permisos: podría ceder a
  su vez ante uno que empezó a leer antes del cambio, y ese cambio no lo leería nadie. Ante una reserva viva sin decidir,
  el publicador espera hasta 200 ms a que se decida o desaparezca, y si no, lee.
- Solo cede o queda en la cola quien atiende un pedido con su reloj (`__publish`) y en el primer intento: una llamada
  directa, como la medición `stages`, lee siempre.
- Si el publicador que cubre muere o queda detenido después de que otros cedieron, esos cambios los refleja la siguiente
  publicación: es la excepción de un proceso que muere mientras publica.

Cada publicador, sin lock: entra al directorio por una cadena verificada (dispositivo, inodo y ruta física), escribe un
temporal en exclusiva, lo enlaza con su nombre definitivo (`linkSync`, que nunca pisa una entrada) y poda. Todas sus
operaciones, también las de la reserva, son relativas a ese directorio verificado. La poda borra las observaciones de
otro arranque o con un `m0` adelante del reloj, y las viejas que no están entre las dos más nuevas ni entre las de los
últimos 5 s; borra también los temporales de más de 60 s, las reservas que no están vivas (de otro arranque,
adelantadas, de más de 60 s o de un `pid` que ya no existe) y las entradas ajenas que no son directorios. Un enlace se
borra a sí mismo, sin seguirlo, y nunca borra en forma recursiva.

## Las versiones

`schema_version` es la del contenido. Todos los binarios, de cualquier versión, publican con este mismo mecanismo, y
ninguno deja de publicar por lo que diga una observación existente. Un consumidor que no entiende la versión de la más
nueva la trata como no disponible hasta la siguiente publicación compatible.

## Lo que se puede borrar a mano

- `projection/stale-*`: solo aparecen si alguien llenó `live/` con más de 256 entradas.
- `projection/live/junk-*`: un subdirectorio con nombre de observación que el publicador sacó del camino.

## Apagarla y revertirla

- `SDD_AI_PROJECTION=off` apaga la publicación de un proceso (la usa la suite de pruebas).
- `SDD_AI_PROJECTION_MEASURE=<archivo>` agrega una línea JSON por publicación, con lo que tardó y su latencia y, si
  esperó en la cola, ante qué reservas (`queued`) y cuánto (`queued_ms`) (lo usa `scripts/measure-projection.mjs`).
- Para revertir el productor no alcanza con volver a un binario anterior: hay que borrar `.sdd-ai/projection/` en cada
  checkout y worktree. Si no, un consumidor seguiría mostrando la última observación, que puede no tener corridas vivas
  ni antigüedad que la delate.
