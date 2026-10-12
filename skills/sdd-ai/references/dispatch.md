<!-- Origen: SKILL.md:208–237. Traslado de la base a70c7da. -->

Apoyos: [reception](reception.md); [findings](findings.md); [errors](errors.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## 1. Escribe el encargo

Escribe el encargo en un archivo temporal fuera del repositorio. El worker no ve esta conversación:
el encargo tiene que ser autosuficiente (qué hacer, dónde mirar, qué formato de respuesta).

## 2. Pide el despacho

```
./bin/sdd-ai run --prompt-file <archivo> --conductor <claude|codex> --conductor-model <tu modelo>
```

- `--conductor` es tu propia familia: `claude` si eres Claude Code, `codex` si eres Codex.
- Si conoces tu esfuerzo de razonamiento, agrégalo con `--conductor-effort <valor>`. Codex no lo
  expone al shell, así que sin el flag una caída a tu familia no puede conservarlo.
- Agrega `--role <rol>` cuando la tarea tiene un rol claro: `code-review` para revisar código,
  `refute` para refutar, `investigate` para una causa raíz, `design-review`, `debate` o
  `counter-plan`, e `implement` para delegar una escritura ([writer](writer.md)). Sin el flag, el rol es
  `explore`.
  `explore` e `investigate` pueden buscar en la web; los demás roles trabajan solo con el encargo y
  el repositorio.
- Agrega `--families claude` o `--families codex` solo si el usuario dijo "solo Claude" o
  "solo Codex" para esta tarea.
- Con `--role explore|investigate`, agrega `--flow <id>` para anexar los antecedentes guardados por
  `sdd start` al encargo ([inicio](../procedures/start.md)). No va con otros roles ni con `--retry`: este último conserva el
  encargo congelado. El archivo original no cambia; el texto compuesto queda en `prompt.md` y llega
  al worker tanto por proceso como por la vía nativa.
- **Si eres Codex** y la respuesta va a salir por la vía `process`, ejecuta `run` pidiendo
  escalamiento (fuera del sandbox): el worker necesita red. Si no sabes la vía de antemano, pide
  escalamiento siempre.

