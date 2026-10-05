import { expect, test } from 'claude-code/testing'
import { ageText, bandLine, bandTree, cutToWidth, displayWidth, ELLIPSIS, FIELD_LIMIT, sanitize, SEPARATOR } from '../hooks/band'
import type { TerminalElements } from '../hooks/render'
import { treeFits } from '../hooks/render'
import type { BandActivity, BandFlow, BandPresentation, BandProgress } from '../types'

const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

const flow = (overrides: Partial<BandFlow> = {}): BandFlow => ({ id: 'proyeccion-y-banda', step: 'implement', gate: null, source: 'flow', ...overrides })
const progress = (overrides: Partial<BandProgress> = {}): BandProgress => ({ phase: 'review', round: 2, launch: 1, done: 3, total: 5, reviewer: 'reliability', batch: 1, ...overrides })
const activity = (overrides: Partial<BandActivity> = {}): BandActivity => ({
  id: 'r1', role: 'review', state: 'running', open: 'running', uncertain: false, association: { kind: 'bound' }, progress: progress(), ...overrides,
})
const band = (overrides: Partial<Extract<BandPresentation, { kind: 'band' }>> = {}): BandPresentation => ({
  kind: 'band', flow: flow(), activity: activity(), incomplete: false, lastRead: false, ageMs: null, ...overrides,
})
const writer = (overrides: Partial<BandActivity> = {}): BandActivity => activity({ id: 'w1', role: 'writer', progress: null, ...overrides })

// El constructor de Text con la forma que entrega el motor: tipo, props e hijos.
const ui = { Text: (props: { children?: unknown }) => ({ type: 'Text', props: { ...props, children: undefined }, children: [props.children] }) } as unknown as TerminalElements

test('display width counts terminal columns and not UTF-16 length', () => {
  const cases: [string, number][] = [
    ['plain', 5],
    ['café', 4],
    // `e` y una tilde combinante: dos unidades UTF-16, una columna.
    ['cafe\u0301', 4],
    ['漢字', 4],
    ['한글', 4],
    ['ＡＢ', 4],
    ['🙂', 2],
    // Una familia unida con ZWJ: ocho unidades UTF-16, un solo emoji de dos columnas.
    ['👩\u200d👩\u200d👧', 2],
    ['🇦🇷', 2],
    ['❤', 1],
    ['❤\ufe0f', 2],
    ['a\u200bb', 2],
    ['', 0],
  ]
  for (const [text, width] of cases) expect(displayWidth(text), text).toBe(width)
  expect('漢字'.length).not.toBe(displayWidth('漢字'))
  expect('cafe\u0301'.length).not.toBe(displayWidth('cafe\u0301'))
  expect('👩\u200d👩\u200d👧'.length).not.toBe(displayWidth('👩\u200d👩\u200d👧'))
})

test('a cut keeps whole characters within the columns and ends with an ellipsis', () => {
  expect(cutToWidth('proyeccion', 20)).toBe('proyeccion')
  expect(cutToWidth('proyeccion', 10)).toBe('proyeccion')
  expect(cutToWidth('proyeccion', 9)).toBe('proyecci…')
  expect(cutToWidth('proyeccion', 1)).toBe(ELLIPSIS)
  expect(cutToWidth('proyeccion', 0)).toBe('')
  // Un carácter ancho que no entra entero no se parte: queda afuera.
  expect(cutToWidth('漢字漢字', 5)).toBe('漢字…')
  expect(cutToWidth('漢字漢字', 4)).toBe('漢…')
  // La tilde combinante viaja con su letra, y el emoji unido no se separa.
  expect(cutToWidth('cafe\u0301 cafe\u0301', 5)).toBe('cafe\u0301…')
  expect(cutToWidth('ae\u0301e\u0301x', 3)).toBe('ae\u0301…')
  expect(cutToWidth('👩\u200d👩\u200d👧👩\u200d👩\u200d👧', 3)).toBe('👩\u200d👩\u200d👧…')
  expect(cutToWidth('🇦🇷🇨🇱', 3)).toBe('🇦🇷…')
  for (const text of ['漢字の流れ', 'cafe\u0301 cafe\u0301', '👩\u200d👩\u200d👧x🇦🇷y', 'plain text']) {
    for (let width = 0; width <= displayWidth(text) + 1; width++) expect(displayWidth(cutToWidth(text, width))).toBeLessThanOrEqual(width)
  }
})

