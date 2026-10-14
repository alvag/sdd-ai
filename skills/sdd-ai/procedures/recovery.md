<!-- Origen: SKILL.md:873–906. Traslado de la base a70c7da. -->

Apoyos: [errors](../references/errors.md); [reception](../references/reception.md); [writer](../references/writer.md); [adopción](../references/adoption.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir, adopción al adoptar copias y retomar un flujo existente, y los demás al usar su contrato.

## 9. El estado de un flujo SDD

Al retomar consulta `./bin/sdd-ai sdd status <id>`. Solo en Codex, después de `/fork` o `/new`,
esa consulta liga la sesión nueva al flujo antes de continuar o recibir; no acredita entrega ni
transferencia nativa. Adoptar no autoriza reparar, recibir o aprobar. Antes de sincronizar con writer
reservado espera cese comprobado y cosecha; ante `cessation_uncertain`, detente sin escrituras en
el árbol ni liberación por tu cuenta y pregunta al usuario.

`sdd status` calcula el estado de un flujo de `.plans/<id>/` desde sus archivos, en solo lectura: su
profundidad, sus gates, sus tasks, el paso siguiente y lo que lo bloquea. `sdd approve` registra la
aprobación de un gate con la huella de sus artefactos y la de los gates anteriores: si después
cambian, `status` devuelve el flujo a ese gate. Tras registrar, `approve` sincroniza por defecto los
headers existentes; no depende de una edición posterior de `sdd-flow`.

```
./bin/sdd-ai sdd start <id> [--topic <tema>] [--base-branch <rama>]
./bin/sdd-ai sdd start <id> --apply --depth <corta|normal|completa> --risk <low|high|unknown> --change-type <tipo> --request <archivo> [--topic <tema>] [--base-branch <rama>]
./bin/sdd-ai sdd branch <id> [--prefix <p>]
./bin/sdd-ai sdd branch <id> --apply [--current | --prefix <p>] [--refreeze]
./bin/sdd-ai sdd status [<id>]
./bin/sdd-ai sdd approve <id> <gate> [--conductor claude|codex]
./bin/sdd-ai sdd phase <id> [--request <archivo>] [--context <archivo>] [--families <f>] [--conductor claude|codex] [--deadline <s>]
```

- **Lo que trae `sdd status <id>`**: `depth`, los `gates` de esa profundidad con su `state`
  (`pending`, `approved`, `approved_unfingerprinted` o `stale`), las `tasks` con la primera pendiente,
  `next` con su `step`, y `blocked_reasons` y `notes`, cada una con su `code` y su `detail`. Sale con 0
  aunque el flujo esté bloqueado; con bloqueos, `next` es `resolve_blockers`. Sin id, lista los
  flujos de `.plans/` con su `next`. El paso `branch`, con el comando `sdd branch <id>`, aparece
  antes de `plan` si falta `branch` en el handoff; en corta, antes de que exista `plan.md`.
- **`sdd approve` responde el mismo estado que `status`, con su `next`.** Si sigue un gate,
  `next.question` trae su pregunta canónica, la misma que `status`; si sigue una fase,
  `next.command` trae su comando.
- **`next.task` es el id `T<n>` de la primera task pendiente.** Falta si esa línea no sigue la
  gramática `- [ ] **T<n> — <título>**`; en ese caso, la línea queda tal cual en
  `tasks.first_pending`.
- **`status` es el estado del flujo para sdd-ai, y `sdd-flow` sigue leyendo sus headers.** Cuando
  discrepan, `status` lo dice en `notes`: `header_behind` si una aprobación registrada todavía no
  llegó al header, y `header_ahead` si el header da por aprobado un gate cuya aprobación registrada
  venció.

Ante `resolve_blockers`, lee `blocked_reasons` y `next.detail`: detén el avance y atiende únicamente la recuperación vigente de la operación afectada. No reconstruyas `next` ante consulta fallida. Un step desconocido o material ausente, desactualizado o ilegible detiene la operación: comunica el diagnóstico y espera decisión humana antes de reparar.

Recuperación por operación: [inicio](start.md), [rama](branch.md), [aprobaciones](approvals.md), [fases documentales](../references/document-phases.md), [devolución](../references/document-revision.md), [implementación](implement.md), [verificación](verify.md), [commit](review-and-commit.md), [init](../references/init.md), [prune](../references/prune.md).
