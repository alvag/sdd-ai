import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { inspectModEngine } from '../src/mod-engine.ts'
import { currentBranch } from '../src/git.ts'
import { approveFlowGates, chainFlow, chainSetup, fakeCalls, fakePrompts, runBin } from './helpers.ts'
import { controlOf, implReport } from './chain-cli-fixture.ts'

test('sdd phase prepara el API de mods según el conductor y conserva el relanzamiento', () => {
  const setup = (touches = true, interrupted = false) => {
    const s = chainSetup({ writers: [
      { actions: [{ write: 'src/one.ts', content: 'one\n' }], report: interrupted ? 'Me cortaron.\n' : implReport(['T1'], ['T2']) },
      { actions: [{ write: 'src/two.ts', content: 'two\n' }], report: implReport(['T2']) },
    ] })
    const exclude = join(s.repo, '.git/info/exclude')
    writeFileSync(exclude, readFileSync(exclude, 'utf8') + '\n.claude/\n')
    chainFlow(s, { tasks: 2 })
    if (touches) {
      const spec = join(s.repo, '.plans/f/spec.md')
      writeFileSync(spec, readFileSync(spec, 'utf8') + '\nRuta: `mods/sdd-ai/hooks/register.tsx`.\n')
      approveFlowGates(s.repo)
    }
    return s
  }
  const prepare = (root: string) => {
    for (const path of inspectModEngine(root).paths) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture declaration') }
  }
  const s = setup()
  let r = runBin(s, ['sdd', 'phase', 'f'])
  assert.deepEqual([r.code, r.out.code, r.out.next], [2, 'mod_copy_missing', './bin/sdd-ai agents sync'])
  assert.equal(fakeCalls(s).length, 0, 'Claude detectado aunque la configuración elija Codex')
  assert.equal(existsSync(join(s.repo, '.sdd-ai/runs')), false)
  mkdirSync(inspectModEngine(s.repo).copy, { recursive: true })
  r = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(r.out.code, 'mod_engine_types_missing')
  assert.equal(fakeCalls(s).length, 0)
  prepare(s.repo)
  const inputs = ['spec', 'plan', 'tasks'].map((name) => readFileSync(join(s.repo, `.plans/f/${name}.md`)))
  r = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const first = r.out.id
  runBin(s, ['wait', first, '--max', '30'])
  const before = controlOf(s, first)
  for (const path of inspectModEngine(s.repo).paths) {
    assert.ok(fakePrompts(s)[0].includes(path))
    assert.equal(readFileSync(path, 'utf8'), 'fixture declaration')
  }
  rmSync(inspectModEngine(s.repo).paths[0])
  const calls = fakeCalls(s).length
  r = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(r.out.code, 'mod_engine_types_missing')
  assert.equal(fakeCalls(s).length, calls)
  assert.deepEqual(controlOf(s, first), before, 'el preflight conserva el control del writer anterior')
  prepare(s.repo)
  r = runBin(s, ['sdd', 'phase', 'f'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.kind, 'continuation')
  runBin(s, ['wait', r.out.id, '--max', '30'])
  assert.ok(fakePrompts(s)[1].includes(inspectModEngine(s.repo).paths[0]))
  for (const [i, name] of ['spec', 'plan', 'tasks'].entries()) assert.deepEqual(readFileSync(join(s.repo, `.plans/f/${name}.md`)), inputs[i])

  const codex = setup()
  r = runBin(codex, ['sdd', 'phase', 'f', '--conductor', 'codex'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.warnings[0].code, 'mod_copy_missing')
  runBin(codex, ['wait', r.out.id, '--max', '30'])
  assert.match(fakePrompts(codex)[0], /Toda afirmación.*supuesto/)
  const codexTypes = setup()
  mkdirSync(inspectModEngine(codexTypes.repo).copy, { recursive: true })
  r = runBin(codexTypes, ['sdd', 'phase', 'f', '--conductor', 'codex'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.warnings[0].code, 'mod_engine_types_missing')
  runBin(codexTypes, ['wait', r.out.id, '--max', '30'])
  assert.match(fakePrompts(codexTypes)[0], /Toda afirmación.*supuesto/)
  const plain = setup(false)
  r = runBin(plain, ['sdd', 'phase', 'f'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(r.out.warnings, undefined)
  runBin(plain, ['wait', r.out.id, '--max', '30'])
  assert.doesNotMatch(fakePrompts(plain)[0], /API.*motor de mods/)
  const unknown = setup()
  r = runBin(unknown, ['sdd', 'phase', 'f'], { CLAUDECODE: '', CODEX_THREAD_ID: '' })
  assert.equal(r.out.code, 'conductor_unknown')
  assert.equal(fakeCalls(unknown).length, 0)

  for (const mode of ['block', 'resume'] as const) {
    const variant = setup(true, mode === 'resume')
    prepare(variant.repo)
    const initial = runBin(variant, ['sdd', 'phase', 'f'])
    assert.equal(initial.code, 0, JSON.stringify(initial.out))
    runBin(variant, ['wait', initial.out.id, '--max', '30'])
    const originalControl = controlOf(variant, initial.out.id)
    const originalInputs = ['spec', 'plan', 'tasks'].map(name => readFileSync(join(variant.repo, `.plans/f/${name}.md`)))
    rmSync(inspectModEngine(variant.repo).paths[0])
    const args = ['sdd', 'phase', 'f', ...(mode === 'block' ? ['--blocks'] : [])]
    const refused = runBin(variant, args)
    assert.equal(refused.out.code, 'mod_engine_types_missing', mode)
    assert.equal(fakeCalls(variant).length, 1, mode)
    assert.deepEqual(controlOf(variant, initial.out.id), originalControl, mode)
    prepare(variant.repo)
    const next = runBin(variant, args)
    assert.equal(next.code, 0, `${mode}: ${JSON.stringify(next.out)}`)
    runBin(variant, ['wait', next.out.id, '--max', '30'])
    assert.ok(fakePrompts(variant)[1].includes(inspectModEngine(variant.repo).paths[0]), mode)
    for (const [i, name] of ['spec', 'plan', 'tasks'].entries()) assert.deepEqual(readFileSync(join(variant.repo, `.plans/f/${name}.md`)), originalInputs[i], mode)
  }

  for (const step of ['plan', 'tasks'] as const) {
    const document = setup()
    const handoff = join(document.repo, '.plans/f/handoff.md')
    writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('profundidad:', `branch: ${currentBranch(document.repo)}\nprofundidad:`))
    approveFlowGates(document.repo)
    rmSync(join(document.repo, '.plans/f/tasks.md'))
    if (step === 'plan') rmSync(join(document.repo, '.plans/f/plan.md'))
    r = runBin(document, ['sdd', 'phase', 'f'])
    assert.equal(r.out.code, 'mod_copy_missing', `${step}: ${JSON.stringify(r.out)}`)
    assert.equal(fakeCalls(document).length, 0)
    prepare(document.repo)
    r = runBin(document, ['sdd', 'phase', 'f'])
    assert.equal(r.code, 0, `${step}: ${JSON.stringify(r.out)}`)
    assert.equal(r.out.step, step)
    runBin(document, ['wait', r.out.id, '--max', '30'])
    const prompt = readFileSync(join(document.repo, '.sdd-ai/runs', r.out.id, 'prompt.md'), 'utf8')
    assert.ok(prompt.includes(inspectModEngine(document.repo).paths[0]))
  }
})
