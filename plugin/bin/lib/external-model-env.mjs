import { platform as runtimePlatform } from 'node:process'
import { installedOpenCodeProviderDefinitions } from './host/provider-definitions.mjs'

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
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|CONFIG_FILE)/i
const EXECUTION_HOOK_NAME = /^(?:NODE_OPTIONS|BUN_OPTIONS|BASH_ENV|ENV|ZDOTDIR|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/i
const CONFIGURATION_CARRIER = /^(?:OPENCODE_CONFIG(?:_|$)|CODEX_HOME$)/i
const PROVIDER_CREDENTIALS = Object.freeze({
  anthropic: Object.freeze([]),
  google: Object.freeze(['GOOGLE_GENERATIVE_AI_API_KEY']),
  openai: Object.freeze(['OPENAI_API_KEY']),
})
const PROVIDER_EXTRAS = Object.freeze({
  azure: Object.freeze(['AZURE_RESOURCE_NAME']),
  'azure-cognitive-services': Object.freeze(['AZURE_COGNITIVE_SERVICES_RESOURCE_NAME']),
})
const PROVIDER_MODEL_SEPARATOR = String.fromCharCode(47)
const FALLBACK_WARNED = new Set()

function configuredExtraNames(env) {
  return String(env.WT_EXTERNAL_MODEL_ENV_ALLOW ?? '').split(',').map((name) => name.trim()).filter(Boolean)
}

/**
 * Builds the complete environment for an external model CLI. Unknown parent variables are absent.
 * WT_EXTERNAL_MODEL_ENV_ALLOW can add harmless non-credential, non-execution names.
 * Callers can pass credential names explicitly in code; the three session Anthropic credentials
 * are never eligible.
 */
export function externalModelEnv(env = process.env, extraNames = [], platform = runtimePlatform) {
  const normalize = platform === 'win32' ? (name) => name.toUpperCase() : (name) => name
  const exactNames = new Set([...EXACT_NAMES].map(normalize))
  const configuredNames = new Set(configuredExtraNames(env).filter((name) => NAME.test(name) && !CREDENTIAL_NAME.test(name) && !EXECUTION_HOOK_NAME.test(name) && !CONFIGURATION_CARRIER.test(name)).map(normalize))
  const explicitNames = new Set(extraNames.filter((name) => NAME.test(name)).map(normalize))
  const child = {}
  for (const [name, value] of Object.entries(env)) {
    const matchedName = normalize(name)
    if (value === undefined || NEVER_PASS.has(name.toUpperCase())) continue
    if (explicitNames.has(matchedName)) child[name] = value
    else if (!CONFIGURATION_CARRIER.test(name) && !CREDENTIAL_NAME.test(name) && (exactNames.has(matchedName) || PREFIXES.some((prefix) => matchedName.startsWith(prefix)) || /^LC_[A-Z]+$/.test(matchedName) || configuredNames.has(matchedName))) child[name] = value
  }
  return child
}

// The provider a known credential name is assigned to in PROVIDER_CREDENTIALS, case-insensitive.
// Used so an OpenCode registry definition for provider X can never authorize a credential the
// known map assigns to a DIFFERENT provider Y (e.g. an azure entry listing OPENAI_API_KEY).
function knownCredentialOwner(name) {
  const upper = name.toUpperCase()
  for (const [owner, credentials] of Object.entries(PROVIDER_CREDENTIALS)) {
    if (credentials.some((credential) => credential.toUpperCase() === upper)) return owner
  }
  return null
}

export function providerCredentialNames(model, { definitions = installedOpenCodeProviderDefinitions(), warn = console.error } = {}) {
  const reference = String(model)
  if (!reference.includes(PROVIDER_MODEL_SEPARATOR)) return []
  const provider = reference.split(PROVIDER_MODEL_SEPARATOR, 1)[0].toLowerCase()
  if (Object.hasOwn(PROVIDER_CREDENTIALS, provider)) return [...PROVIDER_CREDENTIALS[provider]]
  const installed = definitions?.[provider]?.env
  if (Array.isArray(installed)) {
    return [...new Set(installed.filter((name) => typeof name === 'string' && NAME.test(name)))]
      .filter((name) => !NEVER_PASS.has(name.toUpperCase()))
      .filter((name) => { const owner = knownCredentialOwner(name); return owner === null || owner === provider })
  }
  const prefix = provider.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_')
  const names = [`${prefix}_API_KEY`, ...(PROVIDER_EXTRAS[provider] ?? [])]
  if (!FALLBACK_WARNED.has(provider)) {
    FALLBACK_WARNED.add(provider)
    warn(`workflow-toolbox: OpenCode provider definitions unavailable for ${provider}; using fallback environment names ${names.join(', ')}`)
  }
  return names
}
