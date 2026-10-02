import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Crossed, ROUTE, type RouteThresholds, renderBootstrap, renderReminder } from '../src/route.ts'
import { makeRepo } from './helpers.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const SKILL = join(import.meta.dirname, '..', 'skills', 'sdd-ai', 'SKILL.md')
const SENTINEL: RouteThresholds = { exploreMinFiles: 91, writerMinFiles: 92, minDelegateLines: 93, backstop: { calls: 94, reads: 95, edits: 96 } }
const EXPLORE = '`./bin/sdd-ai run --role explore --prompt-file <encargo>`'

/** Si el texto trae la frase con ese número entero: `92 o más` no cuenta como `2 o más`. */
const hasPhrase = (text: string, phrase: string) => new RegExp(`(?<!\\d)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)

test('imprime el bootstrap para leerlo', () => {
  console.log(renderBootstrap())
})

test('el bootstrap entra en 40 líneas y 4 KB', () => {
  const text = renderBootstrap()
  assert.ok(text.split('\n').length <= 40, `${text.split('\n').length} líneas`)
  assert.ok(Buffer.byteLength(text) <= 4096, `${Buffer.byteLength(text)} bytes`)
})

test('el bootstrap dice la autorización, las tres rutas, que el tamaño y el riesgo solo proponen SDD con la pregunta de profundidad, las premisas, la refutación y el cierre con ruta y supuestos', () => {
  const text = renderBootstrap()
  for (const anchor of [
    'solo lectura', 'una sola pregunta al usuario', 'no cambian el proyecto y no necesitan esa pregunta',
    'tres rutas: inline, delegada y SDD opcional',
    'Ni el tamaño ni el riesgo eligen SDD', 'lo proponen con la pregunta de profundidad',
    '¿se puede decir ahora, sin explorar, qué archivos se van a tocar y cómo se sabrá que funcionó?', 'solo con un sí del usuario',
    'se validan las premisas', 'checks focalizados', 'después, los completos',
    '`./bin/sdd-ai run --role refute --prompt-file <encargo>`',
    'declara la ruta que siguió y los supuestos que tomó',
  ]) assert.ok(text.includes(anchor), `falta: ${anchor}`)
})

test('el bootstrap da el comando de exploración con un temporal fuera del repo, que se borra cuando run lo copió y se conserva si falla antes', () => {
  const text = renderBootstrap()
  assert.ok(text.includes(`${ROUTE.exploreMinFiles} o más archivos, la exploración se delega`))
  assert.ok(text.includes('sea cual sea el tamaño del cambio'))
  assert.ok(text.includes(`archivo temporal fuera del repositorio y se corre ${EXPLORE} con esa ruta`))
  assert.ok(text.includes('El temporal se borra cuando `run` confirma que copió el encargo a la corrida'))
  assert.ok(text.includes('se conserva si `run` falla antes'))
})

test('el bootstrap define las 20 líneas como agregadas más quitadas, la excepción mecánica solo para elegir la ruta y la excepción cuando no se puede escribir el encargo', () => {
  const text = renderBootstrap()
  assert.ok(text.includes(`menos de ${ROUTE.minDelegateLines} líneas (agregadas más quitadas) no se delega`))
  assert.ok(text.includes(`la exploración sí, por la regla de los ${ROUTE.exploreMinFiles} archivos`))
  assert.ok(text.includes('Un cambio mecánico, como renombrar o formatear, no cuenta para elegir la ruta'))
  assert.ok(text.includes('el recordatorio de sesión larga cuenta igual todas las ediciones'))
  assert.ok(text.includes('Si el encargo no se puede escribir'))
  assert.ok(text.includes('la exploración va inline, y es una excepción admitida'))
})

test('cada texto cambia con los umbrales que usa y no conserva los valores por defecto', () => {
  const bootstrap = renderBootstrap(SENTINEL)
  for (const n of [91, 92, 93]) assert.ok(bootstrap.includes(String(n)), `el bootstrap no usa ${n}`)
  for (const old of [`${ROUTE.exploreMinFiles} o más`, `${ROUTE.writerMinFiles} o más`, `${ROUTE.minDelegateLines} líneas`]) {
    assert.ok(!hasPhrase(bootstrap, old), `el bootstrap conserva ${old}`)
  }
  const reminder = renderReminder(['calls', 'reads', 'edits'], { calls: 94, reads: 95, edits: 96 }, SENTINEL)
  for (const n of [91, 94, 95, 96]) assert.ok(reminder.includes(String(n)), `el recordatorio no usa ${n}`)
  const { calls, reads, edits } = ROUTE.backstop
  for (const old of [calls, reads, edits, ROUTE.exploreMinFiles]) {
    assert.ok(!reminder.includes(` ${old} `) && !reminder.includes(`: ${old})`), `el recordatorio conserva ${old}`)
  }
})

test('la skill no repite los números de la constante', () => {
  const skill = readFileSync(SKILL, 'utf8')
  const { calls, reads, edits } = ROUTE.backstop
  for (const phrase of [
    `${ROUTE.exploreMinFiles} o más archivos`, `${ROUTE.writerMinFiles} o más archivos`, `${ROUTE.minDelegateLines} líneas`,
    `${calls} llamadas`, `${reads} lecturas`, `${edits} ediciones`,
  ]) assert.ok(!hasPhrase(skill, phrase), `la skill repite: ${phrase}`)
})

test('el texto del writer sigue a implement: con run aceptándolo, el bootstrap y el recordatorio nombran la escritura delegada', () => {
  const repo = makeRepo()
  mkdirSync(join(repo, '.sdd-ai'))
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex]\n  selection: full\n')
  const prompt = join(mkdtempSync(join(tmpdir(), 'sdd-ai-prompt-')), 'p.md')
  writeFileSync(prompt, 'Encargo de prueba.\n')
  const r = spawnSync(process.execPath, [BIN, 'run', '--role', 'implement', '--prompt-file', prompt], {
    cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' },
  })
  const out = JSON.parse(r.stdout || 'null') as { code?: string } | null
  // run acepta el rol: lo que lo frena en este repo sin commits es la base, no el rol.
  assert.notEqual(out?.code, 'usage', r.stdout + r.stderr)
  assert.ok(renderBootstrap().includes('--role implement'))
  assert.ok(!renderBootstrap().includes('llega con la fase 4b'))
  assert.ok(!renderReminder(['edits'], { calls: 0, reads: 0, edits: 3 }).includes('llega con la fase 4b'))
})

test('con implement despachable el bootstrap nombra el comando del writer, la regla de 20 líneas, las rutas que no se delegan y la pregunta de permiso', () => {
  const b = renderBootstrap(SENTINEL, true)
  const writer = b.split('\n').find((l) => l.includes('--role implement')) ?? ''
  assert.match(writer, new RegExp(`Con ${SENTINEL.writerMinFiles} o más archivos no triviales para escribir`))
  assert.ok(writer.includes('`./bin/sdd-ai run --role implement --prompt-file <encargo>`'))
  assert.match(writer, /misma pregunta que escribir inline/)
  for (const p of ['`.git`', '`.sdd-ai/`', '`.claude/`', '`.codex/`', '`.agents/`', 'archivos que Git ignora']) assert.ok(writer.includes(p), p)
  assert.match(writer, /va inline o se propone SDD/)
  const lines = b.split('\n').find((l) => l.includes(`menos de ${SENTINEL.minDelegateLines} líneas`)) ?? ''
  assert.match(lines, new RegExp(`no se delega aunque toque ${SENTINEL.writerMinFiles} o más archivos`))
  // Sin el writer, el texto de antes: nada que delegar.
  assert.ok(!renderBootstrap(SENTINEL, false).includes('--role implement'))
})

test('el recordatorio de ediciones remite al comando del writer', () => {
  const r = renderReminder(['edits'], { calls: 0, reads: 0, edits: 3 }, SENTINEL, true)
  assert.ok(r.includes('`./bin/sdd-ai run --role implement --prompt-file <encargo>`'))
  assert.match(r, new RegExp(`${SENTINEL.writerMinFiles} o más archivos no triviales`))
  assert.match(r, new RegExp(`${SENTINEL.minDelegateLines} líneas`))
  assert.match(r, /con permiso del usuario/)
  assert.ok(!renderReminder(['edits'], { calls: 0, reads: 0, edits: 3 }, SENTINEL, false).includes('--role implement'))
})

test('recordatorio con Jira: on e invalid no ofrecen el writer y dicen que todo cambio va por SDD; off es el de hoy', () => {
  const counts = { calls: 97, reads: 98, edits: 99 }
  const all: Crossed[] = ['calls', 'reads', 'edits']
  for (const wd of [true, false]) assert.equal(renderReminder(all, counts, SENTINEL, wd, 'off'), renderReminder(all, counts, SENTINEL, wd))
  const editsLine = (r: string) => r.split('\n').find((l) => l.startsWith('- 99 ediciones'))
  const on = renderReminder(all, counts, SENTINEL, true, 'on')
  assert.equal(editsLine(on), '- 99 ediciones (umbral: 96): con `jira_approval` en `on`, todo cambio del proyecto va por un flujo SDD, ' +
    'aunque sea `corta`: se le propone al usuario.')
  assert.ok(!on.includes('--role implement'))
  const others = (r: string) => r.split('\n').filter((l) => !l.startsWith('- 99 ediciones'))
  assert.deepEqual(others(on), others(renderReminder(all, counts, SENTINEL, true)))
  const detail = '.sdd-ai/config.yml: jira_approval.mode tiene que ser "on" u "off", no true'
  const invalid = renderReminder(['edits'], counts, SENTINEL, true, 'invalid', detail)
  assert.equal(editsLine(invalid), `- 99 ediciones (umbral: 96): la config de Jira no se puede leer (${detail}) y rige lo mismo que con ` +
    '`jira_approval` en `on`: todo cambio del proyecto va por un flujo SDD, aunque sea `corta`, y se le propone al usuario.')
  assert.ok(!invalid.includes('--role implement'))
})

test('con jira on el bootstrap exige SDD, nombra las dos partes y no ofrece rutas de escritura; con invalid lo dice; con off es el de hoy', () => {
  for (const wd of [true, false]) assert.equal(renderBootstrap(SENTINEL, wd, 'off'), renderBootstrap(SENTINEL, wd))
  const on = [
    'Ruta directa de sdd-ai en este repositorio, con la aprobación de la spec en Jira:',
    '- Con `jira_approval` en `on`, todo cambio del proyecto va por un flujo SDD, aunque sea `corta`, y la spec se publica en Jira ' +
      'con dos partes: un resumen para el PO, en lenguaje no técnico, y la definición técnica.',
    '- Fuera de un flujo SDD el trabajo es de solo lectura. Escribir el encargo de una delegación en un archivo temporal fuera del ' +
      'repositorio, y el estado que `run` deja en `.sdd-ai/`, no cambian el proyecto.',
    '- Cuando entender el cambio requiere 91 o más archivos, la exploración se delega, sea cual sea el tamaño del cambio que venga ' +
      `después: se escribe el encargo en un archivo temporal fuera del repositorio y se corre ${EXPLORE} con esa ruta. El temporal ` +
      'se borra cuando `run` confirma que copió el encargo a la corrida, y se conserva si `run` falla antes.',
    '- Si el encargo no se puede escribir, porque el usuario prohíbe toda escritura o porque el entorno no deja escribir fuera del ' +
      'repositorio, la exploración va inline, y es una excepción admitida.',
    '- Antes de rediseñar algo o de repetir una investigación, al arrancar un flujo, ante un «¿por qué se decidió esto?» ' +
      'o cuando el código cita un motivo que no está escrito, se buscan antecedentes con `./bin/sdd-ai recall "<tema>"`: ' +
      'busca en Engram, en el vault, en `.plans/` y en el log de Git, y su `next` dice qué fuente manda.',
    '- Un flujo SDD se arranca con `./bin/sdd-ai sdd start <id>`: el ensayo muestra el config, las familias y los antecedentes ' +
      'sin escribir nada; `--apply` crea `.plans/<id>/` con lo que el usuario confirmó.',
    '- Primero se validan las premisas y se corren checks focalizados; después, los completos.',
    '- Una refutación de solo lectura se pide con `./bin/sdd-ai run --role refute --prompt-file <encargo>`.',
    '- Al cerrar, el conductor declara la ruta que siguió y los supuestos que tomó.',
  ]
  const detail = '.sdd-ai/config.yml: jira_approval.mode tiene que ser "on" u "off", no true'
  const invalid = [on[0], `- La config de Jira no se puede leer (${detail}): hasta corregirla rige lo mismo que con \`jira_approval\` en \`on\`.`, ...on.slice(1)]
  for (const wd of [true, false]) {
    const texts = [renderBootstrap(SENTINEL, wd, 'on'), renderBootstrap(SENTINEL, wd, 'invalid', detail)]
    assert.deepEqual(texts[0].split('\n'), on)
    assert.deepEqual(texts[1].split('\n'), invalid)
    for (const line of texts.flatMap((t) => t.split('\n'))) {
      assert.ok(!line.includes('--role implement') && !line.includes('sin permiso previo'), line)
      assert.ok(!line.includes('inline') || line.includes('la exploración va inline'), line)
    }
  }
})

test('el bootstrap, con Jira y sin Jira, pide buscar antecedentes con recall y dice cuándo', () => {
  for (const text of [renderBootstrap(), renderBootstrap(undefined, undefined, 'on')]) {
    const line = text.split('\n').find((value) => value.includes('./bin/sdd-ai recall "<tema>"'))
    assert.ok(line)
    for (const word of ['Engram', 'vault', '`.plans/`', 'Git', 'por qué se decidió', 'rediseñar', 'repetir una investigación', 'arrancar un flujo', 'motivo que no está escrito']) {
      assert.ok(line.includes(word), word)
    }
  }
})

test('el bootstrap, con Jira y sin Jira, dice que un flujo SDD se arranca con sdd start', () => {
  for (const text of [renderBootstrap(), renderBootstrap(undefined, undefined, 'on')]) {
    const line = text.split('\n').find((value) => value.includes('./bin/sdd-ai sdd start <id>'))
    assert.ok(line)
    for (const part of ['ensayo', 'config', 'familias', 'antecedentes', 'sin escribir nada', '--apply', 'crea `.plans/<id>/`', 'usuario confirmó']) {
      assert.ok(line.includes(part), part)
    }
  }
})
