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

export function opValueFrom(result) {
  return String(result?.stdout ?? '').replace(/\r?\n$/, '');
}
