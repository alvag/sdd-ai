import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readStatus } from '../src/runs.ts'
import { READ_ONLY_ROLES, TERMINAL } from '../src/types.ts'
import { findingsInstructions } from '../src/findings.ts'
import { withWorkerPolicy } from '../src/worker-policy.ts'
import { type Setup, setup, cli, pick, nativeOf, AS_CODEX, runsIn, requestOf } from './cli-run-fixture.ts'

test('run por proceso responde en menos de 1 s', () => {
  // Un worker que nunca termina: si run esperara al worker, este test no respondería a tiempo.
  const s = setup({ families: '[codex]', bins: ['codex'], mode: 'hang-child' })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.out.via, 'process')
  assert.equal(r.out.family, 'codex')
  assert.ok(r.ms < 1000, `run tardó ${r.ms} ms`)
  assert.equal(cli(s, ['cancel', r.out.id]).code, 0)
  assert.equal(cli(s, ['wait', r.out.id, '--max', '10']).out.state, 'cancelled')
})

test('run por proceso seguido de wait entrega el resultado', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0, r.stderr)
  const w = cli(s, ['wait', r.out.id, '--max', '10'])
  assert.equal(w.code, 0, JSON.stringify(w.out))
  assert.equal(w.out.state, 'done')
  assert.equal(w.out.result, 'ok')
})

test('run da búsqueda web por proceso solo a explore e investigate', () => {
  const launched = (s: Setup, role: string, extra: string[] = []): string[] => {
    const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', role, ...extra])
    assert.deepEqual([r.code, r.out.via], [0, 'process'], r.stderr)
    const w = cli(s, ['wait', r.out.id, '--max', '10'])
    assert.ok(TERMINAL.has(w.out.state), `${role}: ${w.out.state}`)
    return JSON.parse(readFileSync(join(s.repo, '.sdd-ai', 'runs', r.out.id, 'argv.json'), 'utf8')).launch.args
  }
  const codex = setup({ families: '[codex]', bins: ['codex'] })
  for (const role of ['explore', 'investigate']) assert.ok(launched(codex, role).includes('web_search="live"'), role)
  assert.ok(launched(codex, 'design-review').includes('web_search="disabled"'))
  const claude = setup({ families: '[claude]', bins: ['claude'] })
  assert.ok(launched(claude, 'explore', ['--conductor', 'codex']).includes('--allowedTools=WebFetch,WebSearch'))
  assert.equal(launched(claude, 'design-review', ['--conductor', 'codex']).some((a) => a.startsWith('--allowedTools')), false)
})

test('vía nativa: sin agentes sincronizados es agents_stale; tras sync, delegated', () => {
  const s = setup({ families: '[claude]' })
  const stale = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(stale.code, 1)
  assert.deepEqual([stale.out.state, stale.out.reason], ['launch_failed', 'agents_stale'])
  assert.equal(cli(s, ['agents', 'sync']).code, 0)
  const r = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.family, r.out.agent], ['native', 'claude', 'sdd-ai-explore'])
  // Un encargo nuevo de explore lleva la política una vez, el encargo y, después, el reporte de hallazgos de run.
  assert.equal(readFileSync(r.out.prompt_file, 'utf8'), withWorkerPolicy(`${readFileSync(s.prompt, 'utf8')}\n\n${findingsInstructions('run')}`))
  assert.equal(readStatus(join(s.repo, '.sdd-ai', 'runs', r.out.id)).state, 'delegated')
})

test('CLI ausente: launch_failed por cli_missing con la propuesta de caída', () => {
  const s = setup({ families: '[codex]' })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--conductor-model', 'claude-opus-5-5'], { CLAUDE_EFFORT: 'xhigh' })
  assert.equal(r.code, 1)
  assert.deepEqual([r.out.state, r.out.reason, r.out.fallback.family], ['launch_failed', 'cli_missing', 'claude'])
  // La caída lleva la familia, el modelo y el esfuerzo del conductor.
  assert.match(r.out.next, /--families claude .*--model claude-opus-5-5 --effort xhigh/)
})

