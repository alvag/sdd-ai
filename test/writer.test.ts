import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WRITER_END_MARK, hasEndMark, writerPrompt } from '../src/writer.ts'

test('el contrato envuelve el encargo con las reglas fijas y la marca de fin, sin exigir secciones', () => {
  const encargo = 'Agrega un saludo en src/a.ts.\nSin más detalles.'
  const p = writerPrompt(encargo)
  // Cada regla del contrato.
  for (const rule of [
    /escribe solo lo que el encargo pide/i, /no commitees/i,
    /\.git/, /\.sdd-ai\//, /\.claude\//, /\.codex\//, /\.agents\//, /archivos que Git ignora/,
    /no corras pruebas ni comandos/i, /declara lo que te desviaste del encargo y por qué/i, /STATUS: done/,
  ]) assert.match(p, rule)
  // El encargo va intacto entre delimitadores, y un encargo sin secciones se acepta.
  const [open, close] = ['<<<ENCARGO', 'ENCARGO>>>']
  assert.equal(p.slice(p.indexOf(open) + open.length + 1, p.indexOf(close) - 1), encargo)
  assert.equal(WRITER_END_MARK, 'STATUS: done')
  assert.doesNotThrow(() => writerPrompt('x'))
})

test('la marca de fin es la última línea no vacía', () => {
  assert.equal(hasEndMark('Hice X.\nSTATUS: done\n\n'), true)
  assert.equal(hasEndMark('STATUS: done\nY una línea más'), false)
  assert.equal(hasEndMark('  STATUS: done  '), true)
  assert.equal(hasEndMark(''), false)
})
