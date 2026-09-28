export function killWorker(pid, signal = 'SIGKILL', processApi = process) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (processApi.platform !== 'win32') {
    try { processApi.kill(-pid, signal); return; }
    catch (error) { if (error.code !== 'ESRCH') { /* Group unavailable: fall back to its leader. */ } }
  }
  try { processApi.kill(pid, signal); } catch { /* Already exited. */ }
}
