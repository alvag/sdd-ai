import type { On, PromptSubmitResult } from 'claude-code'
import { World, REAL_ROOT, known, pending } from './band-world'
import type { NotificationRecord, NotificationSignal } from '../../hooks/notification'

/** El tope del store de un plugin según el API: 4 MiB de JSON en total. */
export const STORE_LIMIT_BYTES = 4 * 1024 * 1024

/** Simulación del API; no acredita recepción ni pintura real en Claude/macOS. */
export class NotificationWorld extends World {
  readonly store: Map<string, unknown>
  readonly effects: { op: string; key: string; value?: unknown }[] = []
  /** Cada submit tal como llegó: el texto, el origen completo y cualquier otro campo, para afirmar que solo hubo { text }. */
  readonly requests: { text: string; origin: unknown; asUser?: boolean; extra: string[] }[] = []
  draft = { text: '', cursor: 0 }
  replies: PromptSubmitResult[] = []
  failure: string | null = null
  storeLimitBytes = STORE_LIMIT_BYTES
  barrier: ((op: string, key: string, value?: unknown) => Promise<void> | undefined) | null = null
  constructor(session: string, store = new Map<string, unknown>()) { super(session); this.store = store }
  signalPath(session = this.session): string { return `${REAL_ROOT}/.sdd-ai/hooks/notifications/claude-${session}.json` }
  signal(session = this.session): NotificationSignal | null {
    const text = this.entries.get(this.signalPath(session))?.text
    return text ? JSON.parse(text) as NotificationSignal : null
  }
  seedSignal(session: string, operational: boolean, now: number): void {
    for (const directory of [`${REAL_ROOT}/.sdd-ai/hooks`, `${REAL_ROOT}/.sdd-ai/hooks/notifications`]) this.entries.set(directory, { kind: 'dir' })
    const signal: NotificationSignal = { schema_version: 1, checkout: { id: 'f'.repeat(64), root: REAL_ROOT },
      family: 'claude', session, instance: session, operational, updated_at: now }
    this.entries.set(this.signalPath(session), { kind: 'file', text: JSON.stringify(signal), mtimeMs: now })
  }
  install(on: On): void {
    super.install(on)
    on('prompt.read', async () => {
      this.effects.push({ op: 'prompt.read', key: this.session })
      await this.barrier?.('prompt.read', this.session)
      return this.failure === 'prompt.read' ? { deny: 'fixture read failure' } : { value: { ...this.draft } }
    })
    on('prompt.submit', async (_$, e) => {
      const { text, origin, ...rest } = e
      // `wait` lo pone siempre el motor; cualquier otro campo con valor no vino de un submit de solo { text }.
      const extra = Object.entries(rest).filter(([key, value]) => key !== 'wait' && value !== undefined).map(([key]) => key)
      this.requests.push({ text, origin, ...(origin.kind === 'plugin' && origin.asUser ? { asUser: true } : {}), extra })
      await this.barrier?.('prompt.submit', this.session)
      if (this.failure === 'prompt.submit') throw new Error('fixture submit failure')
      return this.replies.shift() ?? { text: e.text, origin: e.origin }
    })
    on('store.get', async (_$, e) => {
      this.effects.push({ op: 'store.get', key: e.key })
      await this.barrier?.('store.get', e.key)
      return this.failure === 'store.get' ? { deny: 'fixture get failure' } : { value: this.store.get(e.key) }
    })
    on('store.set', async (_$, e) => {
      this.effects.push({ op: 'store.set', key: e.key, value: e.value })
      await this.barrier?.('store.set', e.key, e.value)
      if (this.failure === 'store.set') return { deny: 'fixture store quota or write failure' }
      const candidate = Object.fromEntries(this.store)
      candidate[e.key] = e.value
      if (new TextEncoder().encode(JSON.stringify(candidate)).length > this.storeLimitBytes) return { deny: 'fixture store quota exceeded' }
      this.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
    on('fs.write', async (_$, e) => {
      this.effects.push({ op: 'fs.write', key: e.path, value: e.text })
      await this.barrier?.('fs.write', e.path, e.text)
      if (this.failure === 'fs.write') return { deny: 'fixture write failure' }
      if (e.path !== this.signalPath()) return { deny: 'not the current session signal' }
      // El host le niega $.clock.now a un hook de test: la fecha del archivo sale de la que escribió el mod con el reloj simulado.
      const parsed = (() => { try { return JSON.parse(e.text) as { updated_at?: unknown } } catch { return {} } })()
      const now = typeof parsed.updated_at === 'number' ? parsed.updated_at : 0
      for (const directory of [`${REAL_ROOT}/.sdd-ai/hooks`, `${REAL_ROOT}/.sdd-ai/hooks/notifications`]) this.entries.set(directory, { kind: 'dir' })
      this.entries.set(e.path, { kind: 'file', text: e.text, mtimeMs: now })
      return { value: undefined }
    })
  }
  terminal(id = 'run', overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return pending(id, this.session, { session_family: known('claude'), delivery: known({ round: null, launch: null }), ...overrides })
  }
  records(): NotificationRecord[] { return [...this.store.values()] as NotificationRecord[] }
}

/** Barrera explícita: el test sabe cuándo llegó y decide cuándo continúa. */
export function notificationBarrier() {
  let arrived = () => {}
  let release = () => {}
  const reached = new Promise<void>(resolve => { arrived = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  return { reached, release, wait: () => { arrived(); return held } }
}
