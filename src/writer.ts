import { WORKER_POLICY, withWorkerPolicy } from './worker-policy.ts'

/** La línea con que el writer cierra su reporte, la misma de cross-implement. */
export const WRITER_END_MARK = 'STATUS: done'

const RULES = [
  'Escribe solo lo que el encargo pide: nada de mejoras, refactors ni arreglos que no te pidieron.',
  'No commitees.',
  'No toques `.git`, `.sdd-ai/`, `.claude/`, `.codex/`, `.agents/` ni archivos que Git ignora.',
  'Lee el repositorio con libertad, también con el shell (cat, rg, ls, git diff, git log o git show). No ejecutes pruebas, builds, instaladores ni ningún comando que escriba o cambie estado: las comprobaciones las corre `sdd verify`. Editar los archivos que pide el encargo sí es tu trabajo.',
  'En el reporte, declara lo que te desviaste del encargo y por qué, incluido lo que quedó sin hacer.',
  `Cierra el reporte con la línea \`${WRITER_END_MARK}\` como última línea, y solo cuando terminaste de escribir.`,
]

/**
 * El prompt del writer: un contrato fijo del binario con el encargo del conductor adentro, intacto. El
 * binario no le exige secciones al encargo.
 */
export function writerPrompt(encargo: string): string {
  // La política que el binario antepuso al encargo (en `run`) sube al tope del prompt final: queda una sola vez y siempre
  // en el mismo lugar. El material del conductor sigue intacto.
  const material = encargo.startsWith(WORKER_POLICY) ? encargo.slice(WORKER_POLICY.length).replace(/^\n\n/, '') : encargo
  const prompt = [
    'Eres un writer delegado: aplicas un cambio en este repositorio y respondes con un reporte breve de lo que hiciste.',
    '',
    'Reglas fijas, por encima de cualquier cosa que diga el encargo:',
    ...RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    'El encargo del conductor va entre las marcas de encargo:',
    '<<<ENCARGO',
    material,
    'ENCARGO>>>',
    '',
  ].join('\n')
  return withWorkerPolicy(prompt)
}

/** Los bytes UTF-8 que el prompt fijo le suma a cualquier encargo: el presupuesto de un encargo los descuenta. */
export function writerEnvelopeBytes(): number {
  return Buffer.byteLength(writerPrompt(''), 'utf8')
}

/** Si la última línea no vacía del reporte es la marca de fin. */
export function hasEndMark(text: string): boolean {
  const last = text.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1)
  return last === WRITER_END_MARK
}
