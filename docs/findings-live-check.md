# Comprobación manual de findings-log-49

Guion del conductor para `sdd verify`, basado en la spec AC-1 a AC-18 y el plan del flujo
findings-log-49. Estas filas observan decisiones y efectos reales: buscar palabras en la skill no las
acredita. El writer solo redacta este guion; no ejecuta escenarios, tests, builds, instaladores, Claude,
`test:mods`, preparación de declaraciones del motor ni recuperación del rollout.

No usar el flujo real para inyectar fallos. No publicar en servicios reales. Cada caso parte de un
fixture nuevo, con la skill nueva en una sesión reabierta y sin writer en curso al editar. Los comandos
siguientes son para el conductor. Anotar observación real, esperado, diferencias y resultado pendiente
si no se pudo comprobar. Ningún resultado sustituye un gate humano.

## Preparación y evidencia común

Desde la raíz del checkout, preparar un repositorio de prueba con configuración, identidades y
mecanismo de copia locales. La variable `findings_source` señala el checkout del producto; no se
modifican sus directorios internos. Node debe cumplir el requisito de `package.json` (>=26).

```sh
findings_source="$PWD"
findings_fixture="$(mktemp -d /tmp/sdd-findings-live.XXXXXX)"
export findings_fixture findings_source
mkdir -p "$findings_fixture/repo/.sdd-ai" "$findings_fixture/bin" "$findings_fixture/evidence" "$findings_fixture/vault"
git -C "$findings_fixture/repo" init -q -b main
git -C "$findings_fixture/repo" -c user.name=Test -c user.email=test@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m base
cat > "$findings_fixture/repo/AGENTS.md" <<'RULES'
Código en inglés, explicaciones en español. Hallazgos nuevos: issues abiertos del repositorio fixture/product.
Consultar duplicados en fixture/product y fixture/legacy. Triage, prioridad definitiva, host y conductor quedan para el responsable del proyecto.
Archivo de prueba: copiar el directorio completo a la carpeta vault del fixture, comparar rutas y bytes y leer desde allí. Retirar requiere aprobación explícita del usuario.
RULES
cat > "$findings_fixture/repo/.sdd-ai/config.yml" <<'CONFIG'
cross_model:
  schema_version: 1
  families: [codex]
  selection: full
CONFIG
printf 'Exportar CSV; no cambiar el lector de filas.\n' > "$findings_fixture/request.md"
cd "$findings_fixture/repo"
"$findings_source/bin/sdd-ai" sdd start sample --apply --depth normal --risk low --change-type feat --request "$findings_fixture/request.md"
export findings_flow="$findings_fixture/repo/.plans/sample"
mkdir -p "$findings_flow/findings-pending" "$findings_flow/findings-evidence"
```

Si el arranque necesita CLIs, usar los ejecutables falsos del repo (`test/helpers.ts`, `makeFakeBin`)
y antecedentes aislados, como `test/findings-start.test.ts`; nunca depender de memoria real. Para
recorridos reales Codex o Claude, el conductor usa un fixture separado y su autorización vigente. Las
filas automáticas V1–V7, V19, V21–V30 se corren por `sdd verify`; V29 usa CLIs falsos. V20 distingue
simulación de doctor de los recorridos reales de familias.

Conservar fuera del flujo un diario `$findings_fixture/evidence/observations.md`: fila V, fecha,
commit del producto, Node, SO, sesión, corrida/paquete, comandos, salida saneada, decisión humana y
comparación contra esperado. No inventar contexto ausente. Para el registro, copiar solo extractos
saneados autosuficientes, no directorios `.sdd-ai/`, contratos o logs enteros. Cada escenario conserva
registro, respaldos, evidencia y resultados externos relevantes; los originales crudos con datos
sintéticos se quedan fuera de la copia del flujo.

## V8: selección, captura inmediata y bloqueo

Preparar un defecto de producto de prueba, fuera del alcance CSV, durante una fase intermedia sin
recordatorio de captura. Escribir esta implementación defectuosa solo en el fixture:

```sh
mkdir -p src
cat > src/reader.ts <<'CODE'
export const readRows = (s: string): string[] => s.split('\n').slice(0, -1)
CODE
node --input-type=module -e 'import { readRows } from "./src/reader.ts"; console.log(JSON.stringify(readRows("a\nb")))'
```

