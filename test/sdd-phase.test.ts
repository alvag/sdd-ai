import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countTasks, criteriaIds, readHeader, section, taskLines } from '../src/sdd/markdown.ts'
import { renderVerification } from '../src/sdd/verification-contract.ts'
import {
  type FlowData, type FrozenInputs, PHASE_INPUTS, PLAN_TITLES, type PhaseStep, SPEC_TITLES, STATUS_TITLES, admitFix, admitImplement, admitPlan, admitSpecify,
  admitTasks, planHeaderFrom, renderPhasePrompt, renderPlan, renderSpec, renderTasks,
} from '../src/sdd/phase.ts'

const STEPS: PhaseStep[] = ['specify', 'plan', 'tasks', 'implement']
const INPUTS: FrozenInputs = {
  request: 'Quiero exportar a CSV.\n', spec: '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** exporta. (pedido)\n',
  plan: '---\nid: f\n---\n\n# Plan\n', tasks: '# Tasks\n\n- [ ] **T1 — exportar**  · cubre: AC-1\n',
}
const flow = (step: PhaseStep, id = 'flujo-a'): FlowData => ({ id, depth: 'completa', step, ...(step === 'implement' ? { pending: ['T1', 'T3'] } : {}) })

test('el prompt de cada fase nombra sus insumos y fija sus fuentes', () => {
  assert.deepEqual(PHASE_INPUTS, { specify: ['request'], plan: ['spec'], tasks: ['spec', 'plan'], implement: ['spec', 'plan', 'tasks'] })
  for (const step of STEPS) {
    const prompt = renderPhasePrompt(step, flow(step), INPUTS)
    for (const input of PHASE_INPUTS[step]) {
      assert.ok(prompt.includes(`<<<INSUMO ${input}\n${INPUTS[input] ?? ''}\nINSUMO ${input}>>>`), `${step}: falta el insumo ${input}`)
    }
    for (const input of (['request', 'spec', 'plan', 'tasks'] as const).filter((i) => !PHASE_INPUTS[step].includes(i))) {
      assert.equal(prompt.includes(`INSUMO ${input}`), false, `${step}: sobra el insumo ${input}`)
      assert.equal(prompt.includes((INPUTS[input] ?? '').trim()), false, `${step}: sobra el texto de ${input}`)
    }
    // Las fuentes: el repositorio y los insumos, sin memoria, web ni vault, por encima de AGENTS.md.
    assert.match(prompt, /repositorio/)
    assert.match(prompt, /memoria/)
    assert.match(prompt, /web/)
    assert.match(prompt, /vault/)
    assert.match(prompt, /AGENTS\.md/)
    assert.ok(prompt.includes(`"phase": "${step}"`), `${step}: falta el ancla del contrato`)
    // Lo que falta lo busca el conductor en el repositorio: el hijo no lo declara ajeno a él.
    if (step !== 'implement') assert.match(prompt, /`missing_context`: lo que te falta leer o saber para terminar y no encontraste: el conductor lo busca en el repositorio/)
    assert.doesNotMatch(prompt, /no está en el repositorio/)
    assert.match(prompt, /next/)

    // Dos flujos con los mismos insumos dan el mismo prompt salvo los datos del flujo.
    const other = renderPhasePrompt(step, flow(step, 'flujo-b'), INPUTS)
    assert.notEqual(other, prompt)
    assert.equal(other.replaceAll('flujo-b', 'flujo-a'), prompt)
    assert.equal(renderPhasePrompt(step, flow(step), INPUTS), prompt)
  }
  const implement = renderPhasePrompt('implement', flow('implement'), INPUTS)
  assert.match(implement, /T1, T3/)
  assert.match(implement, /STATUS: done/)

  // En una ampliación, el contexto viaja entre sus marcas.
  const amended = renderPhasePrompt('plan', flow('plan'), { ...INPUTS, context: 'La tabla vive en src/export.ts.\n' })
  assert.ok(amended.includes('<<<CONTEXTO ampliación\nLa tabla vive en src/export.ts.\n\nCONTEXTO ampliación>>>'))
  assert.equal(renderPhasePrompt('plan', flow('plan'), INPUTS).includes('CONTEXTO ampliación'), false)
})

