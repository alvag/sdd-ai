// Mide el costo de publicar la proyección y su latencia.
//
//   node scripts/measure-projection.mjs stages <raíz> [repeticiones]
//   node scripts/measure-projection.mjs verbs <raíz> [repeticiones] -- <argv> [-- <argv>...]
//   node scripts/measure-projection.mjs latency [publicadores] [segundos]
//   node scripts/measure-projection.mjs rate <archivo de SDD_AI_PROJECTION_MEASURE>
//
// `stages` publica en el `.sdd-ai/projection/` de la raíz dada y no toca nada más. `verbs` corre cada argv, dos veces
// por repetición, sobre la raíz dada: lo que el verbo escriba queda escrito, así que conviene usarlo con verbos de
// lectura, como `sdd status`. Solo `latency` usa un checkout temporal, que borra al terminar. `rate` solo lee el
// registro. Una muestra fallida (código distinto de 0, una señal o un error al lanzarla) o vencida no entra en las
// estadísticas: se cuenta aparte, y el script termina con código 1.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BIN = join(REPO, 'bin', 'sdd-ai')
/** Tope de cada proceso que lanza la medición: una medición colgada no debe colgar al que mide. */
const STEP_TIMEOUT_MS = 120_000

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}
const summary = (values) => ({
  n: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9), max: values.length ? Math.max(...values) : null,
})
const round = (value) => (value === null ? null : Math.round(value * 10) / 10)
const rounded = (s) => ({ n: s.n, p50: round(s.p50), p90: round(s.p90), max: round(s.max) })

async function stages(root, repetitions) {
  const { collectProjection, publishProjection } = await import(join(REPO, 'src', 'projection.ts'))
  const rows = []
  for (let i = 0; i < repetitions; i++) rows.push(publishProjection(root, collectProjection, { publisher: 'cli' }))
  const published = rows.filter((r) => r.kind === 'published')
  const out = {}
  for (const key of ['entry_ms', 'read_ms', 'serialize_ms', 'write_ms', 'prune_ms', 'total_ms']) {
    out[key] = rounded(summary(published.map((r) => r.timings[key])))
  }
  const failures = rows.filter((r) => r.kind !== 'published').map((r) => r.cause)
  return { root, repetitions, failures, stages: out, failed: failures.length > 0 }
}

/** Una muestra: lo que tardó el verbo y cómo terminó. Solo vale la que terminó con 0, sin señal ni error. */
function timed(argv, root, env) {
  const started = process.hrtime.bigint()
  const r = spawnSync(process.execPath, [BIN, ...argv], { cwd: root, env, encoding: 'utf8', timeout: STEP_TIMEOUT_MS })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const error = r.error ? (r.error.code === 'ETIMEDOUT' ? `vencida a los ${STEP_TIMEOUT_MS} ms` : r.error.message) : null
  return { ms, code: r.status, signal: r.signal, error, ok: error === null && r.signal === null && r.status === 0 }
}

