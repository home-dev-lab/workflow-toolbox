// Tiny shared runtime type-narrowers, used across @workflow-toolbox packages (debugger, smoke) to parse
// untrusted JSON (journals, SDK messages, marker files). `isRecord` EXCLUDES arrays so
// callers can safely index string keys without an array slipping through as a "record".

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
