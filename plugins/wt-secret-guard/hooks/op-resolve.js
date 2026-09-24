// Pure helpers for 1Password references. The hook module makes the `$.process.run` call itself:
// the strict validator refuses `$` handed to a function imported from another module.
// `account` maps to `op read --account` (measured 2026-09-08: OP_ACCOUNT does not cross WSL
// interop to op.exe; `--account` does).

export function opReadArgv(ref, account = '', binary = 'op') {
  return [binary || 'op', 'read', ...(account ? ['--account', account] : []), ref];
}

export function opReferencesIn(command) {
  const refs = [];
  for (const match of String(command ?? '').matchAll(/(?:secret:1p:|op:\/\/)([^\s"']+)/g)) refs.push(`op://${match[1]}`);
  return [...new Set(refs)];
}

// A value exists only when op SUCCEEDED: an exit status other than 0 - or none at all - is a failure,
// whatever stdout it produced (Astra at 2618aa81: `{exitCode: 1, stdout: 'partial-failed-result'}` was
// bound and run). Fail closed: a result that does not say it succeeded is not a value.
export function opValueFrom(result) {
  if (result?.exitCode !== 0) return '';
  return String(result?.stdout ?? '').replace(/\r?\n$/, '');
}
