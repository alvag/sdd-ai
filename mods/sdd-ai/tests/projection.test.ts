import type { FsEntry, FsStat } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import {
  directoryProblem, isAbsence, judgeStat, listingOf, MAX_LIVE_ENTRIES, MAX_OBSERVATION_BYTES, newestFirst, observationName, parseObservation,
  notificationObservation, projectionPaths, refreshBand, selectBand, STALE_AFTER_MS,
} from '../hooks/projection'
import type { BandMemory, BandPresentation, BandSelection, Identity, ProjectionDocument } from '../hooks/projection'
import { BOOT, claimExamples, foreignExamples, observationExamples, OTHER_BOOT, temporaryExamples } from './fixtures/projection-names'

const ROOT = '/work/checkout'
const SESSION = 'session-a'
const OTHER_SESSION = 'session-b'
const T0 = 1_759_680_000_000
const PID = 4242
const IDENTITY: Identity = { session: SESSION, root: ROOT }

const known = <T>(value: T) => ({ value, reason: null })
const unknown = (code: string) => ({ value: null, reason: { code, detail: 'Sin dato.' } })
const stamp = (m0: number) => String(m0).padStart(20, '0')
const nameOf = (m0: number, suffix = 'a', boot = BOOT) => `obs-${stamp(m0)}-${boot}-${PID}-${suffix.repeat(32)}.json`
const NAME = nameOf(100)

type Json = Record<string, unknown>
const run = (id: string, overrides: Json = {}): Json => ({
  id, availability: 'available', reason: null, kind: known('worker'), state: known('running'), open: known('running'), session: known(SESSION),
  flow: unknown('not_recorded'), live: known(true), progress: unknown('not_applicable'), ...overrides,
})
const pending = (id: string, overrides: Json = {}): Json => run(id, { state: known('done'), open: known('undelivered'), live: known(false), ...overrides })
const unreadableRun = (id: string): Json => ({
  id, availability: 'unavailable', reason: { code: 'run_unreadable', detail: 'No se pudo observar la corrida.' }, kind: unknown('run_unreadable'),
  state: unknown('run_unreadable'), open: unknown('run_unreadable'), session: unknown('run_unreadable'), flow: unknown('run_unreadable'),
  live: unknown('run_unreadable'), progress: unknown('run_unreadable'),
})
const job = (key: string, launch = 1) => ({ round: 2, key, launch, state: 'done', admission: known('admitted') })
const progress = (overrides: Json = {}): Json => ({
  phase: 'review', round: 2, launch: 2, planned: ['base:2', 'reliability:1', 'reliability:2'], retained: [job('base:1')], completed: [job('base:2', 2)], total: 4,
  active: known({ key: 'reliability:1', reviewer: known('reliability'), batch: known(1) }), ...overrides,
})
const review = (id: string, overrides: Json = {}): Json => run(id, { kind: known('review'), progress: known(progress()), ...overrides })
const writer = (id: string, overrides: Json = {}): Json => ({
  id, availability: 'available', reason: null, state: known('running'), open: known('running'), session: known(SESSION), flow: unknown('not_recorded'), live: known(true), ...overrides,
})
const flowEntry = (id: string, step = 'implement', gate?: string): Json => ({
  id, availability: 'available', reason: null, observed_at: T0, status: known('planned'),
  view: known({ id, depth: 'completa', gates: [], tasks: { total: 3, done: 1, pending: 2, first_pending: 'T2 — tarea' },
    next: { step, ...(gate ? { gate, artifacts: ['spec.md'] } : {}) }, blocked_reasons: [], notes: [], paths: { dir: `.plans/${id}` } }),
})
const binding = (session: string, flow: string | null, step = 'specify'): Json => ({
  id: session, availability: 'available', reason: null, flow: flow === null ? unknown('unbound') : known({ id: flow, step, gate: null, at: '2026-10-05T00:00:00.000Z' }),
})
const available = (items: Json[]) => ({ availability: items.some((item) => item.availability !== 'available') ? 'partial' : 'available',
  reason: items.some((item) => item.availability !== 'available') ? { code: 'partial', detail: 'Hay entidades ilegibles.' } : null, items })

