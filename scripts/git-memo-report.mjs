import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cleanGitEnv, withGitEnv } from '../test/git-memo-fixture.ts'

const fail = (message) => { throw new Error(message) }
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** Comprueba los cuerpos y las salidas originales antes de normalizar referencias. */
export function validateReceiptIntegrity(state) {
  const receipts = new Map()
  const documents = []
  for (const [path, file] of Object.entries(state.files ?? {})) {
    if (!path.endsWith('.json') || typeof file.bytes !== 'string') continue
    let document
    try { document = JSON.parse(Buffer.from(file.bytes, 'base64').toString('utf8')) } catch {
      if (/\/sdd-ai\/verify\/[^/]+\/receipt\.json$/.test(path)) fail(`recibo ilegible: ${path}`)
      continue
    }
    documents.push(document)
    if (!/\/sdd-ai\/verify\/[^/]+\/receipt\.json$/.test(path)) continue
    if (!Array.isArray(document.rows) || document.id !== posix.basename(posix.dirname(path))) fail(`recibo sin identidad o filas: ${path}`)
    if (receipts.has(document.id)) fail(`identidad de recibo ambigua: ${document.id}`)
    receipts.set(document.id, { path, digest: sha256(Buffer.from(file.bytes, 'base64')) })
    for (const row of document.rows) for (const execution of [row.execution, row.confirmation?.execution]) {
      if (!execution) continue
      for (const stream of ['stdout', 'stderr']) {
        const name = execution[`${stream}_file`]
        if (typeof name !== 'string' || posix.basename(name) !== name) fail('ruta de salida de recibo inválida')
        const output = state.files[posix.join(posix.dirname(path), name)]
        if (!output || sha256(Buffer.from(output.bytes, 'base64')) !== execution[`${stream}_sha256`]) fail(`salida de recibo no íntegra: ${path}/${name}`)
      }
    }
  }
  const check = (value) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.id === 'string' && typeof value.digest === 'string' && ['baseline', 'final'].includes(value.mode)) {
      const receipt = receipts.get(value.id)
      if (!receipt || receipt.digest !== value.digest) fail(`referencia de recibo no íntegra: ${value.id}`)
    }
    for (const item of Object.values(value)) check(item)
  }
  for (const document of documents) check(document)
  check(state.output?.json)
  return receipts.size
}

