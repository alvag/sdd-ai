import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderPhasePrompt } from '../src/sdd/phase.ts'
import type { Candidate } from '../src/review/candidate.ts'
import { LENSES, type LedgerEntry, type RoundPlan } from '../src/review/ledger.ts'
import { renderMaterial, renderReviewPrompt, renderRoundPrompt, renderLensRoundPrompt } from '../src/review/prompt.ts'
import { renderArtifactMaterial, renderArtifactPrompt, renderArtifactRoundPrompt } from '../src/review/artifact-prompt.ts'

const request = 'Exportar a CSV con encabezado.'
const spec = 'AC-1: la exportación CSV incluye el encabezado.'
const hash = `sha256:${'a'.repeat(64)}`

// Quita bloques completos, sin confundir las marcas citadas en las instrucciones de acceso.
function phaseInstructions(prompt: string): string {
  return prompt.replace(/^<<<(INSUMO \w+|CONTEXTO ampliación)\n[\s\S]*?^\1>>>\n?/gm, '')
}

function reviewInstructions(prompt: string): string {
  return prompt.replace(/^<<<([^\n]+ sha256:[a-f0-9]+)>>>\n[\s\S]*?^<<<FIN \1>>>\n?/gm, '')
}

function discipline(instructions: string): void {
  assert.match(instructions, /mínimo necesario para cumplir el pedido y sus AC/)
  assert.match(instructions, /lo que el pedido o un AC no sostiene no es exigencia/)
  assert.match(instructions, /Las decisiones ya aprobadas en el plan y las tasks siguen siendo vinculantes\./)
  assert.match(instructions, /Distingue un incumplimiento de un borde especulativo o de una decisión no tomada/)
  assert.match(instructions, /«falta decidir» no equivale a «falta exigir»/)
  assert.match(instructions, /Una ausencia no pedida no se convierte por sí sola en obligación/)
  assert.match(instructions, /defectos reales y seguridad necesaria con evidencia concreta/)
  assert.match(instructions, /defectos o riesgos concretos que introduce el propio cambio/)
  assert.match(instructions, /no autoriza correcciones fuera de alcance/)
  assert.doesNotMatch(instructions, /fuera de lo pedido/)
}

function clause(instructions: string, label: string, content: RegExp): void {
  const line = instructions.split('\n').find((line) => line.startsWith(`- ${label}:`))
  assert.ok(line, `falta la cláusula ${label}`)
  assert.match(line, /el pedido o un AC/)
  assert.match(line, content)
}

function artifactConditions(instructions: string, kind: 'spec' | 'plan' | 'tasks'): void {
  if (kind === 'spec') {
    clause(instructions, 'Bordes del dominio', /precondiciones, los límites y los fallos.*cuando son necesarios para cumplir/)
    clause(instructions, 'Adopción', /estados preexistentes o las corridas vivas.*cuando son necesarios para cumplir/)
  }
  if (kind === 'plan') {
    clause(instructions, 'Efectos colaterales', /compatibilidad y el rollback se exigen cuando son necesarios para cumplir/)
  }
}

test('las cuatro fases exigen el mínimo y condicionan bordes y adopción al encargo', () => {
  const inputs = { request, spec, plan: 'Exportar CSV usando el mecanismo existente.',
    tasks: '- [ ] **T1 — Exportar CSV**\n  - Incluye el encabezado de AC-1.\n', context: request }
  for (const step of ['specify', 'plan', 'tasks', 'implement'] as const) {
    const instructions = phaseInstructions(renderPhasePrompt(step, { id: 'csv', depth: 'normal', step, pending: ['T1'] }, inputs))
    assert.doesNotMatch(instructions, /Exportar a CSV con encabezado\.|AC-1: la exportación/)
    discipline(instructions)
    if (step !== 'implement') artifactConditions(instructions, step === 'specify' ? 'spec' : step)
    if (step === 'plan') {
      const sentence = instructions.split(/\.(?:\s|$)/).find((part) => part.includes('las alternativas o trade-offs'))
      assert.ok(sentence)
      assert.match(sentence, /el pedido o un AC no necesitan/)
      assert.match(sentence, /sin convertirse en trabajo obligatorio/)
    }
  }
})

