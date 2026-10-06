import type { On } from 'claude-code'

// El motor de prueba no deja que un test llame a `$.state` ni a `$.ui.open`, `$.ui.close` o `$.ui.panes`: solo el
// módulo del mod puede. Estos fixtures dan, con hooks, lo que el test necesita: un registro de panes que hace de
// fondo de esas tres llamadas, y un grabador del estado que el mod escribe, con siembra de lo que debe encontrar.

export interface FixturePane { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

/**
 * El registro de panes del motor, como fondo de `ui.open`, `ui.close` y `ui.panes`. Abrir un id nuevo lo deja
 * mostrado y al frente; abrir uno que ya está abierto solo lo retitula, como el motor real; cerrar lo quita. `preopen` simula un pane que quedó de una carga anterior, `personClose` el cierre de
 * la persona (Escape o el botón) y `cover` otro pane al frente. Con `guard`, además rechaza cualquier apertura o
 * cierre fuera de los dos panes del mod, una apertura sin `closeOnEscape` o con foco: es la guarda de efectos del panel,
 * en el mismo hook porque el motor no admite dos del mismo evento.
 */
export function paneRegistry(on: On, options: { unplaced?: () => boolean; guard?: boolean } = {}) {
  const panes = new Map<string, FixturePane>()
  const effects: string[] = []
  const front = (id: string) => { for (const pane of panes.values()) pane.isShown = pane.id === id }
  const own = (id: string) => id === 'sdd-panel' || id === 'sdd-runs'
  on('ui.open', (_$, e) => {
    if (options.guard && (!own(e.id) || e.closeOnEscape !== true || e.focus !== undefined)) throw new Error('Apertura fuera del pane autorizado.')
    effects.push(`open:${e.id}`)
    if (options.unplaced?.()) {
      panes.set(e.id, { id: e.id, title: e.title ?? e.id, isShown: false, isFocused: false, isPlaced: false })
      return { value: { isPlaced: false, reason: 'fixture: terminal sin lugar' } }
    }
    // Como el motor: abrir un id que ya está abierto solo lo retitula, no lo trae al frente.
    const existing = panes.get(e.id)
    if (existing?.isPlaced === false) return { value: { isPlaced: false, reason: 'fixture: terminal sin lugar' } }
    if (existing) {
      existing.title = e.title ?? existing.title
      return { value: { isPlaced: true } }
    }
    panes.set(e.id, { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: e.focus === true, isPlaced: true })
    front(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    if (options.guard && !own(e.id)) throw new Error('Cierre fuera del pane autorizado.')
    effects.push(`close:${e.id}`)
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes.values()].map((pane) => ({ ...pane })) }))
  return {
    effects,
    list: (): FixturePane[] => [...panes.values()].map((pane) => ({ ...pane })),
    find: (id: string): FixturePane | undefined => panes.get(id),
    preopen: (id: string, title: string) => { panes.set(id, { id, title, isShown: true, isFocused: false, isPlaced: true }); front(id) },
    personClose: (id: string) => { panes.delete(id) },
    cover: (id: string) => { const pane = panes.get(id); if (pane) pane.isShown = false },
  }
}

/** Las claves del estado del mod, tal como las declara su contrato de tipos. */
export type ModStateKey = 'attribution' | 'band' | 'notification' | 'persisted' | 'views'

type Address = { value?: unknown; id?: string }
type Handlers = {
  set: <E extends Address, R>(e: E, next: (e: E) => R) => R | { deny: string }
  get?: <E extends Address, R>(e: E, next: (e: E) => R) => R | { value: { value: never; version: number } }
}

// El matcher de `state.set` y `state.get` está tipado por clave: cada una se registra con su literal.
function hookKey(on: On, key: ModStateKey, handlers: Handlers): void {
  const { set, get } = handlers
  switch (key) {
    case 'attribution':
      on('state.set', { plugin: 'sdd-ai-mod', key: 'attribution' }, (_$, e, next) => set(e, next))
      if (get) on('state.get', { plugin: 'sdd-ai-mod', key: 'attribution' }, (_$, e, next) => get(e, next))
      return
    case 'band':
      on('state.set', { plugin: 'sdd-ai-mod', key: 'band' }, (_$, e, next) => set(e, next))
      if (get) on('state.get', { plugin: 'sdd-ai-mod', key: 'band' }, (_$, e, next) => get(e, next))
      return
    case 'notification':
      on('state.set', { plugin: 'sdd-ai-mod', key: 'notification' }, (_$, e, next) => set(e, next))
      if (get) on('state.get', { plugin: 'sdd-ai-mod', key: 'notification' }, (_$, e, next) => get(e, next))
      return
    case 'persisted':
      on('state.set', { plugin: 'sdd-ai-mod', key: 'persisted' }, (_$, e, next) => set(e, next))
      if (get) on('state.get', { plugin: 'sdd-ai-mod', key: 'persisted' }, (_$, e, next) => get(e, next))
      return
    case 'views':
      on('state.set', { plugin: 'sdd-ai-mod', key: 'views' }, (_$, e, next) => set(e, next))
      if (get) on('state.get', { plugin: 'sdd-ai-mod', key: 'views' }, (_$, e, next) => get(e, next))
      return
  }
}

/**
 * Lo que el mod escribe en una clave de su estado: el último valor que llegó a `state.set` y todos los escritos, en
 * orden. Con `seed`, la clave arranca con ese valor hasta la primera escritura del mod, como si lo hubiera dejado una
 * carga anterior; con `seedIds`, lo mismo para los miembros de una familia (`id`). Con `deny`, una escritura se
 * rechaza mientras devuelva `true`. Es el único hook de `state.set` y `state.get` de esa clave en el test.
 */
export function stateRecorder<T>(on: On, key: ModStateKey, options: { seed?: T; seedIds?: Record<string, T>; deny?: () => boolean } = {}) {
  const writes: T[] = []
  const written = new Set<string>()
  let current: { value: T } | null = options.seed === undefined ? null : { value: options.seed }
  const seeded = options.seed !== undefined || options.seedIds !== undefined
  hookKey(on, key, {
    set: (e, next) => {
      if (options.deny?.()) return { deny: 'fixture: estado no disponible' }
      writes.push(e.value as T)
      written.add(e.id ?? '')
      if (e.id === undefined) current = { value: e.value as T }
      return next(e)
    },
    ...(seeded ? {
      get: (e, next) => {
        if (written.has(e.id ?? '')) return next(e)
        const value = e.id === undefined ? options.seed : options.seedIds?.[e.id]
        // Un resultado de `$.state.get` va envuelto: `{ value }` con la lectura `{ value, version }` adentro.
        return value === undefined ? next(e) : { value: { value: value as never, version: 1 } }
      },
    } : {}),
  })
  return {
    writes,
    value: (): T | undefined => current?.value,
  }
}