test('vía nativa Claude: el modelo distinto al del agente viaja; el esfuerzo se avisa', () => {
  const s = setup({ families: '[claude]' })
  cli(s, ['agents', 'sync'])
  const plain = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal('model' in plain.out || 'effort' in plain.out || 'warnings' in plain.out, false)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--model', 'sonnet', '--effort', 'alto'])
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.model, r.out.effort], ['native', 'sonnet', undefined])
  assert.match(r.out.warnings.join(' '), /esfuerzo/)
  // native.json guarda lo que run le mostró al conductor: en Claude, sin esfuerzo.
  assert.deepEqual(nativeOf(s.repo, r.out.id), { agent: r.out.agent, family: 'claude', role: 'explore', model: 'sonnet' })
})

test('vía nativa: el perfil del rol vive en su agente', () => {
  const s = setup({ families: '[claude]', workers: 'schema_version: 1\nroles:\n  design-review:\n    claude:\n      model: sonnet\n      effort: muy_alto\n' })
  cli(s, ['agents', 'sync'])
  assert.match(readFileSync(join(s.repo, '.claude/agents/sdd-ai-design-review.md'), 'utf8'), /\nmodel: sonnet\neffort: xhigh\n/)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', 'design-review'])
  assert.equal(r.code, 0)
  assert.equal(r.out.agent, 'sdd-ai-design-review')
  assert.equal('model' in r.out || 'effort' in r.out || 'warnings' in r.out, false)
})

test('vía nativa: cada rol responde con su agente', () => {
  const claude = setup({ families: '[claude]' })
  cli(claude, ['agents', 'sync'])
  const c = cli(claude, ['run', '--prompt-file', claude.prompt, '--role', 'code-review'])
  assert.deepEqual([c.code, c.out.family, c.out.agent], [0, 'claude', 'sdd-ai-code-review'])
  const codex = setup({ families: '[codex]' })
  cli(codex, ['agents', 'sync'], AS_CODEX)
  const x = cli(codex, ['run', '--prompt-file', codex.prompt, '--role', 'code-review'], AS_CODEX)
  assert.deepEqual([x.code, x.out.family, x.out.agent], [0, 'codex', 'sdd-ai-code-review'])
})

test('vía nativa Codex: el esfuerzo viaja para spawn_agent', () => {
  const s = setup({ families: '[codex]' })
  cli(s, ['agents', 'sync'], AS_CODEX)
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--effort', 'maximo', '--model', 'gpt-prueba'], AS_CODEX)
  assert.equal(r.code, 0)
  assert.deepEqual([r.out.via, r.out.effort, r.out.model], ['native', 'max', 'gpt-prueba'])
  assert.deepEqual(nativeOf(s.repo, r.out.id), { agent: r.out.agent, family: 'codex', role: 'explore', model: 'gpt-prueba', effort: 'max' })
})

test('wait informa el reintento', () => {
  const s = setup({ families: '[claude]', bins: ['claude'], mode: 'reject-model-claude' })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--model', 'no-existe'], AS_CODEX)
  assert.deepEqual([r.code, r.out.via], [0, 'process'])
  const w = cli(s, ['wait', r.out.id, '--max', '10'], AS_CODEX)
  assert.equal(w.code, 0)
  assert.equal(w.out.state, 'done')
  assert.deepEqual([w.out.retry.field, w.out.retry.requested], ['model', 'no-existe'])
  assert.match(w.out.warnings.join(' '), /modelo no-existe/)
})

test('wait avisa la reanudación', () => {
  const s = setup({ families: '[claude]', bins: ['claude'], mode: 'hang-unless-resume-claude' })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--deadline', '1'], AS_CODEX)
  assert.equal(r.code, 0)
  const w = cli(s, ['wait', r.out.id, '--max', '30'], AS_CODEX)
  assert.equal(w.out.state, 'done')
  assert.equal(w.out.resume.outcome, 'done')
  assert.equal(w.out.result, 'ok')
  assert.match(w.out.warnings.join(' '), /reanud/)
})

