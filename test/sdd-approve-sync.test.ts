import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readFlow } from '../src/sdd/read.ts'
import { readHeader } from '../src/sdd/markdown.ts'
import { accept, answer, behind, cli, fixture, logged, planText, snapshot, SPEC, TASKS, transcriptPath } from './sdd-approve-fixture.ts'

const data = (file: string) => { const h = readHeader(readFileSync(file, 'utf8')); assert.ok(h.ok); return h.data }
const states = (out: any) => Object.fromEntries(out.gates.map((g: any) => [g.gate, g.state]))

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

test('approve plan-tasks sincroniza tasks-ready y coincide con status', () => {
  const f = fixture()
  try {
    accept(f, 'spec')
    const out = accept(f, 'plan-tasks')
    assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
    assert.equal(states(out)['plan-tasks'], 'approved')
    assert.deepEqual(out, cli(f, 'status', 'f').out)
    assert.ok(!out.notes.some((n: any) => ['header_behind', 'header_ahead'].includes(n.code)))
  } finally { f.cleanup() }
})

test('approve sincroniza las tres profundidades y solo el prefijo autorizado', () => {
  for (const depth of ['corta', 'normal', 'completa'] as const) {
    const f = fixture(depth)
    try {
      if (depth === 'corta') {
        accept(f, 'single')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
        assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, null)
        continue
      }
      accept(f, 'spec')
      const first = logged(f)[0]
      assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, first.at)
      behind(f)
      if (depth === 'normal') {
        accept(f, 'plan-tasks')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
      } else {
        const plan = accept(f, 'plan')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'plan-approved')
        assert.equal(states(plan).tasks, 'pending')
        accept(f, 'tasks')
        assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
      }
      assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, first.at)
      writeFileSync(join(f.dir, 'spec.md'), SPEC + '\nCambio sustantivo.\n')
      const out = accept(f, 'spec')
      const last = logged(f).at(-1)!
      assert.equal(data(join(f.dir, 'handoff.md')).spec_approved_at, last.at)
      assert.notEqual(last.at, first.at)
      assert.equal(data(join(f.dir, 'plan.md')).status, 'tasks-ready')
      assert.ok(out.gates.slice(1).every((g: any) => g.state === 'stale'))
    } finally { f.cleanup() }
  }
})

test('una sincronizacion efectiva conserva huellas pruebas cuerpos comentarios y gate externo', () => {
  for (const value of [undefined, '', 'null', '~', '"fecha vieja"']) {
    for (const nl of ['\n', '\r\n']) {
      const f = fixture()
      try {
        accept(f, 'spec'); accept(f, 'plan-tasks')
        const h = `---\nprofundidad: normal # profundidad\nphase: implementing\ngate_status: awaiting\nother: 'literal'\nnested:\n  value: "otra"\n${value === undefined ? '' : `spec_approved_at: ${value} # fecha\n`}---\n\n# Handoff\n\nCuerpo intacto.\n`.replaceAll('\n', nl)
        const p = planText('normal').replace('status: planned', 'status: "planned" # estado').replaceAll('\n', nl)
        writeFileSync(join(f.dir, 'handoff.md'), h)
        writeFileSync(join(f.dir, 'plan.md'), p)
        const original = snapshot(f)
        const facts = readFlow(f.root, 'f').facts
        const entries = logged(f)
        const r = cli(f, 'approve', 'f', 'plan-tasks')
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
        assert.equal(cli(f, 'approve', 'f', 'plan-tasks').code, 0)
        assert.deepEqual(snapshot(f), synced)
      } finally { f.cleanup() }
    }
  }
})

