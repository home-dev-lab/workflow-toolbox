import { test } from 'node:test';
import { statSync } from 'node:fs';

// Checkout integrations are optional in a vendored plugin. Only absence is a
// skip: permissions, malformed contents and missing transitive imports stay red.
// The external URL is available only inside the guarded test callback.
export function externalTest(relativePath, parentURL) {
  const url = new URL(relativePath, parentURL);
  let skip = false;
  try { statSync(url); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    skip = `toolbox dependency absent: ${relativePath} (${url.href})`;
  }
  return (name, callback) => test(name, { skip }, (t) => callback(t, url));
}
