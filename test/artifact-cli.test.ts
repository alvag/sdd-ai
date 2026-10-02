import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GOLDEN_DIR, goldenRepo } from './fixtures/golden-diff/capture.ts'
import { makeFakeBin, makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()

interface Setup { repo: string; env: Record<string, string> }

const SPEC = '# Spec\n\n- AC-1: algo observable.\n- AC-2: otra cosa observable.\n'
const PEDIDO = 'Quiero algo observable.\n'

/**
 * Repo con `.plans/` ignorado, una spec y su pedido, y el CLI falso guionado. El autor es Codex y el
 * revisor Claude; con `single`, la config solo tiene a Claude y el autor también es Claude.
 */
function setup(answers: string[], o: { single?: boolean } = {}): Setup {
  const repo = makeRepo()
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\n')
  mkdirSync(join(repo, '.plans'))
  writeFileSync(join(repo, '.plans', 'spec.md'), SPEC)
  writeFileSync(join(repo, '.plans', 'pedido.md'), PEDIDO)
  mkdirSync(join(repo, '.sdd-ai'))
  const families = o.single ? '[claude]' : '[codex, claude]'
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), `cross_model:\n  schema_version: 1\n  families: ${families}\n  selection: ${o.single ? 'user_choice' : 'full'}\n`)
  writeFileSync(join(repo, '.sdd-ai', 'workers.yml'), [
    'schema_version: 1', 'roles:',
    '  design-review:', '    claude:', '      model: opus', '      effort: muy_alto',
    '  code-review:', '    claude:', '      model: sonnet', '      effort: bajo', '',
  ].join('\n'))
  const bin = mkdtempSync(join(tmpdir(), 'sdd-ai-bin-'))
  symlinkSync(process.execPath, join(bin, 'node'))
  makeFakeBin(bin, 'claude')
  const work = mkdtempSync(join(tmpdir(), 'sdd-ai-fake-'))
  writeFileSync(join(work, 'answers.json'), JSON.stringify(answers))
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1',
    FAKE_MODE: 'scripted', FAKE_ANSWERS: join(work, 'answers.json'), FAKE_CALLS_FILE: join(work, 'calls'),
  }
  return { repo, env }
}

