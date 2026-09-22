import { open } from 'node:fs/promises';

const [path, offsetText, lengthText, inodeText, mode = 'write'] = process.argv.slice(2);
const offset = Number(offsetText);
const length = Number(lengthText);
const input = mode === 'read' ? '' : await new Promise((resolve) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { value += chunk; });
  process.stdin.on('end', () => resolve(value));
});
const payload = input ? JSON.parse(input) : {};
const expected = Buffer.from(payload.expected ?? '', 'base64');
const replacement = Buffer.from(payload.replacement ?? '', 'base64');
const prefix = Buffer.from(payload.prefix ?? '', 'base64');
const handle = await open(path, mode === 'read' ? 'r' : 'r+');
try {
  const stat = await handle.stat();
  if (mode === 'read') {
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, offset);
    process.stdout.write(bytes.subarray(0, result.bytesRead).toString('base64'));
  } else if (inodeText && String(stat.ino) !== inodeText) process.exitCode = 2;
  else if (stat.size !== payload.size) process.exitCode = 6;
  else {
    const currentPrefix = Buffer.alloc(prefix.length);
    const prefixRead = await handle.read(currentPrefix, 0, prefix.length, 0);
    const current = Buffer.alloc(length);
    const result = await handle.read(current, 0, length, offset);
    if (prefixRead.bytesRead !== prefix.length || !currentPrefix.equals(prefix)
      || result.bytesRead !== length || !current.equals(expected)) process.exitCode = 3;
    else {
      const written = await handle.write(replacement, 0, replacement.length, offset);
      if (written.bytesWritten !== replacement.length) process.exitCode = 4;
      else {
        await handle.sync();
        const verify = Buffer.alloc(replacement.length);
        const verified = await handle.read(verify, 0, replacement.length, offset);
        if (verified.bytesRead !== replacement.length || !verify.equals(replacement)) process.exitCode = 5;
      }
    }
  }
} finally {
  await handle.close();
}