const SPECIFY = {
  phase: 'specify',
  known_facts: [{ fact: 'la exportación vive en un módulo', pointer: 'src/export.ts:10' }],
  assumptions: ['el separador es la coma'],
  blocking_questions: [],
  missing_context: [],
  acceptance_criteria: [
    { id: 'AC-1', text: 'Given datos, When exporto, Then sale un CSV.', authority: 'pedido', verification: 'test de exportación' },
    { id: 'AC-2', text: 'El encabezado va en la primera línea.', authority: 'repositorio', verification: 'comparar la primera línea' },
  ],
  problem: 'No hay forma de exportar.', background: 'Nada previo.', scope: '- **Incluye:** CSV\n- **No incluye:** Excel',
}
const json = (o: unknown, extra = '') => `Aquí va el contrato.\n\n${JSON.stringify(o, null, 2)}\n${extra}`
const errorOf = (a: { kind: string; error?: string }) => (a.kind === 'inadmissible' ? a.error ?? '' : `admitido: ${a.kind}`)

test('la admisión de specify rechaza con causa y descarta next', () => {
  const admitted = admitSpecify(json({ ...SPECIFY, next: 'plan' }))
  assert.equal(admitted.kind, 'admitted')
  if (admitted.kind === 'admitted') assert.equal('next' in admitted.review, false)
  assert.equal(admitSpecify(json({ ...SPECIFY, assumptions: [], known_facts: [] })).kind, 'admitted')

  const without = (key: string) => Object.fromEntries(Object.entries(SPECIFY).filter(([k]) => k !== key))
  const criterion = (o: Record<string, unknown>) => ({ ...SPECIFY, acceptance_criteria: [{ ...SPECIFY.acceptance_criteria[0], ...o }] })
  const cases: Array<[string, unknown, RegExp]> = [
    ['sin método', criterion({ verification: '' }), /verification/],
    ['sin método, clave ausente', { ...SPECIFY, acceptance_criteria: [{ id: 'AC-1', text: 'x', authority: 'pedido' }] }, /verification/],
    ['sin criterios', { ...SPECIFY, acceptance_criteria: [] }, /al menos un criterio/],
    ['id repetido', { ...SPECIFY, acceptance_criteria: [SPECIFY.acceptance_criteria[0], SPECIFY.acceptance_criteria[0]] }, /AC-1.*repet/],
    ['id sin forma', criterion({ id: 'C1' }), /AC-<n>/],
    ['autoridad fuera de las cuatro', criterion({ authority: 'usuario' }), /authority/],
    ['campo faltante', without('scope'), /scope/],
    ['clave extra', { ...SPECIFY, extra: 1 }, /extra/],
    ['otra fase', { ...SPECIFY, phase: 'plan' }, /specify/],
    ['prosa con criterios propios', { ...SPECIFY, problem: 'x\n\n## Criterios de aceptación\n\n- **AC-9:** otro' }, /Criterios de aceptación/],
    ['prosa con una sección de status', { ...SPECIFY, background: '## Tasks\n' }, /Tasks/],
    ['prosa con una cerca abierta', { ...SPECIFY, scope: '```\nsin cerrar' }, /cerca/],
  ]
  for (const [name, o, cause] of cases) assert.match(errorOf(admitSpecify(json(o))), cause, name)
  assert.match(errorOf(admitSpecify('sin JSON')), /exactamente un objeto JSON con phase/)
  assert.match(errorOf(admitSpecify(`${json(SPECIFY)}\n${json(SPECIFY)}`)), /hay 2/)
})

test('la admisión de specify arma la spec desde los campos', () => {
  const a = admitSpecify(json(SPECIFY))
  assert.equal(a.kind, 'admitted')
  if (a.kind !== 'admitted') return
  const spec = renderSpec(a.review)
  for (const title of SPEC_TITLES) assert.ok(spec.includes(`\n## ${title}\n`), title)
  assert.deepEqual(criteriaIds(spec), ['AC-1', 'AC-2'])
  assert.match(section(spec, 'Criterios de aceptación') ?? '', /- \*\*AC-1:\*\* Given datos, When exporto, Then sale un CSV\. Verificación: test de exportación\. \(pedido\)/)
  assert.match(section(spec, 'Hechos conocidos') ?? '', /la exportación vive en un módulo \(`src\/export\.ts:10`\)/)
  assert.match(section(spec, 'Supuestos') ?? '', /- el separador es la coma/)
  assert.equal(section(spec, 'Alcance')?.trim(), SPECIFY.scope)
  // Una lista vacía se escribe como ninguno, y el render no inventa criterios que el contrato no trae.
  const empty = renderSpec({ ...a.review, assumptions: [], known_facts: [] })
  assert.match(section(empty, 'Supuestos') ?? '', /Ninguno/)
  assert.equal(countTasks(spec).total, 0)
})

