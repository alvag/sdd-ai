import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Question, gateQuestionFor } from '../src/approval/question.ts'
import { readFlow } from '../src/sdd/read.ts'
import { type GateId, resolve } from '../src/sdd/status.ts'

/** Ejecutable `claude` o `codex` en `dir` que delega en el CLI falso de los tests. */
export function makeFakeBin(dir: string, name: 'claude' | 'codex'): void {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, 'fake-cli.ts')}" "$@"\n`)
  chmodSync(file, 0o755)
}

/**
 * Ejecuta una vez el bin falso. macOS evalúa la primera ejecución de un ejecutable nuevo (unos 0,4 s,
 * a veces más con la suite en paralelo): un test con un tope de 1 s no puede pagarla dentro del tope.
 */
export function warmFakeBin(dir: string, name: 'claude' | 'codex'): void {
  spawnSync(join(dir, name), [], { env: { PATH: process.env.PATH, FAKE_MODE: 'ok-claude' }, input: '' })
}

/** Repo Git vacío en un directorio temporal (ruta real, sin el symlink de /var en macOS). */
export function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-repo-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const lines = (items: unknown[]) => items.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'

/**
 * Agrega líneas al transcript de Claude Code de una sesión, en `<configDir>/projects/-repo/<session>.jsonl`.
 * Una línea que ya es texto se escribe tal cual: así se arma una línea ilegible.
 */
export function writeClaudeTranscript(configDir: string, session: string, items: unknown[]): string {
  const file = join(configDir, 'projects', '-repo', `${session}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, lines(items))
  return file
}

/** Agrega líneas al rollout de Codex de una sesión, bajo `<codexHome>/sessions/` y con la forma de nombre real. */
export function writeCodexRollout(codexHome: string, session: string, items: unknown[]): string {
  const file = join(codexHome, 'sessions', '2026', '09', '28', `rollout-2026-09-28T00-00-00-${session}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, lines(items))
  return file
}

const AT = '2026-09-28T12:00:00.000Z'

/**
 * El par de `AskUserQuestion` de un transcript de Claude Code: la línea del asistente con el `tool_use`
 * y la del usuario con su `tool_result`, con las claves que se observaron en archivos reales. `at: null`
 * deja la línea del resultado sin `timestamp`.
 */
export function askPair(session: string, toolUseId: string, q: Question, label: string,
  o: { sidechain?: boolean; isError?: boolean; at?: string | null; multiSelect?: boolean } = {}): [unknown, unknown] {
  const sidechain = o.sidechain ?? false
  const assistant = {
    type: 'assistant', sessionId: session, isSidechain: sidechain, uuid: `a-${toolUseId}`, timestamp: AT,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion',
      input: { questions: [{ ...q, multiSelect: o.multiSelect ?? false }] } }] },
  }
  const user = {
    type: 'user', sessionId: session, isSidechain: sidechain, uuid: `u-${toolUseId}`, sourceToolAssistantUUID: `a-${toolUseId}`,
    ...(o.at === null ? {} : { timestamp: o.at ?? AT }),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `User has answered your questions: "${q.question}"="${label}".`,
      ...(o.isError ? { is_error: true } : {}) }] },
    toolUseResult: { questions: [q], answers: { [q.question]: label }, annotations: {} },
  }
  return [assistant, user]
}

/**
 * Una línea `item_completed` de un rollout de Codex. El contenido de un `AgentMessage` es `Text` y el de
 * un `UserMessage` es `text`, como en los rollouts reales. `id: null` y `at: null` omiten esas claves.
 */
export function codexItem(type: string, text: string, o: { id?: string | null; at?: string | null } = {}): unknown {
  const item: Record<string, unknown> = { type }
  if (o.id !== null) item.id = o.id ?? `${type}-${Math.random().toString(16).slice(2)}`
  if (type === 'UserMessage') item.client_id = 'client-1'
  item.content = [{ type: type === 'AgentMessage' ? 'Text' : 'text', text }]
  return { ...(o.at === null ? {} : { timestamp: o.at ?? AT }), type: 'event_msg', payload: { type: 'item_completed', item } }
}

/**
 * Deja en el transcript de la sesión de fixture de `env` la respuesta del usuario a la pregunta del
 * gate, con las huellas que el flujo tiene ahora. No usa `next.question`: en un fixture cuyo header ya
 * acredita gates, `sdd status` apunta a otro paso.
 */
export function answerGate(repo: string, env: Record<string, string>, id: string, gate: string, label = 'Aprobar'): Question {
  const { facts } = readFlow(repo, id)
  const depth = resolve(facts).depth
  if (depth === null) throw new Error(`el flujo ${id} no tiene profundidad`)
  const q = gateQuestionFor(id, depth, gate as GateId, facts.fingerprints)
  const session = env.CLAUDE_CODE_SESSION_ID!
  writeClaudeTranscript(env.CLAUDE_CONFIG_DIR!, session, askPair(session, `tu-${Math.random().toString(16).slice(2)}`, q, label))
  return q
}
