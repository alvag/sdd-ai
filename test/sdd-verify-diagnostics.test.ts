import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPhaseRecord } from '../src/sdd/phase-state.ts'
import { readVerifyReceipt } from '../src/sdd/verify-receipt.ts'
import { proposeClass } from '../src/sdd/chain.ts'
import { randomUUID } from 'node:crypto'
import {
  realpathTmp, EXEC, TROW, RED_ROW, BUILD_ROW, verifyFlow, planOf, final, cli, B_ROW, B_BASE, B_CANDIDATE,
} from './sdd-verify-fixture.ts'

test('una confirmación que no carga al revertir es un defecto de contrato con su módulo y la ruta que falta', () => {
  const { repo } = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: B_CANDIDATE })
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CONFIG_DIR: realpathTmp(), CODEX_SESSION_ID: '', CODEX_THREAD_ID: '' }
  const run = cli(repo, env, 'sdd', 'verify', 'f')
  assert.equal(run.out.green, false, JSON.stringify(run.out))
  const [v1] = run.out.rows
  assert.equal(v1.outcome, 'failed')
  assert.equal(v1.confirmation, 'contract_incoherent')
  for (const text of ['src/a.ts', '«g»', 'src/b.ts', 'contract']) assert.ok(v1.reason.includes(text), `${text}: ${v1.reason}`)
  assert.match(v1.reason, /falta src\/a\.ts en implementation_paths/)

  const receipt = readVerifyReceipt(repo, readPhaseRecord(repo, 'f').verify!.receipts.at(-1)!)
  assert.equal(receipt.green, false)
  assert.equal(receipt.rows[0].confirmation?.state, 'contract_incoherent')
  assert.match(receipt.rows[0].confirmation?.reason ?? '', /src\/a\.ts/)
  assert.match(planOf(repo), /revert: contract_incoherent \(/)
  assert.match(planOf(repo), /\| AC-1 \| V1 \| ❌ failed \|/)
  assert.equal(readFileSync(join(repo, 'src', 'b.ts'), 'utf8'), B_CANDIDATE['src/b.ts'])

  // Contraste: si el test sigue pasando con las rutas revertidas, es una refutación del comportamiento.
  const refuted = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: { 'src/b.ts': 'export const h = () => 0 // cambia\n' } })
  const other = cli(refuted.repo, env, 'sdd', 'verify', 'f')
  assert.equal(other.out.rows[0].confirmation, 'refuted')
})

test('una confirmación con el contrato incoherente propone la clase contract', () => {
  const tap = 'TAP version 13\nok 1 - pasa\n'
  const result = (state: 'contract_incoherent' | 'not_confirmable') => ({
    row: 'V1', outcome: 'failed' as const, execution: { ...EXEC, exit_code: 0 },
    confirmation: { row: 'V1', obligation: 'red_on_revert' as const, state, restored: true },
  })
  assert.equal(proposeClass(TROW, result('contract_incoherent'), tap), 'contract')
  assert.equal(proposeClass(TROW, result('not_confirmable'), tap), null)
})

test('el diagnóstico de un módulo que no existe nombra el importador aunque la ruta del repositorio tenga espacios', async () => {
  const { repo } = verifyFlow({
    prefix: 'sdd ai repo-', rows: [B_ROW, BUILD_ROW],
    base: { 'src/b.ts': "import { c } from './c.ts'\nexport const h = () => c\n", 'src/c.ts': 'export const c = 0\n' },
    candidate: {
      'src/b.ts': 'export const g = () => 2\n',
      'test/a.test.ts': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { g } from '../src/b.ts'\ntest('f da 2', () => { assert.equal(g(), 2) })\n",
    },
  })
  rmSync(join(repo, 'src', 'c.ts'))
  const confirmation = (await final(repo)).receipt.rows[0].confirmation
  assert.equal(confirmation?.state, 'contract_incoherent')
  assert.match(confirmation?.reason ?? '', /src\/b\.ts importa src\/c\.ts, que no existe/)
})