test('la caída desde Codex conserva el esfuerzo que declara el conductor', () => {
  const s = setup({ families: '[claude]' })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--conductor-model', 'gpt-6-sol', '--conductor-effort', 'alto'], AS_CODEX)
  assert.equal(r.out.reason, 'cli_missing')
  assert.match(r.out.next, /--families codex .*--model gpt-6-sol --effort high/)
})

test('retry reutiliza el prompt congelado y sale por la vía nativa', () => {
  const s = setup({ families: '[codex]' })
  const first = cli(s, ['run', '--prompt-file', s.prompt])
  assert.equal(first.out.reason, 'cli_missing')
  cli(s, ['agents', 'sync'])
  const retry = cli(s, ['run', '--retry', first.out.id, '--families', 'claude'])
  assert.equal(retry.code, 0)
  assert.equal(retry.out.via, 'native')
  const runs = join(s.repo, '.sdd-ai', 'runs')
  assert.equal(JSON.parse(readFileSync(join(runs, retry.out.id, 'request.json'), 'utf8')).retry_of, first.out.id)
  assert.equal(readFileSync(join(runs, retry.out.id, 'prompt.md'), 'utf8'), readFileSync(join(runs, first.out.id, 'prompt.md'), 'utf8'))
})

test('run guarda la sesión dueña según la familia del conductor', () => {
  // Las dos variables presentes: manda la de la familia del conductor, no la primera que aparezca.
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const claude = cli(s, ['run', '--prompt-file', s.prompt], { CODEX_SESSION_ID: 's-codex' })
  assert.equal(claude.code, 0, claude.stderr)
  assert.equal(requestOf(s.repo, claude.out.id).session, 's-claude')
  const x = setup({ families: '[claude]', bins: ['claude'] })
  const codex = cli(x, ['run', '--prompt-file', x.prompt], AS_CODEX)
  assert.equal(codex.code, 0, codex.stderr)
  assert.equal(requestOf(x.repo, codex.out.id).session, 's-codex')
  cli(s, ['wait', claude.out.id, '--max', '10'])
  cli(x, ['wait', codex.out.id, '--max', '10'], AS_CODEX)
})

test('run --retry hereda rol, overrides y familia del conductor', () => {
  // Conductor Codex declarado y familia Claude sin CLI: las dos corridas quedan en cli_missing.
  const s = setup({ families: '[claude]' })
  const first = cli(s, ['run', '--prompt-file', s.prompt, '--conductor', 'codex', '--role', 'code-review', '--model', 'sonnet', '--deadline', '900'])
  assert.equal(first.out.reason, 'cli_missing', JSON.stringify(first.out))
  const retry = cli(s, ['run', '--retry', first.out.id])
  assert.equal(retry.out.reason, 'cli_missing', JSON.stringify(retry.out))
  const req = requestOf(s.repo, retry.out.id)
  assert.deepEqual([req.role, req.overrides.model, req.overrides.deadline_sec, req.conductor.family], ['code-review', 'sonnet', 900, 'codex'])
  const plain = requestOf(s.repo, cli(s, ['run', '--prompt-file', s.prompt, '--conductor', 'codex']).out.id)
  assert.deepEqual([plain.role, plain.overrides.deadline_sec], ['explore', 600])
})

test('un fallback con modelo de la otra familia no hereda ese modelo', () => {
  const s = setup({ families: '[codex]' })
  const first = cli(s, ['run', '--prompt-file', s.prompt, '--families', 'codex', '--model', 'gpt-6-sol', '--role', 'design-review'])
  assert.equal(first.out.reason, 'cli_missing', JSON.stringify(first.out))
  const retry = cli(s, ['run', '--retry', first.out.id, '--families', 'claude', '--conductor', 'claude'])
  const req = requestOf(s.repo, retry.out.id)
  assert.equal(req.overrides.model, undefined)
  assert.equal(req.role, 'design-review')
})

