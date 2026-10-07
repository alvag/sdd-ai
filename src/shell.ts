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
  return pipelineSegments(command, 'posix').map((pipeline) => pipeline.map((s) => s.text))
}

/** Un tramo del comando y el índice de su primer carácter en el texto original. */
export interface Segment { text: string; start: number }

/** Cómo se lee el escape: en `posix` la barra, en `powershell` el backtick y la barra es literal. */
export type Grammar = 'posix' | 'powershell'

/**
 * Lo mismo que `shellPipelines`, con el texto crudo de cada tramo y su posición. Con `powershell` los
 * separadores son los mismos, pero la barra no escapa: entre comillas simples nada escapa (`''` cierra
 * y reabre), y fuera de ellas el backtick escapa el carácter siguiente; backtick con salto de línea
 * (LF o CRLF) es una continuación y no parte el tramo.
 */
export function pipelineSegments(command: string, grammar: Grammar): Segment[][] {
  const powershell = grammar === 'powershell'
  let stopped = false
  let escapedBoundary = -1
  const pipelines: Segment[][] = []
  let pipeline: Segment[] = []
  let begin = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  const endCommand = (end: number, next: number) => {
    pipeline.push({ text: command.slice(begin, end), start: begin })
    begin = next
  }
  const endPipeline = (end: number, next: number) => {
    endCommand(end, next)
    pipelines.push(pipeline)
    pipeline = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (stopped && c === '|') stopped = false
    if (stopped) {
      if (c === '\n') { stopped = false; endPipeline(i, i + 1) }
      continue
    }
    if (powershell && !quote && command.slice(i, i + 3) === '--%' && (i === 0 || (/\s/.test(command[i - 1]) && i - 1 !== escapedBoundary)) && (i + 3 === command.length || /\s/.test(command[i + 3]))) {
      stopped = true; i += 2; continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (!powershell && c === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (powershell && c === '`' && quote !== "'") {
      const startsWord = i === begin || (/\s/.test(command[i - 1]) && i - 1 !== escapedBoundary)
      i += command[i + 1] === '\r' && command[i + 2] === '\n' ? 2 : 1
      escapedBoundary = command[i] === '\n' && startsWord ? -1 : i
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      endPipeline(i, i + 2)
      i++
      continue
    }
    if (pair === '|&') {
      endCommand(i, i + 2)
      i++
      continue
    }
    const redirect = c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')
    if (c === ';' || c === '\n' || (c === '&' && !redirect)) {
      endPipeline(i, i + 1)
      continue
    }
    if (c === '|') {
      endCommand(i, i + 1)
      continue
    }
  }
  endPipeline(command.length, command.length)
  return pipelines
}

/**
 * Los tramos que la guarda del worker examina. En Windows se suman los de PowerShell, porque el comando
 * puede correr en cualquiera de las dos shells y una barra ante `;` separa tramos solo en una de ellas.
 */
export function commandSegments(command: string, platform: string): string[] {
  const segments = shellSegments(command)
  if (platform !== 'win32') return segments
  return [...segments, ...pipelineSegments(command, 'powershell').flat().map((s) => s.text)]
}
