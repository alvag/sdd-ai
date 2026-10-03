import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { runBin } from './helpers.ts'
import { createRun, newRunId, writeJsonAtomic } from '../src/runs.ts'
import { committable, draft, registry, success } from './sdd-commit-fixture.ts'

test('prune preserves an old cited final review recognized by status and commit', () => {
  const { s, reviewId } = committable()
  assert.ok(registry(s).reviews.includes(reviewId))
  const control = newRunId(); const controlDir = createRun(s.repo, control)
  writeJsonAtomic(join(controlDir, 'request.json'), { role: 'explore' })
  writeJsonAtomic(join(controlDir, 'status.json'), { state: 'done' })
  const date = new Date(Date.now() - 40 * 86400_000)
  const age = (path: string) => {
    if (lstatSync(path).isDirectory()) for (const child of readdirSync(path)) age(join(path,child))
    utimesSync(path,date,date)
  }
  const reviewDir = join(s.repo,'.sdd-ai/runs',reviewId!)
  age(reviewDir); age(controlDir)
  const preview = success(runBin(s,['prune']))
  assert.ok(preview.kept.some((k: Record<string,any>) => k.id === reviewId && k.reason === 'cited'))
  success(runBin(s,['prune','--apply','--digest',preview.digest]))
  assert.equal(existsSync(reviewDir),true); assert.equal(existsSync(controlDir),false)
  assert.equal(success(runBin(s,['sdd','status','f'])).next.command,'./bin/sdd-ai sdd commit f --subject "<asunto>"')
  assert.equal(success(draft(s)).review.id,reviewId)
})
