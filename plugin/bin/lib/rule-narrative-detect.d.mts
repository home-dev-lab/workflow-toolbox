export interface AddedLine {
  text: string
  lineNumber: number
  context?: string[]
}

export interface NarrativeFinding {
  detector: string
  match: string
  lineNumber: number
  snippet: string
  tier: 'deny' | 'warn'
}

export interface AddedLinesInput {
  tool: string
  input: Record<string, unknown>
  currentText?: string | null
}

export function addedLines(request: AddedLinesInput): AddedLine[]
export function detectNarrative(
  lines: readonly AddedLine[],
  options?: { honorMarker?: boolean },
): NarrativeFinding[]
