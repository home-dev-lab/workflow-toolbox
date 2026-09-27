import { platform as runtimePlatform } from 'node:process'
import { externalModelEnv, isCredentialName } from './external-model-env.mjs'

// Anthropic credentials the SDK itself authenticates with. externalModelEnv refuses them on purpose
// (an external CLI must never receive them), so they are composed here, by exact name only.
const SDK_CREDENTIAL_NAMES = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
// Non-credential SDK and plugin names; their values go through the external-model value detector.
const SDK_NAMES = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT',
]
const FORCED_SWITCHES = ['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB never passes: measured 2026-09-27 on WSL2 (Claude Code SDK 0.3.280),
// it makes every sandboxed Bash command fail at bwrap setup ("Can't mkdir /mnt/c/Program Files/ClaudeCode").
// The SDK credentials are kept from sandboxed commands by executorSandboxCredentials() instead.
const NEVER_PASS = ['ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', ...FORCED_SWITCHES]
const OPEN_PREFIXES = ['CLAUDE_CODE_', 'WT_']

/**
 * Builds the complete environment for the Claude SDK executor worker and for the SDK query it runs.
 * Unknown parent variables are absent: the base is the external-model allow-list, plus the SDK's own
 * Anthropic credentials by exact name, plus value-checked SDK, plugin, CLAUDE_CODE_* and WT_* names
 * whose names do not look like credentials. ANTHROPIC_CUSTOM_HEADERS and every case spelling of
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB never pass; every case spelling of CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
 * is replaced by the canonical name set to '1'. Refusals are reported by name and reason, never by value.
 * The SDK credentials stay in this environment (the SDK authenticates with them); the executor keeps
 * them from its sandboxed Bash commands with executorSandboxCredentials().
 *
 * Bedrock and Vertex executor authentication (AWS_*, GOOGLE_* cloud credentials) is not supported by
 * this builder: those credentials never reach the executor.
 */
export function claudeExecutorEnv(env = process.env, platform = runtimePlatform, { warn } = {}) {
  const fold = platform === 'win32' ? (name) => name.toUpperCase() : (name) => name
  const neverPass = new Set(NEVER_PASS)
  const sdkNames = new Set(SDK_NAMES.map(fold))
  const open = (name) => OPEN_PREFIXES.some((prefix) => fold(name).startsWith(prefix)) && !isCredentialName(name)
  const extraNames = Object.keys(env).filter((name) => !neverPass.has(name.toUpperCase()) && (sdkNames.has(fold(name)) || open(name)))
  const child = externalModelEnv(env, extraNames, platform, { warn })
  const credentials = new Set(SDK_CREDENTIAL_NAMES.map(fold))
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && credentials.has(fold(name))) child[name] = value
  }
  for (const name of Object.keys(child)) {
    if (neverPass.has(name.toUpperCase())) delete child[name]
  }
  for (const name of FORCED_SWITCHES) child[name] = '1'
  return child
}

/**
 * The sandbox `credentials` block for the executor's SDK query: the SDK's own credentials are unset
 * before every sandboxed Bash command runs (Claude Code sandbox.credentials.envVars, mode deny), so
 * the model driving the executor, remapped or not, cannot read them from its shell.
 */
export function executorSandboxCredentials() {
  return { envVars: SDK_CREDENTIAL_NAMES.map((name) => ({ name, mode: 'deny' })) }
}
