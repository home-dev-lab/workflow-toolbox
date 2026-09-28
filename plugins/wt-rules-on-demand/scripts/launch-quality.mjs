import { killWorker } from './kill-worker.mjs';

// Spawn is injected so an asynchronous watchdog error can be exercised without a real child.
export function launchQuality({ spawn, executable, args, watchdogArgs, env, latestPath, publish, kill = killWorker }) {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env });
  child.on('error', async (error) => {
    await publish(latestPath, { ok: false, finishedAt: new Date().toISOString(), error: `spawn: ${error.message}` });
  });
  child.unref();
  let watchdog;
  try { watchdog = spawn(executable, watchdogArgs(child.pid), { detached: true, stdio: 'ignore' }); }
  catch (error) {
    kill(child.pid);
    return publish(latestPath, { ok: false, finishedAt: new Date().toISOString(), error: `watchdog spawn: ${error.message}` });
  }
  watchdog.on('error', async (error) => {
    kill(child.pid);
    await publish(latestPath, { ok: false, finishedAt: new Date().toISOString(), error: `watchdog spawn: ${error.message}` });
  });
  watchdog.unref();
}
