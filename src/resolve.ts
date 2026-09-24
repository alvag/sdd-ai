import type { WorkersFile } from './profiles.ts'
import {
  type Conductor, type Effort, type Family, type Origin, type Profile, type Resolution, type Role,
  opposite, toNativeEffort,
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
 * Lo que significa `heredado`, igual que en sdd-flow: Claude usa el modelo de la ruta de juicio y
 * el esfuerzo por defecto del CLI; Codex, lo que declare la raíz del config personal.
 */
function inherited(family: Family, codexRoot: Profile): Profile {
  return family === 'claude' ? { model: 'opus' } : { ...codexRoot }
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
  const base = inherited(family, codexRoot)
  const model = pick<string>(flags.model, file.model, base.model)
  const effort = pick<Effort>(flags.effort, file.effort, base.effort)

  const r: Resolution = { family, via, origin: { model: model.origin, effort: effort.origin } }
  if (model.value !== undefined) r.model = model.value
  if (effort.value !== undefined) r.effort = effort.value
  return r
}

/** Perfil de `explore` con el que se generan los agentes nativos de cada familia. */
export function nativeProfile(family: Family, workers: WorkersFile | null, codexRoot: Profile): Profile {
  const r = resolve({ conductor: { family }, families: [family], workers, role: 'explore', flags: {}, codexRoot })
  const p: Profile = {}
  if (r.model !== undefined) p.model = r.model
  if (r.effort !== undefined) p.effort = r.effort
  return p
}
