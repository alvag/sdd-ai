<!-- Origen: SKILL.md:1407–1446. Traslado de la base a70c7da. -->

Apoyos: [verify](verify.md), para comprobar el recibo final y su vigencia antes de revisar; [diff-review](../references/diff-review.md), para revisar el candidato después del verde vigente; [writer](../references/writer.md), si el candidato procede de una cosecha. Lee estos apoyos antes de sus operaciones.

### El commit: `sdd commit`

Completa todas las tasks, de cualquier actor, antes de verify final. Conserva el orden verify → revisión vigente → ensayo y consentimiento humano → aplicación del commit. Las comprobaciones precommit del conductor, incluidas las que exigen Claude, deben completarse antes del commit.

Con el recibo final válido y una revisión de código del flujo terminada, convergida y vigente,
`sdd status` propone el ensayo:

```sh
./bin/sdd-ai sdd commit <id> --subject "agrega el comportamiento acordado"
```

El asunto va en español, con inicial minúscula, en una sola línea. El binario pone el tipo desde
`change_type`, el ticket del flujo o de la rama si existe y los Extras del plan. La primera línea
completa debe tener menos de 72 caracteres. No agrega firmas ni atribuciones.

Muestra al usuario el ensayo completo: las rutas, sus orígenes, las sensibles, el mensaje, el recibo,
la revisión y el digest. Pide su sí explícito antes de aplicar. Solo con ese permiso, repite el mismo
asunto con el digest mostrado:

```sh
./bin/sdd-ai sdd commit <id> --subject "agrega el comportamiento acordado" --apply --digest <digest>
```

En Codex, corre el `--apply --digest` con escalada, fuera del sandbox. `git_unwritable` pide repetir
el mismo comando con escalada antes de tocar el índice. Si el usuario no la aprueba, puede hacer
el commit desde su terminal. Un digest distinto se rechaza: vuelve a mostrar el ensayo y pide el sí.

- `already_committed`: no crea otro commit. El ensayo informa qué falta del índice, registro o header;
  el `--apply` con su digest completa esos pendientes. Si no falta nada, sigue el estado del flujo.
- `commit_failed`: muestra el error de Git y no reintenta automáticamente. Corrige la causa antes de
  volver al ensayo; lo staged del usuario se conserva.
- `commit_altered`: un hook cambió el contenido, el modo o el mensaje; el verbo deshace su commit.
  Revisa las rutas indicadas. Si el hook tocó el árbol, vuelve a verificar y revisar ese contenido.
- **Sin mover ninguna referencia** (`commit_altered` si un hook cambió de rama, `commit_failed` si HEAD avanzó con
  commits que no son del intento): revisa el historial con el usuario antes de repetir nada. El `next` dice si
  quedó un commit del intento, y con él la intención en el registro para reconocerlo.

El commit incluye el contenido verificado sin filtros `clean`. Los hooks de Git sí corren. Un hook
`commit-msg` que cambia el mensaje impide usar el verbo. El commit a mano sigue disponible desde
`review_and_commit`; en ese camino el conductor actualiza el header como antes. El verbo no hace
push, PR ni archivo.

