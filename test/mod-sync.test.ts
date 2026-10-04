import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { syncAgents } from '../src/agents.ts'
import { MOD_PATH, MOD_RUNTIME_FILES, modChanges, modCopy, modInventory, syncModCopy } from '../src/mod-copies.ts'
import { modFixture, profiles, snapshot, write } from './mod-fixture.ts'

test('mod inventory compares bytes hashes and managed leftovers', () => {
  const c = modFixture()
  try {
    write(c.root, 'mods/sdd-ai/hooks/nested/x.test.ts', 'excluded')
    write(c.root, 'mods/sdd-ai/hooks/tests/x.ts', 'excluded')
    const inventory = modInventory(c.root)
    assert.deepEqual(inventory.map((file) => file.path), inventory.map((file) => file.path).sort())
    assert.equal(inventory.some((file) => file.path.includes('test')), false)
    for (const file of inventory) assert.equal(file.sha256, createHash('sha256').update(file.bytes).digest('hex'))
    assert.equal(modCopy(c.root, inventory).state, 'missing')
    syncModCopy(c.root, inventory)
    write(c.root, `${MOD_PATH}/hooks/obsolete.ts`, 'old')
    write(c.root, `${MOD_PATH}/hooks/register.tsx`, 'changed')
    const changes = modChanges(c.root, inventory)
    assert.ok(changes.some((change) => change.state === 'stale'))
    assert.ok(changes.some((change) => change.state === 'leftover'))
    assert.equal(modCopy(c.root, inventory).state, 'stale')
  } finally { c.dispose() }
})

test('sync installs exactly the mod payload and preserves engine types', () => {
  const c = modFixture()
  try {
    write(c.root, `${MOD_PATH}/.claude-plugin/types/claude-code/index.d.ts`, 'engine')
    write(c.root, `${MOD_PATH}/tsconfig.json`, 'engine config')
    write(c.root, `${MOD_PATH}/hooks/old.ts`, 'old')
    write(c.root, '.claude/skills/another-mod/hooks/file.ts', 'other')
    write(c.root, '.claude/skills/other/SKILL.md', 'other skill')
    const inventory = modInventory(c.root)
    const first = syncAgents(c.root, c.root, profiles())
    assert.deepEqual(first.written.filter((path) => path.includes(`${MOD_PATH}/`)).map((path) => relative(c.root, path)).sort(), inventory.map((file) => `${MOD_PATH}/${file.path}`).sort())
    assert.ok(first.removed.includes(join(c.root, MOD_PATH, 'hooks/old.ts')))
    for (const file of inventory) assert.deepEqual(readFileSync(join(c.root, MOD_PATH, file.path)), file.bytes)
    assert.equal(readFileSync(join(c.root, MOD_PATH, '.claude-plugin/types/claude-code/index.d.ts'), 'utf8'), 'engine')
    assert.equal(readFileSync(join(c.root, MOD_PATH, 'tsconfig.json'), 'utf8'), 'engine config')
    assert.equal(readFileSync(join(c.root, '.claude/skills/another-mod/hooks/file.ts'), 'utf8'), 'other')
    assert.equal(readFileSync(join(c.root, '.claude/skills/other/SKILL.md'), 'utf8'), 'other skill')
    assert.equal(modCopy(c.root, inventory).state, 'ok')
    const second = syncAgents(c.root, c.root, profiles())
    assert.deepEqual(second.written, first.written)
    assert.deepEqual(second.removed, [])
    for (const file of inventory) assert.deepEqual(readFileSync(join(c.root, MOD_PATH, file.path)), file.bytes)
    for (const path of [MOD_PATH, 'mods/sdd-ai/.claude-plugin/types/engine.ts', 'mods/sdd-ai/tsconfig.json']) {
      assert.equal(execFileSync('git', ['check-ignore', path], { cwd: c.root, encoding: 'utf8' }).trim(), path)
    }
    for (const path of ['mods/sdd-ai/.claude-plugin/plugin.json', 'mods/sdd-ai/hooks/register.tsx', 'mods/sdd-ai/types/index.d.ts', 'mods/sdd-ai/tests/command.test.ts']) {
      assert.throws(() => execFileSync('git', ['check-ignore', '-q', path], { cwd: c.root }))
    }
  } finally { c.dispose() }
})

