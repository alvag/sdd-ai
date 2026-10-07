import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIN, setup, cli, git } from './cli-run-fixture.ts'
import { FINDING, SPECIFY, PLAN, TASKS } from './findings-fixture.ts'
import { readFlow } from '../src/sdd/read.ts'
import { freezeLaunch } from '../src/sdd/publish.ts'
import { codexLaunch } from '../src/workers/codex.ts'

function phase(step: 'specify' | 'plan' | 'tasks') {
  const s = setup({ families: '[codex]', bins: ['codex'], mode: 'scripted' })
  git(s.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
  git(s.repo, 'checkout', '-q', '-b', 'feature/f')
  writeFileSync(join(s.repo, '.git', 'info', 'exclude'), '.plans/\n.sdd-ai/\n')
  const dir = join(s.repo, '.plans', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'handoff.md'), `---\nprofundidad: completa\nrisk: low\nchange_type: feat\nbranch: feature/f\nspec_approved_at: ${step === 'specify' ? 'null' : '2026-10-06T00:00:00Z'}\n---\n`)
  if (step !== 'specify') writeFileSync(join(dir, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n\n- **AC-1:** Exporta. (pedido)\n')
  if (step === 'tasks') writeFileSync(join(dir, 'plan.md'), '---\nid: f\nprofundidad: completa\nstatus: plan-approved\n---\n\n# Plan\n')
  const answers = join(mkdtempSync(join(tmpdir(), 'findings-answers-')), 'answers.json')
  Object.assign(s.env, { FAKE_ANSWERS: answers, FAKE_CALLS_FILE: `${answers}.calls` })
  const request = join(s.repo, 'pedido.md')
  writeFileSync(request, readFileSync(s.prompt))
  const launch = () => cli(s, ['sdd', 'phase', 'f', ...(step === 'specify' ? ['--request', request] : [])])
  return { s, dir, answers, request, launch, wait: (id: string) => cli(s, ['wait', id, '--max', '20']), runFile: (id: string, name: string) => join(s.repo, '.sdd-ai', 'runs', id, name) }
}
const contracts = { specify: SPECIFY, plan: PLAN, tasks: TASKS }

test('wait entrega findings de specify plan y tasks aunque el artefacto quede pendiente', () => {
  for (const step of ['specify', 'plan', 'tasks'] as const) for (const pending of [false, true]) {
    const x = phase(step)
    const c = { ...contracts[step], findings: [FINDING, { problem: 'incompleto' }], ...(pending ? { blocking_questions: ['¿Formato?'], missing_context: ['esquema'] } : {}) }
    writeFileSync(x.answers, JSON.stringify([JSON.stringify(c), JSON.stringify(c)]))
    const r = x.launch()
    assert.equal(r.code, 0, JSON.stringify(r))
    const w = x.wait(r.out.id)
    assert.equal(w.code, 0, JSON.stringify(w))
    assert.equal(w.out.outcome, pending ? 'awaiting_context' : 'published')
    assert.deepEqual(w.out.findings, [FINDING])
    assert.equal(w.out.findings_rejected.length, 1)
    for (const name of ['phase.json', 'contract.json']) {
      const stored = JSON.parse(readFileSync(x.runFile(r.out.id, name), 'utf8'))
      assert.deepEqual(stored.findings, [FINDING])
    }
    if (pending) {
      writeFileSync(join(x.s.repo, 'context.md'), 'Contexto\n')
      const again = cli(x.s, ['sdd', 'phase', 'f', '--context', 'context.md'])
      const closed = x.wait(again.out.id)
      assert.equal(closed.out.outcome, 'closed_inline')
      assert.deepEqual(closed.out.findings, [FINDING])
    }
  }
  // Una publicación fallida conserva el canal. La barrera evita cambiar el flujo antes del lanzamiento.
  const x = phase('specify')
  const gate = join(tmpdir(), `findings-publication-${process.pid}`)
  writeFileSync(x.answers, JSON.stringify([`__barrier__ ${gate}\n${JSON.stringify({ ...SPECIFY, findings: [FINDING] })}`]))
  const r = x.launch()
  writeFileSync(join(x.dir, 'spec.md'), '# Spec\n\n## Criterios de aceptación\n- **AC-1:** Otro. (pedido)\n')
  writeFileSync(`${gate}.release`, '')
  const w = x.wait(r.out.id)
  assert.equal(w.out.outcome, 'not_published')
  assert.deepEqual(w.out.findings, [FINDING])
  const bad = phase('specify')
  writeFileSync(bad.answers, JSON.stringify([JSON.stringify({ ...SPECIFY, findings: [FINDING], extra: true }), 'inválido']))
  const b = bad.launch()
  const bw = bad.wait(b.out.id)
  assert.equal(bw.out.outcome, 'not_admitted')
  assert.equal('findings' in bw.out, false)
  assert.ok(readFileSync(bad.runFile(b.out.id, 'result.md'), 'utf8').includes('reader'))
  const failed = phase('specify')
  writeFileSync(failed.answers, JSON.stringify(['__fail__', '__fail__']))
  const f = failed.launch()
  const fw = failed.wait(f.out.id)
  assert.notEqual(fw.out.state, 'done')
  assert.equal('findings' in fw.out, false)
})

test('una corrida nueva sin findings queda marcada findings_missing y una anterior no', () => {
  for (const step of ['specify', 'plan', 'tasks'] as const) {
    const x = phase(step)
    writeFileSync(x.answers, JSON.stringify([JSON.stringify({ ...contracts[step], missing_context: ['dato'] })]))
    const r = x.launch()
    assert.equal(r.code, 0, JSON.stringify(r))
    const control = JSON.parse(readFileSync(x.runFile(r.out.id, 'argv.json'), 'utf8'))
    assert.equal(control.phase.findings, true)
    const w = x.wait(r.out.id)
    assert.equal(w.out.findings_missing, true)
    assert.equal('findings' in w.out, false)
    assert.equal(JSON.parse(readFileSync(x.runFile(r.out.id, 'contract.json'), 'utf8')).findings_missing, true)
  }
})

test('una fase lanzada con contrato anterior sigue recibible sin findings ni cambios de gate', async () => {
  // Congela un lanzamiento antiguo antes de ejecutar el supervisor: sin la marca ni el canal nuevo.
  const x = phase('specify')
  const id = 'legacy-findings'
  const run = join(x.s.repo, '.sdd-ai', 'runs', id)
  mkdirSync(run, { recursive: true })
  const barrier = join(run, 'legacy-response')
  const frozen = freezeLaunch(readFlow(x.s.repo, 'f'), {
    step: 'specify', depth: 'completa', amended: false,
    request: { path: x.request, bytes: readFileSync(x.request) },
  })
  const promptFile = join(run, 'prompt.md')
  const resultFile = join(run, 'result.md')
  writeFileSync(promptFile, 'Devuelve el contrato specify anterior, sin findings.\n')
  writeFileSync(x.answers, JSON.stringify([`__barrier__ ${barrier}\n${JSON.stringify(SPECIFY)}`]))
  const argv = { family: 'codex', kind: 'phase', deadline_sec: 30,
    phase: { ...frozen, root: x.s.repo },
    launch: codexLaunch({ cwd: x.s.repo, promptFile, resultFile, sessionId: 'legacy-session' }),
  }
  writeFileSync(join(run, 'argv.json'), JSON.stringify(argv))
  writeFileSync(join(run, 'request.json'), JSON.stringify({ kind: 'phase', flow: 'f', step: 'specify', role: 'specify' }))
  writeFileSync(join(run, 'status.json'), JSON.stringify({ state: 'launching' }))
  // No se fabrican contract.json, phase.json ni spec.md: los produce la admisión real del supervisor.
  const child = spawn(process.execPath, [BIN, '__supervise', run], { cwd: x.s.repo, env: x.s.env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  try {
    const until = Date.now() + 15_000
    while (!existsSync(`${barrier}.arrived`)) {
      assert.equal(child.exitCode, null, stderr)
      assert.ok(Date.now() < until, 'el worker antiguo no llegó a la barrera')
      await sleep(20)
    }
    assert.equal(JSON.parse(readFileSync(join(run, 'status.json'), 'utf8')).state, 'running')
    assert.equal('findings' in JSON.parse(readFileSync(join(run, 'argv.json'), 'utf8')).phase, false)
    for (const name of ['contract.json', 'phase.json']) assert.equal(existsSync(join(run, name)), false)
    assert.equal(existsSync(join(x.dir, 'spec.md')), false)
  } finally {
    writeFileSync(`${barrier}.release`, '')
    await closed
  }
  assert.equal(await closed, 0, `${stdout}\n${stderr}`)
  const w = x.wait(id)
  assert.equal(w.code, 0, JSON.stringify(w))
  assert.equal(w.out.outcome, 'published')
  assert.equal(w.out.next.step, 'gate')
  assert.equal(w.out.next.gate, 'spec')
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'contract.json'), 'utf8')), SPECIFY)
  assert.ok(existsSync(join(x.dir, 'spec.md')))
  for (const result of [w.out, JSON.parse(readFileSync(join(run, 'phase.json'), 'utf8'))]) {
    for (const k of ['findings', 'findings_missing', 'findings_rejected']) assert.equal(k in result, false)
  }
  assert.equal(existsSync(join(x.dir, 'sdd-ai-approvals.json')), false)
})
