import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARTIFACT_MANDATES, renderArtifactMaterial, renderArtifactPrompt, renderArtifactRoundPrompt } from '../src/review/artifact-prompt.ts'
import { type ArtifactKind, type ArtifactSelection, freezeArtifact } from '../src/review/artifact.ts'
import type { LedgerEntry, RoundPlan } from '../src/review/ledger.ts'
import { ARTIFACT_SYSTEM_PROMPT } from '../src/workers/claude.ts'
import { makeRepo } from './helpers.ts'

const REVIEWER_OF_CODE = /revisor de c[oó]digo|code reviewer/i
// Lo que va entre delimitadores es material a revisar, no instrucción al worker.
const withoutMaterial = (prompt: string) => prompt.replace(/<<<([A-ZÁÉÍÓÚ]+)[^\n]*>>>\n[\s\S]*?<<<FIN \1[^\n]*>>>/g, '')

const SPEC = '# Spec\n\n- AC-1: algo observable.\n- AC-2: hoy el prompt llama al worker "revisor de código".\n'
const PLAN = '# Plan\n\nAC-1 se cumple con `resolve` en src/a.ts:1.\n'
const TASKS = '# Tasks\n\n- [ ] T1 — cubre AC-1.\n'

function setup(kind: ArtifactKind) {
  const repo = makeRepo()
  mkdirSync(join(repo, '.plans'), { recursive: true })
  writeFileSync(join(repo, '.plans', 'pedido.md'), 'Quiero algo observable.\n')
  writeFileSync(join(repo, '.plans', 'spec.md'), SPEC)
  writeFileSync(join(repo, '.plans', 'plan.md'), PLAN)
  writeFileSync(join(repo, '.plans', 'tasks.md'), TASKS)
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
  const inputs = {
    spec: [{ role: 'request' as const, path: '.plans/pedido.md' }],
    plan: [{ role: 'spec' as const, path: '.plans/spec.md' }],
    tasks: [{ role: 'spec' as const, path: '.plans/spec.md' }, { role: 'plan' as const, path: '.plans/plan.md' }],
  }[kind]
  const sel: ArtifactSelection = { artifact: `.plans/${kind}.md`, kind, inputs, context: kind === 'spec' ? [] : ['a.ts'] }
  const { candidate, bytes } = freezeArtifact(repo, sel)
  return { repo, candidate, bytes, material: renderArtifactMaterial(candidate, bytes) }
}

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  id: 'F-1', round: 1, state: 'aceptado', axis: 'quality', severity: 'CRITICAL', location: '.plans/spec.md:3',
  claim: 'el AC-1 no se puede observar', evidence: 'inferential', responses: [], ...over,
})

function roundTwo(kind: ArtifactKind) {
  const s = setup(kind)
  const plan: RoundPlan = {
    n: 2, prev_hash: 'sha256:x', identical: false,
    targets: [{ id: 'F-1', kind: 'verify' }, { id: 'F-2', kind: 'respond' }],
    changed: { [s.candidate.files[0].path]: [[3, 3]] }, removed: [[2, 2]],
  }
  const before = 'uno\nlínea borrada\ntres\n'
  const after = s.bytes.get(s.candidate.files[0].path)?.toString('utf8') ?? ''
  const entries = [
    entry({ location: `${s.candidate.files[0].path}:3` }),
    entry({ id: 'F-2', state: 'rechazado', location: `${s.candidate.context[0].path}:1`, decision: { action: 'reject', reason: 'no aplica', from: 'abierto', after_round: 1 } }),
  ]
  return { ...s, prompt: renderArtifactRoundPrompt(s.candidate, s.material, plan, entries, 3, before, after) }
}

test('el prompt nombra el tipo y trae el mandato de SCOPE, SPEC y QUALITY de ese tipo', () => {
  for (const kind of ['spec', 'plan', 'tasks'] as const) {
    const { candidate, material } = setup(kind)
    const prompt = renderArtifactPrompt(candidate, material)
    assert.match(prompt, { spec: /una spec/, plan: /un plan/, tasks: /unas tasks/ }[kind])
    assert.ok(prompt.includes('1. SCOPE — ¿sobra algo?'), kind)
    assert.ok(prompt.includes(`2. ${ARTIFACT_MANDATES[kind].spec}`), kind)
    assert.ok(prompt.includes(`3. ${ARTIFACT_MANDATES[kind].quality}`), kind)
    assert.ok(prompt.includes('Dry run') && prompt.includes('Implementación más floja') && prompt.includes('Malentendido de buena fe') && prompt.includes('Ausencia no pedida'), kind)
  }
})

test('ningún prompt ni system prompt de artefacto dice revisor de código', () => {
  const prompts = (['spec', 'plan', 'tasks'] as const).flatMap((k) => {
    const { candidate, material } = setup(k)
    return [renderArtifactPrompt(candidate, material), roundTwo(k).prompt]
  })
  for (const p of prompts) {
    // La spec del material cita la frase: la búsqueda la vería si no se excluyera el material.
    assert.match(p, REVIEWER_OF_CODE)
    assert.doesNotMatch(withoutMaterial(p), REVIEWER_OF_CODE)
  }
  assert.doesNotMatch(ARTIFACT_SYSTEM_PROMPT, REVIEWER_OF_CODE)
})

