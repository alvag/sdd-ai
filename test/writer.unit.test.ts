import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WRITER_END_MARK, hasEndMark, writerEnvelopeBytes, writerPrompt } from '../src/writer.ts'
import { WORKER_POLICY, withWorkerPolicy } from '../src/worker-policy.ts'

test('el writer conserva la política una sola vez y el material intacto', () => {
  for (const encargo of ['material\n', withWorkerPolicy('material\n')]) {
    const prompt = writerPrompt(encargo)
    assert.equal(prompt.split(WORKER_POLICY).length - 1, 1)
    // La política va al tope del prompt, por encima de las reglas fijas, y no dentro del encargo del conductor.
    assert.ok(prompt.startsWith(WORKER_POLICY))
    assert.ok(prompt.includes('<<<ENCARGO\nmaterial\n\nENCARGO>>>'))
  }
})

test('el contrato envuelve el encargo con las reglas fijas y la marca de fin, sin exigir secciones', () => {
  const encargo = 'Agrega un saludo en src/a.ts.\nSin más detalles.'
  const p = writerPrompt(encargo)
  // Cada regla del contrato.
  for (const rule of [
    /escribe solo lo que el encargo pide/i, /no commitees/i,
    /\.git/, /\.sdd-ai\//, /\.claude\//, /\.codex\//, /\.agents\//, /archivos que Git ignora/,
    /lee el repositorio con libertad, también con el shell/i, /no ejecutes pruebas, builds, instaladores ni ningún comando que escriba/i,
    /las comprobaciones las corre `sdd verify`/, /declara lo que te desviaste del encargo y por qué/i, /STATUS: done/,
  ]) assert.match(p, rule)
  // La regla ya no prohíbe los comandos de lectura: esa ambigüedad frenó a un writer que leía con el shell.
  assert.doesNotMatch(p, /no corras pruebas ni comandos/i)
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

test('el envoltorio del writer mide lo que suma a cualquier encargo', () => {
  assert.equal(writerEnvelopeBytes(), Buffer.byteLength(writerPrompt(''), 'utf8'))
  assert.equal(Buffer.byteLength(writerPrompt('ñandú'), 'utf8'), writerEnvelopeBytes() + Buffer.byteLength('ñandú', 'utf8'))
})