function cli(s: Setup, args: string[]) {
  const r = spawnSync(BIN, args, { cwd: s.repo, env: s.env, encoding: 'utf8' })
  return { code: r.status, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
}

const runs = (s: Setup) => (existsSync(join(s.repo, '.sdd-ai', 'runs')) ? readdirSync(join(s.repo, '.sdd-ai', 'runs')) : [])
const runFile = (s: Setup, id: string, name: string) => join(s.repo, '.sdd-ai', 'runs', id, name)
const runJson = (s: Setup, id: string, name: string) => JSON.parse(readFileSync(runFile(s, id, name), 'utf8'))
const calls = (s: Setup) => (existsSync(s.env.FAKE_CALLS_FILE) ? readFileSync(s.env.FAKE_CALLS_FILE, 'utf8').trim().split('\n').length : 0)
const specArgs = (author = 'codex') => ['review', 'start', '--artifact', '.plans/spec.md', '--kind', 'spec', '--request', '.plans/pedido.md', '--author', author]

const grave = { of: '.plans/spec.md', axis: 'quality', severity: 'CRITICAL', location: '.plans/spec.md:3', claim: 'AC-1 no se puede observar', evidence: 'inferential' }
const informative = { of: '.plans/pedido.md', axis: 'spec', severity: 'WARNING', location: '.plans/pedido.md:1', claim: 'el pedido es ambiguo' }
const first = (findings: unknown[], unverifiable: unknown[] = []) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"findings":${JSON.stringify(findings)},"unverifiable":${JSON.stringify(unverifiable)}}`
const next = (responses: unknown[], findings: unknown[] = [], unverifiable: unknown[] = []) =>
  `{"candidate_hash":"$HASH","inspection":{"status":"completed","paths":$PATHS},"responses":${JSON.stringify(responses)},"findings":${JSON.stringify(findings)},"unverifiable":${JSON.stringify(unverifiable)}}`

function start(s: Setup, extra: string[] = [], author = 'codex'): string {
  const r = cli(s, [...specArgs(author), ...extra])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.notEqual(w.code, 3, 'la ronda 1 no terminó')
  return r.out.id
}

function usage(r: { code: number | null; out: { code: string; message: string; next?: string } }, why: RegExp) {
  assert.equal(r.code, 2, JSON.stringify(r.out))
  assert.equal(r.out.code, 'usage')
  assert.match(r.out.message, why)
}

/** Una ronda 1 con un grave aceptado y la spec corregida en la línea 3, lista para `review round`. */
function acceptedAndCorrected(s: Setup, extra: string[] = []): string {
  const id = start(s, extra)
  assert.equal(cli(s, ['review', 'decide', id, 'accept', 'F-1']).code, 0)
  writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC.replace('algo observable', 'la respuesta tiene el campo x'))
  return id
}

// —— review start ——

test('artefacto como sujeto: congela un artefacto ignorado y rechaza lo inválido sin crear la corrida', () => {
  const s = setup([first([])])
  const r = cli(s, specArgs())
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.artifact, r.out.kind, r.out.inputs, r.out.context], ['.plans/spec.md', 'spec', [{ role: 'request', path: '.plans/pedido.md' }], []])
  cli(s, ['wait', r.out.id, '--max', '20'])

  const t = setup([])
  usage(cli(t, ['review', 'start', '--artifact', '.plans/spec.md', '--request', '.plans/pedido.md']), /tipo de artefacto desconocido/)
  usage(cli(t, ['review', 'start', '--artifact', '.plans/no.md', '--kind', 'spec', '--request', '.plans/pedido.md']), /no existe/)
  usage(cli(t, [...specArgs(), '--base', 'HEAD']), /--base/)
  usage(cli(t, [...specArgs(), '--context', '.plans/spec.md']), /más de una vez/)
  writeFileSync(join(t.repo, '.plans', 'latin.md'), Buffer.from([0xff, 0xfe, 0x61]))
  usage(cli(t, ['review', 'start', '--artifact', '.plans/latin.md', '--kind', 'spec', '--request', '.plans/pedido.md']), /UTF-8/)
  assert.deepEqual(runs(t), [])
})

test('los contextos de artefacto inexistentes fallan antes de crear la corrida y los válidos se congelan', () => {
  const missing = setup([])
  const before = runs(missing)
  const bad = cli(missing, [...specArgs(), '--context', 'no-existe.md'])
  usage(bad, /no-existe\.md/)
  assert.deepEqual(runs(missing), before)

  const valid = setup([first([])])
  writeFileSync(join(valid.repo, 'contexto.md'), '# Contexto\n')
  const r = cli(valid, [...specArgs(), '--context', 'contexto.md'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual(r.out.context, ['contexto.md'])
})

test('el revisor de un artefacto se resuelve con design-review y la familia opuesta al autor', () => {
  const s = setup([first([])])
  const id = start(s)
  const resolved = runJson(s, id, 'resolved.json')
  assert.deepEqual([resolved.family, resolved.model, resolved.effort], ['claude', 'opus', 'xhigh'])
  assert.deepEqual(runJson(s, id, 'request.json').degradations, [])
})

test('con una sola familia configurada, el artefacto se revisa con esa familia y declara same_family en start y en el recibo', () => {
  const s = setup([first([])], { single: true })
  const r = cli(s, specArgs('claude'))
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.deepEqual([r.out.family, r.out.degradations], ['claude', ['same_family']])
  cli(s, ['wait', r.out.id, '--max', '20'])
  assert.ok(runJson(s, r.out.id, 'receipt.json').degradations.includes('same_family'))
})

test('--risk high con --artifact es un error de uso', () => {
  const s = setup([])
  usage(cli(s, [...specArgs(), '--risk', 'high']), /--risk/)
  assert.deepEqual(runs(s), [])
})

test('una revisión de artefacto no resuelve refute, no escribe resolved-refute.json y nunca lanza el refutador', () => {
  // Con causality introduced, un diff mandaría este hallazgo al refutador.
  const s = setup([first([{ ...grave, causality: 'introduced' }]), '__fail__'])
  const id = start(s)
  assert.equal(existsSync(runFile(s, id, 'resolved-refute.json')), false)
  assert.equal(runJson(s, id, 'status.json').state, 'done')
  assert.equal(calls(s), 1)
  assert.equal(runJson(s, id, 'rounds.json').rounds[0].refutation, undefined)
  assert.deepEqual(runJson(s, id, 'ledger.json').entries.map((e: { id: string; state: string }) => [e.id, e.state]), [['F-1', 'abierto']])
})

test('un artefacto con sus insumos que no entra sin --context no crea la corrida y dice que no se puede revisar', () => {
  const s = setup([])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), `# Spec\n${'- AC: una línea larga de la spec.\n'.repeat(7000)}`)
  const r = cli(s, specArgs())
  assert.deepEqual([r.code, r.out.code], [2, 'prompt_too_large'])
  assert.match(r.out.next, /review no puede revisar esta combinación de artefacto e insumos/)
  assert.match(r.out.detail, /\.plans\/spec\.md: \d+ bytes, \.plans\/pedido\.md: \d+ bytes/)
  assert.deepEqual(runs(s), [])
})

