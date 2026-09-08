export function parseRunnerArgs(argv: string[]): {
  agentPath: string
  inputPath: string
  outputPath: string
}

export function parseAgentFrontmatter(source: string): {
  frontmatter: Record<string, string>
  body: string
}

export function requireString(frontmatter: Record<string, string>, field: string): string

export function serializeRun(
  agentPath: string,
  model: string,
  effort: string,
  transcript: unknown[],
): {
  agent: { path: string; model: string; effort: string }
  transcript: unknown[]
  usage: unknown
}