interface Parts { name?: string; root?: string; observedAt?: number; runs?: Json; writer?: Json; flows?: Json; bindings?: Json }
function doc(parts: Parts = {}): Json {
  const name = parts.name ?? NAME
  const parsed = observationName(name)
  return {
    schema_version: 1, checkout: { id: 'f'.repeat(64), root: parts.root ?? ROOT },
    observation: { id: name, publisher: { pid: parsed?.pid ?? PID, kind: 'cli' }, m0: parsed?.m0 ?? stamp(100), boot: parsed?.boot ?? BOOT,
      observed_at: parts.observedAt ?? T0, read_finished_at: (parts.observedAt ?? T0) + 5 },
    runs: parts.runs ?? available([]), writer: parts.writer ?? { availability: 'available', reason: null, item: null },
    flows: parts.flows ?? available([]), bindings: parts.bindings ?? available([]), omissions: [],
  }
}
function document(parts: Parts = {}): ProjectionDocument {
  const parsed = parseObservation(JSON.stringify(doc(parts)), parts.name ?? NAME, ROOT)
  if (parsed.kind !== 'valid') throw new Error(`fixture inválida: ${parsed.reason}`)
  return parsed.document
}
const band = (parts: Parts, session = SESSION): BandSelection => selectBand(document(parts), session)
const stat = (overrides: Partial<FsStat> = {}): FsStat => ({ kind: 'file', size: 2048, mtimeMs: T0, isLink: false, realPath: projectionPaths(ROOT).observation(NAME), ...overrides })

test('notification extension preserves old presentation and known null delivery without inferring counters', () => {
  for (const version of [undefined, 1, 99]) {
    const source = doc({ runs: available([pending('worker', { session_family: known('claude'), delivery: known({ round: null, launch: null }) })]) })
    if (version !== undefined) source.notifications_version = version
    const parsed = parseObservation(JSON.stringify(source), NAME, ROOT)
    expect(parsed.kind).toBe('valid')
    if (parsed.kind !== 'valid') throw new Error('fixture ilegible')
    expect(selectBand(parsed.document, SESSION).kind).toBe('band')
    expect(notificationObservation(parsed.document).compatible).toBe(version === 1)
    expect(parsed.document.runs.items[0]?.delivery?.value).toEqual(version === 1 ? { round: null, launch: null } : undefined)
  }
  const source = doc({ runs: available([pending('review', { kind: known('review'), delivery: unknown('delivery_unavailable') })]) })
  source.notifications_version = 1
  const parsed = parseObservation(JSON.stringify(source), NAME, ROOT)
  expect(parsed.kind).toBe('valid')
  if (parsed.kind === 'valid') expect(parsed.document.runs.items[0]?.delivery?.value).toBeNull()
  const invalid = doc({ runs: available([pending('bad', { delivery: known({ round: -1, launch: null }) })]) })
  invalid.notifications_version = 1
  expect(parseObservation(JSON.stringify(invalid), NAME, ROOT)).toEqual({ kind: 'unavailable', reason: 'corrupt' })
  const partial = document({ runs: { availability: 'partial', reason: { code: 'partial', detail: 'x' }, items: [pending('known')] } })
  expect(notificationObservation(partial).complete).toBe(false)
})

test('observation names follow the same examples as the contract', () => {
  for (const example of observationExamples) {
    expect(observationName(example.name)).toMatchObject({ name: example.name, m0: example.m0, boot: example.boot, pid: example.pid })
  }
  for (const name of [...temporaryExamples, ...foreignExamples]) expect(observationName(name)).toBeNull()
})

test('observations are ordered by m0 then by the rest of the name whatever the listing order', () => {
  const expected = [
    nameOf(900),
    nameOf(500, 'c', OTHER_BOOT),
    nameOf(500, 'b'),
    nameOf(500, 'a'),
    // El resto del nombre se compara como texto, igual que el binario: `1700-…` va antes que `17-…`.
    `obs-${stamp(500)}-${BOOT}-1700-${'0'.repeat(32)}.json`,
    `obs-${stamp(500)}-${BOOT}-17-${'f'.repeat(32)}.json`,
    nameOf(99),
    nameOf(1),
  ]
  const noise = [...temporaryExamples, ...claimExamples, ...foreignExamples, `tmp-${stamp(1000)}-${BOOT}-1-${'b'.repeat(32)}`]
  const all = [...expected, ...noise]
  // Todas las rotaciones, sus inversas y un barajado fijo: el orden del listado no cuenta.
  const permutations: string[][] = []
  for (let shift = 0; shift < all.length; shift++) {
    const rotated = [...all.slice(shift), ...all.slice(0, shift)]
    permutations.push(rotated, [...rotated].reverse())
  }
  permutations.push(all.map((name, i) => ({ name, key: (i * 7919) % 31 })).sort((a, b) => a.key - b.key).map((entry) => entry.name))
  for (const listing of permutations) expect(newestFirst(listing)).toEqual(expected)
  expect(newestFirst(noise)).toEqual([])
})

