import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ArtifactSelection, artifactDelta, freezeArtifact, validateArtifactArgs } from '../src/review/artifact.ts'
import { renderArtifactMaterial } from '../src/review/artifact-prompt.ts'
import { freezeStableWith, snapshot } from '../src/review/candidate.ts'
import { SddError } from '../src/types.ts'
import { makeRepo } from './helpers.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/** Repo con un commit y `.plans/` en `.git/info/exclude`, con una spec y su pedido en `.plans/x/`. */
function repoWithPlans(): { repo: string; sel: ArtifactSelection } {
  const repo = makeRepo()
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n')
  mkdirSync(join(repo, '.plans', 'x'), { recursive: true })
  writeFileSync(join(repo, '.plans', 'x', 'spec.md'), '# Spec\n\n- AC-1: algo observable.\n')
  writeFileSync(join(repo, '.plans', 'x', 'pedido.md'), 'Quiero algo observable.\n')
  return { repo, sel: { artifact: '.plans/x/spec.md', kind: 'spec', inputs: [{ role: 'request', path: '.plans/x/pedido.md' }], context: [] } }
}

function usage(fn: () => unknown, why: RegExp) {
  assert.throws(fn, (e: unknown) => e instanceof SddError && e.code === 'usage' && why.test(e.message))
}

test('congela un artefacto que Git ignora', () => {
  const { repo, sel } = repoWithPlans()
  assert.equal(git(repo, 'check-ignore', '.plans/x/spec.md'), '.plans/x/spec.md')
  const { candidate: c, bytes } = freezeArtifact(repo, sel)
  const spec = '# Spec\n\n- AC-1: algo observable.\n'
  assert.deepEqual(c.subject, { kind: 'spec' })
  assert.deepEqual(c.files, [{ path: '.plans/x/spec.md', status: 'A', mode: '100644', sha256: sha(spec), binary: false, lines: 3, visible: [[1, 3]] }])
  assert.deepEqual(c.context, [{ path: '.plans/x/pedido.md', sha256: sha('Quiero algo observable.\n'), lines: 1, role: 'request' }])
  assert.deepEqual([c.diff, c.base_sha, c.head_sha, c.left_out], ['', null, null, []])
  assert.equal(bytes.get('.plans/x/spec.md')?.toString('utf8'), spec)
  assert.equal(bytes.get('.plans/x/pedido.md')?.toString('utf8'), 'Quiero algo observable.\n')
})

test('freezeStableWith congela dos veces un artefacto y compara el hash del candidato', () => {
  const { repo, sel } = repoWithPlans()
  const { candidate } = freezeStableWith(repo, sel, freezeArtifact, (r) => r.candidate.hash)
  assert.equal(candidate.hash, freezeArtifact(repo, sel).candidate.hash)
  let n = 0
  const unstable = (root: string, s: ArtifactSelection) => {
    const r = freezeArtifact(root, s)
    return { ...r, candidate: { ...r.candidate, hash: `sha256:${String(n++).padStart(64, '0')}` } }
  }
  assert.throws(() => freezeStableWith(repo, sel, unstable, (r) => r.candidate.hash), (e: unknown) => e instanceof SddError && e.code === 'candidate_unstable')
})

test('rechaza un tipo desconocido, una ruta inexistente, fuera del repo, binaria (con NUL o UTF-8 inválido sin NUL) o vacía, sin crear la corrida', () => {
  const { repo, sel } = repoWithPlans()
  usage(() => validateArtifactArgs({ kind: 'design', request: 'p.md' }), /tipo/)
  usage(() => validateArtifactArgs({ request: 'p.md' }), /tipo/)
  usage(() => freezeArtifact(repo, { ...sel, artifact: '.plans/x/no-existe.md' }), /no existe: \.plans\/x\/no-existe\.md/)
  const outside = join(mkdtempSync(join(tmpdir(), 'sdd-ai-fuera-')), 'spec.md')
  writeFileSync(outside, '# fuera\n')
  usage(() => freezeArtifact(repo, { ...sel, artifact: outside }), /dentro del repo/)
  writeFileSync(join(repo, '.plans', 'x', 'nul.md'), Buffer.from([0x61, 0, 0x62]))
  usage(() => freezeArtifact(repo, { ...sel, artifact: '.plans/x/nul.md' }), /binari/)
  writeFileSync(join(repo, '.plans', 'x', 'latin.md'), Buffer.from([0xff, 0xfe, 0x61]))
  usage(() => freezeArtifact(repo, { ...sel, artifact: '.plans/x/latin.md' }), /no es texto UTF-8: \.plans\/x\/latin\.md/)
  writeFileSync(join(repo, '.plans', 'x', 'vacio.md'), ' \n\n')
  usage(() => freezeArtifact(repo, { ...sel, artifact: '.plans/x/vacio.md' }), /vacío: \.plans\/x\/vacio\.md/)
  assert.equal(existsSync(join(repo, '.sdd-ai')), false)
})

test('rechaza el artefacto repetido como insumo o contexto, también por otra ruta o un symlink', () => {
  const { repo, sel } = repoWithPlans()
  usage(() => freezeArtifact(repo, { ...sel, context: ['.plans/x/spec.md'] }), /más de una vez/)
  usage(() => freezeArtifact(repo, { ...sel, context: ['.plans/x/../x/spec.md'] }), /más de una vez/)
  usage(() => freezeArtifact(repo, { ...sel, inputs: [{ role: 'request', path: join(repo, '.plans', 'x', 'spec.md') }] }), /más de una vez/)
  symlinkSync('spec.md', join(repo, '.plans', 'x', 'enlace.md'))
  usage(() => freezeArtifact(repo, { ...sel, context: ['.plans/x/enlace.md'] }), /más de una vez/)
  usage(() => freezeArtifact(repo, { ...sel, context: ['.plans/x/pedido.md'] }), /más de una vez/)
})