const PLAN_C = {
  phase: 'plan', assumptions: [], blocking_questions: [], missing_context: [],
  approach: 'Un módulo nuevo.', decisions: 'ninguno', files: '- `src/export.ts` — nuevo',
  verification: {
    schema_version: 1 as const,
    rows: [{ id: 'V1', acs: ['AC-1'], kind: 'inspección' as const, obligation: 'none' as const, obligation_reason: 'lectura de la salida', argv: ['npm', 'test'], timeout_ms: 60000, expect: { exit_code: 0 } }],
  },
}
const PLAN_ACS = ['AC-1']
const HANDOFF = { profundidad: 'completa', change_type: 'feat', risk: 'low', spec_approved_at: '2026-09-29T08:59:18-05:00' }

test('la admisión de plan rechaza secciones vacías y títulos reservados', () => {
  assert.equal(admitPlan(json(PLAN_C), PLAN_ACS).kind, 'admitted')
  assert.equal(admitPlan(json({ ...PLAN_C, decisions: '' }), PLAN_ACS).kind, 'admitted')
  const cases: Array<[string, unknown, RegExp]> = [
    ['enfoque vacío', { ...PLAN_C, approach: '  ' }, /approach/],
    ['archivos vacíos', { ...PLAN_C, files: '' }, /files/],
    ['verificación vacía', { ...PLAN_C, verification: '' }, /verification/],
    ['sin documento', { phase: 'plan', assumptions: [], blocking_questions: [], missing_context: [] }, /approach/],
    ['lista que no es lista', { ...PLAN_C, assumptions: 'ninguno' }, /assumptions/],
  ]
  for (const title of [...STATUS_TITLES, ...PLAN_TITLES]) cases.push([`## ${title}`, { ...PLAN_C, approach: `x\n\n## ${title}\n\ny` }, /título reservado/])
  for (const [name, o, cause] of cases) assert.match(errorOf(admitPlan(json(o), PLAN_ACS)), cause, name)
})

test('la admisión de plan arma el header de sdd-flow y la verificación', () => {
  const now = new Date('2026-09-29T14:17:42Z')
  const h = planHeaderFrom('f', HANDOFF, 'feature/f', 'a'.repeat(40), now)
  assert.ok('header' in h)
  if (!('header' in h)) return
  assert.deepEqual(Object.keys(h.header), ['id', 'branch', 'base_commit', 'change_type', 'profundidad', 'risk', 'status', 'created_at'])
  assert.equal(h.header.status, 'planned')
  assert.match(h.header.created_at, /^2026-09-29T\d{2}:17:42[+-]\d{2}:\d{2}$/)
  assert.equal(Date.parse(h.header.created_at), now.getTime())

  const a = admitPlan(json(PLAN_C), PLAN_ACS)
  assert.equal(a.kind, 'admitted')
  if (a.kind !== 'admitted') return
  const plan = renderPlan(a.review, h.header, PLAN_ACS)
  const header = readHeader(plan)
  assert.ok(header.ok)
  if (header.ok) {
    assert.deepEqual(header.data, { ...h.header })
    for (const title of PLAN_TITLES) assert.ok(section(header.body, title) !== null, title)
    assert.equal(section(header.body, 'Verification')?.trim(), renderVerification(PLAN_C.verification))
    assert.equal(section(header.body, 'Decisiones y trade-offs')?.trim(), 'ninguno')
  }
  // Un SHA que YAML leería como número va entre comillas y se lee como texto.
  const numeric = planHeaderFrom('f', HANDOFF, 'feature/f', '1234e5', now)
  if ('header' in numeric) {
    const r = readHeader(renderPlan(a.review, numeric.header, PLAN_ACS))
    assert.ok(r.ok && r.data.base_commit === '1234e5')
  }

  assert.deepEqual(planHeaderFrom('f', { ...HANDOFF, risk: undefined }, 'feature/f', 'abc', now), { missing: ['risk'] })
  assert.deepEqual(planHeaderFrom('f', HANDOFF, null, null, now), { missing: ['branch', 'base_commit'] })
  assert.deepEqual(planHeaderFrom('f', null, 'feature/f', 'abc', now), { missing: ['change_type', 'profundidad', 'risk'] })
})

