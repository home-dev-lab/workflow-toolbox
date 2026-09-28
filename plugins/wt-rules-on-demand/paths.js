// Shared by Function Hooks and Node CLIs; deliberately no Node builtin imports.
export function ruleDirectories(project, config) {
  const clean = (value) => {
    let path = String(value);
    while (path.endsWith('/') || path.endsWith('\\')) path = path.slice(0, -1);
    return path;
  };
  return {
    project: `${clean(project)}/.claude/rules-on-demand`,
    user: `${clean(config)}/rules-on-demand`,
    projectStatic: `${clean(project)}/.claude/rules`,
    userStatic: `${clean(config)}/rules`,
  };
}

export function configDirectory(env) {
  return env.CLAUDE_CONFIG_DIR || (env.HOME || env.USERPROFILE ? `${env.HOME || env.USERPROFILE}/.claude` : null);
}

export function agentLoop(agentId) {
  return agentId || 'main';
}
