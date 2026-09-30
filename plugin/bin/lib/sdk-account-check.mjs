export const PROFILE_AUTH_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL', 'WT_PILOT_EXPECT_ACCOUNT',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'CLAUDE_CODE_API_BASE_URL', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GB_BASE_URL', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_BRIDGE_BASE_URL', 'CLAUDE_BRIDGE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_API_KEY',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'ANTHROPIC_BEDROCK_REGION_PREFIX',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_PROJECT', 'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH', 'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
]

export function profileAccountOverride(profileEnv) {
  return PROFILE_AUTH_KEYS.find((key) => Object.hasOwn(profileEnv, key)) ?? null
}

export function evaluateSdkAccount(account, expected, unavailable = null) {
  const email = typeof account?.email === 'string' && account.email.trim() ? account.email.trim() : null
  const tokenSource = typeof account?.tokenSource === 'string' && account.tokenSource ? account.tokenSource : null
  const storedLogin = (tokenSource === null || tokenSource === 'none') && (account?.apiKeySource == null || account.apiKeySource === 'none') && account?.apiProvider === 'firstParty'
  const environmentToken = tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN'
  const configEmail = environmentToken && email ? `; config reports ${email}; not the token's owner` : ''
  const summary = { email, token_source: tokenSource, expected: expected || null }
  if (!expected) {
    return { verdict: 'not_enforced', allowed: true, line: unavailable
      ? `account: unknown (${unavailable}) (not enforced)`
      : `account: ${email ?? 'e-mail not exposed'} tokenSource=${tokenSource ?? 'none'} (not enforced)`, ...summary }
  }
  if (unavailable) return { verdict: 'unavailable', allowed: false, line: `account: unknown (${unavailable}); expected ${expected}; SDK account check unavailable`, ...summary }
  if (email && storedLogin) {
    if (email.toLowerCase() === expected.trim().toLowerCase()) return { verdict: 'email_matched', allowed: true, line: `account: ${email} matched expected ${expected}`, ...summary }
    return { verdict: 'mismatch', allowed: false, line: `account: ${email} does not match expected ${expected}; launch the runner with the expected account's token in CLAUDE_CODE_OAUTH_TOKEN (the child otherwise uses the config dir's saved login)`, ...summary }
  }
  if (environmentToken && account?.apiProvider === 'firstParty' && (account?.apiKeySource == null || account.apiKeySource === 'none')) {
    return { verdict: 'launcher_asserted', allowed: true, line: `account: OAuth environment token selected; owner not independently verified (expected ${expected})${configEmail}`, ...summary }
  }
  return { verdict: 'unverifiable', allowed: false, line: `account: credential owner not verified; cannot verify expected ${expected} from SDK accountInfo (tokenSource=${tokenSource ?? 'none'})${configEmail}`, ...summary }
}

export async function closeRefusedAccountStream(stream, log) {
  if (typeof stream.close !== 'function') return
  try { await stream.close() } catch { log('account: SDK stream close failed after refusal') }
}

export function profileOverrideDecision(variable, expected) {
  return { verdict: 'profile_override', allowed: false, line: `account: --profile-env sets ${variable}; expected ${expected} must be checked against the runner launch environment`, email: null, token_source: null, expected }
}

// Thrown by open() on a refused account so the runner's catch can tell it from an SDK failure:
// a refusal ends the run failed with its account line, it is never rethrown.
export class AccountRefusal extends Error {}

const EMPTY_GATE_TIMERS = {}

// The whole account gate of one pilot run. It lives here, outside runPilot, so runPilot keeps its
// complexity ceiling: runPilot only wraps its prompt, opens the stream through open(), and asks
// errorToRethrow()/reasonAfterError()/summary() in its catch and summary.
export function createAccountGate({ expectAccount, launchEnv, profileEnv, log, timers = EMPTY_GATE_TIMERS }) {
  const expected = (expectAccount ?? launchEnv?.WT_PILOT_EXPECT_ACCOUNT ?? '').trim() || null
  const profileOverride = expected ? profileAccountOverride(profileEnv ?? {}) : null
  let resolveGate
  const gate = new Promise((resolve) => { resolveGate = resolve })
  let decision = null
  const settle = (next) => { decision = next; log(next.line); resolveGate(next.allowed) }
  return {
    expected,
    // The SDK starts reading the prompt as soon as query() is called: nothing is yielded before the verdict.
    async *gatePrompt(inner) { if (await gate) yield* inner },
    async open(startQuery, abortController) {
      if (profileOverride) {
        settle(profileOverrideDecision(profileOverride, expected))
        abortController.abort()
        throw new AccountRefusal(decision.line)
      }
      const stream = startQuery()
      settle(await checkSdkAccount(stream, expected, timers))
      if (decision.allowed) return stream
      abortController.abort()
      await closeRefusedAccountStream(stream, log)
      throw new AccountRefusal(decision.line)
    },
    errorToRethrow(error) { return error instanceof AccountRefusal ? null : error },
    // The run's incomplete reason after the stream failed: a refusal (or an enforced check that never ran)
    // names the account; otherwise an SDK error after init names that error, as before this gate existed.
    async reasonAfterError(error, { initReceiptSeen, incompleteReason }) {
      if (!decision) settle(await checkSdkAccount(null, expected))
      if (!decision.allowed) return decision.line
      if (initReceiptSeen) return `sdk stream error: ${error instanceof Error ? error.message : String(error)}`
      return incompleteReason
    },
    summary() { return decision && { verdict: decision.verdict, email: decision.email, token_source: decision.token_source, expected: decision.expected } },
  }
}

export async function checkSdkAccount(stream, expected, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof stream?.accountInfo !== 'function') return evaluateSdkAccount(null, expected, 'accountInfo unavailable')
  let timer
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => stream.accountInfo()).then((account) => ({ account }), () => ({ unavailable: 'accountInfo threw' })),
      new Promise((resolve) => { timer = setTimer(() => resolve({ unavailable: 'accountInfo timed out after 30 s' }), 30_000) }),
    ])
    return evaluateSdkAccount(outcome.account, expected, outcome.unavailable)
  } finally {
    if (timer !== undefined) clearTimer(timer)
  }
}
