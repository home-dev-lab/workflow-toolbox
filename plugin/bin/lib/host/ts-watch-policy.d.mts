export const DEFAULT_NATIVE_WATCH_BUDGET: 64
export function createBoundedFsWatch(ts: unknown, nativeWatch?: typeof import('node:fs').watch, settings?: { budget?: number }): typeof import('node:fs').watch
export function createPollingDirectoryWatch(ts: unknown, system?: unknown): (directory: string, callback: (path: string) => void, recursive?: boolean, options?: object) => { close(): void }
export function observeClosedProgramInputs(ts: unknown): void
export function boundTypeScriptWatches(ts: unknown, fs?: unknown): void
