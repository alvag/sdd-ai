# Rutas de Windows en las guardas de hooks

La guarda de commit lee el comando que llega al hook para saber a qué repositorio va un `git commit`. En
Windows ese comando puede ejecutarse en bash o en PowerShell, y las dos leen distinto el backslash sin
comillas. Para que el destino quede claro, escribe la ruta con comillas o con slash.

Para un `git -C` a otro repositorio, cualquiera de estas formas funciona:

```
git -C 'C:\Users\x\other' commit -m "mensaje"
git -C "C:\Users\x\other" commit -m "mensaje"
git -C C:/Users/x/other commit -m "mensaje"
```

- Comillas simples: la ruta nativa llega tal cual a Git.
- Comillas dobles: el backslash se conserva ante las letras comunes (`\U`, `\x`).
- Slash: ambas shells lo leen igual; no necesita comillas.
- Si la ruta tiene espacios, usa comillas (`git -C 'C:\Mis repos\other' commit`).

Una ruta con backslash **sin comillas** (`git -C C:\Users\x\other commit`) es ambigua: bash la lee como
`C:Usersxother` y PowerShell como la ruta nativa. La guarda no adivina y la trata como destino
desconocido. Con una sesión ligada a un flujo, el commit se niega con el motivo
«no se puede saber a qué repositorio va». Sin liga, y con Jira activo o inválido, se conserva el motivo
de Jira. El texto de la negación depende del contexto.
