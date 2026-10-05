import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runOpenness } from '../src/open-runs.ts'
import { publishProjection } from '../src/projection.ts'
import { known, validateProjection } from '../src/projection-types.ts'
import { readStatus } from '../src/runs.ts'
import { diffInventory, readControl, sensitiveInventory, sensitiveInventoryV2 } from '../src/writer-store.ts'
import { latestProjection, projectionDocument, projectionFixture, TEST_BOOT } from './projection-fixture.ts'

test('projection publication preserves protected writer state and sensitive path detection', () => {
  for (const state of ['running', 'cessation_uncertain'] as const) {
    const f = projectionFixture()
    try {
      const writer = f.writer('writer', state, 'session-a', 'flow-a')
      const protectedControl = readFileSync(join(writer.store, 'control.json'))
      const protectedStatus = readFileSync(join(writer.store, 'status.json'))
      const directories = writer.control.checkout
      const before = sensitiveInventory(f.root, directories)
      const beforeV2 = sensitiveInventoryV2(f.root, directories)
      // La corrida visible no es la autoridad: el writer puede borrarla mientras sigue en vuelo.
      rmSync(writer.run, { recursive: true })
      assert.equal(runOpenness(f.root, 'writer', join(writer.store, '..'))?.open, 'running')
      for (let i = 0; i < 20; i++) {
        const result = publishProjection(f.root, (root, observation) => {
          const document = projectionDocument(root, observation)
          const control = readControl(root, 'writer')
          const status = readStatus(writer.store)
          document.writer.item = { id: control.id, availability: 'available', reason: null,
            state: known(status.state), open: known('running'), session: known(control.session!), flow: known(control.phase!.flow), live: known(true) }
          return document
        }, { boot: () => TEST_BOOT })
        assert.equal(result.kind, 'published')
        assert.equal(validateProjection(latestProjection(f.root)).ok, true)
        assert.equal(latestProjection(f.root)?.writer.item?.state.value, state)
        assert.deepEqual(diffInventory(before, sensitiveInventory(f.root, directories)), [])
        assert.deepEqual(diffInventory(beforeV2, sensitiveInventoryV2(f.root, directories)), [])
      }
      assert.deepEqual(readFileSync(join(writer.store, 'control.json')), protectedControl)
      assert.deepEqual(readFileSync(join(writer.store, 'status.json')), protectedStatus)
      const sensitive = join(f.root, '.sdd-ai', 'foreign-sensitive')
      writeFileSync(sensitive, 'alteración ajena a la publicación')
      for (const inventory of [sensitiveInventory, sensitiveInventoryV2]) {
        const changes = diffInventory(inventory === sensitiveInventory ? before : beforeV2, inventory(f.root, directories))
        assert.deepEqual(changes.map((change) => change.path), ['.sdd-ai/foreign-sensitive'])
      }
    } finally { f.dispose() }
  }
})

test('projection exclusion preserves detection in other sensitive directories and existing link rules', () => {
  const f = projectionFixture()
  try {
    const writer = f.writer('writer')
    const before = sensitiveInventory(f.root, writer.control.checkout)
    const beforeV2 = sensitiveInventoryV2(f.root, writer.control.checkout)
    for (const directory of ['.claude', '.codex', '.agents']) {
      mkdirSync(join(f.root, directory))
      writeFileSync(join(f.root, directory, 'foreign'), 'sensible')
    }
    const target = join(f.scratch, 'outside'); mkdirSync(target)
    symlinkSync(target, join(f.root, '.sdd-ai', 'projection'))
    for (const [inventory, baseline] of [[sensitiveInventory, before], [sensitiveInventoryV2, beforeV2]] as const) {
      const changed = diffInventory(baseline, inventory(f.root, writer.control.checkout)).map((change) => change.path)
      for (const directory of ['.claude', '.codex', '.agents']) assert.ok(changed.includes(`${directory}/foreign`))
      assert.ok(changed.includes('.sdd-ai/projection'), 'las exclusiones existentes no ocultan un directorio convertido en enlace')
    }
  } finally { f.dispose() }
})
