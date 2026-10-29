// A `node --test` reporter that names how a test FILE's process ended when the file failed. The spec reporter prints
// only 'test failed' for a file whose process exited non-zero with every subtest passing, yet the runner holds that
// process's exit code and signal: a crash status (0xC0000005 on Windows), a silent `process.exitCode` and a kill from
// outside are three different causes, told apart only by these two values.
const hex = (code) => (Number.isInteger(code) ? ` (0x${(code >>> 0).toString(16).toUpperCase()})` : '');

export function describeFileFailure(data) {
  const error = data?.details?.error;
  if (!error || typeof error !== 'object' || !('exitCode' in error || 'signal' in error)) return null;
  return `node --test: ${data.file ?? data.name} exited with code ${error.exitCode}${hex(error.exitCode)}, ` +
    `signal ${error.signal ?? 'none'}, failure type ${error.failureType ?? 'unknown'}\n`;
}

export default async function* nodeTestExitReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const line = describeFileFailure(event.data);
    if (line) yield line;
  }
}
