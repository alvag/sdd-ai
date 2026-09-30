import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureTree, dirtyPaths, entryDiff, gitDirs, headCommit, indexEntries } from '../src/git.ts'
import { SddError } from '../src/types.ts'
import {
  canWriteStore, diffInventory, groupState, leaderMatches, readControl, readProcess, readReservation, recordGroup, releaseWriter, reserveWriter,
  sensitiveInventory, storeDir, storeRoot, writeControl, freezeHarvest, launchTreeDiff, launchTreeHolds, readTakeoverMap, registryDigest,
  runEntries, writeTakeoverMap, type WriterControl,
} from '../src/writer-store.ts'
import { headerHash, readFlow } from '../src/sdd/read.ts'
import { makeRepo } from './helpers.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Un repo con autor y un primer commit con los archivos dados. */
function committed(files: Record<string, string | Buffer>): { repo: string; base: string } {
  const repo = makeRepo()
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  return { repo, base: git(repo, 'rev-parse', 'HEAD') }
}

const checkoutOf = (repo: string) => ({ root: repo, gitDir: gitDirs(repo).gitDir })
const scratchIndex = () => join(mkdtempSync(join(tmpdir(), 'sdd-ai-index-')), 'index')

test('headCommit devuelve el commit de HEAD, y nada en un repo sin commits', () => {
  assert.equal(headCommit(makeRepo()), undefined)
  const { repo, base } = committed({ 'a.txt': 'a\n' })
  assert.equal(headCommit(repo), base)
})