/** Las líneas del registro cuando deja de crecer: las publicaciones en segundo plano llegan después del verbo. */
function settled(file) {
  const read = () => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  let last = read()
  const deadline = Date.now() + 8000
  let quietSince = Date.now()
  while (Date.now() < deadline && Date.now() - quietSince < 1500) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    const now = read()
    if (now !== last) { last = now; quietSince = Date.now() }
  }
  return last.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function verbs(root, repetitions, commands) {
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-measure-'))
  // Con publicación: el entorno sin el interruptor que la apaga.
  const { SDD_AI_PROJECTION: _off, ...published } = process.env
  try {
    const results = []
    for (const argv of commands) {
      const without = []
      const withPublication = []
      const publications = []
      const failures = []
      for (let i = 0; i < repetitions; i++) {
        const plain = timed(argv, root, { ...process.env, SDD_AI_PROJECTION: 'off' })
        const file = join(scratch, `${i}-${argv.join('_').replace(/[^A-Za-z0-9_-]/g, '')}.jsonl`)
        const measured = timed(argv, root, { ...published, SDD_AI_PROJECTION_MEASURE: file })
        // Las publicaciones en segundo plano terminan antes de la muestra siguiente, aunque esta no valga.
        const lines = settled(file)
        // Las dos muestras de una repetición se comparan entre sí: si una falló, no entra ninguna.
        const failed = [['without', plain], ['with', measured]].filter(([, sample]) => !sample.ok)
        if (failed.length) {
          for (const [run, sample] of failed) failures.push({ repetition: i, run, code: sample.code, signal: sample.signal, error: sample.error })
          continue
        }
        without.push(plain.ms)
        withPublication.push(measured.ms)
        publications.push(lines)
      }
      const done = publications.map((p) => p.filter((line) => line.result === 'published'))
      results.push({
        argv: argv.join(' '),
        without_ms: rounded(summary(without)),
        with_ms: rounded(summary(withPublication)),
        added_ms: rounded(summary(without.map((w, i) => withPublication[i] - w))),
        publications_per_run: rounded(summary(done.map((p) => p.length))),
        // Un pedido que ya cubría una observación posterior, o que cedió ante la reserva de otro publicador que ya leía
        // después del cambio, no lee nada: se cuenta aparte.
        skipped_per_run: rounded(summary(publications.map((p) => p.filter((line) => line.result === 'skipped').length))),
        publication_ms: rounded(summary(done.flat().map((p) => p.ms))),
        latency_ms: rounded(summary(done.flat().map((p) => p.latency_ms))),
        failures,
      })
    }
    return { root, repetitions, results, failed: results.some((r) => r.failures.length > 0) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Un checkout temporal con corridas sintéticas, para medir sin tocar el real. */
function fixtureCheckout(runs) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-measure-repo-')))
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('-c', 'user.email=m@example.com', '-c', 'user.name=m', 'commit', '-q', '--allow-empty', '-m', 'base')
  for (let i = 0; i < runs; i++) {
    const dir = join(root, '.sdd-ai', 'runs', `20261005-0000-${String(i).padStart(4, '0')}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'request.json'), `${JSON.stringify({ role: 'explore' })}\n`)
    writeFileSync(join(dir, 'status.json'), `${JSON.stringify({ state: 'running', started_at: new Date().toISOString() })}\n`)
  }
  return root
}

const PUBLISHER = `
import { collectProjection, publishProjection } from ${JSON.stringify(join(REPO, 'src', 'projection.ts'))}
const [root, until] = process.argv.slice(2)
while (Date.now() < Number(until)) publishProjection(root, collectProjection, { publisher: 'cli' })
`
const CHANGER = `
import { collectProjection, publishProjection } from ${JSON.stringify(join(REPO, 'src', 'projection.ts'))}
import { setStatus } from ${JSON.stringify(join(REPO, 'src', 'runs.ts'))}
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [root, until] = process.argv.slice(2)
let n = 0
while (Date.now() < Number(until) - 1500) {
  n++
  const dir = join(root, '.sdd-ai', 'runs', '20261005-1000-' + String(n).padStart(4, '0'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ role: 'explore' }) + '\\n')
  setStatus(dir, { state: 'running', started_at: new Date().toISOString() })
  console.log(JSON.stringify({ marker: n, changed: Date.now() }))
  publishProjection(root, collectProjection, { publisher: 'cli' })
  await new Promise((r) => setTimeout(r, 400))
}
`

/**
 * Lanza un hijo y registra en el acto la promesa de su fin: llega aunque termine por una señal antes de que alguien la
 * espere, o aunque no llegue a arrancar. El fin es `close`, no `exit`: llega cuando además se cerraron sus canales, así
 * lo que escribió en stdout ya se leyó entero. Un hijo que pasa de `timeout` se corta.
 */
function launch(args, stdio, timeout) {
  const child = spawn(process.execPath, args, { stdio, timeout })
  const ended = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error: error.message }))
    child.once('close', (code, signal) => resolve({ code, signal, error: null }))
  })
  return { child, ended }
}

async function latency(publishers, seconds) {
  const root = fixtureCheckout(20)
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-measure-'))
  try {
    writeFileSync(join(scratch, 'publisher.mjs'), PUBLISHER)
    writeFileSync(join(scratch, 'changer.mjs'), CHANGER)
    const until = Date.now() + seconds * 1000
    const timeout = seconds * 1000 + STEP_TIMEOUT_MS
    const children = []
    for (let i = 0; i < publishers; i++) children.push(launch([join(scratch, 'publisher.mjs'), root, String(until)], 'ignore', timeout))
    const changer = launch([join(scratch, 'changer.mjs'), root, String(until)], ['ignore', 'pipe', 'ignore'], timeout)
    children.push(changer)
    let out = ''
    changer.child.stdout.on('data', (d) => { out += d })
    const seen = new Map()
    const live = join(root, '.sdd-ai', 'projection', 'live')
    while (Date.now() < until) {
      try {
        const names = readdirSync(live).filter((n) => n.startsWith('obs-')).sort()
        const newest = names.at(-1)
        if (newest) {
          const doc = JSON.parse(readFileSync(join(live, newest), 'utf8'))
          for (const r of doc.runs.items) {
            const m = /^20261005-1000-(\d+)$/.exec(r.id)
            if (m && !seen.has(Number(m[1]))) seen.set(Number(m[1]), Date.now())
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 5))
    }
    const ends = await Promise.all(children.map((c) => c.ended))
    const failures = ends.filter((end) => end.error !== null || end.signal !== null || end.code !== 0)
    const changes = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const delays = changes.filter((c) => seen.has(c.marker)).map((c) => seen.get(c.marker) - c.changed)
    return { publishers, seconds, changes: changes.length, observed: delays.length, latency_ms: rounded(summary(delays)), failures, failed: failures.length > 0 }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * La frecuencia de un registro de `SDD_AI_PROJECTION_MEASURE`. Cada línea es un pedido; solo las `published` son
 * publicaciones: un pedido cubierto o que cedió ante una reserva (`skipped`), o uno fallido, no publica una observación
 * y se cuenta aparte. Las dos
 * frecuencias usan el intervalo del registro entero; la ráfaga, la latencia y lo que tarda cada origen son de las
 * publicaciones.
 */
function rate(file) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.at - b.at)
  if (rows.length === 0) return { requests: 0, publications: 0 }
  const span = (rows.at(-1).at - rows[0].at) / 1000
  const perSecond = (count) => round(count / Math.max(span, 1))
  const published = rows.filter((r) => r.result === 'published')
  let burst = 0
  for (let i = 0, j = 0; i < published.length; i++) {
    while (published[i].at - published[j].at > 1000) j++
    burst = Math.max(burst, i - j + 1)
  }
  const byWhere = {}
  for (const r of published) (byWhere[r.where] ??= []).push(r.ms)
  const latencies = published.map((r) => r.latency_ms).filter((v) => typeof v === 'number')
  return {
    requests: rows.length, span_s: round(span), requests_per_second: perSecond(rows.length),
    publications: published.length, per_second: perSecond(published.length), max_in_1s: burst,
    skipped: rows.filter((r) => r.result === 'skipped').length,
    failures: rows.filter((r) => r.result !== 'published' && r.result !== 'skipped').length,
    latency_ms: rounded(summary(latencies)),
    by_where: Object.fromEntries(Object.entries(byWhere).map(([k, v]) => [k, rounded(summary(v))])),
  }
}

const [mode, ...args] = process.argv.slice(2)
let result
if (mode === 'stages') result = await stages(realpathSync(args[0]), Number(args[1] ?? 15))
else if (mode === 'verbs') {
  const split = args.indexOf('--')
  const head = args.slice(0, split)
  const commands = args.slice(split + 1).join('\u0000').split('\u0000--\u0000').map((c) => c.split('\u0000'))
  result = verbs(realpathSync(head[0]), Number(head[1] ?? 5), commands)
} else if (mode === 'latency') result = await latency(Number(args[0] ?? 4), Number(args[1] ?? 8))
else if (mode === 'rate') result = rate(args[0])
else {
  console.error('uso: stages <raíz> [n] | verbs <raíz> [n] -- <argv> [-- <argv>...] | latency [publicadores] [segundos] | rate <archivo>')
  process.exit(2)
}
console.log(JSON.stringify(result, null, 2))
if (result.failed) process.exitCode = 1
