import { expect, test } from 'claude-code/testing'
import { recognizeCommand } from '../hooks/command'

const recognized = [
  './bin/sdd-ai sdd status',
  'bin/sdd-ai sdd status',
  'cd /repo && ./bin/sdd-ai sdd status',
  'cd /repo; bin/sdd-ai sdd status',
  // Un `cd … || exit` en su propia línea no salta el binario de la línea siguiente.
  'cd /repo || exit 1\n./bin/sdd-ai sdd status',
  // Un tramo de solo asignaciones es válido antes de un operador, y un `;` corta la cadena de un `||` anterior.
  'ID=20261003-1909-efbf; ./bin/sdd-ai review status "$ID"',
  'ID=x && ./bin/sdd-ai sdd status',
  'false || true; ./bin/sdd-ai sdd status',
  // Un `false` que siempre se ejecuta falla sin imprimir nada: el binario que sigue a su `||` corre siempre.
  'false || ./bin/sdd-ai sdd status',
  'false || false || ./bin/sdd-ai sdd status',
  'cd /repo && false || ./bin/sdd-ai sdd status',
  'cd /repo\n./bin/sdd-ai sdd status',
  'SDD_AI_TELEMETRY=off X="a b" ./bin/sdd-ai sdd status',
  './bin/sdd-ai sdd status 2>&1',
  'cd /repo &&\n./bin/sdd-ai sdd status',
  '# ./bin/sdd-ai is a comment\n./bin/sdd-ai sdd status # comment',
  './bin/sdd-ai run --prompt "first\n./bin/sdd-ai is an argument\nlast"',
  "./bin/sdd-ai run --prompt 'first\n./bin/sdd-ai is an argument\nlast'",
  './bin/sdd-ai run <<EOF\n./bin/sdd-ai is heredoc data\nEOF\n',
  "./bin/sdd-ai run <<'EOF'\n$(not a command)\n./bin/sdd-ai\nEOF\n",
  './bin/sdd-ai run <<-EOF\n\t./bin/sdd-ai is heredoc data\n\tEOF\n',
  "cat <<EOF\n./bin/sdd-ai\nEOF\n./bin/sdd-ai sdd status",
  './bin/sdd-ai run <<A <<B\n./bin/sdd-ai\nA\n./bin/sdd-ai\nB\n',
  'cd /repo && \\\n./bin/sdd-ai sdd status',
  './bin/sdd-ai run --prompt "escaped \\" quotation"',
  './bin/sdd-ai run --prompt \'$(literal) `literal` ; || &&\'',
  './bin/sdd-ai run --prompt "\\$(literal) \\`literal\\`"',
]
const native = [
  '', 'echo ./bin/sdd-ai', 'printf "./bin/sdd-ai\\n"',
  'echo "first\n./bin/sdd-ai sdd status\nlast"',
  "cat <<EOF\n./bin/sdd-ai sdd status\nEOF\n",
  './bin/sdd-ai sdd status | cat', 'cat | ./bin/sdd-ai sdd status',
  './bin/sdd-ai sdd status && ./bin/sdd-ai sdd status',
  './bin/sdd-ai sdd status\nbin/sdd-ai sdd status',
  './bin/sdd-ai sdd status; bin/sdd-ai sdd status',
  './bin/sdd-ai sdd status || bin/sdd-ai sdd status',
  './bin/sdd-ai run --prompt $(cat file)',
  './bin/sdd-ai run --prompt "$(cat file)"',
  './bin/sdd-ai run --prompt `cat file`',
  './bin/sdd-ai run --prompt "`cat file`"',
  '( ./bin/sdd-ai sdd status )', '{ ./bin/sdd-ai sdd status; }',
  './bin/sdd-ai sdd status &',
  './bin/sdd-ai sdd status >out', './bin/sdd-ai sdd status >>out',
  './bin/sdd-ai sdd status <in', './bin/sdd-ai sdd status 2>/dev/null',
  './bin/sdd-ai sdd status 2>&2',
  './bin/sdd-ai run --prompt "unfinished', './bin/sdd-ai run \\',
  './bin/sdd-ai run <<EOF\nunfinished', './bin/sdd-ai sdd status &&',
  'if true; then ./bin/sdd-ai sdd status; fi',
  'echo $(date); ./bin/sdd-ai sdd status',
  './bin/sdd-ai sdd status; echo $(date)',
  '"./bin/sdd-ai" sdd status',
  // Un `||` que introduce al binario lo salta si el tramo anterior funciona, aunque sea un cd.
  'cd /repo || ./bin/sdd-ai sdd status',
  "printf '{\"state\":\"done\"}'; cd . || ./bin/sdd-ai review status x",
  // Un tramo anterior que no es cd puede imprimir su propio JSON y saltar el binario.
  "echo '{\"state\":\"done\"}' || ./bin/sdd-ai sdd status",
  'cat run.json || ./bin/sdd-ai wait x',
  // Un `false` que viene después de otro `||` puede no ejecutarse, y entonces tampoco el binario.
  'cd /repo || false || ./bin/sdd-ai sdd status',
  'cat run.json || false || ./bin/sdd-ai sdd status',
  '"false" || ./bin/sdd-ai sdd status',
  // El `false` de una línea anterior no es el tramo del `||`: una asignación que funciona salta el binario.
  "printf '{\"state\":\"done\"}'\nfalse\nVAR=x || ./bin/sdd-ai sdd status",
  'false\nVAR=x || ./bin/sdd-ai sdd status',
  // Una palabra citada no es una asignación: Bash intentaría ejecutar X=y, nunca el binario.
  '"X=y" ./bin/sdd-ai || printf \'{"state":"done"}\'',
  // El binario entre comillas también es una invocación: con dos, la llamada queda nativa.
  './bin/sdd-ai sdd status || "./bin/sdd-ai" sdd status',
  "\\./bin/sdd-ai sdd status",
  // Solo el ejecutable literal: ni otros binarios con prefijo o sufijo parecidos ni otras rutas.
  './bin/sdd-ai-old sdd status', './bin/sdd-ai.bak sdd status', '../bin/sdd-ai sdd status',
  '/repo/bin/sdd-ai sdd status', 'xbin/sdd-ai sdd status',
  // Por `env`, el binario es un argumento y no está en posición de comando.
  'env X=1 ./bin/sdd-ai sdd status',
]

for (const command of recognized) test(`recognizes execution: ${command}`, () => {
  expect(recognizeCommand(command)).toEqual({ kind: 'recognized', command })
})
for (const command of native) test(`keeps ambiguous or unrelated command native: ${command}`, () => {
  expect(recognizeCommand(command)).toEqual({ kind: 'native' })
})
