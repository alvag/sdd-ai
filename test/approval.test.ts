import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disputeQuestion, extraQuestion, gateQuestion, gateQuestionFor, renderForText } from '../src/approval/question.ts'
import { askNext, prove } from '../src/approval/proof.ts'
import { SessionReadError, answersFor, detectRunner, readTail, sessionFile } from '../src/approval/session.ts'
import { SddError } from '../src/types.ts'
import { askPair, codexItem, writeClaudeTranscript, writeCodexRollout } from './helpers.ts'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-approval-')))
const code = (e: unknown) => (e instanceof SddError ? e.code : String(e))
const throwsCode = (fn: () => unknown, c: string) => assert.throws(fn, (e) => code(e) === c)
const Q = gateQuestion('f', 'spec', 'sha256:aa', {})
const CLAUDE = { runner: 'claude' as const, session: 's-1' }
const CODEX = { runner: 'codex' as const, session: 'c-1' }

test('la pregunta canónica sale igual byte a byte y cambia con la huella de un gate anterior', () => {
  const a = gateQuestion('f', 'plan', 'sha256:aa', { spec: 'sha256:bb' })
  assert.deepEqual(a, gateQuestion('f', 'plan', 'sha256:aa', { spec: 'sha256:bb' }))
  // El vector ata el código al contrato: sha256 de ese JSON, primeros 16 caracteres hexadecimales.
  assert.equal(a.question, '¿Apruebas el gate plan del flujo f? (código 39f170f6f2fa7468)')
  assert.deepEqual(a.options.map((o) => o.label), ['Aprobar', 'No aprobar'])
  assert.notEqual(gateQuestion('f', 'plan', 'sha256:ab', { spec: 'sha256:bb' }).question, a.question)
  assert.notEqual(gateQuestion('f', 'plan', 'sha256:aa', { spec: 'sha256:bc' }).question, a.question)
  const two = { spec: 'sha256:11', plan: 'sha256:22' }
  const swapped = { plan: 'sha256:22', spec: 'sha256:11' }
  assert.deepEqual(gateQuestion('f', 'tasks', 'sha256:33', two), gateQuestion('f', 'tasks', 'sha256:33', swapped))

  const fps = { spec: 'sha256:11', plan: 'sha256:22', tasks: 'sha256:33' }
  assert.deepEqual(gateQuestionFor('f', 'completa', 'tasks', fps), gateQuestion('f', 'tasks', 'sha256:33', two))
  assert.deepEqual(gateQuestionFor('f', 'completa', 'spec', fps), gateQuestionFor('f', 'completa', 'spec', { ...fps, plan: 'sha256:99' }))
  assert.deepEqual(gateQuestionFor('f', 'completa', 'spec', fps), gateQuestion('f', 'spec', 'sha256:11', {}))

  const d = disputeQuestion('rv-1', { id: 'F-2', claim: 'falta un caso' }, 3, 'es intencional')
  assert.equal(d.question, '¿Qué hacemos con la disputa F-2 de la revisión rv-1 (ronda 3)?')
  assert.deepEqual(d.options, [
    { label: 'Aceptar el hallazgo', description: 'falta un caso' },
    { label: 'Mantener el rechazo', description: 'es intencional' },
  ])
  const x = extraQuestion('rv-1', 4)
  assert.equal(x.question, '¿Lanzamos la ronda 4 de la revisión rv-1, más allá del tope?')
  assert.deepEqual(x.options.map((o) => o.label), ['Lanzar la ronda 4', 'Dejar la revisión como está'])
  assert.equal(renderForText(d), [
    '¿Qué hacemos con la disputa F-2 de la revisión rv-1 (ronda 3)?',
    '1. Aceptar el hallazgo — falta un caso',
    '2. Mantener el rechazo — es intencional',
  ].join('\n'))
})