test('dirtyPaths nombra modificados, borrados, nuevos y renombrados, y no los ignorados', () => {
  const { repo } = committed({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', '.gitignore': 'ignorado.txt\n' })
  assert.deepEqual(dirtyPaths(repo), [])
  writeFileSync(join(repo, 'a.txt'), 'cambio\n')
  unlinkSync(join(repo, 'b.txt'))
  writeFileSync(join(repo, 'nuevo.txt'), 'n\n')
  writeFileSync(join(repo, 'ignorado.txt'), 'i\n')
  git(repo, 'mv', 'c.txt', 'd.txt')
  assert.deepEqual(dirtyPaths(repo).sort(), ['a.txt', 'b.txt', 'd.txt', 'nuevo.txt'])
})

test('gitDirs resuelve el directorio de Git y el común, también en un worktree', () => {
  const { repo } = committed({ 'a.txt': 'a\n' })
  const main = gitDirs(repo)
  assert.deepEqual(main, { gitDir: join(repo, '.git'), commonDir: join(repo, '.git') })
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-wt-'))), 'wt')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt')
  assert.deepEqual(gitDirs(wt), { gitDir: join(repo, '.git', 'worktrees', 'wt'), commonDir: join(repo, '.git') })
})

test('diff.patch aplicado sobre la base reproduce el árbol cosechado', () => {
  const long = Array.from({ length: 40 }, (_, i) => `línea ${i}\n`).join('')
  const { repo, base } = committed({
    'a.txt': 'uno\ndos\n', 'borrar.txt': 'b\n', 'mover.txt': long, 'bin.dat': Buffer.from([0, 1, 2, 3, 255]),
    'script.sh': '#!/bin/sh\necho hola\n', 'destino.txt': 'd\n',
  })
  symlinkSync('destino.txt', join(repo, 'enlace'))
  git(repo, 'add', 'enlace')
  git(repo, 'commit', '-qm', 'enlace')
  const withLink = git(repo, 'rev-parse', 'HEAD')

  writeFileSync(join(repo, 'a.txt'), 'uno\ndos\ntres\n')
  unlinkSync(join(repo, 'borrar.txt'))
  renameSync(join(repo, 'mover.txt'), join(repo, 'movido.txt'))
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 9, 9, 9, 255, 7]))
  chmodSync(join(repo, 'script.sh'), 0o755)
  unlinkSync(join(repo, 'enlace'))
  symlinkSync('a.txt', join(repo, 'enlace'))
  symlinkSync('destino.txt', join(repo, 'enlace-nuevo'))
  writeFileSync(join(repo, 'nuevo.txt'), 'nuevo\n')
  writeFileSync(join(repo, 'nuevo.bin'), Buffer.from([0, 0, 1]))
  const indexBefore = git(repo, 'ls-files', '-s')

  const cap = captureTree(checkoutOf(repo), withLink, scratchIndex())
  // El índice del usuario no cambia.
  assert.equal(git(repo, 'ls-files', '-s'), indexBefore)
  const byPath = new Map(cap.files.map((f) => [f.path, f]))
  assert.deepEqual([...byPath.keys()].sort(),
    ['a.txt', 'bin.dat', 'borrar.txt', 'enlace', 'enlace-nuevo', 'movido.txt', 'nuevo.bin', 'nuevo.txt', 'script.sh'])
  assert.deepEqual(byPath.get('a.txt'), { path: 'a.txt', status: 'M', added: 1, removed: 0, binary: false, modeBefore: '100644', modeAfter: '100644' })
  assert.equal(byPath.get('borrar.txt')?.status, 'D')
  assert.deepEqual([byPath.get('movido.txt')?.status, byPath.get('movido.txt')?.from], ['R', 'mover.txt'])
  assert.deepEqual([byPath.get('bin.dat')?.binary, byPath.get('bin.dat')?.added], [true, null])
  assert.deepEqual([byPath.get('script.sh')?.modeBefore, byPath.get('script.sh')?.modeAfter], ['100644', '100755'])
  assert.equal(byPath.get('enlace-nuevo')?.modeAfter, '120000')
  assert.deepEqual([byPath.get('nuevo.bin')?.status, byPath.get('nuevo.bin')?.binary], ['A', true])

  // Aplicado en un clon de la base, el patch deja el mismo árbol.
  const clone = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-clone-')))
  git(tmpdir(), 'clone', '-q', repo, clone)
  git(clone, 'checkout', '-q', withLink)
  const patch = join(mkdtempSync(join(tmpdir(), 'sdd-ai-patch-')), 'diff.patch')
  writeFileSync(patch, cap.patch)
  git(clone, 'apply', '--index', '--binary', patch)
  assert.equal(git(clone, 'write-tree'), cap.tree)
  assert.notEqual(cap.tree, git(repo, 'rev-parse', `${base}^{tree}`))
})

test('mapas del índice: el árbol actual y el reconstruido desde el patch coinciden, sin tocar el índice del usuario', () => {
  const { repo, base } = committed({ 'a.txt': 'uno\n', 'borrar.txt': 'b\n', 'mover.txt': 'm\n'.repeat(30), 'script.sh': '#!/bin/sh\n' })
  const clean = indexEntries(repo, base, { kind: 'current' })!
  assert.deepEqual([...clean.keys()].sort(), ['a.txt', 'borrar.txt', 'mover.txt', 'script.sh'])
  assert.match(clean.get('a.txt')!, /^100644 [0-9a-f]{40}$/)

  writeFileSync(join(repo, 'a.txt'), 'uno\ndos\n')
  unlinkSync(join(repo, 'borrar.txt'))
  renameSync(join(repo, 'mover.txt'), join(repo, 'movido.txt'))
  chmodSync(join(repo, 'script.sh'), 0o755)
  writeFileSync(join(repo, 'nuevo.txt'), 'n\n')
  mkdirSync(join(repo, '.plans', 'f'), { recursive: true })
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), '# Plan\n')
  const indexBefore = readFileSync(join(repo, '.git', 'index'))
  const now = indexEntries(repo, base, { kind: 'current' })!
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore)
  // Borrados, renombres, modos y archivos nuevos cuentan; el directorio del flujo no.
  assert.deepEqual(entryDiff(clean, now, 'f'), ['a.txt', 'borrar.txt', 'mover.txt', 'movido.txt', 'nuevo.txt', 'script.sh'])
  assert.ok(now.has('.plans/f/plan.md'))
  assert.deepEqual(entryDiff(now, now, 'f'), [])

  // El patch de una cosecha, aplicado sobre la base en un índice propio, da el mismo mapa.
  const cap = captureTree(checkoutOf(repo), base, scratchIndex())
  const patch = join(mkdtempSync(join(tmpdir(), 'sdd-ai-patch-')), 'diff.patch')
  writeFileSync(patch, cap.patch)
  const rebuilt = indexEntries(repo, base, { kind: 'patch', patchFile: patch })!
  assert.deepEqual(entryDiff(rebuilt, now, 'f'), [])
  // Un mapa guardado sigue sirviendo después de borrar el índice temporal: son cadenas, no objetos.
  assert.deepEqual(entryDiff(new Map(JSON.parse(JSON.stringify([...rebuilt]))), now, 'f'), [])
  // Sin el patch, o con uno que no aplica, no hay mapa.
  assert.equal(indexEntries(repo, base, { kind: 'patch', patchFile: join(tmpdir(), 'no-existe.patch') }), null)
  writeFileSync(patch, 'esto no es un patch\n')
  assert.equal(indexEntries(repo, base, { kind: 'patch', patchFile: patch }), null)
})

