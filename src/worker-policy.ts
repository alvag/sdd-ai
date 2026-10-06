/** Regla superior compartida; las comprobaciones con Claude pertenecen al conductor con red. */
export const WORKER_POLICY = `## Política de ejecución del delegado
No ejecutes \`claude\`, ni directamente ni mediante scripts que lo lanzan: \`npm run test:mods\`, la preparación de las declaraciones del motor y la recuperación del rollout.
Si una comprobación necesaria exige Claude, infórmala como pendiente para el conductor y no la ejecutes.`

/** Anteponer una vez sin alterar el material congelado del encargo. */
export function withWorkerPolicy(prompt: string): string {
  return prompt.startsWith(WORKER_POLICY) ? prompt : `${WORKER_POLICY}\n\n${prompt}`
}
