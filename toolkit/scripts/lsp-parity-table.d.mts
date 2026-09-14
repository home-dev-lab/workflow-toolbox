export function renderParityTable(data: Record<string, Record<string, { verdict: string; reason?: string }>>, languages?: string[]): { markdown: string; json: Record<string, Record<string, { verdict: string; reason?: string }>> }
export function writeParityTable(archive: string): { markdown: string; json: Record<string, Record<string, { verdict: string; reason?: string }>> }
