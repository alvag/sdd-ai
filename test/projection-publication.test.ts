import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { publishNow, publishProjection, readBootId, systemBootId } from '../src/projection.ts'
import type { ProjectionPublicationOptions } from '../src/projection.ts'
import { CLAIM_NAME, OBSERVATION_NAME, validateProjection } from '../src/projection-types.ts'
import { fixtureJson, latestProjection, observation, OTHER_BOOT, projectionDocument, projectionFixture, projectionRun, publicationScript, publicationTrace, TEST_BOOT, TEST_TIME } from './projection-fixture.ts'

type Fixture = ReturnType<typeof projectionFixture>
const live = (f: Fixture) => join(f.root, '.sdd-ai', 'projection', 'live')
function publish(f: Fixture, ids: string[] = [], options: ProjectionPublicationOptions = {}) {
  const before = process.cwd()
  const result = publishProjection(f.root, (root, stamp) => {
    assert.equal(process.cwd(), before, 'la lectura de fuentes no cambia el directorio de trabajo')
    const document = projectionDocument(root, stamp)
    document.runs.items = ids.map((id) => projectionRun(id))
    return document
  }, { boot: () => TEST_BOOT, ...options })
  assert.equal(process.cwd(), before, 'el publicador restaura el directorio de trabajo')
  return result
}
const ids = (f: Fixture) => latestProjection(f.root)?.runs.items.map((run) => run.id)
function monotonic(start = 100_000_000_000n): () => bigint { let value = start; return () => ++value }
function writeObservation(f: Fixture, stamp: ReturnType<typeof observation>, run = 'older'): string {
  mkdirSync(live(f), { recursive: true })
  const document = projectionDocument(f.root, stamp)
  document.runs.items = [projectionRun(run)]
  const path = join(live(f), stamp.id)
  fixtureJson(path, document)
  return path
}

