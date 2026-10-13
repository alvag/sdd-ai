import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('close y findings sustituyen la copia manual por archive conservando decisiones de hallazgos', () => {
  const root = join(import.meta.dirname, '..')
  const close = readFileSync(join(root, 'skills/sdd-ai/procedures/close.md'), 'utf8')
  const findings = readFileSync(join(root, 'skills/sdd-ai/references/findings.md'), 'utf8')
  for (const text of [close, findings]) {
    for (const pattern of [/sdd archive <id> --prepare/, /sdd archive <id> --apply/, /--summary/, /pregunta canónica exacta/,
      /saneamiento/, /insuficiente/, /conservación literal/, /hooks/, /antes del reclamo|después reclama/,
      /sin otra respuesta|no necesita otra respuesta/, /stopped/, /stageadas propias/, /fuera del verbo/,
      /no restaures|no se reconstruye/, /no edites el origen autorizado/i]) assert.match(text, pattern)
    assert.doesNotMatch(text, /Conserva la política existente de archivo y retiro|mecanismo de archivo declarado por el proyecto|invócalo después de esa persistencia|anota la preservación pendiente\s+en el `## Cierre` del origen/)
  }
  const start = findings.indexOf('1. Ejecuta `sdd archive')
  assert.ok(start >= 0, 'falta el procedimiento nativo numerado')
  const native = findings.slice(start)
  const order = ['--prepare', '2. Revisa saneamiento', '3. Con vault', '4. Declara', '5. Con la respuesta']
  for (const marker of order) assert.ok(native.includes(marker), `falta ${marker} en el procedimiento nativo`)
  for (let i = 1; i < order.length; i++) assert.ok(native.indexOf(order[i]) > native.indexOf(order[i - 1]))
  assert.match(findings, /publicar allí, vincular una coincidencia, descartar/)
  assert.match(findings, /published.*linked.*discarded/s)
  assert.match(findings, /Si el issue ya pudo crearse/)
  assert.match(findings, /autorización|confirma publicar/)
  // Solo acredita el procedimiento escrito; no simula la revisión de contenido ni la sesión real.
})
