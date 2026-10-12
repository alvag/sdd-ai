<!-- Origen: SKILL.md:536–577. Traslado de la base a70c7da. -->

Apoyos: [aprobaciones](../procedures/approvals.md), antes de presentar preguntas canónicas o registrar decisiones; [diff-review](diff-review.md); [reception](reception.md); [document-revision](document-revision.md). Lee los que correspondan antes de la operación; errores al fallar, recepción al recibir, revisión antes de decidir y los demás al usar su contrato.

## 5. Revisar un artefacto

Para revisar una spec, un plan o unas tasks antes de su gate usa `review` con `--artifact`. El
binario congela el documento desde el árbol aunque Git lo ignore, lo revisa contra sus insumos de
declarados en este procedimiento y valida la respuesta por código. El revisor es de la familia opuesta al autor, con el perfil
de `design-review`. No hay nivel de riesgo, lentes, lotes ni refutador.

```
./bin/sdd-ai review start --artifact <ruta> --kind spec|plan|tasks <insumos> [--context <ruta>]... --conductor <claude|codex>
```

- **Los insumos van con su rol**, y cada tipo exige los suyos:
  - una spec: `--request <pedido>`;
  - un plan: `--spec <spec>`;
  - unas tasks: `--spec <spec> --plan <plan>`.
- **El pedido de una spec se escribe a un archivo** con el pedido original de la persona y las
  decisiones que lo modificaron después (por ejemplo, las respuestas de clarify). Nunca con un
  resumen de la spec: el eje SPEC compara la spec contra el pedido, y un pedido copiado de la spec
  la aprueba sola. **Muéstrale ese archivo al usuario en el gate**, para que compruebe que es fiel.
- **Código:** el revisor no lee el repo. Si el plan o las tasks afirman algo del código ("`resolve`
  está en `src/cli.ts:283`"), pasa esas fuentes con `--context`. Lo que no viaje, o viaje incompleto,
  el revisor lo declara en `unverifiable`.
- Con una ronda en marcha no cambies los insumos ni el contexto: si cambian, `review round` no se
  lanza y `next` pide un `review start` nuevo.

### Lo que trae la respuesta

- **`informative`**: defectos de un insumo o de un contexto, no del artefacto. No cuentan para el
  veredicto ni se deciden con `review decide`: muéstraselos al usuario, que decide si reabre ese
  documento.
- **`unverifiable`**: lo que el revisor no pudo comprobar con el material, de la última ronda. No
  cuenta para el veredicto. Suma el código que falta y revisa de nuevo, o declara esas afirmaciones en
  el gate.
- La ronda siguiente es dirigida, como en un diff. Además admite las regresiones que causó la
  corrección en cualquier línea del artefacto, cada una con su `cause` (`+N` o `-N`).
- Para corregir un artefacto delegado, devuelve los aceptados a su productor con `sdd phase
  --revise` (procedimiento en [devolución documental](document-revision.md)). Después continúa la misma
  revisión con `review round <review-id>`: conserva IDs, decisiones, historial y revisor. El reporte
  del productor no resuelve hallazgos ni concede un veredicto o un gate.
- **El gate es del usuario.** El veredicto informa y no aprueba nada: presenta el artefacto con el
  resultado de la revisión y espera su aprobación.

