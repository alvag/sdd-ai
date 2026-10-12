<!-- Origen: SKILL.md:1616–1652. Traslado de la base a70c7da. -->

Apoyos: [errors](errors.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## 12. Buscar antecedentes: `recall`

El conductor corre `./bin/sdd-ai recall "<tema>"` al arrancar un flujo, antes de rediseñar algo o de repetir
una investigación, ante «¿por qué se decidió X?» y cuando el código cita un motivo que no está escrito.
Varios argumentos se unen en un tema. Primero busca todos los términos y, si una fuente no encuentra nada,
busca cualquiera; cada fuente declara `match: all|any`, sus aciertos y `truncated`.

Las cuatro fuentes son Engram, el vault, `.plans/` y Git (mensajes de todas las ramas). El vault manda
sobre lo que decidió un flujo terminado; Engram aporta sesiones y descubrimientos que pueden estar viejos;
el código y Git mandan sobre el estado actual. `.plans/` muestra el trabajo del checkout y los flujos
abiertos de otros worktrees. Ante una contradicción, se declara y se verifica en el código. Recordar algo
no autoriza una acción. Cada dato se cita con su origen: ruta y línea, id de Engram o commit.

- `ok`: leer los aciertos; una lista vacía no prueba que no existan antecedentes fuera del alcance buscado.
- `not_configured`: el vault no tiene `knowledge-vault.path_vault` en `.sdd-ai/config.yml`; no se descubre otro.
- `unresolved`: la identidad Git no determina un proyecto único del vault; revisar los candidatos y el registro,
  sin elegir por nombre del directorio.
- `unavailable`: falta el CLI de Engram; las demás fuentes siguen respondiendo.
- `error`: leer `reason` y resolver el problema de esa fuente; las demás responden con normalidad.

El cuerpo completo de Engram se lee con `mem_get_observation` del servidor MCP de Engram. El binario usa
solo `engram search`, desde la raíz y sin `--project` ni `ENGRAM_PROJECT`: Engram resuelve el proyecto.
Las otras fuentes se amplían leyendo la ruta citada o con `git show <sha>`.

En Codex se corre con escalamiento porque Engram toma un lock en el home del usuario, incluso al buscar.
`recall` no escribe archivos propios ni crea corridas, y no restaura una verificación pendiente. Engram
puede escribir su lock y la vinculación del proyecto en Git por su cuenta.

El conductor hace la búsqueda y pasa los extractos al worker, nunca el verbo: la guarda niega `recall`
a los subagentes. Se mantiene la prohibición de consultar memoria, web y vault en los workers de fase.

Engram busca variantes con a lo sumo una vocal marcada por tramo de letras; un tramo con dos marcas,
como «lingüística», puede no encontrarse desde la forma sin marcas. `incomplete` avisa cuando se recortan
las variantes a 64 o cuando la intersección quedó vacía con alguna lista de 20 aciertos: ese cero puede
deberse al tope. El vault, `.plans/` y Git pliegan todas las marcas de vocales, conservando la ñ y la ç.
`truncated` indica el recorte de aciertos o grupos; `omitted_lines` y `cut` indican líneas omitidas y texto
cortado. Los fallos parciales no hacen fallar el verbo; solo un uso inválido produce `usage`.
