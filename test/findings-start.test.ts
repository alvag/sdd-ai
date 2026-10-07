import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { renderFindingsTemplate } from '../src/findings.ts'
import { startPreview, startApply, type FlowFilesIo } from '../src/sdd/start.ts'

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'sdd-findings-start-'))
  const root = join(scratch, 'repo')
  mkdirSync(root)
  const env = { PATH: '/usr/bin:/bin', HOME: join(scratch, 'home'), CODEX_HOME: join(scratch, 'codex'), SDD_AI_TELEMETRY: 'off', SDD_AI_PROJECTION: 'off' }
  for (const dir of [env.HOME, env.CODEX_HOME]) mkdirSync(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base')
  mkdirSync(join(root, '.sdd-ai'))
  writeFileSync(join(root, '.sdd-ai', 'config.yml'), 'cross_model:\n  schema_version: 1\n  families: [codex]\n  selection: full\n')
  const requestFile = join(scratch, 'request.md')
  writeFileSync(requestFile, 'Exportar CSV\n')
  return { scratch, root, git, deps: { env, hasCli: () => true }, input: { depth: 'normal', risk: 'low', changeType: 'feat', requestFile } }
}

test('start crea el registro vacío solo al aplicar y conserva su paridad Git', () => {
  const s = fixture()
  try {
    startPreview(s.root, 'f', {}, s.deps)
    assert.equal(existsSync(join(s.root, '.plans', 'f', 'hallazgos.md')), false)
    const applied = startApply(s.root, 'f', s.input, s.deps)
    assert.deepEqual(applied.created, ['pedido.md', 'antecedentes.json', 'handoff.md', 'hallazgos.md'].map((n) => `.plans/f/${n}`))
    const content = readFileSync(join(s.root, '.plans', 'f', 'hallazgos.md'), 'utf8')
    assert.equal(content, renderFindingsTemplate('f'))
    assert.doesNotMatch(content, /^## H-\d+/m)
    const paths = ['hallazgos.md', 'handoff.md'].map((n) => `.plans/f/${n}`)
    for (const ignored of [false, true]) {
      if (ignored) writeFileSync(join(s.root, '.git', 'info', 'exclude'), '.plans/\n')
      const statuses = paths.map((p) => spawnSync('git', ['check-ignore', '-v', p], { cwd: s.root, encoding: 'utf8', env: s.deps.env }))
      assert.equal(statuses[0].status, statuses[1].status)
      assert.equal(statuses[0].status, ignored ? 0 : 1)
      const gitStatus = paths.map((p) => s.git('status', '--porcelain', '--untracked-files=all', '--', p).slice(0, 2))
      assert.deepEqual(gitStatus, ignored ? ['', ''] : ['??', '??'])
    }
  } finally { rmSync(s.scratch, { recursive: true, force: true }) }
})

test('start deshace el flujo entero si falla la escritura del registro', () => {
  const s = fixture()
  try {
    const original = join(s.root, '.plans', 'existing')
    mkdirSync(original, { recursive: true })
    writeFileSync(join(original, 'keep.md'), 'No tocar\n')
    const files = { 'pedido.md': 'p', 'antecedentes.json': '{}', 'handoff.md': 'h', 'hallazgos.md': renderFindingsTemplate('f') }
    const written: string[] = []
    const io: FlowFilesIo = {
      mkdtemp: (prefix) => mkdtempSync(prefix),
      writeFile: (p, data) => { written.push(basename(p)); if (basename(p) === 'hallazgos.md') throw new Error('fallo del cuarto archivo'); writeFileSync(p, data) },
      rename: renameSync, rm: (p) => rmSync(p, { recursive: true, force: true }),
    }
    assert.throws(() => startApply(s.root, 'f', s.input, { ...s.deps, flowFilesIo: io }), /no se pudo escribir/)
    assert.deepEqual(written, Object.keys(files))
    assert.equal(existsSync(join(s.root, '.plans', 'f')), false)
    assert.equal(readFileSync(join(original, 'keep.md'), 'utf8'), 'No tocar\n')
    assert.deepEqual(readdirSync(join(s.root, '.sdd-ai', 'tmp')), [])
  } finally { rmSync(s.scratch, { recursive: true, force: true }) }
})
