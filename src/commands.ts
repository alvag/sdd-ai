// Reconoce en un comando de shell lo que les importa a la liga y a la guarda del commit. Es puro y solo
// depende de `node:path` y de módulos igual de puros, para que el lanzador de hooks lo cargue sin
// arrancar el binario. Lee la forma honesta del comando: una variable, un alias, un script, `$()`,
// `sh -c` o `eval` lo esquivan.
import { posix, win32 } from 'node:path'
import { isFlowId } from './sdd/id.ts'
import { type Grammar, type Segment, pipelineSegments } from './shell.ts'

/** Un comando del binario que liga la sesión a un flujo. */
export interface Binding { verb: 'start' | 'branch' | 'status' | 'approve' | 'phase' | 'verify'; id: string }

/** Dónde actúa un `git commit`: un directorio, o desconocido si el comando no deja saberlo. */
export type CommitTarget = { dir: string } | { unknown: true }

/**
 * Una palabra del comando, sin comillas; `literal` es falso si el shell la expandiría. `start` es el
 * índice de su primer carácter (comilla incluida) en el comando original, y `opaque` marca una palabra
 * que un backtick, una continuación o `--%` impiden leer.
 */
export interface Word { value: string; literal: boolean; start: number; syntax?: true; opaque?: true }

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Entre comillas dobles, bash escapa con la barra solo estos caracteres. */
const BASH_DOUBLE_ESCAPES = '$`"\\\n'

/**
 * Las palabras de un tramo con la lectura POSIX. Con `win`, dentro de comillas dobles la barra solo
 * escapa lo que escapa bash: ante una letra común se conserva, como en `"C:\Users\x"`.
 */
