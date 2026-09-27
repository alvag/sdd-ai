import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, openRuns, runKey } from '../src/open-runs.ts'
import { createRun, setStatus, writeJsonAtomic } from '../src/runs.ts'
import type { Status } from '../src/types.ts'

const root = () => mkdtempSync(join(tmpdir(), 'sdd-ai-open-'))

/** Una corrida con su `request.json` y su estado; `session: null` la deja sin dueño. */
function makeRun(r: string, id: string, status: Status, o: { session?: string | null; review?: boolean } = {}): string {
  const dir = createRun(r, id)
  const request: Record<string, unknown> = { conductor: { family: 'claude' }, role: 'explore' }
  if (o.session !== null) request.session = o.session ?? 's1'
  if (o.review) request.kind = 'review'
  writeJsonAtomic(join(dir, 'request.json'), request)
  writeFileSync(join(dir, 'prompt.md'), 'Encargo.\n')
  setStatus(dir, status)
  return dir
}

const delivered = (dir: string, s: Status) => writeJsonAtomic(join(dir, 'delivered.json'), { round: s.round ?? null, launch: s.launch ?? null })
const native = (dir: string) => writeJsonAtomic(join(dir, 'native.json'), { agent: 'sdd-ai-explore', family: 'claude', role: 'explore' })

test('openRuns clasifica las cinco formas de corrida abierta', () => {
  const r = root()
  makeRun(r, '20260101-0001-aaaa', { state: 'running' })
  makeRun(r, '20260101-0002-aaaa', { state: 'done' })
  native(makeRun(r, '20260101-0003-aaaa', { state: 'delegated' }))
  const unconfirmed = makeRun(r, '20260101-0004-aaaa', { state: 'delegated' })
  native(unconfirmed)
  writeJsonAtomic(join(unconfirmed, 'launch.json'), { tool_use_id: 'tu-1', attempt: 0 })
  const reviewed: Status = { state: 'done', round: 2, launch: 1 }
  const review = makeRun(r, '20260101-0005-aaaa', reviewed, { review: true })
  delivered(review, reviewed)
  writeJsonAtomic(join(review, 'ledger.json'), {
    completed: 2, next_id: 3, entries: [
      { id: 'F-1', round: 1, state: 'en-disputa', responses: [] },
      { id: 'F-2', round: 1, state: 'resuelto', responses: [] },
    ],
  })

  // Los que no están abiertos.
  const launched = makeRun(r, '20260101-0006-aaaa', { state: 'delegated' })
  native(launched)
  writeJsonAtomic(join(launched, 'launched.json'), { tool_use_id: 'tu-2' })
  delivered(makeRun(r, '20260101-0007-aaaa', { state: 'done' }), { state: 'done' })
  makeRun(r, '20260101-0008-aaaa', { state: 'running' }, { session: null })
  writeFileSync(join(makeRun(r, '20260101-0009-aaaa', { state: 'running' }), 'status.json'), '{"state":')

  const open = openRuns(r)
  assert.deepEqual(open.map((o) => [o.id, o.kind, o.open]), [
    ['20260101-0001-aaaa', 'worker', 'running'],
    ['20260101-0002-aaaa', 'worker', 'undelivered'],
    ['20260101-0003-aaaa', 'native', 'native_pending'],
    ['20260101-0004-aaaa', 'native', 'native_unconfirmed'],
    ['20260101-0005-aaaa', 'review', 'review_pending'],
  ])
  const byId = new Map(open.map((o) => [o.id, o]))
  assert.equal(byId.get('20260101-0002-aaaa')?.next, './bin/sdd-ai wait 20260101-0002-aaaa')
  assert.match(byId.get('20260101-0003-aaaa')?.next ?? '', /sdd-ai-explore .*20260101-0003-aaaa\/prompt\.md.*cancel 20260101-0003-aaaa/)
  assert.match(byId.get('20260101-0004-aaaa')?.next ?? '', /preguntarle al usuario.*run --retry 20260101-0004-aaaa/)

  const pending = byId.get('20260101-0005-aaaa')
  assert.deepEqual([pending?.undecided, pending?.disputed, pending?.round, pending?.launch], [1, 1, 2, 1])
  assert.equal(pending?.next, './bin/sdd-ai review status 20260101-0005-aaaa')
  const line = describe(pending!)
  assert.match(line, /^20260101-0005-aaaa \(revisión, ronda 2\) /)
  assert.match(line, /1 hallazgo sin decidir, 1 en disputa/)
  assert.match(line, /las decide el usuario/)
  assert.equal(runKey(pending!), '20260101-0005-aaaa|review_pending|2|1|')
})

test('sin .sdd-ai/runs no hay corridas abiertas', () => {
  assert.deepEqual(openRuns(root()), [])
})