test('el header no pasa de 12 caracteres, también con F-100', () => {
  const headers = [
    disputeQuestion('rv', { id: 'F-10', claim: 'c' }, 1, 'r'),
    disputeQuestion('rv', { id: 'F-100', claim: 'c' }, 1, 'r'),
    disputeQuestion('rv', { id: 'F-1234', claim: 'c' }, 1, 'r'),
    gateQuestion('f', 'plan-tasks', 'sha256:aa', { spec: 'sha256:bb' }),
    gateQuestion('f', 'single', 'sha256:aa', {}),
    extraQuestion('rv', 4),
  ].map((q) => q.header)
  assert.deepEqual(headers, ['Disputa F-10', 'F-100', 'F-1234', 'plan-tasks', 'Gate single', 'Ronda extra'])
  assert.ok(headers.every((h) => h.length <= 12))
  assert.match(disputeQuestion('rv', { id: 'F-1234', claim: 'c' }, 1, 'r').question, /disputa F-1234 /)
  assert.match(gateQuestion('f', 'plan-tasks', 'sha256:aa', {}).question, /gate plan-tasks /)
})

test('sin la señal completa, con las dos a la vez sin --conductor o con SDD_AI_WORKER el comando no identifica la sesión', () => {
  const claude = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's-1' }
  const codex = { CODEX_THREAD_ID: 't-1', CODEX_SESSION_ID: 'c-1' }
  throwsCode(() => detectRunner({}), 'runner_required')
  throwsCode(() => detectRunner({ CLAUDECODE: '1' }), 'runner_required')
  throwsCode(() => detectRunner({ CODEX_THREAD_ID: 't-1' }), 'runner_required')
  throwsCode(() => detectRunner({ ...claude, SDD_AI_WORKER: '1' }), 'runner_required')
  throwsCode(() => detectRunner({ ...codex, SDD_AI_WORKER: '1' }, 'codex'), 'runner_required')
  throwsCode(() => detectRunner({ ...claude, ...codex }), 'conductor_unknown')
  throwsCode(() => detectRunner(claude, 'codex'), 'runner_required')
  assert.deepEqual(detectRunner(claude), { runner: 'claude', session: 's-1' })
  assert.deepEqual(detectRunner(codex), { runner: 'codex', session: 'c-1' })
  assert.deepEqual(detectRunner({ ...claude, ...codex }, 'codex'), { runner: 'codex', session: 'c-1' })
  assert.deepEqual(detectRunner({ ...claude, ...codex }, 'claude'), { runner: 'claude', session: 's-1' })
  try {
    detectRunner({})
  } catch (e) {
    assert.match((e as SddError).next ?? '', /usuario/)
  }
})

test('en Claude vale solo el par de AskUserQuestion de la sesión, fuera de un sidechain', () => {
  const dir = tmp()
  const other = { ...Q, options: Q.options.map((o, i) => (i === 0 ? { ...o, description: 'otra' } : o)) }
  const file = writeClaudeTranscript(dir, 's-1', [
    ...askPair('s-2', 'tu-other-session', Q, 'Aprobar'),
    ...askPair('s-1', 'tu-sidechain', Q, 'Aprobar', { sidechain: true }),
    ...askPair('s-1', 'tu-error', Q, 'Aprobar', { isError: true }),
    ...askPair('s-1', 'tu-header', { ...Q, header: 'Otro' }, 'Aprobar'),
    ...askPair('s-1', 'tu-description', other, 'Aprobar'),
    ...askPair('s-1', 'tu-multi', Q, 'Aprobar', { multiSelect: true }),
  ])
  assert.deepEqual(answersFor(CLAUDE, readTail(file), Q), [])
  appendFileSync(file, askPair('s-1', 'tu-ok', Q, 'Aprobar', { at: '2026-09-28T12:05:00.000Z' }).map((l) => JSON.stringify(l)).join('\n') + '\n')
  const answers = answersFor(CLAUDE, readTail(file), Q)
  assert.equal(answers.length, 1)
  assert.equal(answers[0]!.label, 'Aprobar')
  assert.equal(answers[0]!.answered_at, '2026-09-28T12:05:00.000Z')
  assert.match(answers[0]!.ref, /^tu-ok:[0-9a-f]{16}$/)
})