test('fields lose controls line breaks and direction overrides and are bounded before the line is built', () => {
  expect(sanitize('a\nb\r\nc\td\u0007e\u001b[31mf\u007fg\u0085h\u2028i')).toBe('a b c d e [31mf g h i')
  expect(sanitize('  leading   and\u00a0trailing  ')).toBe('leading and trailing')
  expect(sanitize('flujo\u202e-invertido\u2066x\u2069')).toBe('flujo-invertidox')
  expect(sanitize('mitad \ud800 suelta \udc00')).toBe('mitad \ufffd suelta \ufffd')
  expect(sanitize('🙂 entero')).toBe('🙂 entero')
  const long = 'x'.repeat(FIELD_LIMIT * 3)
  expect(Array.from(sanitize(long))).toHaveLength(FIELD_LIMIT)
  expect(sanitize(long).endsWith(ELLIPSIS)).toBe(true)
  // Lo que el refresco publica no lleva controles: la línea pasa los límites del motor aunque los traigan los datos.
  const dirty = band({ flow: flow({ id: 'demo\n\u001b[2Jborrado', step: 'imple\u0000ment', gate: 'spec\r' }), activity: activity({ progress: progress({ reviewer: 're\u0007viewer' }) }) })
  const line = bandLine(dirty, 200)
  expect(FORBIDDEN_CONTROL.test(line)).toBe(false)
  expect(line.includes('\n')).toBe(false)
  expect(line).toBe('demo [2Jborrado · paso imple ment (spec) · revisión · ronda 2 · re viewer lote 1 · 3/5')
})

test('the line says the bound flow its step and the selected activity', () => {
  const cases: [BandPresentation, string][] = [
    [band(), 'proyeccion-y-banda · paso implement · revisión · ronda 2 · reliability lote 1 · 3/5'],
    [band({ activity: activity({ progress: progress({ launch: 3, done: 1, total: 4, reviewer: null, batch: 2 }) }) }), 'proyeccion-y-banda · paso implement · revisión · ronda 2 (lanzamiento 3) · lote 2 · 1/4'],
    [band({ activity: activity({ progress: progress({ phase: 'refutation', round: 3, done: 0, total: 1, reviewer: null, batch: null }) }) }), 'proyeccion-y-banda · paso implement · refutación · ronda 3 · 0/1'],
    // Un formato anterior sin avance no recibe conteos.
    [band({ activity: activity({ progress: null }) }), 'proyeccion-y-banda · paso implement · revisión · en curso'],
    [band({ activity: activity({ progress: null, state: 'done', open: 'review_pending' }) }), 'proyeccion-y-banda · paso implement · revisión · hallazgos por decidir'],
    [band({ activity: writer() }), 'proyeccion-y-banda · paso implement · writer · en curso'],
    [band({ activity: writer({ state: 'cessation_uncertain', open: 'undelivered', uncertain: true }) }), 'proyeccion-y-banda · paso implement · writer · cese incierto'],
    [band({ activity: activity({ role: 'worker', progress: null, state: 'done', open: 'undelivered', association: { kind: 'flow', id: 'otro' } }) }), 'proyeccion-y-banda · paso implement · worker · sin entregar · de otro'],
    [band({ activity: activity({ role: 'native', progress: null, open: 'native_pending', association: { kind: 'none', reason: 'not_recorded' } }) }), 'proyeccion-y-banda · paso implement · nativa · despacho pendiente · sin flujo registrado'],
    [band({ activity: activity({ role: 'native', progress: null, open: 'native_unconfirmed', association: { kind: 'none', reason: 'association_conflict' } }) }), 'proyeccion-y-banda · paso implement · nativa · despacho sin confirmar · flujo en conflicto'],
    [band({ activity: activity({ role: null, progress: null, open: null, association: { kind: 'none', reason: 'association_unavailable' } }) }), 'proyeccion-y-banda · paso implement · corrida · flujo no disponible'],
    [band({ activity: null }), 'proyeccion-y-banda · paso implement'],
    [band({ flow: flow({ gate: 'spec', step: 'gate' }) }), 'proyeccion-y-banda · paso gate (spec) · revisión · ronda 2 · reliability lote 1 · 3/5'],
    [band({ flow: flow({ step: 'specify', source: 'binding' }), activity: null }), 'proyeccion-y-banda · paso specify según la liga'],
    [band({ flow: null, activity: writer({ association: { kind: 'flow', id: 'demo' } }) }), 'sin flujo ligado · writer · en curso · de demo'],
    [band({ incomplete: true, activity: null }), 'proyeccion-y-banda · paso implement · datos parciales'],
    [band({ lastRead: true, ageMs: 75_000 }), 'proyeccion-y-banda · paso implement · revisión · ronda 2 · reliability lote 1 · 3/5 · última lectura · observada hace 75 s'],
    [{ kind: 'empty', lastRead: false, ageMs: null }, 'sdd-ai: sin flujo ligado ni actividad en esta sesión'],
    [{ kind: 'empty', lastRead: true, ageMs: 61_000 }, 'sdd-ai: sin flujo ligado ni actividad en esta sesión · última lectura · observada hace 61 s'],
    [{ kind: 'unavailable', reason: 'incompatible_version' }, 'sdd-ai: no disponible · versión incompatible'],
    [{ kind: 'unavailable', reason: 'missing' }, 'sdd-ai: no disponible · sin proyección'],
    [{ kind: 'unavailable', reason: 'inventory_unavailable' }, 'sdd-ai: no disponible · la observación no permite saber la actividad'],
  ]
  for (const [presentation, line] of cases) expect(bandLine(presentation, 400)).toBe(line)
  // Cada motivo de indisponibilidad se distingue del estado vacío y de los demás.
  const reasons = ['missing', 'link', 'not_directory', 'directory', 'not_regular', 'too_large', 'flooded', 'unreadable', 'corrupt', 'incompatible_version', 'foreign_checkout', 'inventory_unavailable'] as const
  const lines = reasons.map((reason) => bandLine({ kind: 'unavailable', reason }, 400))
  expect(new Set(lines).size).toBe(reasons.length)
  expect(lines).not.toContain(bandLine({ kind: 'empty', lastRead: false, ageMs: null }, 400))
  expect(ageText(119_999)).toBe('observada hace 119 s')
  expect(ageText(120_000)).toBe('observada hace 2 min')
  expect(ageText(7_199_999)).toBe('observada hace 119 min')
  expect(ageText(7_200_000)).toBe('observada hace 2 h')
})

