// Reconoce en un comando de shell lo que les importa a la liga y a la guarda del commit. Es puro y solo
// depende de `node:path` y de módulos igual de puros, para que el lanzador de hooks lo cargue sin
// arrancar el binario. Lee la forma honesta del comando: una variable, un alias, un script, `$()`,
// `sh -c` o `eval` lo esquivan.
import { isAbsolute, resolve } from 'node:path'
import { isFlowId } from './sdd/id.ts'
import { shellPipelines } from './shell.ts'

/** Un comando del binario que liga la sesión a un flujo. */
export interface Binding { verb: 'start' | 'branch' | 'status' | 'approve' | 'phase' | 'verify'; id: string }

/** Dónde actúa un `git commit`: un directorio, o desconocido si el comando no deja saberlo. */
export type CommitTarget = { dir: string } | { unknown: true }

/** Una palabra del comando, sin comillas; `literal` es falso si el shell la expandiría. */
interface Word { value: string; literal: boolean; syntax?: true }

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function words(command: string): Word[] {
  const out: Word[] = []
  let value = ''
  let raw = ''
  let open = false
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (open) out.push({ value, literal: quote === null && !/[$`]/.test(raw) && !raw.startsWith('~') })
    value = ''
    raw = ''
    open = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      raw += c
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) value += command[++i]
      else value += c
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
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
      out.push({ value: c, literal: true, syntax: true })
      continue
    }
    if (c === '"' || c === "'") quote = c
    else value += c
    raw += c
    open = true
  }
  flush()
  return out
}

/** Las palabras del comando que corre el tramo: sin el `(` o `{` de apertura ni las asignaciones previas. */
function commandWords(segment: string): Word[] {
  const ws = words(segment)
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

function bindingOf(segment: string): Binding | undefined {
  const ws = commandWords(segment).map((w) => w.value)
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
  return bindingOf(shellPipelines(command)[0][0])
}

/** La misma forma que `bindingCommand`, en cualquier tramo. */
export function invokesBinding(command: string): boolean {
  return shellPipelines(command).flat().some((segment) => bindingOf(segment) !== undefined)
}

/**
 * El destino de un tramo si corre `git commit`. Un `-C` absoluto decide; si no, un `cd` o un `pushd`
 * anteriores lo vuelven desconocido, y sin ellos es el `cwd` con los `-C` relativos en orden. Un `-C`
 * que el shell expandiría, `--git-dir` o `--work-tree` también lo vuelven desconocido.
 */
function commitTarget(ws: Word[], cwd: string, moved: boolean): CommitTarget | undefined {
  if (ws[0]?.value !== 'git') return undefined
  let base: string | undefined
  const relative: string[] = []
  let unknown = false
  let i = 1
  for (; i < ws.length; i++) {
    const v = ws[i].value
    if (v === '-C') {
      const dir = ws[++i]
      if (dir === undefined) return undefined
      if (!dir.literal) unknown = true
      else if (isAbsolute(dir.value)) {
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
  if (unknown) return { unknown: true }
  if (base !== undefined) return { dir: resolve(base, ...relative) }
  return moved ? { unknown: true } : { dir: resolve(cwd, ...relative) }
}

/** Un destino por cada `git commit` del comando, en cualquier tramo. */
export function commitTargets(command: string, cwd: string): CommitTarget[] {
  const targets: CommitTarget[] = []
  let moved = false
  for (const segment of shellPipelines(command).flat()) {
    const ws = commandWords(segment)
    if (ws[0]?.value === 'cd' || ws[0]?.value === 'pushd') {
      moved = true
      continue
    }
    const target = commitTarget(ws, cwd, moved)
    if (target !== undefined) targets.push(target)
  }
  return targets
}
