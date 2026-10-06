import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WORKER_POLICY, withWorkerPolicy } from '../src/worker-policy.ts'
import { writerEnvelopeBytes, writerPrompt } from '../src/writer.ts'
import { renderPhasePrompt } from '../src/sdd/phase.ts'
import { renderContinuationPrompt, renderFixPrompt, renderResumePrompt } from '../src/sdd/chain.ts'
import { LENSES, type RoundPlan } from '../src/review/ledger.ts'
import { type Candidate } from '../src/review/candidate.ts'
import { renderCorrectionPrompt, renderLensRoundPrompt, renderRefutePrompt, renderReviewPrompt, renderRoundPrompt } from '../src/review/prompt.ts'
import { renderArtifactPrompt, renderArtifactRoundPrompt } from '../src/review/artifact-prompt.ts'

test('los generadores de encargos prohíben Claude directo e indirecto', () => {
  const original = 'material inmutable\n'
  assert.equal(withWorkerPolicy(withWorkerPolicy(original)), withWorkerPolicy(original))
  const candidate: Candidate = { base_sha: 'b'.repeat(40), head_sha: null, hash: `sha256:${'a'.repeat(64)}`,
    files: [{ path: 'spec.md', status: 'A', mode: '100644', sha256: 'c', binary: false, lines: 1, visible: [[1, 1]] }],
    context: [], left_out: [], diff: [
      'diff --git a/spec.md b/spec.md', 'new file mode 100644', '--- /dev/null', '+++ b/spec.md',
      '@@ -0,0 +1 @@', '+material inmutable', '',
    ].join('\n') }
  const round: RoundPlan = { n: 2, prev_hash: candidate.hash, identical: true, targets: [], changed: {} }
  const artifact: Candidate = { ...candidate, base_sha: null, subject: { kind: 'spec' } }
  const fix = renderFixPrompt({ flow: 'f', receipt: 'r', paths: { spec: 'spec.md', plan: 'plan.md', tasks: 'tasks.md' }, rows: [
    { id: 'V1', argv: ['node'], exit_code: 1, excerpt: 'error', class: 'implementation', reason: 'defecto', stdout: '', stderr: '' },
  ] }, 65536 - writerEnvelopeBytes())
  assert.ok('prompt' in fix)
  const prompts = [
    writerPrompt(original), writerPrompt(withWorkerPolicy(original)),
    ...(['specify', 'plan', 'tasks', 'implement'] as const).map((step) => renderPhasePrompt(step, { id: 'f', depth: 'normal', step, pending: ['T1'] }, { request: original, spec: original, plan: original, tasks: original })),
    renderContinuationPrompt('f', ['T1']), renderResumePrompt('f', 'r', 'implement', ['T1']), renderResumePrompt('f', 'r', 'fix', ['V1']),
    ...('prompt' in fix ? [fix.prompt] : []),
    renderReviewPrompt(candidate, new Map()),
    ...LENSES.map((reviewer) => renderReviewPrompt(candidate, new Map(), { reviewer })),
    renderRoundPrompt(candidate, original, round, [], 3),
    ...LENSES.map((lens) => renderLensRoundPrompt(candidate, original, round, lens, 3)),
    renderRefutePrompt(candidate, original, []),
    renderArtifactPrompt(artifact, original), renderArtifactRoundPrompt(artifact, original, round, [], 3, original, original),
  ]
  for (const prompt of prompts) {
    assert.equal(prompt.split(WORKER_POLICY).length - 1, 1)
    assert.match(prompt, /No ejecutes `claude`/)
    assert.match(prompt, /npm run test:mods/)
    assert.match(prompt, /preparación de las declaraciones/)
    assert.match(prompt, /recuperación del rollout/)
    assert.match(prompt, /pendiente para el conductor/)
    const corrected = renderCorrectionPrompt(prompt, 'JSON inválido')
    assert.equal(corrected.split(WORKER_POLICY).length - 1, 1)
    assert.ok(corrected.startsWith(prompt))
  }
  assert.ok(writerPrompt(original).includes(`<<<ENCARGO\n${original}\nENCARGO>>>`))
  for (const file of ['agents/worker.md', 'skills/sdd-ai/SKILL.md']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const phrase of ['`claude`', 'npm run test:mods', 'declaraciones', 'rollout', 'pendiente para el conductor']) assert.ok(source.includes(phrase), `${file}: ${phrase}`)
  }
})