const TASK = { id: 'T1', title: 'Exportar a CSV', covers: ['AC-1'], pattern: 'como `src/import.ts:12`', test: '`node --test test/export.test.ts`', files: ['src/export.ts'], steps: ['escribir la prueba', 'implementar'] }
const TASKS_C = {
  phase: 'tasks', assumptions: [], blocking_questions: [], missing_context: [],
  tasks: [TASK, { ...TASK, id: 'T2', title: 'Encabezado', covers: ['AC-1', 'AC-2'] }],
}
const CRITERIA = ['AC-1', 'AC-2']

test('la admisión de tasks rechaza con causa y arma exactamente las tasks del contrato', () => {
  const a = admitTasks(json(TASKS_C), CRITERIA)
  assert.equal(a.kind, 'admitted')
  const withTask = (o: Record<string, unknown>) => ({ ...TASKS_C, tasks: [{ ...TASK, ...o }, TASKS_C.tasks[1]] })
  const cases: Array<[string, unknown, RegExp]> = [
    ['sin patrón', withTask({ pattern: '' }), /pattern/],
    ['sin prueba', withTask({ test: ' ' }), /test/],
    ['sin prueba, clave ausente', { ...TASKS_C, tasks: [Object.fromEntries(Object.entries(TASK).filter(([k]) => k !== 'test'))] }, /test/],
    ['archivos vacíos', withTask({ files: [] }), /files/],
    ['un archivo vacío', withTask({ files: [''] }), /files\[0\]/],
    ['pasos vacíos', withTask({ steps: [] }), /steps/],
    ['un paso vacío', withTask({ steps: ['a', ''] }), /steps\[1\]/],
    ['sin tasks', { ...TASKS_C, tasks: [] }, /al menos una task/],
    ['id repetido', { ...TASKS_C, tasks: [TASK, TASK] }, /T1.*repet/],
    ['id sin forma', withTask({ id: 'Tx' }), /T<n>/],
    ['sin cobertura', withTask({ covers: [] }), /covers/],
    ['criterio inexistente', withTask({ covers: ['AC-9'] }), /AC-9/],
    ['criterio sin task', { ...TASKS_C, tasks: [TASK] }, /AC-2.*ninguna task/],
    ['título en dos líneas', withTask({ title: 'uno\ndos' }), /title/],
    ['campo faltante', Object.fromEntries(Object.entries(TASKS_C).filter(([k]) => k !== 'missing_context')), /missing_context/],
  ]
  for (const [name, o, cause] of cases) assert.match(errorOf(admitTasks(json(o), CRITERIA)), cause, name)

  if (a.kind !== 'admitted') return
  const doc = renderTasks(a.review)
  assert.deepEqual(taskLines(doc).map((l) => l.task), [
    { done: false, id: 'T1', title: 'Exportar a CSV', covers: ['AC-1'] },
    { done: false, id: 'T2', title: 'Encabezado', covers: ['AC-1', 'AC-2'] },
  ])
  assert.ok(doc.includes('- [ ] **T1 — Exportar a CSV**  · cubre: AC-1\n'))
  assert.match(doc, /\n {2}- \*\*Patrón:\*\* como `src\/import\.ts:12`/)
  assert.match(doc, /\n {2}- \*\*Prueba:\*\* `node --test test\/export\.test\.ts`/)
  assert.match(doc, /\n {4}1\. escribir la prueba\n {4}2\. implementar/)
  // Un paso con un checkbox queda sangrado y no suma tasks; uno que abre una cerca sin cerrarla no se admite.
  const nested = admitTasks(json(withTask({ steps: ['- [ ] x\n- [ ] y'] })), CRITERIA)
  assert.equal(nested.kind, 'admitted')
  if (nested.kind === 'admitted') assert.equal(countTasks(renderTasks(nested.review)).total, 2)
  assert.match(errorOf(admitTasks(json(withTask({ steps: ['antes\n```\nsin cerrar'] })), CRITERIA)), /tasks:.*T1:AC-1 T2:AC-1,AC-2/)
})

