import { describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import * as externalEnv from '../../../../plugin/bin/lib/external-model-env.mjs'

const { externalModelEnv } = externalEnv

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
    expect(warnings).toEqual(['workflow-toolbox: external-model child environment refused OTEL_EXPORTER_OTLP_HEADERS (header-credential); its value is not passed'])
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
    ['OTEL_EXPORTER_OTLP_HEADERS', 'content-type=application/json,x-tenant=blue', 'OTEL_EXPORTER_OTLP_HEADERS', 'linux'],
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
    ['OTEL_EXPORTER_OTLP_HEADERS', 'x-api-key=abc123', 'OTEL_EXPORTER_OTLP_HEADERS', 'abc123', 'header-credential'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer abcdefghij', 'OTEL_EXPORTER_OTLP_HEADERS', 'abcdefghij', 'header-credential'],
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
})