export function validateRecordedIntegrity(state) {
  const receipts = validateReceiptIntegrity(state)
  const attestations = new Map()
  const documents = []
  let candidates = 0
  for (const [path, file] of Object.entries(state.files ?? {})) {
    if (!path.endsWith('.json') || typeof file.bytes !== 'string') continue
    let document
    try { document = JSON.parse(Buffer.from(file.bytes, 'base64').toString('utf8')) } catch {
      if (path.endsWith('/candidate.json') || /\/sdd-ai\/verify\/attestations\/[^/]+\.json$/.test(path)) fail(`registro de integridad ilegible: ${path}`)
      continue
    }
    documents.push(document)
    if (/\/sdd-ai\/verify\/attestations\/[^/]+\.json$/.test(path)) {
      if (document.id !== posix.basename(path, '.json') || attestations.has(document.id)) fail('identidad de acreditación inválida o ambigua')
      attestations.set(document.id, { document, digest: sha256(Buffer.from(file.bytes, 'base64')) })
    }
    if (!path.endsWith('/candidate.json')) continue
    if (!Array.isArray(document.files) || !Array.isArray(document.context)) fail('manifiesto del candidato incompleto')
    const manifest = {
      base_sha: document.base_sha, head_sha: document.head_sha,
      files: document.files.map((f) => ({ path: f.path, status: f.status, from: f.from ?? null, mode: f.mode, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
      context: document.context.map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    }
    if (sha256(JSON.stringify(manifest)) !== document.hash) fail(`hash del candidato inválido: ${path}`)
    for (const entry of [...document.files, ...document.context]) {
      if (entry.sha256 === null) continue
      const blob = state.files[posix.join(posix.dirname(path), 'blobs', entry.sha256)]
      if (!blob || sha256(Buffer.from(blob.bytes, 'base64')) !== `sha256:${entry.sha256}`) fail(`blob del candidato no íntegro: ${path}/${entry.path}`)
    }
    candidates++
  }
  const check = (value) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.id === 'string' && typeof value.digest === 'string' && typeof value.row === 'string' && typeof value.proof_ref === 'string') {
      const body = attestations.get(value.id)
      if (!body || body.digest !== value.digest || body.document.row !== value.row || body.document.proof_ref !== value.proof_ref) fail(`referencia de acreditación no íntegra: ${value.id}`)
    }
    for (const item of Object.values(value)) check(item)
  }
  documents.forEach(check); check(state.output?.json)
  return { receipts, candidates, attestations: attestations.size }
}

/**
 * Las clases de tiempo y su forma: una regla `time` solo puede normalizar un valor con la forma de su clase, así que
 * un manifiesto no puede colapsar por esa vía otros datos, como un código de salida.
 */
export const TIME_CLASSES = {
  // Un instante ISO.
  t: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
  // La duración con su clave, en JSON (`"duration_ms": n`), en el YAML de TAP (`duration_ms: n`) y en su resumen
  // (`# duration_ms n`).
  d: /\bduration_ms"?:?\s*\d+(?:\.\d+)?(?:e[+-]?\d+)?/g,
  // La hora de arranque de un proceso en el formato de `ps -o lstart`.
  l: /\b[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}\b/g,
}
const timeShape = (symbol, value) => TIME_CLASSES[symbol] !== undefined && new RegExp(`^(?:${TIME_CLASSES[symbol].source})$`).test(value)

/**
 * Las reglas de normalización de los datos que varían entre corridas independientes. Cada regla reemplaza una
 * ocurrencia completa (un token, o el dato con la clave de su campo), nunca un número suelto en otro lugar. Las reglas
 * son correspondencias explícitas: no se eliminan campos ni mensajes.
 *
 * - **Biyectivas por valor** (ids de corrida y digests de ensayo): son tokens completos que no aparecen dentro de otro
 *   dato. Se emparejan los valores de cada lado en orden de aparición.
 * - **Biyectivas por número, con su contexto** (PID e inodos): la regla reemplaza `"pid": n` o `"ino": n` con su clave,
 *   pero la correspondencia se comprueba sobre el número. Así, dos campos que citan el mismo proceso en un lado tienen
 *   que citar el mismo proceso en el otro.
 * - En las dos, si un tipo no tiene la misma cantidad de ocurrencias en los dos lados, no emite reglas; si un valor se
 *   emparejaría con dos distintos, ese par no se normaliza. La diferencia queda a la vista en compareStates.
 * - **Por clase** (instantes ISO, `duration_ms` y `lstart`; desvío F-10, aceptado por Max): cada valor va al símbolo
 *   de su clase, porque dos eventos pueden caer en el mismo milisegundo en un lado y no en el otro. Los instantes ISO
 *   conservan sus relaciones: dos ocurrencias ordenadas en un sentido no pueden estarlo en el otro, y una marca copiada
 *   (el mismo texto en dos lugares de un lado) no puede distar en el otro un segundo o más (dos si está en segundos). Las
 *   duraciones y `lstart` miden al host y se normalizan sin relaciones. Una regla por clase tiene un solo lado
 *   (`side`), así que no se confunde con una correspondencia.
 */
export function deriveVariableRules(left, right) {
  const patterns = [
    { kind: 'time', regex: TIME_CLASSES.t, symbol: 't', ordered: true },
    { kind: 'time', regex: TIME_CLASSES.d, symbol: 'd' },
    { kind: 'time', regex: TIME_CLASSES.l, symbol: 'l' },
    { kind: 'run_id', regex: /\b\d{8}-\d{4}-[0-9a-f]{4}\b/g, symbol: 'r' },
    // Los PID de procesos del sistema, en los campos que los registran.
    { kind: 'pid', regex: /"(?:supervisor_pid|pid|child_pid)":\s*(\d+)/g, symbol: 'p', contextual: true },
    // Los inodos que registran identidades de directorios: distinguen dos fixtures independientes.
    { kind: 'inode', regex: /"ino":\s*"?(\d+)"?/g, symbol: 'i', contextual: true },
    // El digest de un ensayo (commit o prune; con prefijo sha256: o sin él) se calcula sobre datos que ya varían (ids
    // y digests de recibos) y no es el hash de un archivo capturado. Cada lado lo consume en su propio `--apply`, cuya
    // aceptación lo verifica. Se localiza por su `--digest` y se normaliza como token completo también en el JSON del
    // ensayo.
    { kind: 'derived_digest', regex: /--digest ((?:sha256:)?[0-9a-f]{64})\b/g, symbol: 'g' },
  ]
  const texts = (value, key = '', out = []) => {
    if (typeof value === 'string') {
      if (key === 'bytes') {
        const bytes = Buffer.from(value, 'base64'); const utf8 = bytes.toString('utf8')
        if (Buffer.from(utf8, 'utf8').equals(bytes)) out.push(utf8)
      } else out.push(value)
    } else if (Array.isArray(value)) value.forEach((item) => texts(item, '', out))
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) { out.push(name); texts(item, name, out) }
    return out
  }
  // Cada ocurrencia, con el texto completo que reemplaza la regla y el valor que entra en la correspondencia.
  const found = (state, regex, contextual) => {
    const values = []
    for (const text of texts(state)) for (const match of text.matchAll(regex)) {
      values.push(contextual ? { text: match[0], value: match[1], context: match[0].replace(match[1], '#') } : { text: match[1] ?? match[0], value: match[1] ?? match[0], context: '' })
    }
    return values
  }
  // El orden entre dos instantes, con la resolución más gruesa de los dos: un instante en segundos no ordena contra
  // los milisegundos de otro que cae en el mismo segundo.
  const order = (x, y) => {
    const coarse = !/:\d{2}\.\d/.test(x) || !/:\d{2}\.\d/.test(y)
    const a = Date.parse(x); const b = Date.parse(y)
    return coarse ? Math.sign(Math.floor(a / 1000) - Math.floor(b / 1000)) : Math.sign(a - b)
  }
  const gap = (x, y) => Math.abs(Date.parse(x) - Date.parse(y))
  const fine = (x) => /:\d{2}\.\d/.test(x)
  // Una marca copiada: el mismo texto en dos lugares de un lado y textos que distan en el otro más de lo que explica la
  // resolución (1 s con milisegundos; 2 s en segundos, porque dos eventos del mismo segundo pueden caer en segundos
  // contiguos del otro lado). Solo cuentan los textos idénticos: dos instantes de formatos distintos que caen en el
  // mismo segundo son eventos distintos, no una copia.
  const copyBroken = (x, y, u, v) => x === y && u !== v && gap(u, v) >= (fine(x) ? 1000 : 2000)
  // Dos ocurrencias rompen las relaciones si se ordenan al revés en cada lado, o si una marca copiada deja de serlo.
  const broken = (a, b, i, j) => order(a[i], a[j]) * order(b[i], b[j]) < 0 || copyBroken(a[i], a[j], b[i], b[j]) || copyBroken(b[i], b[j], a[i], a[j])
  const rules = []
  for (const { kind, regex, symbol, ordered, contextual } of patterns) {
    const a = found(left, regex, contextual); const b = found(right, regex, contextual)
    if (a.length !== b.length) continue
    if (kind === 'time') {
      const x = a.map((o) => o.text); const y = b.map((o) => o.text)
      if (ordered && x.some((_, i) => x.some((__, j) => j > i && broken(x, y, i, j)))) continue
      for (const value of new Set(x)) rules.push({ kind, side: 'left', value, symbol })
      for (const value of new Set(y)) rules.push({ kind, side: 'right', value, symbol })
      continue
    }
    // Se empareja por ocurrencia, en el mismo orden de recorrido. Un valor que se emparejaría con dos distintos, o una
    // ocurrencia con otro contexto en cada lado, rompe la correspondencia: ese valor no se normaliza.
    const forward = new Map(); const backward = new Map(); const rejected = new Set()
    a.forEach((occurrence, i) => {
      const other = b[i]
      if ((forward.has(occurrence.value) && forward.get(occurrence.value) !== other.value) ||
        (backward.has(other.value) && backward.get(other.value) !== occurrence.value) || occurrence.context !== other.context) rejected.add(occurrence.value)
      forward.set(occurrence.value, other.value); backward.set(other.value, occurrence.value)
    })
    const numbers = new Map(); const emitted = new Set()
    a.forEach((occurrence, i) => {
      const other = b[i]
      if (occurrence.value === other.value || rejected.has(occurrence.value) || emitted.has(occurrence.text)) return
      emitted.add(occurrence.text)
      if (!numbers.has(occurrence.value)) numbers.set(occurrence.value, numbers.size + 1)
      // Las reglas de un mismo par de valores en contextos distintos comparten número de símbolo.
      rules.push({ kind, left: occurrence.text, right: other.text, symbol: contextual ? `${symbol}${numbers.get(occurrence.value)}:${occurrence.context}` : `${symbol}${numbers.get(occurrence.value)}` })
    })
  }
  return rules
}

