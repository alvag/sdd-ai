import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readFlow } from '../src/sdd/read.ts'
import { readHeader } from '../src/sdd/markdown.ts'
import { currentGitQueryScope } from '../src/git-memo.ts'
import { onStatusWritten } from '../src/runs.ts'
import { REAL_DEPS } from '../src/sdd/approve-sync.ts'
import { accept, acceptInProcess, answer, checkpoint, runInProcess, behind, cli, fixture, logged, planText, snapshot, SPEC, TASKS, transcriptPath } from './sdd-approve-fixture.ts'

const data = (file: string) => { const h = readHeader(readFileSync(file, 'utf8')); assert.ok(h.ok); return h.data }
const states = (out: any) => Object.fromEntries(out.gates.map((g: any) => [g.gate, g.state]))

test('la reutilizacion de fixtures y main conserva el aislamiento y restaura el contexto', async (t) => {
  const exterior = { env: { ...process.env }, cwd: process.cwd(), exitCode: process.exitCode }
  const listener = () => {}
  const previousListener = onStatusWritten(listener)
  const f = fixture(), other = fixture()
  let saved: ReturnType<typeof checkpoint> | undefined
  const capture = () => ({ env: { ...process.env }, cwd: process.cwd(), exitCode: process.exitCode })
  const restored = (before: ReturnType<typeof capture>) => {
    assert.deepEqual({ ...process.env }, before.env)
    assert.equal(process.cwd(), before.cwd)
    assert.equal(process.exitCode, before.exitCode)
    assert.equal(process.env.SDD_APPROVE_FIXTURE_ONLY, undefined)
    assert.equal(onStatusWritten(listener), listener)
    assert.equal(currentGitQueryScope().scope, null)
  }
  // Inventario independiente de snapshot: incluye .git, directorios y destinos de enlaces.
  const inventory = (root: string) => {
    const entries: Array<{ path: string; type: string; bytes?: string; target?: string }> = []
    const walk = (path: string) => {
      const full = join(root, path), stat = lstatSync(full)
      if (stat.isSymbolicLink()) entries.push({ path, type: 'link', target: readlinkSync(full) })
      else if (stat.isDirectory()) {
        entries.push({ path, type: 'directory' })
        for (const name of readdirSync(full).sort()) walk(join(path, name))
      } else {
        assert.ok(stat.isFile(), `tipo inesperado: ${path}`)
        entries.push({ path, type: 'file', bytes: readFileSync(full).toString('base64') })
      }
    }
    walk('')
    return entries
  }
  try {
    process.env.SDD_APPROVE_EXTERIOR_ONLY = 'exterior'
    delete process.env.SDD_APPROVE_FIXTURE_ONLY
    delete f.env.SDD_APPROVE_EXTERIOR_ONLY
    f.env.SDD_APPROVE_FIXTURE_ONLY = 'fixture'
    const fixtureEnv = { ...f.env }
    assert.notEqual(f.env.CLAUDE_CODE_SESSION_ID, other.env.CLAUDE_CODE_SESSION_ID)
    assert.notEqual(f.sessionDir, other.sessionDir)
    answer(f, 'spec')
    let observations = 0
    let closedScope: (() => ReturnType<typeof currentGitQueryScope>) | undefined
    const observe = (root: string, id: string) => {
      observations++
      assert.deepEqual({ ...process.env }, fixtureEnv)
      assert.equal(process.env.SDD_APPROVE_EXTERIOR_ONLY, undefined)
      assert.equal(process.env.SDD_APPROVE_FIXTURE_ONLY, 'fixture')
      assert.equal(process.cwd(), f.root)
      assert.equal(root, f.root)
      assert.equal(id, 'f')
      assert.notEqual(process.env, f.env)
      process.env.SDD_APPROVE_FIXTURE_ONLY = 'cambio temporal'
      assert.deepEqual(f.env, fixtureEnv)
      process.env.SDD_APPROVE_FIXTURE_ONLY = fixtureEnv.SDD_APPROVE_FIXTURE_ONLY
      process.exitCode = 17
      assert.notEqual(currentGitQueryScope().scope, null)
      const resume = AsyncLocalStorage.snapshot()
      closedScope = () => resume(currentGitQueryScope)
      REAL_DEPS.activity(root, id)
    }
    const beforeSuccess = capture()
    const success = await runInProcess(f, ['approve', 'f', 'spec'], { approve: { ...REAL_DEPS, activity: observe } })
    restored(beforeSuccess)
    assert.equal(success.code, 0)
    assert.ok(observations > 0)
    assert.ok(closedScope)
    assert.equal(closedScope().scope, null, 'las tareas del ámbito cerrado no reutilizan su memoización')
    assert.deepEqual(f.env, fixtureEnv)

    // La respuesta de una sesión no autoriza la otra.
    const beforeMissing = capture(), otherBefore = snapshot(other)
    const missing = await runInProcess(other, ['approve', 'f', 'spec'])
    restored(beforeMissing)
    assert.equal(missing.code, 2)
    assert.equal(missing.out.code, 'approval_missing')
    assert.deepEqual(snapshot(other), otherBefore)
    assert.deepEqual(logged(other), [])

    const failure = new Error('fallo controlado')
    const otherEnv = { ...other.env }, beforeException = capture()
    let failedChecks = 0
    await assert.rejects(runInProcess(other, ['approve', 'f', 'spec'], { approve: { ...REAL_DEPS,
      activity: () => {
        failedChecks++
        process.exitCode = 19
        assert.notEqual(currentGitQueryScope().scope, null)
        const resume = AsyncLocalStorage.snapshot()
        closedScope = () => resume(currentGitQueryScope)
        throw failure
      },
    } }), (error: unknown) => error === failure)
    restored(beforeException)
    assert.equal(failedChecks, 1)
    assert.equal(closedScope().scope, null)
    assert.deepEqual(other.env, otherEnv)
    assert.deepEqual(snapshot(other), otherBefore)

    f.env.SDD_AI_WORKER = '1'
    const workerEnv = { ...f.env }, beforeWorker = capture(), workerBefore = snapshot(f)
    const worker = await runInProcess(f, ['approve', 'f', 'spec'])
    restored(beforeWorker)
    assert.equal(worker.code, 2)
    assert.equal(worker.out.code, 'runner_required')
    assert.deepEqual(f.env, workerEnv)
    assert.deepEqual(snapshot(f), workerBefore)
    delete f.env.SDD_AI_WORKER
    answer(other, 'spec')
    const beforeOther = capture()
    const otherSuccess = await runInProcess(other, ['approve', 'f', 'spec'])
    restored(beforeOther)
    assert.equal(otherSuccess.code, 0)
    assert.equal(logged(other).length, 1)
    assert.equal(logged(f).length, 1)

    const beforeOverlap = capture()
    const original = runInProcess(f, ['approve', 'f', 'spec'], { approve: { ...REAL_DEPS, activity: observe } })
    try {
      await assert.rejects(runInProcess(other, ['status', 'f']), /no admite llamadas superpuestas/)
    } finally {
      const completed = await original
      restored(beforeOverlap)
      assert.equal(completed.code, 0)
    }
    assert.deepEqual(f.env, fixtureEnv)
    assert.equal(closedScope().scope, null)

    // Dos resets comprueban que ni las mutaciones ni el primer reset cambian la captura.
    if (process.platform === 'win32') t.diagnostic('enlaces del checkpoint: omitidos, requieren permisos POSIX')
    mkdirSync(join(f.sessionDir, 'captured'))
    writeFileSync(join(f.sessionDir, 'captured', 'original'), 'contenido inicial')
    if (process.platform !== 'win32') symlinkSync('original', join(f.sessionDir, 'captured', 'link'))
    const trees = { repo: inventory(f.root), session: inventory(f.sessionDir) }, checkpointEnv = { ...f.env }
    saved = checkpoint(f)
    for (const variant of ['primera', 'segunda']) {
      answer(f, 'plan-tasks')
      writeFileSync(join(f.dir, 'sdd-ai-approvals.json'), '{"approvals":[]}')
      writeFileSync(join(f.dir, 'handoff.md'), variant)
      writeFileSync(join(f.root, '.git', 'config'), variant)
      writeFileSync(join(f.sessionDir, 'captured', 'original'), variant)
      if (process.platform !== 'win32') rmSync(join(f.sessionDir, 'captured', 'link'))
      mkdirSync(join(f.root, 'residue', 'nested'), { recursive: true })
      writeFileSync(join(f.root, 'residue', 'nested', 'extra'), variant)
      mkdirSync(join(f.sessionDir, 'residue'))
      writeFileSync(join(f.sessionDir, 'residue', 'extra'), variant)
      if (process.platform !== 'win32') symlinkSync('extra', join(f.sessionDir, 'residue', 'link'))
      delete f.env.PATH
      f.env.SDD_APPROVE_FIXTURE_ONLY = variant
      f.env.SDD_APPROVE_RESIDUE = variant
      saved.reset()
      assert.deepEqual(inventory(f.root), trees.repo)
      assert.deepEqual(inventory(f.sessionDir), trees.session)
      assert.deepEqual(f.env, checkpointEnv)
      assert.equal(existsSync(join(f.root, 'residue')), false)
      assert.equal(existsSync(join(f.sessionDir, 'residue')), false)
    }
  } finally {
    onStatusWritten(previousListener)
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(exterior.env, key)) delete process.env[key]
    for (const [key, value] of Object.entries(exterior.env)) process.env[key] = value
    process.exitCode = exterior.exitCode
    process.chdir(exterior.cwd)
    saved?.cleanup(); f.cleanup(); other.cleanup()
  }
})