1. Entregar al conductor la reproducción como descubrimiento durante plan/tasks, sin solicitar que
   registre. Esperado: H-1 inmediato, sin permiso local, con `src/reader.ts:1`, esperado `["a","b"]`,
   observado `["a"]`, impacto pérdida de fila, referencia de alcance y contexto disponible.
2. Repetir con contexto parcial desconocido: deben aparecer desconocidos explícitos, sin datos
   inventados. Pedir lectura de ambas entradas a alguien sin conversación: debe explicar el defecto.
3. Contrastar: error de CSV dentro del alcance; agente que leyó otra carpeta; servicio externo sin
   evidencia del producto; defecto sustentado de la skill/runtime cuando el producto analizado sea
   sdd-ai. Solo defecto fuera de alcance y defecto de skill/runtime pertinente producen H-n.
4. Antes de aprobación, registrar referencia provisional y después reevaluar contra spec aprobada.
5. Hacer que un AC requiera exportar todas las filas: ahora el defecto impide ese AC. Debe declararlo,
   detener el avance de ese criterio y pedir decisión de alcance/continuidad. No corregirlo solo por
   registrarlo. Simular decisión explícita que lo incorpore y resolución: conservar ambas antes de
   `resolved_in_flow`. Contrastar otro hallazgo no bloqueante que sigue `pending`.
6. Descubrir uno mientras corre un writer: exigir contenido completo en conversación y «no persistido
   todavía (writer en curso)», sin escribir el árbol. Tras cosechar debe persistirse. Cortar antes de
   cosechar deja esa conversación como única traza, nunca una afirmación de registro.

Guardar entradas, comparación con alcance, evidencia de ausencia de cambios no autorizados, decisiones,
lectura independiente y estado de gates. Comprobar que no asigna prioridad definitiva, host o conductor,
ni crea o migra un ticket heredado.

## V9: saneamiento y evidencia independiente del temporal

```sh
cat > "$findings_fixture/raw-evidence.txt" <<'RAW'
reader("a\nb") => ["a"]
TOKEN=synthetic-secret-123
persona=Persona Sintética; email=private-test@example.invalid
ruta=/Users/persona-privada/customer/data.csv
RAW
```

Entregar evidencia desde un worker y una revisión. El conductor debe omitir token, datos personales y
ruta privada antes de guardar registro, respaldo, evidencia o cuerpo de issue, conservando reproducción
con datos sintéticos, marcadores y ruta relativa. Revisar todos esos archivos y la copia archivada;
puede usarse `rg 'synthetic-secret-123|private-test|persona-privada'` para detectar fugas, pero además un
lector debe poder reproducir el defecto. Registrar limitaciones del saneamiento.

```sh
rm "$findings_fixture/raw-evidence.txt"
```

Después de retirar el temporal, leer entrada/evidencia desde el flujo y desde la copia: deben seguir
siendo autosuficientes. Introducir un secreto sintético en un bloque heredado: exigir declaración del
conflicto con conservación literal y decisión del usuario antes de publicar o archivar ese material.
Guardar versiones saneadas y evaluación de suficiencia, sin incluir el secreto en evidencia archivada.

## V10: recepción independiente de admisión y publicación

Preparar cada reporte con `problem`, `location`, `expected`, `observed`, `evidence`, `impact`, `moment`,
`stage` y `context` como `test/findings-fixture.ts`, con unknown como null. Usar respuestas controladas
por `FAKE_MODE=scripted`, `FAKE_ANSWERS` y `FAKE_CALLS_FILE` (`test/fake-cli.ts`); writers usan
`FAKE_WRITERS`. Ejemplo de archivos de respuestas, escritos en un fixture y no ejecutados por el writer:

```sh
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs'
const { FINDING, SPECIFY } = await import(`${process.env.findings_source}/test/findings-fixture.ts`)
writeFileSync(`${process.env.findings_fixture}/answers.json`, JSON.stringify([
  JSON.stringify({ ...SPECIFY, findings: [FINDING], missing_context: ['esquema'] }),
  JSON.stringify({ ...SPECIFY, findings: [FINDING], extra: true }),
  'sin contrato admisible'
]))
JS
```