test('las revisiones distinguen requisitos, especulación y decisiones sin perder evidencia', () => {
  const candidate: Candidate = {
    base_sha: 'b'.repeat(40), head_sha: null, hash, left_out: [],
    files: [{ path: 'export.ts', status: 'A', mode: '100644', sha256: 'c', binary: false, lines: 1, visible: [[1, 1]] }],
    context: [{ path: 'spec.md', sha256: 'd', lines: 1 }],
    diff: 'diff --git a/export.ts b/export.ts\nnew file mode 100644\n--- /dev/null\n+++ b/export.ts\n@@ -0,0 +1 @@\n+export const csv = "header"\n',
  }
  const entries: LedgerEntry[] = [
    { id: 'F-1', round: 1, state: 'aceptado', axis: 'spec', severity: 'CRITICAL', location: 'spec.md:1',
      claim: 'Se omite el encabezado exigido.', evidence: 'deterministic', responses: [] },
    { id: 'F-2', round: 1, state: 'rechazado', axis: 'scope', severity: 'SUGGESTION', location: 'spec.md:1',
      claim: 'Agregar otro formato y convivencia con versiones anteriores.', responses: [],
      decision: { action: 'reject', reason: 'fuera de lo pedido', from: 'abierto', after_round: 1 } },
  ]
  const round: RoundPlan = { n: 2, prev_hash: hash, identical: false,
    targets: [{ id: 'F-1', kind: 'verify' }, { id: 'F-2', kind: 'respond' }], changed: { 'export.ts': [[1, 1]] } }
  const material = renderMaterial(candidate, new Map([['spec.md', spec]]))
  const codePrompts = [
    renderReviewPrompt(candidate, new Map([['spec.md', spec]])),
    renderRoundPrompt(candidate, material, round, entries, 3),
    ...LENSES.flatMap((reviewer) => [renderReviewPrompt(candidate, new Map([['spec.md', spec]]), { reviewer }),
      renderLensRoundPrompt(candidate, material, round, reviewer, 3)]),
  ]
  const seen = new Set<string>()
  for (const prompt of codePrompts) {
    const instructions = reviewInstructions(prompt)
    for (const mark of ['RIESGO —', 'RESILIENCIA —', 'FIABILIDAD —', 'SCOPE —', 'Clasifica cada hallazgo', '## Reglas']) {
      if (instructions.includes(mark)) seen.add(mark)
    }
    assert.doesNotMatch(instructions, /Se omite el encabezado exigido|Agregar otro formato|AC-1: la exportación/)
    discipline(instructions)
    assert.match(instructions, /Solo puedes citar líneas que ves/)
    assert.match(instructions, /Una cita a una ruta o a una línea que no ves rechaza la respuesta entera/)
    assert.match(instructions, /deterministic.*línea citada muestra el defecto/)
    assert.match(instructions, /inferential.*razonando sobre el comportamiento/)
    if (instructions.includes('RIESGO —')) assert.match(instructions, /impacto alcanzable; no reportes un riesgo hipotético/)
    if (instructions.includes('RESILIENCIA —')) assert.match(instructions, /modo de falla concreto; no reportes especulación operativa genérica/)
    if (instructions.includes('FIABILIDAD —')) assert.match(instructions, /aserciones observables: qué entrada da qué resultado/)
    if (instructions.includes('SCOPE —') || instructions.includes('Clasifica cada hallazgo')) {
      assert.match(instructions, /ni el pedido ni los AC sostienen/)
    }
    if (instructions.includes('## Reglas')) assert.match(instructions, /hallazgos nuevos solo pueden citar líneas del bloque CAMBIOS/)
  }
  // Las comprobaciones condicionadas no se saltan en silencio: cada marca aparece en algún prompt.
  assert.deepEqual([...seen].sort(), ['## Reglas', 'Clasifica cada hallazgo', 'FIABILIDAD —', 'RESILIENCIA —', 'RIESGO —', 'SCOPE —'].sort())
  for (const kind of ['spec', 'plan', 'tasks'] as const) {
    const path = `${kind}.md`
    const artifact: Candidate = { ...candidate, subject: { kind }, base_sha: null, diff: '',
      files: [{ ...candidate.files[0], path }], context: [{ path: 'request.md', sha256: 'e', lines: 1, role: 'request' }] }
    const bytes = new Map([[path, Buffer.from(spec)], ['request.md', Buffer.from(request)]])
    const artifactMaterial = renderArtifactMaterial(artifact, bytes)
    const artifactRound: RoundPlan = { ...round, changed: { [path]: [[1, 1]] }, removed: [[1, 1]] }
    for (const prompt of [renderArtifactPrompt(artifact, artifactMaterial),
      renderArtifactRoundPrompt(artifact, artifactMaterial, artifactRound, entries, 3, spec, spec)]) {
      const instructions = reviewInstructions(prompt)
      assert.doesNotMatch(instructions, /Se omite el encabezado exigido|Agregar otro formato|AC-1: la exportación|Exportar a CSV con encabezado/)
      discipline(instructions)
      artifactConditions(instructions, kind)
      clause(instructions, 'Dry run', /una decisión que el pedido o un AC necesitan para ejecutar el encargo/)
      clause(instructions, 'Ausencia no pedida', /solo cuando sean necesarios para cumplir.*su ausencia por sí sola no es una exigencia/)
      assert.match(instructions, /ni el pedido ni los AC sostienen/)
      assert.match(instructions, /Cada línea de los bloques ARTEFACTO, INSUMO y CONTEXTO.*Cita ese número/)
      assert.match(instructions, /Una cita a una ruta o a una línea que no ves rechaza la respuesta entera/)
      assert.match(instructions, /deterministic.*líneas citadas muestran el defecto/)
      assert.match(instructions, /inferential.*razonando/)
      assert.match(instructions, /una respuesta sin `unverifiable` se rechaza/)
      if (kind !== 'spec') assert.match(instructions, /se comprueba solo contra los bloques CONTEXTO/)
      if (instructions.includes('## Reglas')) {
        assert.match(instructions, /Un hallazgo nuevo solo se admite como regresión de la corrección/)
        assert.match(instructions, /una cita del material actual que muestra el defecto/)
      }
    }
  }
})

