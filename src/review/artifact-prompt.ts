import type { ArtifactKind } from './artifact.ts'
import type { Candidate } from './candidate.ts'
import type { LedgerEntry, RoundPlan } from './ledger.ts'
import { EVIDENCE_ONLY, access, block, previous } from './prompt.ts'

const KIND_NAME: Record<ArtifactKind, string> = { spec: 'una spec', plan: 'un plan', tasks: 'unas tasks' }

// Las dimensiones por tipo y los encargos de forma son los de la revisión de artefactos de sdd-flow.
const SCOPE = `SCOPE — ¿sobra algo? Lo que el artefacto manda hacer y ningún criterio de arriba reclama: alcance, abstracciones de un solo uso, configurabilidad, validaciones y manejo de errores que nadie pidió, o comentarios que repiten lo que ya se dice.`

const SHAPE = `Y además, en QUALITY:
- Dry run: no lo revises, ejecútalo. Empieza a hacer lo que el artefacto ordena y reporta dónde te trabas por algo que no decidió.
- Implementación más floja: ¿cuál es la implementación más floja que satisface todo lo que pide y no resuelve el problema? Nómbrala concretamente.
- Malentendido de buena fe: ¿qué malentendería quien lo ejecute de buena fe, sin haber estado en la conversación que lo produjo?
- Ausencia no pedida: ¿qué falta que nadie pidió? Despliegue, migración, interacción con lo que ya existe.`

// Lo que el revisor no puede comprobar con el material no se da por bueno ni por falso: se declara.
const CODE_CLAIMS = `- Una afirmación sobre el código (una ruta, una función, un comportamiento) se comprueba solo contra los bloques CONTEXTO. Si lo que viajó no alcanza para comprobarla —porque ese código no está, o está solo una parte, como una función sin sus llamadores—, no la des por buena ni por falsa: decláralo en \`unverifiable\` con su línea del artefacto.`

export const ARTIFACT_MANDATES: Record<ArtifactKind, { spec: string; quality: string }> = {
  spec: {
    spec: 'SPEC — ¿la spec cumple el pedido del INSUMO request? Un criterio que el pedido no sostiene, algo del pedido que ningún criterio cubre, o una decisión del pedido que la spec contradice.',
    quality: `QUALITY — recorre estas dimensiones:
- Cobertura del objetivo: cada resultado declarado tiene al menos un AC.
- Observabilidad: cada AC tiene un resultado distinguible de su negación.
- Consistencia de alcance: ningún AC exige algo excluido ni contradice a otro.
- Bordes del dominio: las precondiciones, los límites y los fallos tienen un comportamiento decidido.
- Autoridad y actores: cada decisión o escritura tiene responsable y gate.
- Adopción: los estados preexistentes o las corridas vivas tienen un resultado definido.`,
  },
  plan: {
    spec: 'SPEC — ¿el plan cumple la spec del INSUMO spec? Un AC sin un mecanismo que lo cumpla, un mecanismo que contradice la spec, o una decisión de la spec que el plan ignora.',
    quality: `QUALITY — recorre estas dimensiones:
- Satisfacción AC→mecanismo: cada AC tiene un mecanismo causal concreto.
- Reúso: ninguna pieza existente aplicable se reinventa.
- Orden y dependencias: cada paso consume artefactos ya producidos.
- Contratos entre componentes: productor y consumidor coinciden en forma y autoridad.
- Efectos colaterales: las mutaciones, la compatibilidad y el rollback están tratados.
- Verificación: cada prueba distingue el cumplimiento del incumplimiento.
${CODE_CLAIMS}`,
  },
  tasks: {
    spec: 'SPEC — ¿las tasks cumplen la spec y el plan de los INSUMOS spec y plan? Un AC sin task, una task que contradice el plan, o una decisión del plan que ninguna task ejecuta.',
    quality: `QUALITY — recorre estas dimensiones:
- Cobertura bidireccional AC↔task: sin huérfanos en ningún sentido.
- Autosuficiencia: cada task tiene sus rutas, sus entradas y sus decisiones.
- Atomicidad: ninguna task mezcla cambios separables con finalizaciones distintas.
- Orden ejecutable: los productos van antes que sus consumidores.
- Interfaces Produce/Consume: los nombres y las firmas coinciden.
- Evidencia: cada task referencia una verificación capaz de probar su resultado.
${CODE_CLAIMS}`,
  },
}

