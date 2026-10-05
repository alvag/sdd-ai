// Nombres de ejemplo de `.sdd-ai/projection/live/`. La prueba del mod los interpreta con su copia de la expresión de
// las observaciones, y una prueba del binario los contrasta con las expresiones del contrato: si la copia se aparta
// del contrato, falla alguna de las dos. Este archivo no importa nada, para que lo lean las dos.

export const BOOT = '11111111-1111-1111-1111-111111111111'
export const OTHER_BOOT = '22222222-2222-2222-2222-222222222222'
const HEX = '0123456789abcdef'.repeat(2)

/** Observaciones válidas, con lo que dice su nombre. */
export const observationExamples: { name: string; m0: string; boot: string; pid: number }[] = [
  { name: `obs-00000000000000000001-${BOOT}-1-${'a'.repeat(32)}.json`, m0: '00000000000000000001', boot: BOOT, pid: 1 },
  { name: `obs-00000000099000000000-${BOOT}-4242-${HEX}.json`, m0: '00000000099000000000', boot: BOOT, pid: 4242 },
  { name: `obs-99999999999999999999-${OTHER_BOOT}-7-${'f'.repeat(32)}.json`, m0: '99999999999999999999', boot: OTHER_BOOT, pid: 7 },
  { name: `obs-00000000099000000000-${OTHER_BOOT}-007-${'e'.repeat(32)}.json`, m0: '00000000099000000000', boot: OTHER_BOOT, pid: 7 },
]

/** Temporales del publicador: nunca son observaciones. */
export const temporaryExamples: string[] = [
  `tmp-00000000099000000000-${BOOT}-1-${'b'.repeat(32)}`,
  `tmp-00000000000000000001-${BOOT}-1-${'c'.repeat(32)}`,
]

/** Reservas de un publicador que está leyendo: nunca son observaciones, pero cuentan en el listado. */
export const claimExamples: string[] = [
  `claim-00000000099000000000-${BOOT}-1-${'c'.repeat(32)}`,
  `claim-99999999999999999999-${OTHER_BOOT}-7-${HEX}`,
]

/** Ni observaciones, ni temporales, ni reservas: lo apartado, lo ajeno y los nombres casi válidos. */
export const foreignExamples: string[] = [
  `junk-${'d'.repeat(32)}`,
  `stale-${'d'.repeat(32)}`,
  'README',
  `tmp-00000000099000000000-${BOOT}-1-${'b'.repeat(32)}.json`,
  `claim-00000000099000000000-${BOOT}-1-${'c'.repeat(32)}.json`,
  `claim-0000000099000000000-${BOOT}-1-${'c'.repeat(32)}`,
  `obs-0000000000000000001-${BOOT}-1-${'a'.repeat(32)}.json`,
  `obs-000000000000000000001-${BOOT}-1-${'a'.repeat(32)}.json`,
  `obs-00000000000000000001-${BOOT.toUpperCase().replace(/1/g, 'A')}-1-${'a'.repeat(32)}.json`,
  `obs-00000000000000000001-${BOOT}-1-${'A'.repeat(32)}.json`,
  `obs-00000000000000000001-${BOOT}-1-${'a'.repeat(31)}.json`,
  `obs-00000000000000000001-${BOOT}--${'a'.repeat(32)}.json`,
  `obs-00000000000000000001-${BOOT}-x1-${'a'.repeat(32)}.json`,
  `obs-00000000000000000001-${BOOT}-1-${'a'.repeat(32)}`,
  `obs-00000000000000000001-${BOOT}-1-${'a'.repeat(32)}.json.tmp`,
  `obs-00000000000000000001-${BOOT}-1-${'a'.repeat(32)}.json\n`,
  ` obs-00000000000000000001-${BOOT}-1-${'a'.repeat(32)}.json`,
  `OBS-00000000000000000001-${BOOT}-1-${'a'.repeat(32)}.json`,
]