test('el diagnóstico de carga nombra la ruta solo si la evidencia la identifica y no atribuye una aserción opaca', async () => {
  // La evidencia identifica al importador que no está en implementation_paths.
  const named = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: B_CANDIDATE })
  const a = (await final(named.repo)).receipt.rows[0].confirmation
  assert.equal(a?.state, 'contract_incoherent')
  assert.match(a?.reason ?? '', /falta src\/a\.ts en implementation_paths/)

  // Si quien importa es la prueba, la ruta que falta no se puede determinar y no se propone una.
  const direct = verifyFlow({
    rows: [B_ROW, BUILD_ROW], base: B_BASE,
    candidate: {
      'src/b.ts': 'export const g = () => 2\nexport const h = () => 0\n',
      'test/a.test.ts': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { g } from '../src/b.ts'\ntest('f da 2', () => { assert.equal(g(), 2) })\n",
    },
  })
  const b = (await final(direct.repo)).receipt.rows[0].confirmation
  assert.equal(b?.state, 'contract_incoherent')
  assert.match(b?.reason ?? '', /test\/a\.test\.ts es una prueba/)
  assert.match(b?.reason ?? '', /no se puede determinar la ruta que falta/)
  assert.doesNotMatch(b?.reason ?? '', /falta \S+ en implementation_paths/)

  // Una aserción que falla sin diagnóstico de carga conserva su tratamiento: confirmada.
  const opaque = verifyFlow()
  const c = (await final(opaque.repo)).receipt.rows[0].confirmation
  assert.equal(c?.state, 'confirmed')

  // Un subprocess con un fallo de enlace propaga el diagnóstico en el error del test nombrado.
  const subprocessTest = (paths: string[]) => `import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
test('f da 2', () => {
  const errors = []
  for (const path of ${JSON.stringify(paths)}) {
    try { execFileSync(process.execPath, [path], { stdio: 'pipe' }) }
    catch (error) { errors.push(error.message) }
  }
  if (errors.length) throw new Error(errors.join('\\n'))
})\n`
  const propagated = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: B_BASE, candidate: {
    ...B_CANDIDATE, 'test/a.test.ts': subprocessTest(['src/a.ts']),
  } })
  const d = (await final(propagated.repo)).receipt.rows[0].confirmation
  assert.equal(d?.state, 'contract_incoherent')
  assert.match(d?.reason ?? '', /falta src\/a\.ts en implementation_paths/)

  // Un diagnóstico sin marcador propio no hereda el importador de otro fallo de carga.
  const unlocated = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: {
    ...B_BASE, 'src/c.ts': 'export const c = 1\n', 'src/d.ts': 'export const d = 1\n',
    'src/e.ts': 'export const e = 1\n',
  }, candidate: {
    ...B_CANDIDATE, 'src/b.ts': 'export const g = () => 2\nexport const h = () => 2\n',
    'src/c.ts': "import { z } from './d.ts'\nexport const c = z\n",
    'src/e.ts': "import { g } from './b.ts'\nexport const e = g()\n",
    'src/unlocated.ts': "import('./e.ts').catch(error => { console.error(error.toString()); process.exitCode = 1 })\n",
    'test/a.test.ts': "import { h } from '../src/b.ts'\n" + subprocessTest(['src/c.ts', 'src/unlocated.ts'])
      .replace('  const errors = []', '  if (h() !== 0) return\n  const errors = []'),
  } })
  const withoutImporter = (await final(unlocated.repo)).receipt.rows[0].confirmation
  assert.equal(withoutImporter?.state, 'confirmed', withoutImporter?.reason ?? '')

  // Los helpers bajo el directorio de pruebas tampoco se proponen como implementación.
  const helper = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: {
    ...B_BASE, 'test/helpers.ts': 'export const f = () => 1\n',
  }, candidate: {
    ...B_CANDIDATE,
    'test/helpers.ts': "import { g } from '../src/b.ts'\nexport const f = () => g()\n",
    'test/a.test.ts': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { f } from './helpers.ts'\ntest('f da 2', () => { assert.equal(f(), 2) })\n",
  } })
  const helperFailure = (await final(helper.repo)).receipt.rows[0].confirmation
  assert.equal(helperFailure?.state, 'contract_incoherent')
  assert.match(helperFailure?.reason ?? '', /test\/helpers\.ts es una prueba/)
  assert.match(helperFailure?.reason ?? '', /no se puede determinar la ruta que falta/)
  assert.doesNotMatch(helperFailure?.reason ?? '', /falta \S+ en implementation_paths/)

  // Citar un diagnóstico mientras falla una aserción no demuestra que el módulo no cargó.
  const incidental = verifyFlow({ base: { 'src/b.ts': 'export const b = 1\n' }, candidate: { 'src/b.ts': 'export const b = 2\n' } })
  writeFileSync(join(incidental.repo, 'test/a.test.ts'), `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { f } from '../src/a.ts'
test('f da 2', () => {
  if (f() === 1) console.error(${JSON.stringify("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '" + join(incidental.repo, 'src/a.ts') + "' imported from " + join(incidental.repo, 'src/b.ts'))})
  assert.equal(f(), 2)
})\n`)
  const e = (await final(incidental.repo)).receipt.rows[0].confirmation
  assert.equal(e?.state, 'confirmed')

  // Una dependencia externa observable no es una ruta que se pueda agregar al conjunto de revert.
  const external = join(realpathTmp(), 'outside.mjs')
  writeFileSync(external, 'export const h = 1\n')
  const outside = verifyFlow({ rows: [RED_ROW, BUILD_ROW], base: {
    'src/a.ts': `import { g } from ${JSON.stringify(external)}\nexport const f = () => g\n`,
  }, candidate: { 'test/a.test.ts': subprocessTest(['src/a.ts']) } })
  const g = (await final(outside.repo)).receipt.rows[0].confirmation
  assert.equal(g?.state, 'contract_incoherent')
  assert.match(g?.reason ?? '', /outside\.mjs/)
  assert.match(g?.reason ?? '', /no se puede determinar la ruta que falta/)
  assert.doesNotMatch(g?.reason ?? '', /falta \S+ en implementation_paths/)

  // Dos importadores modificados observables no permiten escoger una única ruta que falta.
  const multiple = verifyFlow({ rows: [B_ROW, BUILD_ROW], base: {
    ...B_BASE, 'src/c.ts': 'export const c = 1\n',
  }, candidate: {
    ...B_CANDIDATE, 'src/c.ts': "import { g } from './b.ts'\nexport const c = g()\n",
    'test/a.test.ts': subprocessTest(['src/a.ts', 'src/c.ts']),
  } })
  const h = (await final(multiple.repo)).receipt.rows[0].confirmation
  assert.equal(h?.state, 'contract_incoherent')
  assert.match(h?.reason ?? '', /no hay una única ruta candidata/)
  assert.doesNotMatch(h?.reason ?? '', /falta \S+ en implementation_paths/)
})
