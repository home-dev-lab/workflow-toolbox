// The one verdict every spawning process-snapshot reader gives a failed read. A read counts as failed when the
// command did not exit 0 OR the invocation reported an error: spawnSync can hand back exit 0 together with an
// ENOBUFS error and a truncated table, and that table must never be read as complete. The reason names the
// command and its cause, because "unavailable on this platform" hid an output overflow on a platform that
// supports discovery.
export function processSnapshotFailure(result, command) {
  if (result.status === 0 && !result.error) return null
  const cause = result.error?.code ?? result.error?.message ?? `exited ${String(result.status)}`
  return { supported: false, processes: [], reason: `process discovery failed: ${command} ${cause}` }
}