/**
 * Las referencias de integridad entre digests citados y archivos capturados. Un digest (`sha256:<hex>` o el hex
 * solo) que aparece en el estado y coincide con el hash de un archivo capturado se empareja con el archivo de la
 * misma ruta del otro lado, traducida con las reglas de ids. Se ordenan por dependencia: primero los archivos que
 * no citan a otros referenciados, para que compareStates recalcule cada derivado sobre contenido ya normalizado.
 */
export function deriveIntegrity(left, right, rules = []) {
  const hashes = (state) => {
    const byDigest = new Map()
    for (const [path, file] of Object.entries(state.files ?? {})) {
      if (!file || typeof file.bytes !== 'string') continue
      const hex = createHash('sha256').update(Buffer.from(file.bytes, 'base64')).digest('hex')
      byDigest.set(`sha256:${hex}`, path); byDigest.set(hex, path)
    }
    return byDigest
  }
  const leftHashes = hashes(left)
  const rightPaths = new Map(Object.entries(right.files ?? {}))
  // Solo las correspondencias traducen rutas: una regla por clase no tiene un valor del otro lado.
  const toRight = (path) => rules.filter((rule) => rule.side === undefined).reduce((p, rule) => p.split(rule.left).join(rule.right), path)
  const text = JSON.stringify(left) + Object.values(left.files ?? {}).map((f) => {
    if (!f || typeof f.bytes !== 'string') return ''
    const bytes = Buffer.from(f.bytes, 'base64'); const utf8 = bytes.toString('utf8')
    return Buffer.from(utf8, 'utf8').equals(bytes) ? utf8 : ''
  }).join('\n')
  const refs = []
  const seen = new Set()
  for (const match of text.matchAll(/(?:sha256:)?\b[0-9a-f]{64}\b/g)) {
    const digest = match[0]
    const path = leftHashes.get(digest)
    if (!path || seen.has(digest)) continue
    const rightPath = toRight(path)
    const rightFile = rightPaths.get(rightPath)
    if (!rightFile || typeof rightFile.bytes !== 'string') continue
    seen.add(digest)
    const hex = createHash('sha256').update(Buffer.from(rightFile.bytes, 'base64')).digest('hex')
    refs.push({ left: { path, digest }, right: { path: rightPath, digest: digest.startsWith('sha256:') ? `sha256:${hex}` : hex } })
  }
  const contentOf = (state, path) => Buffer.from(state.files[path].bytes, 'base64').toString('utf8')
  const ordered = []
  const pending = [...refs]
  while (pending.length > 0) {
    const ready = pending.findIndex((ref) => !pending.some((other) => other !== ref && contentOf(left, ref.left.path).includes(other.left.digest.replace(/^sha256:/, ''))))
    ordered.push(...pending.splice(ready === -1 ? 0 : ready, 1))
  }
  return ordered
}

/** La primera ruta en la que difieren dos valores canónicos, con un extracto de cada lado. */
function firstDifference(a, b, path = '') {
  const show = (v) => { const s = JSON.stringify(v) ?? String(v); return s.length > 200 ? `${s.slice(0, 200)}…` : s }
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    for (const key of keys) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return firstDifference(a[key], b[key], `${path}/${key}`)
    }
  }
  if (path.endsWith('/bytes') && typeof a === 'string' && typeof b === 'string') {
    const la = Buffer.from(a, 'base64').toString('utf8').split('\n'); const lb = Buffer.from(b, 'base64').toString('utf8').split('\n')
    const line = la.findIndex((text, i) => text !== lb[i])
    const at = line === -1 ? la.length : line
    const x = la[at] ?? ''; const y = lb[at] ?? ''
    let c = 0; while (c < x.length && x[c] === y[c]) c++
    const from = Math.max(0, c - 60)
    return { path: `${path} (línea ${at + 1}, columna ${c + 1})`, left: show(x.slice(from, c + 140)), right: show(y.slice(from, c + 140)) }
  }
  return { path, left: show(a), right: show(b) }
}

