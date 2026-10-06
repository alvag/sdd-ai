import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inPath } from '../src/cli-path.ts'

function withDirs(n: number, fn: (dirs: string[]) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'sdd-ai-cli-path-'))
  try {
    const dirs = Array.from({ length: n }, (_, i) => {
      const dir = join(base, `d${i}`)
      mkdirSync(dir)
      return dir
    })
    fn(dirs)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const touch = (dir: string, name: string) => writeFileSync(join(dir, name), '')

test('win32: claude.exe en un directorio de Path cuenta con un entorno plano sin PATH', () => {
  withDirs(1, ([dir]) => {
    touch(dir, 'claude.exe')
    assert.equal(inPath('claude', { Path: dir }, 'win32'), true)
    assert.equal(inPath('claude', { Path: `${join(dir, 'otro')};${dir}` }, 'win32'), true)
    assert.equal(inPath('codex', { Path: dir }, 'win32'), false)
  })
})

test('win32: con PATH y Path a directorios distintos manda la primera clave en orden de código', () => {
  withDirs(2, ([withExe, without]) => {
    touch(withExe, 'claude.exe')
    assert.equal(inPath('claude', { PATH: withExe, Path: without }, 'win32'), true)
    assert.equal(inPath('claude', { PATH: without, Path: withExe }, 'win32'), false)
  })
})

test('win32: una copia plana de process.env con solo Path cuenta claude.exe', () => {
  withDirs(1, ([dir]) => {
    touch(dir, 'claude.exe')
    const env: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH') env[key] = value
    env.Path = dir
    assert.equal(inPath('claude', env, 'win32'), true)
  })
})

test('win32: claude.cmd, claude.bat o un claude sin extensión solos no cuentan', () => {
  for (const name of ['claude.cmd', 'claude.bat', 'claude']) {
    withDirs(1, ([dir]) => {
      touch(dir, name)
      assert.equal(inPath('claude', { Path: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32'), false, name)
    })
  }
})

test('win32: claude.exe cuenta aunque PATHEXT falte o no incluya .EXE', () => {
  withDirs(1, ([dir]) => {
    touch(dir, 'claude.exe')
    assert.equal(inPath('claude', { Path: dir }, 'win32'), true)
    assert.equal(inPath('claude', { Path: dir, PATHEXT: '.CMD;.BAT' }, 'win32'), true)
  })
})

test('win32: un claude vacío junto a claude.exe no cambia la detección', () => {
  withDirs(1, ([dir]) => {
    touch(dir, 'claude')
    touch(dir, 'claude.exe')
    assert.equal(inPath('claude', { Path: dir }, 'win32'), true)
  })
})

test('win32: una entrada del Path entre comillas cuenta sin ellas', () => {
  withDirs(1, ([dir]) => {
    touch(dir, 'claude.exe')
    assert.equal(inPath('claude', { Path: `"${dir}"` }, 'win32'), true)
  })
})

test('darwin: cuenta el claude exacto del PATH y no un claude.exe solo', () => {
  withDirs(2, ([withBin, withExe]) => {
    touch(withBin, 'claude')
    chmodSync(join(withBin, 'claude'), 0o755)
    touch(withExe, 'claude.exe')
    chmodSync(join(withExe, 'claude.exe'), 0o755)
    assert.equal(inPath('claude', { PATH: withBin }, 'darwin'), true)
    assert.equal(inPath('claude', { PATH: withExe }, 'darwin'), false)
  })
})

test('darwin: un claude sin permiso de ejecución no cuenta', { skip: process.platform === 'win32' }, () => {
  withDirs(1, ([dir]) => {
    touch(dir, 'claude')
    chmodSync(join(dir, 'claude'), 0o644)
    assert.equal(inPath('claude', { PATH: dir }, 'darwin'), false)
  })
})
