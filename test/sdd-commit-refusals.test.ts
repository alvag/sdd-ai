import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { approveFlowGates } from './helpers.ts'
import {
  VERIFIED, FOREIGN_DIGEST, file, text, put, planPath, registry, writeRegistry, reviewPath, json, success, draft,
  refused, committable,
} from './sdd-commit-fixture.ts'

test('sdd commit se niega sin tocar nada fuera de review_and_commit, con el recibo vencido, con contrato en prosa, sin revisión convergida y vigente del candidato entero, con una restauración pendiente o con un writer o un verify en vuelo', () => {
  const a = committable()
  const digest = success(draft(a.s)).digest
  const original = text(a.s, planPath)
  put(a.s, planPath, original.replace('status: verified', 'status: implementing'))
  refused(a.s, 'step_not_commit', digest)
  put(a.s, planPath, original)
  put(a.s, 'src/a.ts', 'export const f = () => 3\n')
  refused(a.s, 'step_not_commit', digest)
  put(a.s, 'src/a.ts', VERIFIED)
  put(a.s, planPath, original.slice(0, original.indexOf('## Verification')) + '## Verification\n\nPruebas manuales.\n')
  approveFlowGates(a.s.repo)
  refused(a.s, 'contract_prose', digest)
  const b = committable({ review: false })
  refused(b.s, 'review_missing', FOREIGN_DIGEST)
  const c = committable()
  const requestPath = reviewPath(c.reviewId!, 'request')
  const request = json(c.s, requestPath)
  for (const mutate of [
    (r: any) => { delete r.flow },
    (r: any) => { delete r.selection.untracked },
    (r: any) => { r.selection.head = 'HEAD' },
    (r: any) => { r.selection.base = 'HEAD'; r.selection.untracked = false },
    (r: any) => { r.selection.context = ['missing-context.md'] },
  ]) {
    const changed = structuredClone(request); mutate(changed)
    put(c.s, requestPath, JSON.stringify(changed))
    refused(c.s, 'review_missing', digest)
  }
  put(c.s, requestPath, JSON.stringify(request))
  const ledgerPath = reviewPath(c.reviewId!, 'ledger')
  const ledger = json(c.s, ledgerPath)
  for (const state of ['abierto', 'aceptado', 'rechazado', 'en-disputa']) {
    put(c.s, ledgerPath, JSON.stringify({ ...ledger, entries: [{ id: 'F-1', state, opened_round: 1, seen_round: 1 }] }))
    refused(c.s, 'review_missing', digest)
  }
  put(c.s, ledgerPath, JSON.stringify(ledger))
  const statusPath = reviewPath(c.reviewId!, 'status')
  const status = json(c.s, statusPath)
  put(c.s, statusPath, JSON.stringify({ ...status, state: 'running' }))
  refused(c.s, 'review_missing', digest)
  put(c.s, statusPath, JSON.stringify(status))
  put(c.s, `.sdd-ai/runs/${c.reviewId}/review.lock`, 'ocupado')
  refused(c.s, 'review_missing', digest)
  rmSync(file(c.s, `.sdd-ai/runs/${c.reviewId}/review.lock`))
  put(c.s, '.git/sdd-ai/verify/restore-intent.json', JSON.stringify({ receipt: 'pending', checkout: c.s.repo,
    owner_pid: process.pid, owner_lstart: null, paths: [] }))
  refused(c.s, 'restore_pending', digest)
  rmSync(file(c.s, '.git/sdd-ai/verify/restore-intent.json'))
  for (const kind of ['verify', undefined]) {
    put(c.s, '.git/sdd-ai/writer.lock', JSON.stringify({ id: 'busy', pid: process.pid, lstart: null, gitDir: file(c.s, '.git'), kind }))
    refused(c.s, 'writer_open', digest)
    rmSync(file(c.s, '.git/sdd-ai/writer.lock'))
  }
  const active = '20261001-0001-aaaa'
  const r = registry(c.s)
  r.last_run = { id: active, step: 'implement' }
  writeRegistry(c.s, r)
  put(c.s, `.sdd-ai/runs/${active}/status.json`, JSON.stringify({ state: 'running' }))
  refused(c.s, 'writer_open', digest)
  const e = committable()
  put(e.s, '.sdd-ai/config.yml', text(e.s, '.sdd-ai/config.yml') + 'jira_approval:\n  mode: "on"\n')
  put(e.s, '.plans/f/handoff.md', text(e.s, '.plans/f/handoff.md').replace('---\n\n# Handoff', 'gate_status: awaiting\n---\n\n# Handoff'))
  refused(e.s, 'step_not_commit', FOREIGN_DIGEST)
})