test('un .gitattributes del writer que activa un filtro clean no hace correr ningún comando durante la captura', () => {
  const { repo, base } = committed({ 'a.txt': 'a\n' })
  const marks = mkdtempSync(join(tmpdir(), 'sdd-ai-marks-'))
  for (const [key, name] of [['filter.malo.clean', 'clean'], ['filter.malo.smudge', 'smudge'], ['diff.malo.textconv', 'textconv'], ['diff.malo.command', 'command']]) {
    git(repo, 'config', key, `sh -c 'touch ${join(marks, name)}; cat'`)
  }
  writeFileSync(join(repo, '.gitattributes'), '* filter=malo diff=malo\n')
  writeFileSync(join(repo, 'a.txt'), 'cambiado\n')
  writeFileSync(join(repo, 'nuevo.txt'), 'nuevo\n')
  const cap = captureTree(checkoutOf(repo), base, scratchIndex())
  assert.deepEqual(cap.files.map((f) => f.path).sort(), ['.gitattributes', 'a.txt', 'nuevo.txt'])
  for (const name of ['clean', 'smudge', 'textconv', 'command']) assert.equal(existsSync(join(marks, name)), false, name)
  // El blob es el contenido tal cual, sin pasar por el filtro.
  assert.match(cap.patch.toString('utf8'), /\+cambiado/)
})

// --- Almacén, reserva, inventario e identidad del grupo ---

function withWorktree(repo: string): string {
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), 'sdd-ai-wt-'))), 'wt')
  git(repo, 'worktree', 'add', '-q', wt, '-b', `wt-${Date.now()}`)
  return wt
}

