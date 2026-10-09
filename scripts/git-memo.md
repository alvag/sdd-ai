# Medición y equivalencia de las consultas Git

Estas herramientas no invocan motores. La preparación usa filas ejecutables reales de verify y una
revisión sintética cuya cobertura, convergencia y vigencia comprueban los lectores del producto.
No aprueban el flujo git-memo-228. La ejecución corresponde a `sdd verify` y al conductor.

## Traza y agregado

El destino es obligatorio, debe estar fuera del fixture y su directorio debe existir. La operación
se transmite en la URL, sin variables de entorno ni cambios de PATH:

```sh
node --import 'file:///ruta/al/repo/scripts/git-memo-trace.mjs?out=/ruta/a/trace.jsonl&op=verify' /ruta/al/repo/bin/sdd-ai sdd verify f
node scripts/git-memo-report.mjs aggregate --input /ruta/a/trace.jsonl --output /ruta/a/aggregate.json
node scripts/git-memo-report.mjs validate --input /ruta/a/aggregate.json
```

La precarga intercepta spawn, spawnSync, execFile, execFileSync, exec, execSync y fork. Propaga su URL
a hijos lanzados con process.execPath y a fork. Cada lanzamiento tiene un attempt y una completion
con el mismo id. Los intentos fallidos permanecen en la traza; `observed_processes` cuenta solo los
procesos observados. Las llamadas internas de una API no se cuentan dos veces.
La duración acumulada suma solo procesos observados. Los grupos conservan por separado
attempt_duration_ms, que también incluye la latencia de intentos que no lanzaron un proceso.

Los eventos de `sdd-ai:git-memo` son registros separados y no suman procesos. Un miss o bypass se
asocia con el siguiente Git síncrono compatible del mismo proceso. La validación rechaza asociaciones
ausentes o ambiguas, referencias inválidas y consultas repetidas con un store vigente.
El baseline conserva scope/call desconocidos: no se infieren ámbitos desde argv.

La traza distingue operación, clase de consulta, entrada/cwd y, cuando existe, clave y ámbito.
Las clases objetivo son repoRoot, gitDirs y objects; las otras consultas Git figuran como other.
La lista de bypass admite no_scope, legacy, redirect_env y stamp_unreadable. Los descartes admiten
stale_stamp, stamp_unreadable, unstable e incoherent, con referencia al miss o store correspondiente.

## Bench macOS

La única dependencia específica del host es `/usr/bin/time`, usada exclusivamente por el bench en
macOS. El producto, la precarga y las pruebas no seleccionan otro Git ni cambian PATH. El snapshot
base se extrae de git archive con un lector tar en Node; node_modules se enlaza. No se crean worktrees
para snapshots. El candidato se copia sobre la base y su árbol se coteja con candidateFingerprint.

```sh
node scripts/git-memo-bench.mjs run --base c9c3443f94555d2e4973a5b395d061e43c085d73 --candidate-root . --pairs 3 --output .plans/git-memo-228/measurements/macos --report .plans/git-memo-228/measurements/report.json
node scripts/git-memo-report.mjs validate --input .plans/git-memo-228/measurements/report.json --require-measurement --candidate-root .
```

El directorio de salida no puede tener archivos de una medición anterior (manifiesto, informe,
trazas, evidencias, estados iniciales o agregados), porque se mezclarían con los nuevos; otros
contenidos no molestan. El informe no puede existir, y su directorio se crea antes de medir. Los
artefactos se registran con rutas relativas al informe, así que validate los resuelve desde su
directorio (o desde `--artifacts-root`) en cualquier clon.

Cada operación corre en su propio grupo de procesos. Al vencer el timeout de 240 s se mata el grupo
completo y la exclusión dice `timeout`. La espera termina cuando sale `time`, aunque un descendiente
desligado retenga los pipes. Un SIGINT o SIGTERM al bench mata los grupos en curso, limpia los
fixtures y termina con error.

El entorno del manifiesto se deriva del que reciben las operaciones: los interruptores, las variables
GIT_* que fija el fixture y las heredadas del host, que tienen que ser ninguna. validate con
`--require-measurement` exige muestras y recalcula el overhead, las diferencias y sus estadísticas. Un
informe trae una traza o muestras, no las dos.

El comando crea fixtures nuevos para verify final y commit en ensayo/aplicación. Registra filas
ejecutadas y commit creado; rechaza salidas fallidas, timeout, recibo ausente, filas no ejecutadas,
aplicación sin commit, padre inesperado o registro incoherente. Cada ronda válida contiene las dos
versiones y las condiciones con/sin traza. El orden de ambas dimensiones alterna por ronda. El límite
es 2N intentos por escenario para conseguir N rondas válidas; no alcanzarlo hace fallar el bench.
Las exclusiones se guardan en manifest.json, sin convertirlas en muestras válidas.

