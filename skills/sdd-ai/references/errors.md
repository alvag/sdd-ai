<!-- Origen: SKILL.md:677–715. Traslado de la base a70c7da. -->

Apoyos: [mod](mod.md); [adopción](adoption.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir, adopción después de sincronizar, y los demás al usar su contrato.

## 7. Si algo falla

- **`launch_failed`**: muestra `reason` y `detail` al usuario y **pregúntale** si quiere caer a tu
  familia, tu modelo y tu esfuerzo (`fallback`). Solo con un sí, corre el comando exacto que trae
  `next` (reutiliza el encargo, el rol y el plazo con `--retry`, y fija `--families`, `--model` y
  `--effort`). Nunca cambies de familia sin preguntar.
- **`launch_failed` con `supervisor_not_started`**: el sistema no lanzó el proceso que supervisa la
  corrida, y el comando que la lanzó ya falló con ese error. No es cosa de la familia, así que no
  propongas caer a la tuya: díselo al usuario y **pregúntale** si la relanza. Solo con un sí, una
  revisión se relanza con el `next` de `./bin/sdd-ai review status <id>` y una corrida de `run`
  con `./bin/sdd-ai run --retry <id>`.
- **`session_unknown`**: una corrida nativa necesita el id de tu sesión (`CLAUDE_CODE_SESSION_ID` en
  Claude Code, `CODEX_SESSION_ID` en Codex), porque sin él ningún hook la dejaría lanzar. Díselo al
  usuario.
- **Rol `implement`**: los errores del writer (`control_unavailable`, `writer_open`, `no_head`,
  `tree_dirty`) y el cese incierto están en [writer](writer.md).
- **Rol `pr`**: ahora se llama `code-review`. El error de migración vale para `--role pr` y para una
  clave `pr:` en `.sdd-ai/workers.yml`; no edites la config sin permiso.
- **`agents_stale`**: el agente generado falta o está desactualizado; el error conserva
  `launch_failed` y no acredita lanzamiento. Propón `./bin/sdd-ai agents sync` (en Codex,
  con escalamiento: escribe en `.codex/`), después de la decisión humana y las guardas de writer.
  Adopta según la familia afectada y la carga observada en [adopción](adoption.md).
- **`doctor` con la skill `stale` o `missing`**: una copia de esta skill (`.claude/skills/` o
  `.agents/skills/`) no coincide con su fuente, o falta, y el CLI está leyendo otra versión. Se
  corrige con `./bin/sdd-ai agents sync` tras decisión humana y las guardas de writer; adopta la
  skill según runner y condición en [adopción](adoption.md), sin exigir hilo nuevo solo para la skill de Codex.
- **`config_missing`**: muestra el bloque que trae `next` y pregunta si lo creas. No escribas la
  config sin permiso.
- Para cortar una corrida: `./bin/sdd-ai cancel <id>`. En una revisión detiene el trabajo en curso y
  no lanza los que faltan. En una nativa sin lanzar o con una reserva sin confirmar, solo la marca
  como cancelada: no detiene a un agente que quizá llegó a arrancar.
- **Codex no corre los hooks del proyecto**: si al abrir avisa "Hooks need review", o los hooks no
  responden, pídele al usuario que los apruebe en `/hooks`. Hace falta la primera vez y cada vez que
  cambian las definiciones de `.codex/hooks.json`.
- **Límites declarados de `review`**: si el supervisor muere en medio de una ronda, no deja su
  registro y el relanzamiento corre todos los trabajos, no solo los que faltaban. Las sesiones del
  revisor Claude dejan un directorio de proyecto en `~/.claude/projects/`: el binario solo borra su
  temporal del sistema.

Después de cada `./bin/sdd-ai agents sync`, sigue [adopción](adoption.md) por runner, componente
y carga previa observada. Sesión nueva permanece como fallback; no anula las alternativas comprobadas.


La vigencia comprende SKILL.md, procedures/ y references/. Ante material ausente o distinto, comunica sus rutas y propone `agents sync`; con fuente no comprobable, restaura o revisa primero la fuente; con copia ilegible, atiéndela antes de sincronizar. Espera la decisión humana antes de reparar y consulta [adopción](adoption.md) para adoptar con sus condiciones y fallback. Con writer reservado espera cese comprobado y cosecha; ante `cessation_uncertain`, detente sin escrituras ni liberación autónoma y pregunta al usuario. No inventes instrucciones sustitutas.
