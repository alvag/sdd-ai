/**
 * Parte un comando de shell en tramos por `&&`, `||`, `;`, `|` y el salto de línea, solo donde el
 * separador está fuera de comillas y sin escapar: `echo "a; sdd-ai run"` es un solo tramo.
 */
export function shellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (escaped) {
      current += c
      escaped = false
      continue
    }
    // Entre comillas simples la barra no escapa nada.
    if (c === '\\' && quote !== "'") {
      current += c
      escaped = true
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      segments.push(current)
      current = ''
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += c
  }
  segments.push(current)
  return segments
}

/**
 * Parte un comando de shell en tuberías, y cada tubería en sus comandos. Una tubería termina en `&&`,
 * `||`, `;`, un `&` simple o el salto de línea; sus comandos se separan por `|`. Con las mismas
 * comillas y escapes que `shellSegments`, y sin partir una redirección como `2>&1` o `&>`.
 */
export function shellPipelines(command: string): string[][] {
  const pipelines: string[][] = []
  let pipeline: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  const endCommand = () => {
    pipeline.push(current)
    current = ''
  }
  const endPipeline = () => {
    endCommand()
    pipelines.push(pipeline)
    pipeline = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (escaped) {
      current += c
      escaped = false
      continue
    }
    if (c === '\\' && quote !== "'") {
      current += c
      escaped = true
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      endPipeline()
      i++
      continue
    }
    if (pair === '|&') {
      endCommand()
      i++
      continue
    }
    const redirect = c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')
    if (c === ';' || c === '\n' || (c === '&' && !redirect)) {
      endPipeline()
      continue
    }
    if (c === '|') {
      endCommand()
      continue
    }
    current += c
  }
  endPipeline()
  return pipelines
}