test('si sobra --context el next pide quitarlo, con el tamaño de cada archivo', () => {
  const s = setup([])
  writeFileSync(join(s.repo, 'grande.ts'), '// relleno\n'.repeat(20000))
  const r = cli(s, [...specArgs(), '--context', 'grande.ts'])
  assert.deepEqual([r.code, r.out.code], [2, 'prompt_too_large'])
  assert.match(r.out.next, /quita archivos de --context/)
  assert.match(r.out.detail, /\.plans\/spec\.md: \d+ bytes, \.plans\/pedido\.md: \d+ bytes, grande\.ts: \d+ bytes/)
  assert.deepEqual(runs(s), [])
})

// —— review round ——

test('review round de un artefacto rechaza --head', () => {
  const s = setup([first([grave])])
  const id = acceptedAndCorrected(s)
  usage(cli(s, ['review', 'round', id, '--head', 'HEAD']), /no acepta --head/)
})

test('review round de un artefacto no clasifica el delta', () => {
  const s = setup([first([grave]), next([{ id: 'F-1', answer: 'resolved' }])])
  const id = start(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC.replace('algo observable', 'se lanza con spawn y child_process.exec(cmd)'))
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  cli(s, ['wait', id, '--max', '20'])
  assert.deepEqual(runJson(s, id, 'ledger.json').entries.map((e: { state: string }) => e.state), ['resuelto'])
})

test('un artefacto vacío o borrado no lanza la ronda', () => {
  const s = setup([first([grave])])
  const id = acceptedAndCorrected(s)
  writeFileSync(join(s.repo, '.plans', 'spec.md'), '\n')
  usage(cli(s, ['review', 'round', id]), /el artefacto está vacío/)
  rmSync(join(s.repo, '.plans', 'spec.md'))
  usage(cli(s, ['review', 'round', id]), /el artefacto no existe/)
  assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
})

test('un insumo cambiado, borrado o vuelto binario no lanza la ronda, no escribe nada y pide un review start, también con hallazgos sin decidir o sin nada que verificar', () => {
  const restart = /revisa de nuevo: \.\/bin\/sdd-ai review start --artifact \S+\/\.plans\/spec\.md --kind spec --request \S+\/\.plans\/pedido\.md --author codex/
  const cases: Array<[string, (repo: string) => void]> = [
    ['cambiado', (repo) => writeFileSync(join(repo, '.plans', 'pedido.md'), 'Quiero otra cosa.\n')],
    ['borrado', (repo) => rmSync(join(repo, '.plans', 'pedido.md'))],
    ['binario', (repo) => writeFileSync(join(repo, '.plans', 'pedido.md'), Buffer.from([0x61, 0, 0x62]))],
  ]
  for (const [what, change] of cases) {
    // Con un hallazgo sin decidir.
    const s = setup([first([grave])])
    const id = start(s)
    const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
    change(s.repo)
    const r = cli(s, ['review', 'round', id])
    usage(r, /cambió un insumo o el contexto/)
    assert.match(r.out.next ?? '', restart, what)
    assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
    assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
    // Sin nada que verificar ni responder.
    const e = setup([first([])])
    const eid = start(e)
    change(e.repo)
    usage(cli(e, ['review', 'round', eid]), /cambió un insumo o el contexto/)
  }
})

test('review round de un artefacto corre sin resolved-refute.json', () => {
  const s = setup([first([grave]), next([{ id: 'F-1', answer: 'resolved' }])])
  const id = acceptedAndCorrected(s)
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  cli(s, ['wait', id, '--max', '20'])
  assert.equal(runJson(s, id, 'status.json').state, 'done')
  assert.equal(existsSync(runFile(s, id, 'resolved-refute.json')), false)
})

