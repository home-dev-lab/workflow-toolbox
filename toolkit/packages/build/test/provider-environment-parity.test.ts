import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { providerCredentialNames } from '../../../../plugin/bin/lib/external-model-env.mjs'
// @ts-expect-error Shipped dependency-free plugin source has no declaration file.
import { providerEnvironmentNames } from '../../../../plugins/wt-deep-search/src/deep/opencode.js'

const { installedOpenCodeProviderDefinitions } = await import(new URL('../../../../plugin/bin/lib/host/provider-definitions.mjs', import.meta.url).href)

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const noopWarn = () => {}

function writeRegistry(cacheRoot: string, definitions: unknown) {
  const file = path.join(cacheRoot, 'opencode', 'models.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(definitions))
}

function tempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wt-provider-parity-'))
  roots.push(root)
  return root
}

// Both resolvers read the registry files themselves, from the same environment.
function bothSides(model: string, env: Record<string, string>) {
  return {
    deepSearch: providerEnvironmentNames(model, env, noopWarn),
    shared: providerCredentialNames(model, { definitions: installedOpenCodeProviderDefinitions(env), warn: noopWarn }),
  }
}

const MODELS = ['openai/x', 'google/x', 'anthropic/x', 'azure/x', 'mistral/x', 'unknownprov/x', 'google-generative-ai/x', 'openai-compatible/x']

describe('external model provider environment parity', () => {
  it('resolves every provider identically from one registry file', () => {
    const cache = path.join(tempRoot(), 'cache')
    writeRegistry(cache, {
      azure: { env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY', 'OPENAI_API_KEY', 'anthropic_api_key'] },
      mistral: { env: ['MISTRAL_API_KEY'] },
    })

    for (const model of MODELS) {
      const { deepSearch, shared } = bothSides(model, { XDG_CACHE_HOME: cache })
      expect(deepSearch, model).toEqual(shared)
    }
  })

  it('uses the first parseable registry even when it lacks the provider', () => {
    const root = tempRoot()
    const xdg = path.join(root, 'xdg-cache')
    const home = path.join(root, 'home')
    writeRegistry(xdg, { mistral: { env: ['MISTRAL_API_KEY'] } })
    writeRegistry(path.join(home, '.cache'), { azure: { env: ['AZURE_RESOURCE_NAME', 'AZURE_SECONDARY_KEY'] } })

    for (const model of MODELS) {
      const { deepSearch, shared } = bothSides(model, { XDG_CACHE_HOME: xdg, HOME: home })
      expect(deepSearch, model).toEqual(shared)
    }
    expect(bothSides('azure/x', { XDG_CACHE_HOME: xdg, HOME: home }).deepSearch).not.toContain('AZURE_SECONDARY_KEY')
  })

  it('never resolves a fallback name the known map assigns to a different provider', () => {
    const { deepSearch, shared } = bothSides('google-generative-ai/x', { XDG_CACHE_HOME: path.join(tempRoot(), 'none') })
    expect(deepSearch).not.toContain('GOOGLE_GENERATIVE_AI_API_KEY')
    expect(shared).not.toContain('GOOGLE_GENERATIVE_AI_API_KEY')
  })
})
