import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { nodeMetadata } from '../src/recall.ts'

// Los nodos `<flujo>.md` del vault los escribe knowledge-vault (kv) sin comillas, con «: » dentro de los valores: no
// son YAML válido. Estos nodos son sintéticos, pero tienen la forma de los reales: las mismas claves en el mismo
// orden, la fecha con offset y el resumen con «: » sin comillas.

/** Un nodo con el header y el cuerpo dados, como lo escribe kv. */
const node = (header: string[], body = '# Nodo\n') => ['---', ...header, '---', body].join('\n')

const KV_NODE = node([
  'type: sdd-flow',
  'title: Spec — lector sintético: primera fase',
  'project: proyecto-sintetico',
  'flow: lector-sintetico',
  'branch: fix/lector-sintetico',
  'date: 2026-01-02T03:04:05-05:00',
  'provenance: worktree-sintetico/.plans/lector-sintetico',
  'state: done',
  'summary: Fix H-0 (paquete 0): el lector sintético lee: tres campos (abc1234)',
])

test('un nodo con la forma de kv no es YAML y nodeMetadata lo lee', () => {
  const header = KV_NODE.split('---')[1]
  assert.throws(() => parse(header), /Nested mappings are not allowed/)
  assert.deepEqual(nodeMetadata(KV_NODE), {
    state: 'done',
    date: '2026-01-02T03:04:05-05:00',
    summary: 'Fix H-0 (paquete 0): el lector sintético lee: tres campos (abc1234)',
  })
})

test('nodeMetadata limpia los valores como kv', () => {
  const summary = (line: string) => nodeMetadata(node([line])).summary
  // Entre comillas simples, como kv escribe algunos resúmenes: se quitan las comillas y lo de adentro queda literal.
  assert.equal(summary("summary: 'Fix H-1: con dos puntos # y un numeral'"), 'Fix H-1: con dos puntos # y un numeral')
  assert.equal(summary("summary: 'entre comillas' # comentario"), 'entre comillas')
  // Fuera de comillas, ` #` abre un comentario; pegado a una palabra, no.
  assert.equal(summary('summary: Resumen: sin comillas # comentario'), 'Resumen: sin comillas')
  assert.equal(summary('summary: PR#12: pegado'), 'PR#12: pegado')

  // Las fechas se conservan tal cual: con offset, sin hora o `desconocido`, que kv escribe cuando no la sabe.
  const date = (value: string) => nodeMetadata(node([`date: ${value}`])).date
  assert.equal(date('2026-01-02T03:04:05-05:00'), '2026-01-02T03:04:05-05:00')
  assert.equal(date('2026-01-02'), '2026-01-02')
  assert.equal(date('desconocido'), 'desconocido')

  // Solo cuentan las claves de primer nivel, y la primera de cada una.
  assert.deepEqual(nodeMetadata(node(['extra:', '  state: anidado', 'state: done', 'state: planned'])),
    { state: 'done', date: null, summary: null })

  // El BOM y los finales CRLF no cambian nada.
  assert.deepEqual(nodeMetadata(`﻿${KV_NODE.replaceAll('\n', '\r\n')}`), nodeMetadata(KV_NODE))

  // Sin frontmatter, con un valor vacío o con solo un comentario no hay dato.
  const empty = { state: null, date: null, summary: null }
  assert.deepEqual(nodeMetadata('# Nodo sin header\nstate: done\n'), empty)
  assert.deepEqual(nodeMetadata(node(['state:', 'date: ""', 'summary: # solo comentario'])), empty)
  assert.deepEqual(nodeMetadata(''), empty)
})
