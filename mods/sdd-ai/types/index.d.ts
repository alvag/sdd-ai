export type CommandDecision = { kind: 'recognized'; command: string } | { kind: 'native' }
export interface Attribution { command: string }
export interface LedgerRow { id: string; severity: string; reviewer?: string; state: string; claim: string }
export interface Summary {
  state?: string
  code?: string
  message?: string
  detail?: string
  next?: string[]
  ledger?: LedgerRow[]
  extra: string[]
  exitCode?: number
}
export type OriginalOutput = { kind: 'text'; text: string } | { kind: 'streams'; stdout: string; stderr: string }
export type OutputDecision = { kind: 'native' } | { kind: 'interrupted' } | { kind: 'summary'; summary: Summary; original: OriginalOutput }

declare module 'claude-code' {
  interface PluginState {
    'sdd-ai-mod': { attribution: StateFamily<Attribution> }
  }
}
