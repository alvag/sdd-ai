import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { chainFlow, chainSetup, fakePrompts, runBin } from './helpers.ts'
import {
  git, file, put, planPath, registryPath, registry, writeRegistry, reviewPath, json, report, success, wait, snapshot,
  unchanged, review, committable,
} from './sdd-commit-fixture.ts'

test('review start --flow guarda el flujo en la corrida y rechaza un flujo que no existe, una revisión sin --untracked ni --harvest y otra base', () => {
  const { s, reviewId } = committable()
  assert.equal(json(s, reviewPath(reviewId!, 'request')).flow, 'f')
  const args = ['review', 'start', '--base', s.base, '--author', 'claude']
  const before = snapshot(s)
  for (const [flags, code] of [
    [['--untracked', '--flow', 'missing'], 'flow_not_found'],
    [['--flow', 'f'], 'usage'], [['--flow', 'f', '--untracked', '--head', 'HEAD'], 'usage'],
    [['--flow', 'f', '--artifact', planPath, '--kind', 'spec', '--request', 'src/a.ts'], 'usage'],
  ] as Array<[string[], string]>) {
    assert.equal(runBin(s, [...args, ...flags], { FAKE_MODE: 'review-ok' }).out.code, code)
    unchanged(s, before)
  }
  git(s, 'commit', '--allow-empty', '-q', '-m', 'otra base')
  const after = snapshot(s)
  const mismatch = runBin(s, ['review', 'start', '--base', 'HEAD', '--untracked', '--flow', 'f'], { FAKE_MODE: 'review-ok' })
  assert.equal(mismatch.out.code, 'flow_base_mismatch'); unchanged(s, after)
  const chained = committable({ chain: true, review: false })
  const harvested = success(runBin(chained.s, ['review', 'start', '--harvest', chained.run!, '--flow', 'f'], { FAKE_MODE: 'review-ok' }))
  wait(chained.s, harvested.id)
  assert.equal(json(chained.s, reviewPath(harvested.id, 'request')).flow, 'f')
})

test('con una revisión del flujo convergida, vigente y del candidato entero, sdd status propone el ensayo de sdd commit con cadena y sin ella, y si no la hay propone review start con --flow', () => {
  for (const chain of [false, true]) {
    const { s } = committable({ chain, review: false })
    const next = () => success(runBin(s, ['sdd', 'status', 'f'])).next
    assert.equal(next().step, 'review_and_commit'); assert.match(next().command, /review start .*--flow f/)
    const id = review(s)
    assert.equal(next().command, './bin/sdd-ai sdd commit f --subject "<asunto>"')
    assert.ok(next().detail.includes(id))
    const reqPath = reviewPath(id, 'request')
    const req = json(s, reqPath)
    for (const altered of [
      { ...req, flow: undefined }, { ...req, selection: { ...req.selection, untracked: false } },
      { ...req, selection: { artifact: file(s, planPath), kind: 'plan', inputs: [], context: [] } },
      { ...req, selection: { ...req.selection, context: ['absent.md'] } },
    ]) {
      put(s, reqPath, JSON.stringify(altered))
      assert.match(next().command, /review start .*--flow f/)
    }
    put(s, reqPath, JSON.stringify(req))
    const statusPath = reviewPath(id, 'status')
    const status = json(s, statusPath)
    put(s, statusPath, JSON.stringify({ ...status, state: 'running' }))
    assert.match(next().command, /review start .*--flow f/)
    put(s, statusPath, JSON.stringify(status))
    const ledgerPath = reviewPath(id, 'ledger')
    const ledger = json(s, ledgerPath)
    put(s, ledgerPath, JSON.stringify({ ...ledger, entries: [{ id: 'F-1', state: 'aceptado', opened_round: 1, seen_round: 1 }] }))
    assert.match(next().command, /review start .*--flow f/)
    put(s, ledgerPath, JSON.stringify(ledger))
    put(s, `.sdd-ai/runs/${id}/review.lock`, 'ocupado')
    assert.match(next().command, /review start .*--flow f/)
    rmSync(file(s, `.sdd-ai/runs/${id}/review.lock`))
    assert.match(next().command, /sdd commit/)
    put(s, reqPath, JSON.stringify({ ...req, degradations: ['same_family'] }))
    assert.match(next().command, /sdd commit/)
  }
})

test('una corrida nueva de la cadena registra el digest del encargo, la familia y el perfil, también heredado de un origen anterior, y copia el encargo al flujo con ese digest', () => {
  const s = chainSetup({ bins: ['codex', 'claude'], families: '[codex, claude]', writers: [
    { actions: [{ write: 'src/one.ts', content: 'export const one = 1\n' }], report: report(['T1'], ['T2', 'T3']) },
    { actions: [{ write: 'src/two.ts', content: 'export const two = 2\n' }], report: report(['T2'], ['T3']) },
    { actions: [{ write: 'src/three.ts', content: 'export const three = 3\n' }], report: report(['T3']) },
  ] })
  put(s, '.sdd-ai/workers.yml', 'schema_version: 1\nroles:\n  implement:\n    codex:\n      model: test-model\n      effort: alto\n')
  chainFlow(s, { tasks: 3 })
  const first = success(runBin(s, ['sdd', 'phase', 'f']))
  wait(s, first.id)
  const initial = registry(s).implement.chains[0].entries[0]
  assert.equal(initial.launch.family, 'codex'); assert.equal(initial.launch.model, 'test-model'); assert.equal(initial.launch.effort, 'high')
  const checkPrompt = (id: string, launch: any, n: number) => {
    const bytes = readFileSync(file(s, `.plans/f/runs/${id}/encargo.md`))
    assert.equal(launch.prompt_digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    assert.equal(bytes.toString('utf8'), fakePrompts(s)[n])
  }
  checkPrompt(first.id, initial.launch, 0)
  // Un origen anterior conserva el perfil concreto en resolved.json.
  const old = registry(s)
  delete old.implement.chains[0].entries[0].launch
  writeRegistry(s, old)
  const controlPath = `.git/sdd-ai/runs/${first.id}/control.json`
  const control = json(s, controlPath)
  const bytes = readFileSync(file(s, registryPath))
  control.phase.registry = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  put(s, controlPath, JSON.stringify(control))
  // La resolución de ahora daría otro perfil: si la corrida nueva lo toma de acá y no del origen, la prueba falla.
  put(s, '.sdd-ai/workers.yml', 'schema_version: 1\nroles:\n  implement:\n    codex:\n      model: other-model\n      effort: bajo\n')
  const second = success(runBin(s, ['sdd', 'phase', 'f', '--blocks']))
  wait(s, second.id)
  const inherited = registry(s).implement.chains[0].entries[1]
  assert.deepEqual([inherited.launch.family, inherited.launch.model, inherited.launch.effort], ['codex', 'test-model', 'high'])
  checkPrompt(second.id, inherited.launch, 1)
  const third = success(runBin(s, ['sdd', 'phase', 'f']))
  wait(s, third.id)
  const last = registry(s).implement.chains[0].entries[2]
  assert.deepEqual([last.launch.family, last.launch.model, last.launch.effort], ['codex', 'test-model', 'high'])
  checkPrompt(third.id, last.launch, 2)
})
