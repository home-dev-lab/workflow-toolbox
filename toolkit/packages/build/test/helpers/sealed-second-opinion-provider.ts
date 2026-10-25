// Replace the SDK boundary, retaining the real CLI, core and provider option propagation.
// The subprocess is unconditionally the fixture's local Node script, never a model binary.
export function sealedSecondOpinionSdk(binary: string) {
  return `import { spawn } from 'node:child_process';
    export const resolveAgentSdkRequire = () => () => ({ query });
    async function* query({ prompt, options }) {
      const child = spawn(process.execPath, [${JSON.stringify(binary)}, 'run', '--prompt', prompt], {
        cwd: options.cwd, env: options.env, signal: options.abortController?.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [], stderr = [];
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (code) throw new Error(Buffer.concat(stderr).toString() || 'sealed model failed');
      yield { type: 'result', result: Buffer.concat(stdout).toString() || 'SEALED ANSWER' };
    }`
}
