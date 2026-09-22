import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const path = process.argv[2];
const input = await new Promise((resolve) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { value += chunk; });
  process.stdin.on('end', () => resolve(value));
});
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
let target = path;
try {
  if ((await stat(path)).size >= 4 * 1024 * 1024) target = `${path}.${Date.now()}`;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await appendFile(target, input, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(target);
