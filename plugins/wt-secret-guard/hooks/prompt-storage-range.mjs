import { open } from 'node:fs/promises';

const [path, offsetText, lengthText, inodeText] = process.argv.slice(2);
const offset = Number(offsetText);
const length = Number(lengthText);
const input = await new Promise((resolve) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { value += chunk; });
  process.stdin.on('end', () => resolve(value));
});
const { expected: expectedText, replacement: replacementText } = JSON.parse(input);
const expected = Buffer.from(expectedText, 'base64');
const replacement = Buffer.from(replacementText, 'base64');
const handle = await open(path, 'r+');
try {
  const stat = await handle.stat();
  if (inodeText && String(stat.ino) !== inodeText) process.exitCode = 2;
  else {
    const current = Buffer.alloc(length);
    const result = await handle.read(current, 0, length, offset);
    if (result.bytesRead !== length || !current.equals(expected)) process.exitCode = 3;
    else {
      const written = await handle.write(replacement, 0, replacement.length, offset);
      if (written.bytesWritten !== replacement.length) process.exitCode = 4;
      else await handle.sync();
    }
  }
} finally {
  await handle.close();
}