test('a listing over 256 entries is flooded and only observation names are candidates', () => {
  const entry = (name: string, kind: FsEntry['kind'] = 'file', isLink = false): FsEntry => ({ name, kind, size: kind === 'file' ? 1 : 0, mtimeMs: kind === 'file' ? T0 : 0, isLink })
  const full = Array.from({ length: MAX_LIVE_ENTRIES }, (_, i) => entry(nameOf(i + 1)))
  expect(listingOf(full)).toEqual({ kind: 'candidates', names: full.map((e) => e.name).reverse() })
  // La entrada 257 inunda `live/` aunque sea un temporal o una reserva: la proyección no está disponible, sin elegir
  // ninguna.
  expect(listingOf([...full, entry(temporaryExamples[0]!)])).toEqual({ kind: 'flooded' })
  expect(listingOf([...full, entry(claimExamples[0]!)])).toEqual({ kind: 'flooded' })
  expect(listingOf([])).toEqual({ kind: 'candidates', names: [] })
  expect(listingOf([...temporaryExamples, ...claimExamples, ...foreignExamples].map((name) => entry(name)))).toEqual({ kind: 'candidates', names: [] })
  // Un directorio o un enlace con nombre de observación es candidato: su `stat` decide, y no se salta a una anterior.
  expect(listingOf([entry(nameOf(1)), entry(nameOf(2), 'dir'), entry(nameOf(3), 'other', true)]))
    .toEqual({ kind: 'candidates', names: [nameOf(3), nameOf(2), nameOf(1)] })
})

test('the directory chain must be real directories', () => {
  const found = (stat: { kind: 'dir' | 'file' | 'other'; isLink: boolean }) => ({ kind: 'found' as const, stat })
  expect(directoryProblem(found({ kind: 'dir', isLink: false }))).toBeNull()
  // Solo una ausencia es `missing`, que se reintenta; una consulta que falló por otro motivo no se puede leer.
  expect(directoryProblem({ kind: 'absent' })).toBe('missing')
  expect(directoryProblem({ kind: 'failed' })).toBe('unreadable')
  expect(directoryProblem(found({ kind: 'dir', isLink: true }))).toBe('link')
  expect(directoryProblem(found({ kind: 'file', isLink: false }))).toBe('not_directory')
  expect(directoryProblem(found({ kind: 'other', isLink: false }))).toBe('not_directory')
  expect(projectionPaths(`${ROOT}/`)).toMatchObject({ root: ROOT, store: `${ROOT}/.sdd-ai`, projection: `${ROOT}/.sdd-ai/projection`, live: `${ROOT}/.sdd-ai/projection/live` })
  expect(projectionPaths(ROOT).observation(NAME)).toBe(`${ROOT}/.sdd-ai/projection/live/${NAME}`)
})

test('the chosen observation must be a regular file at its real path within the read limit', () => {
  const found = (overrides: Partial<FsStat> = {}) => ({ kind: 'found' as const, stat: stat(overrides) })
  expect(judgeStat(found(), NAME, ROOT)).toEqual({ kind: 'readable' })
  expect(judgeStat(found({ size: MAX_OBSERVATION_BYTES }), NAME, ROOT)).toEqual({ kind: 'readable' })
  // Solo una elegida que desapareció deja probar la siguiente: una consulta que falló por otro motivo no la deja.
  expect(judgeStat({ kind: 'absent' }, NAME, ROOT)).toEqual({ kind: 'vanished' })
  expect(judgeStat({ kind: 'failed' }, NAME, ROOT)).toEqual({ kind: 'unavailable', reason: 'unreadable' })
  const cases: [Partial<FsStat>, string][] = [
    [{ isLink: true }, 'link'],
    [{ kind: 'dir', size: 0 }, 'directory'],
    [{ kind: 'other', size: 0 }, 'not_regular'],
    [{ size: MAX_OBSERVATION_BYTES + 1 }, 'too_large'],
    [{ realPath: `/elsewhere/live/${NAME}` }, 'link'],
    [{ realPath: undefined }, 'link'],
  ]
  for (const [overrides, reason] of cases) expect(judgeStat(found(overrides), NAME, ROOT)).toEqual({ kind: 'unavailable', reason })
})

