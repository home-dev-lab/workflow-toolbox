import type { AddedLine, NarrativeFinding } from './rule-narrative-detect.mjs'

export interface SplitProposal {
  line: number
  text: string
}

export interface SplitResult {
  ok: boolean
  reason?: string
  proposals?: SplitProposal[]
  stdout?: string
}

export interface SplitRequest {
  instruction: string
  stdin: string
}

export interface RunSplitChildOptions extends SplitRequest {
  timeoutMs: number
  signal?: AbortSignal
  env?: Record<string, string | undefined>
  platform?: string
  spawnChild?: (...args: never[]) => unknown
}

export type SplitRunner = (options: RunSplitChildOptions) => Promise<SplitResult> | SplitResult

export function splitTimeoutMs(value: string | number | undefined | null): number
export function buildSplitRequest(lines: readonly AddedLine[], findings: readonly NarrativeFinding[]): SplitRequest
export function runSplitChild(options: RunSplitChildOptions): Promise<SplitResult>
export function splitNarrative(options: {
  lines: readonly AddedLine[]
  findings: readonly NarrativeFinding[]
  run?: SplitRunner
  env?: Record<string, string | undefined>
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<SplitResult>
export function renderNarrativeMessage(options: {
  findings: readonly NarrativeFinding[]
  lines: readonly AddedLine[]
  result: SplitResult
  file?: string
  deny?: boolean
}): string