function kindOf(c: Candidate): ArtifactKind {
  if (!c.subject) throw new Error('el candidato no es un artefacto')
  return c.subject.kind
}

const artifactPath = (c: Candidate) => c.files[0].path

/** Las líneas de un texto con su número a la izquierda de `│`, en un ancho fijo. */
function numberedText(text: string): string {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  if (text === '') return ''
  const width = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(width)}│${l}`).join('\n')
}

const lineCount = (n: number) => `${n} ${n === 1 ? 'línea' : 'líneas'}`

/**
 * El material de un artefacto: el manifiesto y un bloque numerado para el artefacto, cada insumo y cada
 * archivo de contexto. Sale de los bytes que se validaron al congelar, no de otra lectura del árbol.
 */
export function renderArtifactMaterial(c: Candidate, bytes: Map<string, Buffer>): string {
  const h = c.hash
  const kind = kindOf(c)
  const art = c.files[0]
  const text = (path: string) => bytes.get(path)?.toString('utf8') ?? ''
  const inputs = c.context.filter((x) => x.role)
  const context = c.context.filter((x) => !x.role)
  const manifest = [
    `Tipo: ${kind}`,
    `${art.status} ${art.path} — ${lineCount(art.lines)}; visibles 1-${art.lines}`,
    'Insumos:',
    ...inputs.map((x) => `- ${x.role} ${x.path} (${lineCount(x.lines)})`),
    'Contexto:',
    ...(context.length === 0 ? ['No hay archivos de contexto.'] : context.map((x) => `- ${x.path} (${lineCount(x.lines)})`)),
  ].join('\n')
  return [
    block('MANIFIESTO', h, manifest),
    block(`ARTEFACTO ${kind} ${art.path}`, h, numberedText(text(art.path))),
    ...inputs.map((x) => block(`INSUMO ${x.role} ${x.path}`, h, numberedText(text(x.path)))),
    ...context.map((x) => block(`CONTEXTO ${x.path}`, h, numberedText(text(x.path)))),
  ].join('\n\n')
}

const CITING = `## Cómo citar
- Cada hallazgo lleva una \`location\`: la ruta exacta del artefacto, de un insumo o de un contexto, seguida de \`:línea\` o \`:inicio-fin\`.
- Cada línea de los bloques ARTEFACTO, INSUMO y CONTEXTO lleva a la izquierda de \`│\` su número. Cita ese número; puedes citar cualquier línea de esos bloques.
- Una cita a una ruta o a una línea que no ves rechaza la respuesta entera.`

const OWNER = `## De qué archivo es cada hallazgo
- \`of\` es la ruta del archivo que tiene el defecto: el artefacto, o un insumo o un contexto si el defecto es de ese archivo.
- Un defecto del artefacto puede citar su evidencia en otro archivo: si el plan no cubre un AC, \`of\` es el plan y \`location\` puede ser la línea de ese AC en la spec.
- Un defecto de un insumo o de un contexto se cita en ese mismo archivo. Se le informa a la persona y no cuenta para el resultado de esta revisión.`

const GRAVITY = `## Gravedad
- \`severity\`: BLOCKER o CRITICAL para lo que hay que corregir antes de aprobar el artefacto, WARNING para lo que conviene corregir, SUGGESTION para una mejora opcional.
- Todo BLOCKER o CRITICAL declara \`evidence\`: \`deterministic\` si las líneas citadas muestran el defecto sin suponer nada fuera del material, o \`inferential\` si el defecto se deduce razonando.`

const UNVERIFIABLE = `- \`unverifiable\` lista las afirmaciones del artefacto que no pudiste comprobar con el material, cada una con su \`location\` en el artefacto. Si no hay ninguna, es []. Va siempre: una respuesta sin \`unverifiable\` se rechaza.`