test('concurrent publication converges within budget across stale publication suspension termination quarantine wall clock jumps and directory swaps', async (t) => {
  await t.test('boot identifiers use the local platform and failure prevents publication', () => {
    assert.equal(readBootId('linux', (path) => { assert.equal(path, '/proc/sys/kernel/random/boot_id'); return TEST_BOOT + '\n' }), TEST_BOOT)
    assert.equal(readBootId('darwin', () => { throw new Error('Linux reader used') }, () => OTHER_BOOT.toUpperCase() + '\n'), OTHER_BOOT)
    assert.equal(readBootId('linux', () => { throw new Error('permission') }), null)
    assert.equal(readBootId('darwin', () => '', () => 'invalid'), null)
    assert.equal(readBootId('unknown'), null)
    assert.match(systemBootId() ?? '', /^[0-9a-f-]{36}$/)
    const f = projectionFixture()
    try {
      let reads = 0
      const before = process.cwd()
      assert.deepEqual(publishProjection(f.root, () => { reads++; throw new Error('must not read') }, { boot: () => null }), { kind: 'not_published', cause: 'boot_unavailable' })
      assert.equal(reads, 0); assert.equal(existsSync(live(f)), false); assert.equal(process.cwd(), before)
    } finally { f.dispose() }
  })

  await t.test('publication ignores the store in Git without replacing an existing ignore file', () => {
    const f = projectionFixture()
    try {
      assert.equal(publish(f, ['one']).kind, 'published')
      assert.equal(readFileSync(join(f.root, '.sdd-ai', '.gitignore'), 'utf8'), '*\n')
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.root, encoding: 'utf8' })
      assert.equal(status, '', 'las observaciones no aparecen como archivos sin seguimiento')
      writeFileSync(join(f.root, '.sdd-ai', '.gitignore'), 'propio\n')
      assert.equal(publish(f, ['two']).kind, 'published')
      assert.equal(readFileSync(join(f.root, '.sdd-ai', '.gitignore'), 'utf8'), 'propio\n')
    } finally { f.dispose() }
  })

  await t.test('publication preserves complete JSON and orders equal timestamps by the remaining filename', () => {
    const f = projectionFixture()
    try {
      for (let i = 0; i < 20; i++) {
        const result = publish(f, [`run-${i}`])
        assert.equal(result.kind, 'published')
        assert.equal(validateProjection(latestProjection(f.root)).ok, true)
        assert.deepEqual(ids(f), [`run-${i}`])
      }
      const one = observation(1n, TEST_BOOT, 'a'.repeat(32))
      const two = observation(1n, TEST_BOOT, 'b'.repeat(32))
      rmSync(live(f), { recursive: true }); mkdirSync(live(f))
      writeObservation(f, two, 'tie-b'); writeObservation(f, one, 'tie-a')
      assert.deepEqual(ids(f), ['tie-b'])
      const samples = [0n, 1n, 2n, 3n]
      assert.equal(publish(f, ['same-m0'], { monotonic: () => samples.shift() ?? 3n }).kind, 'published')
      const names = readdirSync(live(f)).filter((name) => OBSERVATION_NAME.test(name)).sort()
      assert.ok(names.filter((name) => name.startsWith('obs-00000000000000000001-')).length >= 2)
      assert.equal(new Set(names).size, names.length)
    } finally { f.dispose() }
  })

  await t.test('a stopped publisher cannot resurrect a closed run or lose another entity update', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['closing'])
      const barrier = f.barrier('slow')
      const slow = f.start(publicationScript(f.root, source, { barrier: barrier.path }))
      await barrier.arrived()
      slow.child.kill('SIGSTOP')
      fixtureJson(source, ['new-entity'])
      assert.equal(publish(f, ['new-entity']).kind, 'published')
      barrier.release(); slow.child.kill('SIGCONT')
      const done = await slow.done
      assert.equal(done.code, 0, done.stderr)
      assert.deepEqual(ids(f), ['new-entity'])
      assert.equal(validateProjection(latestProjection(f.root)).ok, true)
    } finally { f.dispose() }
  })

  await t.test('podar un temporal envejecido obliga al publicador reanudado a observar de nuevo', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['old'])
      const offset = join(f.scratch, 'offset'); writeFileSync(offset, '0')
      const barrier = f.barrier('temporary')
      const slow = f.start(publicationScript(f.root, source, { barrier: barrier.path, stage: 'temporary', offset }))
      await barrier.arrived(); slow.child.kill('SIGSTOP')
      fixtureJson(source, ['new'])
      // Se adelanta el mismo reloj inyectado en los dos procesos: no requiere esperar un minuto real.
      const advance = 61_000_000_000n; writeFileSync(offset, String(advance))
      assert.equal(publish(f, ['new'], { monotonic: () => process.hrtime.bigint() + advance }).kind, 'published')
      assert.equal(readdirSync(live(f)).some((name) => name.startsWith('tmp-')), false)
      barrier.release(); slow.child.kill('SIGCONT')
      const done = await slow.done
      assert.equal(done.code, 0, done.stderr)
      assert.deepEqual(ids(f), ['new'])
    } finally { f.dispose() }
  })

  await t.test('interleaved changes to independent entities survive a publication that finishes late', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['entity-a-old', 'entity-b-old'])
      const barrier = f.barrier('interleaved')
      const first = f.start(publicationScript(f.root, source, { barrier: barrier.path }))
      await barrier.arrived()
      fixtureJson(source, ['entity-a-new', 'entity-b-old'])
      assert.equal(publish(f, ['entity-a-new', 'entity-b-old']).kind, 'published')
      fixtureJson(source, ['entity-a-new', 'entity-b-new'])
      const second = f.start(publicationScript(f.root, source))
      const secondDone = await second.done
      assert.equal(secondDone.code, 0, secondDone.stderr)
      barrier.release()
      const firstDone = await first.done
      assert.equal(firstDone.code, 0, firstDone.stderr)
      assert.deepEqual(ids(f), ['entity-a-new', 'entity-b-new'])
    } finally { f.dispose() }
  })

  await t.test('two processes publish equal m0 observations without overwriting either file', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['shared'])
      const firstBarrier = f.barrier('equal-first'); const secondBarrier = f.barrier('equal-second')
      const m0 = '100000000002'
      const first = f.start(publicationScript(f.root, source, { barrier: firstBarrier.path, m0 }))
      const second = f.start(publicationScript(f.root, source, { barrier: secondBarrier.path, m0 }))
      await Promise.all([firstBarrier.arrived(), secondBarrier.arrived()])
      secondBarrier.release(); const secondDone = await second.done
      firstBarrier.release(); const firstDone = await first.done
      assert.equal(firstDone.code, 0, firstDone.stderr); assert.equal(secondDone.code, 0, secondDone.stderr)
      const names = readdirSync(live(f)).filter((name) => OBSERVATION_NAME.test(name)).sort()
      assert.equal(names.length, 2)
      for (const name of names) {
        assert.equal(OBSERVATION_NAME.exec(name)![1], m0.padStart(20, '0'))
        assert.equal(validateProjection(JSON.parse(readFileSync(join(live(f), name), 'utf8'))).ok, true)
      }
      assert.equal(latestProjection(f.root)?.observation.id, names[1])
      assert.deepEqual(ids(f), ['shared'])
    } finally { f.dispose() }
  })

  await t.test('another publisher pruning while a real temporary is young leaves it usable', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['old'])
      const barrier = f.barrier('young-temporary')
      const first = f.start(publicationScript(f.root, source, { barrier: barrier.path, stage: 'temporary' }))
      await barrier.arrived()
      const temporary = readdirSync(live(f)).find((name) => name.startsWith('tmp-'))
      assert.ok(temporary)
      fixtureJson(source, ['new'])
      assert.equal(publish(f, ['new']).kind, 'published')
      assert.equal(existsSync(join(live(f), temporary)), true)
      barrier.release(); const done = await first.done
      assert.equal(done.code, 0, done.stderr)
      assert.equal(existsSync(join(live(f), temporary)), false)
      assert.deepEqual(ids(f), ['new'])
    } finally { f.dispose() }
  })

  await t.test('wall clock jumps cannot change causal ordering and old boots are pruned', () => {
    const f = projectionFixture()
    try {
      const clock = monotonic()
      writeObservation(f, observation(999_000_000_000n, OTHER_BOOT), 'previous-boot-high')
      writeObservation(f, observation(1n, OTHER_BOOT), 'previous-boot-low')
      assert.equal(publish(f, ['first'], { monotonic: clock, now: () => TEST_TIME + 100000 }).kind, 'published')
      assert.equal(publish(f, ['backward'], { monotonic: clock, now: () => TEST_TIME - 100000 }).kind, 'published')
      assert.deepEqual(ids(f), ['backward'])
      assert.equal(publish(f, ['forward'], { monotonic: clock, now: () => TEST_TIME + 200000 }).kind, 'published')
      assert.deepEqual(ids(f), ['forward'])
      assert.equal(readdirSync(live(f)).some((name) => name.includes(OTHER_BOOT)), false)
    } finally { f.dispose() }
  })

  await t.test('false observations and incompatible contracts do not block a compatible publisher', () => {
    const f = projectionFixture()
    try {
      const old = writeObservation(f, observation(1n), 'false-old')
      const ahead = writeObservation(f, observation(999_000_000_000n), 'false-future')
      const foreign = writeObservation(f, observation(2n), 'incompatible')
      const incompatible = JSON.parse(readFileSync(foreign, 'utf8')); incompatible.schema_version = 999
      fixtureJson(foreign, incompatible)
      assert.equal(publish(f, ['real'], { monotonic: monotonic() }).kind, 'published')
      assert.deepEqual(ids(f), ['real']); assert.equal(existsSync(ahead), false)
      assert.equal(existsSync(old), false)
      assert.equal(validateProjection(latestProjection(f.root)).ok, true)
    } finally { f.dispose() }
  })

  await t.test('pruning preserves recent observations two old observations and young temporaries', () => {
    const f = projectionFixture()
    try {
      const veryOld = writeObservation(f, observation(1n), 'very-old')
      const old = writeObservation(f, observation(2n), 'old')
      const recent = writeObservation(f, observation(99_000_000_000n), 'recent')
      const young = `tmp-${String(99_000_000_000n).padStart(20, '0')}-${TEST_BOOT}-1-${'b'.repeat(32)}`
      const expired = `tmp-${String(1n).padStart(20, '0')}-${TEST_BOOT}-1-${'c'.repeat(32)}`
      writeFileSync(join(live(f), young), 'unlinked'); writeFileSync(join(live(f), expired), 'expired')
      assert.equal(publish(f, ['current'], { monotonic: monotonic() }).kind, 'published')
      assert.equal(existsSync(young), false, 'la prueba no debe cambiar su cwd')
      assert.equal(existsSync(join(live(f), young)), true)
      assert.equal(existsSync(join(live(f), expired)), false)
      assert.equal(existsSync(recent), true); assert.equal(existsSync(old), false); assert.equal(existsSync(veryOld), false)
      rmSync(live(f), { recursive: true }); mkdirSync(live(f))
      writeObservation(f, observation(1n), 'old-one')
      const oldTwo = writeObservation(f, observation(2n), 'old-two')
      assert.equal(publish(f, ['current'], { monotonic: monotonic() }).kind, 'published')
      assert.equal(existsSync(oldTwo), true, 'se conservan las dos observaciones más nuevas aunque sean viejas')
    } finally { f.dispose() }
  })

  await t.test('repair removes irregular entries and quarantines 257 entries without recursive deletion', () => {
    const f = projectionFixture()
    try {
      assert.equal(publish(f).kind, 'published')
      const witness = join(f.scratch, 'witness'); writeFileSync(witness, 'protected')
      symlinkSync(witness, join(live(f), observation(1n).id))
      execFileSync('mkfifo', [join(live(f), 'pipe')])
      writeFileSync(join(live(f), 'foreign'), 'foreign')
      const sub = observation(2n).id; mkdirSync(join(live(f), sub))
      writeFileSync(join(live(f), sub, 'child'), 'keep')
      mkdirSync(join(live(f), 'unrelated-directory'))
      assert.equal(publish(f, ['repaired']).kind, 'published')
      assert.equal(readFileSync(witness, 'utf8'), 'protected')
      assert.equal(existsSync(join(live(f), 'pipe')), false)
      assert.equal(existsSync(join(live(f), 'foreign')), false)
      assert.equal(existsSync(join(live(f), sub)), false)
      assert.ok(readdirSync(live(f)).some((name) => name.startsWith('junk-')))
      assert.equal(existsSync(join(live(f), 'unrelated-directory')), true)
      for (let i = 0; i < 257; i++) writeFileSync(join(live(f), `flood-${i}`), '')
      assert.equal(publish(f, ['after-flood']).kind, 'published')
      assert.deepEqual(ids(f), ['after-flood'])
      const stale = readdirSync(join(f.root, '.sdd-ai', 'projection')).find((name) => name.startsWith('stale-'))
      assert.ok(stale)
      assert.ok(readdirSync(join(f.root, '.sdd-ai', 'projection', stale)).length > 256)
      assert.equal(readFileSync(witness, 'utf8'), 'protected')
    } finally { f.dispose() }
  })

  await t.test('256 previous boot observations are recovered after linking creates the 257th entry', () => {
    const f = projectionFixture()
    try {
      for (let i = 0; i < 256; i++) writeObservation(f, observation(BigInt(i + 1), OTHER_BOOT, i.toString(16).padStart(32, '0')))
      assert.equal(publish(f, ['new-boot'], { monotonic: monotonic() }).kind, 'published')
      assert.deepEqual(ids(f), ['new-boot'])
      assert.equal(readdirSync(live(f)).length, 1)
      assert.ok(readdirSync(join(f.root, '.sdd-ai', 'projection')).some((name) => name.startsWith('stale-')))
    } finally { f.dispose() }
  })

  await t.test('projection and live symlinks are repaired and sdd-ai symlinks are rejected', () => {
    for (const segment of ['projection', 'live', '.sdd-ai']) {
      const f = projectionFixture()
      try {
        assert.equal(publish(f).kind, 'published')
        const target = join(f.scratch, 'outside'); mkdirSync(target)
        const witness = join(target, 'witness'); writeFileSync(witness, 'protected')
        const path = segment === '.sdd-ai' ? join(f.root, segment) : segment === 'projection' ? join(f.root, '.sdd-ai', segment) : live(f)
        renameSync(path, path + '.saved'); symlinkSync(target, path)
        const result = publish(f, ['real'])
        assert.equal(result.kind, segment === '.sdd-ai' ? 'not_published' : 'published')
        assert.deepEqual(readdirSync(target), ['witness']); assert.equal(readFileSync(witness, 'utf8'), 'protected')
        if (segment !== '.sdd-ai') assert.equal(lstatSync(path).isSymbolicLink(), false)
      } finally { f.dispose() }
    }
  })

  await t.test('replacement while holding a verified directory never writes through the symlink', () => {
    for (const segment of ['.sdd-ai', 'projection', 'live']) for (const stage of ['entered', 'temporary', 'linked'] as const) {
      const f = projectionFixture()
      try {
        const target = join(f.scratch, 'outside'); mkdirSync(target); writeFileSync(join(target, 'witness'), 'protected')
        const path = segment === '.sdd-ai' ? join(f.root, segment) : segment === 'projection' ? join(f.root, '.sdd-ai', segment) : live(f)
        const saved = path + '.saved'
        const result = publish(f, ['real'], { stage: (at, context) => {
          if (at !== stage || context.attempt !== 1) return
          renameSync(path, saved)
          symlinkSync(target, path)
        } })
        assert.equal(result.kind, segment === '.sdd-ai' ? 'not_published' : 'published')
        assert.deepEqual(readdirSync(target), ['witness'])
        assert.equal(readFileSync(join(target, 'witness'), 'utf8'), 'protected')
        if (segment === '.sdd-ai') {
          unlinkSync(path); renameSync(saved, path)
          assert.equal(publish(f, ['restored']).kind, 'published')
          assert.deepEqual(ids(f), ['restored'])
        } else assert.deepEqual(ids(f), ['real'])
      } finally { f.dispose() }
    }
  })

  await t.test('a parent of the checkout replaced by a symlink cannot redirect publication mutations', () => {
    for (const stage of ['before', 'entered', 'temporary', 'linked'] as const) {
      const f = projectionFixture()
      const before = process.cwd()
      try {
        const container = join(f.scratch, 'container')
        const root = join(container, 'checkout')
        const outside = join(f.scratch, 'outside')
        const foreignHome = join(outside, 'checkout', '.sdd-ai')
        mkdirSync(join(root, '.sdd-ai'), { recursive: true })
        mkdirSync(foreignHome, { recursive: true })
        writeFileSync(join(foreignHome, 'witness'), 'protected')
        let replaced = false
        const replace = () => {
          renameSync(container, container + '.saved'); symlinkSync(outside, container); replaced = true
        }
        if (stage === 'before') replace()
        const result = publishProjection(root, projectionDocument, { boot: () => TEST_BOOT, stage: (at, context) => {
          if (!replaced && context.attempt === 1 && at === stage) replace()
        } })
        assert.equal(result.kind, 'not_published')
        assert.equal(replaced, true)
        assert.equal(process.cwd(), before)
        assert.deepEqual(readdirSync(foreignHome), ['witness'])
        assert.equal(readFileSync(join(foreignHome, 'witness'), 'utf8'), 'protected')
        unlinkSync(container); renameSync(container + '.saved', container)
        assert.equal(publishProjection(root, projectionDocument, { boot: () => TEST_BOOT }).kind, 'published')
      } finally { f.dispose() }
    }
  })

  await t.test('files and FIFOs in place of projection or live are repaired without reading them', () => {
    for (const segment of ['projection', 'live']) for (const kind of ['file', 'fifo']) {
      const f = projectionFixture()
      try {
        assert.equal(publish(f, ['old']).kind, 'published')
        const path = segment === 'projection' ? join(f.root, '.sdd-ai', segment) : live(f)
        renameSync(path, path + '.saved')
        if (kind === 'file') writeFileSync(path, 'private unrelated bytes')
        else execFileSync('mkfifo', [path])
        assert.equal(publish(f, ['repaired']).kind, 'published')
        assert.equal(lstatSync(path).isDirectory(), true)
        assert.deepEqual(ids(f), ['repaired'])
      } finally { f.dispose() }
    }
  })

  await t.test('competing repairs and a third publisher in the detached live directory observe sources again', async () => {
    const f = projectionFixture()
    try {
      mkdirSync(live(f), { recursive: true })
      for (let i = 0; i < 257; i++) writeFileSync(join(live(f), `flood-${i}`), '')
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['old'])
      const repairing = f.barrier('repairing')
      const first = f.start(publicationScript(f.root, source, { barrier: repairing.path, stage: 'before_quarantine' }))
      await repairing.arrived(); first.child.kill('SIGSTOP')
      fixtureJson(source, ['new'])
      // Otro publicador aparta el live que ambos habían encontrado lleno y publica en el nuevo.
      assert.equal(publish(f, ['new']).kind, 'published')
      const writing = f.barrier('writing')
      const third = f.start(publicationScript(f.root, source, { barrier: writing.path, stage: 'temporary' }))
      await writing.arrived(); third.child.kill('SIGSTOP')
      // El primero reanuda después de su comprobación y aparta el live donde espera el tercero.
      repairing.release(); first.child.kill('SIGCONT')
      const firstDone = await first.done
      assert.equal(firstDone.code, 0, firstDone.stderr)
      writing.release(); third.child.kill('SIGCONT')
      const thirdDone = await third.done
      assert.equal(thirdDone.code, 0, thirdDone.stderr)
      assert.deepEqual(ids(f), ['new'])
      assert.equal(validateProjection(latestProjection(f.root)).ok, true)
      assert.ok(readdirSync(join(f.root, '.sdd-ai', 'projection')).filter((name) => name.startsWith('stale-')).length >= 2)
    } finally { f.dispose() }
  })

  await t.test('failure between quarantine and creation leaves unavailable state and the next publisher repairs it', () => {
    const f = projectionFixture()
    try {
      mkdirSync(live(f), { recursive: true })
      for (let i = 0; i < 257; i++) writeFileSync(join(live(f), `flood-${i}`), '')
      const result = publish(f, ['failed'], { stage: (stage) => {
        if (stage === 'quarantined') throw Object.assign(new Error('no se puede crear el nuevo live'), { code: 'EACCES' })
      } })
      assert.equal(result.kind, 'not_published')
      assert.equal(latestProjection(f.root), null)
      assert.equal(publish(f, ['recovered']).kind, 'published')
      assert.deepEqual(ids(f), ['recovered'])
    } finally { f.dispose() }
  })

  await t.test('disappearing temporaries and occupied definitive names invalidate at most two cycles', () => {
    const f = projectionFixture()
    try {
      let reads = 0
      const result = publish(f, ['real'], { stage: (stage) => {
        if (stage !== 'temporary') return
        reads++
        const temporary = readdirSync('.').find((name) => name.startsWith('tmp-'))!
        unlinkSync(temporary)
      } })
      assert.deepEqual(result, { kind: 'not_published', cause: 'invalidated' }); assert.equal(reads, 2)
      let attempts = 0
      assert.equal(publish(f, ['real'], { stage: (stage, context) => {
        if (stage === 'temporary') { attempts++; writeFileSync(context.id!, 'occupied', { flag: 'wx' }) }
      } }).kind, 'not_published')
      assert.equal(attempts, 2)
    } finally { f.dispose() }
  })

  await t.test('a temporary whose write fails midway is removed and the next publication recovers', () => {
    const f = projectionFixture()
    try {
      assert.equal(publish(f, ['valid']).kind, 'published')
      // La escritura del temporal, por su descriptor, deja una parte y falla por falta de espacio; las demás escrituras
      // siguen como siempre. El módulo usa la función de `node:fs` que queda después de sincronizar sus exports.
      const original = fs.writeFileSync
      const failing = mock.method(fs, 'writeFileSync', (file: Parameters<typeof fs.writeFileSync>[0], data: string, options?: fs.WriteFileOptions) => {
        if (typeof file !== 'number') return original(file, data, options)
        fs.writeSync(file, data.slice(0, 10))
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      })
      syncBuiltinESMExports()
      let result: ReturnType<typeof publish>
      try { result = publish(f, ['lost']) } finally { failing.mock.restore(); syncBuiltinESMExports() }
      assert.ok(failing.mock.calls.some((call) => typeof call.arguments[0] === 'number'), 'la escritura del temporal pasó por la función simulada')
      assert.deepEqual(result, { kind: 'not_published', cause: 'publication_failed' })
      assert.deepEqual(readdirSync(live(f)).filter((name) => name.startsWith('tmp-')), [])
      assert.deepEqual(ids(f), ['valid'])
      assert.equal(publish(f, ['recovered']).kind, 'published')
      assert.deepEqual(ids(f), ['recovered'])
    } finally { f.dispose() }
  })

  await t.test('a publication pruned by its own pruning reports superseded instead of a deleted path', () => {
    const f = projectionFixture()
    try {
      let now = 100_000_000_000n
      // Mientras esta publicación enlaza, otras dos más nuevas se publican y el reloj avanza más de cinco segundos: su
      // poda solo conserva esas dos.
      const result = publish(f, ['slow'], { monotonic: () => ++now, stage: (stage, context) => {
        if (stage !== 'linked' || context.attempt !== 1) return
        now += 10_000_000_000n
        writeObservation(f, observation(now - 1n, TEST_BOOT, 'b'.repeat(32)), 'newer')
        writeObservation(f, observation(now, TEST_BOOT, 'c'.repeat(32)), 'newest')
      } })
      assert.deepEqual(result, { kind: 'not_published', cause: 'superseded' })
      assert.deepEqual(ids(f), ['newest'])
      assert.equal(readdirSync(live(f)).filter((name) => OBSERVATION_NAME.test(name)).length, 2)
      assert.equal(readdirSync(live(f)).some((name) => name.startsWith('tmp-')), false)
    } finally { f.dispose() }
  })

  await t.test('a publication request already covered by a newer valid observation reads nothing', () => {
    const f = projectionFixture()
    const previous = process.env.SDD_AI_PROJECTION_MEASURE
    const measure = join(f.scratch, 'measure.jsonl')
    process.env.SDD_AI_PROJECTION_MEASURE = measure
    try {
      const boot = systemBootId()!
      const last = () => JSON.parse(readFileSync(measure, 'utf8').trim().split('\n').at(-1)!) as { result: string; id?: string }
      const observations = () => readdirSync(live(f)).filter((name) => OBSERVATION_NAME.test(name)).sort()
      // Sin observaciones, el pedido publica.
      const requested = process.hrtime.bigint()
      publishNow(f.root, 'test', 'cli', Date.now(), requested)
      assert.equal(last().result, 'published')
      const covering = observations().at(-1)!
      // Un pedido anterior al `m0` de la más nueva ya está cubierto: termina sin leer ni publicar.
      publishNow(f.root, 'test', 'cli', Date.now(), requested)
      assert.deepEqual([last().result, last().id], ['skipped', covering])
      assert.deepEqual(observations(), [covering])
      // Un pedido posterior a ella publica.
      publishNow(f.root, 'test', 'cli', Date.now(), process.hrtime.bigint())
      assert.equal(last().result, 'published')
      assert.equal(observations().length, 2)
      // Sin el reloj del pedido, como en un binario anterior, también publica.
      publishNow(f.root, 'test', 'cli', Date.now())
      assert.equal(last().result, 'published')
      // Una más nueva que no sirve no cubre ningún pedido: una corrupta y una adelantada al reloj.
      const corrupt = observation(process.hrtime.bigint(), boot, 'd'.repeat(32))
      writeFileSync(join(live(f), corrupt.id), '{')
      publishNow(f.root, 'test', 'cli', Date.now(), requested)
      assert.equal(last().result, 'published')
      writeObservation(f, observation(process.hrtime.bigint() + 3_600_000_000_000n, boot, 'e'.repeat(32)), 'ahead')
      publishNow(f.root, 'test', 'cli', Date.now(), requested)
      assert.equal(last().result, 'published')
      assert.equal(validateProjection(latestProjection(f.root)).ok, true)
    } finally {
      if (previous === undefined) delete process.env.SDD_AI_PROJECTION_MEASURE
      else process.env.SDD_AI_PROJECTION_MEASURE = previous
      f.dispose()
    }
  })

  await t.test('collection failure preserves the last valid observation and cwd and a later publication recovers', () => {
    const f = projectionFixture()
    try {
      assert.equal(publish(f, ['valid']).kind, 'published')
      const before = process.cwd()
      const result = publishProjection(f.root, () => { throw new Error('storage fault') }, { boot: () => TEST_BOOT })
      assert.equal(result.kind, 'not_published'); assert.equal(process.cwd(), before); assert.deepEqual(ids(f), ['valid'])
      assert.equal(publish(f, ['recovered']).kind, 'published'); assert.deepEqual(ids(f), ['recovered'])
    } finally { f.dispose() }
  })

  await t.test('dead publishers at read write link and quarantine boundaries cannot prevent recovery', async () => {
    for (const stage of ['entered', 'observed', 'temporary', 'linked', 'verified', 'pruned', 'before_quarantine', 'quarantined'] as const) {
      const f = projectionFixture()
      try {
        const source = join(f.scratch, 'source.json'); fixtureJson(source, ['old'])
        if (stage === 'before_quarantine' || stage === 'quarantined') {
          mkdirSync(live(f), { recursive: true })
          for (let i = 0; i < 257; i++) writeFileSync(join(live(f), `flood-${i}`), '')
        }
        const barrier = f.barrier('killed')
        const child = f.start(publicationScript(f.root, source, { barrier: barrier.path, stage }))
        await barrier.arrived(); child.child.kill('SIGKILL'); await child.done
        assert.equal(publish(f, ['recovered']).kind, 'published'); assert.deepEqual(ids(f), ['recovered'])
      } finally { f.dispose() }
    }
  })

  await t.test('system monotonic timestamps increase across alternating real processes', async () => {
    const f = projectionFixture()
    try {
      let previous = process.hrtime.bigint()
      for (let i = 0; i < 6; i++) {
        const child = f.start('console.log(process.hrtime.bigint().toString())')
        const done = await child.done; assert.equal(done.code, 0, done.stderr)
        const current = BigInt(done.stdout.trim()); assert.ok(current > previous)
        previous = process.hrtime.bigint(); assert.ok(previous > current)
      }
    } finally { f.dispose() }
  })

  await t.test('continuous source changes converge while a reader keeps observing complete JSON', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['initial'])
      assert.equal(publish(f, ['initial']).kind, 'published')
      const until = Date.now() + 5200
      let sequence = 0
      while (Date.now() < until) {
        const expected = `change-${sequence++}`
        fixtureJson(source, [expected])
        const changed = Date.now()
        const workers = [f.start(publicationScript(f.root, source)), f.start(publicationScript(f.root, source))]
        while (workers.some((worker) => worker.child.exitCode === null && worker.child.signalCode === null)) {
          assert.equal(validateProjection(latestProjection(f.root)).ok, true)
          await sleep(10)
        }
        for (const worker of workers) { const done = await worker.done; assert.equal(done.code, 0, done.stderr) }
        assert.deepEqual(ids(f), [expected]); assert.ok(Date.now() - changed < 5000)
      }
      assert.ok(sequence > 1)
    } finally { f.dispose() }
  })
})

