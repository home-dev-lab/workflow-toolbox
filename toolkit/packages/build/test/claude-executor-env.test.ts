import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

type Env = Record<string, string | undefined>
type Builder = (env: Env, platform: string, options: { warn: (message: string) => void }) => Record<string, string>

const MODULE = pathToFileURL(fileURLToPath(new URL('../../../../plugin/bin/lib/claude-executor-env.mjs', import.meta.url))).href
const { claudeExecutorEnv } = (await import(MODULE)) as { claudeExecutorEnv: Builder }

function build(env: Env, platform = 'linux') {
  const warnings: string[] = []
  const child = claudeExecutorEnv(env, platform, { warn: (message) => warnings.push(message) })
  return { child, warnings }
}

const OWNER_ENV: Env = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/owner',
  GITHUB_TOKEN: 'CANARY_GITHUB',
  GH_TOKEN: 'CANARY_GH',
  NPM_TOKEN: 'CANARY_NPM',
  AWS_SECRET_ACCESS_KEY: 'CANARY_AWS',
  AWS_REGION: 'eu-west-2',
  OPENAI_API_KEY: 'CANARY_OPENAI',
  GOOGLE_APPLICATION_CREDENTIALS: '/secret/CANARY.json',
  SSH_AUTH_SOCK: '/tmp/CANARY-agent.sock',
  ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: CANARY_HEADER',
  HTTPS_PROXY: 'http://user:CANARY@proxy.invalid:8080',
  ANTHROPIC_BASE_URL: 'https://u:CANARY@proxy.invalid',
  ANTHROPIC_AUTH_TOKEN: 'sdk-auth-token',
  ANTHROPIC_API_KEY: 'sdk-api-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'sdk-oauth-token',
  ANTHROPIC_MODEL: 'opus',
  ANTHROPIC_SMALL_FAST_MODEL: 'haiku',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-6-sol',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-6-sol',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-6-mini',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable-5-1',
  CLAUDE_CONFIG_DIR: '/home/owner/.claude',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
  CLAUDE_PLUGIN_DATA: '/home/owner/.claude/plugins/data/wt',
  CLAUDE_PLUGIN_ROOT: '/home/owner/.claude/plugins/cache/wt',
  CLAUDE_CODE_EFFORT_LEVEL: 'high',
  CLAUDE_CODE_SECRET_THING: 'CANARY_CC_SECRET',
  CLAUDE_CODE_PROXY_URL: 'https://a:CANARY@proxy.invalid',
  WT_EXECUTOR_CODE_VARIANT: 'high',
  WT_DEPLOY_TOKEN: 'CANARY_WT_TOKEN',
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0',
}

describe('claudeExecutorEnv', () => {
  it.each([
    'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'OPENAI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS', 'SSH_AUTH_SOCK', 'ANTHROPIC_CUSTOM_HEADERS', 'HTTPS_PROXY',
    'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_SECRET_THING', 'CLAUDE_CODE_PROXY_URL', 'WT_DEPLOY_TOKEN',
  ])('drops %s from the owner environment', (name) => {
    expect(Object.keys(build(OWNER_ENV).child)).not.toContain(name)
  })

  it('keeps the SDK names, the executor names and the basic process names', () => {
    const { child } = build(OWNER_ENV)
    expect(child).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/home/owner',
      ANTHROPIC_AUTH_TOKEN: 'sdk-auth-token',
      ANTHROPIC_API_KEY: 'sdk-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'sdk-oauth-token',
      ANTHROPIC_MODEL: 'opus',
      ANTHROPIC_SMALL_FAST_MODEL: 'haiku',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-6-sol',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-6-sol',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-6-mini',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable-5-1',
      CLAUDE_CONFIG_DIR: '/home/owner/.claude',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      CLAUDE_PLUGIN_DATA: '/home/owner/.claude/plugins/data/wt',
      CLAUDE_PLUGIN_ROOT: '/home/owner/.claude/plugins/cache/wt',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      WT_EXECUTOR_CODE_VARIANT: 'high',
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    })
    expect(Object.keys(child)).not.toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')
  })

  it('keeps a proxy base URL that carries no credential', () => {
    expect(build({ ...OWNER_ENV, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' }).child.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8317')
  })

  it('names refused variables without ever quoting their values', () => {
    const { warnings } = build(OWNER_ENV)
    expect(warnings.some((warning) => warning.includes('ANTHROPIC_BASE_URL'))).toBe(true)
    expect(warnings.filter((warning) => warning.includes('CANARY'))).toEqual([])
  })

  it('on win32 drops every spelling of the subprocess scrub and replaces every spelling of the hooks switch with one canonical value', () => {
    const { child } = build({ Path: 'C:\\Windows', claude_code_subprocess_env_scrub: '0', Claude_Code_Enable_Function_Hooks: '0', anthropic_custom_headers: 'x-api-key: CANARY' }, 'win32')
    const scrub = Object.entries(child).filter(([name]) => name.toUpperCase() === 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')
    const hooks = Object.entries(child).filter(([name]) => name.toUpperCase() === 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS')
    expect(scrub).toEqual([])
    expect(hooks).toEqual([['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', '1']])
    expect(Object.keys(child).map((name) => name.toUpperCase())).not.toContain('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('never lets the external-model allow knob admit the header carrier', () => {
    const { child } = build({ PATH: '/bin', WT_EXTERNAL_MODEL_ENV_ALLOW: 'ANTHROPIC_CUSTOM_HEADERS', ANTHROPIC_CUSTOM_HEADERS: 'accept: text/plain' })
    expect(Object.keys(child)).not.toContain('ANTHROPIC_CUSTOM_HEADERS')
  })
})
