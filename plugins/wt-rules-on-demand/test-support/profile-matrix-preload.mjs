import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const original = childProcess.spawnSync;
const checker = fileURLToPath(new URL('./profile-outcome.mjs', import.meta.url));
childProcess.spawnSync = (exe, args, options) => {
  if (args.includes('migrate') && args.includes('--user')) {
    const nodeArgs = args.slice(0, args.indexOf('migrate') - 1);
    const check = original(exe, [...nodeArgs, checker, JSON.stringify(args)], options);
    assert.equal(check.status, 0, `health matrix comparison failed:\n${check.stderr}`);
    console.log('PROFILE-MATRIX-COMPARED');
  }
  return original(exe, args, options);
};
syncBuiltinESMExports();