function posixWords(segment: Segment, win: boolean): Word[] {
  const command = segment.text
  const out: Word[] = []
  let value = ''
  let raw = ''
  let literal = true
  let open = false
  let start = 0
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (open) out.push({ value, literal: quote === null && (win ? literal : !/[$`]/.test(raw)) && !raw.startsWith('~'), start })
    value = ''
    raw = ''
    literal = true
    open = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      raw += c
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length && (!win || BASH_DOUBLE_ESCAPES.includes(command[i + 1]))) {
        value += command[++i]
      } else {
        if (quote === '"' && /[$`]/.test(c)) literal = false
        value += c
      }
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      if (!open) start = segment.start + i
      raw += c + command[i + 1]
      value += command[++i]
      open = true
      continue
    }
    if (/\s/.test(c)) {
      flush()
      continue
    }
    if (c === '(' || c === ')') {
      flush()
      out.push({ value: c, literal: true, start: segment.start + i, syntax: true })
      continue
    }
    if (!open) start = segment.start + i
    if (c === '"' || c === "'") quote = c
    else {
      if (/[$`]/.test(c)) literal = false
      value += c
    }
    raw += c
    open = true
  }
  flush()
  return out
}

/**
 * Las palabras de un tramo con la lectura de PowerShell: la barra es literal. Solo una ruta simple, sin
 * comillas o con un único par, es literal; una concatenación, un `''` o `""` interno, una expansión, un
 * `~` o `@` inicial o una comilla en el valor no lo son. Un backtick vuelve opaca su palabra; una
 * continuación (backtick con salto de línea) o `--%` propagan la opacidad a las palabras posteriores.
 */
function powershellWords(segment: Segment): Word[] {
  const t = segment.text
  const out: Word[] = []
  let value = ''
  let open = false
  let start = 0
  let parts = 0
  let lastUnquoted = false
  let literal = true
  let opaque = false
  let quoted = false
  let tail = false
  let native = false
  let nativeQuoted = false
  const flush = () => {
    if (!open) return
    const first = t[start - segment.start]
    const loose = parts > 1 || value.includes('"') || first === '@' || first === '~' ||
      (quoted && /\s/.test(value) && value.endsWith('\\'))
    const o = opaque || tail
    const w: Word = { value, literal: literal && !loose && !o, start }
    if (o) w.opaque = true
    // PowerShell consume el marcador: no ocupa el argumento de -C; lo posterior sigue opaco.
    if (value === '--%' && !quoted && !native) {
      w.syntax = true
      tail = true
      native = true
    }
    out.push(w)
    value = ''
    open = false
    parts = 0
    lastUnquoted = false
    literal = true
    opaque = false
    quoted = false
  }
  const begin = (i: number) => {
    if (!open) start = segment.start + i
    open = true
  }
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (native) {
      if (/\s/.test(c) && !nativeQuoted) { flush(); continue }
      begin(i)
      if (c === '"') {
        let slash = i
        while (slash > start - segment.start && t[slash - 1] === '\\') slash--
        if ((i - slash) % 2 === 0) nativeQuoted = !nativeQuoted
        else value += c
      } else value += c
      continue
    }
    if (c === '`') {
      const crlf = t[i + 1] === '\r' && t[i + 2] === '\n'
      if (crlf || t[i + 1] === '\n') {
        if (open) {
          literal = false
          opaque = true
        }
        tail = true
        i += crlf ? 2 : 1
        continue
      }
      begin(i)
      if (!lastUnquoted) parts++
      lastUnquoted = true
      literal = false
      opaque = true
      if (i + 1 < t.length) value += t[++i]
      continue
    }
    if (/\s/.test(c)) {
      flush()
      continue
    }
    if (c === '(' || c === ')') {
      flush()
      out.push({ value: c, literal: true, start: segment.start + i, syntax: true })
      continue
    }
    if (c === "'") {
      begin(i)
      parts++
      quoted = true
      lastUnquoted = false
      const end = t.indexOf("'", i + 1)
      if (end === -1) {
        literal = false
        value += t.slice(i + 1)
        i = t.length
      } else {
        value += t.slice(i + 1, end)
        i = end
      }
      continue
    }
    if (c === '"') {
      begin(i)
      parts++
      quoted = true
      lastUnquoted = false
      let closed = false
      for (i++; i < t.length; i++) {
        const d = t[i]
        if (d === '"') {
          closed = true
          break
        }
        if (d === '`') {
          literal = false
          opaque = true
          if (i + 1 < t.length) value += t[++i]
          continue
        }
        if (d === '$') literal = false
        value += d
      }
      if (!closed) literal = false
      continue
    }
    begin(i)
    if (!lastUnquoted) parts++
    lastUnquoted = true
    if (c === '$') literal = false
    value += c
  }
  flush()
  return out
}

/** Las palabras del comando que corre el tramo: sin el `(` o `{` de apertura ni las asignaciones previas. */
function commandWords(all: Word[]): Word[] {
  const ws = [...all]
  while (ws.length > 0 && (ws[0].value === '(' || ws[0].value === '{' || ASSIGNMENT.test(ws[0].value))) ws.shift()
  return ws.filter((w) => !w.syntax)
}

/** Las opciones de cada verbo que liga, como las declara su `parseArgs`: las booleanas y las que llevan valor. */
const OPTIONS: Record<Binding['verb'], { flags: string[]; values: string[]; count: number }> = {
  branch: { flags: ['--apply', '--current', '--refreeze'], values: ['--prefix'], count: 1 },
  start: { flags: ['--apply'], values: ['--topic', '--base-branch', '--depth', '--risk', '--change-type', '--request'], count: 1 },
  status: { flags: ['--json'], values: [], count: 1 },
  approve: { flags: [], values: ['--conductor'], count: 2 },
  phase: { flags: [], values: ['--request', '--context', '--families', '--conductor', '--deadline'], count: 1 },
  verify: { flags: ['--baseline'], values: ['--attest', '--conductor'], count: 1 },
}

/**
 * Los argumentos como los separa el `parseArgs` estricto de la CLI: los posicionales y las banderas que vio antes
 * de un `--`. `undefined` si ella los rechazaría.
 */
function splitArgs(args: string[], o: { flags: string[]; values: string[] }): { args: string[]; flags: string[] } | undefined {
  const out: string[] = []
  const flags: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return { args: [...out, ...args.slice(i + 1)], flags }
    if (!a.startsWith('-') || a === '-') out.push(a)
    else if (o.flags.includes(a)) flags.push(a)
    else if (o.values.some((v) => a.startsWith(`${v}=`))) continue
    else if (o.values.includes(a) && i + 1 < args.length) i++
    else return undefined
  }
  return { args: out, flags }
}

