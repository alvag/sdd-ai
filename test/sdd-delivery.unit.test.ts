import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type SpecifyContract, SPEC_TITLES, STATUS_TITLES, admitSpecify, renderSpec, renderPhasePrompt } from '../src/sdd/phase.ts'
import { criteriaIds, section } from '../src/sdd/markdown.ts'
import { ARTIFACT_MANDATES } from '../src/review/artifact-prompt.ts'

const contract: SpecifyContract = {
  phase: 'specify', known_facts: [], assumptions: [], blocking_questions: [], missing_context: [],
  acceptance_criteria: [
    { id: 'AC-1', text: 'Exporta un resultado.', authority: 'pedido', verification: 'comparar el resultado' },
    { id: 'AC-2', text: 'El conductor comprueba el resultado antes del commit.', authority: 'pedido', verification: 'inspección precommit' },
  ], problem: 'Exportar un resultado.', background: 'Pedido mixto.', scope: 'Producto y comprobación precommit.',
}
const admitted = (value: unknown): SpecifyContract => {
  const result = admitSpecify(JSON.stringify(value))
  assert.equal(result.kind, 'admitted', JSON.stringify(result))
  if (result.kind !== 'admitted') throw new Error('contrato no admitido')
  return result.review
}
const rejected = (delivery: unknown, cause?: string) => {
  const result = admitSpecify(JSON.stringify({ ...contract, delivery }))
  assert.equal(result.kind, 'inadmissible', JSON.stringify(delivery))
  if (result.kind !== 'inadmissible') throw new Error('contrato admitido')
  assert.match(result.error, /delivery/)
  if (Array.isArray(delivery) && delivery.length) assert.match(result.error, /delivery\[0\]/)
  if (cause) assert.ok(result.error.includes(cause), result.error)
}

