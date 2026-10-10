import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureState, classifyGitQuery, countGitQueries, createFixture, gitIn, interceptExecFileSync, makeGitMemoRepo,
  SOURCE_ROOT, spawnControlledProcess, spawnControlledWriter, writeLegacyControl } from './git-memo-fixture.ts'

test('helpers de git-memo: createFixture es determinista y no arrastra el entorno Git', async () => {
  const saved = process.env.GIT_DIR
  process.env.GIT_DIR = 'identificación-heredada-inválida'
  try {
    for (const scenario of ['verify', 'commit'] as const) for (const checkout of ['principal', 'linked'] as const) {
      const a = await createFixture({ sourceRoot: SOURCE_ROOT, scenario, checkout })
      try {
        const b = await createFixture({ sourceRoot: SOURCE_ROOT, scenario, checkout })
        try {
          assert.equal(a.fixtureSha, b.fixtureSha)
          assert.equal(a.baseCommit, b.baseCommit)
          const left = captureState(a.root); const right = captureState(b.root)
          assert.equal(left.head, right.head)
          assert.equal(left.index, right.index)
          assert.equal(left.files['src/a.ts'].bytes, right.files['src/a.ts'].bytes)
          assert.equal(process.env.GIT_DIR, 'identificación-heredada-inválida')
        } finally { b.cleanup() }
      } finally { a.cleanup() }
    }
  } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved }
})

test('helpers de git-memo: el envoltorio cuenta y muta solo lo que reconoce y se restaura', () => {
  const fixture = makeGitMemoRepo()
  let before = 0; let after = 0
  const counter = countGitQueries()
  const restore = interceptExecFileSync({ match: (argv, opts, stack) => classifyGitQuery(argv) === 'repoRoot' && resolve(String(opts.cwd)) === resolve(fixture.root) && stack.includes('git-memo-harness'),
    before: () => { before++; writeFileSync(join(fixture.root, 'mutation'), 'before') }, after: () => { after++ } })
  try {
    gitIn(fixture.root, 'rev-parse', '--show-toplevel')
    gitIn(fixture.root, 'rev-parse', 'HEAD')
    assert.equal(before, 1); assert.equal(after, 1)
    assert.equal(counter.launches.length, 1)
    assert.equal(readFileSync(join(fixture.root, 'mutation'), 'utf8'), 'before')
  } finally { restore(); counter.restore() }
  try { gitIn(fixture.root, 'rev-parse', '--show-toplevel'); assert.equal(before, 1) } finally { fixture.cleanup() }
})