1. Recibir worker read-only y los cinco roles de run; no deben escribir registro. Respuesta libre trae
   el apartado, JSON lo incluye en el esquema admitido; esquema cerrado sin canal se respeta. Recibir
   un run sin vínculo inequívoco: informar al usuario sin atribuirlo por proximidad.
2. Recibir specify, plan, tasks, implement y fix: el conductor consolida antes de seguir/gate, incluso
   con preguntas/contexto y sin publicar el artefacto. Conservar ubicación y respaldo.
3. En otra corrida, clave ajena causa inadmisión. Recuperar solo hallazgos legibles de salidas de
   intentos, sin declarar admisión. Provocar fallo de corrida. Hacer que la corrección final sea válida
   y el hallazgo exista solo en el intento anterior: debe recuperarse también.
4. Dar `findings` mal formado junto a uno válido: procesar válido y contenido legible de
   `findings_rejected` sin cambiar admisión/completion/filas. Nueva corrida sin clave señala
   `findings_missing`; un control anterior sin marca no debe hacerlo.
5. Mover temporalmente las salidas conservadas del fixture a una carpeta fuera de acceso del conductor
   (anotar sus rutas antes). Debe persistir incidencia de recepción con corrida, causa y referencias,
   sin H-n publicable inventado. Cortar/reabrir la sesión y comprobar esa incidencia; restaurar salidas.

Guardar `wait` saneado, referencias de intento/corrida/elemento, resultados de admisión y registro;
conservar evidencia relevante íntegra en el flujo, nunca la corrida completa.

## V11: revisiones sin mutar el ledger

Preparar dos ledgers con el constructor puro del producto. Son resultados sintéticos de revisión,
no una afirmación de haber ejecutado una revisión real. La evidencia concreta acompaña al ledger:

```sh
node --input-type=module <<'JS'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
const { openLedger } = await import(`${process.env.findings_source}/src/review/ledger.ts`)
const dir = `${process.env.findings_fixture}/reviews`
mkdirSync(dir)
const common = { axis: 'quality', causality: 'pre-existing', evidence: 'deterministic', reviewer: 'base', batch: 1 }
const diff = openLedger([
  { ...common, severity: 'CRITICAL', location: 'src/reader.ts:1', claim: 'Pierde última fila: reader("a\\nb") devuelve ["a"]' },
  { ...common, severity: 'CRITICAL', location: 'external/tool.ts:1', claim: 'Fricción de una herramienta ajena; sin defecto del producto' },
  { ...common, severity: 'WARNING', location: 'src/other.ts:1', claim: 'Defecto no grave distinto, reproducción sintética documentada' }
])
const artifact = openLedger([{ ...common, severity: 'WARNING', location: 'plan.md:1', of: 'src/reader.ts', claim: 'El lector pierde la última fila; reproducción reader("a\\nb")' }], { artifact: true })
writeFileSync(`${dir}/diff-ledger.json`, JSON.stringify(diff, null, 2))
writeFileSync(`${dir}/artifact-ledger.json`, JSON.stringify(artifact, null, 2))
copyFileSync(`${dir}/diff-ledger.json`, `${dir}/diff-before.json`)
copyFileSync(`${dir}/artifact-ledger.json`, `${dir}/artifact-before.json`)
JS
```

Recibirlos: solo los pertinentes pasan al registro con claim, reproducción/cita, ubicación y
revisión/F-n/ronda/reviewer/batch. deterministic/inferential se conserva y no reemplaza respaldo.
Contrastar uno que impida un AC: exige bloqueo y decisión aunque el ledger diga informativo o
fuera-de-alcance. No cambiar estados, ejes, decisiones ni veredicto por la captura.

```sh
cmp "$findings_fixture/reviews/diff-before.json" "$findings_fixture/reviews/diff-ledger.json"
cmp "$findings_fixture/reviews/artifact-before.json" "$findings_fixture/reviews/artifact-ledger.json"
```

Guardar comparación byte a byte, evaluación de pertinencia, relaciones y decisión del AC. Para el recorrido con una revisión real del fixture conserva además su request,
candidato y referencia de corrida; si esos resultados no están disponibles, esa variante queda pendiente.

## V12: identidad semántica, adopción y retoma

Entregar el mismo defecto del lector con tres redacciones desde conductor, worker y revisión. Repetir
recepciones, retry y retoma: un H-n estable, fuentes nuevas y evidencia nueva sin repeticiones.
Preparar dos problemas similares cuya identidad no sea decidible: entradas separadas y relacionadas
para triage, sin usar igualdad literal/hash como identidad.

