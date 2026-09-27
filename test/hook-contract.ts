import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Qué salida acepta cada CLI de un hook. Los esquemas de Codex están copiados sin cambios de
 * `codex-rs/hooks/schema/generated/` en el tag `rust-v0.157.1`: Codex rechaza campos desconocidos, así
 * que se comparan claves, obligatorios y tipos. Encima van las reglas que Codex aplica al parsear
 * (`hooks/src/engine/output_parser.rs`). De Claude Code se comprueba la forma documentada.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'hooks')

const SCHEMA_FILES: Record<string, string> = {
  SessionStart: 'codex-session-start.command.output.schema.json',
  Stop: 'codex-stop.command.output.schema.json',
  PreToolUse: 'codex-pre-tool-use.command.output.schema.json',
  PostToolUse: 'codex-post-tool-use.command.output.schema.json',
}

interface Schema {
  type?: string; const?: unknown; enum?: unknown[]; default?: unknown
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean
  allOf?: Schema[]; $ref?: string; definitions?: Record<string, Schema>
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function validate(value: unknown, schema: Schema, root: Schema, path: string, errors: string[]): void {
  // Un campo opcional de Codex declara `default: null`: el parser lo acepta nulo.
  if (value === null && 'default' in schema && schema.default === null) return
  if (schema.$ref) {
    const name = schema.$ref.replace('#/definitions/', '')
    const target = root.definitions?.[name]
    if (!target) throw new Error(`referencia sin resolver: ${schema.$ref}`)
    validate(value, target, root, path, errors)
    return
  }
  for (const part of schema.allOf ?? []) validate(value, part, root, path, errors)
  if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path}: se esperaba un string`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: se esperaba un booleano`)
  if (schema.type === 'object' && !isObject(value)) errors.push(`${path}: se esperaba un objeto`)
  if ('const' in schema && value !== schema.const) errors.push(`${path}: debe ser ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} no está en ${JSON.stringify(schema.enum)}`)
  if (!isObject(value) || !schema.properties) return
  for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: falta ${key}`)
  for (const [key, v] of Object.entries(value)) {
    const property = schema.properties[key]
    if (!property) {
      if (schema.additionalProperties === false) errors.push(`${path}: campo desconocido ${key}`)
      continue
    }
    validate(v, property, root, `${path}.${key}`, errors)
  }
}

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== ''

function codexRules(event: string, out: Record<string, unknown>, errors: string[]): void {
  if (event === 'Stop' && out.decision === 'block' && !nonEmpty(out.reason)) errors.push('Stop: block sin reason')
  if (event !== 'PreToolUse' || !isObject(out.hookSpecificOutput)) return
  const h = out.hookSpecificOutput
  const decision = h.permissionDecision ?? null
  const updated = h.updatedInput ?? null
  if (updated !== null && decision !== 'allow') errors.push('PreToolUse: updatedInput sin permissionDecision allow')
  if (decision === 'allow' && updated === null) errors.push('PreToolUse: allow sin updatedInput')
  if (decision === 'ask') errors.push('PreToolUse: ask no está soportado')
  if (decision === 'deny' && !nonEmpty(h.permissionDecisionReason)) errors.push('PreToolUse: deny sin motivo')
  if (decision === null && h.permissionDecisionReason != null) errors.push('PreToolUse: motivo sin decisión')
}

const CLAUDE_KEYS = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput'])

function claudeRules(event: string, out: Record<string, unknown>, errors: string[]): void {
  for (const key of Object.keys(out)) if (!CLAUDE_KEYS.has(key)) errors.push(`campo desconocido ${key}`)
  if ('hookSpecificOutput' in out) {
    const h = out.hookSpecificOutput
    if (!isObject(h)) errors.push('hookSpecificOutput: se esperaba un objeto')
    else {
      if (h.hookEventName !== event) errors.push(`hookSpecificOutput.hookEventName: debe ser ${event}`)
      if (event === 'PreToolUse' && h.permissionDecision !== undefined && !['allow', 'deny', 'ask'].includes(h.permissionDecision as string)) {
        errors.push('PreToolUse: permissionDecision inválido')
      }
      // Claude acepta una negación sin motivo, pero el conductor necesita saber qué hacer.
      if (event === 'PreToolUse' && h.permissionDecision === 'deny' && !nonEmpty(h.permissionDecisionReason)) {
        errors.push('PreToolUse: deny sin motivo')
      }
    }
  }
  if ('decision' in out) {
    if (event !== 'Stop') errors.push(`${event}: decision solo vale en Stop`)
    else if (out.decision !== 'block' || !nonEmpty(out.reason)) errors.push('Stop: decision exige block y reason')
  }
}

/** Los errores de forma de la salida `out` de un hook para `event` en `cli`; vacío si el CLI la acepta. */
export function checkOutput(cli: 'claude' | 'codex', event: string, out: unknown): string[] {
  const errors: string[] = []
  if (!isObject(out)) return ['la salida no es un objeto JSON']
  if (cli === 'claude') {
    claudeRules(event, out, errors)
    return errors
  }
  const file = SCHEMA_FILES[event]
  if (!file) return [`sin esquema de salida para ${event}`]
  const schema = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Schema
  validate(out, schema, schema, event, errors)
  codexRules(event, out, errors)
  return errors
}

/** El payload `<cli>-<name>.json`, con la forma real de ese CLI, más lo que el test cambie. */
export function payload(cli: 'claude' | 'codex', name: string, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...JSON.parse(readFileSync(join(FIXTURES, `${cli}-${name}.json`), 'utf8')), ...patch }
}
