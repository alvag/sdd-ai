import type { RoleProfiles } from './agents.ts'
import { type WorkersFile, loadWorkers, loadCodexRoot } from './profiles.ts'
import {
  type Conductor, type Effort, type Family, type Origin, type Profile, type Resolution, type Role,
  READ_ONLY_ROLES, opposite, toNativeEffort,
} from './types.ts'

export interface ResolveInput {
  conductor: Conductor
  families: Family[]
  workers: WorkersFile | null
  role: Role
  flags: Profile
  codexRoot: Profile
}

/**
 * Lo que significa `heredado`, igual que en sdd-flow: Claude usa el modelo de su ruta (`sonnet` para
 * implementar, `opus` para las de juicio) y el esfuerzo por defecto del CLI; Codex, lo que declare la
 * raíz del config personal.
 */
function inherited(family: Family, role: Role, codexRoot: Profile): Profile {
  if (family === 'codex') return { ...codexRoot }
  return { model: role === 'implement' ? 'sonnet' : 'opus' }
}

function pick<T>(flag: T | undefined, fromFile: T | undefined, fromInheritance: T | undefined): { value?: T; origin: Origin } {
  if (flag !== undefined) return { value: flag, origin: 'flag' }
  if (fromFile !== undefined) return { value: fromFile, origin: 'workers' }
  return { value: fromInheritance, origin: 'heredado' }
}

function fileProfile(workers: WorkersFile | null, role: Role, family: Family): Profile {
  const p = workers?.roles[role]?.[family]
  const out: Profile = {}
  if (p?.model !== undefined && p.model !== 'heredado') out.model = p.model
  if (p?.effort !== undefined && p.effort !== 'heredado') out.effort = toNativeEffort(p.effort)
  return out
}

export function resolve(input: ResolveInput): Resolution {
  const { conductor, families, workers, role, flags, codexRoot } = input
  const family = families.length === 1 ? families[0] : opposite(conductor.family)
  const via = family === conductor.family ? 'native' : 'process'

  const file = fileProfile(workers, role, family)
  const base = inherited(family, role, codexRoot)
  const model = pick<string>(flags.model, file.model, base.model)
  const effort = pick<Effort>(flags.effort, file.effort, base.effort)

  const r: Resolution = { family, via, origin: { model: model.origin, effort: effort.origin } }
  if (model.value !== undefined) r.model = model.value
  if (effort.value !== undefined) r.effort = effort.value
  return r
}

/** Perfil con el que se genera el agente nativo de un rol en una familia. */
export function nativeProfile(family: Family, role: Role, workers: WorkersFile | null, codexRoot: Profile): Profile {
  const r = resolve({ conductor: { family }, families: [family], workers, role, flags: {}, codexRoot })
  const p: Profile = {}
  if (r.model !== undefined) p.model = r.model
  if (r.effort !== undefined) p.effort = r.effort
  return p
}

/** Perfiles nativos de los agentes de solo lectura. */
export function roleProfiles(workers: WorkersFile | null, codexRoot: Profile): RoleProfiles {
  return Object.fromEntries(READ_ONLY_ROLES.map((role) => [role, {
    claude: nativeProfile('claude', role, workers, codexRoot),
    codex: nativeProfile('codex', role, workers, codexRoot),
  }])) as RoleProfiles
}

/** Los mismos perfiles del worktree y del entorno para el despacho y las inspecciones. */
export function nativeProfiles(root: string, env: Record<string, string | undefined>): RoleProfiles {
  return roleProfiles(loadWorkers(root), loadCodexRoot(env))
}