test('en Claude una respuesta que no es una etiqueta no autoriza y anula las anteriores', () => {
  const dir = tmp()
  const file = writeClaudeTranscript(dir, 's-1', [...askPair('s-1', 'tu-1', Q, 'Aprobar'), ...askPair('s-1', 'tu-2', Q, 'mejor mañana')])
  const answers = answersFor(CLAUDE, readTail(file), Q)
  assert.deepEqual(answers.map((a) => a.label), ['Aprobar', null])
})

test('en Codex vale el primer UserMessage que sigue a la pregunta si no hay otro mensaje del agente en el medio', () => {
  const dir = tmp()
  const text = renderForText(Q)
  const file = writeCodexRollout(dir, 'c-1', [
    codexItem('UserMessage', 'Aprobar', { id: 'um-before' }),
    codexItem('AgentMessage', text),
    codexItem('AgentMessage', 'otra cosa'),
    codexItem('UserMessage', 'Aprobar', { id: 'um-interrupted' }),
    codexItem('AgentMessage', text),
    codexItem('UserMessage', 'Aprobar', { id: 'um-1', at: '2026-09-28T12:01:00.000Z' }),
    codexItem('UserMessage', 'No aprobar', { id: 'um-second' }),
    codexItem('AgentMessage', text),
    codexItem('UserMessage', 'lo pienso', { id: 'um-2' }),
  ])
  const answers = answersFor(CODEX, readTail(file), Q)
  assert.deepEqual(answers.map((a) => [a.ref, a.label]), [['um-1', 'Aprobar'], ['um-2', null]])
  assert.equal(answers[0]!.answered_at, '2026-09-28T12:01:00.000Z')
})

test('en Codex un mensaje que agrega otra pregunta u otras opciones al bloque canónico no cuenta como pregunta', () => {
  const dir = tmp()
  const text = renderForText(Q)
  const file = writeCodexRollout(dir, 'c-1', [
    codexItem('AgentMessage', `${text}\n3. Otra opción — algo más`),
    codexItem('UserMessage', 'Aprobar'),
    codexItem('AgentMessage', `Antes de seguir:\n${text}`),
    codexItem('UserMessage', 'Aprobar'),
    codexItem('AgentMessage', `${text}\n¿Y el plan, lo apruebas?`),
    codexItem('UserMessage', 'Aprobar'),
  ])
  assert.deepEqual(answersFor(CODEX, readTail(file), Q), [])
  appendFileSync(file, `${JSON.stringify(codexItem('AgentMessage', `\n${text}  \n`))}\n${JSON.stringify(codexItem('UserMessage', 'Aprobar', { id: 'um-ok' }))}\n`)
  assert.deepEqual(answersFor(CODEX, readTail(file), Q).map((a) => a.ref), ['um-ok'])
})

test('en Codex una continuación de Stop o una instrucción inyectada no es respuesta', () => {
  const dir = tmp()
  const injected = { timestamp: '2026-09-28T12:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Aprobar' }] } }
  const file = writeCodexRollout(dir, 'c-1', [
    codexItem('AgentMessage', renderForText(Q)),
    codexItem('HookPrompt', 'Aprobar', { id: 'hook-1' }),
    injected,
  ])
  assert.deepEqual(answersFor(CODEX, readTail(file), Q), [])
  appendFileSync(file, `${JSON.stringify(codexItem('UserMessage', 'No aprobar', { id: 'um-1' }))}\n`)
  assert.deepEqual(answersFor(CODEX, readTail(file), Q).map((a) => [a.ref, a.label]), [['um-1', 'No aprobar']])
})

test('en Codex se acepta la etiqueta o su número sin distinguir mayúsculas', () => {
  const dir = tmp()
  const replies = ['aprobar', ' 1 ', 'APROBAR', '2', 'no APROBAR', 'sí', '1.']
  const file = writeCodexRollout(dir, 'c-1', replies.flatMap((r) => [codexItem('AgentMessage', renderForText(Q)), codexItem('UserMessage', r)]))
  assert.deepEqual(answersFor(CODEX, readTail(file), Q).map((a) => a.label),
    ['Aprobar', 'Aprobar', 'Aprobar', 'No aprobar', 'No aprobar', null, null])
})