export function compareStates(left, right, rules = [], integrity = []) {
  validateRecordedIntegrity(left); validateRecordedIntegrity(right)
  // Un símbolo es de una clase de tiempo (muchos valores por lado) o de una sola correspondencia, nunca de las dos.
  const leftMap = new Map(); const rightMap = new Map(); const classes = new Set(); const pairs = new Set()
  for (const rule of rules) {
    if (!['root', 'time', 'run_id', 'derived_digest', 'pid', 'inode'].includes(rule.kind) || typeof rule.symbol !== 'string' || !rule.symbol) fail('regla de normalización inválida')
    if (rule.kind === 'time') {
      if (!['left', 'right'].includes(rule.side) || typeof rule.value !== 'string' || !timeShape(rule.symbol, rule.value)) fail('regla de normalización inválida')
      const map = rule.side === 'left' ? leftMap : rightMap
      if (map.has(rule.value) || pairs.has(rule.symbol)) fail('normalización no biyectiva')
      map.set(rule.value, rule.symbol); classes.add(rule.symbol)
      continue
    }
    if (rule.side !== undefined || typeof rule.left !== 'string' || typeof rule.right !== 'string' || !rule.left || !rule.right) fail('regla de normalización inválida')
    if (leftMap.has(rule.left) || rightMap.has(rule.right) || pairs.has(rule.symbol) || classes.has(rule.symbol)) fail('normalización no biyectiva')
    leftMap.set(rule.left, rule.symbol); rightMap.set(rule.right, rule.symbol); pairs.add(rule.symbol)
  }
  // Una regla reemplaza un token completo: no se aplica dentro de otro número, hash o nombre más largo.
  const word = /[0-9A-Za-z_]/
  const bounded = (text, from, i) => {
    const before = text[i - 1] ?? ''; const after = text[i + from.length] ?? ''
    if (word.test(from[0]) && word.test(before)) return false
    if (word.test(from.at(-1)) && word.test(after)) return false
    return !(/\d/.test(from.at(-1)) && after === '.' && /\d/.test(text[i + from.length + 1] ?? ''))
  }
  const replace = (text, map) => {
    const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length)
    let result = ''
    for (let i = 0; i < text.length;) {
      const entry = entries.find(([from]) => text.startsWith(from, i) && bounded(text, from, i))
      if (entry) { result += `<${entry[1]}>`; i += entry[0].length } else result += text[i++]
    }
    return result
  }
  for (const reference of integrity) {
    const canonical = []
    const texts = []
    for (const [state, map, side] of [[left, leftMap, 'left'], [right, rightMap, 'right']]) {
      const file = state.files?.[reference[side].path]
      if (!file || typeof file.bytes !== 'string') fail('contenido de integridad ausente')
      const bytes = Buffer.from(file.bytes, 'base64')
      const digest = reference[side].digest
      // Los digests se citan con prefijo (`sha256:<hex>`) o como hex solo, como las salidas de un recibo.
      if (sha256(bytes) !== digest && sha256(bytes) !== `sha256:${digest}`) fail(`digest inválido: ${reference[side].path}`)
      const utf8 = bytes.toString('utf8')
      const normalized = Buffer.from(utf8, 'utf8').equals(bytes) ? Buffer.from(replace(utf8, map)) : bytes
      canonical.push(sha256(normalized))
      texts.push(normalized.toString('utf8'))
      if (map.has(digest) && map.get(digest) !== sha256(normalized)) fail('un digest perdió su relación con el contenido')
      map.set(digest, sha256(normalized))
    }
    if (canonical[0] !== canonical[1]) {
      const la = texts[0].split('\n'); const lb = texts[1].split('\n'); const at = la.findIndex((line, i) => line !== lb[i])
      fail(`contenidos íntegros distintos en ${reference.left.path} (línea ${at + 1}): ${JSON.stringify(la[at]).slice(0, 300)} ≠ ${JSON.stringify(lb[at]).slice(0, 300)}`)
    }
  }
  const canonicalize = (value, map, key = '') => {
    if (typeof value === 'string') {
      if (key === 'bytes') {
        const bytes = Buffer.from(value, 'base64'); const utf8 = bytes.toString('utf8')
        return Buffer.from(utf8, 'utf8').equals(bytes) ? Buffer.from(replace(utf8, map)).toString('base64') : value
      }
      return replace(value, map)
    }
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, map))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [replace(name, map), canonicalize(item, map, name)]))
    return value
  }
  const a = canonicalize(left, leftMap); const b = canonicalize(right, rightMap)
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    // Toda diferencia queda identificada para la decisión de Max: la ruta y los dos valores normalizados.
    const where = firstDifference(a, b)
    fail(`diferencia fuera de las normalizaciones declaradas en ${where.path || '<raíz>'}: ${where.left} ≠ ${where.right}`)
  }
  return { equivalent: true, rules, integrity_checks: integrity.length }
}

export async function checkEquivalence(manifest, candidateRoot) {
  if (!manifest.candidate?.fingerprint || !manifest.base_commit || !Array.isArray(manifest.equivalence) || manifest.equivalence.length === 0) fail('manifiesto de equivalencia incompleto')
  const { candidateFingerprint } = await import(pathToFileURL(resolve(candidateRoot, 'src/git.ts')).href)
  const actual = withGitEnv({}, () => candidateFingerprint(candidateRoot, 'git-memo-228', manifest.base_commit))
  if (JSON.stringify(actual) !== JSON.stringify(manifest.candidate.fingerprint)) fail('huella del candidato distinta')
  const config = (name) => {
    try { return execFileSync('git', ['config', '--get', name], { cwd: candidateRoot, env: cleanGitEnv(), encoding: 'utf8' }).trim() } catch (error) {
      if (error.status === 1) return null
      throw error
    }
  }
  const modes = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: candidateRoot, env: cleanGitEnv(), encoding: 'utf8' })
  const newPaths = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: candidateRoot, env: cleanGitEnv(), encoding: 'utf8' }).split('\0').filter(Boolean)
  const newModes = newPaths.map((path) => {
    const stat = lstatSync(resolve(candidateRoot, path))
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644'
    if (mode !== '100644') fail(`archivo nuevo con modo distinto de 100644: ${path}`)
    return { path, mode }
  })
  const results = manifest.equivalence.map((entry) => ({ name: entry.name, ...compareStates(entry.baseline, entry.candidate, entry.rules, entry.integrity) }))
  return { schema: 1, candidate: actual, core_autocrlf: config('core.autocrlf'), core_filemode: config('core.filemode'), tracked_modes: modes, new_file_modes: newModes, results }
}
export function summarize(values) {
  if (!values.length || values.some((n) => !Number.isFinite(n))) fail('muestras numéricas incompletas')
  const median = (items) => { const s = [...items].sort((a, b) => a - b); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2 }
  const center = median(values)
  return { n: values.length, median: center, mad: median(values.map((n) => Math.abs(n - center))), min: Math.min(...values), max: Math.max(...values) }
}