const findingSchema = (round: boolean) => `{
      "of": "<ruta del archivo que tiene el defecto>",
      "axis": "scope" | "spec" | "quality",
      "severity": "BLOCKER" | "CRITICAL" | "WARNING" | "SUGGESTION",
      "location": "ruta:línea" | "ruta:inicio-fin",
      "claim": "<qué está mal y por qué>",${round ? '\n      "cause": "+N" | "-N",' : ''}
      "evidence": "deterministic" | "inferential"
    }`

const UNVERIFIABLE_SCHEMA = `"unverifiable": [
    { "location": "ruta del artefacto:línea", "claim": "<qué afirmación no pudiste comprobar y qué faltó>" }
  ]`

const inspection = (c: Candidate) => `- \`candidate_hash\` es exactamente ${c.hash}.
- Si inspeccionaste el artefacto completo: \`inspection.status\` es "completed" e \`inspection.paths\` es exactamente ["${artifactPath(c)}"].
- Si no pudiste inspeccionarlo: \`inspection.status\` es "unavailable", \`inspection.paths\` es [] e \`inspection.reason\` explica por qué. No devuelvas un resultado limpio si no pudiste ver el artefacto.`

const inspectionSchema = (c: Candidate) => `"inspection": {
    "status": "completed" | "unavailable",
    "paths": ["${artifactPath(c)}"],
    "reason": "<solo con unavailable: por qué no pudiste inspeccionar>"
  }`

function axes(kind: ArtifactKind): string {
  const m = ARTIFACT_MANDATES[kind]
  return `## Qué revisar, en este orden
1. ${SCOPE}
2. ${m.spec}
3. ${m.quality}

${SHAPE}`
}

const header = (c: Candidate) =>
  `Eres un revisor aislado de artefactos de diseño. Revisas un artefacto congelado, ${KIND_NAME[kindOf(c)]}, junto con sus insumos de arriba y el contexto que lo acompaña.`

/** El prompt de la ronda 1 de un artefacto: su mandato por tipo, el esquema con `of` y `unverifiable`, y el material. */
export function renderArtifactPrompt(c: Candidate, material: string): string {
  const instructions = `${header(c)}

${access(c.hash)}

${axes(kindOf(c))}

${CITING}

${OWNER}

${GRAVITY}

## Respuesta
- Responde con un único objeto JSON que cumpla el esquema de abajo. No agregues otro objeto ni campos que el esquema no tenga.
${inspection(c)}
${UNVERIFIABLE}
- Escribe cada \`claim\` y \`reason\` en español.
- No hay campo de aprobación: el resultado sale de tus hallazgos. Sin hallazgos, \`findings\` es [].

Esquema:
{
  "candidate_hash": "<el hash exacto de arriba>",
  ${inspectionSchema(c)},
  "findings": [
    ${findingSchema(false)}
  ],
  ${UNVERIFIABLE_SCHEMA}
}`
  return `${instructions}\n\n${material}\n`
}

const spans = (r: Array<[number, number]>) => r.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))

/** Las líneas que cambiaron, con su número y su texto: `+N` del artefacto actual y `-N` de la versión anterior. */
function changes(plan: RoundPlan, path: string, before: string, after: string): string {
  if (plan.identical) return 'El artefacto no cambió respecto de la ronda anterior: no hay líneas nuevas que revisar.'
  const added = plan.changed[path]
  const now = after.split('\n')
  const old = before.split('\n')
  const out = [
    ...(added === undefined || added === 'binary' ? [] : spans(added).map((n) => `+${n}│${now[n - 1] ?? ''}`)),
    ...spans(plan.removed ?? []).map((n) => `-${n}│${old[n - 1] ?? ''}`),
  ]
  return out.length === 0 ? 'Ninguna línea del artefacto cambió respecto de la ronda anterior.' : out.join('\n')
}

/**
 * La ronda N de un artefacto: pasada dirigida sobre lo aceptado y lo rechazado, con el mismo mandato que la
 * ronda 1, y hallazgos nuevos solo como regresiones de la corrección, en cualquier línea y con su causa
 * en CAMBIOS.
 */
