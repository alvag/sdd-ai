import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBin } from './helpers.ts'
import { committable, draft, json, put, registry, reviewPath, success, text, writeRegistry } from './sdd-commit-fixture.ts'

test('citations never approve partial nonconverged foreign-base or stale reviews', () => {
  const { s, reviewId } = committable()
  const approvals = text(s,'.plans/f/sdd-ai-approvals.json')
  writeRegistry(s,{ ...registry(s),reviews: [reviewId] })
  const requestPath = reviewPath(reviewId!,'request'); const req = json(s,requestPath)
  const ledgerPath = reviewPath(reviewId!,'ledger'); const ledger = json(s,ledgerPath)
  const statusPath = reviewPath(reviewId!,'status'); const status = json(s,statusPath)
  const candidatePath = reviewPath(reviewId!,'candidate'); const candidate = json(s,candidatePath)
  const variants = [
    [statusPath,{ ...status,state: 'running' }],
    [ledgerPath,{ ...ledger,entries: [{ id: 'F-1',state: 'abierto',opened_round: 1,seen_round: 1 }] }],
    // Parcial: la misma base, sin cubrir el árbol entero.
    [requestPath,{ ...req,selection: { ...req.selection,untracked: false } }],
    // Otra base: cubre el árbol entero, pero congelado contra otro commit.
    [candidatePath,{ ...candidate,base_sha: '0'.repeat(40) }],
    [requestPath,{ ...req,selection: { ...req.selection,context: ['missing-context.md'] } }],
    [requestPath,{ ...req,selection: { artifact: 'src/a.ts',kind: 'plan',inputs: [],context: [] } }],
  ] as Array<[string,unknown]>
  for (const [path,value] of variants) {
    const original = text(s,path)
    put(s,path,JSON.stringify(value))
    assert.equal(draft(s).out.code,'review_missing')
    assert.match(success(runBin(s,['sdd','status','f'])).next.command,/review start/)
    assert.equal(text(s,'.plans/f/sdd-ai-approvals.json'),approvals)
    put(s,path,original)
  }
})