test('cada tipo exige sus insumos y el next nombra el que falta', () => {
  const missing = (v: Parameters<typeof validateArtifactArgs>[0], flag: string) =>
    assert.throws(() => validateArtifactArgs(v), (e: unknown) => e instanceof SddError && e.code === 'usage' && (e.next ?? '').includes(flag))
  missing({ kind: 'spec' }, '--request')
  missing({ kind: 'plan' }, '--spec')
  missing({ kind: 'tasks', spec: 's.md' }, '--plan')
  missing({ kind: 'tasks', plan: 'p.md' }, '--spec')
  assert.deepEqual(validateArtifactArgs({ kind: 'tasks', plan: 'p.md', spec: 's.md' }), {
    kind: 'tasks', inputs: [{ role: 'spec', path: 's.md' }, { role: 'plan', path: 'p.md' }],
  })
})

test('un rol que el tipo no usa es un error de uso', () => {
  usage(() => validateArtifactArgs({ kind: 'spec', request: 'r.md', plan: 'p.md' }), /--plan/)
  usage(() => validateArtifactArgs({ kind: 'plan', spec: 's.md', request: 'r.md' }), /--request/)
})

test('un insumo vacío es un error de uso', () => {
  const { repo, sel } = repoWithPlans()
  writeFileSync(join(repo, '.plans', 'x', 'pedido.md'), '\n')
  usage(() => freezeArtifact(repo, sel), /vacío: \.plans\/x\/pedido\.md/)
  // Un archivo de --context vacío se admite: ningún criterio lo prohíbe.
  writeFileSync(join(repo, '.plans', 'x', 'pedido.md'), 'Quiero algo.\n')
  writeFileSync(join(repo, 'vacio.txt'), '')
  assert.equal(freezeArtifact(repo, { ...sel, context: ['vacio.txt'] }).candidate.context.at(-1)?.path, 'vacio.txt')
})

test('rechaza --artifact con --base o --head', () => {
  usage(() => validateArtifactArgs({ kind: 'spec', request: 'r.md', base: 'main' }), /--base/)
  usage(() => validateArtifactArgs({ kind: 'spec', request: 'r.md', head: 'HEAD' }), /--head/)
})

test('un commit con todo idéntico da el mismo hash', () => {
  const { repo, sel } = repoWithPlans()
  const before = freezeArtifact(repo, sel).candidate.hash
  writeFileSync(join(repo, 'otro.txt'), 'otro\n')
  git(repo, 'add', 'otro.txt')
  git(repo, 'commit', '-qm', 'otro commit')
  assert.equal(freezeArtifact(repo, sel).candidate.hash, before)
})

test('un byte distinto en el artefacto, un insumo o el contexto cambia el hash', () => {
  const { repo, sel } = repoWithPlans()
  writeFileSync(join(repo, 'src.ts'), 'export const a = 1\n')
  const full = { ...sel, context: ['src.ts'] }
  const base = freezeArtifact(repo, full).candidate.hash
  for (const [path, text] of [['.plans/x/spec.md', '# Spec\n\n- AC-1: algo observable!\n'], ['.plans/x/pedido.md', 'Quiero algo observable!\n'], ['src.ts', 'export const a = 2\n']] as const) {
    const original = readFileSync(join(repo, path), 'utf8')
    writeFileSync(join(repo, path), text)
    assert.notEqual(freezeArtifact(repo, full).candidate.hash, base, path)
    writeFileSync(join(repo, path), original)
  }
  assert.equal(freezeArtifact(repo, full).candidate.hash, base)
})

test('un artefacto que cambia después de congelarse no deja una corrida a medias, y el prompt y los blobs son los bytes del hash', () => {
  const { repo, sel } = repoWithPlans()
  const { candidate, bytes } = freezeArtifact(repo, sel)
  const original = readFileSync(join(repo, '.plans', 'x', 'spec.md'))
  writeFileSync(join(repo, '.plans', 'x', 'spec.md'), '# Otra cosa\n')
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-run-'))
  snapshot(repo, candidate, dir, bytes)
  assert.deepEqual(readFileSync(join(dir, 'blobs', candidate.files[0].sha256 ?? '')), original)
  assert.deepEqual(readFileSync(join(dir, 'blobs', candidate.context[0].sha256)).toString('utf8'), 'Quiero algo observable.\n')
  const material = renderArtifactMaterial(candidate, bytes)
  assert.ok(material.includes('3│- AC-1: algo observable.'))
  assert.equal(material.includes('Otra cosa'), false)
})

test('el delta separa líneas agregadas y borradas', () => {
  const before = 'uno\ndos\ntres\ncuatro\ncinco\n'
  const after = 'uno\nDOS\ntres\ncinco\nseis\n'
  assert.deepEqual(artifactDelta(before, after), { added: [[2, 2], [5, 5]], removed: [[2, 2], [4, 4]] })
})

test('un cambio que solo borra da removed y ningún added', () => {
  assert.deepEqual(artifactDelta('uno\ndos\ntres\n', 'uno\ntres\n'), { added: [], removed: [[2, 2]] })
  assert.deepEqual(artifactDelta('uno\ndos\n', 'uno\ndos\n'), { added: [], removed: [] })
})
