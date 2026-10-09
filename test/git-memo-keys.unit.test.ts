import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve, sep } from 'node:path'
import { GIT_QUERY_ENV, gitQueryKey, normalizeGitQueryInput } from '../src/git-memo.ts'

test('las claves distinguen entradas y nunca unen checkouts distintos', () => {
  const a = { dev: '9007199254740993', ino: '9007199254740995' }
  const b = { ...a, ino: '9007199254740996' }
  const path = resolve('Checkout')
  assert.equal(normalizeGitQueryInput(join(path, '.', 'nested', '..') + sep), path)
  assert.equal(gitQueryKey('gitDirs', path, {}, a), gitQueryKey('gitDirs', path.toLowerCase(), {}, a))
  assert.notEqual(gitQueryKey('gitDirs', path, {}, a), gitQueryKey('gitDirs', path, {}, b))
  for (const query of ['repoRoot', 'objects'] as const) {
    assert.notEqual(gitQueryKey(query, path, {}, a), gitQueryKey(query, path.toLowerCase(), {}, a))
  }
  for (const name of GIT_QUERY_ENV) {
    for (const query of ['repoRoot', 'gitDirs', 'objects'] as const) {
      assert.notEqual(gitQueryKey(query, path, {}, a), gitQueryKey(query, path, { [name]: '' }, a))
      assert.notEqual(gitQueryKey(query, path, { [name]: '' }, a), gitQueryKey(query, path, { [name]: 'value' }, a))
    }
  }
  // En POSIX la barra invertida es parte del nombre; en Windows los dos separadores son el mismo y comparten clave.
  if (sep === '/') assert.notEqual(normalizeGitQueryInput('a/b'), normalizeGitQueryInput('a\\b'))
  else {
    assert.equal(normalizeGitQueryInput('C:/x/y'), normalizeGitQueryInput('C:\\x\\y'))
    for (const query of ['repoRoot', 'gitDirs', 'objects'] as const) {
      assert.equal(gitQueryKey(query, normalizeGitQueryInput('C:/x/y'), {}, a), gitQueryKey(query, normalizeGitQueryInput('C:\\x\\y'), {}, a))
    }
  }
})
