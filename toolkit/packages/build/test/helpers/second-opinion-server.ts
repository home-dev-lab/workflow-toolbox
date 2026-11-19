import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Intercept at the real spawn boundary, including the inlined bridge. Both old
// and new implementations are sealed: this never conditionally runs real Codex.
export function fakeServerPreload(root: string, server: string) {
  const preload = join(root, 'fake-server-preload.mjs')
  writeFileSync(preload, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {pathToFileURL} from 'node:url';
const original = cp.spawn;
cp.spawn = function(bin, args, options) {
  if (bin === 'codex') return original.call(this, process.execPath, [${JSON.stringify(server)}, ...args], {...options, shell:false});
  if (bin === process.execPath && args.includes('--eval')) return original.call(this, bin, ['--import', pathToFileURL(${JSON.stringify(preload)}).href, ...args], options);
  return original.call(this, bin, args, options);
}; syncBuiltinESMExports();`)
  return preload
}