test('se señalan los cambios en .claude, .codex, .agents, .sdd-ai y el directorio de Git (HEAD, refs, packed-refs, config, hooks, info), ignorados incluidos, con estado anterior y posterior', () => {
  const { repo } = committed({ 'a.txt': 'a\n', '.gitignore': '.claude/\n.codex/\n.agents/\n' })
  mkdirSync(join(repo, '.claude'))
  writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n')
  mkdirSync(join(repo, '.sdd-ai'))
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'x: 1\n')
  const before = sensitiveInventory(repo)
  writeFileSync(join(repo, '.claude', 'settings.json'), '{"hooks":{}}\n')
  mkdirSync(join(repo, '.codex'))
  writeFileSync(join(repo, '.codex', 'hooks.json'), '{}\n')
  mkdirSync(join(repo, '.agents'))
  writeFileSync(join(repo, '.agents', 'x.md'), 'x\n')
  writeFileSync(join(repo, '.sdd-ai', 'config.yml'), 'x: 2\n')
  const gd = join(repo, '.git')
  writeFileSync(join(gd, 'HEAD'), 'ref: refs/heads/otra\n')
  writeFileSync(join(gd, 'refs', 'heads', 'nueva'), `${'1'.repeat(40)}\n`)
  writeFileSync(join(gd, 'packed-refs'), '# pack-refs\n')
  writeFileSync(join(gd, 'config'), `${readFileSync(join(gd, 'config'), 'utf8')}[x]\n\ty = 1\n`)
  writeFileSync(join(gd, 'hooks', 'pre-commit'), '#!/bin/sh\n')
  writeFileSync(join(gd, 'info', 'exclude'), 'otro\n')
  const flagged = diffInventory(before, sensitiveInventory(repo))
  const paths = flagged.map((f) => f.path)
  for (const p of ['.claude/settings.json', '.codex', '.codex/hooks.json', '.agents', '.agents/x.md', '.sdd-ai/config.yml',
    join(gd, 'HEAD'), join(gd, 'refs/heads/nueva'), join(gd, 'packed-refs'), join(gd, 'config'), join(gd, 'hooks/pre-commit'), join(gd, 'info/exclude')]) {
    assert.ok(paths.includes(p), `falta ${p} en ${paths.join(', ')}`)
  }
  const settings = flagged.find((f) => f.path === '.claude/settings.json')
  assert.equal(settings?.before?.type, 'file')
  assert.notEqual(settings?.before?.hash, settings?.after?.hash)
  const created = flagged.find((f) => f.path === '.codex/hooks.json')
  assert.deepEqual([created?.before, created?.after?.type], [undefined, 'file'])
})

test('quedan fuera runs, hooks y tmp de .sdd-ai y el índice, objetos y logs de Git', () => {
  const { repo } = committed({ 'a.txt': 'a\n' })
  for (const d of ['runs/x', 'hooks/route', 'tmp']) mkdirSync(join(repo, '.sdd-ai', d), { recursive: true })
  const before = sensitiveInventory(repo)
  for (const d of ['runs/x', 'hooks/route', 'tmp']) writeFileSync(join(repo, '.sdd-ai', d, 'f'), 'x\n')
  // Índice y objetos nuevos, y una entrada del reflog con la rama en el mismo commit.
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  git(repo, 'add', 'b.txt')
  git(repo, 'update-ref', '--create-reflog', '-m', 'prueba', 'HEAD', 'HEAD')
  assert.deepEqual(diffInventory(before, sensitiveInventory(repo)), [])
})

test('en un worktree se vigilan el gitdir y el directorio común', () => {
  const { repo } = committed({ 'a.txt': 'a\n' })
  const wt = withWorktree(repo)
  const { gitDir, commonDir } = gitDirs(wt)
  const before = sensitiveInventory(wt)
  assert.ok(Object.keys(before).includes('.git'))
  // Lo que el binario escribe en su almacén mientras el writer corre no cuenta.
  assert.equal(canWriteStore(wt), true)
  mkdirSync(storeDir(wt, 'id-1'), { recursive: true })
  writeFileSync(join(storeDir(wt, 'id-1'), 'control.json'), '{}\n')
  assert.equal(reserveWriter(wt, 'id-1').ok, true)
  assert.deepEqual(diffInventory(before, sensitiveInventory(wt)), [])
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(commonDir, 'config'), `${readFileSync(join(commonDir, 'config'), 'utf8')}[y]\n\tz = 1\n`)
  writeFileSync(join(wt, '.git'), 'gitdir: /no/existe\n')
  const paths = diffInventory(before, sensitiveInventory(wt, { gitDir, commonDir })).map((f) => f.path).sort()
  assert.deepEqual(paths, ['.git', join(commonDir, 'config'), join(gitDir, 'HEAD')].sort())
})