test('una ronda con un --context vacío que no cambió se lanza', () => {
  const s = setup([first([grave]), next([{ id: 'F-1', answer: 'resolved' }])])
  writeFileSync(join(s.repo, 'vacio.txt'), '')
  const id = acceptedAndCorrected(s, ['--context', 'vacio.txt'])
  const r = cli(s, ['review', 'round', id])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  cli(s, ['wait', id, '--max', '20'])
})

test('en la ronda N, si no entran los pendientes, el next lo dice y la corrida queda como estaba', () => {
  const s = setup([first([{ ...grave, claim: 'x'.repeat(210_000) }])])
  const id = acceptedAndCorrected(s)
  const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code, r.out.message], [2, 'prompt_too_large', 'los hallazgos pendientes no entran en el presupuesto'])
  assert.match(r.out.next, /pendientes/)
  assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
  assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
})

test('en la ronda N, un artefacto corregido que ya no entra con sus insumos da prompt_too_large con el tamaño de cada archivo, el next de AC-10 y la corrida intacta', () => {
  const s = setup([first([grave])])
  const id = start(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), `# Spec\n${'- AC: una línea larga de la spec.\n'.repeat(7000)}`)
  const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code], [2, 'prompt_too_large'])
  assert.match(r.out.next, /review no puede revisar esta combinación/)
  assert.match(r.out.detail, /\.plans\/spec\.md: \d+ bytes, \.plans\/pedido\.md: \d+ bytes/)
  assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
  assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
})

test('en la ronda N, una corrección que no entra por sus cambios pide un review start nuevo y deja la corrida como estaba', () => {
  const s = setup([first([grave])])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), `# Spec\n${'- AC: una línea de la spec, de largo medio.\n'.repeat(2400)}`)
  const id = start(s)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  // Reescribir cada línea hace que CAMBIOS lleve la versión anterior y la nueva enteras.
  writeFileSync(join(s.repo, '.plans', 'spec.md'), `# Spec\n${'- AC: otra línea de la spec, de largo medio.\n'.repeat(2400)}`)
  const blobs = readdirSync(runFile(s, id, 'blobs')).sort()
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code], [2, 'prompt_too_large'])
  assert.match(r.out.next, /corre un review start nuevo sobre el artefacto corregido/)
  assert.doesNotMatch(r.out.next, /--context/)
  assert.deepEqual(readdirSync(runFile(s, id, 'blobs')).sort(), blobs)
  assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
})

test('en la ronda N, si el artefacto corregido solo entra sin --context, el next pide un review start nuevo sin esos archivos', () => {
  const s = setup([first([grave])])
  writeFileSync(join(s.repo, 'grande.ts'), '// relleno\n'.repeat(8000))
  const id = start(s, ['--context', 'grande.ts'])
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), `# Spec\n${'- AC: una línea de la spec, de largo medio.\n'.repeat(1500)}`)
  const r = cli(s, ['review', 'round', id])
  assert.deepEqual([r.code, r.out.code], [2, 'prompt_too_large'])
  assert.match(r.out.next, /corre un review start nuevo sin archivos de --context/)
  assert.match(r.out.detail, /\.plans\/spec\.md: \d+ bytes, \.plans\/pedido\.md: \d+ bytes, grande\.ts: \d+ bytes/)
  assert.equal(existsSync(runFile(s, id, 'argv-r2-l1.json')), false)
})

test('la ronda N reusa la resolución congelada', () => {
  for (const single of [false, true]) {
    const s = setup([first([grave]), next([{ id: 'F-1', answer: 'resolved' }])], { single })
    const id = start(s, [], single ? 'claude' : 'codex')
    cli(s, ['review', 'decide', id, 'accept', 'F-1'])
    writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC.replace('algo observable', 'la respuesta tiene el campo x'))
    writeFileSync(join(s.repo, '.sdd-ai', 'workers.yml'), 'schema_version: 1\nroles:\n  design-review:\n    claude:\n      model: haiku\n      effort: bajo\n')
    assert.equal(cli(s, ['review', 'round', id]).code, 0)
    cli(s, ['wait', id, '--max', '20'])
    assert.deepEqual(runJson(s, id, 'argv-r2-l1.json').reviewer_resolution, runJson(s, id, 'resolved.json'))
    if (single) {
      const receipt = runJson(s, id, 'receipt.json')
      assert.equal(receipt.rounds.length, 2)
      assert.ok(receipt.degradations.includes('same_family'))
    }
  }
})