export function aggregate(rows) {
  const attempts = new Map()
  const completions = new Map()
  const memo = new Map()
  const counts = new Map()
  const lastSequence = new Map()
  for (const row of rows) {
    if (row.schema !== 1 || !Number.isInteger(row.pid) || typeof row.operation !== 'string') fail('esquema de traza desconocido o incompleto')
    if (row.kind === 'correlation_error') fail(`correlación incompleta: ${JSON.stringify(row)}`)
    if (row.kind === 'memo') {
      const e = row.event
      if (e?.v !== 1 || !Number.isInteger(e.seq) || !['hit', 'miss', 'store', 'discard', 'bypass'].includes(e.kind)) fail('evento de memo inválido')
      if (!['repoRoot', 'gitDirs', 'objects'].includes(e.query) || typeof e.key !== 'string' || typeof e.reason !== 'string' ||
        !(e.scope === null || Number.isInteger(e.scope)) || !(e.call === null || Number.isInteger(e.call))) fail('campos de memo incompletos')
      // Un proceso se identifica por su operación y su PID: dos operaciones de una muestra escriben en la misma
      // traza, y un PID puede reutilizarse entre ellas.
      const source = `${row.operation}|${row.pid}`
      const id = `${source}:${e.seq}`
      if (memo.has(id)) fail(`evento duplicado: ${id}`)
      if (e.seq <= (lastSequence.get(source) ?? 0)) fail('secuencia de memo fuera de orden')
      lastSequence.set(source, e.seq)
      memo.set(id, { ...e, operation: row.operation })
      if (e.kind === 'bypass' && !['no_scope', 'legacy', 'redirect_env', 'stamp_unreadable'].includes(e.reason)) fail(`bypass desconocido: ${e.reason}`)
      if (e.kind === 'discard' && !['stale_stamp', 'stamp_unreadable', 'unstable', 'incoherent'].includes(e.reason)) fail(`discard desconocido: ${e.reason}`)
    } else if (row.kind === 'process') {
      const target = row.stage === 'attempt' ? attempts : row.stage === 'completion' ? completions : fail('fase de proceso desconocida')
      if (typeof row.id !== 'string') fail('proceso duplicado o sin id')
      const id = `${row.operation}|${row.id}`
      if (target.has(id)) fail('proceso duplicado o sin id')
      target.set(id, row)
    } else fail('clase de evento desconocida')
  }
  const linked = new Set()
  let processes = 0
  let duration = 0
  let gitQueries = 0
  for (const [id, attempt] of attempts) {
    const end = completions.get(id)
    if (!end || typeof end.observed !== 'boolean' || !Number.isFinite(end.duration_ms) || end.duration_ms < 0) fail(`proceso incompleto: ${id}`)
    if (end.pid !== attempt.pid || end.operation !== attempt.operation) fail('completion de otro proceso u operación')
    if (!Array.isArray(attempt.argv) || typeof attempt.cwd !== 'string' || typeof attempt.api !== 'string') fail('lanzamiento incompleto')
    processes += Number(end.observed)
    if (end.observed) duration += end.duration_ms
    if (attempt.query) gitQueries++
    let event = null
    if (attempt.memo !== null && attempt.memo !== undefined) {
      const ref = `${attempt.operation}|${attempt.pid}:${attempt.memo}`
      event = memo.get(ref)
      if (!event || !['miss', 'bypass'].includes(event.kind) || event.query !== attempt.query || event.operation !== attempt.operation || linked.has(ref)) fail(`asociación inválida: ${id}`)
      linked.add(ref)
    }
    const key = JSON.stringify([attempt.pid, attempt.operation, attempt.query, attempt.cwd, event?.key ?? null, event?.scope ?? null, event?.call ?? null])
    const group = counts.get(key) ?? { pid: attempt.pid, operation: attempt.operation, query: attempt.query, input: attempt.cwd,
      key: event?.key ?? null, scope: event?.scope ?? null, call: event?.call ?? null, attempts: 0, processes: 0, duration_ms: 0, attempt_duration_ms: 0 }
    group.attempts++; group.processes += Number(end.observed)
    group.attempt_duration_ms += end.duration_ms
    if (end.observed) group.duration_ms += end.duration_ms
    counts.set(key, group)
  }
  if (completions.size !== attempts.size) fail('completion sin attempt')
  for (const [id, e] of memo) {
    if (['miss', 'bypass'].includes(e.kind) && !linked.has(id)) fail(`consulta no correlacionada: ${id}`)
    if (['store', 'discard'].includes(e.kind)) {
      const ref = memo.get(`${id.slice(0, id.lastIndexOf(':'))}:${e.ref}`)
      if (!ref || ref.query !== e.query || ref.key !== e.key || ref.scope !== e.scope) fail('referencia de memo inválida')
      if (e.kind === 'store' && ref.kind !== 'miss') fail('store sin miss')
      if (e.kind === 'discard' && e.reason === 'stale_stamp' && ref.kind !== 'store') fail('stale_stamp sin store')
      if (e.kind === 'discard' && ['unstable', 'incoherent'].includes(e.reason) && ref.kind !== 'miss') fail('captura descartada sin miss')
      if (e.kind === 'discard' && e.reason === 'stamp_unreadable' && !['miss', 'store'].includes(ref.kind)) fail('estampa ilegible sin consulta o entrada')
      if (ref.seq >= e.seq || ref.call !== e.call || ref.operation !== e.operation) fail('referencia de memo fuera de su llamada')
    }
  }
  // Una segunda consulta con un store vigente requiere un descarte previo de esa misma entrada.
  const live = new Map()
  for (const [id, e] of memo) {
    const source = id.slice(0, id.lastIndexOf(':'))
    const key = JSON.stringify([source, e.scope, e.query, e.key])
    if (e.kind === 'store') live.set(key, e.seq)
    if (e.kind === 'discard' && live.get(key) === e.ref) live.delete(key)
    if (e.kind === 'miss' && live.has(key)) fail('consulta repetida con estampa estable')
    if (e.kind === 'hit' && !live.has(key)) fail('hit sin entrada vigente')
  }
  return { schema: 1, trace: rows, attempts: attempts.size, observed_processes: processes, git_queries: gitQueries,
    accumulated_duration: { value: duration, unit: 'ms', source: 'Node launch-to-return-or-close' },
    groups: [...counts.values()], memo_events: memo.size,
    memo_counts: Object.fromEntries(['hit', 'miss', 'store', 'discard', 'bypass'].map((kind) => [kind, [...memo.values()].filter((e) => e.kind === kind).length])) }
}

