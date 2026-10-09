import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { candidateFingerprint } from '../src/git.ts'
import { changeScenarios, cleanGitEnv, consumerScenarios, exclusionScenarios, gitIn, keyScenarios, legacyScenarios, makeGitMemoRepo, recoveryScenarios, SOURCE_ROOT, withGitEnv } from './git-memo-fixture.ts'

test('baseline y candidato conservan salidas códigos y efectos con normalizaciones verificadas', { timeout: 900000 }, async (t) => {
  const report = await import(pathToFileURL(join(SOURCE_ROOT, 'scripts', 'git-memo-report.mjs')).href)
  const digest = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const leftText = '/fixture/a run-a\n'; const rightText = '/fixture/b run-b\n'
  const leftDigest = digest(leftText); const rightDigest = digest(rightText)
  const left = { stdout: '/fixture/a run-a', stderr: '', exit_code: 0, unknown: { message: 'conservar' },
    files: { 'output.log': { bytes: Buffer.from(leftText).toString('base64'), mode: 420 } }, refs: [leftDigest], json: { digest: leftDigest, run: 'run-a' } }
  const right = { ...left, stdout: '/fixture/b run-b', files: { 'output.log': { bytes: Buffer.from(rightText).toString('base64'), mode: 420 } }, refs: [rightDigest], json: { digest: rightDigest, run: 'run-b' } }
  const rules = [{ kind: 'root', left: '/fixture/a', right: '/fixture/b', symbol: 'root' }, { kind: 'run_id', left: 'run-a', right: 'run-b', symbol: 'run' }]
  const integrity = [{ left: { path: 'output.log', digest: leftDigest }, right: { path: 'output.log', digest: rightDigest } }]
  assert.equal(report.compareStates(left, right, rules, integrity).equivalent, true)
  assert.throws(() => report.compareStates(left, { ...right, unknown: { message: 'distinto' } }, rules, integrity), /diferencia/)
  assert.throws(() => report.compareStates(left, { ...right, json: { digest: leftDigest, run: 'run-b' } }, rules, integrity), /diferencia/)
  assert.throws(() => report.compareStates(left, right, [...rules, { ...rules[0], symbol: 'second' }], integrity), /biyectiva/)
  assert.throws(() => report.compareStates(left, right, rules, [{ ...integrity[0], right: { path: 'output.log', digest: leftDigest } }]), /digest inválido/)
  assert.throws(() => report.compareStates(left, { ...right, exit_code: 2 }, rules, integrity), /diferencia/)
  // Las reglas derivadas normalizan el dato en su contexto: un número igual en otro campo sigue comparándose.
  const variable = (stdout: string) => ({ stdout, files: {} })
  const derived = (a: string, b: string) => report.compareStates(variable(a), variable(b), report.deriveVariableRules(variable(a), variable(b)))
  assert.equal(derived('{"duration_ms": 0, "pid": 7, "count": 3}', '{"duration_ms": 1, "pid": 9, "count": 3}').equivalent, true)
  assert.throws(() => derived('{"duration_ms": 0, "count": 0}', '{"duration_ms": 1, "count": 1}'), /diferencia/)
  assert.throws(() => derived('{"pid": 1, "exit_code": 1}', '{"pid": 2, "exit_code": 2}'), /diferencia/)
  assert.throws(() => derived('{"duration_ms": 12.5, "n": 125}', '{"duration_ms": 13.5, "n": 135}'), /diferencia/)
  // PID e inodos se emparejan por número: dos campos que citan el mismo proceso en un lado lo citan también en el otro.
  assert.equal(derived('{"child_pid": 100, "pid": 100}', '{"child_pid": 200, "pid": 200}').equivalent, true)
  assert.throws(() => derived('{"child_pid": 100, "pid": 100}', '{"child_pid": 200, "pid": 300}'), /diferencia/)
  // Los instantes ISO conservan su orden. Una marca copiada (el mismo texto dos veces) conserva su igualdad con la
  // tolerancia que Max aceptó dentro del desvío F-10: puede quedar a menos de 1 s en el otro lado (dos eventos del mismo
  // milisegundo en un lado caen a unos milisegundos en el otro), pero no a un segundo o más.
  const at = (x: string, y: string) => `{"answered_at": "2026-01-01T00:00:${x}Z", "expires_at": "2026-01-01T00:00:${y}Z"}`
  assert.equal(derived(at('01.000', '02.000'), at('03.000', '05.000')).equivalent, true)
  assert.equal(derived(at('01.000', '01.000'), at('03.000', '03.004')).equivalent, true)
  assert.throws(() => derived(at('01.000', '01.000'), at('03.000', '05.000')), /diferencia/)
  assert.equal(derived(at('03.000', '03.004'), at('01.000', '01.000')).equivalent, true)
  assert.throws(() => derived(at('03.000', '05.000'), at('01.000', '01.000')), /diferencia/)
  // Con instantes en segundos la tolerancia es de 2 s: dos eventos del mismo segundo pueden caer en segundos contiguos
  // del otro lado.
  const seconds = (x: string, y: string) => `{"confirmed": "2026-01-01T00:00:${x}-05:00", "next": "2026-01-01T00:00:${y}-05:00"}`
  assert.equal(derived(seconds('01', '01'), seconds('02', '03')).equivalent, true)
  assert.throws(() => derived(seconds('01', '01'), seconds('02', '04')), /diferencia/)
  // Un instante en segundos y otro en milisegundos que caen en el mismo segundo no son una copia: el otro lado puede
  // separarlos, siempre que conserven su orden.
  const mixed = (x: string, y: string) => `{"confirmed": "2026-01-01T00:00:${x}-05:00", "started_at": "2026-01-01T05:00:${y}Z"}`
  assert.equal(derived(mixed('54', '54.775'), mixed('02', '03.223')).equivalent, true)
  // Con formatos mezclados, una inversión estricta del orden se rechaza: aquí `confirmed` va antes que `started_at` en un
  // lado y después en el otro. Si en un lado caen en el mismo segundo, su orden no se conoce a esa resolución y el otro
  // lado puede ordenarlos en cualquier sentido.
  assert.throws(() => derived(mixed('54', '55.100'), mixed('03', '01.900')), /diferencia/)
  assert.equal(derived(mixed('54', '54.775'), mixed('02', '01.900')).equivalent, true)
  assert.throws(() => derived(at('01.000', '02.000'), at('05.000', '03.000')), /diferencia/)
  // Una regla de tiempo solo normaliza un valor con la forma de su clase.
  assert.throws(() => report.compareStates(variable('"exit_code":1'), variable('"exit_code":0'), [
    { kind: 'time', side: 'left', value: '"exit_code":1', symbol: 't' }, { kind: 'time', side: 'right', value: '"exit_code":0', symbol: 't' }]), /regla de normalización inválida/)
  const receiptPath = '<git>/sdd-ai/verify/receipt-a/receipt.json'
  const outputPath = '<git>/sdd-ai/verify/receipt-a/stdout-row.log'
  const errorPath = '<git>/sdd-ai/verify/receipt-a/stderr-row.log'
  const receiptText = JSON.stringify({ id: 'receipt-a', mode: 'final', rows: [{ row: 'row', execution: {
    stdout_file: 'stdout-row.log', stderr_file: 'stderr-row.log', stdout_sha256: digest('ok\n'), stderr_sha256: digest(''),
  } }] }) + '\n'
  const receiptState = { files: {
    [receiptPath]: { bytes: Buffer.from(receiptText).toString('base64') },
    [outputPath]: { bytes: Buffer.from('ok\n').toString('base64') },
    [errorPath]: { bytes: '' },
    'registry.json': { bytes: Buffer.from(JSON.stringify({ verify: { receipts: [{ id: 'receipt-a', mode: 'final', digest: digest(receiptText) }] } })).toString('base64') },
  } }
  assert.equal(report.validateReceiptIntegrity(receiptState), 1)
  const corruptOutput = structuredClone(receiptState)
  corruptOutput.files[outputPath].bytes = Buffer.from('bad\n').toString('base64')
  assert.throws(() => report.compareStates(corruptOutput, corruptOutput), /salida de recibo no íntegra/)
  const corruptReference = structuredClone(receiptState)
  corruptReference.files['registry.json'].bytes = Buffer.from(JSON.stringify({ id: 'receipt-a', mode: 'final', digest: digest('different') })).toString('base64')
  assert.throws(() => report.compareStates(corruptReference, corruptReference), /referencia de recibo no íntegra/)
  const blobHash = digest('candidate\n').slice(7)
  const candidateManifest = { base_sha: null, head_sha: null,
    files: [{ path: 'candidate.txt', status: 'A', from: null, mode: '100644', sha256: blobHash }], context: [] }
  const candidateRecord = { ...candidateManifest, hash: digest(JSON.stringify(candidateManifest)), left_out: [], diff: '' }
  const candidatePath = '.sdd-ai/runs/review-a/candidate.json'
  const blobPath = `.sdd-ai/runs/review-a/blobs/${blobHash}`
  const candidateState = { files: {
    [candidatePath]: { bytes: Buffer.from(JSON.stringify(candidateRecord)).toString('base64') },
    [blobPath]: { bytes: Buffer.from('candidate\n').toString('base64') },
  } }
  assert.equal(report.validateRecordedIntegrity(candidateState).candidates, 1)
  const corruptBlob = structuredClone(candidateState)
  corruptBlob.files[blobPath].bytes = Buffer.from('changed\n').toString('base64')
  assert.throws(() => report.compareStates(corruptBlob, corruptBlob), /blob del candidato no íntegro/)
  const corruptCandidate = structuredClone(candidateState)
  corruptCandidate.files[candidatePath].bytes = Buffer.from(JSON.stringify({ ...candidateRecord, hash: digest('incorrect') })).toString('base64')
  assert.throws(() => report.compareStates(corruptCandidate, corruptCandidate), /hash del candidato inválido/)
  const attestation = { id: 'attestation-a', row: 'V1', proof_ref: 'proof-a', flow: 'f', answered_at: '2026-01-01T00:00:00Z' }
  const attestationBytes = JSON.stringify(attestation) + '\n'
  const attestationPath = '<git>/sdd-ai/verify/attestations/attestation-a.json'
  const attestationState = { files: {
    [attestationPath]: { bytes: Buffer.from(attestationBytes).toString('base64') },
    'registry.json': { bytes: Buffer.from(JSON.stringify({ verify: { attestations: [{ id: attestation.id, row: attestation.row, proof_ref: attestation.proof_ref, digest: digest(attestationBytes) }] } })).toString('base64') },
  } }
  assert.equal(report.validateRecordedIntegrity(attestationState).attestations, 1)
  const corruptAttestation = structuredClone(attestationState)
  corruptAttestation.files[attestationPath].bytes = Buffer.from(JSON.stringify({ ...attestation, row: 'V2' })).toString('base64')
  assert.throws(() => report.compareStates(corruptAttestation, corruptAttestation), /referencia de acreditación no íntegra/)

  const fixture = makeGitMemoRepo()
  try {
    mkdirSync(join(fixture.root, 'src'))
    for (const name of ['git.ts', 'git-memo.ts', 'types.ts']) cpSync(join(SOURCE_ROOT, 'src', name), join(fixture.root, 'src', name))
    writeFileSync(join(fixture.root, 'package.json'), '{"type":"module"}\n')
    gitIn(fixture.root, 'add', '-A'); gitIn(fixture.root, 'commit', '-qm', 'identity fixture')
    const base = gitIn(fixture.root, 'rev-parse', 'HEAD')
    writeFileSync(join(fixture.root, 'candidate.txt'), 'candidate\n')
    const fingerprint = withGitEnv({}, () => candidateFingerprint(fixture.root, 'git-memo-228', base))
    const manifest = { schema: 1, base_commit: base, candidate: { fingerprint }, equivalence: [{ name: 'normalizations', baseline: left, candidate: right, rules, integrity }] }
    const checked = await report.checkEquivalence(manifest, fixture.root)
    assert.equal(checked.results[0].equivalent, true)
    writeFileSync(join(fixture.root, 'candidate.txt'), 'altered\n')
    await assert.rejects(report.checkEquivalence(manifest, fixture.root), /huella/)
  } finally { fixture.cleanup() }

  const snapshots = mkdtempSync(join(tmpdir(), 'git-memo-equivalence-'))
  const bench = await import(pathToFileURL(join(SOURCE_ROOT, 'scripts', 'git-memo-bench.mjs')).href)
  const factories = [recoveryScenarios, consumerScenarios, changeScenarios, exclusionScenarios, legacyScenarios, keyScenarios]
  const exercised = new Set<string>()
  const cases = new Set<string>()
  try {
    const base = bench.snapshotBase('c9c3443f94555d2e4973a5b395d061e43c085d73', join(snapshots, 'base'))
    for (const checkout of ['principal', 'linked'] as const) {
      for (const factory of factories) for (const scenario of factory()) {
        const a = makeGitMemoRepo(); const b = makeGitMemoRepo()
        const leftRoot = checkout === 'principal' ? a.root : `${a.root}-linked`
        const rightRoot = checkout === 'principal' ? b.root : `${b.root}-linked`
        try {
          if (checkout === 'linked') {
            gitIn(a.root, 'worktree', 'add', '-qb', 'linked', leftRoot)
            gitIn(b.root, 'worktree', 'add', '-qb', 'linked', rightRoot)
          }
          const leftGit = gitIn(leftRoot, 'rev-parse', '--absolute-git-dir')
          const rightGit = gitIn(rightRoot, 'rev-parse', '--absolute-git-dir')
          // Copiar el índice inicial evita atribuir a la versión los stat de dos fixtures independientes.
          // Después se compara el contenido lógico del índice, sin sus datos de stat.
          cpSync(join(leftGit, 'index'), join(rightGit, 'index'))
          assert.equal(gitIn(leftRoot, 'rev-parse', 'HEAD'), gitIn(rightRoot, 'rev-parse', 'HEAD'))
          await scenario.prepare(leftRoot, cleanGitEnv())
          await scenario.prepare(rightRoot, cleanGitEnv())
          assert.equal(gitIn(leftRoot, 'rev-parse', 'HEAD'), gitIn(rightRoot, 'rev-parse', 'HEAD'), 'la preparación conserva la misma base en ambos fixtures')
          // Una preparación que crea una base nueva escribe otro índice; se fija antes de ejecutar las versiones.
          cpSync(join(leftGit, 'index'), join(rightGit, 'index'))
          const baseline = await scenario.run(base.root, leftRoot, cleanGitEnv())
          const candidate = await scenario.run(SOURCE_ROOT, rightRoot, cleanGitEnv())
          // Las raíces temporales, más los instantes, duraciones e ids de corrida emparejados en orden de aparición.
          // El nombre del directorio temporal también aparece solo, por ejemplo en el nombre del worktree que Git deriva de él.
          const mappings = [{ kind: 'root', left: a.root, right: b.root, symbol: 'fixture' },
            { kind: 'root', left: basename(a.root), right: basename(b.root), symbol: 'fixture-name' }, ...report.deriveVariableRules(baseline, candidate)]
          const integrity = report.deriveIntegrity(baseline, candidate, mappings)
          assert.equal(report.compareStates(baseline, candidate, mappings, integrity).equivalent, true, `${scenario.name}/${checkout}`)
          assert.equal(baseline.output?.error, null)
          assert.equal(candidate.output?.error, null)
          exercised.add(factory.name)
          cases.add(scenario.name)
          t.diagnostic(`comparación diferencial: ${scenario.name}/${checkout}; código ${baseline.output?.exit_code}`)
        } finally {
          if (checkout === 'linked') {
            rmSync(leftRoot, { recursive: true, force: true }); rmSync(rightRoot, { recursive: true, force: true })
          }
          a.cleanup(); b.cleanup()
        }
      }
    }
  } finally { rmSync(snapshots, { recursive: true, force: true }) }
  for (const required of ['recoveryScenarios', 'consumerScenarios', 'changeScenarios', 'exclusionScenarios', 'legacyScenarios', 'keyScenarios']) {
    assert.ok(exercised.has(required), `matriz diferencial incompleta: falta ejecutar ${required} contra ambas versiones`)
  }
  for (const required of ['verify-final-success', 'commit-draft-and-apply-success', 'prune-changed-candidate',
    'cancel-uncertain-cessation', 'invalid-gates', 'live-writer-evolution', 'publication-enabled']) {
    assert.ok(cases.has(required), `matriz diferencial incompleta: falta el camino ${required}`)
  }
})