test('la skill contrasta el alcance antes de aceptar o proponer una ampliación', () => {
  const source = readFileSync(new URL('../skills/sdd-ai/SKILL.md', import.meta.url), 'utf8')
  const decision = source.split('### Decidir cada hallazgo\n')[1]?.split('### La ronda siguiente\n')[0]
  assert.ok(decision)
  assert.match(decision, /Antes de aceptar una corrección, contrástala con el pedido o los AC aprobados/)
  assert.match(decision, /lo que el pedido o un\s+AC no sostiene no es exigencia/)
  assert.match(decision, /Las decisiones ya aprobadas en el plan y las tasks siguen siendo vinculantes\./)
  assert.match(decision, /`accept` y corrige los hallazgos sustentados por el pedido o un AC/)
  assert.match(decision, /defectos o riesgos\s+concretos que introduce el propio cambio, dentro del alcance autorizado/)
  assert.match(decision, /`reject` las ampliaciones y las decisiones que ni el pedido ni los AC sostienen/)
  assert.match(decision, /«falta decidir»\s+no equivale a «falta exigir»/)
  assert.match(decision, /motivo literal «fuera de lo pedido».*explica qué pedido o AC\s+no sostiene esa exigencia, de forma comprobable contra esos insumos/)
  assert.match(decision, /verificar en el código[\s\S]*o en el pedido y los AC aprobados, no una opinión/)
  assert.match(decision, /Solo si propones incorporar una ampliación como conductor, consulta a Max ofreciendo excluirla\s+o diferirla y espera su respuesta antes de incorporarla/)
  assert.match(decision, /fuera de alcance que no impide cumplir un AC se rechaza en el ledger\s+con «fuera de lo pedido» y se registra en el registro transversal/)
  assert.match(decision, /Si impide cumplir un AC,[\s\S]*registra el hallazgo, declara el AC afectado, detén su avance y pide una\s+decisión humana/)
  assert.match(decision, /Registrar o aceptar un hallazgo no autoriza ampliar el\s+alcance ni sustituye los gates humanos de spec y plan-tasks/)
  assert.match(decision, /Una decisión se puede cambiar hasta que lances la ronda siguiente/)
  assert.match(decision, /Lo grave que ya estaba antes del cambio queda `fuera-de-alcance`: no se decide/)
  const registry = source.split('## Registro transversal de hallazgos\n')[1]?.split('### Registro y entradas\n')[0]
  assert.ok(registry)
  assert.match(registry, /Registrar no autoriza corregir ni ampliar el alcance/)
  assert.match(registry, /Si un hallazgo impide cumplir un AC, declara el criterio afectado, detén su avance y pide al usuario\s+una decisión/)
  assert.match(registry, /Solo una decisión\s+explícita que incorpore el problema al alcance y su resolución permiten `resolved_in_flow`/)
  assert.match(registry, /no aprueba gates: `spec` y `plan-tasks` en profundidad normal\s+siguen requiriendo respuesta humana/)
})