Para adopción, en otro fixture mover el registro fuera del flujo, conservando las aprobaciones:

```sh
cp "$findings_flow/sdd-ai-approvals.json" "$findings_fixture/evidence/approvals-before.json"
mv "$findings_flow/hallazgos.md" "$findings_fixture/evidence/old-register.md"
"$findings_source/bin/sdd-ai" sdd status sample
```

Retomar debe crear plantilla sin reiniciar ni invalidar gates; evaluar reviews citadas en
`sdd-ai-phases.json` y artefactos asociados explícitamente por request/candidato. Declarar inaccesibles,
no inventar conversaciones ni asociar por cercanía. Comparar aprobaciones después.

Para heredado, usar un fixture distinto o restablecido:

```sh
cat > "$findings_flow/hallazgos.md" <<'OLD'
# Hallazgos — sample

## H-1 — Lector
Texto heredado literal con espacios y estilo antiguo.

## H-7 — Otro defecto
Texto antiguo sin contexto completo.
OLD
cp "$findings_flow/hallazgos.md" "$findings_fixture/evidence/legacy-before.md"
```

Agregar evidencia debajo de H-1 y un defecto distinto H-8. Comparar literalmente los bloques antiguos
contra el respaldo, respetando orden; no reformatear ni exigir los campos nuevos. Preparar publicación
con sus faltantes declarados. Al retomar informar H-n existentes. Recibir una corrida viva con control
anterior sin exigir findings ni cambiar gate. Guardar entradas, procedencias, comparación literal y
`sdd status` antes/después.

## V13 y V14: fallos de persistencia y orden de efectos

Usar usuario sin privilegios: si permisos no producen el fallo esperado, registrar limitación y usar
fallos controlados del patrón `test/fs-fault.ts`; no acreditar el caso sin observar el fallo. Guardar
copia del registro antes y restaurar permisos en todos los casos. Nunca aplicar al flujo real.

```sh
mkdir -p "$findings_flow/findings-pending"
cp "$findings_flow/hallazgos.md" "$findings_fixture/evidence/register-before-fault.md"
# Caso ilegible
chmod 000 "$findings_flow/hallazgos.md"
# Restauración tras observar el caso
chmod 644 "$findings_flow/hallazgos.md"
# Legible pero no escribible ni reemplazable; respaldo sí escribible
chmod 777 "$findings_flow/findings-pending"
chmod 444 "$findings_flow/hallazgos.md"
chmod 555 "$findings_flow"
# Falta total de escritura
chmod 555 "$findings_flow/findings-pending"
# Restaurar siempre antes de preparar el caso siguiente
chmod 755 "$findings_flow"
chmod 755 "$findings_flow/findings-pending"
chmod 644 "$findings_flow/hallazgos.md"
```

V13, durante fase: con registro ilegible y luego legible no escribible, declarar fallo y conservar
reporte saneado en `findings-pending/` sin afirmar consolidación ni reemplazar por vacío. Cortar sesión,
restaurar, retomar y consolidar sin pérdida/duplicados, marcando respaldo con H-n sin eliminarlo.
Sin escritura del respaldo entregar contenido completo en conversación y declarar falta de
persistencia. En archive, legible no escribible con respaldo permite continuar y archivar resultados;
cierre sin nada por tramitar con directorio no escribible también continúa.

V14, cuatro fixtures independientes de archive:

| Fallo inyectado | Observación exigida |
| --- | --- |
| Registro ilegible | Detener antes de publicar/copiar; entregar solo pendientes legibles y declarar resto desconocido. |
| Sin escritura antes de preguntar | Detener antes de pregunta de publicación; contenido completo y decisiones/resultados legibles entregados. |
| Pérdida de escritura entre dos publicaciones | Tras guardar la primera, aplicar falta total de escritura; segunda intención no se guarda/relee, no se crea segundo issue ni copia. |
| Creación completada, luego pérdida de escritura | En el gh simulado activar `GH_FAKE_AFTER_CREATE_LOCK=1`; detener si no persiste resultado en registro ni respaldo, entregar número/URL/verificación o incertidumbre. |

