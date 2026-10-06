import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chainFlow, chainSetup, fakeCalls, runBin } from './helpers.ts'
import { storeOf, controlOf, implReport, fixReport, markAll, classesFile, registry } from './chain-cli-fixture.ts'

test('la toma declara el arbol y cierra la cadena del writer', () => {
  const s = chainSetup({ writers: [{ actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) }] })
  chainFlow(s)
  const first = runBin(s, ['sdd', 'phase', 'f'])
  runBin(s, ['wait', first.out.id, '--max', '30'])
  markAll(s)
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.green, false)
  // El conductor corrige a mano: verify no corre sobre un árbol que no declaró.
  writeFileSync(join(s.repo, 'src', 'a.ts'), 'export const f = () => 2\n')
  const refused = runBin(s, ['sdd', 'verify', 'f'])
  assert.deepEqual([refused.code, refused.out.code, refused.out.detail], [2, 'tree_not_harvest', 'src/a.ts'], JSON.stringify(refused.out))
  assert.match(refused.out.next, /--takeover/)
  const receipts = () => JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).verify.receipts.length
  assert.equal(receipts(), 1, 'la negativa no publicó ningún recibo')

  const taken = runBin(s, ['sdd', 'verify', 'f', '--takeover', '--reason', 'corregí la suma a mano'])
  assert.equal(taken.out.green, true, JSON.stringify(taken.out))
  const record = () => JSON.parse(readFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), 'utf8')).implement
  let imp = record()
  const [chain] = imp.chains
  assert.deepEqual([chain.entries.at(-1).kind, chain.entries.at(-1).parent, chain.entries.at(-1).reason, chain.terminal.code],
    ['takeover', first.out.id, 'corregí la suma a mano', 'takeover'])
  const receipt = JSON.parse(readFileSync(join(s.repo, '.git', 'sdd-ai', 'verify', taken.out.receipt, 'receipt.json'), 'utf8'))
  assert.equal(receipt.writer.takeover, chain.entries.at(-1).id)

  // Una edición nueva exige otra toma, encadenada a la anterior.
  writeFileSync(join(s.repo, 'src', 'a.ts'), 'export const f = () => 5\n')
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'tree_not_harvest')
  const second = runBin(s, ['sdd', 'verify', 'f', '--takeover'])
  assert.equal(second.out.green, false)
  imp = record()
  assert.deepEqual(imp.chains[0].entries.slice(-2).map((e: { kind: string }) => e.kind), ['takeover', 'takeover'])
  assert.equal(imp.chains[0].entries.at(-1).parent, imp.chains[0].entries.at(-2).id)
  // Con la cadena cerrada por la toma no hay fix: el rojo lo resuelve el conductor.
  const cls = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, second.out.receipt, [['V1', 'implementation']])])
  assert.equal(cls.code, 2, JSON.stringify(cls.out))
  assert.match(cls.out.next, /--takeover/)
  assert.equal(fakeCalls(s).length, 1, 'ningún writer después de la toma')
  // Un mapa de toma alterado o ausente no acredita el árbol: verify no lo puede comparar y se niega.
  const mapFile = join(s.repo, '.git', 'sdd-ai', imp.chains[0].entries.at(-1).map.ref)
  writeFileSync(mapFile, readFileSync(mapFile, 'utf8').replace('{', '{"src/x.ts":"100644 0",'))
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'tree_not_harvest')
  rmSync(mapFile)
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.code, 'tree_not_harvest')

  // Un flujo sin writer de fase no tiene nada que tomar.
  const inline = chainSetup()
  chainFlow(inline)
  markAll(inline)
  assert.equal(runBin(inline, ['sdd', 'verify', 'f', '--takeover']).out.code, 'usage')
})

