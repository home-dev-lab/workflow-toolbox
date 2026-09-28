import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import * as externalEnv from '../../../../plugin/bin/lib/external-model-env.mjs'

const { externalModelEnv, providerCredentialNames } = externalEnv

afterEach(() => { vi.restoreAllMocks() })

describe('external model environment value filtering', () => {
  it('refuses URL credentials while retaining the explicitly selected provider credential', () => {
    const warnings: string[] = []
    const child = externalModelEnv({
      OPENAI_API_KEY: 'selected',
      GOOGLE_GENERATIVE_AI_API_KEY: 'unrelated',
      OPENAI_BASE_URL: 'https://other:secret@api.example/v1',
    }, ['OPENAI_API_KEY'], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).toEqual({ OPENAI_API_KEY: 'selected' })
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused OPENAI_BASE_URL (url-userinfo); its value is not passed'])
  })

  it('refuses credentials carried by a configured extra and reports its name safely', () => {
    const secret = 'other-service-secret'
    const warnings: string[] = []
    const child = externalModelEnv({
      OPENAI_API_KEY: 'selected',
      WT_EXTERNAL_MODEL_ENV_ALLOW: 'OTEL_EXPORTER_OTLP_HEADERS',
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${secret}`,
    }, ['OPENAI_API_KEY'], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).toEqual({ OPENAI_API_KEY: 'selected', WT_EXTERNAL_MODEL_ENV_ALLOW: 'OTEL_EXPORTER_OTLP_HEADERS' })
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused OTEL_EXPORTER_OTLP_HEADERS (header-carrier); its value is not passed'])
    expect(warnings.join('\n')).not.toContain(secret)
  })

  it.each([
    ['OPENAI_BASE_URL', 'https://api.openai.com/v1', undefined, 'linux'],
    ['HTTPS_PROXY', 'http://127.0.0.1:8080', undefined, 'linux'],
    ['NO_PROXY', 'localhost,127.0.0.1,.internal', undefined, 'linux'],
    ['OPENAI_ORG_ID', 'org-AbC123', undefined, 'linux'],
    ['AZURE_OPENAI_ENDPOINT', 'https://res.openai.azure.com/openai/deployments/d?api-version=2024-02-01', undefined, 'linux'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'linux'],
    ['OTEL_RESOURCE_ATTRIBUTES', 'service.name=lane,deployment.environment=dev', 'OTEL_RESOURCE_ATTRIBUTES', 'linux'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'content-type=application/json,user-agent=lane', 'OTEL_EXPORTER_OTLP_HEADERS', 'linux'],
    ['PATH', '/usr/local/bin:/usr/bin', undefined, 'linux'],
    ['Path', 'C:\\Windows\\system32;C:\\Tools', undefined, 'win32'],
    ['LANG', 'en_GB.UTF-8', undefined, 'linux'],
    ['OPENCODE_THEME', 'dark', undefined, 'linux'],
  ])('passes harmless %s values unchanged', (name, value, configuredName, platform) => {
    const warnings: string[] = []
    const env = { [name]: value, ...(configuredName ? { WT_EXTERNAL_MODEL_ENV_ALLOW: configuredName } : {}) }
    const child = externalModelEnv(env, [], platform, { warn: (message: string) => warnings.push(message) })

    expect(child[name]).toBe(value)
    expect(warnings).toEqual([])
  })

  it.each([
    ['HTTPS_PROXY', 'http://user:pass@proxy.corp:3128', undefined, 'user:pass', 'url-userinfo'],
    ['OPENAI_BASE_URL', 'https://tok@gateway.example/v1', undefined, 'tok', 'url-userinfo'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?api_key=abc123', undefined, 'abc123', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?sig=abc&se=2026', undefined, 'abc', 'url-token-parameter'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'x-api-key=abc123', 'OTEL_EXPORTER_OTLP_HEADERS', 'abc123', 'header-carrier'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer abcdefghij', 'OTEL_EXPORTER_OTLP_HEADERS', 'abcdefghij', 'header-carrier'],
    ['CODEX_EXTRA', 'Basic dXNlcjpwYXNzd29yZA==', undefined, 'dXNlcjpwYXNzd29yZA==', 'bearer-token'],
    ['DATABASE_URL', 'postgres://app:pw@db:5432/x', 'DATABASE_URL', 'pw', 'url-userinfo'],
  ])('refuses credential-bearing %s values without logging their secret', (name, value, configuredName, secret, reason) => {
    const warnings: string[] = []
    const env = { [name]: value, ...(configuredName ? { WT_EXTERNAL_MODEL_ENV_ALLOW: configuredName } : {}) }
    const child = externalModelEnv(env, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).not.toHaveProperty(name)
    expect(warnings).toEqual([expect.stringContaining(`${name} (${reason})`)])
    expect(warnings.join('\n')).not.toContain(secret)
  })

  it('warns when a present configured extra is refused by its credential-shaped name', () => {
    const warnings: string[] = []
    const secret = 'synthetic-github-value'
    const child = externalModelEnv({
      WT_EXTERNAL_MODEL_ENV_ALLOW: 'GITHUB_TOKEN',
      GITHUB_TOKEN: secret,
    }, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).not.toHaveProperty('GITHUB_TOKEN')
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused configured extra GITHUB_TOKEN (credential-name)'])
    expect(warnings.join('\n')).not.toContain(secret)
  })

  it.each([
    ['1INVALID', 'invalid-name'],
    ['NODE_OPTIONS', 'execution-hook'],
    ['OPENCODE_CONFIG_DIR', 'configuration-carrier'],
  ])('reports configured-extra name refusal for %s', (name, reason) => {
    const warnings: string[] = []
    externalModelEnv({
      WT_EXTERNAL_MODEL_ENV_ALLOW: name,
      [name]: 'synthetic-safe-value',
    }, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(warnings).toEqual([`workflow-toolbox: external-model child environment refused configured extra ${name} (${reason})`])
  })

  it('lets an explicit provider credential bypass value inspection but inspects an explicit endpoint', () => {
    const warnings: string[] = []
    const child = externalModelEnv({
      OPENAI_API_KEY: 'Basic dXNlcjpwYXNzd29yZA==',
      AZURE_RESOURCE_NAME: 'https://user:pass@example.test',
    }, ['OPENAI_API_KEY', 'AZURE_RESOURCE_NAME'], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).toEqual({ OPENAI_API_KEY: 'Basic dXNlcjpwYXNzd29yZA==' })
    expect(warnings).toEqual([expect.stringContaining('AZURE_RESOURCE_NAME (url-userinfo)')])
  })

  it.each([
    ['https://user@example.test', 'url-userinfo'],
    ['https://example.test/path#authorization=value', 'url-token-parameter'],
    ['Cookie: synthetic-cookie', 'header-credential'],
    ['Bearer abcdefghijk', 'bearer-token'],
    ['https://example.test?api-version=2026-09-01', null],
  ])('classifies credential shape %s', (value, reason) => {
    const warnings: string[] = []
    const child = externalModelEnv({ OPENAI_BASE_URL: value }, [], 'linux', { warn: (message: string) => warnings.push(message) })
    if (reason === null) {
      expect(child).toEqual({ OPENAI_BASE_URL: value })
      expect(warnings).toEqual([])
    } else {
      expect(child).toEqual({})
      expect(warnings).toEqual([`workflow-toolbox: external-model child environment refused OPENAI_BASE_URL (${reason}); its value is not passed`])
    }
  })

  // Review round 1: a header carrier passes only when every item names a non-secret header.
  it.each([
    ['x-honeycomb-team=hcaik_x', 'hcaik_x'],
    ['DD-APPLICATION-KEY=x', 'DD-APPLICATION-KEY=x'],
    ['Ocp-Apim-Subscription-Key=x', 'Subscription-Key=x'],
    ['{"x-api-key":"sk-x"}', 'sk-x'],
    ["'authorization'='sk-x'", 'sk-x'],
  ])('refuses the header carrier item %s', (value, secret) => {
    const warnings: string[] = []
    const env = { WT_EXTERNAL_MODEL_ENV_ALLOW: 'OTEL_EXPORTER_OTLP_HEADERS', OTEL_EXPORTER_OTLP_HEADERS: value }
    const child = externalModelEnv(env, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS')
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused OTEL_EXPORTER_OTLP_HEADERS (header-carrier); its value is not passed'])
    expect(warnings.join('\n')).not.toContain(secret)
  })

  it.each([
    ['HTTPS_PROXY', 'auth-proxy.corp:3128', undefined, 'linux'],
    ['NO_PROXY', 'localhost,.oauth.corp:443', undefined, 'linux'],
    ['NO_PROXY', 'localhost,auth-gateway:8443', undefined, 'linux'],
    ['OTEL_RESOURCE_ATTRIBUTES', 'service.name=lane,session.id=abc', 'OTEL_RESOURCE_ATTRIBUTES', 'linux'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?api-version=2024-02-01', undefined, 'linux'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?region=eu', undefined, 'linux'],
    ['USER', 'alice@corp.example', undefined, 'linux'],
    ['Path', 'C:\\Tools\\Basic PowerPacks\\bin', undefined, 'win32'],
    ['APPDATA', 'C:\\Users\\a\\AppData\\Roaming', undefined, 'win32'],
  ])('passes the round-1 harmless shape %s=%s', (name, value, configuredName, platform) => {
    const warnings: string[] = []
    const env = { [name]: value, ...(configuredName ? { WT_EXTERNAL_MODEL_ENV_ALLOW: configuredName } : {}) }
    const child = externalModelEnv(env, [], platform, { warn: (message: string) => warnings.push(message) })

    expect(child[name]).toBe(value)
    expect(warnings).toEqual([])
  })

  it.each([
    ['X_CFG', 'x-functions-key=abc', 'X_CFG', 'abc', 'header-credential'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?subscription-key=abc', undefined, 'abc', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?code=abc', undefined, 'abc', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?access_key=abc', undefined, 'abc', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?private_key=abc', undefined, 'abc', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?pass=abc', undefined, 'abc', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?api%5Fkey=abc', undefined, 'abc', 'url-token-parameter'],
    ['HTTPS_PROXY', 'alice:S3cret@proxy.corp:3128', undefined, 'S3cret', 'url-userinfo'],
    ['https_proxy', 'tok@proxy:3128', undefined, 'tok@', 'url-userinfo'],
    ['OPENAI_BASE_URL', 'HTTPS://u:p@h', undefined, 'u:p', 'url-userinfo'],
    ['OPENAI_BASE_URL', 'http://u:p@[::1]:8080', undefined, 'u:p', 'url-userinfo'],
    ['CODEX_EXTRA', 'first line\nAuthorization: Bearer abcdefghij', undefined, 'abcdefghij', 'header-credential'],
    ['CODEX_EXTRA', '{"x-api-key":"sk-synthetic"}', undefined, 'sk-synthetic', 'header-credential'],
  ])('refuses the round-1 credential shape %s=%s', (name, value, configuredName, secret, reason) => {
    const warnings: string[] = []
    const env = { [name]: value, ...(configuredName ? { WT_EXTERNAL_MODEL_ENV_ALLOW: configuredName } : {}) }
    const child = externalModelEnv(env, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).not.toHaveProperty(name)
    expect(warnings).toEqual([`workflow-toolbox: external-model child environment refused ${name} (${reason}); its value is not passed`])
    expect(warnings.join('\n')).not.toContain(secret)
  })

  // Review round 2: harmless shapes the round-1 rules refused, and neighbours the new rules must not catch.
  it.each([
    ['OTEL_EXPORTER_OTLP_HEADERS', 'content-type=application/json;charset=utf-8', 'OTEL_EXPORTER_OTLP_HEADERS'],
    ['EDITOR', 'C:\\Tools\\Basic PowerPacks\\editor.exe', 'EDITOR'],
    ['HTTPS_PROXY', 'auth-proxy:8080/', undefined],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?monkey=1', undefined],
    ['OPENAI_BASE_URL', 'https://gw.example/v1?keyboard=1', undefined],
    ['CODEX_EXTRA', '{"theme":"dark"}', undefined],
    ['CODEX_BYPASS_CACHE', '1', undefined],
    ['COMPASS_DIR', '/opt/compass', 'COMPASS_DIR'],
  ])('passes the round-2 harmless shape %s=%s', (name, value, configuredName) => {
    const warnings: string[] = []
    const env = { [name]: value, ...(configuredName ? { WT_EXTERNAL_MODEL_ENV_ALLOW: configuredName } : {}) }
    const child = externalModelEnv(env, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child[name]).toBe(value)
    expect(warnings).toEqual([])
  })

  it.each([
    ['OTEL_EXPORTER_OTLP_HEADERS', 'x-tenant=public', 'OTEL_EXPORTER_OTLP_HEADERS', 'public', 'header-carrier'],
    ['CODEX_EXTRA', 'Bearer abc', undefined, 'abc', 'bearer-token'],
    ['CODEX_EXTRA', 'Basic dTpw', undefined, 'dTpw', 'bearer-token'],
    ['CODEX_EXTRA', 'Authorization: Basic dTpw', undefined, 'dTpw', 'header-credential'],
    ['CODEX_EXTRA', 'Authorization: 123456', undefined, '123456', 'header-credential'],
    ['CODEX_EXTRA', 'authorization=123456', undefined, '123456', 'header-credential'],
    ['OPENAI_BASE_URL', 'https://u:pa ss@example.test/v1', undefined, 'pa ss', 'url-userinfo'],
    ['OPENAI_BASE_URL', 'https://u:pa\tss@example.test/v1', undefined, 'pa\tss', 'url-userinfo'],
    ['OPENAI_BASE_URL', '//u:synthetic-rel@example.test/v1', undefined, 'synthetic-rel', 'url-userinfo'],
    ['NO_PROXY', 'localhost,//u:synthetic-rel@example.test', undefined, 'synthetic-rel', 'url-userinfo'],
    ['CODEX_EXTRA', 'mirror //u:synthetic-rel@example.test', undefined, 'synthetic-rel', 'url-userinfo'],
    ['OPENAI_BASE_URL', 'https://gw.example/?accessKey=synthetic-q', undefined, 'synthetic-q', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/?subscriptionKey=synthetic-q', undefined, 'synthetic-q', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/?access_token=synthetic-q', undefined, 'synthetic-q', 'url-token-parameter'],
    ['OPENAI_BASE_URL', 'https://gw.example/?secret=synthetic-q', undefined, 'synthetic-q', 'url-token-parameter'],
    ['CODEX_EXTRA', '{"headers":{"x-api-key":"synthetic-json"}}', undefined, 'synthetic-json', 'header-credential'],
  ])('refuses the round-2 credential shape %s=%s', (name, value, configuredName, secret, reason) => {
    const warnings: string[] = []
    const env = { [name]: value, ...(configuredName ? { WT_EXTERNAL_MODEL_ENV_ALLOW: configuredName } : {}) }
    const child = externalModelEnv(env, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).not.toHaveProperty(name)
    expect(warnings).toEqual([`workflow-toolbox: external-model child environment refused ${name} (${reason}); its value is not passed`])
    expect(warnings.join('\n')).not.toContain(secret)
  })

  it('treats PASS as a credential name segment, not by prefix and not as a configured extra', () => {
    const warnings: string[] = []
    const child = externalModelEnv({
      CODEX_PASS: 'synthetic-pass',
      WT_EXTERNAL_MODEL_ENV_ALLOW: 'SERVICE_PASS',
      SERVICE_PASS: 'synthetic-pass',
    }, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).toEqual({ WT_EXTERNAL_MODEL_ENV_ALLOW: 'SERVICE_PASS' })
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused configured extra SERVICE_PASS (credential-name)'])
  })

  it('checks values on win32 with the same rules', () => {
    const warnings: string[] = []
    const child = externalModelEnv({ Https_Proxy: 'alice:S3cret@proxy.corp:3128', Path: 'C:\\bin' }, [], 'win32', { warn: (message: string) => warnings.push(message) })

    expect(child).toEqual({ Path: 'C:\\bin' })
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused Https_Proxy (url-userinfo); its value is not passed'])
  })

  it('reports a present never-pass configured extra without passing it', () => {
    const warnings: string[] = []
    const child = externalModelEnv({
      WT_EXTERNAL_MODEL_ENV_ALLOW: 'ANTHROPIC_API_KEY',
      ANTHROPIC_API_KEY: 'synthetic-session-credential',
    }, [], 'linux', { warn: (message: string) => warnings.push(message) })

    expect(child).toEqual({ WT_EXTERNAL_MODEL_ENV_ALLOW: 'ANTHROPIC_API_KEY' })
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused configured extra ANTHROPIC_API_KEY (never-pass)'])
  })

  it('does not resolve a fallback name the known map assigns to a different provider', () => {
    expect(providerCredentialNames('google-generative-ai/x', { definitions: {}, warn: () => {} })).not.toContain('GOOGLE_GENERATIVE_AI_API_KEY')
    expect(providerCredentialNames('google-generative-ai/x', { definitions: null, warn: () => {} })).not.toContain('GOOGLE_GENERATIVE_AI_API_KEY')
  })

  it('prints each distinct default-path refusal once per process, and every refusal to a supplied warn', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = { OPENAI_BASE_URL: 'https://round1-dedup:synthetic@gw.example/v1' }
    externalModelEnv(env, [], 'linux')
    externalModelEnv(env, [], 'linux')

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).not.toContain('synthetic')

    const warnings: string[] = []
    externalModelEnv(env, [], 'linux', { warn: (message: string) => warnings.push(message) })
    externalModelEnv(env, [], 'linux', { warn: (message: string) => warnings.push(message) })
    expect(warnings).toHaveLength(2)
  })
})