test('reaprobar exige cada gate vencido y conserva implementing verified y tasks-ready', () => {
  for (const changed of ['spec.md', 'plan.md', 'tasks.md'] as const) {
    const f = fixture('completa')
    try {
      accept(f, 'spec'); accept(f, 'plan'); accept(f, 'tasks')
      writeFileSync(join(f.dir, changed), readFileSync(join(f.dir, changed), 'utf8') + '\nCambio sustantivo.\n')
      const gate = { 'spec.md': 'spec', 'plan.md': 'plan', 'tasks.md': 'tasks' }[changed]!
      assert.equal(cli(f, 'status', 'f').out.next.gate, gate)
      const old = logged(f)
      const out = accept(f, gate)
      if (gate !== 'tasks') {
        const dependents = out.gates.slice(gate === 'spec' ? 1 : 2)
        assert.ok(dependents.every((g: any) => g.state === 'stale'))
        // El header conservado (tasks-ready) sigue acreditando los dependientes vencidos: status lo advierte.
        const ahead = cli(f, 'status', 'f').out.notes.filter((n: any) => n.code === 'header_ahead').map((n: any) => n.detail)
        for (const g of dependents) assert.ok(ahead.some((d: string) => d.includes(`gate ${g.gate}`)), `${changed}: ${JSON.stringify(ahead)}`)
        // Y cada dependiente exige su propia respuesta: la reaprobación de la spec no lo recupera.
        const next = dependents[0].gate
        const before = snapshot(f)
        assert.equal(cli(f, 'approve', 'f', next).out.code, 'approval_missing')
        assert.deepEqual(snapshot(f), before)
      }
      assert.deepEqual(logged(f).slice(0, old.length), old)
      if (gate === 'spec') accept(f, 'plan')
      if (gate !== 'tasks') accept(f, 'tasks')
      const final = cli(f, 'status', 'f').out
      assert.ok(final.gates.every((g: any) => g.state === 'approved'))
      assert.ok(!final.notes.some((n: any) => ['header_ahead', 'header_behind'].includes(n.code)))
    } finally { f.cleanup() }
  }
  for (const status of ['implementing', 'verified', 'tasks-ready']) {
    const depth = status === 'tasks-ready' ? 'completa' : 'normal'
    const f = fixture(depth)
    try {
      accept(f, 'spec'); accept(f, depth === 'normal' ? 'plan-tasks' : 'plan')
      writeFileSync(join(f.dir, 'plan.md'), planText(depth, status))
      if (status === 'verified') writeFileSync(join(f.dir, 'tasks.md'), TASKS.replace('[ ]', '[x]'))
      const gate = depth === 'normal' ? 'plan-tasks' : 'plan'
      const file = join(f.dir, depth === 'normal' ? 'tasks.md' : 'plan.md')
      writeFileSync(file, readFileSync(file, 'utf8') + '\nCambio.\n')
      assert.equal(states(accept(f, gate))[gate], 'approved')
      assert.equal(data(join(f.dir, 'plan.md')).status, status)
    } finally { f.cleanup() }
  }
})

test('la adopcion heredada solo recupera pruebas vigentes y no crea ni repara headers', (t) => {
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
        accept(f, 'spec')
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
          const first = cli(f, 'status', 'f').out
          assert.deepEqual(cli(f, 'status', 'f').out, first)
          assert.ok(first.blocked_reasons.length > 0, JSON.stringify(first))
          const r = cli(f, 'approve', 'f', 'plan-tasks')
          assert.equal(r.code, 2, JSON.stringify(r.out))
        } finally { chmodSync(h, 0o644) }
        // Ni se repara ni se reescribe: mismos bytes y mismo mtime.
        assert.deepEqual(snapshot(f), before)
        continue
      }
      const before = snapshot(f)
      const first = cli(f, 'status', 'f').out
      assert.deepEqual(cli(f, 'status', 'f').out, first)
      assert.deepEqual(snapshot(f), before)
      if (kind === 'header' || kind === 'unproven') {
        assert.ok(first.notes.some((n: any) => n.code === (kind === 'header' ? 'approved_unfingerprinted' : 'approval_unproven')))
        // Un header o una entrada sin proof no sustituyen una respuesta humana.
        const r = cli(f, 'approve', 'f', 'spec')
        assert.equal(r.code, 2)
        assert.deepEqual(snapshot(f), before)
        accept(f, 'spec')
      } else if (kind === 'invalid') {
        assert.equal(cli(f, 'approve', 'f', 'spec').code, 2)
        assert.deepEqual(snapshot(f), before)
      } else if (kind === 'proven') {
        assert.equal(cli(f, 'approve', 'f', 'spec').code, 0)
        const entries = JSON.parse(before['sdd-ai-approvals.json']!.text).approvals
        assert.deepEqual(logged(f), entries)
        // La recuperación completa el campo atrasado con el at registrado.
        assert.equal(data(h).spec_approved_at, entries.at(-1).at)
      } else {
        const out = accept(f, kind === 'empty-plan' ? 'spec' : 'plan-tasks')
        assert.equal(out.code, undefined)
        assert.equal(existsSync(h), kind !== 'absent')
        if (kind === 'empty') assert.equal(readFileSync(h, 'utf8'), '')
        if (kind === 'empty-plan') assert.equal(readFileSync(join(f.dir, 'plan.md'), 'utf8'), '')
      }
    } finally { f.cleanup() }
  }
})
