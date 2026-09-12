interface AvailableVerdictInput {
  commandResolved?: string | undefined
  output: string
  debug?: string
  expectedSubstring: string
  exitCode: number | null
  timedOut: boolean
}

interface MissingVerdictInput {
  commandResolved?: string | undefined
  claudeResolved?: string | undefined
  nodeResolved?: string | undefined
  output: string
  debug?: string
  exitCode: number | null
  timedOut: boolean
}

interface Verdict {
  pass: boolean
  diagnostic: boolean
  reason: string
}

interface NavigationVerdictInput {
  commandResolved?: string | undefined | boolean
  output: string
  debug?: string
  expectedSubstrings: string[]
  capability: string
  exitCode: number | null
  timedOut: boolean
  language?: string
}

export const CAPABILITIES: string[]
export function resolveCommand(command: string, pathValue: string): string | undefined
export function buildShimDirectory(pathValue: string, excludedCommand: string, shimDirectory: string): string[]
export function linkWorkspaceModules(projectDir: string, toolkitDir: string): string[]
export function containsDiagnostic(output: string, expectedSubstring: string, options?: { includeAssistantText?: boolean }): boolean
export function availableVerdict(input: AvailableVerdictInput): Verdict
export function missingVerdict(input: MissingVerdictInput): Verdict
export function parseProbeArguments(args: string[]): { pack: string; capability: string }
export function navigationVerdict(input: NavigationVerdictInput): { verdict: 'parity' | 'no parity' | 'unmeasured'; reason: string; requests?: string[] }
export function serverStartFailure(debug: string, language: string): string | undefined
export function probePack(pack: string, options?: { repoRoot?: string; pathValue?: string; toolkitDir?: string; archiveRoot?: string; capability?: string }): Promise<boolean>
export function deliveredAttachments(debugText: string): number
export function publishedDiagnostics(debugText: string): boolean