test('el almacén vive en el directorio de Git: la reserva en el común y la corrida en el del checkout', () => {
  const { repo } = committed({ 'a.txt': 'a\n' })
  const wt = withWorktree(repo)
  assert.equal(storeRoot(repo), join(repo, '.git', 'sdd-ai'))
  assert.equal(storeRoot(wt), join(repo, '.git', 'sdd-ai'))
  assert.equal(storeDir(repo, 'x'), join(repo, '.git', 'sdd-ai', 'runs', 'x'))
  assert.equal(storeDir(wt, 'x'), join(gitDirs(wt).gitDir, 'sdd-ai', 'runs', 'x'))
})

test('canWriteStore falla si una de las dos rutas no se puede escribir', () => {
  const { repo } = committed({ 'a.txt': 'a\n' })
  const wt = withWorktree(repo)
  assert.equal(canWriteStore(wt), true)
  chmodSync(storeRoot(wt), 0o500)
  try {
    assert.equal(canWriteStore(wt), false)
  } finally {
    chmodSync(storeRoot(wt), 0o755)
  }
  const runs = join(gitDirs(wt).gitDir, 'sdd-ai', 'runs')
  chmodSync(runs, 0o500)
  try {
    assert.equal(canWriteStore(wt), false)
  } finally {
    chmodSync(runs, 0o755)
  }
})

test('el rechazo de la reserva nombra la corrida que la tiene, también entre procesos simultáneos', async () => {
  const { repo } = committed({ 'a.txt': 'a\n' })
  const wt = withWorktree(repo)
  assert.deepEqual(reserveWriter(repo, 'uno'), { ok: true })
  // Un worktree del mismo repositorio comparte la reserva.
  assert.deepEqual(reserveWriter(wt, 'dos'), { ok: false, holder: 'uno' })
  releaseWriter(wt, 'dos')
  assert.equal(readReservation(repo)?.id, 'uno')
  releaseWriter(repo, 'uno')
  assert.equal(readReservation(repo), undefined)
  assert.deepEqual(readdirSync(storeRoot(repo)).filter((f) => f.startsWith('writer.lock')), [])

  // Diez procesos a la vez: gana uno y los demás nombran al ganador.
  const script = `import { reserveWriter } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'writer-store.ts'))};`
    + 'console.log(JSON.stringify(reserveWriter(process.argv[1], process.argv[2])))'
  const runs = await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise<{ ok: boolean; holder?: string }>((res, rej) => {
    execFile(process.execPath, ['--input-type=module', '-e', script, repo, `p${i}`], (err, out) => (err ? rej(err) : res(JSON.parse(out))))
  })))
  const winners = runs.filter((r) => r.ok)
  assert.equal(winners.length, 1)
  const holder = readReservation(repo)?.id
  for (const r of runs.filter((x) => !x.ok)) assert.equal(r.holder, holder)
  assert.deepEqual(readdirSync(storeRoot(repo)).filter((f) => f.startsWith('writer.lock.')), [])
})

test('writeControl y readControl guardan el control en el almacén; desde otro checkout no se encuentra', () => {
  const { repo, base } = committed({ 'a.txt': 'a\n' })
  const wt = withWorktree(repo)
  const control = {
    id: 'c1', base, family: 'codex' as const, prompt: 'encargo', checkout: { root: repo, ...gitDirs(repo) },
    request: { role: 'implement' as const, conductor: { family: 'claude' as const }, deadline_sec: 600 },
    preLaunch: {}, inventory: {}, runDir: { dev: 1, ino: 2 },
  }
  writeControl(repo, control)
  assert.deepEqual(readControl(repo, 'c1'), control)
  assert.throws(() => readControl(wt, 'c1'), (e: unknown) => e instanceof SddError && e.code === 'run_not_found')
  recordGroup(repo, 'c1', { pid: 1, pgid: 1, lstart: null, argvHash: 'h' })
  assert.deepEqual(readControl(repo, 'c1').group, { pid: 1, pgid: 1, lstart: null, argvHash: 'h' })
})

