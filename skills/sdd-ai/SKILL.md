---
name: sdd-ai
description: Delega una tarea de solo lectura (explorar, buscar, resumir código) a un worker de Claude o Codex elegido por la config del repo, o revisa un diff congelado con un revisor aislado. Usar cuando el usuario pide "delega esto a un worker", "usa sdd-ai", "que otro agente explore esto" o "revisa este diff".
---

# sdd-ai: despachar un worker read-only

El binario decide qué familia hace el trabajo y por qué vía. Tú escribes el encargo, sigues lo que
responde y le preguntas al usuario ante cualquier fallo. Todo comando imprime un JSON.

## 1. Escribe el encargo

Escribe el encargo en un archivo. El worker no ve esta conversación: el encargo tiene que ser
autosuficiente (qué hacer, dónde mirar, qué formato de respuesta).

## 2. Pide el despacho

```
./bin/sdd-ai run --prompt-file <archivo> --conductor <claude|codex> --conductor-model <tu modelo>
```

- `--conductor` es tu propia familia: `claude` si eres Claude Code, `codex` si eres Codex.
- Si conoces tu esfuerzo de razonamiento, agrégalo con `--conductor-effort <valor>`. Codex no lo
  expone al shell, así que sin el flag una caída a tu familia no puede conservarlo.
- Agrega `--role <rol>` cuando la tarea tiene un rol claro: `code-review` para revisar código,
  `refute` para refutar, `investigate` para una causa raíz, `design-review`, `debate` o
  `counter-plan`. Sin el flag, el rol es `explore`.
- Agrega `--families claude` o `--families codex` solo si el usuario dijo "solo Claude" o
  "solo Codex" para esta tarea.
- **Si eres Codex** y la respuesta va a salir por la vía `process`, ejecuta `run` pidiendo
  escalamiento (fuera del sandbox): el worker necesita red. Si no sabes la vía de antemano, pide
  escalamiento siempre.

## 3. Sigue la respuesta

**`"via": "native"`**: lánzalo tú, sin heredar esta conversación.

- Claude Code: herramienta `Agent` con `subagent_type` igual al valor de `agent` (hay un agente
  por rol, como `sdd-ai-explore` o `sdd-ai-code-review`).
- Codex: `spawn_agent` con `agent_type` igual al valor de `agent`, sin heredar el historial.
- En los dos, el mensaje es: `Tu encargo está en <prompt_file>. Léelo completo y cúmplelo.`
- Si la respuesta trae `model` o `effort`, pásalos a la herramienta: en Codex, `model` y
  `reasoning_effort` de `spawn_agent`; en Claude Code, `model` del `Agent` con el alias que
  corresponda (`opus`, `sonnet`, `haiku` o `fable`).
- Si la respuesta trae `warnings`, muéstraselas al usuario antes de lanzar: dicen qué parte del
  perfil pedido no se puede aplicar (por ejemplo, el esfuerzo de un subagente de Claude Code).
- Si tu herramienta rechaza el agente, el modelo o el esfuerzo, muéstrale el error al usuario tal
  cual y no reintentes: el reintento automático existe solo en la vía `process`.

**`"via": "process"`**: el binario ya lanzó al worker. Espera el resultado:

```
./bin/sdd-ai wait <id>
```

En Claude Code, con timeout de Bash de 600000 ms. Si sale con código 3, la corrida sigue viva:
vuelve a llamar a `wait`. Con código 0, el resultado está en `result`.

Si `wait` trae `warnings`, muéstraselas al usuario. Hay dos casos:

- `retry`: el CLI rechazó el modelo o el esfuerzo pedido y el binario reintentó una sola vez sin ese
  campo. Dice qué campo, qué se pidió, qué se usó y el diagnóstico del proveedor.
- `resume`: se agotó el tope y el binario reanudó la misma sesión una vez, pidiéndole que entregue
  lo que tenga. Una respuesta reanudada puede ser más corta: díselo al usuario.

## 4. Revisar un diff

Para la revisión de un diff (la final antes de un commit, o la de un commit ya hecho) usa `review`
en vez de un encargo a mano con `run --role code-review`. El binario congela el diff, arma el
encargo, aísla al revisor y valida su respuesta por código: tú no escribes el encargo ni juzgas si
el reporte está completo.

```
./bin/sdd-ai review start --base <ref> [--head <ref>] [--context <ruta>]... --conductor <claude|codex>
```

- `--base` es obligatoria: el commit contra el que se revisa (en un flujo SDD, el `base_commit` del
  plan). Con `--head <ref>` se revisa el diff entre dos commits; sin él, el árbol de trabajo.
- **Archivos nuevos:** solo entran los que están en el índice. Antes de revisar, marca los nuevos
  que son parte del cambio con `git add -N <ruta>`. La respuesta trae `left_out`: los archivos
  nuevos que quedaron afuera. Si alguno era parte del cambio, agrégalo y vuelve a correr `start`.
- Pasa la spec, el plan y las tareas con `--context`: sin ellos, el revisor no puede juzgar el eje
  SPEC.
- El revisor es de la familia opuesta al autor del diff (`--author`, que por defecto es la tuya). Si
  la respuesta trae `same_family` en `degradations`, avísale al usuario: revisó un agente fresco de
  la misma familia, sin la diversidad de la otra.
- **Si eres Codex**, pide escalamiento para `review start`, igual que para `run`.

Después, `./bin/sdd-ai wait <id>`, igual que en la vía `process`. Al terminar, `wait` devuelve la
misma vista que `./bin/sdd-ai review status <id>`: los ejes `SCOPE`, `SPEC` y `QUALITY`, los
hallazgos, `out_of_scope` (lo grave que ya estaba antes del cambio) y `next`.

- **`stale: true`**: el diff cambió desde la revisión y el veredicto ya no vale para lo que hay.
  Propón la revisión nueva que trae `next`.
- **`unavailable`**: el revisor no pudo inspeccionar, o su respuesta no se pudo admitir ni después
  de una corrección. Muestra `reason` y `detail` y pregunta si revisa de nuevo.
- El recibo informa: no autoriza el commit ni el push. Un eje en `fail` se resuelve o se declara,
  como en cualquier revisión.

## 5. Si algo falla

- **`launch_failed`**: muestra `reason` y `detail` al usuario y **pregúntale** si quiere caer a tu
  familia, tu modelo y tu esfuerzo (`fallback`). Solo con un sí, corre el comando exacto que trae
  `next` (reutiliza el encargo con `--retry` y fija `--families`, `--model` y `--effort`). Nunca
  cambies de familia sin preguntar.
- **Rol `implement`**: da un error de uso porque todavía no hay un worker que escriba. Díselo al
  usuario y no lo cambies por otro rol sin preguntarle.
- **Rol `pr`**: ahora se llama `code-review`. El error de migración vale para `--role pr` y para una
  clave `pr:` en `.sdd-ai/workers.yml`; no edites la config sin permiso.
- **`agents_stale`**: los agentes generados están desactualizados. Propón
  `./bin/sdd-ai agents sync` (en Codex, con escalamiento: escribe en `.codex/`) y reabrir la sesión.
- **`config_missing`**: muestra el bloque que trae `next` y pregunta si lo creas. No escribas la
  config sin permiso.
- Para cortar una corrida: `./bin/sdd-ai cancel <id>`.

Después de cada `./bin/sdd-ai agents sync` hay que reabrir la sesión para que el CLI cargue los
agentes y esta skill.