test('approve spec sincroniza el at exacto sin plan y branch lo conserva', () => {
  const f = fixture('normal', true)
  try {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: f.root, encoding: 'utf8' }).trim()
    git('commit', '--allow-empty', '-qm', 'base')
    const base = git('branch', '--show-current')
    git('checkout', '-qb', 'fix/f')
    const h = join(f.dir, 'handoff.md')
    writeFileSync(h, readFileSync(h, 'utf8').replace('profundidad: normal', `profundidad: normal\nchange_type: fix\nbase_branch: ${base}`))
    const out = accept(f, 'spec')
    assert.equal(out.next.step, 'branch')
    const at = logged(f)[0].at
    assert.equal(data(h).spec_approved_at, at)
    assert.ok(readFileSync(h, 'utf8').includes(`spec_approved_at: ${at}\n`))
    assert.equal(existsSync(join(f.dir, 'plan.md')), false)
    const applied = cli(f, 'branch', 'f', '--apply', '--current')
    assert.equal(applied.code, 0, JSON.stringify(applied.out))
    assert.equal(data(h).spec_approved_at, at)
    assert.equal(existsSync(join(f.dir, 'plan.md')), false)
  } finally { f.cleanup() }
})

test('approve plan-tasks sincroniza tasks-ready y coincide con status', async () => {
  const f = fixture()
  try {
    await acceptInProcess(f, 'spec')
    const out = await acceptInProcess(f, 'plan-tasks')
    assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
    assert.equal(states(out)['plan-tasks'], 'approved')
    assert.deepEqual(out, (await runInProcess(f, ['status', 'f'])).out)
    assert.ok(!out.notes.some((n: any) => ['header_behind', 'header_ahead'].includes(n.code)))
  } finally { f.cleanup() }
})