test('groupState distingue un grupo vivo, uno vacío y uno sin permiso', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  const pid = child.pid ?? 0
  const g = { pid, pgid: pid, lstart: null, argvHash: '' }
  assert.equal(groupState(g), 'alive')
  process.kill(-pid, 'SIGKILL')
  await new Promise((r) => child.once('exit', r))
  assert.equal(groupState(g), 'gone')
  // Un grupo de root existe y no se puede señalar.
  const rootGroup = Number(execFileSync('sh', ['-c', "ps -axo pgid=,user= | awk '$2==\"root\" && $1>1 {print $1; exit}'"], { encoding: 'utf8' }))
  assert.equal(groupState({ pid: rootGroup, pgid: rootGroup, lstart: null, argvHash: '' }), 'unknown')
  // Ni todos los procesos ni el grupo propio.
  for (const pgid of [0, 1, -5]) assert.equal(groupState({ pid: 99999, pgid, lstart: null, argvHash: '' }), 'unknown', String(pgid))
})

test('leaderMatches rechaza un PID reutilizado con otra hora de inicio, otro grupo u otro argv', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  const pid = child.pid ?? 0
  try {
    const seen = readProcess(pid)
    assert.ok(seen && seen !== 'gone')
    const g = { pid, pgid: seen.pgid, lstart: seen.lstart, argvHash: seen.argvHash }
    assert.equal(g.pgid, pid)
    assert.equal(leaderMatches(g), true)
    assert.equal(leaderMatches({ ...g, lstart: 'Thu Jan  1 00:00:00 1970' }), false)
    assert.equal(leaderMatches({ ...g, pgid: g.pgid + 1 }), false)
    assert.equal(leaderMatches({ ...g, argvHash: 'otro' }), false)
    assert.equal(leaderMatches({ ...g, lstart: null }), undefined)
    assert.equal(leaderMatches({ ...g, pgid: 1 }), undefined)
  } finally {
    process.kill(-pid, 'SIGKILL')
    await new Promise((r) => child.once('exit', r))
  }
  assert.equal(leaderMatches({ pid, pgid: pid, lstart: 'x', argvHash: 'y' }), false)
})

test('sin ps, leaderMatches no afirma nada', () => {
  const path = process.env.PATH
  process.env.PATH = mkdtempSync(join(tmpdir(), 'sdd-ai-sin-ps-'))
  try {
    assert.equal(leaderMatches({ pid: process.pid, pgid: process.pid, lstart: 'x', argvHash: 'y' }), undefined)
  } finally {
    process.env.PATH = path
  }
})

/** Deja el directorio y todo lo que tiene en solo lectura, como el sandbox de Codex deja `.git`, y devuelve cómo restaurarlo. */
export function readOnly(dir: string): () => void {
  const dirs = execFileSync('find', [dir, '-type', 'd'], { encoding: 'utf8' }).trim().split('\n')
  for (const d of dirs) chmodSync(d, 0o555)
  return () => {
    for (const d of dirs) chmodSync(d, 0o755)
  }
}

test('la captura no escribe en .git: funciona con los objetos del repositorio en solo lectura', () => {
  const { repo, base } = committed({ 'a.txt': 'a\n' })
  writeFileSync(join(repo, 'a.txt'), 'cambiado\n')
  writeFileSync(join(repo, 'nuevo.txt'), 'nuevo\n')
  symlinkSync('a.txt', join(repo, 'enlace'))
  const count = () => git(repo, 'count-objects', '-v')
  const before = count()
  const restore = readOnly(join(repo, '.git', 'objects'))
  let cap
  try {
    cap = captureTree(checkoutOf(repo), base, scratchIndex())
  } finally {
    restore()
  }
  assert.deepEqual(cap.files.map((f) => f.path).sort(), ['a.txt', 'enlace', 'nuevo.txt'])
  assert.match(cap.patch.toString('utf8'), /\+nuevo/)
  assert.equal(count(), before)
})