El manifiesto schema=1 conserva base_commit, candidate.fingerprint, candidate.snapshot_sha,
candidate.source_sha, fixture_sha, runtime, env, samples y exclusions. Cada muestra declara version,
scenario, instrumented, round, attempt, order, version_pair y overhead_pair. initial_identity coteja
HEAD, árbol, entradas del índice y archivos candidatos. Los snapshots completos originales se
guardan como artefactos para revisar el resto del estado inicial; la igualdad de initial_identity
por sí sola no acredita equivalencia completa de registros y gates.

El candidato se identifica por candidateFingerprint(root, git-memo-228, base_commit), que excluye
solo el directorio del flujo. validate vuelve a calcularla sobre el árbol actual. También exige tres
rondas por escenario, pares completos, alternancia, el mismo SHA de fixture, fuentes/unidades conocidas
y digests correctos de los artefactos originales.

Las métricas son distintas:

| Métrica | Fuente | Unidad |
| --- | --- | --- |
| CPU user+sys | `/usr/bin/time -p`, suma de user y sys | segundos |
| Pared | real de `/usr/bin/time -p` | segundos |
| Duración acumulada | suma de lanzamiento a retorno/close observada por Node | milisegundos |

Sin traza, duración acumulada y conteos de procesos son null, no cero. Se reportan mediana, MAD y
rango, diferencias candidato-baseline y overhead instrumentado-sin instrumentar. No hay umbral de
mejora. La carga antes/después se registra mediante os.loadavg; su comparabilidad requiere revisión
humana. Las cifras se limitan a estos escenarios, no a la suite completa.

La precarga no observa procesos internos de Git, hooks que lanzan otros ejecutables, comandos Node
dentro de una cadena shell ni descendientes que pierden la precarga. time cuenta CPU según la
contabilidad de procesos esperados del SO; no acredita CPU de procesos desligados. Un lanzamiento
asíncrono que sigue vivo cuando su proceso Node termina se cierra con `observed: false` y
`alive_at_exit: true`: queda fuera de la cobertura, sin invalidar la traza. Las duraciones
acumuladas pueden solaparse y nunca se presentan como CPU.

## Equivalencia y Windows

```sh
node scripts/git-memo-report.mjs check-equivalence --input /ruta/al/manifiesto.json --candidate-root . --output /ruta/al/equivalence.json
node --import ./test/no-subprocess.ts --test --test-reporter=tap --test-name-pattern='^las claves distinguen entradas y nunca unen checkouts distintos$' test/git-memo-keys.unit.test.ts
node --test --test-reporter=tap --test-name-pattern='^las claves del host unen separadores y alias de gitDirs y nunca unen checkouts distintos$' test/git-memo-keys.test.ts
```

check-equivalence exige candidate.fingerprint, base_commit y entradas equivalence no vacías. Cada
entrada contiene name, baseline, candidate, rules e integrity. Compara salidas completas, códigos,
JSON y los estados capturados. Campos desconocidos y mensajes se conservan, y cualquier diferencia
restante falla nombrando su ruta y los dos valores normalizados.

**Reglas de normalización** (`rules`). Una correspondencia tiene kind, left, right y symbol; una regla
por clase tiene kind `time`, side (`left` o `right`), value y symbol. Cada patrón captura el dato con su
contexto (la clave del campo o su formato completo), y el reemplazo exige límites de token: una regla
nunca cambia un número, hash o nombre dentro de otro token.

| kind | Qué cubre (con su contexto) | Correspondencia |
|---|---|---|
| `root` | raíces temporales del fixture y el nombre de su directorio | biyectiva |
| `run_id` | ids de corrida (`AAAAMMDD-HHMM-xxxx`) | biyectiva, por ocurrencia |
| `pid` | `"pid": n`, `"supervisor_pid": n` y `"child_pid": n` | biyectiva por número: dos campos con el mismo proceso lo comparten en el otro lado |
| `inode` | `"ino": n` de las identidades de directorios | biyectiva por número |
| `derived_digest` | `--digest <hex>` de un ensayo (commit o prune) que el mismo lado consume en su `--apply` | biyectiva, por ocurrencia; la aceptación del apply lo verifica |
| `time` | instantes ISO, `"duration_ms": n` y `lstart` de `ps` | por clase: cada valor va al símbolo de su clase |

`deriveVariableRules(baseline, candidate)` arma las reglas de todas las clases salvo `root`, que
declara el test. Si una clase no tiene la misma cantidad de ocurrencias en los dos lados, no emite
reglas de esa clase. Las correspondencias emparejan los valores por ocurrencia, en el mismo orden de
recorrido; un valor que se emparejaría con dos distintos rompe la biyectividad y no se normaliza, así
que la diferencia queda a la vista.