test('approve sincroniza las tres profundidades y solo el prefijo autorizado', async () => {
  for (const depth of ['corta', 'normal', 'completa'] as const) {
    const f = fixture(depth)
    try {
      if (depth === 'corta') {
        await acceptInProcess(f, 'single')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
        assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, null)
        continue
      }
      await acceptInProcess(f, 'spec')
      const first = logged(f)[0]
      assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, first.at)
      behind(f)
      if (depth === 'normal') {
        await acceptInProcess(f, 'plan-tasks')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
      } else {
        const plan = await acceptInProcess(f, 'plan')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'plan-approved')
        assert.equal(states(plan).tasks, 'pending')
        await acceptInProcess(f, 'tasks')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
      }
      assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, first.at)
      writeFileSync(join(f.dir, 'spec.md'), SPEC + '\nCambio sustantivo.\n')
      const out = await acceptInProcess(f, 'spec')
      const last = logged(f).at(-1)!
      assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, last.at)
      assert.notEqual(last.at, first.at)
      assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
      assert.ok(out.gates.slice(1).every((g: any) => g.state === 'stale'))
    } finally { f.cleanup() }
  }
})

test('una sincronizacion efectiva conserva huellas pruebas cuerpos comentarios y gate externo', async () => {
  const f = fixture()
  let saved: ReturnType<typeof checkpoint> | undefined
  try {
    await acceptInProcess(f, 'spec'); await acceptInProcess(f, 'plan-tasks')
    saved = checkpoint(f)
    for (const value of [undefined, '', 'null', '~', '"fecha vieja"']) {
      for (const nl of ['\n', '\r\n']) {
        saved.reset()
        const h = `---\nprofundidad: normal # profundidad\nphase: implementing\ngate_status: awaiting\nother: 'literal'\nnested:\n  value: "otra"\n${value === undefined ? '' : `spec_approved_at: ${value} # fecha\n`}---\n\n# Handoff\n\nCuerpo intacto.\n`.replaceAll('\n', nl)
        const p = planText('normal').replace('status: planned', 'status: "planned" # estado').replaceAll('\n', nl)
        writeFileSync(join(f.dir, 'handoff.md'), h)
        writeFileSync(join(f.dir, 'plan.md'), p)
        const original = snapshot(f)
        const facts = readFlow(f.root, 'f').facts
        const entries = logged(f)
        const r = await runInProcess(f, ['approve', 'f', 'plan-tasks'])
        assert.equal(r.code, 0, JSON.stringify(r.out))
        const after = snapshot(f)
        assert.deepEqual(logged(f), entries)
        assert.deepEqual(readFlow(f.root, 'f').facts.fingerprints, facts.fingerprints)
        assert.deepEqual(after['spec.md'], original['spec.md'])
        assert.deepEqual(after['tasks.md'], original['tasks.md'])
        assert.equal(after['plan.md']!.text, p.replace('"planned"', 'tasks-ready'))
        const expected = value === undefined ? h.replace(`${nl}---${nl}`, `${nl}spec_approved_at: ${entries[0].at}${nl}---${nl}`)
          : h.replace(`spec_approved_at: ${value} # fecha`, `spec_approved_at: ${entries[0].at} # fecha`)
        assert.equal(after['handoff.md']!.text, expected)
        assert.equal(data(join(f.dir, 'handoff.md')).gate_status, 'awaiting')
        assert.equal(r.out.next.step, 'external_gate')
        const synced = snapshot(f)
        assert.equal((await runInProcess(f, ['approve', 'f', 'plan-tasks'])).code, 0)
        assert.deepEqual(snapshot(f), synced)
      }
    }
  } finally { saved?.cleanup(); f.cleanup() }
})