test('only an ENOENT rejection is an absence', () => {
  // Como rechaza el motor una ruta que falta: el `errno` al principio del motivo, también tras el rechazo de un hook.
  expect(isAbsence(new Error("ENOENT: no such file or directory, stat '/x'"))).toBe(true)
  expect(isAbsence(new Error("sdd-ai-mod: $.fs.stat: ENOENT: no such file or directory, stat '/x'"))).toBe(true)
  expect(isAbsence(new Error("sdd-ai-mod: $.fs.list: ENOENT: no such file or directory, scandir '/work/ENOENT/.sdd-ai/projection/live'"))).toBe(true)
  // El formato que emite Claude Code 2.1.289, visto en la comprobación en vivo de aviso-al-conductor.
  expect(isAbsence(new Error('sdd-ai-mod: $.fs.stat(/work/.sdd-ai/hooks/notifications) failed: ENOENT'))).toBe(true)
  expect(isAbsence(new Error('sdd-ai-mod: $.fs.stat(/work/ENOENT) failed: EACCES'))).toBe(false)
  // Con la ruta pedida el corte es exacto: una ruta con paréntesis o con el marcador no lo corre, aunque el motivo
  // repita la ruta como los errno de Node.
  expect(isAbsence(new Error('sdd-ai-mod: $.fs.stat(/work/(x)/y) failed: ENOENT'), '/work/(x)/y')).toBe(true)
  const tricky = '/work/a) failed: ENOENT'
  expect(isAbsence(new Error(`sdd-ai-mod: $.fs.stat(${tricky}) failed: EACCES`), tricky)).toBe(false)
  expect(isAbsence(new Error(`sdd-ai-mod: $.fs.open(${tricky}) failed: EACCES: permission denied, open '${tricky}'`), tricky)).toBe(false)
  expect(isAbsence(new Error(`sdd-ai-mod: $.fs.open(${tricky}) failed: ENOENT: no such file or directory, open '${tricky}'`), tricky)).toBe(true)
  // Sin la ruta, el respaldo toma el primer marcador.
  expect(isAbsence(new Error('sdd-ai-mod: $.fs.stat(/work/(x)/y) failed: ENOENT'))).toBe(true)
  expect(isAbsence(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true)
  expect(isAbsence('ENOENT')).toBe(true)
  for (const error of [new Error("EACCES: permission denied, stat '/x'"), new Error('EIO: i/o error'), new Error('no implementation for fs.stat'),
    Object.assign(new Error('denied'), { code: 'EACCES' }), new Error('XENOENTX'), null, undefined, 3]) {
    expect(isAbsence(error), String(error)).toBe(false)
  }
})

test('an ENOENT inside the path or under another code is not an absence', () => {
  // Con código, manda el código, aunque el texto diga otra cosa.
  expect(isAbsence(Object.assign(new Error("EACCES: permission denied, stat '/work/ENOENT/file'"), { code: 'EACCES' }))).toBe(false)
  expect(isAbsence(Object.assign(new Error("ENOENT: no such file or directory, stat '/x'"), { code: 'EACCES' }))).toBe(false)
  // Sin código, un `ENOENT` en la ruta de un rechazo por permisos no es una ausencia, con el prefijo del motor o sin él.
  for (const message of [
    "sdd-ai-mod: $.fs.list: EACCES: permission denied, scandir '/work/ENOENT/.sdd-ai/projection/live'",
    "sdd-ai-mod: $.fs.stat: EACCES: permission denied, stat '/work/ENOENT/file'",
    "EACCES: permission denied, stat '/work/ENOENT/file'",
  ]) {
    expect(isAbsence(new Error(message)), message).toBe(false)
    expect(isAbsence(message), message).toBe(false)
  }
})

test('a valid observation of this checkout is parsed with the fields the band uses', () => {
  const parsed = parseObservation(JSON.stringify(doc({ runs: available([review('r1')]), flows: available([flowEntry('demo', 'gate', 'spec')]), bindings: available([binding(SESSION, 'demo')]) })), NAME, `${ROOT}/`)
  expect(parsed.kind).toBe('valid')
  if (parsed.kind !== 'valid') return
  expect(parsed.document.observation).toEqual({ id: NAME, m0: stamp(100), boot: BOOT, pid: PID, observed_at: T0, read_finished_at: T0 + 5 })
  expect(parsed.document.flows.items[0]?.view.value).toEqual({ id: 'demo', next: { step: 'gate', gate: 'spec' } })
  expect(parsed.document.runs.items[0]?.progress.value).toMatchObject({ phase: 'review', round: 2, launch: 2, retained: 1, completed: 1, total: 4 })
})

test('corrupt incompatible and foreign observations are unavailable and never empty', () => {
  const valid = doc()
  const variants: [string, string][] = [
    ['', 'corrupt'],
    ['{"schema_version":1', 'corrupt'],
    ['[]', 'corrupt'],
    ['null', 'corrupt'],
    [JSON.stringify({ ...valid, schema_version: 2 }), 'incompatible_version'],
    [JSON.stringify({ schema_version: 3, anything: true }), 'incompatible_version'],
    [JSON.stringify({ ...valid, schema_version: '1' }), 'corrupt'],
    [JSON.stringify({ ...valid, runs: undefined }), 'corrupt'],
    [JSON.stringify({ ...valid, checkout: { id: 'x', root: 'relative/path' } }), 'corrupt'],
    // Copiada a otro nombre, una observación no pasa: su id es el de su archivo.
    [JSON.stringify(doc({ name: nameOf(99) })), 'corrupt'],
    [JSON.stringify({ ...valid, observation: { ...(valid.observation as Json), m0: stamp(101) } }), 'corrupt'],
    [JSON.stringify({ ...valid, observation: { ...(valid.observation as Json), publisher: { pid: PID + 1, kind: 'cli' } } }), 'corrupt'],
    [JSON.stringify(doc({ runs: { availability: 'available', reason: null, items: [run('r1', { session: { value: SESSION, reason: { code: 'x', detail: 'y' } } })] } })), 'corrupt'],
    [JSON.stringify(doc({ runs: { availability: 'unavailable', reason: { code: 'x', detail: 'y' }, items: [run('r1')] } })), 'corrupt'],
    [JSON.stringify(doc({ runs: { availability: 'available', reason: null, items: [unreadableRun('r1')] } })), 'corrupt'],
    [JSON.stringify(doc({ runs: available([run('r1'), run('r1')]) })), 'corrupt'],
    [JSON.stringify(doc({ runs: available([run('r1', { state: known('finished') })]) })), 'corrupt'],
    [JSON.stringify(doc({ runs: available([review('r1', { progress: known(progress({ total: 1 })) })]) })), 'corrupt'],
    [JSON.stringify(doc({ writer: { availability: 'unavailable', reason: { code: 'x', detail: 'y' }, item: writer('w1') } })), 'corrupt'],
    [JSON.stringify(doc({ flows: available([{ ...flowEntry('demo'), view: known({ ...(flowEntry('other').view as { value: Json }).value }) }]) })), 'corrupt'],
    [JSON.stringify(doc({ root: '/work/other-checkout' })), 'foreign_checkout'],
  ]
  for (const [source, reason] of variants) expect(parseObservation(source, NAME, ROOT)).toEqual({ kind: 'unavailable', reason })
  // Campos que la banda no usa pueden crecer sin volver corrupta la observación.
  expect(parseObservation(JSON.stringify({ ...valid, extra: { future: true } }), NAME, ROOT).kind).toBe('valid')
})

test('the band shows the bound flow step and one own activity of that flow by priority', () => {
  const ofDemo = known('demo')
  const runs = [
    pending('a-pending', { flow: ofDemo }),
    run('b-worker', { flow: ofDemo }),
    run('a-worker', { flow: ofDemo }),
    review('z-review', { flow: ofDemo }),
    review('c-review-pending', { flow: ofDemo, open: known('review_pending'), state: known('done'), live: known(false) }),
    run('w1', { flow: ofDemo }),
    review('a-other-flow-review', { flow: known('other') }),
  ]
  const parts = (items: Json[], writerItem: Json | null = writer('w1', { flow: ofDemo })): Parts => ({
    runs: available(items), writer: { availability: 'available', reason: null, item: writerItem },
    flows: available([flowEntry('demo', 'gate', 'spec')]), bindings: available([binding(SESSION, 'demo')]),
  })
  const chosen = (items: Json[], writerItem?: Json | null) => {
    const selection = band(parts(items, writerItem))
    return selection.kind === 'band' ? selection.activity?.id : selection.kind
  }
  const selection = band(parts(runs))
  expect(selection).toMatchObject({ kind: 'band', flow: { id: 'demo', step: 'gate', gate: 'spec', source: 'flow' }, incomplete: false })
  expect(chosen(runs)).toBe('w1')
  expect(chosen(runs.filter((r) => r.id !== 'w1'), null)).toBe('z-review')
  expect(chosen(runs.filter((r) => !['w1', 'z-review'].includes(String(r.id))), null)).toBe('a-worker')
  expect(chosen([pending('b-pending', { flow: ofDemo }), runs[0]!, runs[4]!], null)).toBe('a-pending')
  if (selection.kind === 'band') expect(selection.activity).toMatchObject({ role: 'writer', association: { kind: 'bound' }, uncertain: false })
})

test('without activity of the bound flow the band shows an own activity with its real association', () => {
  const flows = available([flowEntry('demo', 'implement')])
  const bindings = available([binding(SESSION, 'demo')])
  let selection = band({ flows, bindings, runs: available([pending('p1', { flow: known('other') }), review('r1', { flow: unknown('not_recorded') })]) })
  expect(selection).toMatchObject({ kind: 'band', flow: { id: 'demo', step: 'implement' }, activity: { id: 'r1', role: 'review', association: { kind: 'none', reason: 'not_recorded' } } })
  selection = band({ flows, bindings, runs: available([pending('p1', { flow: known('other') })]) })
  expect(selection).toMatchObject({ kind: 'band', activity: { id: 'p1', association: { kind: 'flow', id: 'other' } } })
  // Sin actividad, el flujo ligado se muestra solo; sin liga, la actividad propia conserva su asociación real.
  expect(band({ flows, bindings })).toMatchObject({ kind: 'band', flow: { id: 'demo' }, activity: null, incomplete: false })
  selection = band({ flows, bindings: available([binding(SESSION, null)]), runs: available([run('x1', { flow: known('demo') })]) })
  expect(selection).toMatchObject({ kind: 'band', flow: null, activity: { id: 'x1', association: { kind: 'flow', id: 'demo' } } })
  // Una vista del flujo que no está disponible deja el paso que registró la liga, dicho como tal.
  selection = band({ bindings, flows: available([{ ...flowEntry('demo'), availability: 'unavailable', reason: { code: 'flow_unreadable', detail: 'x' }, status: unknown('flow_unreadable'), view: unknown('flow_unreadable') }]) })
  expect(selection).toMatchObject({ kind: 'band', flow: { id: 'demo', step: 'specify', gate: null, source: 'binding' } })
})

test('runs of other sessions or without session are never attributed to the band', () => {
  const runs = available([
    review('r-other', { session: known(OTHER_SESSION), flow: known('demo') }),
    run('r-none', { session: unknown('not_recorded'), flow: known('demo') }),
    run('r-mine', { flow: known('other'), open: known('native_pending'), kind: known('native'), live: known(false) }),
  ])
  const parts: Parts = { runs, writer: { availability: 'available', reason: null, item: writer('w-other', { session: known(OTHER_SESSION), flow: known('demo') }) },
    flows: available([flowEntry('demo')]), bindings: available([binding(SESSION, 'demo'), binding(OTHER_SESSION, 'other')]) }
  expect(band(parts)).toMatchObject({ kind: 'band', flow: { id: 'demo' }, activity: { id: 'r-mine', role: 'native', association: { kind: 'flow', id: 'other' } } })
  // La otra sesión ve su propia liga y su writer, aunque esté asociado a otro flujo.
  expect(band(parts, OTHER_SESSION)).toMatchObject({ kind: 'band', flow: { id: 'other', source: 'binding' }, activity: { id: 'w-other', role: 'writer', association: { kind: 'flow', id: 'demo' } } })
  // Una sesión sin liga ni corridas propias tiene el estado vacío explícito.
  expect(band(parts, 'session-c')).toMatchObject({ kind: 'empty' })
})

test('the empty state requires an inventory that can assert it', () => {
  expect(band({})).toEqual({ kind: 'empty', observation: NAME, observedAt: T0, live: false })
  expect(band({ bindings: available([binding(SESSION, null)]) })).toMatchObject({ kind: 'empty' })
  const unavailable = { kind: 'unavailable', reason: 'inventory_unavailable' }
  const collection = (code: string) => ({ availability: 'unavailable', reason: { code, detail: 'No disponible.' }, items: [] })
  expect(band({ runs: available([run('r1', { session: known(OTHER_SESSION) }), unreadableRun('r2')]) })).toEqual(unavailable)
  expect(band({ runs: collection('inventory_unreadable') })).toEqual(unavailable)
  expect(band({ writer: { availability: 'unavailable', reason: { code: 'writer_unreadable', detail: 'x' }, item: null } })).toEqual(unavailable)
  expect(band({ bindings: collection('bindings_unreadable') })).toEqual(unavailable)
  expect(band({ bindings: available([{ ...binding(SESSION, null), availability: 'unavailable', reason: { code: 'binding_unreadable', detail: 'x' }, flow: unknown('binding_unreadable') }]) })).toEqual(unavailable)
  // Una observación que no entró en el límite declara todo no disponible: no es un inventario vacío.
  expect(band({ runs: collection('size_unavailable'), writer: { availability: 'unavailable', reason: { code: 'size_unavailable', detail: 'x' }, item: null },
    flows: collection('size_unavailable'), bindings: collection('size_unavailable') })).toEqual(unavailable)
  // Con algo propio que mostrar, se muestra, y la selección dice que pudo faltar algo.
  expect(band({ runs: available([run('r1'), unreadableRun('r2')]) })).toMatchObject({ kind: 'band', activity: { id: 'r1' }, incomplete: true })
})

test('the writer comes from its protected control and its uncertain cessation is marked', () => {
  const flows = available([flowEntry('demo')])
  const bindings = available([binding(SESSION, 'demo')])
  // Su corrida visible desapareció o dice otra cosa: manda el control protegido.
  let selection = band({ flows, bindings, runs: available([run('w1', { session: known(OTHER_SESSION), state: known('done'), open: known('undelivered') })]),
    writer: { availability: 'available', reason: null, item: writer('w1', { flow: known('demo') }) } })
  expect(selection).toMatchObject({ kind: 'band', activity: { id: 'w1', role: 'writer', state: 'running', open: 'running', uncertain: false, association: { kind: 'bound' } } })
  selection = band({ flows, bindings, runs: available([review('r1', { flow: known('demo') })]),
    writer: { availability: 'available', reason: null, item: writer('w1', { state: known('cessation_uncertain'), open: known('undelivered'), live: known(true), flow: known('demo') }) } })
  expect(selection).toMatchObject({ kind: 'band', live: true, activity: { id: 'w1', role: 'writer', state: 'cessation_uncertain', uncertain: true } })
  // Una corrida que no es el writer nunca se marca como de cese incierto.
  selection = band({ runs: available([run('r1', { state: known('cessation_uncertain') })]) })
  expect(selection).toMatchObject({ kind: 'band', activity: { id: 'r1', role: 'worker', uncertain: false } })
})

test('review progress counts the logical jobs of the round and refutation stays apart', () => {
  let selection = band({ runs: available([review('r1')]) })
  expect(selection).toMatchObject({ kind: 'band', activity: { role: 'review', progress: { phase: 'review', round: 2, launch: 2, done: 2, total: 4, reviewer: 'reliability', batch: 1 } } })
  selection = band({ runs: available([review('r1', { progress: known(progress({ phase: 'refutation', round: 3, launch: 1, planned: ['refute:1'], retained: [], completed: [], total: 1,
    active: known({ key: 'refute:1', reviewer: unknown('not_recorded'), batch: unknown('not_recorded') }) })) })]) })
  expect(selection).toMatchObject({ kind: 'band', activity: { progress: { phase: 'refutation', round: 3, done: 0, total: 1, reviewer: null, batch: null } } })
  // Un formato anterior sin avance no recibe conteos inventados.
  selection = band({ runs: available([review('r1', { progress: unknown('history_without_progress') })]) })
  expect(selection).toMatchObject({ kind: 'band', activity: { role: 'review', progress: null } })
})

test('age appears only with a live run and after 60 seconds', () => {
  const present = (parts: Parts, now: number): BandPresentation => refreshBand({ kind: 'valid', document: document(parts) }, IDENTITY, null, now).band
  const ageOf = (parts: Parts, now: number) => {
    const shown = present(parts, now)
    return shown.kind === 'unavailable' ? shown.reason : shown.ageMs
  }
  const liveRun = { runs: available([run('r1')]) }
  expect(ageOf(liveRun, T0 + STALE_AFTER_MS)).toBeNull()
  expect(ageOf(liveRun, T0 + STALE_AFTER_MS + 1)).toBe(STALE_AFTER_MS + 1)
  // Sin corridas vivas no hay antigüedad, por vieja que sea la observación.
  expect(ageOf({ runs: available([pending('p1'), review('r2', { open: known('review_pending'), live: known(false) })]) }, T0 + 3_600_000)).toBeNull()
  // Una corrida viva de otra sesión cuenta, también en el estado vacío; un reloj atrasado no da antigüedad negativa.
  expect(present({ runs: available([run('r1', { session: known(OTHER_SESSION) })]) }, T0 + 120_000)).toEqual({ kind: 'empty', lastRead: false, ageMs: 120_000 })
  expect(ageOf(liveRun, T0 - 120_000)).toBeNull()
  // Un writer en cese incierto cuenta como vivo aunque su motivo de apertura no sea `running`.
  const uncertain = writer('w1', { state: known('cessation_uncertain'), open: known('undelivered'), live: known(false) })
  expect(ageOf({ writer: { availability: 'available', reason: null, item: uncertain } }, T0 + 61_000)).toBe(61_000)
})

test('unavailable outcomes retire previous data and exhausted attempts keep the last valid read marked', () => {
  const parts: Parts = { runs: available([run('r1')]), flows: available([flowEntry('demo')]), bindings: available([binding(SESSION, 'demo')]) }
  const first = refreshBand({ kind: 'valid', document: document(parts) }, IDENTITY, null, T0 + 1000)
  expect(first.band).toMatchObject({ kind: 'band', lastRead: false, ageMs: null, activity: { id: 'r1' } })
  expect(first.memory).toMatchObject({ identity: IDENTITY, selection: { kind: 'band', observation: NAME } })
  // Agotados los intentos, la última lectura válida se conserva marcada, y su antigüedad sigue la regla de siempre.
  const kept = refreshBand({ kind: 'exhausted' }, IDENTITY, first.memory, T0 + 90_000)
  expect(kept.band).toEqual({ ...(first.band as Json), lastRead: true, ageMs: 90_000 })
  expect(kept.memory).toEqual(first.memory)
  // Una lectura trabada se presenta igual: la anterior nunca pasa por actual.
  expect(refreshBand({ kind: 'stalled' }, IDENTITY, first.memory, T0 + 90_000)).toEqual(kept)
  expect(refreshBand({ kind: 'stalled' }, IDENTITY, null, T0)).toEqual({ band: { kind: 'unavailable', reason: 'missing' }, memory: null })
  const quiet = refreshBand({ kind: 'valid', document: document({ ...parts, runs: available([pending('r1')]) }) }, IDENTITY, null, T0)
  expect(refreshBand({ kind: 'exhausted' }, IDENTITY, quiet.memory, T0 + 3_600_000).band).toMatchObject({ kind: 'band', lastRead: true, ageMs: null })
  // Sin una lectura válida de la misma sesión y del mismo checkout, no queda nada que conservar.
  expect(refreshBand({ kind: 'exhausted' }, IDENTITY, null, T0)).toEqual({ band: { kind: 'unavailable', reason: 'missing' }, memory: null })
  for (const identity of [{ session: OTHER_SESSION, root: ROOT }, { session: SESSION, root: '/work/other' }]) {
    expect(refreshBand({ kind: 'exhausted' }, identity, first.memory, T0)).toEqual({ band: { kind: 'unavailable', reason: 'missing' }, memory: null })
  }
  // Una elegida que no sirve retira los datos anteriores: no cae a la lectura de antes, ni la resucita después.
  for (const reason of ['corrupt', 'incompatible_version', 'not_regular', 'directory', 'link', 'too_large', 'flooded', 'missing', 'unreadable'] as const) {
    const retired = refreshBand({ kind: 'unavailable', reason }, IDENTITY, first.memory, T0 + 2000)
    expect(retired).toEqual({ band: { kind: 'unavailable', reason }, memory: null })
    expect(refreshBand({ kind: 'exhausted' }, IDENTITY, retired.memory, T0 + 3000).band).toEqual({ kind: 'unavailable', reason: 'missing' })
  }
  // Una lectura válida que no permite afirmar nada se conserva como lo que era.
  const size = { availability: 'unavailable', reason: { code: 'size_unavailable', detail: 'x' }, items: [] }
  const blind = refreshBand({ kind: 'valid', document: document({ runs: size, bindings: size }) }, IDENTITY, null, T0)
  expect(blind.band).toEqual({ kind: 'unavailable', reason: 'inventory_unavailable' })
  expect(refreshBand({ kind: 'exhausted' }, IDENTITY, blind.memory, T0).band).toEqual({ kind: 'unavailable', reason: 'inventory_unavailable' })
})

test('the presentation state and the memory are plain JSON', () => {
  const parts: Parts = { runs: available([review('r1', { flow: known('demo') })]), writer: { availability: 'available', reason: null, item: writer('w1', { session: known(OTHER_SESSION) }) },
    flows: available([flowEntry('demo')]), bindings: available([binding(SESSION, 'demo')]) }
  const { band: shown, memory } = refreshBand({ kind: 'valid', document: document(parts) }, IDENTITY, null, T0 + 61_000)
  const kept: BandMemory | null = memory
  expect(JSON.parse(JSON.stringify(shown))).toStrictEqual(shown)
  expect(JSON.parse(JSON.stringify(kept))).toStrictEqual(kept)
})
