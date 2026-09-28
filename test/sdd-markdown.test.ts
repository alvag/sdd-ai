import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  combinedFingerprint, countTasks, planFingerprint, readHeader, section, singleFingerprint, specFingerprint, tasksFingerprint,
} from '../src/sdd/markdown.ts'

const FP = /^sha256:[0-9a-f]{64}$/

const PLAN = [
  '---', 'id: x', 'status: planned', '---', '', '# Plan', '', '## Enfoque', '', 'Un módulo nuevo.', '',
  '## Verification', '', '| AC-1 | test |', '',
].join('\n')

const TASKS = ['# Tasks', '', '- [ ] **T1 — primera**', '  - **Pasos:** escribir el test.', '- [ ] **T2 — segunda**', ''].join('\n')

const CORTA = [
  '---', 'profundidad: corta', 'status: tasks-ready', '---', '', '# Plan', '', '## Spec', '', '- AC-1: algo.', '',
  '## Enfoque', '', 'Directo.', '', '## Tasks', '', '- [ ] T1 — hacerlo', '- [ ] T2 — probarlo', '',
].join('\n')

test('las secciones son headings fuera de los bloques cercados', () => {
  const body = [
    '## Verify', '', 'antes', '```md', '## Verify falso', '# tampoco', '```', 'después', '',
    '~~~', '## Extras (fuera de AC)', '~~~', 'sigue', '', '## Otra', 'fuera',
  ].join('\n')
  assert.equal(section(body, 'Verify'), ['', 'antes', '```md', '## Verify falso', '# tampoco', '```', 'después', '', '~~~', '## Extras (fuera de AC)', '~~~', 'sigue', ''].join('\n'))
  assert.equal(section(body, 'Extras (fuera de AC)'), null)
  assert.equal(section(body, 'Otra'), 'fuera')
  assert.equal(section(body, 'No existe'), null)

  // Una cerca que cierra con más marcas que las que abrió también cierra; con otro carácter, no.
  const closes = ['```', '## Tasks falso', '`````', '## Tasks', '- [ ] T1'].join('\n')
  assert.equal(section(closes, 'Tasks'), '- [ ] T1')
  const other = ['```', '~~~', '## Tasks', '```', 'fin'].join('\n')
  assert.equal(section(other, 'Tasks'), null)

  // `## Verify` termina en el siguiente `##` o en un `#`: lo que sigue a un `#` nuevo cuenta para la huella.
  const withVerify = `${PLAN}\n## Verify\n\n| AC-1 | cumplido |\n\n# Anexo\n\nuno\n`
  const changedAfter = `${PLAN}\n## Verify\n\n| AC-1 | cumplido |\n\n# Anexo\n\ndos\n`
  assert.equal(section(readHeaderBody(withVerify), 'Verify'), '\n| AC-1 | cumplido |\n')
  assert.notEqual(planFingerprint(withVerify), planFingerprint(changedAfter))
})

test('la huella ignora las marcas de tasks, los finales de línea, los espacios finales, el header y Verify y Extras del plan', () => {
  assert.match(specFingerprint('# Spec\n'), FP)
  assert.equal(specFingerprint('# Spec\n\n- AC-1: algo.\n'), specFingerprint('# Spec  \r\n\r\n- AC-1: algo.\t'))
  assert.equal(specFingerprint('# Spec\r- AC-1\r'), specFingerprint('# Spec\n- AC-1'))

  assert.equal(tasksFingerprint(TASKS), tasksFingerprint(TASKS.replace('- [ ] **T1', '- [x] **T1').replace('- [ ] **T2', '- [X] **T2')))
  assert.equal(tasksFingerprint(TASKS), tasksFingerprint(TASKS.replaceAll('\n', '\r\n')))

  const plan = planFingerprint(PLAN)
  assert.equal(plan, planFingerprint(PLAN.replace('status: planned', 'status: implementing\nsequence_contract_version: 1')))
  assert.equal(plan, planFingerprint(`${PLAN}\n## Verify\n\n| AC-1 | cumplido |\n\n## Extras (fuera de AC)\n\n- E1 — algo · a.ts\n`))
  assert.equal(plan, planFingerprint(`${PLAN}## Verify\n\n## Extras (fuera de AC)\n`))
  assert.equal(plan, planFingerprint(`${PLAN}\n\n## Verify\n\n| AC-1 | cumplido |\n`))
  const middle = PLAN.replace('## Verification', '## Verify\n\n| AC-1 | cumplido |\n\n## Verification')
  assert.equal(plan, planFingerprint(middle))

  const single = singleFingerprint(CORTA)
  assert.equal(single, singleFingerprint(CORTA.replace('- [ ] T1', '- [x] T1').replace('status: tasks-ready', 'status: verified')))
  assert.equal(single, singleFingerprint(`${CORTA}\n## Verify\n\n| AC-1 | cumplido |\n`))

  const combined = combinedFingerprint({ plan, tasks: tasksFingerprint(TASKS) })
  assert.match(combined, FP)
  assert.equal(combined, combinedFingerprint({ tasks: tasksFingerprint(TASKS), plan }))
})

