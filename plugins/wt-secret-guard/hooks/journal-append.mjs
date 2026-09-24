import { appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

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
  if ((await stat(path)).size >= 4 * 1024 * 1024) {
    const prefix = `${basename(path)}.`;
    const segments = (await readdir(dirname(path))).filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, number: Number(name.slice(prefix.length)) }))
      .filter(({ number }) => Number.isInteger(number) && number > 0)
      .sort((left, right) => left.number - right.number);
    const active = segments.at(-1);
    target = active ? `${dirname(path)}/${active.name}` : `${path}.1`;
    if (active && (await stat(target)).size >= 4 * 1024 * 1024) target = `${path}.${active.number + 1}`;
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await appendFile(target, input, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(target);