const IMPL = {
  phase: 'implement', missing_context: [],
  tasks: [
    { id: 'T1', change_kind: 'behavior_change', changed: 'agregué la exportación', deviation: null, check: 'actualizar la expectativa' },
    { id: 'T3', change_kind: 'defect', changed: 'arreglé el separador', deviation: { what: 'otro archivo', why: 'estaba ahí' }, check: 'reproducir el fallo' },
  ],
}
const report = (o: unknown) => `Hice el cambio.\n\n${JSON.stringify(o)}\n\nSTATUS: done\n`

test('la admisión de implement exige una entrada por task pendiente antes de la marca de fin', () => {
  assert.equal(admitImplement(report(IMPL), ['T1', 'T3']).kind, 'admitted')
  assert.equal(admitImplement(report({ ...IMPL, next: 'verify' }), ['T1', 'T3']).kind, 'admitted')
  const cases: Array<[string, string, RegExp]> = [
    ['pendiente sin entrada', report({ ...IMPL, tasks: [IMPL.tasks[0]] }), /T3/],
    ['entrada de más', report(IMPL).replace('"T3"', '"T4"'), /T4/],
    ['changed vacío', report({ ...IMPL, tasks: [{ ...IMPL.tasks[0], changed: '' }, IMPL.tasks[1]] }), /changed/],
    ['check vacío', report({ ...IMPL, tasks: [{ ...IMPL.tasks[0], check: '' }, IMPL.tasks[1]] }), /check/],
    ['change_kind fuera de los tres', report({ ...IMPL, tasks: [{ ...IMPL.tasks[0], change_kind: 'feature' }, IMPL.tasks[1]] }), /change_kind/],
    ['sin JSON', 'Hice el cambio.\nSTATUS: done\n', /exactamente un objeto JSON con phase/],
    ['dos objetos', `${JSON.stringify(IMPL)}\n${report(IMPL)}`, /hay 2/],
    ['JSON después de la marca', `Hice el cambio.\nSTATUS: done\n${JSON.stringify(IMPL)}\n`, /STATUS: done/],
    ['sin la marca', `Hice el cambio.\n${JSON.stringify(IMPL)}\n`, /STATUS: done/],
    ['sin missing_context', report({ phase: 'implement', tasks: IMPL.tasks }), /missing_context/],
  ]
  for (const [name, text, cause] of cases) assert.match(errorOf(admitImplement(text, ['T1', 'T3'])), cause, name)
})

test('la admisión de implement con completitud explícita exige completion por task y no la deduce de la prosa', () => {
  const done = (id: string, completion: string) => ({ ...IMPL.tasks.find((x) => x.id === id)!, completion })
  const explicit = { explicit: true }
  const all = admitImplement(report({ ...IMPL, tasks: [done('T1', 'done'), done('T3', 'done')] }), ['T1', 'T3'], explicit)
  assert.equal(all.kind, 'admitted')
  const mixed = admitImplement(report({ ...IMPL, tasks: [done('T1', 'done'), done('T3', 'pending')] }), ['T1', 'T3'], explicit)
  assert.equal(mixed.kind, 'admitted')
  assert.deepEqual(mixed.kind === 'admitted' && mixed.review.tasks.map((x) => x.completion), ['done', 'pending'])
  // La prosa y la marca final no la reemplazan: una task pending sigue pending aunque el reporte diga que terminó.
  const prose = `Terminé todo, las dos tasks quedaron hechas.\n\n${JSON.stringify({ ...IMPL, tasks: [done('T1', 'done'), done('T3', 'pending')] })}\n\nSTATUS: done\n`
  const p = admitImplement(prose, ['T1', 'T3'], explicit)
  assert.deepEqual(p.kind === 'admitted' && p.review.tasks.map((x) => x.completion), ['done', 'pending'])
  const cases: Array<[string, string, RegExp]> = [
    ['sin completion', report(IMPL), /completion/],
    ['completion inválido', report({ ...IMPL, tasks: [done('T1', 'hecha'), done('T3', 'done')] }), /completion tiene que ser done \| pending/],
    ['task omitida', report({ ...IMPL, tasks: [done('T1', 'done')] }), /T3/],
    ['id de más', report({ ...IMPL, tasks: [done('T1', 'done'), { ...done('T3', 'done'), id: 'T4' }] }), /T4/],
    ['id duplicado', report({ ...IMPL, tasks: [done('T1', 'done'), done('T1', 'done')] }), /T1/],
  ]
  for (const [name, text, cause] of cases) assert.match(errorOf(admitImplement(text, ['T1', 'T3'], explicit)), cause, name)
  // Sin el modo explícito se admite el contrato anterior, que no trae completion.
  assert.equal(admitImplement(report(IMPL), ['T1', 'T3']).kind, 'admitted')
})