Fuera de archive probar petición explícita anticipada: registro ilegible o comprobación negativa
cancela publicación, declara causa, deja pending y el flujo sigue. Si ya pudo crearse y no se puede
persistir resultado, detiene el flujo. Restaurar escritura y guardar lo faltante sin recrear. Guardar
diario de llamadas, capturas de entregas en conversación y registro antes/después; comprobar ninguna
publicación ni copia posteriores al bloqueo. El usuario decide reparación o modo de archivar.

## Servicio gh simulado para V15/V16

Instalar solo en fixture, delante de PATH. No ejecutar comandos `gh` reales. El script conserva
estado JSON para retoma y registra cada llamada, incluido título/cuerpo, en un archivo fuera del flujo.
Su salida solo contiene datos sintéticos. Admite `issue list`, `search issues`, `issue create`,
`issue view`; toda otra acción (incluida editar o cerrar) falla. El conductor debe adaptar sus consultas
a estas acciones o registrar la limitación, nunca caer al gh real.

```sh
cat > "$findings_fixture/bin/gh" <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
base = pathlib.Path(os.environ['findings_fixture'])
state_path = base / 'gh-state.json'
log = base / 'evidence' / 'gh-calls.jsonl'
mode = os.environ.get('GH_FAKE_MODE', 'ok')
state = json.loads(state_path.read_text()) if state_path.exists() else {'issues': [], 'next': 100}
def flag(name, default=''):
    return args[args.index(name)+1] if name in args else default
def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)
body = pathlib.Path(flag('--body-file')).read_text() if '--body-file' in args else flag('--body')
with log.open('a') as f:
    f.write(json.dumps({'args': args, 'mode': mode, 'title': flag('--title'), 'body': body})+'\n')
if mode == 'denied': fail('permiso denegado')
query = args[:2] == ['issue', 'list'] or args[:2] == ['search', 'issues']
if query:
    if mode == 'search_denied': fail('sin acceso a consulta')
    result = list(state['issues'])
    if mode == 'duplicates':
        result += [{'number': 49, 'url': 'https://example.invalid/fixture/legacy/issues/49', 'title': 'Lector heredado', 'body': 'reader("a\\nb") pierde b', 'repository': 'fixture/legacy'}]
    print(json.dumps(result))
elif args[:2] == ['issue', 'create']:
    if mode in ['service_error', 'rejected']: fail('fallo conocido sin creación: '+mode)
    repo = flag('--repo', flag('-R', 'fixture/product'))
    number = state['next']; state['next'] += 1
    issue = {'number': number, 'url': 'https://example.invalid/'+repo+'/issues/'+str(number), 'title': flag('--title'), 'body': body, 'repository': repo}
    state['issues'].append(issue); state_path.write_text(json.dumps(state))
    if os.environ.get('GH_FAKE_AFTER_CREATE_LOCK') == '1':
        flow = pathlib.Path(os.environ['findings_flow'])
        (flow/'hallazgos.md').chmod(0o444)
        (flow/'findings-pending').chmod(0o555)
        flow.chmod(0o555)
    if mode == 'uncertain': fail('respuesta ilegible tras posible creación')
    print(json.dumps(issue) if '--json' in args else issue['url'])
elif args[:2] == ['issue', 'view']:
    if mode == 'verify_fail': fail('lectura no disponible')
    ref = args[2] if len(args) > 2 else ''
    issues = list(state['issues']) + [{'number': 49, 'url': 'https://example.invalid/fixture/legacy/issues/49', 'title': 'Lector heredado', 'body': 'reader("a\\nb") pierde b', 'repository': 'fixture/legacy'}]
    repo = flag('--repo', flag('-R'))
    found = [i for i in issues if ref in [str(i['number']), i['url']] and (not repo or i['repository'] == repo)]
    if not found: fail('no encontrado')
    print(json.dumps(found[-1]))
else: fail('acción no admitida por el fixture')
PY
chmod 755 "$findings_fixture/bin/gh"
export PATH="$findings_fixture/bin:$PATH"
export GH_FAKE_MODE=ok
command -v gh
```

Esperado: `command -v` señala el fixture. Estado y llamadas sobreviven a la reapertura. No borrar el
estado para retomar un caso incierto. Para otro caso independiente usar otro fixture o respaldar y
reiniciar el estado conscientemente antes de cualquier intención.

