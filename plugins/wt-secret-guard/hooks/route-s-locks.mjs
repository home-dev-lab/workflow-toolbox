import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyOutbound as frozen } from './fixtures/base-outbound-tools.frozen.mjs';
import { classifyOutbound } from './outbound-tools.js';

export const conditionCases = [
  ['shape', 'password: "${HOME}\n'],
  ['reference', 'password="${HOME}word"\n'],
  ['terminator', 'password="${HOME}";\n'],
  ['deeper', 'password="${HOME}"\n  Q7m9Ab12\n'],
  ['literal', 'text="\npassword: "${HOME}"\n'],
  ['bracket', '(\npassword: "${HOME}"\n'],
  ['backslash', '\\\npassword: "${HOME}"\n'],
  ['line', '\rpassword: "${HOME}"\n'],
  ['eof', 'password="${HOME}",'],
];

export async function conditionLocks(f) {
  for (const [name, content] of conditionCases) {
    await f.test(`VB Route S condition ${name}`, () => f.freshVault(async () => {
      const event = { tool: 'Write', content };
      assert.ok((await frozen({}, event)).findings.length, 'condition control not frozen-refused');
      assert.ok((await classifyOutbound({}, event)).findings.length, `${name} condition forwarded frozen refusal`);
    }));
  }
}

export async function mutantLocks(f) {
  await f.test('VB Route S isolated in-memory condition mutants', async () => {
    const source = await readFile(new URL('./value-boundary.js', import.meta.url), 'utf8');
    const absolute = source.replace("'./detector.js'", () => JSON.stringify(new URL('./detector.js', import.meta.url).href));
    for (const [name, content] of conditionCases) {
      const needle = `checks.${name}`;
      assert.ok(absolute.includes(needle), `missing mutation seam ${name}`);
      const mutant = absolute.replace(needle, 'true');
      const module = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}`);
      assert.equal(module.boundaryFindings(content).length, 0, `${name} lock did not kill mutant`);
    }
  });
}

export async function isolatedScanner(source) {
  const original = source ?? await readFile(new URL('./value-boundary.js', import.meta.url), 'utf8');
  const absolute = original.replace("'./detector.js'", () => JSON.stringify(new URL('./detector.js', import.meta.url).href));
  const injected = absolute.replace('const candidates = discoverCandidates(text);', 'const candidates = selectedCandidates;')
    .replace('for (const item of discoverCandidates(text))', 'for (const item of selectedCandidates)');
  const module = await import(`data:text/javascript;base64,${Buffer.from(injected + '\nlet selectedCandidates; export function selectCandidates(items) { selectedCandidates = items; }').toString('base64')}`);
  return module;
}
