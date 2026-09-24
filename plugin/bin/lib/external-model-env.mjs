import { platform as runtimePlatform } from 'node:process'

const EXACT_NAMES = new Set([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'LOGNAME', 'SHELL',
  'TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CI', 'NO_COLOR', 'FORCE_COLOR',
  'WT_EXTERNAL_MODEL_ENV_ALLOW',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'WINDIR',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
])
const PREFIXES = ['OPENCODE_', 'CODEX_', 'OPENAI_', 'AZURE_OPENAI_']
const NEVER_PASS = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i

function configuredExtraNames(env) {
  return String(env.WT_EXTERNAL_MODEL_ENV_ALLOW ?? '').split(',').map((name) => name.trim()).filter(Boolean)
}

/**
 * Builds the complete environment for an external model CLI. Unknown parent variables are absent.
 * WT_EXTERNAL_MODEL_ENV_ALLOW can add non-credential-shaped names. Callers can pass credential
 * names explicitly in code; the three session Anthropic credentials are never eligible.
 */
export function externalModelEnv(env = process.env, extraNames = [], platform = runtimePlatform) {
  const normalize = platform === 'win32' ? (name) => name.toUpperCase() : (name) => name
  const exactNames = new Set([...EXACT_NAMES].map(normalize))
  const configuredNames = new Set(configuredExtraNames(env).filter((name) => NAME.test(name) && !CREDENTIAL_NAME.test(name)).map(normalize))
  const explicitNames = new Set(extraNames.filter((name) => NAME.test(name)).map(normalize))
  const child = {}
  for (const [name, value] of Object.entries(env)) {
    const matchedName = normalize(name)
    if (value === undefined || NEVER_PASS.has(name.toUpperCase())) continue
    if (explicitNames.has(matchedName)) child[name] = value
    else if (!CREDENTIAL_NAME.test(name) && (exactNames.has(matchedName) || PREFIXES.some((prefix) => matchedName.startsWith(prefix)) || /^LC_[A-Z]+$/.test(matchedName) || configuredNames.has(matchedName))) child[name] = value
  }
  return child
}