## V15: decisión por hallazgo y cierre

Preparar cierre vacío: debe declarar ausencia sin preguntas de hallazgos ni llamadas externas. Luego
preparar mezcla de published, linked, discarded, resolved_in_flow, uncertain y pending, incluidos
respaldos e incidencia de recepción. Resumen inicial/final debe ser fiel; resueltos no se proponen.

```sh
export GH_FAKE_MODE=duplicates
```

El conductor lee destinos desde AGENTS del fixture y consulta antes de preguntar. Conservar consultas,
fecha y coincidencias; mostrar `<id>/H-n`, destino, título y cuerpo exactos saneados y faltantes heredados.
En fixtures separados observar: publicación confirmada; descarte; silencio; respuesta parcial; cambio de
destino/contenido; proyecto sin destino (quitar esa línea de AGENTS del fixture); duplicado nuevo y
heredado confirmado; petición anticipada explícita. Sin respuesta/elección queda pending, respuesta
parcial solo tramita decididos, cambio requiere consulta y confirmación nuevas. Aprobar archive sin
confirmar issue no publica. Vínculo requiere confirmación/lectura y no edición del existente. Consultas
sin coincidencias no son triage definitivo. Guardar decisiones exactas, llamadas y estados; no migrar
heredados ni asignar prioridad, host o conductor.

## V16: creación, lectura, incertidumbre y retoma

Cada caso parte de nuevo fixture salvo la retoma del mismo caso:

| GH_FAKE_MODE | Esperado |
| --- | --- |
| ok | Intención autorizada guardada/releída, creación, resultado inmediato, lectura de destino/contenido y published con número/URL. |
| duplicates | Vínculo confirmado y leído queda linked; ninguna creación ni edición. |
| verify_fail | Creación ocurrió; guardar número/URL, lectura falla: uncertain y advertencia de que puede existir. |
| uncertain | Creación conservada en gh-state aunque respuesta falla: uncertain, ninguna recreación ciega. |
| denied | Pending por permiso; contenido listo para publicar a mano. |
| search_denied | Pending por falta de acceso a duplicados; no creación. |
| service_error | Pending, causa y contenido manual; no issue creado. |
| rejected | Pending por contenido rechazado, causa y contenido manual. |

Tras verify_fail/uncertain cortar sesión y volver con `GH_FAKE_MODE=ok`, conservando estado. También
preparar intención persistida sin resultado (cortar entre creación y recepción): al retomar se considera
uncertain y consulta antes de cualquier otra creación. Debe encontrar el existente o mantener
incertidumbre si no puede comprobar; nunca volver a crear a ciegas. Los publicados verificados no se
republican. uncertain entrega referencias conocidas y pide comprobar destino, sin texto «listo para
republicar». Guardar historial fechado y diferencias pending/uncertain. Archive continúa salvo las
detenciones V14; la copia incluye causas, contenido y referencias.

## V17: comparación y conservación del origen

Preparar flujo con published, pending, uncertain, respaldos y evidencia recuperada de corrida. Observar
que tramitación y persistencia preceden a la copia. El mecanismo de prueba declarado copia todo a vault;
no es autorización para retirar. Guardar el orden en el diario y revisar cambios sin commit cuando
`.plans/` esté versionado; avisar al usuario antes de copiar/retirar y dejar que decida si los commitea.

Después de invocar el mecanismo declarado, comparar inventario y hashes sin seguir enlaces:

```sh
export findings_copy="$findings_fixture/vault/sample"
python3 <<'PY'
import hashlib, os, pathlib
source = pathlib.Path(os.environ['findings_flow'])
copy = pathlib.Path(os.environ['findings_copy'])
def fail(error):
    raise error
def inventory(root):
    result = {}
    # onerror propaga un subdirectorio ilegible: sin él, os.walk lo omite y la comparación pasaría sin verlo.
    for base, dirs, files in os.walk(root, onerror=fail, followlinks=False):
        for name in dirs+files:
            p = pathlib.Path(base)/name
            if p.is_symlink(): raise RuntimeError('enlace requiere inspección: '+str(p))
        for name in files:
            p = pathlib.Path(base)/name
            result[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result
assert copy.is_dir(), 'destino ausente'
a, b = inventory(source), inventory(copy)
assert a == b, (a, b)
print(a)
for p in sorted(copy.rglob('*.md')):
    print(p.relative_to(copy), p.read_text())
PY
```

