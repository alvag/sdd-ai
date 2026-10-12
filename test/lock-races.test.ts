import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { awaitObservation, ownProcesses, processState, withOwned } from './scenario-readiness.ts'

const lockModule = join(import.meta.dirname, '..', 'src', 'lock.ts')

// Los scripts y señales pertenecen solo a este escenario; el runtime usa el ps de su PATH.
function scenario() {
  const owned = ownProcesses()
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-lock-races-'))
  owned.directory(dir)
  const lock = join(dir, 'object.lock')
  const events = join(dir, 'events')
  const allow = join(dir, 'allow-ps')
  const targets = join(dir, 'targets')
  const ps = join(dir, 'ps')
  const psScript = join(dir, 'ps.mjs')
  writeFileSync(ps, `#!/bin/sh\nexec "${process.execPath}" "${psScript}" "$@"\n`, { mode: 0o755 })
  writeFileSync(psScript, `
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const pid = Number(args.at(-1))
const targets = JSON.parse(readFileSync(${JSON.stringify(targets)}, 'utf8'))
if (targets.includes(pid)) {
  appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: 'query', target: pid, pid: process.pid }) + '\\n')
  if (pid === targets[0]) {
    const deadline = Date.now() + 30000
    while (!existsSync(${JSON.stringify(allow)})) {
      if (Date.now() >= deadline) throw new Error('ps barrier timeout')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}
const result = spawnSync('/bin/ps', args, { encoding: 'utf8' })
process.stdout.write(result.stdout ?? '')
process.exit(result.status ?? 1)
`)
  const signals: string[] = [allow]
  owned.terminate(() => { for (const signal of signals) writeFileSync(signal, '') })
  const observed = () => existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; target?: number; pid: number }) : []
  function launch(body: string, controlled = false) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { withLock } from ${JSON.stringify(lockModule)}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const event = (event) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event, pid: process.pid }) + '\\n')
${body}
`], { env: { ...process.env, ...(controlled ? { PATH: `${dir}:${process.env.PATH ?? ''}` } : {}) } })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    let terminal: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let error: Error | undefined
    const completed = new Promise<void>((resolve) => {
      child.on('error', (e) => { error = e; resolve() })
      child.on('close', (code, signal) => { terminal = { code, signal }; resolve() })
    })
    if (child.pid) owned.add(child.pid)
    owned.completion(() => completed)
    const state = () => ({ terminal, stderr, error: error?.message })
    const running = () => {
      if (error) throw error
      assert.equal(terminal, undefined, `terminación prematura: ${JSON.stringify(state())}`)
    }
    const finish = () => awaitObservation('terminación del hijo', () => {
      if (error) throw error
      return { value: terminal, detail: state() }
    })
    return { pid: child.pid!, state, running, finish }
  }
  async function holder(name: string, persistent = false) {
    const release = join(dir, `release-${name}`)
    signals.push(release)
    const child = launch(`
withLock(${JSON.stringify(lock)}, () => new Error('busy'), () => {
  event('held')
  const deadline = Date.now() + 60000
  while (!existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error('holder barrier timeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  ${persistent ? 'process.exit(0)' : ''}
})
event('released')
`)
    await awaitObservation(`titular ${name} tomó el lock`, () => {
      child.running()
      return { value: observed().some((e) => e.event === 'held' && e.pid === child.pid) ? true : undefined, detail: observed() }
    })
    const identity = JSON.parse(readFileSync(lock, 'utf8'))
    assert.equal(identity.pid, child.pid)
    assert.equal(typeof identity.lstart, 'string')
    return {
      ...child,
      async release() {
        appendFileSync(events, JSON.stringify({ event: 'release_requested', pid: child.pid }) + '\n')
        writeFileSync(release, '')
        assert.deepEqual(await child.finish(), { code: 0, signal: null })
        await awaitObservation(`cese del titular ${name}`, () => ({ value: processState(child.pid) === 'gone' ? true : undefined, detail: processState(child.pid) }))
        if (!persistent) {
          assert.ok(observed().some((e) => e.event === 'released' && e.pid === child.pid))
        }
      },
    }
  }
  function contender(pids: number[]) {
    writeFileSync(targets, JSON.stringify(pids))
    return launch(`
withLock(${JSON.stringify(lock)}, () => new Error('busy'), () => event('entered'))
`, true)
  }
  async function query(child: ReturnType<typeof contender>, pid: number) {
    await awaitObservation(`consulta ps del titular ${pid}`, () => {
      child.running()
      const match = observed().find((e) => e.event === 'query' && e.target === pid)
      // Solo la consulta del primer target queda detenida y hay que limpiarla; las demás terminan enseguida
      // y su PID puede no existir ya al acreditarlo.
      if (match && pid === JSON.parse(readFileSync(targets, 'utf8'))[0]) owned.add(match.pid)
      return { value: match, detail: { events: observed(), child: child.state() } }
    })
  }
  const entries = () => observed().filter((e) => e.event === 'entered')
  return { owned, lock, allow, targets, holder, contender, query, entries, observed }
}

test('la adquisición relee el lock cuando el titular termina durante ps', async () => {
  const s = scenario()
  await withOwned(s.owned, async () => {
    const a = await s.holder('A')
    const contender = s.contender([a.pid])
    await s.query(contender, a.pid)
    assert.equal(s.entries().length, 0)
    await a.release()
    assert.equal(existsSync(s.lock), false)
    writeFileSync(s.allow, '')
    assert.deepEqual(await contender.finish(), { code: 0, signal: null })
    assert.deepEqual(s.entries().map((e) => e.pid), [contender.pid])
  })
})

test('un titular válido muerto cuyo lock permanece rechaza sin borrarlo', async () => {
  const s = scenario()
  await withOwned(s.owned, async () => {
    const a = await s.holder('persistent', true)
    const initial = readFileSync(s.lock, 'utf8')
    await a.release()
    const contender = s.contender([])
    const result = await contender.finish()
    assert.notEqual(result.code, 0)
    assert.equal(result.signal, null)
    assert.match(contender.state().stderr, /Error: busy/)
    assert.equal(s.entries().length, 0)
    assert.equal(readFileSync(s.lock, 'utf8'), initial)
  })
})

test('la adquisición reevalúa al nuevo titular y entra después de su liberación', async () => {
  const s = scenario()
  await withOwned(s.owned, async () => {
    const a = await s.holder('A')
    const contender = s.contender([a.pid])
    await s.query(contender, a.pid)
    await a.release()
    assert.equal(existsSync(s.lock), false)
    const b = await s.holder('B')
    // El ps detenido ya leyó A; las consultas siguientes también publican B.
    writeFileSync(s.targets, JSON.stringify([a.pid, b.pid]))
    writeFileSync(s.allow, '')
    await s.query(contender, b.pid)
    assert.equal(s.entries().length, 0)
    assert.equal(JSON.parse(readFileSync(s.lock, 'utf8')).pid, b.pid)
    await b.release()
    assert.deepEqual(await contender.finish(), { code: 0, signal: null })
    assert.deepEqual(s.entries().map((e) => e.pid), [contender.pid])
    const events = s.observed()
    assert.ok(events.findIndex((e) => e.event === 'release_requested' && e.pid === b.pid) < events.findIndex((e) => e.event === 'entered'))
  })
})
