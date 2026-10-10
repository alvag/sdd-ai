import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as markdown from '../src/sdd/markdown.ts'
import { admitTasks, renderTasks, renderPhasePrompt } from '../src/sdd/phase.ts'
import { ARTIFACT_MANDATES } from '../src/review/artifact-prompt.ts'

const task = (id: string, actor: unknown = 'writer') => ({ id, title: `Acción ${id}`, actor,
  covers: ['AC-1'], pattern: 'src/a.ts:1', test: 'V1', files: ['src/a.ts'], steps: ['Escribir el cambio'] })
const contract = (tasks: unknown[]) => ({ phase: 'tasks', findings: [], assumptions: [], blocking_questions: [], missing_context: [], tasks })
const admit = (tasks: unknown[]) => admitTasks(JSON.stringify(contract(tasks)), ['AC-1'])

test('admite y relee actores validos y bloquea declaraciones invalidas o duplicadas', () => {
  const absent = { ...task('T1') } as Record<string, unknown>
  delete absent.actor
  // El contrato nuevo exige el actor: una task sin él no se admite.
  assert.equal(admit([absent]).kind, 'inadmissible')
  const accepted = admit(['writer', 'conductor', 'user'].map((actor, i) => task(`T${i + 1}`, actor)))
  assert.equal(accepted.kind, 'admitted')
  if (accepted.kind !== 'admitted') return
  const text = renderTasks(accepted.review)
  assert.deepEqual(markdown.taskLines(text).map((l) => l.task?.actor), ['writer', 'conductor', 'user'])
  assert.deepEqual(markdown.taskLines(text).map((l) => [l.task?.id, l.task?.covers]), [['T1', ['AC-1']], ['T2', ['AC-1']], ['T3', ['AC-1']]])
  assert.match(text, /\*\*T1 — Acción T1\*\*  · actor: writer  · cubre: AC-1/)
  for (const actor of ['', 'other', null, [], {}, ['writer'], 1]) assert.equal(admit([task('T1', actor)]).kind, 'inadmissible', JSON.stringify(actor))
  const raw = JSON.stringify(contract([task('T1')]))
  for (const actor of ['writer', 'user']) {
    const duplicate = raw.replace('"actor":"writer"', `"actor":"writer","actor":"${actor}"`)
    const result = admitTasks(duplicate, ['AC-1'])
    assert.equal(result.kind, 'inadmissible')
    if (result.kind === 'inadmissible') assert.match(result.error, /actor.*T1/)
  }
  // JSON.parse se queda con el último contenedor `tasks`: un actor repetido en él no se escapa por un primero vacío.
  const hidden = admitTasks(raw.replace('"tasks":[', '"tasks":[],"tasks":[').replace('"actor":"writer"', '"actor":"writer","actor":"user"'), ['AC-1'])
  assert.equal(hidden.kind, 'inadmissible')
  if (hidden.kind === 'inadmissible') assert.match(hidden.error, /actor repetido.*T1/)
  assert.equal(admitTasks(raw.replace('"tasks":[', '"tasks":[],"tasks":['), ['AC-1']).kind, 'admitted')
  assert.equal(admitTasks(raw.replace('"findings":[]', '"findings":[],"findings":[]'), ['AC-1']).kind, 'admitted')
  assert.equal(admitTasks(raw.replace('"title":"Acción T1"', '"title":"otro","title":"Acción T1"'), ['AC-1']).kind, 'admitted')
  const legacy = admitTasks(JSON.stringify(contract([absent])), ['AC-1'], { taskActors: false })
  assert.equal(legacy.kind, 'admitted')
  if (legacy.kind === 'admitted') {
    assert.doesNotMatch(renderTasks(legacy.review), /actor:/)
    assert.equal('actor' in markdown.taskLines(renderTasks(legacy.review))[0].task!, false)
  }

  const mixed = '# Tasks\n\n'
    + '- [ ] **T1 — Código**  · actor: writer  · cubre: AC-1\n'
    + '- [ ] **T2 — Claude**  · cubre: AC-1  · actor: conductor\n'
    + '- [x] **T3 — Observación**  · actor: user  · cubre: AC-1\n'
    + '- [ ] T4 — Mostrar texto · actor: user · cubre: AC-1\n'
    + '- [ ] **T5 — Mostrar · actor: user**  · cubre: AC-1\n'
    + '  - actor: user\n'
    + '```md\n- [ ] **T99 — Ignorar** · actor: user\n```\n'
    + '- [ ] trabajo inline\n'
  const responsibilities = markdown.readTaskResponsibilities(mixed)
  assert.deepEqual(responsibilities.writerPending, ['T1', 'T4', 'T5'])
  assert.deepEqual(responsibilities.pendingAssignments.map((t) => [t.id, t.actor]), [['T1', 'writer'], ['T2', 'conductor'], ['T4', null], ['T5', null]])
  assert.deepEqual(responsibilities.inlinePending, ['- [ ] trabajo inline'])
  assert.equal(markdown.countTasks(mixed).total, 6)
  const inherited = markdown.taskLines(mixed).find((l) => l.task?.id === 'T4')!.task!
  assert.equal(inherited.title, 'Mostrar texto · actor: user')
  assert.equal('actor' in inherited, false)
  for (const metadata of ['actor:', 'actor: other', 'actor: writer · actor: user', 'actor: writer · actor: writer']) {
    const invalid = `# Tasks\n\n- [ ] **T7 — Inválida** · ${metadata} · cubre: AC-1\n`
    const read = markdown.readTaskResponsibilities(invalid)
    assert.deepEqual(read.writerPending, [])
    assert.deepEqual(read.inlinePending, [])
    assert.equal(read.actorErrors[0].line, 3)
    assert.equal(read.actorErrors[0].id, 'T7')
    assert.equal(markdown.countTasks(invalid).total, 1)
    assert.equal(markdown.taskLines(invalid)[0].task, null)
  }
})