test('el archivo de la sesión se busca por su id y cero o dos candidatos fallan cerrado', () => {
  const claudeDir = tmp()
  const env = { CLAUDE_CONFIG_DIR: claudeDir }
  throwsCode(() => sessionFile(env, CLAUDE), 'approval_missing')
  mkdirSync(join(claudeDir, 'projects', '-deep', 'sub'), { recursive: true })
  writeFileSync(join(claudeDir, 'projects', '-deep', 'sub', 's-1.jsonl'), '')
  throwsCode(() => sessionFile(env, CLAUDE), 'approval_missing')
  const file = writeClaudeTranscript(claudeDir, 's-1', [])
  assert.equal(sessionFile(env, CLAUDE), file)
  mkdirSync(join(claudeDir, 'projects', '-other'))
  writeFileSync(join(claudeDir, 'projects', '-other', 's-1.jsonl'), '')
  throwsCode(() => sessionFile(env, CLAUDE), 'approval_missing')
  throwsCode(() => sessionFile(env, { runner: 'claude', session: '../-other/s-1' }), 'approval_missing')

  const codexHome = tmp()
  const cenv = { CODEX_HOME: codexHome }
  throwsCode(() => sessionFile(cenv, CODEX), 'approval_missing')
  const rollout = writeCodexRollout(codexHome, 'c-1', [])
  assert.equal(sessionFile(cenv, CODEX), rollout)
  mkdirSync(join(codexHome, 'sessions', '2026', '09', '27'), { recursive: true })
  writeFileSync(join(codexHome, 'sessions', '2026', '09', '27', 'rollout-2026-09-27T00-00-00-c-1.jsonl'), '')
  throwsCode(() => sessionFile(cenv, CODEX), 'approval_missing')
})

test('una línea ilegible posterior a la última respuesta falla cerrado, también la última a medio escribir', () => {
  const dir = tmp()
  const file = writeClaudeTranscript(dir, 's-1', ['{roto', ...askPair('s-1', 'tu-1', Q, 'Aprobar')])
  assert.equal(answersFor(CLAUDE, readTail(file), Q).length, 1)
  writeClaudeTranscript(dir, 's-1', ['{roto'])
  throwsCode(() => answersFor(CLAUDE, readTail(file), Q), 'approval_missing')

  const half = tmp()
  const f2 = writeClaudeTranscript(half, 's-1', askPair('s-1', 'tu-1', Q, 'Aprobar'))
  appendFileSync(f2, '{"type":"user","sessionId":"s-1","mess')
  throwsCode(() => answersFor(CLAUDE, readTail(f2), Q), 'approval_missing')

  // Una última línea con solo espacios tampoco se puede interpretar.
  const blank = tmp()
  const f3 = writeClaudeTranscript(blank, 's-1', askPair('s-1', 'tu-1', Q, 'Aprobar'))
  appendFileSync(f3, '   ')
  throwsCode(() => answersFor(CLAUDE, readTail(f3), Q), 'approval_missing')
})

test('una respuesta fuera de la ventana de lectura cuenta como ausente', () => {
  const dir = tmp()
  const file = writeClaudeTranscript(dir, 's-1', [...askPair('s-1', 'tu-1', Q, 'Aprobar'), ...Array.from({ length: 20 }, (_, i) => ({ type: 'progress', n: i }))])
  assert.equal(answersFor(CLAUDE, readTail(file), Q).length, 1)
  assert.deepEqual(answersFor(CLAUDE, readTail(file, 400), Q), [])
})

test('una ventana que empieza justo después de un salto de línea conserva su primera línea', () => {
  const dir = tmp()
  const file = join(dir, 's.jsonl')
  writeFileSync(file, '{"n":1}\n{"n":2}\n')
  assert.deepEqual(readTail(file, 8).map((l) => l.value), [{ n: 2 }])
  assert.deepEqual(readTail(file, 7).map((l) => l.value), [])
  assert.deepEqual(readTail(file).map((l) => l.value), [{ n: 1 }, { n: 2 }])
})

test('un archivo de sesión que es un FIFO falla cerrado sin abrirse', { timeout: 5000 }, () => {
  const dir = tmp()
  const fifo = join(dir, 's.jsonl')
  execFileSync('mkfifo', [fifo])
  assert.throws(() => readTail(fifo), SessionReadError)
})