test('reaprobar exige cada gate vencido y conserva implementing verified y tasks-ready', async () => {
  for (const changed of ['spec.md', 'plan.md', 'tasks.md'] as const) {
    const f = fixture('completa')
    try {
      await acceptInProcess(f, 'spec'); await acceptInProcess(f, 'plan'); await acceptInProcess(f, 'tasks')
      writeFileSync(join(f.dir, changed), readFileSync(join(f.dir, changed), 'utf8') + '\nCambio sustantivo.\n')
      const gate = { 'spec.md': 'spec', 'plan.md': 'plan', 'tasks.md': 'tasks' }[changed]!
      assert.equal((await runInProcess(f, ['status', 'f'])).out.next.gate, gate)
      const old = logged(f)
      const out = await acceptInProcess(f, gate)
      if (gate !== 'tasks') {
        const dependents = out.gates.slice(gate === 'spec' ? 1 : 2)
        assert.ok(dependents.every((g: any) => g.state === 'stale'))
        // El header conservado (tasks-ready) sigue acreditando los dependientes vencidos: status lo advierte.
        const ahead = (await runInProcess(f, ['status', 'f'])).out.notes.filter((n: any) => n.code === 'header_ahead').map((n: any) => n.detail)
        for (const g of dependents) assert.ok(ahead.some((d: string) => d.includes(`gate ${g.gate}`)), `${changed}: ${JSON.stringify(ahead)}`)
        // Y cada dependiente exige su propia respuesta: la reaprobación de la spec no lo recupera.
        const next = dependents[0].gate
        const before = snapshot(f)
        assert.equal((await runInProcess(f, ['approve', 'f', next])).out.code, 'approval_missing')
        assert.deepEqual(snapshot(f), before)
      }
      assert.deepEqual(logged(f).slice(0, old.length), old)
      if (gate === 'spec') await acceptInProcess(f, 'plan')
      if (gate !== 'tasks') await acceptInProcess(f, 'tasks')
      const final = (await runInProcess(f, ['status', 'f'])).out
      assert.ok(final.gates.every((g: any) => g.state === 'approved'))
      assert.ok(!final.notes.some((n: any) => ['header_ahead', 'header_behind'].includes(n.code)))
    } finally { f.cleanup() }
  }
  for (const status of ['implementing', 'verified', 'tasks-ready']) {
    const depth = status === 'tasks-ready' ? 'completa' : 'normal'
    const f = fixture(depth)
    try {
      await acceptInProcess(f, 'spec'); await acceptInProcess(f, depth === 'normal' ? 'plan-tasks' : 'plan')
      writeFileSync(join(f.dir, 'plan.md'), planText(depth, status))
      if (status === 'verified') writeFileSync(join(f.dir, 'tasks.md'), TASKS.replace('[ ]', '[x]'))
      const gate = depth === 'normal' ? 'plan-tasks' : 'plan'
      const file = join(f.dir, depth === 'normal' ? 'tasks.md' : 'plan.md')
      writeFileSync(file, readFileSync(file, 'utf8') + '\nCambio.\n')
      assert.equal(states(await acceptInProcess(f, gate))[gate], 'approved')
      assert.equal(data(join(f.dir, 'plan.md')).status, status)
    } finally { f.cleanup() }
  }
})