// —— vistas ——

test('status marca stale cuando cambia un archivo, no por un commit', () => {
  const s = setup([first([])])
  const id = start(s)
  writeFileSync(join(s.repo, 'otro.txt'), 'otro\n')
  git(s.repo, 'add', 'otro.txt')
  git(s.repo, 'commit', '-qm', 'otro commit')
  assert.deepEqual([cli(s, ['review', 'status', id]).out.stale, cli(s, ['review', 'status', id]).out.stale_reason], [false, undefined])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), `${SPEC}- AC-3: nuevo.\n`)
  assert.deepEqual([cli(s, ['review', 'status', id]).out.stale, cli(s, ['review', 'status', id]).out.stale_reason], [true, 'artifact'])
  writeFileSync(join(s.repo, '.plans', 'pedido.md'), 'Quiero otra cosa.\n')
  assert.equal(cli(s, ['review', 'status', id]).out.stale_reason, 'inputs')
})

test('con un insumo cambiado, status y wait piden review start antes que decidir o relanzar', () => {
  const s = setup([first([grave])])
  const id = start(s)
  writeFileSync(join(s.repo, '.plans', 'pedido.md'), 'Quiero otra cosa.\n')
  for (const r of [cli(s, ['review', 'status', id]), cli(s, ['wait', id, '--max', '5'])]) {
    assert.match(r.out.next, /^cambió un insumo o el contexto desde la revisión/)
    assert.doesNotMatch(r.out.next, /decide/)
  }
  // Una ronda 1 que no terminó tampoco propone relanzar.
  const u = setup(['__fail__', '__fail__'])
  const r = cli(u, specArgs())
  cli(u, ['wait', r.out.id, '--max', '20'])
  writeFileSync(join(u.repo, '.plans', 'pedido.md'), 'Quiero otra cosa.\n')
  const st = cli(u, ['review', 'status', r.out.id])
  assert.match(st.out.next, /^cambió un insumo o el contexto desde la revisión/)
  assert.doesNotMatch(st.out.next, /review round/)
})

test('un artefacto borrado o inválido se informa como stale por el artefacto, no por los insumos', () => {
  const s = setup([first([])])
  const id = start(s)
  rmSync(join(s.repo, '.plans', 'spec.md'))
  assert.deepEqual([cli(s, ['review', 'status', id]).out.stale, cli(s, ['review', 'status', id]).out.stale_reason], [true, 'artifact'])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), Buffer.from([0xff, 0xfe]))
  assert.equal(cli(s, ['review', 'status', id]).out.stale_reason, 'artifact')
})

test('status, wait y el recibo listan los informativos con su archivo', () => {
  const s = setup([first([grave, informative])])
  const r = cli(s, specArgs())
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  const expected = [{ id: 'F-2', of: '.plans/pedido.md', severity: 'WARNING', claim: 'el pedido es ambiguo', location: '.plans/pedido.md:1' }]
  assert.deepEqual(w.out.informative, expected)
  assert.deepEqual(cli(s, ['review', 'status', r.out.id]).out.informative, expected)
  assert.deepEqual(runJson(s, r.out.id, 'receipt.json').informative, expected)
  assert.deepEqual(w.out.pending, ['F-1'])
})

test('status, wait y el recibo muestran las de la última ronda admitida', () => {
  const claimed = [{ location: '.plans/spec.md:3', claim: 'no viajó el código de resolve' }]
  const s = setup([first([grave], claimed), next([{ id: 'F-1', answer: 'resolved' }], [], [])])
  const id = start(s)
  assert.deepEqual(cli(s, ['review', 'status', id]).out.unverifiable, claimed)
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), SPEC.replace('algo observable', 'la respuesta tiene el campo x'))
  cli(s, ['review', 'round', id])
  const w = cli(s, ['wait', id, '--max', '20'])
  assert.deepEqual(w.out.unverifiable, [])
  assert.deepEqual(runJson(s, id, 'receipt.json').unverifiable, [])
})