/**
 * Recorre todos los anchos, del que entra entero a uno, y comprueba el orden de acortamiento: una parte solo se
 * acorta cuando las anteriores ya no están, las partes fijas siguen enteras mientras entran solas, y por debajo la
 * línea se corta con elipsis. Nunca pasa del ancho.
 */
function walkWidths(presentation: BandPresentation, shortenable: string[], fixed: string[]) {
  const full = bandLine(presentation, 10_000)
  const fixedWidth = displayWidth(fixed.join(SEPARATOR))
  const intact = (line: string, part: string) => line.split(SEPARATOR).includes(part)
  const present = (line: string, part: string) => line.split(SEPARATOR).some((piece) => piece === part || (piece.endsWith(ELLIPSIS) && part.startsWith(piece.slice(0, -1).trimEnd()) && piece.length > 1))
  let previous = full
  const seen = new Set<string>()
  for (let columns = displayWidth(full); columns >= 1; columns--) {
    const line = bandLine(presentation, columns)
    expect(displayWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns)
    expect(line.includes('\n')).toBe(false)
    if (columns >= fixedWidth) {
      shortenable.forEach((part, index) => {
        if (intact(line, part)) return
        seen.add(part)
        for (const earlier of shortenable.slice(0, index)) expect(present(line, earlier), `${columns}: ${earlier} sigue en ${line}`).toBe(false)
      })
      for (const part of fixed) expect(intact(line, part), `${columns}: falta ${part} en ${line}`).toBe(true)
    } else {
      // Por debajo de las partes fijas solo queda el corte final: ninguna parte acortable sigue en la línea.
      expect(line.endsWith(ELLIPSIS), `${columns}: ${line}`).toBe(true)
      expect(fixed.join(SEPARATOR).startsWith(line.slice(0, -1).trimEnd())).toBe(true)
    }
    previous = line
  }
  // A un ancho justo de las fijas, la línea es exactamente ellas.
  expect(bandLine(presentation, fixedWidth)).toBe(fixed.join(SEPARATOR))
  expect(previous).toBe(ELLIPSIS)
  expect([...seen]).toEqual(shortenable)
}

