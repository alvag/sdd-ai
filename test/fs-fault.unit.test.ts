import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFsFault } from './fs-fault.ts'

function scratch<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-ai-fs-fault-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return (e as NodeJS.ErrnoException).code
  }
  return undefined
}

const syncDir = (dir: string) => {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

test('sync-dir falla el fsync de un directorio y no el de un archivo', () => {
  scratch((dir) => {
    const file = join(dir, 'a.txt')
    withFsFault({ op: 'sync-dir', code: 'EIO' }, () => {
      assert.equal(codeOf(() => syncDir(dir)), 'EIO')
      const fd = openSync(file, 'w')
      fsyncSync(fd)
      closeSync(fd)
    })
  })
})

test('open-dir falla la apertura de un directorio', () => {
  scratch((dir) => {
    withFsFault({ op: 'open-dir', code: 'EPERM' }, () => assert.equal(codeOf(() => openSync(dir, 'r')), 'EPERM'))
  })
})

test('rename con suffix falla solo el destino que termina en él', () => {
  scratch((dir) => {
    writeFileSync(join(dir, 'a'), 'a')
    writeFileSync(join(dir, 'b'), 'b')
    withFsFault({ op: 'rename', code: 'EIO', suffix: 'receipt.json' }, () => {
      renameSync(join(dir, 'a'), join(dir, 'otro.json'))
      assert.equal(codeOf(() => renameSync(join(dir, 'b'), join(dir, 'receipt.json'))), 'EIO')
    })
  })
})

test('un sync-dir con un suffix que no coincide no lanza', () => {
  scratch((dir) => {
    mkdirSync(join(dir, 'x'))
    // En Windows el fsync real de un directorio da EPERM (#120): lo que importa es que no salga el EIO inyectado.
    assert.notEqual(withFsFault({ op: 'sync-dir', code: 'EIO', suffix: 'blobs' }, () => codeOf(() => syncDir(join(dir, 'x')))), 'EIO')
  })
})

test('platform redefine process.platform mientras dura y las funciones de fs vuelven a ser las originales', () => {
  const { platform } = process
  const open = fs.openSync
  const fsync = fs.fsyncSync
  const rename = fs.renameSync
  const close = fs.closeSync
  const simulated = platform === 'win32' ? 'darwin' : 'win32'
  withFsFault({ op: 'sync-dir', code: 'EIO', platform: simulated }, () => assert.equal(process.platform, simulated))
  assert.equal(process.platform, platform)
  assert.equal(fs.openSync, open)
  assert.equal(fs.fsyncSync, fsync)
  assert.equal(fs.renameSync, rename)
  assert.equal(fs.closeSync, close)
})
