import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'

const source = process.env.WT_GIT_HISTORY_CORE_MODULE ?? join(import.meta.dirname, '../../../../plugin/bin/lib/second-opinion-core.mjs')
const { createSecondOpinionDependencies } = await import(pathToFileURL(source).href)

it.each(['bwrap', 'unknown-sandbox'])('refuses a %s plan that cannot mask git history before wrapping the reviewer', async (kind) => {
  const dispose = vi.fn()
  const stop = vi.fn()
  const wrap = vi.fn(() => { throw new Error('reviewer must not start') })
  const resolveSandbox = vi.fn(() => ({ kind, line: 'fixture sandbox', unreadable: () => [], dispose, wrap }))
  const adapter = { platform: 'linux', createCodexBrokerOwnership: (env: unknown) => ({ env, stop }) }
  const deps = createSecondOpinionDependencies(adapter, { resolveSandbox })
  const result = await deps.runCodex({ companion: '/fixture/scripts/companion.mjs', cwd: '/fixture/repo', effort: 'high', request: 'review', env: {} })
  expect(result.status).toBe(2)
  expect(result.stderr).toBe('REFUSED: sandbox plan cannot withhold repository git history.\n')
  expect(resolveSandbox).toHaveBeenCalledWith(expect.objectContaining({ hideGitHistory: true }))
  expect(wrap).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
})
