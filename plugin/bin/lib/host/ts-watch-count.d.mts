export const DEFAULT_WATCH_WARN_PCT: number
export const WATCH_SAMPLE_INTERVAL_MS: number
export interface WatchReader {
  platform?: string
  read?: (file: string) => string
  list?: (dir: string) => string[]
}
export type WatchSample = { status: 'skipped'; reason: 'non-linux' } | { status: 'unavailable' } | { status: 'measured'; watches: number; max: number }
export function readTsserverWatchCount(pid: string | number, options?: WatchReader): WatchSample
export function watchWarningThreshold(value?: string): number
export function createWatchWarning(stderr: Pick<NodeJS.WritableStream, 'write'>, options?: WatchReader & { threshold?: number }): (pid: string | number) => WatchSample
export function monitorTsserverWatches(child: { pid?: number; once(event: string, callback: () => void): unknown }, stderr: Pick<NodeJS.WritableStream, 'write'>, options?: WatchReader): { status: 'skipped'; reason: 'non-linux' } | { status: 'monitoring' }