/** El control mínimo de un writer de fase del flujo `f`, para congelar su cosecha sin lanzarlo. */
function chainControl(repo: string, base: string, id: string, phase: Partial<NonNullable<WriterControl['phase']>> = {}): WriterControl {
  mkdirSync(join(repo, '.plans', 'f'), { recursive: true })
  const c: WriterControl = {
    id, base, family: 'codex', prompt: 'encargo', checkout: { root: repo, ...gitDirs(repo) },
    request: { role: 'implement', conductor: { family: 'claude' }, deadline_sec: 600 },
    preLaunch: {}, inventory: sensitiveInventory(repo, gitDirs(repo)), runDir: { dev: 0, ino: 0 },
    phase: { flow: 'f', pending: ['T1'], inputs: {}, handoff_header: headerHash(readFlow(repo, 'f').facts.handoffHeader), kind: 'implement', ...phase },
  }
  writeControl(repo, c)
  return c
}

test('cosecha encadenada: el patch es acumulado, el delta es frente al padre y una reanudación se mide con la corrida que reanuda', async () => {
  const { repo, base } = committed({ 'a.txt': 'a\n' })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n')
  chainControl(repo, base, '20260929-2100-aaaa')
  writeFileSync(join(repo, 'a.txt'), 'a2\n')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  const first = await freezeHarvest(repo, '20260929-2100-aaaa', { state: 'done' }, 'ok\nSTATUS: done')
  assert.deepEqual(first.delta, ['a.txt', 'b.txt'])
  assert.deepEqual(Object.keys(first.entries ?? {}).sort(), ['a.txt', 'b.txt'])

  chainControl(repo, base, '20260929-2101-bbbb', { kind: 'continuation', parent: '20260929-2100-aaaa', launch_from: { run: '20260929-2100-aaaa' } })
  writeFileSync(join(repo, 'b.txt'), 'b2\n')
  const second = await freezeHarvest(repo, '20260929-2101-bbbb', { state: 'done' }, 'ok\nSTATUS: done')
  assert.deepEqual(second.delta, ['b.txt'])
  // El patch sigue siendo contra la base de la cadena: trae los cambios de las dos corridas.
  assert.deepEqual(second.files.map((f) => f.path).sort(), ['a.txt', 'b.txt'])

  // Una reanudación que solo cierra el contrato se mide contra el padre de la corrida que reanuda.
  chainControl(repo, base, '20260929-2102-cccc', { kind: 'continuation', parent: '20260929-2101-bbbb', resumes: '20260929-2101-bbbb', launch_from: { run: '20260929-2101-bbbb' } })
  const resumed = await freezeHarvest(repo, '20260929-2102-cccc', { state: 'done' }, 'ok\nSTATUS: done')
  assert.deepEqual(resumed.delta, ['b.txt'])
  // Un writer sin kind, anterior a las cadenas, no guarda mapa ni delta.
  chainControl(repo, base, '20260929-2103-dddd', { kind: undefined })
  const legacy = await freezeHarvest(repo, '20260929-2103-dddd', { state: 'done' }, 'ok\nSTATUS: done')
  assert.deepEqual([legacy.entries, legacy.delta], [undefined, undefined])
  // Su mapa se reconstruye igual desde el patch.
  assert.deepEqual([...(runEntries(repo, '20260929-2103-dddd') ?? new Map()).keys()].sort(), ['a.txt', 'b.txt'])
  // Sin el árbol del padre, el delta queda sin medir: vacío y marcado, no la lista acumulada del patch.
  chainControl(repo, base, '20260929-2104-eeee', { kind: 'continuation', parent: '20260929-2199-ffff', launch_from: { run: '20260929-2199-ffff' } })
  const orphan = await freezeHarvest(repo, '20260929-2104-eeee', { state: 'done' }, 'ok\nSTATUS: done')
  assert.deepEqual([orphan.delta, orphan.delta_unmeasured], [[], true])
  // Un ciclo en las reanudaciones es un registro roto: tampoco se mide.
  chainControl(repo, base, '20260929-2105-gggg', { kind: 'continuation', parent: '20260929-2106-hhhh', resumes: '20260929-2106-hhhh', launch_from: { run: '20260929-2106-hhhh' } })
  chainControl(repo, base, '20260929-2106-hhhh', { kind: 'continuation', parent: '20260929-2105-gggg', resumes: '20260929-2105-gggg', launch_from: { run: '20260929-2105-gggg' } })
  const loop = await freezeHarvest(repo, '20260929-2105-gggg', { state: 'done' }, 'ok\nSTATUS: done')
  assert.deepEqual([loop.delta, loop.delta_unmeasured], [[], true])
})