const BIN = join(import.meta.dirname, '..', 'bin', 'sdd-ai')
const SECOND = 1_000_000_000n
const claims = (f: Fixture) => (existsSync(live(f)) ? readdirSync(live(f)).filter((name) => CLAIM_NAME.test(name)).sort() : [])
const claimName = (m0: bigint, boot: string, pid: number, suffix: string) => `claim-${m0.toString().padStart(20, '0')}-${boot}-${pid}-${suffix.repeat(32)}`
const measured = (file: string) => readFileSync(file, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line) as { result: string; id?: string; pid: number; ms: number; queued?: string[]; queued_ms?: number })

/** Un `sdd-ai __publish` aparte, como el que lanza `requestPublication`, que anota su resultado en `measure`. */
function publishProcess(root: string, requested: bigint, measure: string): Promise<{ code: number | null; stderr: string }> {
  publicationTrace(measure, 'request_created', { requested: requested.toString() })
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, '__publish', root, 'test', 'cli', String(Date.now()), String(requested)], {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SDD_AI_PROJECTION_MEASURE: measure },
    })
    publicationTrace(measure, 'request_spawned', { child: child.pid, requested: requested.toString() })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.once('error', (e) => { clearTimeout(timeout); resolve({ code: null, stderr: stderr + e.message }) })
    child.once('close', (code) => { clearTimeout(timeout); resolve({ code, stderr }) })
  })
}

