import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { providerCredentialNames } from '../../../../plugin/bin/lib/external-model-env.mjs'
// @ts-expect-error Shipped dependency-free plugin source has no declaration file.
import { providerEnvironmentNames } from '../../../../plugins/wt-deep-search/src/deep/opencode.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('external model provider environment parity', () => {
  it('resolves every provider identically from one registry fixture', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-provider-parity-'))
    roots.push(root)
    const cache = path.join(root, 'cache')
    const file = path.join(cache, 'opencode', 'models.json')
    const definitions = {
      azure: { env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY', 'OPENAI_API_KEY', 'anthropic_api_key'] },
      mistral: { env: ['MISTRAL_API_KEY'] },
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(definitions))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const noopWarn = () => {}

    for (const model of ['openai/x', 'google/x', 'anthropic/x', 'azure/x', 'mistral/x', 'unknownprov/x']) {
      expect(providerEnvironmentNames(model, { XDG_CACHE_HOME: cache }, noopWarn)).toEqual(
        providerCredentialNames(model, { definitions: parsed, warn: noopWarn }),
      )
    }
  })
})