test('la adopcion heredada solo recupera pruebas vigentes y no crea ni repara headers', async (t) => {
  for (const kind of ['header', 'unproven', 'proven', 'absent', 'empty', 'empty-plan', 'invalid', 'unreadable']) {
    // Un archivo sin permisos de lectura solo se reproduce con permisos POSIX.
    if (kind === 'unreadable' && process.platform === 'win32') {
      t.diagnostic('unreadable: omitido, requiere permisos POSIX')
      continue
    }
    const f = fixture('normal', kind === 'empty-plan')
    try {
      const h = join(f.dir, 'handoff.md')
      if (kind === 'header') writeFileSync(join(f.dir, 'plan.md'), planText('normal', 'tasks-ready'))
      else if (kind !== 'empty-plan') {
        await acceptInProcess(f, 'spec')
        if (kind === 'unproven') {
          const entries = logged(f).map(({ proof, ...entry }) => entry)
          writeFileSync(join(f.dir, 'sdd-ai-approvals.json'), JSON.stringify({ schema_version: 1, approvals: entries }))
          rmSync(transcriptPath(f))
        }
        behind(f)
      }
      if (kind === 'absent') rmSync(h)
      if (kind === 'empty') writeFileSync(h, '')
      if (kind === 'empty-plan') writeFileSync(join(f.dir, 'plan.md'), '')
      if (kind === 'invalid') writeFileSync(h, '---\nnot: [valid\n---\n')
      if (kind === 'unreadable') {
        assert.notEqual(process.getuid?.(), 0, 'como root el archivo sigue legible: el caso no se puede comprobar')
        const before = snapshot(f)
        chmodSync(h, 0o000)
        try {
          const first = (await runInProcess(f, ['status', 'f'])).out
          assert.deepEqual((await runInProcess(f, ['status', 'f'])).out, first)
          assert.ok(first.blocked_reasons.length > 0, JSON.stringify(first))
          const r = await runInProcess(f, ['approve', 'f', 'plan-tasks'])
          assert.equal(r.code, 2, JSON.stringify(r.out))
        } finally { chmodSync(h, 0o644) }
        // Ni se repara ni se reescribe: mismos bytes y mismo mtime.
        assert.deepEqual(snapshot(f), before)
        continue
      }
      const before = snapshot(f)
      const first = (await runInProcess(f, ['status', 'f'])).out
      assert.deepEqual((await runInProcess(f, ['status', 'f'])).out, first)
      assert.deepEqual(snapshot(f), before)
      if (kind === 'header' || kind === 'unproven') {
        assert.ok(first.notes.some((n: any) => n.code === (kind === 'header' ? 'approved_unfingerprinted' : 'approval_unproven')))
        // Un header o una entrada sin proof no sustituyen una respuesta humana.
        const r = await runInProcess(f, ['approve', 'f', 'spec'])
        assert.equal(r.code, 2)
        assert.deepEqual(snapshot(f), before)
        await acceptInProcess(f, 'spec')
      } else if (kind === 'invalid') {
        assert.equal((await runInProcess(f, ['approve', 'f', 'spec'])).code, 2)
        assert.deepEqual(snapshot(f), before)
      } else if (kind === 'proven') {
        assert.equal((await runInProcess(f, ['approve', 'f', 'spec'])).code, 0)
        const entries = JSON.parse(before['sdd-ai-approvals.json']!.text).approvals
        assert.deepEqual(logged(f), entries)
        // La recuperación completa el campo atrasado con el at registrado.
        assert.equal(data(h).spec_approved_at, entries.at(-1).at)
      } else {
        const out = await acceptInProcess(f, kind === 'empty-plan' ? 'spec' : 'plan-tasks')
        assert.equal(out.code, undefined)
        assert.equal(existsSync(h), kind !== 'absent')
        if (kind === 'empty') assert.equal(readFileSync(h, 'utf8'), '')
        if (kind === 'empty-plan') assert.equal(readFileSync(join(f.dir, 'plan.md'), 'utf8'), '')
      }
    } finally { f.cleanup() }
  }
})