test('el artefacto, cada insumo y cada contexto van en bloques numerados', () => {
  const { material, candidate } = setup('tasks')
  const h = candidate.hash
  assert.ok(material.includes(`<<<ARTEFACTO tasks .plans/tasks.md ${h}>>>\n1│# Tasks\n2│\n3│- [ ] T1 — cubre AC-1.\n<<<FIN ARTEFACTO tasks .plans/tasks.md ${h}>>>`))
  assert.ok(material.includes(`<<<INSUMO spec .plans/spec.md ${h}>>>\n1│# Spec\n`))
  assert.ok(material.includes(`<<<INSUMO plan .plans/plan.md ${h}>>>\n1│# Plan\n`))
  assert.ok(material.includes(`<<<CONTEXTO a.ts ${h}>>>\n1│export const a = 1\n<<<FIN CONTEXTO a.ts ${h}>>>`))
  assert.match(material, /^A \.plans\/tasks\.md — 3 líneas; visibles 1-3$/m)
})

test('el esquema pide of y unverifiable, y no pide causalidad', () => {
  const { candidate, material } = setup('spec')
  const prompt = renderArtifactPrompt(candidate, material)
  const schema = prompt.slice(prompt.indexOf('Esquema:'), prompt.indexOf('<<<MANIFIESTO'))
  assert.match(schema, /"of": /)
  assert.match(schema, /"unverifiable": \[/)
  assert.doesNotMatch(schema, /causality/)
  assert.match(prompt, /Va siempre: una respuesta sin `unverifiable` se rechaza/)
})

test('el mandato de plan y tasks pide declarar lo que el contexto no alcanza a comprobar', () => {
  for (const kind of ['plan', 'tasks'] as const) {
    assert.match(ARTIFACT_MANDATES[kind].quality, /está solo una parte, como una función sin sus llamadores/)
    assert.match(ARTIFACT_MANDATES[kind].quality, /`unverifiable`/)
  }
  assert.doesNotMatch(ARTIFACT_MANDATES.spec.quality, /unverifiable/)
})

test('la ronda N muestra número y texto de las líneas cambiadas y de las borradas', () => {
  const { prompt, candidate } = roundTwo('spec')
  const cambios = prompt.slice(prompt.indexOf(`<<<CAMBIOS ${candidate.hash}>>>`), prompt.indexOf(`<<<FIN CAMBIOS ${candidate.hash}>>>`))
  assert.ok(cambios.includes('+3│- AC-1: algo observable.'))
  assert.ok(cambios.includes('-2│línea borrada'))
  assert.match(prompt, /su `cause` cita una línea de CAMBIOS/)
})

test('los pendientes de la ronda N llevan of', () => {
  const { prompt, candidate } = roundTwo('spec')
  const verify = prompt.slice(prompt.indexOf('<<<VERIFICAR'), prompt.indexOf('<<<FIN VERIFICAR'))
  const respond = prompt.slice(prompt.indexOf('<<<RESPONDER'), prompt.indexOf('<<<FIN RESPONDER'))
  const of = new RegExp(`"of": "${candidate.files[0].path.replaceAll('.', '\\.')}"`)
  assert.match(verify, of)
  // Un hallazgo del artefacto con su evidencia en un insumo llega con el artefacto como `of`.
  assert.match(respond, /"location": "\.plans\/pedido\.md:1"/)
  assert.match(respond, of)
})

test('la ronda N trae el mandato de su tipo y pide unverifiable', () => {
  for (const kind of ['spec', 'plan', 'tasks'] as const) {
    const { prompt } = roundTwo(kind)
    assert.ok(prompt.includes(`2. ${ARTIFACT_MANDATES[kind].spec}`), kind)
    assert.ok(prompt.includes(`3. ${ARTIFACT_MANDATES[kind].quality}`), kind)
    assert.match(prompt, /"unverifiable": \[/)
    assert.match(prompt, /"cause": "\+N" \| "-N"/)
  }
})

test('la ronda N pide que un hallazgo nuevo sea del artefacto', () => {
  const { prompt, candidate } = roundTwo('plan')
  assert.ok(prompt.includes(`es un defecto del artefacto: su \`of\` es ${candidate.files[0].path}`))
})

test('la pauta de plan pide revisar la pertinencia de cada fila con dos preguntas', () => {
  const plan = ARTIFACT_MANDATES.plan.quality
  assert.match(plan, /¿el esperado se cumpliría aunque el requisito fuera falso\?/)
  assert.match(plan, /¿fallaría aunque el requisito fuera verdadero\?/)
  // La pauta de las otras piezas no carga esas preguntas.
  assert.equal(ARTIFACT_MANDATES.tasks.quality.includes('requisito fuera falso'), false)
})