test('la admisión de fix exige exactamente las filas enviadas antes de la marca de fin', () => {
  const FIX = { phase: 'fix', missing_context: [], rows: [{ id: 'V1', changed: 'corregí la suma', deviation: null }, { id: 'V3', changed: 'el separador', deviation: { what: 'otro archivo', why: 'estaba ahí' } }] }
  const ok = admitFix(report(FIX), ['V1', 'V3'])
  assert.equal(ok.kind, 'admitted')
  assert.deepEqual(ok.kind === 'admitted' && ok.review.rows.map((r) => r.id), ['V1', 'V3'])
  assert.equal(admitFix(report({ ...FIX, next: 'verify' }), ['V1', 'V3']).kind, 'admitted')
  const cases: Array<[string, string, RegExp]> = [
    ['fila enviada sin entrada', report({ ...FIX, rows: [FIX.rows[0]] }), /V3/],
    ['fila no enviada', report({ ...FIX, rows: [...FIX.rows, { id: 'V2', changed: 'x', deviation: null }] }), /V2/],
    ['fila repetida', report({ ...FIX, rows: [FIX.rows[0], FIX.rows[0], FIX.rows[1]] }), /dos entradas/],
    ['otra fase', report({ ...FIX, phase: 'implement' }), /phase tiene que ser "fix"/],
    ['changed vacío', report({ ...FIX, rows: [{ ...FIX.rows[0], changed: '' }, FIX.rows[1]] }), /changed/],
    ['sin la marca', `${JSON.stringify(FIX)}\n`, /STATUS: done/],
    ['clave de más', report({ ...FIX, tasks: [] }), /tasks/],
  ]
  for (const [name, text, cause] of cases) assert.match(errorOf(admitFix(text, ['V1', 'V3'])), cause, name)
})

test('la admisión de plan necesita el header completo: sin sus datos, sdd phase se niega antes de lanzar', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sdd-ai-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: repo })
  const dir = join(repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'handoff.md'), '---\nprofundidad: completa\nchange_type: feat\nspec_approved_at: 2026-09-29T08:59:18-05:00\n---\n')
  writeFileSync(join(dir, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** algo. (pedido)\n')
  const r = spawnSync(join(import.meta.dirname, '..', 'bin', 'sdd-ai'), ['sdd', 'phase', 'f'], {
    cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' },
  })
  const out = JSON.parse(r.stdout)
  assert.deepEqual([r.status, out.code], [2, 'plan_header_incomplete'])
  assert.match(out.message, /risk/)
  assert.equal(existsSync(join(repo, '.sdd-ai', 'runs')), false)
})

test('el encargo de plan pide filas estructuradas y las dos preguntas de pertinencia, sin atribuírselas a la admisión', () => {
  const prompt = renderPhasePrompt('plan', flow('plan'), INPUTS)
  for (const field of ['"schema_version": 1', '"obligation"', '"timeout_ms"', '"implementation_paths"', '"test_name"', '"report_format": "tap"', '"observation"']) {
    assert.ok(prompt.includes(field), field)
  }
  assert.match(prompt, /¿el esperado se cumpliría aunque el requisito fuera falso\?/)
  assert.match(prompt, /¿fallaría aunque el requisito fuera verdadero\?/)
  assert.match(prompt, /esa pertinencia no la puede comprobar/)
})
