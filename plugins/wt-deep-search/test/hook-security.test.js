import assert from 'node:assert/strict'
import test from 'node:test'

import { bestPages, register } from '../hooks/hooks.js'

function hookHandler() {
  let handler
  register((_event, _filter, callback) => { handler = callback })
  return handler
}

function rankingEngine(files) {
  const reads = []
  return {
    reads,
    engine: {
      fs: {
        read: async (path) => {
          reads.push(path)
          if (path === '/mirror/docs_manifest.json') return JSON.stringify({ files })
          return '# Hooks reference\nPostToolUse hook configuration and input.'
        },
      },
    },
  }
}

test('mirror scoring refuses a parent traversal manifest entry', async () => {
  const { engine, reads } = rankingEngine({
    '../outside.md': { title: 'Hooks reference' },
    'safe.md': { title: 'Hooks reference' },
  })

  const pages = await bestPages(engine, '/mirror', 'PostToolUse hooks')

  assert.deepEqual(reads, ['/mirror/docs_manifest.json', '/mirror/safe.md'])
  assert.deepEqual(pages.map(({ name }) => name), ['safe.md'])
})

test('mirror scoring refuses an absolute manifest entry', async () => {
  const { engine, reads } = rankingEngine({
    '/outside.md': { title: 'Hooks reference' },
    'safe.md': { title: 'Hooks reference' },
  })

  const pages = await bestPages(engine, '/mirror', 'PostToolUse hooks')

  assert.deepEqual(reads, ['/mirror/docs_manifest.json', '/mirror/safe.md'])
  assert.deepEqual(pages.map(({ name }) => name), ['safe.md'])
})

test('the hook reads a benign mirror entry for both scoring and its result', async () => {
  const reads = []
  const root = '/home/tester/.claude-code-docs'
  const $ = {
    env: { get: async (name) => name === 'HOME' ? '/home/tester' : undefined },
    fs: {
      exists: async () => true,
      read: async (path) => {
        reads.push(path)
        if (path === `${root}/docs_manifest.json`) {
          return JSON.stringify({ files: { 'hooks.md': { title: 'Hooks reference' } } })
        }
        return '# Hooks reference\nPostToolUse hook configuration and input.'
      },
    },
    tool: { list: async () => [] },
    clock: { sleep: () => new Promise(() => {}) },
  }

  const result = await hookHandler()($, { query: 'How do PostToolUse hooks work in Claude Code?' }, () => {
    throw new Error('benign mirror entry unexpectedly fell through')
  })

  assert.deepEqual(reads, [
    `${root}/docs_manifest.json`,
    `${root}/hooks.md`,
    `${root}/hooks.md`,
  ])
  assert.match(result.result.results[0], /PostToolUse hook configuration/)
})

for (const variable of ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY']) {
  test(`the WebSearch hook detects and sends ${variable}`, async () => {
    let request
    const $ = {
      env: { get: async (name) => name === variable ? 'brave-sentinel-key' : undefined },
      fs: { exists: async () => false },
      http: {
        fetch: async (...args) => {
          request = args
          return {
            status: 200,
            ok: true,
            headers: {},
            text: JSON.stringify({ web: { results: [{ title: 'Weather', url: 'https://example.test', description: 'Sunny' }] } }),
          }
        },
      },
      tool: { list: async () => [] },
      clock: { sleep: () => new Promise(() => {}) },
      ui: { log: async () => {} },
    }

    const result = await hookHandler()($, { query: 'What is the weather in Paris today?' }, () => {
      throw new Error(`${variable} unexpectedly fell through`)
    })

    assert.equal(request[1].headers['X-Subscription-Token'], 'brave-sentinel-key')
    assert.match(result.result.results[0], /Answered by Brave/)
  })
}
