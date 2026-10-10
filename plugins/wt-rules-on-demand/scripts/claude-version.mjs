// Which Claude Code build is running, read from what the CLI puts in its subprocesses' environment.
// CLAUDE_CODE_EXECPATH names the running binary (…/versions/<x.y.z>, an `.exe` suffix accepted for Windows); AI_AGENT
// reads `claude-code_<x>-<y>-<z>_agent` (observed format, undocumented). Neither parseable, or the two disagreeing,
// -> null: the version is unknown, never guessed.
const MODS_DEFAULT = [2, 1, 287];

export function claudeVersion(env) {
  const exec = String(env.CLAUDE_CODE_EXECPATH ?? '').split(/[\\/]/).pop().match(/^(\d+)\.(\d+)\.(\d+)(?:\.exe)?$/i);
  const agent = String(env.AI_AGENT ?? '').match(/^claude-code_(\d+)-(\d+)-(\d+)_agent$/);
  const fromExec = exec && `${exec[1]}.${exec[2]}.${exec[3]}`;
  const fromAgent = agent && `${agent[1]}.${agent[2]}.${agent[3]}`;
  if (fromExec && fromAgent && fromExec !== fromAgent) return null;
  if (fromExec) return { version: fromExec, source: 'CLAUDE_CODE_EXECPATH' };
  if (fromAgent) return { version: fromAgent, source: 'AI_AGENT' };
  return null;
}

// Claude Code 2.1.287 and later load mods by default and ignore CLAUDE_CODE_ENABLE_FUNCTION_HOOKS.
// true / false for a parseable version, null when the version is unknown.
export function modsOnByDefault(version) {
  const parts = String(version ?? '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!parts) return null;
  for (let i = 0; i < 3; i++) {
    const value = Number(parts[i + 1]);
    if (value !== MODS_DEFAULT[i]) return value > MODS_DEFAULT[i];
  }
  return true;
}
