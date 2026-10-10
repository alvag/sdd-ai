import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { currentGitQueryScope, withGitQueryScope } from '../src/git-memo.ts'
import { cleanGitEnv, createFixture, exclusionScenarios, GONE_PID, gitIn, listenGitMemo, makeGitMemoRepo, prepareWaitingWriter, reservationApis, SOURCE_ROOT, startSupervisedNode, withGitAndSwitchesEnvAsync, writeLegacyControl } from './git-memo-fixture.ts'

test('concurrencia cancelación y gates conservan bloqueos reservas y escrituras protegidas', async () => {
  const repo = makeGitMemoRepo(); const linked = `${repo.root}-linked`
  gitIn(repo.root, 'worktree', 'add', '-qb', 'linked', linked)
  const flow = await createFixture({ sourceRoot: SOURCE_ROOT, scenario: 'commit', checkout: 'principal' })
  const api = await reservationApis(); const events = listenGitMemo()
  try { await withGitAndSwitchesEnvAsync(cleanGitEnv(), async () => {
    // Los escenarios de reservas; los demás de la fábrica se comparan en la matriz de equivalencia.
    const reservations = exclusionScenarios().filter((s) => s.name.startsWith('reservation-'))
    assert.ok(reservations.length > 0, 'hay escenarios de reservas')
    for (const scenario of reservations) {
      const held = makeGitMemoRepo()
      try {
        await scenario.prepare(held.root, cleanGitEnv())
        const beforeEvents = events.events.length
        const observed = await scenario.run(SOURCE_ROOT, held.root, cleanGitEnv())
        const json = observed.output?.json as { first: unknown; again: unknown; blocked: { ok: boolean }; released: { state: string }; after: unknown }
        assert.deepEqual(json.first, json.again)
        assert.equal(json.blocked.ok, false)
        assert.equal(json.released.state, 'released')
        assert.equal(json.after, null)
        assert.ok(events.events.slice(beforeEvents).some((e) => e.kind === 'hit' && e.query === 'gitDirs'), 'el conflicto de reserva alcanzó el memo')
      } finally { held.cleanup() }
    }
    const acquisitionEvents = events.events.length
    withGitQueryScope('call', () => {
      const first = api.acquireReservation(repo.root, 'fixture-commit-a', 'commit')
      assert.equal(first.ok, true)
      if (!first.ok) throw new Error('no se adquirió la reserva inicial')
      try {
        assert.deepEqual(first.handles.map((h) => h.domain), ['checkout', 'refs'])
        assert.ok(api.ownReservation(repo.root, 'commit'))
        assert.ok(events.events.slice(acquisitionEvents).some((e) => e.kind === 'hit' && e.query === 'gitDirs'), 'la adquisición dentro del ámbito reutilizó gitDirs')
        const same = api.acquireReservation(repo.root, 'fixture-writer-a', 'writer')
        if (same.ok || !('conflict' in same)) assert.fail('la segunda reserva del mismo checkout no informó su conflicto')
        assert.equal(same.conflict.domain, 'checkout')
        const otherWriter = api.acquireReservation(linked, 'fixture-writer-b', 'writer')
        assert.equal(otherWriter.ok, true, 'la reserva de checkout no bloquea otro worktree')
        if (!otherWriter.ok) throw new Error('no se adquirió la reserva del segundo checkout')
        api.releaseAll(otherWriter.handles)
        const otherCommit = api.acquireReservation(linked, 'fixture-commit-b', 'commit')
        if (otherCommit.ok || !('conflict' in otherCommit)) assert.fail('el commit de otro worktree no informó el conflicto de refs')
        assert.equal(otherCommit.conflict.domain, 'refs')
        assert.equal(api.ownReservation(linked), undefined, 'la adquisición fallida no deja el checkout reservado')
      } finally { api.releaseAll(first.handles) }
      assert.equal(api.ownReservation(repo.root), undefined)
      const next = api.acquireReservation(linked, 'fixture-commit-next', 'commit')
      assert.equal(next.ok, true)
      if (next.ok) api.releaseAll(next.handles)
    })
    const old = api.acquireReservation(repo.root, 'fixture-release-a', 'writer')
    assert.equal(old.ok, true)
    if (!old.ok) throw new Error('no se adquirió la reserva para probar liberación')
    const handle = old.handles[0]
    const saved = readFileSync(handle.path, 'utf8')
    const mutex = `${handle.path}.release`
    writeFileSync(mutex, '{unreadable')
    try {
      const retained = api.releaseReservation(handle)
      assert.equal(retained.state, 'retained')
      if (retained.state === 'retained') assert.equal(retained.code, 'release_abandoned')
      assert.equal(readFileSync(handle.path, 'utf8'), saved)
    } finally { rmSync(mutex, { force: true }) }
    assert.equal(api.releaseReservation(handle).state, 'released')
    const replacement = api.acquireReservation(repo.root, 'fixture-release-b', 'writer')
    assert.equal(replacement.ok, true)
    if (!replacement.ok) throw new Error('no se adquirió la reserva posterior')
    try {
      assert.equal(api.releaseReservation(handle).state, 'different')
      assert.equal(existsSync(replacement.handles[0].path), true)
    } finally { api.releaseAll(replacement.handles) }

    const pending = prepareWaitingWriter(repo.root, '20260101-0000-cdef')
    const reserved = api.acquireReservation(repo.root, pending.id, 'writer')
    assert.equal(reserved.ok, true)
    if (!reserved.ok) throw new Error('no se adquirió la reserva del writer para congelar')
    writeLegacyControl(repo.root, pending.id, { ...pending.control, reservation: reserved.handles[0] })
    try {
      // Un dueño que no puede existir: el PID de un hijo terminado podría reasignarse antes del rescate.
      const abandonedClaim = JSON.stringify({ pid: GONE_PID, lstart: null })
      writeFileSync(join(pending.store, 'harvest.claim.1'), abandonedClaim)
      let rescueScope: number | null = null
      let afterRescue!: Promise<number | null>
      const harvest = await withGitQueryScope('call', () => api.freezeHarvest(repo.root, pending.id, { state: 'cancelled' }, 'fixture\nSTATUS: done', {
        async beforeRescue() {
          rescueScope = currentGitQueryScope().scope
          afterRescue = new Promise((resolve) => setTimeout(() => resolve(currentGitQueryScope().scope), 1))
        },
      }))
      assert.notEqual(rescueScope, null)
      assert.equal(await afterRescue, null, 'un callback de la observación terminada no retiene el memo')
      assert.equal(readFileSync(join(pending.store, 'harvest.claim.1'), 'utf8'), abandonedClaim)
      assert.equal(existsSync(join(pending.store, 'harvest.claim.2')), true)
      assert.equal(harvest.state, 'cancelled')
      assert.equal(existsSync(harvest.patchFile), true)
      assert.equal(existsSync(join(pending.store, 'harvest.json')), true)
      assert.equal(api.ownReservation(repo.root), undefined)
      const repeated = await api.freezeHarvest(repo.root, pending.id, { state: 'failed' })
      assert.deepEqual(repeated, harvest, 'una cosecha publicada conserva su autoridad')
    } finally { api.releaseAll(reserved.handles) }
    const competing = prepareWaitingWriter(repo.root, '20260101-0000-def0')
    writeFileSync(join(competing.store, 'harvest.claim.1'), JSON.stringify({ pid: GONE_PID, lstart: null }))
    let announce!: () => void; let resume!: () => void
    const announced = new Promise<void>((resolve) => { announce = resolve })
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const slower = withGitQueryScope('call', () => api.freezeHarvest(repo.root, competing.id, { state: 'failed' }, 'slower', {
      async beforeRescue() { announce(); await gate },
    }))
    try {
      await Promise.race([announced, slower.then(() => { throw new Error('la cosecha terminó sin alcanzar el rescate') })])
      const winner = await withGitQueryScope('call', () => api.freezeHarvest(repo.root, competing.id, { state: 'done' }, 'winner\nSTATUS: done'))
      resume()
      assert.deepEqual(await slower, winner, 'el reclamante que pierde observa el registro publicado en otra vuelta')
      assert.equal(winner.state, 'done')
      assert.equal(existsSync(join(competing.store, 'harvest.claim.2')), true)
      assert.equal(existsSync(join(competing.store, 'harvest.claim.3')), false)
    } finally { resume(); await slower }
    // Un proceso que sale con SIGTERM y otro que lo ignora: los dos terminan (el segundo con SIGKILL tras la gracia) y
    // no retienen la reserva siguiente. El cese no acreditado de un writer cuyo supervisor ya no existe lo compara la
    // matriz de equivalencia (cancel-uncertain-cessation), y los ámbitos por vuelta de cancelWatch y settleGroup,
    // git-memo-scopes.test.ts.
    for (const onSignal of ['exit', 'ignore'] as const) {
      const supervised = await startSupervisedNode(repo.root, onSignal)
      try {
        const deadline = Date.now() + 5000
        while (!existsSync(supervised.marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
        assert.equal(existsSync(supervised.marker), true, 'el supervisor llegó a lanzar el proceso Node')
        writeFileSync(join(supervised.dir, 'cancel.request'), 'fixture cancel')
        // supervise espera la salida del proceso lanzado, así que su resultado acredita el cese, también del que ignora
        // SIGTERM y termina con SIGKILL tras la gracia. Un `kill(pid, 0)` no serviría: un zombi todavía responde y el PID
        // se puede reasignar.
        const terminal = await supervised.ended
        assert.equal(terminal.state, 'cancelled')
        if (process.platform === 'win32') {
          assert.equal(existsSync(supervised.signalled), false, 'taskkill conserva el comportamiento existente sin entregar SIGTERM a Node')
        } else assert.equal(readFileSync(supervised.signalled, 'utf8'), 'SIGTERM')
        const after = api.acquireReservation(repo.root, `fixture-after-${onSignal}`, 'writer')
        assert.equal(after.ok, true, 'la cancelación no retiene la reserva siguiente')
        if (after.ok) api.releaseAll(after.handles)
      } finally { await supervised.cleanup() }
    }
    // Cada gate se prueba contra la escritura protegida: `--apply` con el digest de un ensayo válido. computeCommit
    // comprueba los gates antes que el digest, así que el rechazo viene del gate y no de un digest viejo.
    const commit = ['sdd', 'commit', 'f', '--subject', 'fixture candidate']
    const draft = await main(commit, cleanGitEnv(), flow.root)
    assert.equal(draft.code, 0)
    const digest = (draft.out as { digest: string }).digest
    const head = gitIn(flow.root, 'rev-parse', 'HEAD')
    const index = gitIn(flow.root, 'ls-files', '--stage', '-z')
    // `step` es el paso que el rechazo nombra cuando el gate devuelve el flujo a un paso anterior.
    const blocked = async (name: string, code: string, step?: string, apply = ['--apply', '--digest', digest]) => {
      const out = await main([...commit, ...apply], cleanGitEnv(), flow.root)
      assert.notEqual(out.code, 0, name)
      assert.equal((out.out as { code: string }).code, code, name)
      if (step) assert.equal((out.out as { message: string }).message, `el paso es ${step}, no review_and_commit`, name)
      assert.equal(gitIn(flow.root, 'rev-parse', 'HEAD'), head, `${name}: HEAD no cambia`)
      assert.equal(gitIn(flow.root, 'ls-files', '--stage', '-z'), index, `${name}: el índice no cambia`)
    }
    await blocked('digest ajeno', 'digest_mismatch', undefined, ['--apply', '--digest', `sha256:${'0'.repeat(64)}`])
    const reviewStatus = join(flow.root, '.sdd-ai', 'runs', '20260101-0000-abcd', 'status.json')
    const validReview = readFileSync(reviewStatus)
    writeFileSync(reviewStatus, JSON.stringify({ state: 'failed', round: 1 }))
    try { await blocked('revisión fallida', 'review_missing') } finally { writeFileSync(reviewStatus, validReview) }
    const verifyStore = join(gitIn(flow.root, 'rev-parse', '--absolute-git-dir'), 'sdd-ai', 'verify')
    const receipt = readdirSync(verifyStore).map((name) => join(verifyStore, name, 'receipt.json')).find(existsSync)
    assert.ok(receipt)
    const validReceipt = readFileSync(receipt)
    rmSync(receipt)
    try { await blocked('recibo ausente', 'step_not_commit', 'verify') } finally { writeFileSync(receipt, validReceipt) }
    const approvalsPath = join(flow.root, '.plans', 'f', 'sdd-ai-approvals.json')
    const validApprovals = readFileSync(approvalsPath)
    const outdated = JSON.parse(validApprovals.toString('utf8'))
    outdated.approvals.find((approval: { gate: string }) => approval.gate === 'tasks').fingerprint = 'sha256:' + '0'.repeat(64)
    writeFileSync(approvalsPath, JSON.stringify(outdated))
    try { await blocked('gate vencido', 'step_not_commit', 'gate') } finally { writeFileSync(approvalsPath, validApprovals) }
    // Un gate ausente: el gate de tasks no tiene ninguna fuente que lo apruebe. Hacen falta las dos cosas: vaciar el
    // registro quita la aprobación registrada, y llevar el header del plan a `plan-approved` quita la acreditación por
    // header, que con `verified` daba el gate por aprobado sin registro (approved_unfingerprinted). A diferencia del
    // gate vencido, aquí no hay ninguna aprobación, ni siquiera una con otra huella.
    const planPath = join(flow.root, '.plans', 'f', 'plan.md')
    const validPlan = readFileSync(planPath)
    writeFileSync(approvalsPath, JSON.stringify({ schema_version: 1, approvals: [] }))
    writeFileSync(planPath, validPlan.toString('utf8').replace(/^status: .*$/m, 'status: plan-approved'))
    try { await blocked('gate ausente', 'step_not_commit', 'gate') } finally { writeFileSync(approvalsPath, validApprovals); writeFileSync(planPath, validPlan) }
    // Restaurados los gates, el mismo digest aplica: los rechazos anteriores no se debían a él.
    const applied = await main([...commit, '--apply', '--digest', digest], cleanGitEnv(), flow.root)
    assert.equal(applied.code, 0)
    assert.equal(gitIn(flow.root, 'rev-parse', 'HEAD^'), head)
  }) } finally { events.stop(); flow.cleanup(); rmSync(linked, { recursive: true, force: true }); repo.cleanup() }
})