/**
 * Valida un informe. Con `requireMeasurement`, exige la medición completa: muestras con pares válidos, sus artefactos
 * (resueltos desde `artifactsRoot`), el overhead y las diferencias recalculados, y la huella del árbol actual.
 */
export async function validateReport(report, { requireMeasurement = false, candidateRoot = resolve(import.meta.dirname, '..'), artifactsRoot = '.' } = {}) {
  if (report.schema !== 1) fail('esquema de informe desconocido')
  // Un informe es de una traza (grupos por proceso y consulta) o de una medición (grupos por escenario y condición):
  // las dos formas usan el mismo nombre `groups` y no se pueden validar juntas.
  if (report.trace && report.samples) fail('un informe trae traza o muestras, no las dos')
  if (report.trace) {
    const actual = aggregate(report.trace)
    for (const name of ['attempts', 'observed_processes', 'git_queries', 'accumulated_duration', 'groups', 'memo_counts']) {
      if (JSON.stringify(report[name]) !== JSON.stringify(actual[name])) fail(`agregado incoherente: ${name}`)
    }
  }
  else if (!report.samples) fail('informe estructural sin traza para comprobar correlaciones')
  if (requireMeasurement && !report.samples) fail('la medición exige muestras con pares válidos')
  if (report.samples) validateManifest(report, requireMeasurement, artifactsRoot)
  if (requireMeasurement) {
    const { overhead, differences, overhead_statistics, difference_statistics, groups, ...manifest } = report
    const expected = compare(manifest)
    for (const [name, value] of Object.entries({ overhead, differences, overhead_statistics, difference_statistics, groups })) {
      if (!Array.isArray(value) || !value.length) fail(`la medición exige ${name}`)
      if (JSON.stringify(value) !== JSON.stringify(expected[name])) fail(`${name} distinto del recalculado sobre las muestras`)
    }
    const { candidateFingerprint } = await import(pathToFileURL(resolve(candidateRoot, 'src/git.ts')).href)
    const actual = withGitEnv({}, () => candidateFingerprint(candidateRoot, 'git-memo-228', report.base_commit))
    if (JSON.stringify(actual) !== JSON.stringify(report.candidate.fingerprint)) fail('huella registrada distinta del árbol actual')
  }
  return { valid: true, measurement: requireMeasurement }
}

