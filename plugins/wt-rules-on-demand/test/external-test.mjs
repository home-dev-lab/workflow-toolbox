import { test } from 'node:test';
import { statSync } from 'node:fs';

// Checkout integrations are optional in a vendored plugin. Only absence is a
// skip: permissions, malformed contents and missing transitive imports stay red.
// externalTest hands the external URL only to the guarded test callback.
// externalSource is the same guard for a file that registers its own `test` calls:
// it returns the URL with the skip reason, and the caller must read it only in a
// test registered with that skip.
export function externalSource(relativePath, parentURL) {
  const url = new URL(relativePath, parentURL);
  let skip = false;
  try { statSync(url); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    skip = `toolbox dependency absent: ${relativePath} (${url.href})`;
  }
  return { url, skip };
}

export function externalTest(relativePath, parentURL) {
  const { url, skip } = externalSource(relativePath, parentURL);
  return (name, callback) => test(name, { skip }, (t) => callback(t, url));
}
