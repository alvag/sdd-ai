import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observedProgress } from '../src/review/progress.ts'

const record = (key: string, launch: number) => ({ key, reviewer: 'base', batch: 1, launch, state: 'done', admitted: `${key}.json`,
  prompt_sha256: 'sha256:x', model_effective: null, tool_events: [] })

/** Los archivos de una revisión terminada en su segundo lanzamiento, con `kept` tal como lo dejó el argv. */
function files(kept: unknown): (name: string) => Record<string, unknown> | null {
  const argv: Record<string, unknown> = { jobs: [{ key: 'risk-b1', reviewer: 'risk', batch: 1, paths: [], prompt: '' }] }
  if (kept !== undefined) argv.kept = kept
  const disk: Record<string, Record<string, unknown>> = {
    'argv-l2.json': argv,
    'rounds.json': { rounds: [{ n: 1, launch: 2, jobs: [record('risk-b1', 2)] }] },
  }
  return (name) => disk[name] ?? null
}
const status = { state: 'done' as const, round: 1, launch: 2 }

test('kept jobs absent from the argv count as none and present but malformed leave progress unknown', () => {
  const none = observedProgress(status, files(undefined))
  assert.deepEqual(none?.retained, [])
  assert.deepEqual(none?.completed.map((job) => job.key), ['risk-b1'])
  const kept = observedProgress(status, files([record('base-b1', 1)]))
  assert.deepEqual(kept?.retained.map((job) => [job.key, job.launch, job.admission]), [['base-b1', 1, 'admitted']])
  // Un `kept` que no es una lista no se lee como «nada conservado»: el avance queda desconocido.
  for (const malformed of [null, 'base-b1', { key: 'base-b1' }, 3]) assert.equal(observedProgress(status, files(malformed)), null, JSON.stringify(malformed))
})