test('specify admite y representa delivery separado y rechaza su contenido inválido', () => {
  const baseline = renderSpec(admitted(contract))
  assert.equal(section(baseline, 'Criterios de aceptación')?.trim(),
    '- **AC-1:** Exporta un resultado. Verificación: comparar el resultado. (pedido)\n'
    + '- **AC-2:** El conductor comprueba el resultado antes del commit. Verificación: inspección precommit. (pedido)')
  const obligations = [' Abrir el PR después del commit.\nEsperar revisión externa. ', 'Registrar SHA y checks.']
  const valid = admitted({ ...contract, delivery: obligations })
  const doc = renderSpec(valid)
  assert.deepEqual(valid.delivery, obligations)
  assert.deepEqual(valid.acceptance_criteria, contract.acceptance_criteria)
  assert.deepEqual(criteriaIds(doc), ['AC-1', 'AC-2'])
  assert.equal(section(doc, 'Criterios de aceptación'), section(baseline, 'Criterios de aceptación'))
  assert.equal(section(doc, 'Entrega posterior al commit')?.trim(), '- Abrir el PR después del commit.\n  Esperar revisión externa.\n- Registrar SHA y checks.')
  assert.doesNotMatch(section(doc, 'Criterios de aceptación') ?? '', /Abrir el PR|revisión externa/)
  assert.doesNotMatch(section(doc, 'Entrega posterior al commit') ?? '', /\[(?: |x|X)\]|acreditad|certificad|cumplid|status:/)
  assert.deepEqual([...doc.matchAll(/^## (.+)$/gm)].map((m) => m[1]), [...SPEC_TITLES])
  assert.equal(SPEC_TITLES[SPEC_TITLES.indexOf('Criterios de aceptación') + 1], 'Entrega posterior al commit')
  for (const value of [contract, { ...contract, delivery: [] }]) {
    const c = admitted(value)
    assert.deepEqual(c.delivery, value === contract ? undefined : [])
    assert.equal(section(renderSpec(c), 'Entrega posterior al commit')?.trim(), 'Ninguno.')
    assert.equal(section(renderSpec(c), 'Criterios de aceptación'), section(baseline, 'Criterios de aceptación'))
  }
  // Compatibilidad de objetos tipados anteriores que no pasan por admisión.
  assert.equal(section(renderSpec(contract), 'Entrega posterior al commit')?.trim(), 'Ninguno.')
  for (const value of [null, 'texto', 1, {}, [null], [1], [{}], [''], [' \t\n']]) rejected(value)
  for (const checkbox of ['[ ]', '[x]', '[X]']) {
    for (const marker of ['', '-', '*', '+', '1.']) {
      for (const before of ['', ' ', '\t', ' \t']) {
        for (const after of ['', ' ', '\t', ' \t']) {
          const line = `${before}${marker}${after}${checkbox} abrir el PR`
          for (const prefix of ['', 'Obligación válida\n']) rejected([prefix + line], 'línea')
        }
      }
    }
  }
  for (const line of ['[ ] abrir el PR', '[x] abrir el PR', '[X] abrir el PR', '- [x] abrir el PR', '1. [ ] abrir el PR']) rejected([line], 'checkbox')
  for (const title of [...SPEC_TITLES, ...STATUS_TITLES]) rejected([`Obligación\n## ${title}\nContenido`], title)
  for (const fence of ['```', '~~~']) rejected([`Obligación\n${fence}\ncontenido`], 'cerca')
  for (const value of ['Ejemplo\n```text\ntexto\n```', 'Ejemplo\n~~~text\ntexto\n~~~', 'Mencionar [x] dentro de una frase.', '[v] abrir el PR', '[✓] revisar', '[done] publicar']) {
    const c = admitted({ ...contract, delivery: [value] })
    assert.equal(section(renderSpec(c), 'Entrega posterior al commit')?.trim(), `- ${value.split('\n').join('\n  ')}`)
    assert.equal(section(renderSpec(c), 'Criterios de aceptación'), section(baseline, 'Criterios de aceptación'))
  }
  const reserved = admitSpecify(JSON.stringify({ ...contract, problem: '## Entrega posterior al commit\nOtro' }))
  assert.equal(reserved.kind, 'inadmissible')
})

test('los encargos separan delivery de AC filas y tasks sin excepciones por actor', () => {
  const inputs = {
    request: 'Exportar un resultado; el conductor lo comprueba antes del commit; abrir el PR después del commit.',
    spec: renderSpec(admitted({ ...contract, delivery: ['Abrir el PR después del commit.', 'Esperar la revisión externa.'] })),
    plan: '# Plan\n\n## Decisiones y trade-offs\n\nLa entrega consiste en abrir el PR después del commit.\n',
  }
  for (const step of ['specify', 'plan', 'tasks'] as const) {
    const full = renderPhasePrompt(step, { id: 'mixto', depth: 'normal', step }, inputs)
    const instructions = full.replace(/<<<INSUMO (\w+)\n[\s\S]*?\nINSUMO \1>>>/g, '')
    assert.ok(!instructions.includes(inputs.request))
    const m = ARTIFACT_MANDATES[step === 'specify' ? 'spec' : step]
    assert.ok(instructions.includes(m.spec))
    assert.ok(instructions.includes(m.quality))
    assert.match(instructions, /trabajo precommit/)
    assert.match(instructions, /(?:sin excepciones por actor|cualquier actor)/)
    if (step === 'specify') {
      assert.match(instructions, /"delivery": \[/)
      assert.match(instructions, /lista opcional de textos no vacíos/)
      assert.match(instructions, /ausencia y \[\] significan ninguna entrega/)
      assert.match(instructions, /La excepción es `delivery`/)
      assert.match(instructions, /nunca en acceptance_criteria/)
      assert.match(instructions, /comprobaciones reales del conductor anteriores al commit/)
      for (const marker of ['[ ]', '[x]', '[X]']) assert.ok(instructions.includes(marker))
      assert.match(instructions, /headings reservados.*cercas sin cerrar/)
    } else {
      assert.match(instructions, /no genera filas de Verification ni tasks/)
      assert.match(instructions, /Ninguna fila o task debe exigir el commit, la publicación del PR o la revisión externa posteriores que esa misma verificación habilita/)
      assert.match(instructions, /cobertura completa de todos los AC del producto/)
      if (step === 'plan') assert.match(instructions, /Cada criterio de la spec tiene al menos una fila/)
      else {
        assert.match(instructions, /cada criterio de la spec lo cubre al menos una task/)
        assert.match(instructions, /Todas las tasks deben poder completarse antes de la verificación final/)
        assert.match(instructions, /incluso cuando se mencionen entre las decisiones del plan/)
      }
    }
  }
  // Controles directos de cada mandato: las frases del encargo no pueden satisfacerlos.
  for (const kind of ['spec', 'plan', 'tasks'] as const) {
    const m = ARTIFACT_MANDATES[kind]
    for (const text of [m.spec, m.quality]) {
      assert.match(text, /entrega futura/)
      assert.match(text, /(?:sin|fuera de|no requiere).*AC.*filas.*tasks/)
      assert.match(text, /incumplimiento.*trasladar.*dependencia circular del commit, publicación del PR o revisión externa/)
    }
  }
  const { spec, plan, tasks } = ARTIFACT_MANDATES
  assert.match(spec.spec, /resultado del producto sin AC.*obligación posterior al commit.*sección Entrega posterior al commit/)
  assert.match(spec.quality, /Cobertura del objetivo: cada resultado del producto.*AC; cada obligación de entrega futura.*sección Entrega posterior al commit/)
  assert.doesNotMatch(spec.spec, /algo del pedido que ningún criterio cubre/)
  assert.doesNotMatch(spec.quality, /cada resultado declarado tiene al menos un AC/)
  assert.match(plan.spec, /decisión de implementación precommit.*requieren mecanismos/)
  assert.doesNotMatch(plan.spec, /una decisión de la spec que el plan ignora/)
  assert.match(plan.quality, /Orden y dependencias: cada paso precommit/)
  assert.match(plan.quality, /Contratos entre componentes:.*trabajo precommit/)
  assert.match(plan.quality, /Verificación:.*trabajo precommit/)
  assert.match(tasks.spec, /decisión precommit del plan.*menciones de entrega futura.*no requieren tasks/)
  assert.doesNotMatch(tasks.spec, /una decisión del plan que ninguna task ejecuta/)
  assert.match(tasks.quality, /Cobertura bidireccional AC↔task: cobertura completa del trabajo del producto/)
  assert.match(tasks.quality, /Orden ejecutable: los productos precommit/)
  assert.match(tasks.quality, /Interfaces Produce\/Consume:.*trabajo precommit/)
  assert.match(tasks.quality, /Evidencia: cada task precommit/)
})