test('sync refuses every incomplete mod source without changing its copy', () => {
  for (const path of MOD_RUNTIME_FILES) {
    const c = modFixture()
    try {
      syncAgents(c.root, c.root, profiles())
      const before = snapshot(join(c.root, MOD_PATH))
      rmSync(join(c.root, path))
      assert.throws(() => syncAgents(c.root, c.root, profiles()), { code: 'ENOENT' })
      assert.deepEqual(snapshot(join(c.root, MOD_PATH)), before)
      assert.equal(existsSync(join(c.root, MOD_PATH)), true)
    } finally { c.dispose() }
  }
})

test('sync never writes or deletes through links in the copy and converges', () => {
  const c = modFixture()
  try {
    const inventory = modInventory(c.root)
    const copy = join(c.root, MOD_PATH)
    const outside = join(c.root, 'outside')
    write(c.root, 'outside/keep.txt', 'ajeno')
    write(c.root, 'outside/hooks/old.ts', 'ajeno')
    const outsideBefore = snapshot(outside)
    // La copia entera es un enlace a otro directorio: se reemplaza el enlace, el destino queda igual.
    mkdirSync(join(c.root, '.claude/skills'), { recursive: true })
    symlinkSync(outside, copy)
    assert.equal(modCopy(c.root, inventory).state, 'stale')
    syncModCopy(c.root, inventory)
    assert.deepEqual(snapshot(outside), outsideBefore)
    assert.equal(lstatSync(copy).isDirectory(), true)
    assert.equal(modCopy(c.root, inventory).state, 'ok')
    // Un archivo del inventario es un enlace roto: se quita el enlace y no se crea nada en su destino.
    rmSync(join(copy, 'hooks/register.tsx'))
    symlinkSync(join(outside, 'creado-por-error.tsx'), join(copy, 'hooks/register.tsx'))
    assert.equal(modCopy(c.root, inventory).state, 'stale')
    syncModCopy(c.root, inventory)
    assert.equal(existsSync(join(outside, 'creado-por-error.tsx')), false)
    assert.equal(lstatSync(join(copy, 'hooks/register.tsx')).isFile(), true)
    // Un directorio ocupa la ruta de un archivo, otro directorio de la copia es un enlace, y un enlace ocupa la ruta del
    // temporal de un archivo: nada se escribe ni se borra en esos destinos.
    rmSync(join(copy, 'hooks/output.ts'))
    write(c.root, `${MOD_PATH}/hooks/output.ts/dentro.ts`, 'x')
    rmSync(join(copy, 'types'), { recursive: true })
    symlinkSync(join(outside, 'hooks'), join(copy, 'types'))
    symlinkSync(join(outside, 'keep.txt'), join(copy, 'hooks/command.ts.sdd-ai-tmp'))
    const outsideNow = snapshot(outside)
    syncModCopy(c.root, inventory)
    assert.deepEqual(snapshot(outside), outsideNow)
    assert.equal(lstatSync(join(copy, 'hooks/output.ts')).isFile(), true)
    assert.equal(lstatSync(join(copy, 'types')).isDirectory(), true)
    assert.deepEqual(modChanges(c.root, inventory), [])
    // Repetir deja el mismo contenido, sin cambios pendientes ni entradas de más. Se listan todas las que no son
    // directorios, también los enlaces, porque un temporal o el enlace plantado en su ruta serían una.
    const bytes = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, value.slice(value.indexOf(':') + 1)]))
    const stable = bytes(snapshot(copy))
    syncModCopy(c.root, inventory)
    assert.deepEqual(bytes(snapshot(copy)), stable)
    assert.deepEqual(modChanges(c.root, inventory), [])
    const entries = (rel = ''): string[] => readdirSync(join(copy, rel), { withFileTypes: true }).flatMap((e) => {
      const path = rel ? `${rel}/${e.name}` : e.name
      return e.isDirectory() ? entries(path) : [path]
    })
    assert.deepEqual(entries().sort(), inventory.map((file) => file.path).sort())
    assert.equal(lstatSync(join(copy, 'hooks/command.ts.sdd-ai-tmp'), { throwIfNoEntry: false }), undefined)
  } finally { c.dispose() }
})