Guardar inventarios, hashes y lectura desde destino de registro, resultados, pendientes y evidencia.
Retirar temporal/corrida original y repetir lectura suficiente. Inyectar en **copias de prueba** archivo
omitido, enlace externo o permisos de lectura denegados: debe declarar preservación pendiente y
conservar origen íntegro, sin afirmar verificación ni retirar. Restaurar permisos. En otro fixture
quitar mecanismo de archivo de AGENTS: no improvisar copia, preservar origen y declarar pendiente.
Verificar solo precondiciones del retiro: comparación completa y aprobación específica del mecanismo;
el retiro real queda al conductor y su mecanismo. Retomar desde el vault queda fuera del cambio.

## V20: sincronización, familias, gates y compatibilidad

El conductor ejecuta en el checkout, **sin writer del flujo en curso**:

```sh
./bin/sdd-ai agents sync
cmp skills/sdd-ai/SKILL.md .claude/skills/sdd-ai/SKILL.md
cmp skills/sdd-ai/SKILL.md .agents/skills/sdd-ai/SKILL.md
./bin/sdd-ai doctor
```

Guardar salidas; copias generadas e ignoradas no entran al commit. `doctor` real puede invocar Claude:
es exclusivamente del conductor. V19/V21 son filas de sdd verify. Comparar todos los agentes contra sus
renderizadores como hace `test/agents.unit.test.ts`; el siguiente script simula detección de agente viejo,
sin ejecutar ningún CLI, en fixture separado:

```sh
node --input-type=module <<'JS'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const repo = process.env.findings_source
const { syncAgents, agentsState } = await import(`${repo}/src/agents.ts`)
const { READ_ONLY_ROLES } = await import(`${repo}/src/types.ts`)
const { doctor } = await import(`${repo}/src/doctor.ts`)
const root = mkdtempSync(join(tmpdir(), 'findings-agent-stale-'))
const profiles = Object.fromEntries(READ_ONLY_ROLES.map(r => [r, { claude: { model: 'opus' }, codex: { model: 'gpt-6-sol' } }]))
syncAgents(root, repo, profiles)
const path = join(root, '.codex/agents/sdd-ai-explore.toml')
writeFileSync(path, readFileSync(path, 'utf8')+'\n# diferencia real\n')
const state = agentsState(root, repo, 'codex', 'explore', profiles)
if (state !== 'stale') throw Error('No detectó stale')
const exec = (family, args) => ({ status: 0, stdout: args.includes('--version') ? '1.0.0' : readFileSync(join(repo, 'test/fixtures', family === 'claude' ? 'claude-help.txt' : args.includes('resume') ? 'codex-exec-resume-help.txt' : 'codex-exec-help.txt'), 'utf8') })
const result = doctor(exec, undefined, undefined, undefined, { copies: [{ path, state, family: 'codex', role: 'explore' }] })
if (!result.warnings?.some(w => w.code === 'agent_copy_stale' && w.message.includes(path))) throw Error('Sin aviso con ruta')
console.log(JSON.stringify(result))
syncAgents(root, repo, profiles)
if (agentsState(root, repo, 'codex', 'explore', profiles) !== 'ok') throw Error('No restauró')
JS
```

Tras sincronizar, reabrir sesiones y recorrer conductor/workers Claude y Codex con y sin hallazgos.
Los recorridos reales Claude, declaraciones del motor y recuperación de rollout quedan exclusivamente
para el conductor; no se ejecutan desde workers. Registrar familia, sesión, recepción y consolidación.

En flujo normal de prueba detenido en spec y luego plan-tasks, guardar `sdd status` y fingerprints de
`readFlow(...).facts.fingerprints` antes y después de editar hallazgos, recibir un reporte, publicar un
issue simulado y completar una tarjeta simulada. Debe seguir gate pendiente con mismas huellas hasta
respuesta humana; ninguna operación del registro concede autorización. No usar una tarjeta como gate.
Conservar resultados de corridas vivas bajo contrato anterior y nuevo; una reanudación antigua no
recibe findings_missing por campos nuevos. Documentar que rollback no borra registros y que se reciben
corridas con findings con versión compatible antes de volver a un binario que rechace el campo.
