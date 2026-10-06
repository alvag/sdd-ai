import { join } from 'node:path'
import { utimesSync } from 'node:fs'
import { fixtureJson, projectionFixture } from './projection-fixture.ts'
import type { NotificationSignal, RecipientIdentity } from '../mods/sdd-ai/hooks/notification.ts'
import { checkoutIdentity } from '../src/notification.ts'
import { freeze } from '../src/review/candidate.ts'
import { openLedger } from '../src/review/ledger.ts'
import type { ProjectionRunState } from '../src/projection-types.ts'

export function notificationFixture() {
  const fixture = projectionFixture()
  // La misma identidad que publica la proyección y que valida el lector de señales.
  const checkout = checkoutIdentity(fixture.root)
  return { ...fixture, checkout,
    review(id: string, state: ProjectionRunState = 'done', flow = 'flow') {
      const dir = fixture.run(id, { session: 'owner', conductor: { family: 'claude' }, kind: 'review', flow,
        author: 'codex', degradations: [], selection: { base: fixture.base, context: [] } }, state)
      fixtureJson(join(dir, 'status.json'), { state, round: 1, launch: 1 })
      fixtureJson(join(dir, 'resolved.json'), { family: 'codex' })
      fixtureJson(join(dir, 'candidate.json'), freeze(fixture.root, { base: fixture.base, context: [] }))
      fixtureJson(join(dir, 'ledger.json'), openLedger([{ axis: 'quality', severity: 'WARNING', location: 'src/x.ts:1', claim: 'Hallazgo de fixture.' }]))
      return dir
    },
    envFor(recipient: RecipientIdentity): Record<string, string | undefined> {
      return recipient.family === 'claude' ? { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: recipient.session }
        : { CODEX_THREAD_ID: 'thread', CODEX_SESSION_ID: recipient.session }
    },
    signalFor(recipient: RecipientIdentity, overrides: Partial<NotificationSignal> = {}) {
      const signal: NotificationSignal = { schema_version: 1, checkout, ...recipient, instance: recipient.session,
        operational: true, updated_at: Date.now(), ...overrides }
      const path = join(fixture.root, '.sdd-ai', 'hooks', 'notifications', `${recipient.family}-${recipient.session}.json`)
      fixtureJson(path, signal)
      utimesSync(path, new Date(signal.updated_at), new Date(signal.updated_at))
      return path
    },
  }
}