export function renderArtifactRoundPrompt(c: Candidate, material: string, plan: RoundPlan, entries: LedgerEntry[], cap: number,
  before: string, after: string): string {
  const h = c.hash
  const path = artifactPath(c)
  const pick = (kind: 'verify' | 'respond') => plan.targets.filter((t) => t.kind === kind)
    .map((t) => entries.find((e) => e.id === t.id))
    .filter((e): e is LedgerEntry => e !== undefined)
    .map((e) => ({ ...previous(e, kind === 'respond'), of: e.of ?? path }))
  const newFindings = plan.identical
    ? '- Como el artefacto no cambió, no se admite ningún hallazgo nuevo: `findings` es [].'
    : `- Un hallazgo nuevo solo se admite como regresión de la corrección, y es un defecto del artefacto: su \`of\` es ${path}. Su \`location\` puede estar en cualquier línea del artefacto, y su \`cause\` cita una línea de CAMBIOS: \`+N\` (una línea agregada o cambiada del artefacto actual) o \`-N\` (una línea borrada de la versión anterior). Una causa fuera de CAMBIOS, o un defecto de otro archivo, rechaza la respuesta entera.`
  const instructions = `${header(c)} Esta es la ronda ${plan.n} de ${cap} de la revisión: en una ronda anterior emitiste hallazgos; el conductor corrigió los que aceptó y rechazó otros con un motivo. Ahora revisas el artefacto corregido.

${access(h)}

${axes(kindOf(c))}

## Qué hacer en esta ronda
1. VERIFICAR — cada hallazgo de este bloque se aceptó y se corrigió. Contesta \`resolved\` si el artefacto actual ya no lo tiene, o \`unresolved\` si sigue ahí.
2. RESPONDER — cada hallazgo de este bloque se rechazó, con el motivo del conductor en \`reason\`. Contesta \`withdrawn\` si el motivo te convence, o \`maintained\` si el defecto sigue siendo real.
3. CAMBIOS — las líneas que cambiaron desde la ronda anterior: \`+N\` del artefacto actual y \`-N\` de la versión anterior. Revisa el artefacto entero buscando regresiones que haya introducido la corrección.

## Reglas
- Da exactamente una respuesta por cada ID de VERIFICAR y de RESPONDER: ni una de menos, ni una de más, ni un ID repetido. A un ID de VERIFICAR se le contesta "resolved" o "unresolved"; a uno de RESPONDER, "withdrawn" o "maintained".
- \`unresolved\` y \`maintained\` llevan \`evidence\`: una cita del material actual que muestra el defecto. Sin ella, la respuesta se rechaza.
- ${EVIDENCE_ONLY}
- En VERIFICAR y RESPONDER, la ubicación de un hallazgo anterior es de la ronda en que se emitió; puede que ya no coincida con el artefacto actual. Toda cita tuya es sobre el material actual.
${newFindings}
- No repitas como hallazgo nuevo uno que ya está en VERIFICAR o en RESPONDER.

${CITING}

${OWNER}

${GRAVITY}

## Respuesta
- Responde con un único objeto JSON que cumpla el esquema de abajo. No agregues otro objeto ni campos que el esquema no tenga.
${inspection(c)}
${UNVERIFIABLE}
- Escribe cada \`claim\`, \`note\` y \`reason\` en español.

Esquema:
{
  "candidate_hash": "<el hash exacto de arriba>",
  ${inspectionSchema(c)},
  "responses": [
    {
      "id": "<F-n de VERIFICAR o de RESPONDER>",
      "answer": "resolved" | "unresolved" | "withdrawn" | "maintained",
      "evidence": "<solo la cita: ruta:línea | ruta:inicio-fin; obligatoria con unresolved y maintained>",
      "note": "<opcional: por qué, en texto>"
    }
  ],
  "findings": [
    ${findingSchema(true)}
  ],
  ${UNVERIFIABLE_SCHEMA}
}`
  return [
    instructions,
    block('VERIFICAR', h, JSON.stringify(pick('verify'), null, 2)),
    block('RESPONDER', h, JSON.stringify(pick('respond'), null, 2)),
    block('CAMBIOS', h, changes(plan, path, before, after)),
    `${material}\n`,
  ].join('\n\n')
}
