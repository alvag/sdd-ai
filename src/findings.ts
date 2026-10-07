/** Canal de reporte puro; el conductor decide pertinencia, identidad y tramitación. */
export interface FindingReport {
  problem: string
  location: string | null
  expected: string | null
  observed: string | null
  evidence: string[]
  impact: string | null
  moment: string | null
  stage: string | null
  context: { commit: string | null; runtime: string | null; os: string | null; session: string | null; run: string | null; package: string | null }
}
export interface FindingRejection { index: number | null; raw: unknown; error: string }
export interface FindingsChannel {
  findings?: FindingReport[]
  findings_rejected?: FindingRejection[]
  findings_missing?: boolean
}

export const FINDINGS_TEMPLATE = `# Hallazgos — <id>

Registro local de defectos o riesgos sustentados del producto fuera del alcance aprobado.
La captura no autoriza corregir ni ampliar el alcance. Al cierre, el usuario decide la tramitación de cada hallazgo antes de archivar el flujo.
`
export const renderFindingsTemplate = (id: string): string => FINDINGS_TEMPLATE.replace('<id>', id)

export const FINDING_REPORT_SCHEMA = `{
  "problem": "<problema sustentado>",
  "location": "<ruta:línea, componente o comando>" | null,
  "expected": "<comportamiento esperado>" | null,
  "observed": "<comportamiento observado>" | null,
  "evidence": ["<reproducción, cita o extracto concreto>"],
  "impact": "<impacto>" | null,
  "moment": "<momento del descubrimiento>" | null,
  "stage": "<fase>" | null,
  "context": { "commit": "<commit>" | null, "runtime": "<runtime>" | null, "os": "<SO>" | null, "session": "<sesión>" | null, "run": "<corrida>" | null, "package": "<paquete>" | null }
}`

export function findingsInstructions(kind: 'phase' | 'run'): string {
  const shared = `Reporta solo defectos o riesgos sustentados del producto ajenos al alcance del encargo. No los corrijas ni escribas hallazgos.md ni respaldos del flujo: el conductor consolida. Incluye ubicación y evidencia concretas disponibles, esperado, observado e impacto; declara desconocidos como null. problem es texto no vacío y evidence una lista no vacía de textos concretos. No agregues H-n, decisiones, prioridad, host, asignación ni publicación. Omite credenciales, tokens, datos personales y rutas privadas innecesarias; usa redacciones, datos sintéticos y rutas relativas sin perder la reproducción y declara las limitaciones.`
  if (kind === 'phase') return `## Hallazgos fuera de alcance
${shared}
Incluye findings en el objeto JSON, también con preguntas bloqueantes o contexto faltante; usa [] si no hay hallazgos. Cada elemento tiene exactamente esta forma:
${FINDING_REPORT_SCHEMA}`
  return `## Hallazgos fuera de alcance
${shared}
En una respuesta libre, entrega un apartado «Hallazgos fuera de alcance» con los datos de cada reporte o declara explícitamente su ausencia. Si el encargo exige un único objeto JSON y su esquema admite findings, usa findings dentro del objeto con esta forma por elemento (o []):
${FINDING_REPORT_SCHEMA}
Ante un esquema cerrado sin findings, respeta el esquema sin añadir claves ni prosa, aunque queden hallazgos sin reportar.`
}