test('la huella cambia con una palabra, un paso, una sección, una línea vacía agregada o una marca dentro de una cerca', () => {
  const spec = '# Spec\n\n- AC-1: algo observable.\n- AC-2: otra cosa.\n'
  assert.notEqual(specFingerprint(spec), specFingerprint(spec.replace('algo', 'nada')))
  assert.notEqual(specFingerprint(spec), specFingerprint(spec.replace('- AC-2', '\n- AC-2')))

  assert.notEqual(tasksFingerprint(TASKS), tasksFingerprint(TASKS.replace('escribir el test', 'escribir dos tests')))
  const nested = TASKS.replace('  - **Pasos:** escribir el test.', '  - [ ] subpaso')
  assert.notEqual(tasksFingerprint(nested), tasksFingerprint(nested.replace('  - [ ] subpaso', '  - [x] subpaso')))
  const fenced = `${TASKS}\n\`\`\`md\n- [ ] ejemplo\n\`\`\`\n`
  assert.notEqual(tasksFingerprint(fenced), tasksFingerprint(fenced.replace('- [ ] ejemplo', '- [x] ejemplo')))

  assert.notEqual(planFingerprint(PLAN), planFingerprint(PLAN.replace('Un módulo nuevo.', 'Dos módulos nuevos.')))
  assert.notEqual(planFingerprint(PLAN), planFingerprint(PLAN.replace('## Verification', '## Riesgos\n\nNinguno.\n\n## Verification')))
  assert.notEqual(planFingerprint(PLAN), planFingerprint(PLAN.replace('| AC-1 | test |', '| AC-1 | test |\n| AC-2 | test |')))

  assert.notEqual(singleFingerprint(CORTA), singleFingerprint(CORTA.replace('T2 — probarlo', 'T2 — probarlo dos veces')))
  // Solo se neutralizan las marcas de `## Tasks`: un checkbox de la spec cuenta como texto.
  const boxed = CORTA.replace('- AC-1: algo.', '- [ ] AC-1: algo.')
  assert.notEqual(singleFingerprint(boxed), singleFingerprint(boxed.replace('- [ ] AC-1', '- [x] AC-1')))
  assert.notEqual(combinedFingerprint({ plan: planFingerprint(PLAN), tasks: tasksFingerprint(TASKS) }),
    combinedFingerprint({ plan: planFingerprint(PLAN), tasks: tasksFingerprint(nested) }))
})

test('readHeader rechaza un header que no es un mapa', () => {
  const ok = readHeader('---\nid: x\nstatus: planned\n---\n\n# Plan\n')
  assert.deepEqual(ok, { ok: true, data: { id: 'x', status: 'planned' }, body: '\n# Plan\n' })
  assert.equal(readHeader('---\r\nid: x  \r\n---  \r\ncuerpo').ok, true)

  for (const text of ['---\nsolo un texto\n---\n', '---\n- uno\n- dos\n---\n', '---\n---\n', '# Plan\n', '---\nid: x\n', '---\nid: x\nid: y\n---\n', '---\nid: [x\n---\n']) {
    const r = readHeader(text)
    assert.equal(r.ok, false, text)
    if (!r.ok) assert.notEqual(r.detail, '')
  }
})

test('cuenta los checkboxes de primer nivel fuera de las cercas, no los anidados ni otras marcas', () => {
  const text = [
    '# Tasks', '', '- [ ] a', '* [x] b', '+ [ ] c', '1. [X] d', '2) [ ] e', '  - [ ] anidado', '- [~] marca', '-[ ] pegado',
    '```', '- [ ] en la cerca', '```', '~~~~', '- [x] en otra', '~~~~', '- [ ]', '',
  ].join('\n')
  assert.deepEqual(countTasks(text), { total: 6, done: 2, firstPending: 'a' })
  assert.deepEqual(countTasks('- [x] **T1 — hecha** · cubre: AC-1\n- [ ] **T2 — pendiente** · cubre: AC-2\n'),
    { total: 2, done: 1, firstPending: '**T2 — pendiente** · cubre: AC-2' })
  assert.deepEqual(countTasks('prosa sin tasks\n'), { total: 0, done: 0, firstPending: null })
})

function readHeaderBody(text: string): string {
  const h = readHeader(text)
  assert.ok(h.ok)
  return h.body
}
