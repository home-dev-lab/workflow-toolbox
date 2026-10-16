// TEMPORARY diagnostic: remove once the Windows-only file-level failure of the rules-on-demand plugin suite is
// explained. Preloaded (`--import`) into the plugin suite's `node --test` run, it acts only in the test-file processes
// (NODE_TEST_CONTEXT is set there, never in the runner) and writes to stderr only when something is wrong: a non-zero
// exit with the stack of any `process.exit` call and the resources still open, and every unhandled rejection or uncaught
// exception with its full stack (the runner's own diagnostic carries the message only). A process ended from outside
// (TerminateProcess on Windows) or by a native crash runs no exit listener: no line here, beside the exit code the exit
// reporter names, is that answer.
import { writeSync } from 'node:fs';

const say = (text) => {
  try { writeSync(2, `exit-trace ${process.pid} ${process.argv[1] ?? '(no entry)'}: ${text}\n`); } catch { /* stderr is gone */ }
};
const stackOf = (value) => (value instanceof Error ? value.stack : String(value));

function install() {
  let exitCaller = null;
  const exit = process.exit.bind(process);
  process.exit = (code) => {
    if (code) exitCaller = new Error(`process.exit(${code})`).stack;
    return exit(code);
  };
  process.on('unhandledRejection', (reason) => say(`unhandledRejection ${stackOf(reason)}`));
  process.on('uncaughtExceptionMonitor', (error, origin) => say(`${origin} ${stackOf(error)}`));
  process.on('exit', (code) => {
    if (!code) return;
    const resources = JSON.stringify(process.getActiveResourcesInfo());
    say(`exit code ${code}; process.exit called from ${exitCaller ?? 'nowhere (exitCode set by code or by the test harness)'}; open resources ${resources}`);
  });
}

if (process.env.NODE_TEST_CONTEXT) install();
