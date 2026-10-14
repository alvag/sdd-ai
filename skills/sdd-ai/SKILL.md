---
name: sdd-ai
description: Delega una tarea de solo lectura (explorar, buscar, resumir código) o una escritura acotada a un worker de Claude o Codex elegido por la config del repo, revisa un diff congelado con un revisor aislado, o lanza en un worker la fase de un flujo SDD. Usar cuando el usuario pide "delega esto a un worker", "usa sdd-ai", "que otro agente explore esto" o "revisa este diff".
---

# sdd-ai: despachar un worker

El binario decide qué familia hace el trabajo y por qué vía. Tú escribes el encargo, sigues lo que
responde y le preguntas al usuario ante cualquier fallo. Todo comando imprime un JSON.


## Reglas permanentes

El usuario conserva la autoridad sobre alcance, aprobaciones, recuperación y publicación. `next` orienta, pero no concede permisos ni sustituye gates. No suplas respuestas humanas, no apruebes desde un worker ni reutilices una respuesta para otra decisión. Conserva las preguntas canónicas y la prueba vigente. No eludas guardas. Las decisiones aprobadas en plan y tasks siguen siendo vinculantes; lo que el pedido o un AC no sostiene no es exigencia.

Mientras corre un writer, no escribas en su árbol, incluidos registros del flujo y sincronización de agentes, skill o mod. La reserva permanece hasta el cese comprobado y la cosecha; `cessation_uncertain` exige detenerse sin tocar el árbol. Lee [writer](references/writer.md) y [recepción](references/reception.md) para recibir. Un aviso o reporte no acredita entrega, tasks ni aprobación.

Todo encargo delegado debe prohibir ejecutar `claude`, directamente o mediante scripts que lo lanzan: `npm run test:mods`, la preparación de las declaraciones del motor y la recuperación del rollout. Una comprobación necesaria que exige Claude queda pendiente para el conductor; no la vuelve a delegar y la completa antes del commit.

Captura hallazgos fuera de alcance conforme a [hallazgos](references/findings.md); registrar no autoriza corregir ni ampliar el alcance. Durante un writer, decláralos en conversación y persiste después de su cosecha.

## Consulta y carga explícita

Al empezar o retomar un flujo y después de recibir un resultado que pueda cambiar su estado, consulta `./bin/sdd-ai sdd status <id>`. Sin id, `./bin/sdd-ai sdd status` lista flujos para identificarlos. Antes de actuar, lee explícitamente el destino de `next.step` en este índice y los apoyos declarados que necesite la operación. Las rutas de lectura son relativas al directorio de la skill instalada; los comandos mantienen rutas del checkout. No cargues todo el material como requisito de entrada.

Un fallo de consulta detiene la conducción: no reconstruyas `next`. Los bloqueos detienen el avance. Un step desconocido o material ausente, desactualizado o ilegible detiene la operación: comunica el diagnóstico y espera la decisión humana antes de sincronizar o reparar; no inventes instrucciones sustitutas. Adopta agentes o skill según runner, componente y carga previa observada en [adopción](references/adoption.md); usa las alternativas comprobadas y conserva sesión nueva como fallback con sus límites. Respeta las reservas de writers antes de sincronizar.

`next.command` de `wait` exige esperar y recibir. Una continuación con `--context` exige obtener contexto del repositorio y respuestas humanas a las preguntas; no autoriza otra fase. Sin comando, interpreta `next.detail` sin inventar un lanzamiento. La aprobación externa pendiente conserva su espera.

## Índice de next.step

| next.step | Procedimiento |
|---|---|
| no_artifacts, depth | [start](procedures/start.md) |
| resolve_blockers | [recovery](procedures/recovery.md) |
| specify | [specify](procedures/specify.md) |
| branch | [branch](procedures/branch.md) |
| plan | [plan](procedures/plan.md) |
| tasks | [tasks](procedures/tasks.md) |
| gate, external_gate | [approvals](procedures/approvals.md) |
| implement | [implement](procedures/implement.md) |
| verify | [verify](procedures/verify.md) |
| review_and_commit | [review-and-commit](procedures/review-and-commit.md) |
| push, open_pr, archive | [close](procedures/close.md) |

## Operaciones independientes

- `run`: [preparación y despacho](references/dispatch.md), [recepción](references/reception.md); para escritura, [writer](references/writer.md).
- `review`: [diff](references/diff-review.md) o [artefacto](references/artifact-review.md), según el candidato.
- `init`: [preparación del checkout](references/init.md); `--reuse-config` copia exclusivamente configuración.
- `prune`: [retención](references/prune.md).
- `recall`: [antecedentes](references/recall.md).
- Fallos: [errores](references/errors.md); guardas: [hooks](references/hooks.md); presentación y espera en Claude: [mod](references/mod.md).

Los procedimientos declaran sus apoyos y cuándo leerlos. Todas las tasks, de cualquier actor, deben completarse antes de verify final. Conserva el orden verify, revisión vigente y ensayo con consentimiento humano antes de aplicar commit. Las comprobaciones precommit reservadas al conductor siguen siendo precommit.