function bindingOf(all: Word[]): Binding | undefined {
  const ws = commandWords(all).map((w) => w.value)
  const start = ws[0] === 'node' ? 1 : 0
  const bin = ws[start]
  if (bin === undefined || (bin !== 'sdd-ai' && !bin.endsWith('bin/sdd-ai')) || ws[start + 1] !== 'sdd') return undefined
  const verb = ws[start + 2]
  if (verb !== 'start' && verb !== 'branch' && verb !== 'status' && verb !== 'approve' && verb !== 'phase' && verb !== 'verify') return undefined
  const parsed = splitArgs(ws.slice(start + 3), OPTIONS[verb])
  if (parsed === undefined || ((verb === 'start' || verb === 'branch') && !parsed.flags.includes('--apply'))) return undefined
  const args = parsed.args
  if (args.length !== OPTIONS[verb].count || !isFlowId(args[0])) return undefined
  return { verb, id: args[0] }
}

/** `sdd start <id> --apply`, `sdd branch <id> --apply`, `sdd status <id>`, `sdd approve <id> <gate>`, `sdd phase <id>` o `sdd verify <id>`, solo en el primer tramo. */
export function bindingCommand(command: string): Binding | undefined {
  return bindingOf(posixWords(pipelineSegments(command, 'posix')[0][0], false))
}

/**
 * La misma forma que `bindingCommand`, en cualquier tramo. En Windows el comando puede correr en bash o
 * en PowerShell, así que basta que una de las dos lecturas lo reconozca.
 */
export function invokesBinding(command: string, platform: string = process.platform): boolean {
  const win = platform === 'win32'
  const posixReads = pipelineSegments(command, 'posix').flat().map((s) => posixWords(s, win))
  const reads = win ? [...posixReads, ...pipelineSegments(command, 'powershell').flat().map(powershellWords)] : posixReads
  return reads.some((ws) => bindingOf(ws) !== undefined)
}

/** Cómo se clasifica y se resuelve una ruta según la plataforma. */
interface DirectoryRules {
  classify(value: string): 'absolute' | 'relative' | 'unknown'
  resolve(...parts: string[]): string
}

/**
 * Una ruta de Windows: absoluta solo con unidad y barra. Una UNC, una de unidad relativa (`C:x`) o una
 * con raíz sin unidad (`/x`, `\x`) no se pueden resolver con seguridad y quedan desconocidas.
 */
function winDir(value: string): 'absolute' | 'relative' | 'unknown' {
  if (/^[\\/]{2}/.test(value)) return 'unknown'
  if (/^[A-Za-z]:[\\/]/.test(value)) return 'absolute'
  if (/^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)) return 'unknown'
  return 'relative'
}

const WIN_RULES: DirectoryRules = { classify: winDir, resolve: (...parts) => win32.resolve(...parts) }
const POSIX_RULES: DirectoryRules = {
  classify: (value) => (posix.isAbsolute(value) ? 'absolute' : 'relative'),
  resolve: (...parts) => posix.resolve(...parts),
}

/** Los comandos que cambian de directorio. Fuera de Windows, solo `cd` y `pushd` exactos. */
const POSIX_MOVES = new Set(['cd', 'pushd'])
const WIN_MOVES = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir', 'push-location', 'pop-location', 'popd'])

function movesWin(word: string, powershell: boolean): boolean {
  const v = word.toLowerCase()
  return WIN_MOVES.has(v) || /^cd\.\./.test(v) || /^[a-z]:$/.test(v) || (powershell && v.startsWith('cd\\'))
}

/** El destino de un commit y si depende de cómo se lea un backslash final. */
interface ParsedCommit { target: CommitTarget; fragile: boolean }

const UNKNOWN: CommitTarget = { unknown: true }