test('a regular file in place of a copy directory reads as stale and sync repairs it', () => {
  const c = modFixture()
  try {
    const inventory = modInventory(c.root)
    syncModCopy(c.root, inventory)
    rmSync(join(c.root, MOD_PATH, 'hooks'), { recursive: true })
    write(c.root, `${MOD_PATH}/hooks`, 'no es un directorio')
    // Los archivos de hooks/ no se leen a través del archivo que ocupa su directorio: quedan vencidos, sin lanzar.
    const hooks = inventory.filter((file) => file.path.startsWith('hooks/')).map((file) => `${MOD_PATH}/${file.path}`)
    const changes = modChanges(c.root, inventory)
    assert.deepEqual(changes.filter((change) => hooks.includes(change.path)).map((change) => change.state), hooks.map(() => 'stale'))
    assert.equal(modCopy(c.root, inventory).state, 'stale')
    syncModCopy(c.root, inventory)
    assert.deepEqual(modChanges(c.root, inventory), [])
  } finally { c.dispose() }
})

test('sync refuses a copy that would leave the checkout and a linked fixed source, before any write', () => {
  const c = modFixture()
  try {
    const inventory = modInventory(c.root)
    // .claude/skills enlazado a otro directorio fuera del checkout: agents sync se niega sin escribir.
    const elsewhere = mkdtempSync(join(tmpdir(), 'sdd-ai-mod-elsewhere-'))
    try {
      mkdirSync(join(c.root, '.claude'), { recursive: true })
      symlinkSync(elsewhere, join(c.root, '.claude/skills'))
      const before = snapshot(c.root)
      assert.throws(() => syncAgents(c.root, c.root, profiles()), { code: 'mod_copy_outside' })
      assert.throws(() => syncModCopy(c.root, inventory), { code: 'mod_copy_outside' })
      assert.deepEqual(readdirSync(elsewhere), [])
      assert.deepEqual(snapshot(c.root), before)
      rmSync(join(c.root, '.claude/skills'))
    } finally { rmSync(elsewhere, { recursive: true, force: true }) }
    // Un enlace que resuelve dentro del checkout sirve.
    write(c.root, 'shared/.keep', '')
    symlinkSync(join(c.root, 'shared'), join(c.root, '.claude/skills'))
    syncModCopy(c.root, inventory)
    assert.equal(modCopy(c.root, inventory).state, 'ok')
    // Un ancestro de la copia que es un enlace circular no detiene la comparación: la copia está desactualizada.
    rmSync(join(c.root, `${MOD_PATH}/hooks`), { recursive: true })
    symlinkSync(join(c.root, `${MOD_PATH}/hooks`), join(c.root, `${MOD_PATH}/hooks`))
    assert.equal(modCopy(c.root, inventory).state, 'stale')
    syncModCopy(c.root, inventory)
    assert.equal(modCopy(c.root, inventory).state, 'ok')
    // Un archivo fijo de la fuente que es un enlace queda fuera del recorrido: el inventario se niega.
    const register = join(c.root, 'mods/sdd-ai/hooks/register.tsx')
    const real = join(c.root, 'register-real.tsx')
    write(c.root, 'register-real.tsx', readFileSync(register))
    rmSync(register)
    symlinkSync(real, register)
    const copyBefore = snapshot(join(c.root, MOD_PATH))
    assert.throws(() => modInventory(c.root), /hooks\/register\.tsx/)
    assert.throws(() => syncAgents(c.root, c.root, profiles()))
    assert.deepEqual(snapshot(join(c.root, MOD_PATH)), copyBefore)
  } finally { c.dispose() }
})
