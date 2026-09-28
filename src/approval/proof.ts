import { type Family, SddError } from '../types.ts'
import { type Question, renderForText } from './question.ts'
import { SessionReadError, answersFor, detectRunner, readTail, sessionFile } from './session.ts'

type Env = Record<string, string | undefined>

/** La procedencia de una decisión: de qué runner, de qué respuesta y de qué sesión salió. */
export interface Proof { runner: Family; source: 'ask_user_question' | 'rollout_message'; ref: string; session: string; answered_at: string }

/** El `next` de un rechazo: nombra la pregunta canónica y dice cómo hacerla en cada runner. */
export function askNext(q: Question): string {
  return `hazle al usuario la pregunta canónica «${q.question}». En Claude Code, con AskUserQuestion, pasando tal cual`
    + ` este objeto como su única pregunta, con selección simple: ${JSON.stringify(q)}. En Codex, mostrando exactamente`
    + ` este texto como único contenido de un mensaje, con el contexto en un mensaje anterior, y esperando el próximo`
    + ` mensaje del usuario: ${JSON.stringify(renderForText(q))}. Después de la respuesta, vuelve a correr el comando`
}

/**
 * La prueba de que el usuario respondió la pregunta canónica con la opción que autoriza la acción. Vale
 * la última respuesta leída ahora, nunca una anterior, y una respuesta ya usada no sirve dos veces. Un
 * rechazo no escribe nada y su `next` trae la pregunta.
 */
export function prove(o: { env: Env; conductor?: Family; q: Question; authorizes: string; consumed: ReadonlySet<string> }): Proof {
  const next = askNext(o.q)
  const missing = (message: string, detail?: string) => new SddError('approval_missing', message, { ...(detail ? { detail } : {}), next })
  let r
  try {
    r = detectRunner(o.env, o.conductor)
  } catch (e) {
    if (e instanceof SddError) throw new SddError(e.code, e.message, { ...(e.detail ? { detail: e.detail } : {}), next: `${e.next}; después, ${next}` })
    throw e
  }
  let answers
  try {
    answers = answersFor(r, readTail(sessionFile(o.env, r)), o.q)
  } catch (e) {
    if (e instanceof SessionReadError) throw missing('no se pudo leer el archivo de la sesión', e.message)
    if (e instanceof SddError && e.code === 'approval_missing') throw missing(e.message, e.detail)
    throw e
  }
  const last = answers.at(-1)
  if (last === undefined) throw missing('falta la respuesta del usuario a la pregunta canónica')
  if (last.label === null) throw missing('la última respuesta del usuario no es una de las opciones', 'una respuesta que no es una opción no autoriza nada')
  if (last.ref === '' || last.answered_at === null) throw missing('no se pudo extraer la identidad o el momento de la respuesta')
  if (last.label !== o.authorizes) {
    throw new SddError('approval_contradicted', 'la última respuesta del usuario no autoriza esta decisión', {
      detail: `respondió «${last.label}» y esta decisión necesita «${o.authorizes}»`, next,
    })
  }
  if (o.consumed.has(last.ref)) {
    throw new SddError('approval_reused', 'esa respuesta ya se usó para registrar una decisión', { detail: `ref ${last.ref}`, next })
  }
  return {
    runner: r.runner, source: r.runner === 'claude' ? 'ask_user_question' : 'rollout_message',
    ref: last.ref, session: r.session, answered_at: last.answered_at,
  }
}