test('publishers of one request read the sources once by yielding to a live claim', async (t) => {
  await t.test('six requests for the same change read the sources once and the other five yield to the claim', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['changed'])
      const requested = process.hrtime.bigint()
      const measure = join(f.scratch, 'measure.jsonl')
      // El primero que empieza a leer queda detenido con su reserva puesta: los otros cinco llegan mientras lee. Usa el
      // arranque real de la máquina, como los `__publish`.
      const barrier = f.barrier('reading')
      const reader = f.start(publicationScript(f.root, source, { barrier: barrier.path, stage: 'claimed', requested, systemBoot: true }))
      await barrier.arrived()
      const [claim, ...rest] = claims(f)
      assert.ok(claim); assert.deepEqual(rest, [])
      const others = await Promise.all(Array.from({ length: 5 }, () => publishProcess(f.root, requested, measure)))
      for (const other of others) assert.equal(other.code, 0, other.stderr)
      assert.deepEqual(measured(measure).map((line) => [line.result, line.id]), Array.from({ length: 5 }, () => ['skipped', claim]))
      assert.equal(readdirSync(live(f)).some((name) => OBSERVATION_NAME.test(name)), false, 'ninguno de los que cedieron publicó')
      barrier.release()
      const done = await reader.done
      assert.equal(done.code, 0, done.stderr)
      assert.equal(JSON.parse(done.stdout).kind, 'published')
      assert.deepEqual(ids(f), ['changed'])
      assert.deepEqual(claims(f), [])
    } finally { f.dispose() }
  })

  await t.test('a request made after the claim began reading does not yield to it', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['first'])
      const before = process.hrtime.bigint()
      const barrier = f.barrier('claimed')
      const reader = f.start(publicationScript(f.root, source, { barrier: barrier.path, stage: 'claimed', requested: before }))
      await barrier.arrived()
      const [claim] = claims(f)
      assert.ok(claim)
      // Un pedido anterior a la reserva cede sin leer: el que la puso empezó a leer después del cambio.
      let reads = 0
      const counted = (root: string, stamp: Parameters<typeof projectionDocument>[1]) => { reads++; return projectionDocument(root, stamp) }
      assert.deepEqual(publishProjection(f.root, counted, { boot: () => TEST_BOOT, requested: before }), { kind: 'skipped', id: claim })
      assert.equal(reads, 0)
      // Uno posterior al `m0` de la reserva, cuyo cambio ese publicador pudo no ver, lee y publica. Sin `queue`, como en
      // esta llamada directa, no espera a que el otro termine.
      assert.equal(publish(f, ['second'], { requested: process.hrtime.bigint() }).kind, 'published')
      assert.deepEqual(ids(f), ['second'])
      assert.deepEqual(claims(f), [claim])
      barrier.release()
      const done = await reader.done
      assert.equal(done.code, 0, done.stderr)
      assert.deepEqual(claims(f), [])
    } finally { f.dispose() }
  })

  await t.test('a claim still searching is not trusted so a request is never lost to a publisher that yields in turn', async () => {
    const f = projectionFixture()
    try {
      const source = join(f.scratch, 'source.json'); fixtureJson(source, ['older-reader'])
      // W lee por un pedido viejo y queda detenido después de decidir leer.
      const older = process.hrtime.bigint()
      const reading = f.barrier('reading')
      const w = f.start(publicationScript(f.root, source, { barrier: reading.path, stage: 'claimed', requested: older }))
      await reading.arrived()
      const [wClaim] = claims(f)
      assert.ok(wClaim)
      // Llega el cambio de Y, que W ya no ve. Después arranca Z por el pedido viejo, y se detiene con su reserva puesta
      // antes de buscar: cuando busque, cederá ante W.
      const requested = process.hrtime.bigint()
      const searching = f.barrier('searching')
      const z = f.start(publicationScript(f.root, source, { barrier: searching.path, stage: 'reserved', requested: older }))
      await searching.arrived()
      const zClaim = claims(f).find((name) => name !== wClaim)!
      assert.equal(lstatSync(join(live(f), zClaim)).mode & 0o777, 0, 'una reserva sin decidir no tiene permisos')
      assert.equal(lstatSync(join(live(f), wClaim)).mode & 0o777, 0o600)
      // Y no cede ante Z, que todavía no decidió, ni ante W, que empezó antes de su cambio: lee y publica.
      assert.equal(publish(f, ['y-change'], { requested }).kind, 'published')
      assert.deepEqual(ids(f), ['y-change'])
      searching.release()
      const zDone = await z.done
      assert.deepEqual(JSON.parse(zDone.stdout), { kind: 'skipped', id: wClaim })
      reading.release()
      const wDone = await w.done
      assert.equal(wDone.code, 0, wDone.stderr)
      assert.deepEqual(ids(f), ['y-change'])
      assert.deepEqual(claims(f), [])
    } finally { f.dispose() }
  })

  await t.test('a request waits for a claim still searching and yields once it decides to read', async () => {
    const f = projectionFixture()
    try {
      mkdirSync(live(f), { recursive: true })
      const requested = process.hrtime.bigint()
      const barrier = f.barrier('pending')
      // Un publicador que reservó y decide leer un momento después.
      const child = f.start(`import { chmodSync, closeSync, openSync, writeFileSync } from 'node:fs';
        const name = 'claim-' + process.hrtime.bigint().toString().padStart(20, '0') + '-${TEST_BOOT}-' + process.pid + '-${'f'.repeat(32)}';
        const path = ${JSON.stringify(live(f))} + '/' + name;
        closeSync(openSync(path, 'wx', 0o000));
        writeFileSync(${JSON.stringify(barrier.path)} + '.arrived', name);
        setTimeout(() => chmodSync(path, 0o600), 80);
        setInterval(() => {}, 1000);`)
      await barrier.arrived()
      const [pending] = claims(f)
      assert.ok(pending)
      let reads = 0
      const counted = (root: string, stamp: Parameters<typeof projectionDocument>[1]) => { reads++; return projectionDocument(root, stamp) }
      assert.deepEqual(publishProjection(f.root, counted, { boot: () => TEST_BOOT, requested }), { kind: 'skipped', id: pending })
      assert.equal(reads, 0)
      child.child.kill('SIGKILL'); await child.done
    } finally { f.dispose() }
  })

  await t.test('dead expired ahead and other boot claims never make a request yield and pruning removes them', () => {
    const f = projectionFixture()
    try {
      mkdirSync(live(f), { recursive: true })
      const now = process.hrtime.bigint()
      const dead = spawnSync(process.execPath, ['-e', '']).pid!
      const stale = [
        claimName(now - SECOND, TEST_BOOT, dead, 'a'),
        claimName(now - 61n * SECOND, TEST_BOOT, process.pid, 'b'),
        claimName(now + 3600n * SECOND, TEST_BOOT, process.pid, 'c'),
        claimName(now - SECOND, OTHER_BOOT, process.pid, 'd'),
      ]
      for (const name of stale) writeFileSync(join(live(f), name), '')
      assert.equal(publish(f, ['read'], { requested: now - 120n * SECOND }).kind, 'published')
      assert.deepEqual(ids(f), ['read'])
      assert.deepEqual(claims(f), [])
      // Una reserva viva del mismo arranque, en cambio, hace ceder, y la poda de otro publicador la conserva.
      const current = process.hrtime.bigint()
      const alive = claimName(current - SECOND, TEST_BOOT, process.pid, 'e')
      writeFileSync(join(live(f), alive), '')
      assert.deepEqual(publish(f, ['yielded'], { requested: current - 2n * SECOND }), { kind: 'skipped', id: alive })
      assert.equal(publish(f, ['direct']).kind, 'published')
      assert.deepEqual(ids(f), ['direct'])
      assert.deepEqual(claims(f), [alive])
    } finally { f.dispose() }
  })

  await t.test('the claim exists while reading and is removed when the publication ends even if it fails', () => {
    const f = projectionFixture()
    try {
      const seen: string[][] = []
      const build = (root: string, stamp: Parameters<typeof projectionDocument>[1]) => { seen.push(claims(f)); return projectionDocument(root, stamp) }
      const own = new RegExp(`^claim-\\d{20}-${TEST_BOOT}-${process.pid}-[0-9a-f]{32}$`)
      assert.equal(publishProjection(f.root, build, { boot: () => TEST_BOOT, requested: process.hrtime.bigint() }).kind, 'published')
      assert.equal(seen.length, 1); assert.equal(seen[0].length, 1); assert.match(seen[0][0], own)
      assert.deepEqual(claims(f), [])
      // Una lectura que falla.
      const failed = publishProjection(f.root, () => { seen.push(claims(f)); throw new Error('storage fault') }, { boot: () => TEST_BOOT, requested: process.hrtime.bigint() })
      assert.deepEqual(failed, { kind: 'not_published', cause: 'publication_failed' })
      assert.equal(seen[1].length, 1); assert.match(seen[1][0], own)
      assert.deepEqual(claims(f), [])
      // Dos intentos invalidados: cada uno lee con su reserva y la borra al terminar.
      const invalidated = publishProjection(f.root, build, { boot: () => TEST_BOOT, requested: process.hrtime.bigint(), stage: (stage) => {
        if (stage === 'temporary') unlinkSync(readdirSync('.').find((name) => name.startsWith('tmp-'))!)
      } })
      assert.deepEqual(invalidated, { kind: 'not_published', cause: 'invalidated' })
      assert.deepEqual(seen.slice(2).map((names) => names.length), [1, 1])
      assert.notEqual(seen[2][0], seen[3][0])
      assert.deepEqual(claims(f), [])
      // Sin el reloj de un pedido, como en una llamada directa, no reserva.
      assert.equal(publishProjection(f.root, build, { boot: () => TEST_BOOT }).kind, 'published')
      assert.deepEqual(seen.at(-1), [])
    } finally { f.dispose() }
  })

  await t.test('a link or a directory named as a claim is not followed does not count and is never removed recursively', () => {
    const f = projectionFixture()
    try {
      mkdirSync(live(f), { recursive: true })
      const witness = join(f.scratch, 'witness'); writeFileSync(witness, 'protected')
      const now = process.hrtime.bigint()
      const link = claimName(now - SECOND, TEST_BOOT, process.pid, 'a')
      const directory = claimName(now - SECOND, TEST_BOOT, process.pid, 'b')
      symlinkSync(witness, join(live(f), link))
      mkdirSync(join(live(f), directory)); writeFileSync(join(live(f), directory, 'child'), 'keep')
      assert.equal(publish(f, ['read'], { requested: now - 2n * SECOND }).kind, 'published')
      assert.deepEqual(ids(f), ['read'])
      assert.equal(readFileSync(witness, 'utf8'), 'protected')
      assert.equal(readdirSync(live(f)).includes(link), false, 'la poda borra el enlace, no su destino')
      assert.equal(readFileSync(join(live(f), directory, 'child'), 'utf8'), 'keep')
    } finally { f.dispose() }
  })
})