const claudeEnv = (dir: string) => ({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's-1', CLAUDE_CONFIG_DIR: dir })
const codexEnv = (dir: string) => ({ CODEX_THREAD_ID: 't-1', CODEX_SESSION_ID: 'c-1', CODEX_HOME: dir })
const proveWith = (env: Record<string, string>, consumed: string[] = []) =>
  () => prove({ env, q: Q, authorizes: 'Aprobar', consumed: new Set(consumed) })

test('un archivo de sesión que desaparece antes de leerlo falla cerrado con approval_missing', () => {
  const dir = tmp()
  const env = claudeEnv(dir)
  const file = writeClaudeTranscript(dir, 's-1', askPair('s-1', 'tu-1', Q, 'Aprobar'))
  assert.equal(sessionFile(env, CLAUDE), file)
  rmSync(file)
  assert.throws(() => readTail(file), SessionReadError)
  // Lo mismo, visto desde `prove`: un candidato que no se puede leer como archivo es approval_missing.
  mkdirSync(file)
  assert.throws(proveWith(env), (e) => code(e) === 'approval_missing' && /no es un archivo regular/.test((e as SddError).detail ?? ''))
})

test('vale la última respuesta y un No posterior a un Sí rechaza con approval_contradicted', () => {
  const dir = tmp()
  const env = claudeEnv(dir)
  writeClaudeTranscript(dir, 's-1', [...askPair('s-1', 'tu-1', Q, 'Aprobar'), ...askPair('s-1', 'tu-2', Q, 'No aprobar')])
  throwsCode(proveWith(env), 'approval_contradicted')
  writeClaudeTranscript(dir, 's-1', askPair('s-1', 'tu-3', Q, 'Aprobar', { at: '2026-09-28T12:09:00.000Z' }))
  const proof = proveWith(env)()
  assert.deepEqual({ ...proof, ref: proof.ref.split(':')[0] },
    { runner: 'claude', source: 'ask_user_question', ref: 'tu-3', session: 's-1', answered_at: '2026-09-28T12:09:00.000Z' })
  throwsCode(proveWith(env, [proof.ref]), 'approval_reused')

  const home = tmp()
  const cenv = codexEnv(home)
  const text = renderForText(Q)
  writeCodexRollout(home, 'c-1', [codexItem('AgentMessage', text), codexItem('UserMessage', '1', { id: 'um-1' }),
    codexItem('AgentMessage', text), codexItem('UserMessage', 'No aprobar', { id: 'um-2' })])
  throwsCode(proveWith(cenv), 'approval_contradicted')
  writeCodexRollout(home, 'c-1', [codexItem('AgentMessage', text), codexItem('UserMessage', 'aprobar', { id: 'um-3' })])
  assert.deepEqual(proveWith(cenv)(), { runner: 'codex', source: 'rollout_message', ref: 'um-3', session: 'c-1', answered_at: '2026-09-28T12:00:00.000Z' })
})

test('sin ref o sin fecha extraíbles rechaza con approval_missing', () => {
  const dir = tmp()
  writeClaudeTranscript(dir, 's-1', askPair('s-1', 'tu-1', Q, 'Aprobar', { at: null }))
  throwsCode(proveWith(claudeEnv(dir)), 'approval_missing')
  // También cuando la respuesta sin fecha no autoriza la acción: sin su momento no es una respuesta.
  const no = tmp()
  writeClaudeTranscript(no, 's-1', askPair('s-1', 'tu-1', Q, 'No aprobar', { at: null }))
  throwsCode(proveWith(claudeEnv(no)), 'approval_missing')
  const home = tmp()
  writeCodexRollout(home, 'c-1', [codexItem('AgentMessage', renderForText(Q)), codexItem('UserMessage', 'Aprobar', { id: null })])
  throwsCode(proveWith(codexEnv(home)), 'approval_missing')
  try {
    proveWith(codexEnv(home))()
  } catch (e) {
    assert.equal((e as SddError).next, askNext(Q))
  }
})