test('proyecta bloques completos y conserva el orden documental sin fallback', () => {
  const text = '# Tasks\n\n- [ ] **T1 — Código** · actor: writer · cubre: AC-1\n'
    + '  - **Patrón:** src/a.ts\n  - **Pasos:**\n    1. Escribir\n    ```ts\n    const x = 1\n    ```\n\n'
    + '- [ ] **T2 — Claude** · actor: conductor · cubre: AC-1\n  - **Pasos:** observar\n\n'
    + '- [ ] **T3 — Otro cambio** · actor: writer · cubre: AC-1\n  - **Prueba:** V1\n\n## Otra sección\nExterior\n'
  const selected = markdown.projectTaskBlocks(text, ['T3', 'T1'])
  assert.deepEqual(markdown.taskLines(selected).map((l) => l.task?.id), ['T1', 'T3'])
  assert.match(selected, /\*\*Patrón:\*\* src\/a.ts/)
  assert.match(selected, /```ts\n    const x = 1\n    ```/)
  assert.doesNotMatch(selected, /T2|Exterior/)
  assert.throws(() => markdown.projectTaskBlocks(text, ['T9']), /T9/)
  assert.throws(() => markdown.projectTaskBlocks(text + '\n- [ ] **T1 — Duplicada**\n', ['T1']), /repetida/)
  const prompt = renderPhasePrompt('implement', { id: 'f', depth: 'normal', step: 'implement', pending: ['T1'] }, { spec: 'spec', plan: 'plan', tasks: text })
  assert.doesNotMatch(prompt, /T2 — Claude|T3 — Otro cambio/)
  assert.match(prompt, /faltantes destinados al conductor/)
})

test('el encargo y la revisión separan autoridad y secuencia final', () => {
  const prompt = renderPhasePrompt('tasks', { id: 'f', depth: 'normal', step: 'tasks' }, { spec: 'spec', plan: 'plan' })
  for (const pattern of [/"actor": "writer" \| "conductor" \| "user"/, /un solo actor/, /productos preceden/, /comprobaciones con Claude/, /acreditación de sus filas/, /aprobación de gates/, /no sustituye la prueba humana/]) assert.match(prompt, pattern)
  assert.match(ARTIFACT_MANDATES.tasks.quality, /capacidades y autoridad/)
  assert.match(ARTIFACT_MANDATES.tasks.quality, /Todas pueden terminar antes de verify/)
})

test('un actor declarado antes de un ** posterior se diagnostica y no cae al writer', () => {
  const r = markdown.readTaskResponsibilities('- [ ] **T1 — X**  · actor: user  · cubre: AC-1 **nota**\n')
  assert.deepEqual(r.writerPending, [])
  assert.deepEqual(r.actorErrors.map((e) => e.id), ['T1'])
  // Un `· actor:` dentro del título en negrita sigue siendo título.
  assert.deepEqual(markdown.readTaskResponsibilities('- [ ] **T1 — Mostrar · actor: user**  · cubre: AC-1\n').writerPending, ['T1'])
})

test('un id repetido no se delega: sus pendientes quedan para atención inline', () => {
  const text = '- [ ] **T1 — Uno**  · actor: writer  · cubre: AC-1\n- [ ] **T1 — Otro**  · actor: writer  · cubre: AC-1\n- [ ] **T2 — Dos**  · actor: writer  · cubre: AC-1\n'
  const r = markdown.readTaskResponsibilities(text)
  assert.deepEqual(r.writerPending, ['T2'])
  assert.equal(r.inlinePending.length, 2)
  assert.deepEqual(r.pendingAssignments.map((t) => t.id), ['T2'])
})

test('un título con ** conserva su lectura heredada y su round-trip con actor', () => {
  const legacy = markdown.parseTaskLine('- [ ] **T1 — Soportar `**` en globs**  · cubre: AC-1')
  assert.deepEqual(legacy, { done: false, id: 'T1', title: 'Soportar `**` en globs', covers: ['AC-1'] })
  assert.deepEqual(markdown.readTaskResponsibilities('- [ ] **T1 — Soportar `**` en globs**  · cubre: AC-1\n').writerPending, ['T1'])
  const admitted = admit([{ ...task('T1', 'user'), title: 'Soportar `**` en globs' }])
  assert.equal(admitted.kind, 'admitted')
  if (admitted.kind !== 'admitted') return
  const line = markdown.taskLines(renderTasks(admitted.review))[0].task
  assert.deepEqual([line?.title, line?.actor], ['Soportar `**` en globs', 'user'])
})
