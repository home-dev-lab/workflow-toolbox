import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function captureHasPane(capture) {
  const lines = String(capture).split(/\r?\n/);
  const header = lines.findIndex((line) => line.includes('What is running') && line.includes('[Close]'));
  if (header < 0) return false;
  return lines.slice(header + 1).some((line) => {
    const separator = line.indexOf('│');
    return separator >= 0 && line.slice(separator + 1).trim().length > 0;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const capture = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
  process.exitCode = captureHasPane(capture) ? 0 : 1;
}