/**
 * Espera los acuses de procesos que devolvieron `queued` para `holder`, después de retirar su reserva.
 * No infiere entrada en cola a partir de archivos fugaces ni da por cumplida la barrera al vencer un plazo.
 */
function queueWatch(f: Fixture, holder: string, measure: string) {
  return {
    async queued(count: number) {
      const until = Date.now() + 10000
      for (;;) {
        const trace = `${measure}.trace.jsonl`
        // Solo líneas completas: un hijo puede estar agregando la última mientras el padre lee.
        const lines = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').slice(0, -1) : []
        const acknowledgements = new Set(lines.map((line) => JSON.parse(line))
          .filter((line) => line.event === 'queued' && line.id === holder).map((line) => line.pid))
        if (acknowledgements.size === count) {
          publicationTrace(measure, 'queue_acknowledged', { expected: count, processes: [...acknowledgements], claims: claims(f) })
          return
        }
        if (Date.now() >= until) throw new Error(`faltan acuses queued: ${acknowledgements.size}/${count}`)
        await sleep(10)
      }
    },
    close() {},
  }
}

/** Un publicador detenido en `claimed`: decidió leer y tiene su reserva puesta, con el arranque real de la máquina. */
async function heldReader(f: Fixture, name: string, measure?: string) {
  const source = join(f.scratch, 'source.json'); fixtureJson(source, ['old'])
  const barrier = f.barrier(name)
  const reader = f.start(publicationScript(f.root, source, { barrier: barrier.path, stage: 'claimed', requested: process.hrtime.bigint(), systemBoot: true, measure }))
  await barrier.arrived()
  const [claim, ...rest] = claims(f)
  assert.ok(claim); assert.deepEqual(rest, [])
  assert.equal(lstatSync(join(live(f), claim)).mode & 0o777, 0o600)
  return { reader, barrier, claim }
}