/**
 * El destino de un tramo si corre `git commit`. Un `-C` absoluto decide; si no, un `cd` o un `pushd`
 * anteriores lo vuelven desconocido, y sin ellos es el `cwd` con los `-C` relativos en orden. Un `-C`
 * que el shell expandiría, `--git-dir` o `--work-tree` también lo vuelven desconocido, como una palabra
 * opaca entre `git` y `commit`. Un `-C` con backslash final marca el destino como frágil.
 */
function commitTarget(ws: Word[], cwd: string, moved: boolean, rules: DirectoryRules): ParsedCommit | undefined {
  if (ws[0]?.value !== 'git') return undefined
  let base: string | undefined
  const relative: string[] = []
  let unknown = false
  let fragile = false
  let i = 1
  for (; i < ws.length; i++) {
    const v = ws[i].value
    if (v === '-C') {
      const dir = ws[++i]
      if (dir === undefined) return undefined
      const kind = rules.classify(dir.value)
      if (dir.value.endsWith('\\')) fragile = true
      if (!dir.literal || kind === 'unknown') unknown = true
      else if (kind === 'absolute') {
        base = dir.value
        relative.length = 0
      } else relative.push(dir.value)
    } else if (v === '--git-dir' || v === '--work-tree') {
      unknown = true
      i++
    } else if (v.startsWith('--git-dir=') || v.startsWith('--work-tree=')) unknown = true
    else if (v === '-c' || v === '--namespace' || v === '--exec-path') i++
    else if (!v.startsWith('-')) break
  }
  if (ws[i]?.value !== 'commit') return undefined
  if (unknown || ws.slice(0, i + 1).some((w) => w.opaque)) return { target: UNKNOWN, fragile }
  if (base !== undefined) return { target: { dir: rules.resolve(base, ...relative) }, fragile }
  return { target: moved ? UNKNOWN : { dir: rules.resolve(cwd, ...relative) }, fragile }
}

/** Los commits que ve una lectura de Windows, por la posición de su ejecutable en el comando. */
function windowsCommits(command: string, cwd: string, grammar: Grammar): Map<number, ParsedCommit> {
  const powershell = grammar === 'powershell'
  const found = new Map<number, ParsedCommit>()
  let moved = false
  for (const segment of pipelineSegments(command, grammar).flat()) {
    const ws = commandWords(powershell ? powershellWords(segment) : posixWords(segment, true))
    if (ws.length > 0 && movesWin(ws[0].value, powershell)) {
      moved = true
      continue
    }
    const parsed = commitTarget(ws, cwd, moved, WIN_RULES)
    if (parsed !== undefined) found.set(ws[0].start, parsed)
  }
  return found
}

function sameTarget(a: CommitTarget, b: CommitTarget): CommitTarget {
  if ('dir' in a && 'dir' in b && a.dir.toLowerCase() === b.dir.toLowerCase()) return a
  return UNKNOWN
}

/**
 * Un destino por cada `git commit` del comando, en cualquier tramo. En Windows el comando puede correr
 * en bash o en PowerShell: se leen las dos, y un mismo commit (por la posición de su ejecutable) con
 * destinos distintos o inciertos es desconocido; el que ve una sola lectura no se descarta.
 */
export function commitTargets(command: string, cwd: string, platform: string = process.platform): CommitTarget[] {
  if (platform === 'win32') {
    const reads = [windowsCommits(command, cwd, 'posix'), windowsCommits(command, cwd, 'powershell')]
    const positions = [...new Set(reads.flatMap((r) => [...r.keys()]))].sort((a, b) => a - b)
    return positions.map((position) => {
      const [x, y] = reads.map((r) => r.get(position))
      if (x !== undefined && y !== undefined) return sameTarget(x.target, y.target)
      const only = (x ?? y) as ParsedCommit
      return only.fragile ? UNKNOWN : only.target
    })
  }
  const targets: CommitTarget[] = []
  let moved = false
  for (const segment of pipelineSegments(command, 'posix').flat()) {
    const ws = commandWords(posixWords(segment, false))
    if (ws.length > 0 && POSIX_MOVES.has(ws[0].value)) {
      moved = true
      continue
    }
    const parsed = commitTarget(ws, cwd, moved, POSIX_RULES)
    if (parsed !== undefined) targets.push(parsed.target)
  }
  return targets
}