test('orienta de cosecha a verify y revisa solo el verde vigente', () => {
  const s = chainSetup({
    writers: [
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 3\n' }], report: implReport(['T1']) },
      { actions: [{ write: 'src/a.ts', content: 'export const f = () => 2\n' }], report: fixReport(['V1']) },
    ],
  })
  chainFlow(s)
  const status = () => runBin(s, ['sdd', 'status', 'f']).out.next
  const first = runBin(s, ['sdd', 'phase', 'f'])
  const w1 = runBin(s, ['wait', first.out.id, '--max', '30'])
  // Una cosecha completa va a verify, no a la revisión.
  assert.match(w1.out.next, /sdd verify f/)
  assert.doesNotMatch(w1.out.next, /review start/)
  assert.match(status().detail, /marca en tasks.md las tasks acreditadas \(T1\)/)
  markAll(s)
  assert.deepEqual([status().step, status().command], ['verify', './bin/sdd-ai sdd verify f'])
  const red = runBin(s, ['sdd', 'verify', 'f'])
  // Un rojo va a clasificar y resolver, nunca a la revisión.
  const afterRed = status()
  assert.deepEqual([afterRed.step, afterRed.command], ['verify', `./bin/sdd-ai sdd phase f --classes .plans/f/classes-${red.out.receipt}.json`], JSON.stringify(afterRed))
  // Con las propuestas y la plantilla del archivo de clases.
  assert.match(afterRed.detail, /V1: implementation/)
  assert.match(afterRed.detail, /plantilla: /)
  assert.doesNotMatch(JSON.stringify(afterRed), /review start/)
  const fix = runBin(s, ['sdd', 'phase', 'f', '--classes', classesFile(s, red.out.receipt, [['V1', 'implementation']])])
  const w2 = runBin(s, ['wait', fix.out.id, '--max', '30'])
  assert.match(w2.out.next, /sdd verify f/)
  assert.doesNotMatch(w2.out.next, /review start/)
  assert.equal(runBin(s, ['sdd', 'verify', 'f']).out.green, true)
  // El verde vigente propone una sola revisión, del candidato acumulado de la última cosecha.
  const green = status()
  assert.deepEqual([green.step, green.command], ['review_and_commit', `./bin/sdd-ai review start --harvest ${fix.out.id} --base ${s.base} --author codex --flow f`], JSON.stringify(green))
  // Sin el control del writer no hay comando de revisión que armar: la consulta dice qué falta.
  const fixControl = join(storeOf(s, fix.out.id), 'control.json')
  const saved = readFileSync(fixControl, 'utf8')
  writeFileSync(fixControl, '{')
  const noControl = status()
  assert.match(noControl.detail ?? '', /no se pudo leer el control/, JSON.stringify(noControl))
  assert.equal(noControl.command, undefined)
  writeFileSync(fixControl, saved)
  // Si la cadena no se puede leer, las consultas lo dicen en vez de proponer el comando de un writer suelto.
  writeFileSync(join(s.repo, '.plans', 'f', 'sdd-ai-phases.json'), '{')
  const broken = status()
  assert.match(broken.detail ?? '', /no se pudo leer la cadena del writer/, JSON.stringify(broken))
  assert.doesNotMatch(JSON.stringify(broken), /review start/)
  assert.match(runBin(s, ['wait', fix.out.id, '--max', '30']).out.next, /revisa el registro de fases/)
})

test('cancel no marca como fallida una corrida que llego a su control mientras esperaba el lock', async () => {
  const { spawn } = await import('node:child_process')
  const s = chainSetup({ writers: [{ hang: true, report: implReport(['T1']) }] })
  chainFlow(s)
  const run = runBin(s, ['sdd', 'phase', 'f']).out.id
  // El supervisor registra el grupo del writer en el control: hasta entonces, el control es suyo.
  for (let i = 0; i < 100 && controlOf(s, run).group === undefined; i++) await new Promise((done) => setTimeout(done, 50))
  assert.ok(controlOf(s, run).group, 'el writer quedó lanzado')
  // La corrida se ve como una entrada sin control: su control se aparta mientras otro proceso tiene el lock del flujo.
  const control = join(storeOf(s, run), 'control.json')
  renameSync(control, `${control}.aparte`)
  const flag = join(mkdtempSync(join(tmpdir(), 'sdd-ai-hold-')), 'soltar')
  const lockTs = join(import.meta.dirname, '..', 'src', 'lock.ts')
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { withLock } from ${JSON.stringify(lockTs)}
import { existsSync } from 'node:fs'
const until = Date.now() + 60000
withLock(${JSON.stringify(join(s.repo, '.plans', 'f', 'sdd-ai-approvals.lock'))}, () => new Error('ocupado'), () => {
  process.stdout.write('tomado\\n')
  while (!existsSync(${JSON.stringify(flag)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
})`])
  // La señal puede llegar partida, y el proceso puede terminar antes de darla: en ese caso la prueba falla.
  await new Promise<void>((done, fail) => {
    let seen = ''
    holder.stdout.on('data', (b: Buffer) => { seen += b.toString('utf8'); if (seen.includes('tomado')) done() })
    holder.on('exit', (code) => fail(new Error(`el proceso que toma el lock terminó antes de tomarlo (${code})`)))
  })
  const out: Buffer[] = []
  const cancel = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'sdd-ai'), 'cancel', run], { cwd: s.repo, env: s.env })
  cancel.stdout.on('data', (b: Buffer) => out.push(b))
  const exited = new Promise<void>((done) => cancel.on('close', () => done()))
  // Quien espera un lock deja su archivo `<lock>.<pid>.<azar>.tmp` junto a él: cuando aparece el de cancel, ya
  // vio la entrada sin control y espera. Recién ahí el lanzamiento termina y deja su control.
  const waiting = () => readdirSync(join(s.repo, '.plans', 'f')).some((f) => f.startsWith(`sdd-ai-approvals.lock.${cancel.pid}.`))
  try {
    for (let i = 0; i < 200 && !waiting(); i++) await new Promise((done) => setTimeout(done, 25))
    assert.ok(waiting(), 'cancel quedó esperando el lock del flujo')
    renameSync(`${control}.aparte`, control)
  } finally {
    // También si la prueba falla: el lock se suelta y el control vuelve a su lugar.
    if (existsSync(`${control}.aparte`)) renameSync(`${control}.aparte`, control)
    writeFileSync(flag, '')
  }
  await exited
  const result = JSON.parse(Buffer.concat(out).toString('utf8'))
  assert.notEqual(result.state, 'launch_failed', JSON.stringify(result))
  assert.deepEqual(registry(s).implement.events, [])
  runBin(s, ['wait', run, '--max', '30'])
})