test('árbol de lanzamiento: una corrida con padre exige el árbol de su cosecha o de su toma, sin contar el flujo', async () => {
  const { repo, base } = committed({ 'a.txt': 'a\n' })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n')
  chainControl(repo, base, '20260929-2200-aaaa')
  writeFileSync(join(repo, 'a.txt'), 'a2\n')
  await freezeHarvest(repo, '20260929-2200-aaaa', { state: 'done' }, 'ok\nSTATUS: done')
  const child = chainControl(repo, base, '20260929-2201-bbbb', { kind: 'fix', parent: '20260929-2200-aaaa', launch_from: { run: '20260929-2200-aaaa' } })
  assert.equal(launchTreeHolds(repo, child), true)
  writeFileSync(join(repo, '.plans', 'f', 'plan.md'), '# Plan\n')
  assert.equal(launchTreeHolds(repo, child), true)
  writeFileSync(join(repo, 'c.txt'), 'c\n')
  assert.equal(launchTreeHolds(repo, child), false)
  assert.deepEqual(launchTreeDiff(repo, child), ['c.txt'])

  // Una toma guarda su mapa con digest; alterado, no se acepta.
  const map = writeTakeoverMap(repo, 't1', new Map([['a.txt', 'x']]))
  assert.deepEqual([...(readTakeoverMap(repo, map) ?? new Map())], [['a.txt', 'x']])
  assert.equal(readTakeoverMap(repo, { ...map, digest: `sha256:${'0'.repeat(64)}` }), null)
  assert.equal(readTakeoverMap(repo, { ref: '../runs/x.json', digest: map.digest }), null)
})

test('insumos de cadena: el registro de fases congelado al lanzar invalida la cosecha si cambia durante la corrida', async () => {
  const { repo, base } = committed({ 'a.txt': 'a\n' })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.plans/\n')
  mkdirSync(join(repo, '.plans', 'f'), { recursive: true })
  writeFileSync(join(repo, '.plans', 'f', 'sdd-ai-phases.json'), '{"schema_version":1,"last_run":null,"phases":{}}\n')
  chainControl(repo, base, '20260929-2300-aaaa', { registry: registryDigest(repo, 'f') })
  writeFileSync(join(repo, 'a.txt'), 'a2\n')
  assert.equal((await freezeHarvest(repo, '20260929-2300-aaaa', { state: 'done' }, 'ok\nSTATUS: done')).phase_inputs, 'unchanged')
  chainControl(repo, base, '20260929-2301-bbbb', { registry: registryDigest(repo, 'f') })
  writeFileSync(join(repo, '.plans', 'f', 'sdd-ai-phases.json'), '{"schema_version":1,"last_run":null,"phases":{},"x":1}\n')
  assert.equal((await freezeHarvest(repo, '20260929-2301-bbbb', { state: 'done' }, 'ok\nSTATUS: done')).phase_inputs, 'changed')
})
