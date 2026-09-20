import { createReadStream, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { detections } from './detector.js';

const roots = process.argv.slice(2).map((path) => resolve(path));
if (!roots.length) {
  process.stderr.write('usage: node detector.measure.mjs <transcript-directory> [...]\n');
  process.exit(2);
}

function* transcriptFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* transcriptFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

const measuredKinds = new Set(['credential-uuid', 'brave-api-key']);
const totals = { transcripts: 0, records: 0, detections: 0, credentialUuid: 0, braveApiKey: 0 };
const review = [];

function reviewContext(line, value) {
  const index = line.indexOf(value);
  const excerpt = line.slice(Math.max(0, index - 80), index + value.length + 80).replace(value, '[candidate]');
  return excerpt.replace(/[A-Za-z0-9+/_-]{16,}/g, '[opaque]');
}

for (const root of roots) {
  for (const path of transcriptFiles(root)) {
    totals.transcripts += 1;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) continue;
      totals.records += 1;
      for (const detection of detections(line).filter(({ kind }) => measuredKinds.has(kind))) {
        totals.detections += 1;
        if (detection.kind === 'credential-uuid') totals.credentialUuid += 1;
        else totals.braveApiKey += 1;
        review.push({ kind: detection.kind, path, line: lineNumber, context: reviewContext(line, detection.value) });
      }
    }
  }
}

process.stdout.write(`${JSON.stringify({ ...totals, review }, null, 2)}\n`);