test('el recibo, status y el next final dicen que el gate lo decide la persona y no mencionan commit ni push', () => {
  const s = setup([first([])])
  const id = start(s)
  const st = cli(s, ['review', 'status', id])
  assert.equal(st.out.note, 'el veredicto informa; el gate del artefacto lo decide la persona')
  assert.equal(st.out.next, 'la revisión está vigente; el veredicto informa; el gate del artefacto lo decide la persona')
  assert.equal(runJson(s, id, 'receipt.json').note, 'el veredicto informa; el gate del artefacto lo decide la persona')
  for (const text of [st.out.note, st.out.next, runJson(s, id, 'receipt.json').note]) assert.doesNotMatch(text, /commit|push/)
})

test('un artefacto corre un solo revisor y el nivel no aplica en start, status, wait y el recibo', () => {
  const s = setup([first([])])
  const r = cli(s, specArgs())
  assert.deepEqual([r.out.risk, r.out.reviewers], [{ level: 'no_aplica' }, ['base']])
  const w = cli(s, ['wait', r.out.id, '--max', '20'])
  assert.deepEqual(w.out.risk, { level: 'no_aplica' })
  assert.deepEqual(cli(s, ['review', 'status', r.out.id]).out.risk, { level: 'no_aplica' })
  assert.deepEqual(runJson(s, r.out.id, 'receipt.json').risk, { level: 'no_aplica' })
  assert.deepEqual(runJson(s, r.out.id, 'argv-l1.json').jobs.map((j: { key: string }) => j.key), ['base-b1'])
})

// —— de punta a punta ——

test('de punta a punta: start, decide, round, relanzamiento y status con un artefacto', () => {
  const regression = { of: '.plans/spec.md', axis: 'quality', severity: 'CRITICAL', location: '.plans/spec.md:1', claim: 'se borró el AC-2 que el pedido pide', evidence: 'inferential', cause: '-4' }
  const s = setup([
    first([grave, informative], [{ location: '.plans/spec.md:4', claim: 'no viajó el código' }]),
    '__fail__',
    next([{ id: 'F-1', answer: 'resolved' }], [regression]),
  ])
  const id = start(s)
  assert.deepEqual(cli(s, ['review', 'status', id]).out.pending, ['F-1'])
  cli(s, ['review', 'decide', id, 'accept', 'F-1'])
  writeFileSync(join(s.repo, '.plans', 'spec.md'), '# Spec\n\n- AC-1: la respuesta tiene el campo x.\n')
  assert.equal(cli(s, ['review', 'round', id]).code, 0)
  const failed = cli(s, ['wait', id, '--max', '20'])
  assert.equal(failed.out.state, 'unavailable', JSON.stringify(failed.out))
  const again = cli(s, ['review', 'round', id])
  assert.equal(again.code, 0, JSON.stringify(again.out))
  assert.deepEqual([again.out.round, again.out.launch, again.out.removed], [2, 2, [[3, 4]]])
  const done = cli(s, ['wait', id, '--max', '20'])
  assert.equal(done.out.state, 'done', JSON.stringify(done.out))
  const st = cli(s, ['review', 'status', id])
  assert.deepEqual(st.out.ledger.map((e: { id: string; state: string }) => [e.id, e.state]), [['F-1', 'resuelto'], ['F-2', 'informativo'], ['F-3', 'abierto']])
  assert.deepEqual([st.out.note, st.out.informative.length, st.out.unverifiable], ['el veredicto informa; el gate del artefacto lo decide la persona', 1, []])
  assert.equal(st.out.axes.quality, 'fail')
})

test('una corrida anterior sin subject se lee como diff en status, report y wait', () => {
  const old = JSON.parse(readFileSync(join(GOLDEN_DIR, 'run-old.json'), 'utf8')) as { id: string; repo: string }
  const { repo } = goldenRepo()
  const s: Setup = { repo, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? '', CLAUDECODE: '1' } }
  cpSync(join(GOLDEN_DIR, 'run-old'), join(repo, '.sdd-ai', 'runs', old.id), { recursive: true })
  for (const r of [cli(s, ['review', 'status', old.id]), cli(s, ['wait', old.id, '--max', '1'])]) {
    assert.equal(r.out.state, 'unavailable', JSON.stringify(r.out))
    assert.equal(r.out.risk.level, 'high')
    assert.equal(r.out.note, undefined)
    assert.match(r.out.next, /review round/)
  }
})