export function validateManifest(manifest, requireArtifacts = false, artifactsRoot = '.') {
  // Los artefactos se registran con rutas relativas al informe, así que la validación no depende del host del bench.
  const artifactPath = (artifact) => {
    if (typeof artifact?.path !== 'string' || isAbsolute(artifact.path)) fail('ruta de artefacto ausente o absoluta')
    const path = resolve(artifactsRoot, artifact.path)
    if (!existsSync(path)) fail(`artefacto ausente: ${artifact.path}`)
    return path
  }
  if (manifest.schema !== 1 || typeof manifest.base_commit !== 'string' || typeof manifest.fixture_sha !== 'string' || !manifest.candidate?.fingerprint || typeof manifest.candidate.snapshot_sha !== 'string') fail('identidad de manifiesto incompleta')
  if (!manifest.runtime?.node || !manifest.runtime.git || !manifest.runtime.os || manifest.env?.SDD_AI_TELEMETRY !== 'off' || manifest.env?.SDD_AI_PROJECTION !== 'off' ||
    !Array.isArray(manifest.env.inherited_git_variables) || manifest.env.inherited_git_variables.length) fail('runtime o entorno incompleto')
  if (!Array.isArray(manifest.samples) || !manifest.samples.length) fail('faltan muestras')
  const ids = new Set(); const rounds = new Map()
  for (const sample of manifest.samples) {
    if (!sample.valid) fail('muestra inválida incluida entre las válidas')
    if (ids.has(sample.id)) fail('muestra duplicada')
    ids.add(sample.id)
    if (!['verify', 'commit'].includes(sample.scenario) || !['baseline', 'candidate'].includes(sample.version) || typeof sample.instrumented !== 'boolean' || !Number.isInteger(sample.round) || sample.round < 0) fail('condición desconocida')
    if (sample.fixture_sha !== manifest.fixture_sha || sample.initial_identity?.head !== manifest.fixture_sha) fail('SHA de fixture o estado inicial distinto')
    if (sample.scenario === 'verify' && !(sample.executed_rows > 0) || sample.scenario === 'commit' && sample.commit_created !== true) fail('muestra que no alcanzó el camino requerido')
    if (sample.version_pair !== `${sample.scenario}:${sample.round}:${sample.instrumented}` || sample.overhead_pair !== `${sample.scenario}:${sample.round}:${sample.version}`) fail('identidad de par incoherente')
    for (const name of ['cpu', 'wall']) {
      const expected = name === 'cpu' ? '/usr/bin/time user+sys' : '/usr/bin/time real'
      if (sample[name]?.unit !== 's' || sample[name]?.source !== expected || !Number.isFinite(sample[name]?.value) || sample[name].value < 0) fail(`unidad o fuente ambigua: ${name}`)
    }
    if (!Array.isArray(sample.operations) || !sample.operations.length || sample.operations.some((op) => op.exit_code !== 0 || !Array.isArray(op.command) || op.command[0] !== '/usr/bin/time' || op.load_before?.length !== 3 || op.load_after?.length !== 3)) fail('operaciones o registro de carga incompletos')
    for (const op of sample.operations) {
      if (!Number.isFinite(op.cpu.user) || !Number.isFinite(op.cpu.sys) || op.cpu.user < 0 || op.cpu.sys < 0 || op.cpu.value !== op.cpu.user + op.cpu.sys || op.cpu.source !== '/usr/bin/time user+sys' || op.cpu.unit !== 's' || op.wall.unit !== 's' || op.wall.source !== '/usr/bin/time real') fail('CPU user+sys o pared no acreditada por la operación')
      const timing = /^real\s+([\d.]+)\s*\nuser\s+([\d.]+)\s*\nsys\s+([\d.]+)$/.exec(op.timing_stderr ?? '')
      if (!timing || Number(timing[1]) !== op.wall.value || Number(timing[2]) !== op.cpu.user || Number(timing[3]) !== op.cpu.sys) fail('métricas distintas de la salida original de time')
    }
    for (const name of ['cpu', 'wall']) if (sample[name].value !== sample.operations.reduce((sum, op) => sum + op[name].value, 0)) fail('métrica sumada incoherente')
    const duration = sample.accumulated_duration
    if (!duration || duration.unit !== 'ms' || (sample.instrumented
      ? !Number.isFinite(duration.value) || duration.value < 0 || duration.source !== 'Node launch-to-return-or-close'
      : duration.value !== null || duration.source !== 'not instrumented')) fail('duración acumulada ambigua')
    const key = `${sample.scenario}:${sample.round}`
    const peers = rounds.get(key) ?? []
    peers.push(sample); rounds.set(key, peers)
    if (requireArtifacts) {
      if (!Array.isArray(sample.artifacts) || sample.artifacts.length < (sample.instrumented ? 4 : 2)) fail('artefactos de muestra ausentes')
      for (const artifact of sample.artifacts) if (sha256(readFileSync(artifactPath(artifact))) !== artifact.digest) fail('artefacto modificado o incompleto')
      const initialArtifact = sample.artifacts.find((artifact) => artifact.path.endsWith('.initial.json'))
      if (!initialArtifact) fail('estado inicial original ausente')
      const initial = JSON.parse(readFileSync(artifactPath(initialArtifact), 'utf8'))
      const identity = { head: initial.head, tree: initial.tree, index: initial.index,
        candidate_files: Object.fromEntries(Object.entries(initial.files).filter(([name]) => name.startsWith('src/') || name.startsWith('test/'))) }
      if (JSON.stringify(identity) !== JSON.stringify(sample.initial_identity)) fail('estado inicial distinto del original')
      validateReceiptIntegrity(initial)
      const trace = sample.artifacts.find((artifact) => artifact.path.endsWith('.trace.jsonl'))
      if (sample.instrumented) {
        if (!trace) fail('traza ausente')
        const result = aggregate(readFileSync(artifactPath(trace), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
        if (result.observed_processes !== sample.observed_processes || result.git_queries !== sample.git_queries || result.accumulated_duration.value !== duration.value) fail('agregado distinto de la traza original')
      }
      const evidence = sample.artifacts.find((artifact) => artifact.path.endsWith('.evidence.json'))
      if (!evidence) fail('evidencia de camino ausente')
      const data = JSON.parse(readFileSync(artifactPath(evidence), 'utf8'))
      if (JSON.stringify(data.operations) !== JSON.stringify(sample.operations) || data.before_head !== sample.fixture_sha || data.final?.head !== data.after_head) fail('operaciones o HEAD distintos de la evidencia original')
      validateReceiptIntegrity(data.final)
      if (sample.scenario === 'verify') {
        const count = data.receipt?.rows?.filter((row) => row.execution?.exit_code === 0).length ?? 0
        if (!data.receipt?.green || data.receipt.mode !== 'final' || count !== sample.executed_rows || count !== data.receipt.rows.length) fail('recibo o filas no acreditados')
        const operation = data.operations[0]
        const matching = Object.entries(data.final.files ?? {}).filter(([path]) => path.endsWith(`/sdd-ai/verify/${operation.json?.receipt}/receipt.json`))
        if (matching.length !== 1) fail('cuerpo original del recibo medido ausente o ambiguo')
        const bytes = Buffer.from(matching[0][1].bytes, 'base64')
        if (sha256(bytes) !== operation.json.digest || JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(data.receipt)) fail('recibo medido distinto de su cuerpo o digest original')
      } else {
        if (data.operations.length !== 2 || data.operations[0].json?.state !== 'dry_run' || data.before_head === data.after_head || data.operations[1].json?.sha !== data.after_head || data.after_parent !== data.before_head) fail('commit no acreditado')
        // El flujo del fixture lo registra el bench en la evidencia, junto a las operaciones que lo usaron.
        if (typeof data.flow !== 'string' || !data.flow) fail('flujo del fixture ausente en la evidencia')
        const registryFile = data.final.files?.[`.plans/${data.flow}/sdd-ai-phases.json`]
        const registry = registryFile ? JSON.parse(Buffer.from(registryFile.bytes, 'base64').toString('utf8')) : null
        if (registry?.commit?.state !== 'done' || registry.commit.sha !== data.after_head || registry.commit.tree !== data.final.tree) fail('registro de commit distinto del HEAD o árbol acreditado')
      }
    }
  }
  for (const [key, peers] of rounds) {
    if (peers.length !== 4 || new Set(peers.map((p) => `${p.version}:${p.instrumented}`)).size !== 4) fail(`par incompleto: ${key}`)
    const ordered = [...peers].sort((a, b) => a.order - b.order)
    if (ordered.some((sample, i) => sample.order !== i)) fail('orden de muestras incompleto')
    const expectedVersion = ordered[0].round % 2 === 0 ? 'baseline' : 'candidate'
    const expectedCondition = ordered[0].round % 2 !== 0
    if (ordered[0].version !== expectedVersion || ordered[0].instrumented !== expectedCondition || ordered[1].version !== expectedVersion || ordered[1].instrumented === expectedCondition || ordered[2].version === expectedVersion || ordered[2].instrumented !== expectedCondition) fail('orden no alternado')
    if (peers.some((sample) => JSON.stringify(sample.initial_identity) !== JSON.stringify(peers[0].initial_identity))) fail('estado inicial no equivalente')
  }
  for (const scenario of ['verify', 'commit']) {
    const seen = [...rounds.keys()].filter((key) => key.startsWith(`${scenario}:`))
    if (seen.length < 3) fail(`${scenario}: muestras insuficientes`)
  }
  return true
}

export function compare(manifest) {
  if (manifest.schema !== 1 || !Array.isArray(manifest.samples) || !manifest.samples.length) fail('manifiesto incompleto')
  const groups = new Map()
  for (const sample of manifest.samples) {
    if (!sample.valid) continue
    const key = JSON.stringify([sample.scenario, sample.version, sample.instrumented])
    const group = groups.get(key) ?? { scenario: sample.scenario, version: sample.version, instrumented: sample.instrumented, samples: [] }
    for (const name of ['cpu', 'wall', 'accumulated_duration']) {
      const metric = sample[name]
      if (!metric || (name === 'accumulated_duration' && !sample.instrumented ? metric.value !== null : !Number.isFinite(metric.value)) || typeof metric.source !== 'string' || !['ms', 's'].includes(metric.unit)) fail(`unidad o fuente ambigua: ${name}`)
    }
    group.samples.push(sample)
    groups.set(key, group)
  }
  const paired = (kind) => {
    const pairs = new Map()
    for (const sample of manifest.samples.filter((s) => s.valid)) { const key = sample[kind]; const pair = pairs.get(key) ?? []; pair.push(sample); pairs.set(key, pair) }
    return [...pairs.entries()].map(([id, pair]) => {
      if (pair.length !== 2) fail('par de comparación incompleto')
      const positive = pair.find((s) => kind === 'overhead_pair' ? s.instrumented : s.version === 'candidate')
      const negative = pair.find((s) => kind === 'overhead_pair' ? !s.instrumented : s.version === 'baseline')
      if (!positive || !negative) fail('condiciones de par inválidas')
      return { id, scenario: positive.scenario, version: kind === 'overhead_pair' ? positive.version : null,
        instrumented: kind === 'version_pair' ? positive.instrumented : null,
        cpu_delta_s: positive.cpu.value - negative.cpu.value, wall_delta_s: positive.wall.value - negative.wall.value }
    })
  }
  validateManifest(manifest)
  const overhead = paired('overhead_pair'); const differences = paired('version_pair')
  const dispersions = (items) => {
    const collected = new Map()
    for (const item of items) { const key = JSON.stringify([item.scenario, item.version, item.instrumented]); const rows = collected.get(key) ?? []; rows.push(item); collected.set(key, rows) }
    return [...collected.entries()].map(([condition, rows]) => ({ condition: JSON.parse(condition), cpu_delta_s: summarize(rows.map((r) => r.cpu_delta_s)), wall_delta_s: summarize(rows.map((r) => r.wall_delta_s)) }))
  }
  return { ...manifest, overhead, differences, overhead_statistics: dispersions(overhead), difference_statistics: dispersions(differences),
    groups: [...groups.values()].map((group) => ({ ...group, statistics: Object.fromEntries(['cpu', 'wall', 'accumulated_duration'].map((name) => {
    const first = group.samples[0][name]
    if (!group.samples.every((sample) => sample[name].source === first.source && sample[name].unit === first.unit)) fail(`unidades mezcladas: ${name}`)
    return [name, { ...(first.value === null ? { n: 0, median: null, mad: null, min: null, max: null } : summarize(group.samples.map((sample) => sample[name].value))), unit: first.unit, source: first.source }]
  })) })) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, ...args] = process.argv.slice(2)
    const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
    const input = option('--input')
    if (!input) fail('falta --input')
    const text = readFileSync(input, 'utf8')
    const result = command === 'check-equivalence' ? await checkEquivalence(JSON.parse(text), option('--candidate-root') ?? resolve(import.meta.dirname, '..'))
      : command === 'aggregate' ? aggregate(text.split('\n').filter(Boolean).map((line) => JSON.parse(line)))
      : command === 'compare' ? compare(JSON.parse(text))
        : command === 'validate' ? await validateReport(JSON.parse(text), { requireMeasurement: args.includes('--require-measurement'),
          candidateRoot: option('--candidate-root') ?? resolve(import.meta.dirname, '..'), artifactsRoot: option('--artifacts-root') ?? dirname(resolve(input)) })
          : fail('comando no implementado; usa aggregate, compare o validate')
    const output = option('--output')
    if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
    else process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