test('un run nativo sin id de sesión falla sin crear la corrida', () => {
  const s = setup({ families: '[claude]' })
  assert.equal(cli(s, ['agents', 'sync']).code, 0)
  const r = cli(s, ['run', '--prompt-file', s.prompt], { CLAUDE_CODE_SESSION_ID: '' })
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'session_unknown')
  assert.deepEqual(runsIn(s.repo), [])
})

test('--role pr da el aviso de migración', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', 'pr'])
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'usage')
  assert.match(`${r.out.message} ${r.out.next}`, /code-review/)
  assert.deepEqual(runsIn(s.repo), [])
})

test('un rol con nombre de Object.prototype es desconocido', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  for (const role of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', role])
    assert.equal(r.code, 2, role)
    assert.equal(r.out.code, 'usage', role)
    assert.equal(r.out.message, `rol desconocido: ${role}`)
  }
  assert.deepEqual(runsIn(s.repo), [])
})

test('los roles de lectura conservan lanzadores, vías y resultado de wait', () => {
  const argsOf = (repo: string, id: string): string[] =>
    JSON.parse(readFileSync(join(repo, '.sdd-ai', 'runs', id, 'argv.json'), 'utf8')).launch.args
  const codex = setup({ families: '[codex]', bins: ['codex'] })
  const claude = setup({ families: '[claude]', bins: ['claude'], mode: 'ok-claude' })
  for (const role of READ_ONLY_ROLES) {
    const r = cli(codex, ['run', '--prompt-file', codex.prompt, '--role', role])
    assert.deepEqual([r.code, r.out.via, r.out.family], [0, 'process', 'codex'], role)
    const args = argsOf(codex.repo, r.out.id)
    assert.deepEqual(args.slice(0, 8), ['exec', '--ignore-user-config', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins'], role)
    assert.equal(args[args.indexOf('-s') + 1], 'read-only', role)
    assert.ok(args.includes('--output-last-message') && !args.includes('--ignore-rules'), role)
    assert.deepEqual(Object.values(pick(cli(codex, ['wait', r.out.id, '--max', '10']))), [0, 'done', 'ok'], role)

    const c = cli(claude, ['run', '--prompt-file', claude.prompt, '--role', role, '--conductor', 'codex'])
    assert.deepEqual([c.code, c.out.via, c.out.family], [0, 'process', 'claude'], role)
    const cargs = argsOf(claude.repo, c.out.id)
    assert.ok(cargs.includes('--safe-mode') && cargs.some((a) => a.startsWith('--tools=Read,Grep,Glob')), role)
    assert.equal(cargs.some((a) => /Edit|Write|Bash/.test(a)) || cargs.includes('--restricted'), false, role)
    assert.equal(cli(claude, ['wait', c.out.id, '--max', '10']).out.state, 'done', role)
  }
  const native = setup({ families: '[claude]' })
  assert.equal(cli(native, ['agents', 'sync']).code, 0)
  for (const role of READ_ONLY_ROLES) {
    const r = cli(native, ['run', '--prompt-file', native.prompt, '--role', role])
    assert.deepEqual([r.code, r.out.via, r.out.agent], [0, 'native', `sdd-ai-${role}`], role)
  }
})

test('--role code-review despacha', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt, '--role', 'code-review'])
  assert.equal(r.code, 0)
  assert.equal(r.out.via, 'process')
  cli(s, ['wait', r.out.id, '--max', '10'])
})

test('un worker no puede lanzar otro sdd-ai', () => {
  const s = setup({ families: '[codex]', bins: ['codex'] })
  const r = cli(s, ['run', '--prompt-file', s.prompt], { SDD_AI_WORKER: '1' })
  assert.equal(r.code, 2)
  assert.equal(r.out.code, 'recursion')
})