Los tiempos van por clase y no por correspondencia, porque dos eventos pueden caer en el mismo
milisegundo en un lado y no en el otro. Los instantes ISO conservan su orden: si dos ocurrencias están
estrictamente ordenadas en los dos lados (por ejemplo, una respuesta y su vencimiento), tienen que
estarlo en el mismo sentido, y una marca copiada (el mismo texto en dos lugares de un lado) no puede
distar en el otro un segundo o más (dos si está en segundos, porque dos eventos del mismo segundo pueden
caer en segundos contiguos del otro lado); si no, la clase no se normaliza. Dos instantes de formatos
distintos que caen en el mismo segundo son eventos distintos y no cuentan como copia. Las duraciones y `lstart` miden al host y se
normalizan sin relaciones. Es un desvío del plan, que pedía correspondencias biyectivas para todo dato
variable: Max lo aceptó de forma explícita el 2026-10-09 (F-10), y queda declarado en el informe de
medición. Una regla `time` solo normaliza un valor con la forma de su clase.

**Integridad** (`integrity`): cada referencia contiene left/right con path y digest, con el prefijo
`sha256:` o como hex solo. Primero comprueba el SHA-256 de los bytes originales. Después compara el
contenido normalizado y reemplaza el digest por el hash de ese contenido, de modo que los derivados se
recalculan y no se eliminan. `deriveIntegrity(baseline, candidate, rules)` encuentra los digests citados
que coinciden con el hash de un archivo capturado, los empareja con el archivo de la misma ruta del otro
lado y los ordena por dependencia.

**Qué captura cada estado** (`captureState`): la salida, los archivos del árbol, el gitfile de un
worktree enlazado, los almacenes `sdd-ai/` del directorio Git y del común, los metadatos de Git que los
registros citan (HEAD, config, commondir, refs, info y worktrees, sin index, objects, logs ni hooks),
HEAD, el árbol, las refs, el índice lógico (`ls-files --stage`) y `diff-files`. Los bytes crudos del
índice no se comparan: guardan datos de stat que difieren entre fixtures en cuanto una operación lo
reescribe.

**La matriz de V11** (`test/git-memo-equivalence.test.ts`) corre cada escenario de las seis fábricas
del fixture contra un snapshot `git archive` de la base y contra el candidato, en checkout principal y
en worktree enlazado, con fixtures nuevos del mismo HEAD. Exige los caminos verify final exitoso,
commit en ensayo y aplicación, prune con candidato cambiado, cese incierto, gates inválidos, writer vivo
y publicación habilitada, además de los escenarios de claves, recuperación, consumidores, cambios,
reservas y controles anteriores.

Para Windows, preparar un paquete con `git diff --binary <base_commit>` y los
archivos nuevos, aplicar el paquete sobre un checkout limpio de la base y crear una junction de
node_modules. Conservar `.gitattributes` (`* text=auto eol=lf`) y modo 100644 de archivos nuevos.
Registrar Node, Git, SO, core.autocrlf y core.filemode. Ejecutar las pruebas de claves anteriores y V11 con
timeout 900000 ms. Comparar la misma huella mediante check-equivalence.
No ejecutar el bench ni time en Windows. La emulación de rutas no sustituye registros de ambos hosts.

## Vigencia y límites

Los ámbitos de verbo y de iteración usan AsyncLocalStorage y se vacían al terminar, incluso tras
rechazo. Las iteraciones no heredan entradas. finally y la proyección legacy consultan fuera del
memo nuevo; el legacy mantiene sus claves y comportamiento. __supervise no abre un ámbito de verbo.
Las esperas de groupGone no consultan las tres funciones objetivo y permanecen intactas.

Las estampas usan dev/ino enteros, tipo y el contenido del gitfile, de `commondir` y de las
configuraciones; no guardan rutas, así que dos grafías de la misma raíz (que comparten clave en
gitDirs) dan la misma estampa. No usan fechas de directorios, que cambian al escribir HEAD, índices o
locks. Discovery vigila las identificaciones intermedias; objects vigila el directorio Git explícito,
`commondir`, el común y el de objetos (no `config` ni `config.worktree`, que no cambian esa ruta), y
vuelve a leer alternates en cada llamada.

Cada entrada guarda además el ancla de su valor: la ruta real y la identidad de cada ruta que devuelve.
Antes de reutilizarla se recalcula. Un repositorio renombrado (la ruta guardada ya no existe) o un padre
movido con un enlace en la ruta anterior (la ruta real cambió) descartan la entrada aunque la estampa
siga igual. Se conservan como límites residuales la reutilización de inodos y una mutación externa
posterior a la última lectura. No se promete atomicidad contra esa carrera.

Este documento describe comandos y contratos; no acredita resultados. La auditoría está en
`.plans/git-memo-228/audit.md` y la evidencia, en `.plans/git-memo-228/measurements/`.
