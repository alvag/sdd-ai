import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { readHeader } from '../src/sdd/markdown.ts'
import { answer, cli, fixture, logged, snapshot, type Fixture } from './sdd-approve-fixture.ts'

/** Congela la primera lectura de ambos comandos antes de liberar su competencia por el lock. */
async function race(f: Fixture, gates: string[]) {
  const release = join(f.sessionDir, 'release')
  const source = join(import.meta.dirname, '..', 'src')
  const program = `
    import fs from 'node:fs';
    import { approve } from ${JSON.stringify(pathToFileURL(join(source, 'sdd/approve.ts')).href)};
    import { readFlow } from ${JSON.stringify(pathToFileURL(join(source, 'sdd/read.ts')).href)};
    import { prove } from ${JSON.stringify(pathToFileURL(join(source, 'approval/proof.ts')).href)};
    const [root, gate, ready, release] = process.argv.slice(1);
    let first = true;
    const read = (root, id) => {
      const result = readFlow(root, id);
      if (first) {
        first = false; fs.writeFileSync(ready, 'ready');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(release)) {
          if (Date.now() > deadline) throw new Error('barrera agotada');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return result;
    };
    try { const out = approve(root, 'f', gate, new Date(), read, prove, process.env); console.log(JSON.stringify({ code: 0, out })); }
    catch (e) { console.log(JSON.stringify({ code: 2, out: { code: e.code, message: e.message } })); }
  `
  const children = gates.map((gate, i) => {
    const ready = join(f.sessionDir, `ready-${i}`)
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.root, gate, ready, release], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const done = new Promise<any>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => {
        try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
      })
    })
    // El rechazo temprano se observa al finalizar, sin unhandled rejection.
    void done.catch(() => {})
    return { child, ready, done }
  })
  try {
    const deadline = Date.now() + 10000
    while (!children.every((c) => existsSync(c.ready))) {
      assert.ok(Date.now() < deadline, 'ambos intentos deben observar el registro antes de competir')
      assert.ok(children.every((c) => c.child.exitCode === null), 'un intento terminó antes de la barrera')
      await sleep(10)
    }
    writeFileSync(release, 'release')
    // Con plazo propio: si un intento se cuelga, el finally lo mata en vez de dejar colgado el archivo.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('los intentos no terminaron en 30 s')), 30000) })
    try {
      return await Promise.race([Promise.all(children.map((c) => c.done)), timeout])
    } finally { clearTimeout(timer) }
  } finally {
    for (const c of children) if (c.child.exitCode === null) c.child.kill()
  }
}

test('intentos concurrentes conservan decisiones el perdedor recibe decision_conflict y el reintento sincroniza sin cambiar mtimes', async () => {
  for (const gates of [['spec', 'spec'], ['spec', 'plan']]) {
    const f = fixture('completa')
    try {
      // El plan arranca en planned: acredita la spec por el header, pero el gate plan solo queda
      // acreditado si su aprobación se registra y la sincronización lo lleva a plan-approved.
      for (const gate of new Set(gates)) answer(f, gate)
      const results = await race(f, gates)
      const winners = results.filter((r) => r.code === 0)
      if (gates[0] === gates[1]) {
        assert.equal(winners.length, 1, JSON.stringify(results))
        assert.equal(results.find((r) => r.code !== 0)?.out.code, 'decision_conflict')
        assert.equal(logged(f).length, 1)
      } else {
        assert.equal(winners.length, 2, JSON.stringify(results))
        assert.deepEqual(logged(f).map((a) => a.gate).sort(), ['plan', 'spec'])
      }
      const h = readHeader(readFileSync(join(f.dir, 'handoff.md'), 'utf8'))
      assert.ok(h.ok)
      assert.equal(h.data.spec_approved_at, logged(f).find((a) => a.gate === 'spec')!.at)
      const plan = readHeader(readFileSync(join(f.dir, 'plan.md'), 'utf8'))
      assert.ok(plan.ok)
      assert.equal(plan.data.status, gates.includes('plan') ? 'plan-approved' : 'planned')
      const status = cli(f, 'status', 'f').out
      for (const gate of new Set(gates)) assert.equal(status.gates.find((g: any) => g.gate === gate).state, 'approved')
      assert.ok(!status.notes.some((n: any) => n.code === 'header_behind'))
      const before = snapshot(f)
      for (const gate of new Set(gates)) assert.equal(cli(f, 'approve', 'f', gate).code, 0)
      assert.deepEqual(snapshot(f), before)
    } finally { f.cleanup() }
  }
})