test('requests made while an earlier reader works wait in a queue instead of reading at the same time', async (t) => {
  await t.test('with the queue a request behind a reader that began before it neither reads nor keeps a claim', () => {
    const f = projectionFixture()
    try {
      mkdirSync(live(f), { recursive: true })
      const now = process.hrtime.bigint()
      let reads = 0
      const counted = (root: string, stamp: Parameters<typeof projectionDocument>[1]) => { reads++; return projectionDocument(root, stamp) }
      // Una reserva sin decidir que empezó antes del pedido no pone a nadie en la cola.
      const pending = claimName(now - 3n * SECOND, TEST_BOOT, process.pid, 'a')
      writeFileSync(join(live(f), pending), ''); chmodSync(join(live(f), pending), 0o000)
      assert.equal(publishProjection(f.root, counted, { boot: () => TEST_BOOT, requested: now, queue: true }).kind, 'published')
      assert.equal(reads, 1)
      // Una decidida y viva sí: no lee y borra su propia reserva antes de devolverla.
      const running = claimName(now - 2n * SECOND, TEST_BOOT, process.pid, 'b')
      writeFileSync(join(live(f), running), '', { mode: 0o600 })
      assert.deepEqual(publishProjection(f.root, counted, { boot: () => TEST_BOOT, requested: now, queue: true }), { kind: 'queued', id: running })
      assert.equal(reads, 1)
      assert.deepEqual(claims(f), [pending, running])
      // Sin la cola, como en una llamada directa, lee.
      assert.equal(publishProjection(f.root, counted, { boot: () => TEST_BOOT, requested: now }).kind, 'published')
      assert.equal(reads, 2)
      // Una reserva que cubre el pedido lo hace ceder antes de mirar la cola.
      const covering = claimName(now - SECOND, TEST_BOOT, process.pid, 'c')
      writeFileSync(join(live(f), covering), '', { mode: 0o600 })
      assert.deepEqual(publishProjection(f.root, counted, { boot: () => TEST_BOOT, requested: now - 1500n * 1_000_000n, queue: true }),
        { kind: 'skipped', id: covering })
      assert.equal(reads, 2)
    } finally { f.dispose() }
  })

  await t.test('three requests after a reader stopped in claimed wait for it and then only one of them reads', async (t) => {
    const f = projectionFixture()
    const measure = join(f.scratch, 'measure.jsonl')
    let watcher: ReturnType<typeof queueWatch> | undefined
    try {
      const { reader, barrier, claim } = await heldReader(f, 'reading', measure)
      watcher = queueWatch(f, claim, measure)
      const requests: ReturnType<typeof publishProcess>[] = []
      for (const change of ['change-1', 'change-2', 'change-3']) {
        f.run(change)
        requests.push(publishProcess(f.root, process.hrtime.bigint(), measure))
      }
      await watcher.queued(3)
      // Mientras el primero sigue leyendo, ninguno de los tres lee ni deja una reserva.
      assert.deepEqual(claims(f), [claim])
      assert.equal(readdirSync(live(f)).some((name) => OBSERVATION_NAME.test(name)), false)
      assert.equal(existsSync(measure), false)
      const released = process.hrtime.bigint()
      publicationTrace(measure, 'holder_release_requested', { id: claim })
      barrier.release()
      const done = await reader.done
      assert.equal(done.code, 0, done.stderr)
      for (const request of await Promise.all(requests)) assert.equal(request.code, 0, request.stderr)
      const lines = measured(measure)
      assert.deepEqual(lines.map((line) => line.result).sort(), ['published', 'skipped', 'skipped'])
      for (const line of lines) assert.deepEqual(line.queued, [claim])
      // El que lee empezó después de que el primero terminara, y los otros dos ceden ante él: ante su reserva o su
      // observación, que llevan su `pid`.
      const published = lines.find((line) => line.result === 'published')!
      assert.ok(BigInt(OBSERVATION_NAME.exec(published.id!)![1]) > released)
      for (const line of lines.filter((line) => line.result === 'skipped')) {
        assert.equal(Number((CLAIM_NAME.exec(line.id!) ?? OBSERVATION_NAME.exec(line.id!))![3]), published.pid)
      }
      assert.deepEqual(ids(f)?.sort(), ['change-1', 'change-2', 'change-3'])
      assert.deepEqual(claims(f), [])
    } finally {
      // Emitir incluso en rojo antes de borrar el fixture: el conductor conserva la traza en el reporte TAP.
      watcher?.close()
      if (existsSync(`${measure}.trace.jsonl`)) t.diagnostic(readFileSync(`${measure}.trace.jsonl`, 'utf8'))
      f.dispose()
    }
  })

  await t.test('a request waiting for a reader that does not finish within five seconds reads anyway', async () => {
    const f = projectionFixture()
    try {
      const { reader, barrier, claim } = await heldReader(f, 'stuck')
      const measure = join(f.scratch, 'measure.jsonl')
      f.run('late')
      const request = await publishProcess(f.root, process.hrtime.bigint(), measure)
      assert.equal(request.code, 0, request.stderr)
      const [line, ...rest] = measured(measure)
      assert.deepEqual(rest, [])
      assert.equal(line.result, 'published')
      assert.deepEqual(line.queued, [claim])
      assert.ok(line.ms >= 5000, `esperó todo el plazo antes de leer: ${line.ms} ms`)
      assert.deepEqual(ids(f), ['late'])
      assert.deepEqual(claims(f), [claim], 'el primero sigue detenido con su reserva')
      barrier.release()
      const done = await reader.done
      assert.equal(done.code, 0, done.stderr)
      assert.deepEqual(ids(f), ['late'])
      assert.deepEqual(claims(f), [])
    } finally { f.dispose() }
  })

  await t.test('a request stops waiting as soon as the reader it waits for dies and reads', async () => {
    const f = projectionFixture()
    let watcher: ReturnType<typeof queueWatch> | undefined
    try {
      const { reader, claim } = await heldReader(f, 'dying')
      const measure = join(f.scratch, 'measure.jsonl')
      watcher = queueWatch(f, claim, measure)
      f.run('after-death')
      const request = publishProcess(f.root, process.hrtime.bigint(), measure)
      await watcher.queued(1)
      assert.equal(existsSync(measure), false)
      reader.child.kill('SIGKILL'); await reader.done
      const result = await request
      assert.equal(result.code, 0, result.stderr)
      const [line] = measured(measure)
      assert.equal(line.result, 'published')
      assert.deepEqual(line.queued, [claim])
      assert.ok(line.ms < 5000, `dejó de esperar antes del plazo: ${line.ms} ms`)
      assert.deepEqual(ids(f), ['after-death'])
      assert.deepEqual(claims(f), [], 'la poda borra la reserva del proceso que murió')
    } finally { watcher?.close(); f.dispose() }
  })
})
