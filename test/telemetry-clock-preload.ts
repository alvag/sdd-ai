const OriginalDate = Date
const offset = Number(process.env.SDD_AI_TEST_CLOCK_OFFSET_MS ?? 0)
/** Desplaza el reloj sin congelarlo y conserva los constructores con fecha explícita. */
globalThis.Date = new Proxy(OriginalDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 ? [OriginalDate.now() + offset] : args, newTarget)
  },
  get(target, key, receiver) {
    if (key === 'now') return () => OriginalDate.now() + offset
    return Reflect.get(target, key, receiver)
  },
})