test('helpers de git-memo: los procesos controlados y los controles anteriores se crean y se limpian', async () => {
  const fixture = makeGitMemoRepo()
  const writer = spawnControlledWriter({ root: fixture.root, onSignal: 'exit', steps: [{ path: 'written', content: 'writer', delay_ms: 20 }] })
  try {
    const deadline = Date.now() + 5000
    while (!existsSync(join(fixture.root, 'written')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.equal(readFileSync(join(fixture.root, 'written'), 'utf8'), 'writer')
    const dir = writeLegacyControl(fixture.root, '20260101-0000-abcd', { spawning: false })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')), { spawning: false, id: '20260101-0000-abcd' })
    const mark = join(fixture.root, 'preload-mark')
    const module = join(fixture.root, 'mark.mjs')
    writeFileSync(module, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(mark)}, 'loaded');`)
    const control = spawnControlledProcess({ launches: [], execArgv: ['--import', pathToFileURL(module).href] })
    assert.equal((await control.ended).code, 0)
    assert.equal(readFileSync(mark, 'utf8'), 'loaded')
    writer.child.kill('SIGTERM')
    await writer.ended
    // En Windows no se puede atrapar SIGTERM: la señal termina el proceso, que sale sin código.
    if (process.platform === 'win32') assert.ok(writer.child.exitCode === 0 || writer.child.signalCode === 'SIGTERM')
    else assert.equal(writer.child.exitCode, 0)
  } finally { await writer.cleanup(); fixture.cleanup() }
})

test('la traza y el agregado identifican operaciones consultas y procesos sin duplicarlos', async () => {
  const fixture = makeGitMemoRepo()
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-ai-git-trace-'))
  const trace = join(scratch, 'trace.jsonl')
  const preload = pathToFileURL(join(SOURCE_ROOT, 'scripts', 'git-memo-trace.mjs'))
  preload.searchParams.set('out', trace); preload.searchParams.set('op', 'controlled verify')
  const report = await import(pathToFileURL(join(SOURCE_ROOT, 'scripts', 'git-memo-report.mjs')).href)
  try {
    const childScript = join(scratch, 'child.mjs')
    writeFileSync(childScript, "import { execFileSync } from 'node:child_process'; execFileSync('git', ['rev-parse', '--show-toplevel']);\n")
    const controlled = spawnControlledProcess({ execArgv: ['--import', preload.href], tolerateFailures: true, launches: [
      { api: 'execFileSync', file: 'git', argv: ['rev-parse', '--show-toplevel'], cwd: fixture.root },
      { api: 'spawnSync', file: 'git', argv: ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], cwd: fixture.root },
      { api: 'execFileSync', file: 'git', argv: ['--git-dir', join(fixture.root, '.git'), 'rev-parse', '--path-format=absolute', '--git-path', 'objects'] },
      { api: 'execFile', file: 'git', argv: ['rev-parse', 'HEAD'], cwd: fixture.root },
      { api: 'spawn', file: process.execPath, argv: [childScript], cwd: fixture.root },
      { api: 'fork', file: childScript, cwd: fixture.root },
      { api: 'spawnSync', file: join(scratch, 'missing-executable') },
    ] })
    const ended = await controlled.ended
    assert.equal(ended.code, 0, ended.stderr)
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const aggregate = report.aggregate(rows)
    assert.equal((await report.validateReport(aggregate)).valid, true)
    await assert.rejects(report.validateReport({ ...aggregate, git_queries: 999 }), /incoherente/)
    await assert.rejects(report.validateReport({ schema: 1, groups: [], attempts: 0 }), /sin traza/)
    // Los 7 lanzamientos de la lista (tolerateFailures no agrega ninguno: solo deja seguir al programa cuando el
    // ejecutable inexistente falla) más la consulta repoRoot de cada hijo Node (spawn y fork) son 9 intentos; el
    // ejecutable inexistente no llega a ser un proceso observado, así que quedan 8.
    assert.equal(aggregate.attempts, 9)
    assert.equal(aggregate.observed_processes, 8)
    const observedDuration = rows.filter((row) => row.kind === 'process' && row.stage === 'completion' && row.observed).reduce((sum, row) => sum + row.duration_ms, 0)
    assert.ok(Math.abs(aggregate.accumulated_duration.value - observedDuration) < 1e-8 * Math.max(1, observedDuration))
    // Consultas Git: las tres objetivo y `rev-parse HEAD` (other) del programa, más la de cada hijo Node. Los bypass
    // son los eventos sintéticos que el programa publica antes de cada lanzamiento síncrono con consulta objetivo.
    assert.equal(aggregate.git_queries, 6)
    assert.equal(aggregate.memo_counts.bypass, 3)
    assert.ok(aggregate.groups.every((g: { operation: string }) => g.operation === 'controlled verify'))
    assert.equal(aggregate.groups.filter((g: { query: string }) => g.query === 'repoRoot').reduce((n: number, g: { attempts: number }) => n + g.attempts, 0), 3)
    assert.throws(() => report.aggregate([...rows, rows[0]]), /duplicado/)
    assert.throws(() => report.aggregate(rows.slice(0, -1)), /incompleto/)
    assert.throws(() => report.aggregate([{ ...rows[0], schema: 2 }]), /esquema/)
    const unmatched = { schema: 1, pid: 42, operation: 'candidate', kind: 'memo', event: { v: 1, seq: 1, kind: 'miss', query: 'repoRoot', key: 'x', scope: 1, call: 1, reason: 'not_stored' } }
    assert.throws(() => report.aggregate([unmatched]), /no correlacionada/)
    const wrongCompletion = rows.map((row) => row.kind === 'process' && row.stage === 'completion' ? { ...row, pid: row.pid + 1 } : row)
    assert.throws(() => report.aggregate(wrongCompletion), /otro proceso/)
    assert.throws(() => report.aggregate([{ ...unmatched, event: { ...unmatched.event, kind: 'hit' } }]), /sin entrada vigente/)
    assert.throws(() => report.aggregate([{ ...unmatched, event: { ...unmatched.event, kind: 'bypass', reason: 'consumer_excluded' } }]), /bypass desconocido/)
    assert.throws(() => report.compare({ schema: 1, samples: [{ valid: true, cpu: { value: 1 }, wall: {}, accumulated_duration: {} }] }), /unidad/)
    const bench = await import(pathToFileURL(join(SOURCE_ROOT, 'scripts', 'git-memo-bench.mjs')).href)
    assert.throws(() => bench.validateOperation('verify', [{ exit_code: 2 }], 'a', 'a', null), /fallida/)
    assert.throws(() => bench.validateOperation('verify', [{ exit_code: 0, json: { digest: 'x' } }], 'a', 'a', { green: true, mode: 'final', rows: [] }), /filas/)
    assert.throws(() => bench.validateOperation('commit', [{ exit_code: 0, json: { state: 'dry_run', digest: 'x' } }, { exit_code: 0, json: { sha: 'a' } }], 'a', 'a', null), /efectivos/)
    await assert.rejects(createFixture({ sourceRoot: join(scratch, 'missing-source'), scenario: 'commit', checkout: 'principal' }), /preparación verify fallida/)
    const manifest = measurementManifest()
    const comparison = report.compare(manifest)
    assert.equal(comparison.overhead.length, 12)
    assert.equal(comparison.differences.length, 12)
    assert.equal(comparison.overhead_statistics.length, 4)
    assert.equal(comparison.groups.length, 8)
    assert.ok(comparison.groups.every((g: { statistics: { cpu: { n: number } } }) => g.statistics.cpu.n === 3))
    assert.equal(report.validateManifest(manifest), true)
    assert.throws(() => report.validateManifest({ ...manifest, samples: manifest.samples.slice(1) }), /incompleto/)
    const wrongOrder = structuredClone(manifest)
    wrongOrder.samples[0].order = 3
    assert.throws(() => report.validateManifest(wrongOrder), /orden/)
    const wrongFixture = structuredClone(manifest)
    wrongFixture.samples[0].fixture_sha = 'different'
    assert.throws(() => report.validateManifest(wrongFixture), /fixture/)
    const missingPath = structuredClone(manifest)
    missingPath.samples[0].executed_rows = 0
    assert.throws(() => report.validateManifest(missingPath), /camino/)
    await assert.rejects(report.validateReport(comparison, { requireMeasurement: true }), /artefactos/)
    await assert.rejects(report.validateReport(aggregate, { requireMeasurement: true }), /exige muestras/)
    await assert.rejects(report.validateReport({ ...comparison, trace: rows }), /traza o muestras/)
    assert.throws(() => report.validateManifest({ ...manifest, env: { ...manifest.env, inherited_git_variables: ['GIT_DIR'] } }), /entorno/)
  } finally { fixture.cleanup(); rmSync(scratch, { recursive: true, force: true }) }
})

function measurementManifest() {
  const samples = []
  for (const scenario of ['verify', 'commit']) for (let round = 0; round < 3; round++) {
    const versions = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    const conditions = round % 2 === 0 ? [false, true] : [true, false]
    let order = 0
    for (const version of versions) for (const instrumented of conditions) {
      const cpu = { value: round + 1, user: round + 1, sys: 0, unit: 's', source: '/usr/bin/time user+sys' }
      const wall = { value: round + 2, unit: 's', source: '/usr/bin/time real' }
      samples.push({ id: `${scenario}:${round}:${version}:${instrumented}`, valid: true, scenario, version, instrumented, round, order: order++,
        version_pair: `${scenario}:${round}:${instrumented}`, overhead_pair: `${scenario}:${round}:${version}`,
        fixture_sha: 'fixture', initial_identity: { head: 'fixture', tree: 'tree', index: 'index', candidate_files: {} },
        executed_rows: scenario === 'verify' ? 2 : 0, commit_created: scenario === 'commit', cpu, wall,
        accumulated_duration: { value: instrumented ? round + 3 : null, unit: 'ms', source: instrumented ? 'Node launch-to-return-or-close' : 'not instrumented' },
        operations: [{ command: ['/usr/bin/time', '-p', 'node'], exit_code: 0, load_before: [0, 0, 0], load_after: [0, 0, 0], cpu, wall,
          timing_stderr: `real ${round + 2}\nuser ${round + 1}\nsys 0` }] })
    }
  }
  return { schema: 1, base_commit: 'base', fixture_sha: 'fixture', candidate: { fingerprint: { base_commit: 'base', base_tree: 'base-tree', tree: 'tree' }, snapshot_sha: 'candidate' },
    runtime: { node: 'synthetic', git: 'synthetic', os: 'darwin' }, env: { SDD_AI_TELEMETRY: 'off', SDD_AI_PROJECTION: 'off', git_variables: [], inherited_git_variables: [] }, samples }
}