test('a review line shortens flow association reviewer and batch and round in that order', () => {
  const presentation = band({
    flow: flow({ id: 'flujo-ligado-con-un-nombre-largo' }), lastRead: true, ageMs: 75_000,
    activity: activity({ association: { kind: 'flow', id: 'otro-flujo-asociado' }, progress: progress({ round: 3, launch: 2, done: 3, total: 7, reviewer: 'reliability', batch: 4 }) }),
  })
  expect(bandLine(presentation, 10_000)).toBe('flujo-ligado-con-un-nombre-largo · paso implement · revisión · de otro-flujo-asociado · ronda 3 (lanzamiento 2) · reliability lote 4 · 3/7 · última lectura · observada hace 75 s')
  walkWidths(presentation,
    ['flujo-ligado-con-un-nombre-largo', 'de otro-flujo-asociado', 'reliability lote 4', 'ronda 3 (lanzamiento 2)'],
    ['paso implement', 'revisión', '3/7', 'última lectura', 'observada hace 75 s'])
  // El nombre del flujo se acorta antes de quitarse.
  expect(bandLine(presentation, displayWidth(bandLine(presentation, 10_000)) - 10)).toBe('flujo-ligado-con-un-n… · paso implement · revisión · de otro-flujo-asociado · ronda 3 (lanzamiento 2) · reliability lote 4 · 3/7 · última lectura · observada hace 75 s')
})

test('a writer keeps its mark and its uncertain cessation while the rest is shortened', () => {
  const presentation = band({
    flow: flow({ id: '漢字の流れ-cafe\u0301' }), ageMs: 3_600_000,
    activity: writer({ state: 'cessation_uncertain', open: 'undelivered', uncertain: true, association: { kind: 'flow', id: '👩\u200d👩\u200d👧-otro' } }),
  })
  expect(bandLine(presentation, 10_000)).toBe('漢字の流れ-cafe\u0301 · paso implement · writer · cese incierto · de 👩\u200d👩\u200d👧-otro · observada hace 60 min')
  walkWidths(presentation, ['漢字の流れ-cafe\u0301', 'de 👩\u200d👩\u200d👧-otro'], ['paso implement', 'writer', 'cese incierto', 'observada hace 60 min'])
  // El nombre ancho se corta por columnas, sin partir un carácter: si el último no entra entero, sobra una columna.
  const full = displayWidth(bandLine(presentation, 10_000))
  expect(bandLine(presentation, full - 3)).toBe('漢字の流れ-… · paso implement · writer · cese incierto · de 👩\u200d👩\u200d👧-otro · observada hace 60 min')
  const narrower = bandLine(presentation, full - 5)
  expect(narrower).toBe('漢字の流… · paso implement · writer · cese incierto · de 👩\u200d👩\u200d👧-otro · observada hace 60 min')
  expect(displayWidth(narrower)).toBe(full - 6)
})

test('the tree is one line within the engine limits and yields without columns', () => {
  const tree = bandTree(ui, band(), 120)
  expect(tree).toEqual({ type: 'Text', props: { wrap: 'truncate-end', children: undefined }, children: ['proyeccion-y-banda · paso implement · revisión · ronda 2 · reliability lote 1 · 3/5'] })
  expect(bandTree(ui, band(), 0)).toBeNull()
  expect(bandTree(ui, band(), 1)).toEqual({ type: 'Text', props: { wrap: 'truncate-end', children: undefined }, children: [ELLIPSIS] })
  // Datos enormes y una terminal enorme: los textos se limitan antes de armar el árbol, que el motor aceptaría.
  const huge = 'y'.repeat(20_000)
  const inflated = band({ flow: flow({ id: huge, step: huge, gate: huge }), activity: activity({ association: { kind: 'flow', id: huge }, progress: progress({ reviewer: huge }) }) })
  const wide = bandTree(ui, inflated, 100_000)
  expect(wide).not.toBeNull()
  if (wide !== null) {
    expect(treeFits(wide)).toBe(true)
    const [text] = (wide as unknown as { children: string[] }).children
    expect((text ?? '').length).toBeLessThan(10_000)
  }
})
