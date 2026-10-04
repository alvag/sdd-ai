import type { CommandDecision } from '../types'

/** Scanner conservador: nunca evalúa expansiones ni cuerpos de heredoc. */
export function recognizeCommand(command: string): CommandDecision {
  let i = 0
  let count = 0
  let atCommandStart = true
  let pendingOperator = false
  // Un `||` puede saltar lo que sigue, y entonces la salida no sería la del binario: la llamada queda nativa si el `||`
  // introduce al binario, o si antes, en la misma cadena de `&&` y `||`, sigue a un tramo que no es `cd` (un `cd … || exit`
  // en su propia línea sí sirve). Un `;` o un salto de línea cortan la cadena. La excepción es un `false` que se ejecuta
  // siempre, porque ningún `||` de la cadena lo precede: falla sin imprimir nada, así que el tramo que sigue a su `||`
  // también se ejecuta siempre.
  let skippable = false
  let chainHasOr = false
  // El tramo actual viene después de un `||` que puede saltarlo.
  let introducedByOr = false
  let segmentCommand = ''
  // Un tramo de solo asignaciones (`ID=x && …`) es válido aunque no tenga comando.
  let segmentAssigned = false
  // El binario entre comillas o con escapes se ejecuta igual, pero no es la forma literal que se reconoce.
  let ambiguous = false
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  const native: CommandDecision = { kind: 'native' }

  /** Lee una palabra: `literal` si no lleva comillas ni escapes, `assignment` si empieza con `NOMBRE=` antes de cualquiera. */
  function word(): { text: string; literal: boolean; assignment: boolean } | null {
    let text = ''
    let literal = true
    let quotedAt = -1
    let started = false
    while (i < command.length && !/[\s;&|<>]/.test(command.charAt(i))) {
      const c = command.charAt(i++)
      started = true
      if (c === '`' || (c === '$' && command.charAt(i) === '(') || /[(){}]/.test(c)) return null
      if (c === '\\') {
        if (i === command.length) return null
        literal = false
        if (quotedAt < 0) quotedAt = text.length
        if (command.charAt(i) === '\n') { i++; continue }
        text += command.charAt(i++)
      } else if (c === "'" || c === '"') {
        literal = false
        if (quotedAt < 0) quotedAt = text.length
        let closed = false
        while (i < command.length) {
          const q = command.charAt(i++)
          if (q === c) { closed = true; break }
          if (c === '"' && (q === '`' || (q === '$' && command.charAt(i) === '('))) return null
          if (c === '"' && q === '\\') {
            if (i === command.length) return null
            const escaped = command.charAt(i++)
            if (escaped !== '\n') text += escaped
          } else text += q
        }
        if (!closed) return null
      } else text += c
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(text)
    return started ? { text, literal, assignment: name !== null && (quotedAt < 0 || name[0].length <= quotedAt) } : null
  }

  function bodies(): boolean {
    for (const { delimiter, stripTabs } of heredocs.splice(0)) {
      let closed = false
      while (i < command.length) {
        const end = command.indexOf('\n', i)
        const line = command.slice(i, end < 0 ? command.length : end)
        i = end < 0 ? command.length : end + 1
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) { closed = true; break }
      }
      if (!closed) return false
    }
    return true
  }

  while (i < command.length) {
    const c = command.charAt(i)
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (command.startsWith('\\\n', i)) { i += 2; continue }
    if (c === '#') {
      while (i < command.length && command.charAt(i) !== '\n') i++
      continue
    }
    if (c === '\n') {
      i++
      if (!bodies()) return native
      // Un salto después de && o || continúa el tramo siguiente; si no, separa como `;` y corta la cadena.
      if (!pendingOperator) {
        chainHasOr = false
        introducedByOr = false
      }
      atCommandStart = true
      segmentAssigned = false
      // El tramo nuevo todavía no tiene comando: el de la línea anterior no vale para el operador que venga.
      segmentCommand = ''
      continue
    }
    if (command.startsWith('2>&1', i) && (i + 4 === command.length || /[\s;&|]/.test(command.charAt(i + 4)))) {
      i += 4
      continue
    }
    if (command.startsWith('<<', i)) {
      i += 2
      const stripTabs = command.charAt(i) === '-'
      if (stripTabs) i++
      while (command.charAt(i) === ' ' || command.charAt(i) === '\t') i++
      const delimiter = word()
      if (!delimiter || !delimiter.text || delimiter.text.includes('\n')) return native
      heredocs.push({ delimiter: delimiter.text, stripTabs })
      continue
    }
    if (command.startsWith('&&', i) || command.startsWith('||', i) || c === ';') {
      if (atCommandStart && !segmentAssigned) return native
      const or = command.startsWith('||', i)
      const alwaysRuns: boolean = or && segmentCommand === 'false' && !introducedByOr && !chainHasOr
      pendingOperator = c !== ';'
      if (c === ';') chainHasOr = false
      else if (or && segmentCommand !== 'cd' && !alwaysRuns) chainHasOr = true
      introducedByOr = or && !alwaysRuns
      atCommandStart = true
      segmentAssigned = false
      segmentCommand = ''
      i += c === ';' ? 1 : 2
      continue
    }
    if (/[&|<>]/.test(c)) return native
    const token = word()
    if (!token) return native
    if (atCommandStart && token.assignment) {
      segmentAssigned = true
      continue
    }
    if (atCommandStart) {
      segmentCommand = token.literal ? token.text : ''
      if (['if', 'then', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '!', 'time'].includes(token.text)) return native
      if (token.text === './bin/sdd-ai' || token.text === 'bin/sdd-ai') {
        count++
        if (!token.literal) ambiguous = true
        if (introducedByOr || chainHasOr) skippable = true
      }
      atCommandStart = false
      pendingOperator = false
    }
  }
  return count === 1 && !pendingOperator && !skippable && !ambiguous && heredocs.length === 0 ? { kind: 'recognized', command } : native
}
