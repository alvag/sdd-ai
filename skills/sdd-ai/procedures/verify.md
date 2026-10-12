<!-- Origen: SKILL.md:1357–1406. Traslado de la base a70c7da. -->

Apoyos: [aprobaciones](approvals.md), antes de presentar preguntas canónicas o registrar decisiones; [writer](../references/writer.md); [hooks](../references/hooks.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

### Verificar la implementación: `sdd verify`

```
./bin/sdd-ai sdd verify <id> [--baseline | --attest <fila> | --takeover --reason <texto>] [--conductor claude|codex]
```

- **La corrida final**, sin flags de modo, ejecuta el contrato cuando el paso es `verify` o
  `review_and_commit`, con todas las tasks hechas.
- **`--baseline`** mide sobre la base antes del primer writer, en `implement`. Exige que el árbol
  coincida con la base, salvo los archivos del flujo. Guarda la medición sin pasar a `verified`;
  si escribió en el árbol, limpia las rutas que informa antes de lanzar el writer.
- **`--attest <fila>`** acredita una fila `manual` con la respuesta del usuario a su pregunta
  canónica, atada al candidato y al plan aprobado. La corrida final trae las preguntas pendientes;
  lee [aprobaciones](approvals.md) para presentar la pregunta canónica por familia y conservar su prueba; acredita la fila antes de repetir la corrida final.
- **`--takeover --reason <texto>`** declara la toma del conductor sobre la cadena de un writer de
  fase antes de verificar el árbol actual. Registra autoría mezclada y cierra esa cadena. Va solo
  con la corrida final, y el motivo explica la toma.

**El contrato y el recibo.** `## Verification` contiene el bloque `sdd-ai-verification-v1`, con
filas `test`, `build`, `inspection` o `manual`. Las rutas de `implementation_paths` de una fila
con reversión deben existir en la base: no se puede confirmar revirtiendo un archivo que la base
no tiene. El recibo guarda cada fila con su resultado y su confirmación por reversión, el candidato
y la huella del plan aprobado. Queda en el directorio Git del checkout, bajo
`sdd-ai/verify/<recibo>/receipt.json`, junto a las salidas de la ejecución. Un recibo final verde
proyecta `## Verify` en el plan y deja `status: verified`.

**Errores y cómo seguir:**

| Código | Cuándo sale y qué hacer |
|---|---|
| `contract_prose` | El contrato está en prosa. Republica el plan con `sdd phase <id>` para obtener el contrato estructurado y vuelve a aprobarlo. |
| `contract_invalid` | El bloque estructurado no se admite. Corrige `## Verification` según el diagnóstico y reaprueba el plan. |
| `plan_invalid` | El plan no declara `base_commit`. Declara la base correcta y reaprueba el plan. |
| `plan_not_approved` | Falta una aprobación registrada vigente del gate que cubre el plan. Consulta `status`, haz la pregunta canónica y registra la aprobación. |
| `verify_not_now` | El paso actual no admite el modo pedido. Consulta `status` y completa el paso indicado; la base se mide en `implement` y la corrida final en `verify` o `review_and_commit`. |
| `flow_blocked` | El flujo tiene bloqueos. Consulta `sdd status <id>` y resuelve los motivos antes de verificar. |
| `writer_open` | Sigue abierto un writer del flujo o está ocupada la reserva del repositorio. Espera a que termine con `wait <corrida>` y vuelve a verificar. |
| `baseline_not_clean` | La medición sobre la base encontró cambios fuera del flujo. Devuelve el árbol a la base antes de repetir `--baseline`. |
| `path_invalid` | Una ruta de control o artefacto no tiene la forma segura esperada, por ejemplo un enlace o un archivo no regular. Corrige la ruta indicada sin atravesar enlaces y repite el comando. |
| `restore_conflict` | Una ruta revertida tiene un tercer contenido, distinto del candidato y de la base. Decide con el usuario qué conservar; después borra la intención indicada y repite el comando. |
| `recovery_busy` | Otro comando tiene el lock de recuperación. Espera; si no hay otro comando corriendo, borra el lock que indica el error y repite. |
| `control_unavailable` | No se puede escribir el almacén de control o de recibos en el directorio Git. Corrige el acceso a ese almacén y repite. |
| `approval_missing` | Con `--attest`, falta una respuesta válida o no se pudo leer la sesión. Haz la pregunta canónica de la fila y repite la acreditación. |
| `approval_reused` | Con `--attest`, esa respuesta ya se consumió. Si el usuario quiere acreditar la fila, haz una pregunta nueva y repite. |

**Un `verified` puede vencer.** Con contrato estructurado, vale solo con un recibo final íntegro y
verde que corresponda al árbol actual y al plan aprobado actual. Si el recibo ya no vale,
`status` agrega la nota `verified_stale` y devuelve el paso a `verify`: corre de nuevo la
verificación antes de continuar.

